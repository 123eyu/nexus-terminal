/**
 * 端口转发的运行时：本地 -L、动态 SOCKS5 -D、远程 -R。
 *
 * 每条规则自己带一个「专用」的 SSH 连接（不跟终端会话共用），
 * 这样不开终端也能跑转发，终端断线重连也不会把转发一起带走。
 * 同一条连接下的多条规则共用同一个 SSH 客户端。
 */
import net from 'net';
import { Client } from 'ssh2';
import { establishSshConnection, getConnectionDetails } from '../services/ssh.service';
import { PortForwardRule } from './port-forward.repository';

const CONNECT_TIMEOUT_MS = 20000;
const RESTART_DELAY_MS = 5000;
const MAX_RESTART_ATTEMPTS = 3;

interface RunningRule {
    rule: PortForwardRule;
    server?: net.Server;
    /** 远程转发登记成功后的实际端口（bind_port=0 时由服务器分配） */
    remotePort?: number;
    remoteHost?: string;
    connCount: number;
    sockets: Set<net.Socket>;
    startedAt: number;
    error?: string;
    /** 用户主动停掉的，不参与自动恢复 */
    manualStop?: boolean;
    /** 已成功监听/登记；断线时不置 false，靠 error 标记，避免重复启动 */
    started?: boolean;
    restartAttempts: number;
    restartTimer?: NodeJS.Timeout;
}

export interface ForwardStatus {
    ruleId: number;
    running: boolean;
    error?: string;
    startedAt?: number;
    connCount?: number;
}

const clients = new Map<number, Client>();
const running = new Map<number, RunningRule>();

const statusOf = (rule: PortForwardRule): ForwardStatus => {
    const rt = running.get(rule.id);
    if (!rt) return { ruleId: rule.id, running: false };
    return {
        ruleId: rule.id,
        running: true,
        error: rt.error,
        startedAt: rt.startedAt,
        connCount: rt.connCount,
    };
};

const closeQuietly = (sock: net.Socket | undefined) => {
    try { sock?.destroy(); } catch { /* ignore */ }
};

/** 拿到（或新建）某条连接专用的 SSH 客户端 */
const ensureClient = async (connectionId: number): Promise<Client> => {
    const existing = clients.get(connectionId);
    if (existing) return existing;

    const details = await getConnectionDetails(connectionId);
    const client = await establishSshConnection(details, CONNECT_TIMEOUT_MS);

    client.on('error', (err: Error) => {
        console.warn(`[PortForward] 连接 ${connectionId} 出错:`, err.message);
        handleClientLost(connectionId, err.message);
    });
    client.on('close', () => {
        handleClientLost(connectionId, 'SSH 连接已断开');
    });

    clients.set(connectionId, client);
    return client;
};

/** 连接断了：把这条连接下所有规则标失败，必要时按 auto_start 重试 */
const handleClientLost = (connectionId: number, message: string) => {
    // ssh2 的 error 和 close 会连着来，只处理第一次
    if (!clients.has(connectionId)) return;
    clients.delete(connectionId);
    for (const [ruleId, rt] of running.entries()) {
        if (rt.rule.connection_id !== connectionId) continue;
        rt.started = false;
        rt.error = message;
        rt.server?.close();
        rt.server = undefined;
        rt.sockets.forEach(closeQuietly);
        rt.sockets.clear();
        if (rt.restartTimer) continue;
        if (!rt.manualStop && rt.rule.auto_start && rt.restartAttempts < MAX_RESTART_ATTEMPTS) {
            rt.restartAttempts += 1;
            rt.restartTimer = setTimeout(() => {
                rt.restartTimer = undefined;
                startRule(rt.rule).catch(err => {
                    console.warn(`[PortForward] 规则 ${ruleId} 自动恢复失败:`, err.message);
                });
            }, RESTART_DELAY_MS);
        } else {
            running.delete(ruleId);
        }
    }
};

/** 本地监听：每条进来的 TCP 都开一条 direct-tcpip 通道 */
const startLocal = async (rule: PortForwardRule, client: Client, rt: RunningRule): Promise<void> => {
    const server = net.createServer(socket => {
        const srcPort = socket.remotePort ?? 0;
        client.forwardOut('127.0.0.1', srcPort, rule.target_host as string, rule.target_port as number, (err, stream) => {
            if (err) {
                socket.destroy();
                return;
            }
            rt.connCount += 1;
            rt.sockets.add(socket);
            socket.pipe(stream).pipe(socket);
            const cleanup = () => {
                rt.sockets.delete(socket);
                closeQuietly(socket);
                try { stream.close(); } catch { /* ignore */ }
            };
            socket.on('error', cleanup);
            socket.on('close', () => {
                rt.sockets.delete(socket);
                try { stream.close(); } catch { /* ignore */ }
            });
            stream.on('error', cleanup);
            stream.on('close', cleanup);
        });
    });
    await listen(server, rule);
    rt.server = server;
};

/** 动态转发：本地起一个 SOCKS5（只支持 CONNECT，无认证） */
const startDynamic = async (rule: PortForwardRule, client: Client, rt: RunningRule): Promise<void> => {
    const server = net.createServer(socket => {
        let buffer = Buffer.alloc(0);
        let stage: 'greeting' | 'request' | 'done' = 'greeting';

        const fail = (code = 0x01) => {
            try { socket.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch { /* ignore */ }
            socket.destroy();
        };

        socket.on('error', () => socket.destroy());
        socket.on('close', () => rt.sockets.delete(socket));
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            if (stage === 'greeting') {
                if (buffer.length < 2) return;
                const nMethods = buffer[1];
                if (buffer[0] !== 0x05 || buffer.length < 2 + nMethods) return;
                buffer = buffer.subarray(2 + nMethods);
                stage = 'request';
                socket.write(Buffer.from([0x05, 0x00])); // 无认证
                if (buffer.length === 0) return;
            }
            if (stage !== 'request') return;
            if (buffer.length < 5) return;
            if (buffer[0] !== 0x05 || buffer[1] !== 0x01) { fail(0x07); return; }

            const atyp = buffer[3];
            let host = '';
            let port = 0;
            let consumed = 0;
            if (atyp === 0x01) {
                if (buffer.length < 10) return;
                host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
                port = buffer.readUInt16BE(8);
                consumed = 10;
            } else if (atyp === 0x03) {
                const len = buffer[4];
                if (buffer.length < 5 + len + 2) return;
                host = buffer.subarray(5, 5 + len).toString('utf8');
                port = buffer.readUInt16BE(5 + len);
                consumed = 5 + len + 2;
            } else if (atyp === 0x04) {
                if (buffer.length < 22) return;
                const parts: string[] = [];
                for (let i = 0; i < 16; i += 2) parts.push(buffer.readUInt16BE(4 + i).toString(16));
                host = parts.join(':');
                port = buffer.readUInt16BE(20);
                consumed = 22;
            } else {
                fail(0x08);
                return;
            }

            stage = 'done';
            const rest = buffer.subarray(consumed);
            client.forwardOut('127.0.0.1', socket.remotePort ?? 0, host, port, (err, stream) => {
                if (err) { fail(0x05); return; }
                rt.connCount += 1;
                rt.sockets.add(socket);
                socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                if (rest.length > 0) stream.write(rest);
                socket.pipe(stream).pipe(socket);
                const cleanup = () => {
                    rt.sockets.delete(socket);
                    closeQuietly(socket);
                    try { stream.close(); } catch { /* ignore */ }
                };
                socket.on('error', cleanup);
                socket.on('close', () => {
                    rt.sockets.delete(socket);
                    try { stream.close(); } catch { /* ignore */ }
                });
                stream.on('error', cleanup);
                stream.on('close', cleanup);
            });
        });
    });
    await listen(server, rule);
    rt.server = server;
};

/** 远程转发：在服务器上开端口，流量回送到本机目标 */
const startRemote = async (rule: PortForwardRule, client: Client, rt: RunningRule): Promise<void> => {
    const bindHost = rule.bind_host || '127.0.0.1';
    await new Promise<void>((resolve, reject) => {
        client.forwardIn(bindHost, rule.bind_port, err => {
            if (err) reject(err); else resolve();
        });
    });
    rt.remoteHost = bindHost;
    rt.remotePort = rule.bind_port;
};

const listen = (server: net.Server, rule: PortForwardRule): Promise<void> => {
    return new Promise((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once('error', onError);
        server.listen(rule.bind_port, rule.bind_host || '127.0.0.1', () => {
            server.removeListener('error', onError);
            server.on('error', err => {
                const rt = running.get(rule.id);
                if (rt) rt.error = err.message;
            });
            resolve();
        });
    });
};

/** 启动一条规则；已启动则直接返回 */
export const startRule = async (rule: PortForwardRule): Promise<ForwardStatus> => {
    const existing = running.get(rule.id);
    // 远程转发没有本地 server，只认 started 标记，否则重复调用会重复 forwardIn
    if (existing?.started) return statusOf(rule);

    const client = await ensureClient(rule.connection_id);
    const rt: RunningRule = existing ?? {
        rule,
        connCount: 0,
        sockets: new Set(),
        startedAt: Date.now(),
        restartAttempts: 0,
    };
    rt.rule = rule;
    rt.error = undefined;
    rt.started = false;
    running.set(rule.id, rt);

    try {
        if (rule.type === 'local') {
            if (!rule.target_host || !rule.target_port) throw new Error('本地转发缺少目标地址');
            await startLocal(rule, client, rt);
        } else if (rule.type === 'dynamic') {
            await startDynamic(rule, client, rt);
        } else {
            if (!rule.target_host || !rule.target_port) throw new Error('远程转发缺少目标地址');
            await startRemote(rule, client, rt);
            // 远程转发的入站在此处统一分发（一个客户端可能挂了多条 -R）
            client.removeAllListeners('tcp connection');
            client.on('tcp connection', (info, accept) => {
                const acceptStream = accept();
                const candidate = [...running.values()].find(r =>
                    r.rule.connection_id === rule.connection_id && r.rule.type === 'remote' && r.remotePort === info.destPort
                );
                if (!candidate || !candidate.rule.target_host || !candidate.rule.target_port) {
                    acceptStream.close();
                    return;
                }
                const target = net.connect(candidate.rule.target_port, candidate.rule.target_host);
                candidate.connCount += 1;
                acceptStream.pipe(target).pipe(acceptStream);
                const cleanup = () => {
                    closeQuietly(target);
                    try { acceptStream.close(); } catch { /* ignore */ }
                };
                target.on('error', cleanup);
                acceptStream.on('error', cleanup);
                acceptStream.on('close', cleanup);
            });
        }
        rt.started = true;
    } catch (err: any) {
        rt.error = err.message;
        running.delete(rule.id);
        throw err;
    }

    return statusOf(rule);
};

export const stopRule = async (ruleId: number, manual = true): Promise<void> => {
    const rt = running.get(ruleId);
    if (!rt) return;
    if (manual) rt.manualStop = true;
    if (rt.restartTimer) clearTimeout(rt.restartTimer);

    rt.server?.close();
    rt.server = undefined;
    rt.sockets.forEach(closeQuietly);
    rt.sockets.clear();

    const client = clients.get(rt.rule.connection_id);
    if (rt.rule.type === 'remote' && client && rt.remotePort) {
        await new Promise<void>(resolve => client.unforwardIn(rt.remoteHost || '127.0.0.1', rt.remotePort!, () => resolve()));
        rt.remotePort = undefined;
    }

    running.delete(ruleId);

    // 这条连接没有别的转发在跑了，就把专用连接关掉
    const stillRunning = [...running.values()].some(r => r.rule.connection_id === rt.rule.connection_id);
    if (!stillRunning) {
        const c = clients.get(rt.rule.connection_id);
        clients.delete(rt.rule.connection_id);
        try { c?.end(); } catch { /* ignore */ }
    }
};

export const getStatuses = (rules: PortForwardRule[]): ForwardStatus[] => rules.map(statusOf);

/** 后端启动时把 auto_start 的规则拉起来（桌面端才需要） */
export const restoreAutoStart = async (rules: PortForwardRule[]): Promise<void> => {
    for (const rule of rules) {
        try {
            await startRule(rule);
            console.log(`[PortForward] 已恢复规则 #${rule.id} (${rule.type} ${rule.bind_port})`);
        } catch (err: any) {
            console.warn(`[PortForward] 恢复规则 #${rule.id} 失败:`, err.message);
        }
    }
};

/** 连接被删除时，先停掉内存里的规则 */
export const stopAllForConnection = async (connectionId: number): Promise<void> => {
    for (const [ruleId, rt] of [...running.entries()]) {
        if (rt.rule.connection_id === connectionId) {
            await stopRule(ruleId, true);
        }
    }
    const c = clients.get(connectionId);
    clients.delete(connectionId);
    try { c?.end(); } catch { /* ignore */ }
};
