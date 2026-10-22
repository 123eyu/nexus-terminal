import net from 'net';
import WebSocket from 'ws';
import { connectRemoteTcp, REMOTE_CONNECT_TIMEOUT_MS } from './proxy-connect';
import type { RemoteSessionTicket } from './remote-session.store';

/** 建隧道的外层保险（连 + 代理握手），比 connectRemoteTcp 自己的超时略宽 */
const TUNNEL_TIMEOUT_MS = REMOTE_CONNECT_TIMEOUT_MS + 3_000;

/**
 * VNC 隧道：noVNC 直接把 RFB 协议跑在 WebSocket 上，
 * 我们只需要把字节原样转给 TCP——认证（VNC password / VeNCrypt）由浏览器端自己完成。
 *
 * 走代理时 TCP 是异步建立的（SOCKS5/HTTP 握手要几个 RTT），而 noVNC 一连上 WS 就会立刻
 * 发 RFB 版本号。所以隧道没建好之前进来的字节必须先排队，否则首包丢掉 →
 * 表现为「连上了但画面永远不出来」。
 */
export function handleVncTunnel(ws: WebSocket, ticket: RemoteSessionTicket): void {
  let closed = false;
  let socket: net.Socket | null = null;
  let pending: Buffer[] = [];

  function teardown() {
    if (closed) return;
    closed = true;
    pending = [];
    try { socket?.destroy(); } catch { /* noop */ }
    try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch { /* noop */ }
  }

  const timer = setTimeout(() => {
    if (closed) return;
    console.error(`[RemoteVNC] 连接 ${ticket.host}:${ticket.port} 超时`);
    teardown();
    try { ws.close(1011, 'connect timeout'); } catch { /* noop */ }
  }, TUNNEL_TIMEOUT_MS);

  const attach = (sock: net.Socket) => {
    socket = sock;

    sock.on('data', (chunk) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    });
    sock.on('error', (err) => {
      console.warn(`[RemoteVNC] ${ticket.host}:${ticket.port} socket 错误:`, err.message);
      teardown();
      try { ws.close(1011, err.message.slice(0, 100)); } catch { /* noop */ }
    });
    sock.on('close', teardown);

    // 先把建连期间攒下的客户端字节按顺序写进去
    for (const chunk of pending) sock.write(chunk);
    pending = [];
  };

  if (ticket.proxy) {
    console.log(
      `[RemoteVNC] ${ticket.host}:${ticket.port} 经 ${ticket.proxy.type} 代理 ${ticket.proxy.host}:${ticket.proxy.port} 建立 TCP`
    );
  }

  void connectRemoteTcp(ticket.host, ticket.port, {
    proxy: ticket.proxy,
    timeoutMs: REMOTE_CONNECT_TIMEOUT_MS,
  })
    .then((sock) => {
      clearTimeout(timer);
      if (closed) {
        sock.destroy();
        return;
      }
      attach(sock);
    })
    .catch((err: Error) => {
      clearTimeout(timer);
      const via = ticket.proxy ? `（经 ${ticket.proxy.type} 代理 ${ticket.proxy.host}:${ticket.proxy.port}）` : '';
      console.warn(`[RemoteVNC] 连接 ${ticket.host}:${ticket.port}${via} 失败:`, err.message);
      teardown();
      try { ws.close(1011, err.message.slice(0, 100)); } catch { /* noop */ }
    });

  ws.on('message', (data) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (socket && !socket.destroyed) socket.write(chunk);
    else if (!closed) pending.push(chunk);
  });
  ws.on('close', teardown);
  ws.on('error', teardown);
}
