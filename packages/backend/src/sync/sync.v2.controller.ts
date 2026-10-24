// packages/backend/src/sync/sync.v2.controller.ts
import { Request, Response } from 'express';
import { syncV2Service } from './sync.v2.service';
import { getServerSyncApiKey } from './sync.middleware';
import { syncEventsManager } from './sync.events';

/**
 * 解析「同步范围」（细项 key 列表）。
 * 支持三种写法：query 里逗号分隔的字符串、重复 query 参数、body 里的数组。
 * 不传 / 空 = 全同步（老客户端不回退）。
 */
function parseModules(raw: any): string[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    const list = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return list.length > 0 ? list : undefined;
  }
  if (typeof raw === 'string') {
    const list = raw.split(',').map(s => s.trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

export const syncV2Controller = {
  /**
   * 处理桌面端推上来的变更集
   */
  async push(req: Request, res: Response): Promise<void> {
    try {
      const payload = req.body;
      if (!payload || !payload.device_id || !Array.isArray(payload.changes)) {
        res.status(400).json({ success: false, error: '请求载荷格式错误，缺少 device_id 或 changes 数组' });
        return;
      }

      const pairingSecret = (await getServerSyncApiKey()) || 'nexus-default-key';
      const result = await syncV2Service.handlePush(payload, pairingSecret, parseModules(payload.modules));

      res.json({
        success: true,
        data: result
      });
    } catch (err: any) {
      console.error('[SyncV2Controller:push] 出错:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  },

  /**
   * 处理桌面端拉取变更集
   */
  async pull(req: Request, res: Response): Promise<void> {
    try {
      const deviceId = (req.query.device_id as string) || 'unknown-device';
      const cursor = parseInt((req.query.cursor as string) || '0', 10);
      const limit = parseInt((req.query.limit as string) || '200', 10);

      const pairingSecret = (await getServerSyncApiKey()) || 'nexus-default-key';
      const result = await syncV2Service.handlePull(deviceId, cursor, limit, pairingSecret, parseModules(req.query.modules));

      res.json({
        success: true,
        data: result
      });
    } catch (err: any) {
      if (err.statusCode === 410) {
        res.status(410).json({ success: false, error: err.message, code: 'CURSOR_EXPIRED' });
        return;
      }
      res.status(500).json({ success: false, error: err.message });
    }
  },

  /**
   * 全量快照拉取 (用于初次加入集群或游标过期后的全量重建)
   */
  async snapshot(req: Request, res: Response): Promise<void> {
    try {
      const page = parseInt((req.query.page as string) || '1', 10);
      const pageSize = parseInt((req.query.page_size as string) || '200', 10);

      const pairingSecret = (await getServerSyncApiKey()) || 'nexus-default-key';
      const result = await syncV2Service.getSnapshot(page, pageSize, pairingSecret, parseModules(req.query.modules));

      res.json({
        success: true,
        data: result
      });
    } catch (err: any) {
      console.error('[SyncV2Controller:snapshot] 出错:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  },

  /**
   * SSE 变更事件通道 (推送最新 latest_seq 通知)
   */
  async events(req: Request, res: Response): Promise<void> {
    const deviceId = (req.query.device_id as string) || `client-${Date.now()}`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    res.write(`: sse channel opened\n\n`);

    syncEventsManager.registerClient(deviceId, res);
  }
};
