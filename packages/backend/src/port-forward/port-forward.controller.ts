import { Request, Response } from 'express';
import * as repo from './port-forward.repository';
import * as service from './port-forward.service';
import { PortForwardRuleInput } from './port-forward.repository';

const isValidPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;

const sanitize = (body: any): PortForwardRuleInput => {
    const type = body?.type;
    if (type !== 'local' && type !== 'remote' && type !== 'dynamic') {
        throw new Error('type 只能是 local / remote / dynamic');
    }
    const bindPort = Number(body?.bind_port);
    if (!isValidPort(bindPort)) throw new Error('本地/远端监听端口不合法');
    const bindHost = typeof body?.bind_host === 'string' && body.bind_host.trim() ? body.bind_host.trim() : '127.0.0.1';

    if (type === 'dynamic') {
        return { type, bind_host: bindHost, bind_port: bindPort, target_host: null, target_port: null, auto_start: !!body?.auto_start };
    }

    const targetPort = Number(body?.target_port);
    const targetHost = typeof body?.target_host === 'string' ? body.target_host.trim() : '';
    if (!targetHost) throw new Error('目标地址不能为空');
    if (!isValidPort(targetPort)) throw new Error('目标端口不合法');
    return {
        type,
        bind_host: bindHost,
        bind_port: bindPort,
        target_host: targetHost,
        target_port: targetPort,
        auto_start: !!body?.auto_start,
    };
};

/** GET /port-forwards?connectionId=1 —— 规则 + 运行状态 */
export const list = async (req: Request, res: Response): Promise<void> => {
    const connectionId = Number(req.query.connectionId);
    if (!Number.isInteger(connectionId) || connectionId <= 0) {
        res.status(400).json({ message: 'connectionId 不合法' });
        return;
    }
    const rules = await repo.listRulesByConnection(connectionId);
    res.json({ rules, statuses: service.getStatuses(rules) });
};

export const create = async (req: Request, res: Response): Promise<void> => {
    const connectionId = Number(req.query.connectionId ?? req.body?.connection_id);
    if (!Number.isInteger(connectionId) || connectionId <= 0) {
        res.status(400).json({ message: 'connectionId 不合法' });
        return;
    }
    try {
        const rule = await repo.createRule(connectionId, sanitize(req.body));
        if (rule.auto_start) {
            await service.startRule(rule).catch(() => { /* 启动失败状态里能看到 */ });
        }
        res.status(201).json(rule);
    } catch (err: any) {
        res.status(400).json({ message: err.message });
    }
};

export const update = async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    const existing = await repo.getRuleById(id);
    if (!existing) {
        res.status(404).json({ message: '规则不存在' });
        return;
    }
    try {
        const input = sanitize(req.body);
        // 改了参数就得重启，否则监听还挂在旧端口上；原本在跑的，改完继续跑
        const wasRunning = service.getStatuses([existing])[0]?.running === true;
        await service.stopRule(id, true).catch(() => { /* ignore */ });
        const rule = await repo.updateRule(id, input);
        if (rule && (wasRunning || rule.auto_start)) {
            await service.startRule(rule).catch(() => { /* 状态里可查 */ });
        }
        res.json(rule);
    } catch (err: any) {
        res.status(400).json({ message: err.message });
    }
};

export const remove = async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    await service.stopRule(id, true).catch(() => { /* ignore */ });
    await repo.deleteRule(id);
    res.status(204).end();
};

export const start = async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    const rule = await repo.getRuleById(id);
    if (!rule) {
        res.status(404).json({ message: '规则不存在' });
        return;
    }
    try {
        await repo.setAutoStart(id, true);
        const status = await service.startRule({ ...rule, auto_start: 1 });
        res.json(status);
    } catch (err: any) {
        res.status(502).json({ message: err.message });
    }
};

export const stop = async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    await repo.setAutoStart(id, false);
    await service.stopRule(id, true);
    res.json({ ruleId: id, running: false });
};

/** GET /port-forwards/status?connectionId=1 —— 只取运行态（前端轮询用） */
export const status = async (req: Request, res: Response): Promise<void> => {
    const connectionId = Number(req.query.connectionId);
    if (!Number.isInteger(connectionId) || connectionId <= 0) {
        res.status(400).json({ message: 'connectionId 不合法' });
        return;
    }
    const rules = await repo.listRulesByConnection(connectionId);
    res.json({ statuses: service.getStatuses(rules) });
};
