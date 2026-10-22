import crypto from 'crypto';
import type { RemoteProxyConfig } from './proxy-connect';

/**
 * 一次性连接票据。
 *
 * 为什么不把主机/凭据直接塞进 WebSocket URL：
 *   URL 会进浏览器历史、反代日志、Referer。凭据必须在服务端保管，
 *   浏览器只拿到一个几十秒就失效的随机票据，WebSocket 握手时再换回真实参数。
 */
export interface RemoteSessionTicket {
  userId: number;
  protocol: 'rdp' | 'vnc';
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** RDP 可选域；留空时客户端把 username 原样发（支持 DOMAIN\\user 或 user@domain） */
  domain?: string;
  /** 连接记录绑定的 SOCKS5 / HTTP 代理；为空表示直连。凭据已解密，票存在服务端内存里 */
  proxy?: RemoteProxyConfig | null;
  /** 连接记录 id，仅用于日志 */
  connectionId: number;
  createdAt: number;
}

const TTL_MS = 60_000;
const tickets = new Map<string, RemoteSessionTicket>();

function sweep() {
  const now = Date.now();
  for (const [key, value] of tickets) {
    if (now - value.createdAt > TTL_MS) tickets.delete(key);
  }
}

export function createTicket(input: Omit<RemoteSessionTicket, 'createdAt'>): string {
  sweep();
  const ticket = crypto.randomBytes(24).toString('base64url');
  tickets.set(ticket, { ...input, createdAt: Date.now() });
  return ticket;
}

/** 取出并作废（一次性）。票据只允许用一次，避免被复用 */
export function consumeTicket(ticket: string, userId: number): RemoteSessionTicket | null {
  const found = tickets.get(ticket);
  if (!found) return null;
  tickets.delete(ticket);
  if (found.userId !== userId) return null;
  if (Date.now() - found.createdAt > TTL_MS) return null;
  return found;
}

export function ticketCount(): number {
  sweep();
  return tickets.size;
}
