// packages/backend/src/sync/sync.ws-broadcaster.ts
import { WebSocket } from 'ws';
import { IncomingMessage } from 'http';

/**
 * 已连接并鉴权成功的同步客户端连接池 (如桌面端后台连到云端)
 */
const syncWsClients = new Set<WebSocket>();

/**
 * 处理通过 /ws/sync 鉴权成功的 WebSocket 连接
 */
export function handleSyncWsConnection(ws: WebSocket, req: IncomingMessage): void {
  syncWsClients.add(ws);
  console.log(`[SyncBroadcaster] 新增同步长连接客户端，当前活跃客户端总数: ${syncWsClients.size}`);

  // 连接握手成功后立即向客户端发送 ready 信号
  try {
    ws.send(JSON.stringify({
      type: 'sync:ready',
      message: '双端实时同步长连接就绪',
      timestamp: Date.now()
    }));
  } catch (err) {
    console.warn('[SyncBroadcaster] 发送 ready 消息异常:', err);
  }

  // 心跳响应与协议消息处理
  ws.on('message', (data: any) => {
    try {
      const msgStr = data.toString();
      const msg = JSON.parse(msgStr);
      if (msg.type === 'ping' || msg.type === 'sync:ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      } else if (msg.type === 'sync:notify') {
        console.log(`[SyncBroadcaster] 收到客户端主动广播请求 (seq: ${msg.seq ?? 'latest'})`);
        broadcastSyncInvalidated(msg.seq);
      }
    } catch {
      // 容错非 JSON 消息
    }
  });

  ws.on('close', () => {
    syncWsClients.delete(ws);
    console.log(`[SyncBroadcaster] 同步长连接客户端断开，当前活跃客户端数: ${syncWsClients.size}`);
  });

  ws.on('error', (err) => {
    console.warn('[SyncBroadcaster] 同步客户端连接异常:', err.message);
    syncWsClients.delete(ws);
  });
}

/**
 * 广播同步失效/变更信号至所有在线的客户端
 * 当云端或本地数据库产生新变更时触发，毫秒级唤醒远端对齐
 */
export function broadcastSyncInvalidated(maxSeq?: number): void {
  if (syncWsClients.size === 0) return;

  const payload = JSON.stringify({
    type: 'sync:invalidated',
    seq: maxSeq,
    timestamp: Date.now()
  });

  let broadcastCount = 0;
  for (const client of syncWsClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
        broadcastCount++;
      } catch (e: any) {
        console.warn('[SyncBroadcaster] 广播同步信号异常:', e.message);
      }
    }
  }

  if (broadcastCount > 0) {
    console.log(`[SyncBroadcaster] 已向 ${broadcastCount} 个在线同步客户端广播实时变更失效信号 (seq: ${maxSeq ?? 'latest'})。`);
  }
}

import { clientStates } from '../websocket/state';

/**
 * 当本地调度器完成同步拉取或推送后，通知当前打开的桌面端 Web 前端刷新 Store
 */
export function notifyLocalFrontendSyncDone(stats?: { pushed: number; pulled: number }): void {
  const msg = JSON.stringify({
    type: 'sync:completed',
    payload: stats || { pushed: 0, pulled: 0 }
  });
  for (const [_sessionId, state] of clientStates) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      try {
        state.ws.send(msg);
      } catch {}
    }
  }
}

/**
 * 获取当前活跃连接数
 */
export function getActiveSyncClientsCount(): number {
  return syncWsClients.size;
}
