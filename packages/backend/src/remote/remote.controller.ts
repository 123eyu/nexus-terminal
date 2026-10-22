import { Request, Response } from 'express';
import * as ConnectionService from '../connections/connection.service';
import * as ConnectionRepository from '../connections/connection.repository';
import { createTicket } from './remote-session.store';
import { decrypt } from '../utils/crypto';
import type { RemoteProxyConfig } from './proxy-connect';

/**
 * 取连接记录绑定的代理（SOCKS5 / HTTP CONNECT）。
 *
 * 什么都没配 → null（直连）；配了 jump（跳板机链）→ null + 警告，
 * 因为跳板机链是 SSH 专用的（需要在跳板机上开 direct-tcpip 通道），远程桌面不支持。
 * 配了 proxy 但代理记录缺失 → 抛错，让用户在连接时就看到明确原因，而不是一个"连不上"。
 */
const resolveProxyConfig = async (connectionId: number): Promise<RemoteProxyConfig | null> => {
  const row = await ConnectionRepository.findFullConnectionById(connectionId);
  if (!row || !row.proxy_db_id) return null;

  if (row.proxy_type === 'jump') {
    console.warn(
      `[RemoteSession] 连接 ${connectionId} 配置的是跳板机链（jump），远程桌面不支持，本次直连。`
    );
    return null;
  }

  const type = row.actual_proxy_server_type;
  if (type !== 'SOCKS5' && type !== 'HTTP') {
    throw new Error(`连接绑定的代理类型无效（${String(type)}），仅支持 SOCKS5 / HTTP。`);
  }
  if (!row.proxy_host || !row.proxy_port) {
    throw new Error(`连接绑定的代理记录不存在（proxy_id=${row.proxy_db_id}），请重新选择代理。`);
  }

  return {
    type,
    host: row.proxy_host,
    port: row.proxy_port,
    username: row.proxy_username || undefined,
    password: row.proxy_encrypted_password ? decrypt(row.proxy_encrypted_password) : undefined,
  };
};

/**
 * 为一次远程桌面连接签发一次性票据。
 *
 * POST /api/v1/connections/:id/remote-session
 * body: { protocol?: 'rdp' | 'vnc' }
 * 返回: { ticket, protocol, username, password, domain, wsPath }
 *
 * 前端拿到后：
 *   RDP → IronRDP Web 组件把 wsPath 作为 proxyAddress，ticket 作为 authToken
 *   VNC → noVNC 直接连 wsPath，剪贴板/认证都在 RFB 协议里自己做
 *
 * 代理（SOCKS5 / HTTP）不在这里拨号：票据里带上解密后的代理参数，
 * 由 `/ws/remote/*` 的隧道在服务端建立 TCP 时套用（见 proxy-connect.ts）。
 */
export const createRemoteSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const connectionId = parseInt(req.params.id, 10);
    if (Number.isNaN(connectionId)) {
      res.status(400).json({ message: '无效的连接 ID。' });
      return;
    }

    // @ts-ignore express-session 类型来自全局增强
    const userId = req.session?.userId;
    if (!userId) {
      res.status(401).json({ message: '未登录。' });
      return;
    }

    const data = await ConnectionService.getConnectionWithDecryptedCredentials(connectionId);
    if (!data) {
      res.status(404).json({ message: '连接未找到。' });
      return;
    }
    const { connection, decryptedPassword } = data;

    const requested = String(req.body?.protocol || '').toLowerCase();
    const protocol: 'rdp' | 'vnc' | null =
      requested === 'rdp' || requested === 'vnc'
        ? requested
        : connection.type === 'RDP'
          ? 'rdp'
          : connection.type === 'VNC'
            ? 'vnc'
            : null;

    if (!protocol) {
      res.status(400).json({ message: '该连接不是远程桌面类型。' });
      return;
    }
    if (connection.type !== protocol.toUpperCase()) {
      res.status(400).json({ message: `连接类型（${connection.type}）与请求的协议（${protocol}）不一致。` });
      return;
    }
    if (connection.auth_method !== 'password' || !decryptedPassword) {
      res.status(400).json({ message: '远程桌面连接需要密码认证，或密码解密失败。' });
      return;
    }

    // 记录"最近连接时间"，失败不影响主流程
    try {
      await ConnectionRepository.updateLastConnected(connectionId, Math.floor(Date.now() / 1000));
    } catch (err) {
      console.warn('[RemoteSession] 更新 last_connected_at 失败:', err);
    }

    // 代理配置读不出来就直接拒掉：与其让用户对着"连不上"猜，不如在这里说清楚
    let proxy: RemoteProxyConfig | null = null;
    try {
      proxy = await resolveProxyConfig(connectionId);
    } catch (err: any) {
      res.status(400).json({ message: err?.message || '代理配置无效。' });
      return;
    }
    if (proxy) {
      console.log(
        `[RemoteSession] ${protocol.toUpperCase()} ${connection.host}:${connection.port} 经 ${proxy.type} 代理 ${proxy.host}:${proxy.port}`
      );
    }

    const ticket = createTicket({
      userId: Number(userId),
      protocol,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: decryptedPassword,
      proxy,
      connectionId,
    });

    res.status(200).json({
      ticket,
      protocol,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: decryptedPassword,
      domain: '',
      // 相对路径，前端按当前 origin 拼成 ws:// 或 wss://
      wsPath: protocol === 'rdp' ? '/ws/remote/rdp' : '/ws/remote/vnc',
    });
  } catch (error: any) {
    console.error('[RemoteSession] 创建远程会话票据失败:', error?.message || error);
    res.status(500).json({ message: '创建远程会话失败。' });
  }
};
