import net from 'net';
import http from 'http';
import { SocksClient, SocksClientOptions } from 'socks';

/**
 * RDP / VNC 隧道用的 TCP 连接器：直连 / SOCKS5 / HTTP CONNECT。
 *
 * 为什么单独抽一个文件：`rdp-tunnel.ts` 与 `vnc-tunnel.ts` 都只需要一个「已经连到目标端口」的
 * socket（RDP 之后还要在它上面做 X.224 + TLS，VNC 直接在上面跑 RFB），代理逻辑放在这里两处共用。
 * 注意不要直接复用 `ssh.service.ts` 里的那套：那边是给 ssh2 的 `sock` 准备的，耦合了 SSH 的
 * 连接配置与日志，远程桌面用不上。
 */
export interface RemoteProxyConfig {
  type: 'SOCKS5' | 'HTTP';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface RemoteConnectOptions {
  /** 为空表示直连 */
  proxy?: RemoteProxyConfig | null;
  timeoutMs?: number;
}

/** 连接（含代理握手）超时。走代理时多一个 RTT，比裸连宽一点 */
export const REMOTE_CONNECT_TIMEOUT_MS = 12_000;

function connectDirect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function connectViaSocks5(
  host: string,
  port: number,
  proxy: RemoteProxyConfig,
  timeoutMs: number
): Promise<net.Socket> {
  const options: SocksClientOptions = {
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type: 5,
      userId: proxy.username,
      password: proxy.password,
    },
    command: 'connect',
    // 目标给的是主机名时会按 SOCKS5 的 DOMAINNAME 发过去，由代理解析 DNS
    destination: { host, port },
    timeout: timeoutMs,
  };

  try {
    const { socket } = await SocksClient.createConnection(options);
    return socket as net.Socket;
  } catch (err: any) {
    throw new Error(`SOCKS5 代理 ${proxy.host}:${proxy.port} 连接失败: ${err?.message || err}`);
  }
}

function connectViaHttpProxy(
  host: string,
  port: number,
  proxy: RemoteProxyConfig,
  timeoutMs: number
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { Host: `${host}:${port}` };
    if (proxy.username) {
      headers['Proxy-Authorization'] =
        'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
    }

    const req = http.request({
      method: 'CONNECT',
      host: proxy.host,
      port: proxy.port,
      path: `${host}:${port}`,
      timeout: timeoutMs,
      headers,
      agent: false,
    });

    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(message));
    };

    req.on('connect', (res, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(`HTTP 代理 ${proxy.host}:${proxy.port} 拒绝 CONNECT ${host}:${port}（状态码 ${res.statusCode}）`);
        return;
      }
      settled = true;
      // 200 之后代理可能已经把目标服务器的首包带回来了，必须塞回 socket，
      // 否则 RDP 的 X.224 / VNC 的 RFB 版本握手会直接缺一段字节（表现为一直等超时）
      if (head && head.length) socket.unshift(head);
      resolve(socket as net.Socket);
    });
    req.on('error', (err) => fail(`HTTP 代理 ${proxy.host}:${proxy.port} 请求失败: ${err.message}`));
    req.on('timeout', () => fail(`HTTP 代理 ${proxy.host}:${proxy.port} 连接超时`));
    req.end();
  });
}

/** 连到目标 TCP 端口，按需经过 SOCKS5 / HTTP 代理。返回的 socket 保证已 connected */
export async function connectRemoteTcp(
  host: string,
  port: number,
  options: RemoteConnectOptions = {}
): Promise<net.Socket> {
  const timeoutMs = options.timeoutMs ?? REMOTE_CONNECT_TIMEOUT_MS;
  const proxy = options.proxy;

  let socket: net.Socket;
  if (!proxy) {
    socket = await connectDirect(host, port, timeoutMs);
  } else if (proxy.type === 'SOCKS5') {
    socket = await connectViaSocks5(host, port, proxy, timeoutMs);
  } else if (proxy.type === 'HTTP') {
    socket = await connectViaHttpProxy(host, port, proxy, timeoutMs);
  } else {
    throw new Error(`不支持的代理类型: ${String((proxy as RemoteProxyConfig).type)}`);
  }

  socket.setNoDelay(true);
  return socket;
}
