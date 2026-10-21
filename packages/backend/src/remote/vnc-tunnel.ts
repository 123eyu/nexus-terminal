import net from 'net';
import WebSocket from 'ws';
import type { RemoteSessionTicket } from './remote-session.store';

/**
 * VNC 隧道：noVNC 直接把 RFB 协议跑在 WebSocket 上，
 * 我们只需要把字节原样转给 TCP——认证（VNC password / VeNCrypt）由浏览器端自己完成。
 */
export function handleVncTunnel(ws: WebSocket, ticket: RemoteSessionTicket): void {
  let closed = false;

  const socket = net.connect({ host: ticket.host, port: ticket.port });
  socket.setNoDelay(true);

  const timer = setTimeout(() => {
    if (!closed) {
      console.error(`[RemoteVNC] 连接 ${ticket.host}:${ticket.port} 超时`);
      teardown();
      try { ws.close(1011, 'connect timeout'); } catch { /* noop */ }
    }
  }, 10_000);

  function teardown() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    try { socket.destroy(); } catch { /* noop */ }
    try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch { /* noop */ }
  }

  socket.once('connect', () => clearTimeout(timer));
  socket.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  });
  socket.on('error', (err) => {
    console.warn(`[RemoteVNC] ${ticket.host}:${ticket.port} socket 错误:`, err.message);
    teardown();
    try { ws.close(1011, err.message.slice(0, 100)); } catch { /* noop */ }
  });
  socket.on('close', teardown);

  ws.on('message', (data) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (!socket.destroyed) socket.write(chunk);
  });
  ws.on('close', teardown);
  ws.on('error', teardown);
}
