// packages/backend/src/websocket/frontend-events.ts
import { WebSocket } from 'ws';

/**
 * 前端 UI 全局事件通道（/ws/events）的客户端池。
 *
 * 单独抽成 leaf 模块（只依赖 ws），是为了让「谁都可以往里推事件」而不引入环：
 * 之前这个 Set 藏在 sync/sync.ws-broadcaster.ts 里，sftp 层想推一条"外部编辑器已回传"
 * 就得反向依赖 sync 模块，最终绕回 websocket/state，容易出现循环导入。
 */
const frontendEventClients = new Set<WebSocket>();

/** 注册一条前端 UI 事件连接（由 /ws/events 的 upgrade 回调调用） */
export function registerFrontendEventClient(ws: WebSocket): void {
    frontendEventClients.add(ws);
}

/** 注销（连接关闭 / 出错时调用） */
export function unregisterFrontendEventClient(ws: WebSocket): void {
    frontendEventClients.delete(ws);
}

/** 当前在线的前端页面数（日志 / 健康检查用） */
export function getFrontendEventClientCount(): number {
    return frontendEventClients.size;
}

/**
 * 向所有在线前端页面推一条事件。返回实际发送成功的页面数。
 *
 * 注意：这个通道不区分用户，多用户部署时 payload 里要带 userId，由前端自己过滤，
 * 不要把别人的路径信息直接显示出来。
 */
export function broadcastFrontendEvent(message: Record<string, unknown>): number {
    if (frontendEventClients.size === 0) return 0;

    let payload: string;
    try {
        payload = JSON.stringify({ ...message, timestamp: (message.timestamp as number) ?? Date.now() });
    } catch (err: any) {
        console.warn('[FrontendEvents] 事件序列化失败:', err?.message || err);
        return 0;
    }

    let sent = 0;
    for (const client of frontendEventClients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        try {
            client.send(payload);
            sent += 1;
        } catch (err: any) {
            console.warn('[FrontendEvents] 发送事件异常:', err?.message || err);
        }
    }
    return sent;
}
