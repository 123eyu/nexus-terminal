import WebSocket, { WebSocketServer } from 'ws';
import { AuthenticatedWebSocket } from './types';
import { cleanupClientConnection } from './utils';

const HEARTBEAT_INTERVAL_MS = 15000; // 优化心跳检测间隔为 15 秒，避免高负载与文件上传时误杀连接

export function initializeHeartbeat(wss: WebSocketServer): NodeJS.Timeout {
    const heartbeatInterval = setInterval(() => {
        wss.clients.forEach((ws: WebSocket) => {
            const extWs = ws as AuthenticatedWebSocket & { 
                missedPongs?: number; 
                isSyncOrEventChannel?: boolean; 
                channelType?: string 
            };

            if (extWs.isAlive === false) {
                extWs.missedPongs = (extWs.missedPongs || 0) + 1;
                // 同步长连接与前端事件长连接允许 3 次缓冲 (45s)，终端连接允许 2 次 (30s)
                const maxMissedPongs = extWs.isSyncOrEventChannel ? 3 : 2;

                if (extWs.missedPongs >= maxMissedPongs) {
                    if (extWs.isSyncOrEventChannel) {
                        console.log(`WebSocket 心跳检测：全局通道 (${extWs.channelType || 'sync/event'}) 连续 ${extWs.missedPongs} 次无响应，正在清理连接...`);
                        return extWs.terminate();
                    }

                    console.log(`WebSocket 心跳检测：用户 ${extWs.username} (会话: ${extWs.sessionId}) 连续 ${extWs.missedPongs} 次无响应 (超过 30s)，正在终止连接...`);
                    if (extWs.sessionId) {
                        cleanupClientConnection(extWs.sessionId); // 仅在持有终端会话 ID 时清理终端
                    }
                    return extWs.terminate();
                }
            } else {
                extWs.missedPongs = 0;
            }

            extWs.isAlive = false;
            try {
                extWs.ping(() => {});
            } catch {
                // 忽略发送瞬间连接已断开的异常
            }
        });
    }, HEARTBEAT_INTERVAL_MS);

    // 当 WebSocket 服务器关闭时，清除心跳定时器
    wss.on('close', () => {
        console.log('WebSocket 服务器正在关闭，清理心跳定时器...');
        clearInterval(heartbeatInterval);
    });

    console.log(`心跳检测已初始化，间隔: ${HEARTBEAT_INTERVAL_MS}ms`);
    return heartbeatInterval;
}