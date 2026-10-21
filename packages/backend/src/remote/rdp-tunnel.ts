import net from 'net';
import tls from 'tls';
import WebSocket from 'ws';
import {
  decodePdu,
  detectPduLength,
  encodeError,
  encodeResponse,
  ERR_GENERAL,
  ERR_NEGOTIATION,
} from './rdcleanpath';
import type { RemoteSessionTicket } from './remote-session.store';

const CONNECT_TIMEOUT_MS = 10_000;
const X224_TIMEOUT_MS = 10_000;
const TLS_TIMEOUT_MS = 12_000;

/** 读一条完整的 TPKT 帧（X.224 握手就是 TPKT 承载的） */
function readTpktFrame(socket: net.Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('等待 X.224 响应超时'));
    }, timeoutMs);
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('连接在 X.224 握手前关闭'));
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      // TPKT: version(1) reserved(1) length(2, BE)
      const total = buf.readUInt16BE(2);
      if (buf.length >= total && total >= 7) {
        cleanup();
        resolve(buf.subarray(0, total));
      }
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

function connectTcp(host: string, port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 把 Node 的证书对象拍平成 DER 链（leaf 在前） */
function certificateChainToDer(cert: tls.PeerCertificate | undefined): Buffer[] {
  const chain: Buffer[] = [];
  let current: tls.PeerCertificate | undefined = cert;
  const seen = new Set<string>();
  while (current && current.raw) {
    const fingerprint = current.fingerprint256 || String(chain.length);
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);
    chain.push(Buffer.from(current.raw));
    const next: tls.PeerCertificate | undefined = (current as any).issuerCertificate;
    if (!next || next === current) break;
    current = next;
  }
  return chain;
}

/**
 * 在已经完成 X.224 协商的连接上升级 TLS。
 *
 * 关键点：RDCleanPath 里的 `server_cert_chain` **不是**让客户端自己做 TLS 用的，
 * 而是让客户端校验"代理背后确实是我要连的那台服务器"（防中间人）。
 * TLS 由代理终结，客户端在 WebSocket 上跑的是明文 RDP。
 * 之前把 TLS 留给客户端，xrdp 会直接报 `wrong version number`（收到明文 ClientHello 后的应答）。
 */
function upgradeToTls(
  socket: net.Socket,
  timeoutMs = TLS_TIMEOUT_MS
): Promise<{ tlsSocket: tls.TLSSocket; chain: Buffer[] }> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({
      socket,
      // 自签名证书是常态（xrdp / Windows 默认都是），链会回传给客户端自行判断
      rejectUnauthorized: false,
      servername: undefined,
    });
    const timer = setTimeout(() => {
      tlsSocket.destroy();
      reject(new Error('TLS 握手超时'));
    }, timeoutMs);
    tlsSocket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve({ tlsSocket, chain: certificateChainToDer(tlsSocket.getPeerCertificate(true)) });
    });
    tlsSocket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sendErrorPdu(ws: WebSocket, errorCode: number, x224?: Buffer, wsa?: number) {
  try {
    ws.send(encodeError({ version: 3390, errorCode, x224, wsaError: wsa }));
  } catch { /* 连接已断，忽略 */ }
}

/** RDP 色深常量（RNS_UD_COLOR_*），注意不是位宽本身 */
const COLOR_32BPP = 0xca04;

/**
 * 把 Connect Initial 里声明的色深抬到 32bpp。
 *
 * IronRDP 的位图解码只处理 32bpp：客户端声明 8bpp 时 xrdp 会发 16bpp RLE 位图，
 * 结果画面能出但整片花屏（斜线条带）。服务器是按客户端声明的色深发图的，
 * 所以在代理层把这几个字段纠正成 32bpp 是唯一不改客户端内核的修法。
 *
 * 结构（CS_CORE，小端）：type(2) len(2) version(4) width(2) height(2) colorDepth(2)
 *   … clientName(32) + keyboard 三件套(6) + imeFileName(64) → postBeta2ColorDepth(2)
 *   → clientProductId(2) serial(4) highColorDepth(2) supportedColorDepths(2)
 */
function patchClientColorDepth(buf: Buffer): boolean {
  // 按 "version + width + height + colorDepth" 特征定位 CS_CORE：
  // IronRDP 会把 GCC 压缩成 `Duca` 容器，但 CS_CORE 的字段本身仍是明文，
  // 所以不用解析容器结构，认 version(0x00080004) 后面紧跟合法尺寸与色深常量即可。
  for (let i = 0; i + 134 <= buf.length; i += 1) {
    if (buf.readUInt32LE(i) !== 0x00080004) continue;
    const width = buf.readUInt16LE(i + 4);
    const height = buf.readUInt16LE(i + 6);
    const colorDepth = buf.readUInt16LE(i + 8);
    if (width === 0 || height === 0) continue;
    if (colorDepth !== 0xca01 && colorDepth !== 0xca02 && colorDepth !== 0xca03) continue;

    // 相对 version 的偏移：colorDepth +8 / postBeta2 +122 / highColor +130 / supported +132
    const postBeta2 = buf.readUInt16LE(i + 122);
    const supported = buf.readUInt16LE(i + 132);
    buf.writeUInt16LE(COLOR_32BPP, i + 8);
    buf.writeUInt16LE(COLOR_32BPP, i + 122);
    buf.writeUInt16LE(0x0006, i + 130); // RNS_UD_HIGHCOLOR_32BPP
    buf.writeUInt16LE(supported | 0x000b, i + 132); // 声明支持 24/16/32
    console.log(
      `[RemoteRDP] 色深纠正为 32bpp: ${width}x${height} colorDepth=0x${colorDepth.toString(16)}` +
      ` postBeta2=0x${postBeta2.toString(16)} supported=0x${supported.toString(16)}`
    );
    return true;
  }
  return false;
}

/**
 * 处理一条 RDP 隧道连接。
 *
 * 时序：
 *   1. 客户端发来 DER 编码的 RDCleanPath 请求（含它自己构造的 X.224 连接请求）
 *   2. 我们连真实主机，把 X.224 发过去，读回服务器的 X.224 确认
 *   3. 在连接上升级 TLS，取回服务器证书链
 *   4. 回 DER 响应（X.224 + 证书链 + 服务器地址）
 *   5. 之后这条 WS 上双向搬运明文 RDP 字节（TLS 由我们终结）
 */
export function handleRdpTunnel(ws: WebSocket, ticket: RemoteSessionTicket): void {
  let socket: net.Socket | null = null;
  let tlsSocket: tls.TLSSocket | null = null;
  let closed = false;
  let buffer = Buffer.alloc(0);
  let established = false;
  let colorDepthPatched = false;

  const teardown = () => {
    if (closed) return;
    closed = true;
    try { tlsSocket?.destroy(); } catch { /* noop */ }
    try { socket?.destroy(); } catch { /* noop */ }
    try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch { /* noop */ }
  };

  const fail = (message: string, errorCode = ERR_GENERAL, wsa?: number) => {
    console.error(`[RemoteRDP] ${ticket.host}:${ticket.port} →`, message);
    sendErrorPdu(ws, errorCode, undefined, wsa);
    teardown();
  };

  ws.on('close', teardown);
  ws.on('error', teardown);

  const establish = async (request: Buffer) => {
    let pdu;
    try {
      pdu = decodePdu(request);
    } catch (err) {
      fail(`RDCleanPath 请求解析失败: ${(err as Error).message}`);
      return;
    }

    if (pdu.error) {
      fail(`客户端返回错误 ${pdu.error.errorCode}`);
      return;
    }
    if (!pdu.x224?.length) {
      fail('请求里缺少 X.224 连接请求');
      return;
    }

    try {
      socket = await connectTcp(ticket.host, ticket.port);
    } catch (err: any) {
      fail(`连接 ${ticket.host}:${ticket.port} 失败: ${err.message}`, ERR_GENERAL, err.errno === -111 ? 10061 : undefined);
      return;
    }

    socket.on('error', (err) => {
      console.warn('[RemoteRDP] 隧道 socket 错误:', err.message);
      teardown();
    });
    socket.on('close', teardown);

    // 把客户端的 X.224 原样发过去，等服务器确认
    let x224Response: Buffer;
    try {
      socket.write(pdu.x224);
      x224Response = await readTpktFrame(socket, X224_TIMEOUT_MS);
    } catch (err: any) {
      fail(`X.224 协商失败: ${err.message}`, ERR_NEGOTIATION);
      return;
    }

    // X.224 一旦确认，服务器就等着 TLS ClientHello —— 必须由我们接管 TLS，
    // 否则客户端会把明文 Connect Initial 灌进来，服务器只能报 wrong version number。
    let chain: Buffer[] = [];
    try {
      const upgraded = await upgradeToTls(socket);
      tlsSocket = upgraded.tlsSocket;
      chain = upgraded.chain;
    } catch (err: any) {
      fail(`TLS 握手失败: ${err.message}`, ERR_NEGOTIATION);
      return;
    }

    const serverAddr = socket.remoteAddress || ticket.host;
    try {
      ws.send(encodeResponse({
        version: 3390,
        x224: x224Response,
        serverCertChain: chain.length ? chain : undefined,
        serverAddr: serverAddr.replace(/^::ffff:/, ''),
      }));
    } catch (err) {
      console.warn('[RemoteRDP] 回写 RDCleanPath 响应失败:', (err as Error).message);
      teardown();
      return;
    }

    established = true;

    // 之后就是纯字节搬运：客户端在 WS 上跑明文 RDP，TLS 已经在服务端侧终结
    tlsSocket.on('data', (chunk) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    });
    tlsSocket.on('error', (err) => {
      console.warn('[RemoteRDP] TLS 连接错误:', err.message);
      teardown();
    });
    tlsSocket.on('close', teardown);
  };

  ws.on('message', (data: WebSocket.RawData) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

    if (!established) {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const total = detectPduLength(buffer);
        if (total === null) return; // 还没收全
        const pduBytes = buffer.subarray(0, total);
        const rest = buffer.subarray(total);
        buffer = Buffer.alloc(0);
        void establish(pduBytes).then(() => {
          // 极端情况下客户端把 DER 和后续字节放一起发了
          if (rest.length && tlsSocket) tlsSocket.write(rest);
        });
      } catch (err) {
        fail(`RDCleanPath 探测失败: ${(err as Error).message}`);
      }
      return;
    }

    if (tlsSocket && !tlsSocket.destroyed) {
      let out = chunk;
      if (!colorDepthPatched) {
        // 客户端在 Connect Initial 之前还会先发 Erect Domain / Attach User 两条 MCS 请求，
        // 所以不能只看第一条消息，逐条试到命中 CS_CORE 为止。
        const copy = Buffer.from(chunk);
        if (patchClientColorDepth(copy)) {
          colorDepthPatched = true;
          out = copy;
        }
      }
      tlsSocket.write(out);
    }
  });
}
