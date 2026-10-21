import apiClient from '../../utils/apiClient';

export type RemoteProtocol = 'rdp' | 'vnc';

export interface RemoteSessionInfo {
  ticket: string;
  protocol: RemoteProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
  domain: string;
  /** 后端 ws 路径，如 /ws/remote/rdp */
  wsPath: string;
  /** 拼好的完整 WebSocket 地址（同源，自动 ws/wss） */
  wsUrl: string;
}

function buildWsUrl(path: string, ticket: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // 桌面端/反代/开发代理都是同源；Vite dev 时 http-proxy 也带 ws
  const host = window.location.host;
  return `${proto}//${host}${path}?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * 换取一次性票据。真实凭据只在这次响应里出现一次，
 * WebSocket 地址上只有票据（60 秒失效、只能用一次）。
 */
export async function requestRemoteSession(
  connectionId: number,
  protocol: RemoteProtocol
): Promise<RemoteSessionInfo> {
  const res = await apiClient.post<Omit<RemoteSessionInfo, 'wsUrl'>>(
    `connections/${connectionId}/remote-session`,
    { protocol }
  );
  const data = res.data;
  if (!data?.ticket || !data.wsPath) {
    throw new Error('后端没有返回远程会话票据');
  }
  return { ...data, wsUrl: buildWsUrl(data.wsPath, data.ticket) };
}
