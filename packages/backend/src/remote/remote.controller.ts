import { Request, Response } from 'express';
import * as ConnectionService from '../connections/connection.service';
import * as ConnectionRepository from '../connections/connection.repository';
import { createTicket } from './remote-session.store';

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

    const ticket = createTicket({
      userId: Number(userId),
      protocol,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: decryptedPassword,
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
