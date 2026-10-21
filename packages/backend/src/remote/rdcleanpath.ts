/**
 * RDCleanPath（ASN.1 DER）编解码。
 *
 * 这是 IronRDP 的 WebAssembly 客户端与"网关/代理"之间的握手协议：浏览器拿不到裸 TCP，
 * 也读不到 RDP 服务器的自签名证书，所以先把客户端构造好的 X.224 连接请求交给代理，
 * 代理连上真实主机、把服务器的 X.224 响应和 **证书链** 回传给客户端，
 * 之后这条 WebSocket 上跑的就是原始 RDP 字节流（客户端自己做端到端 TLS）。
 *
 * 线格式（见 IronRDP crates/ironrdp-rdcleanpath）：
 *   SEQUENCE {
 *     [0] INTEGER            version = 3390
 *     [1] SEQUENCE           error   { [0] error_code, [1] http_status?, [2] wsa_err?, [3] tls_alert? }
 *     [2] UTF8String         destination        (client → proxy)
 *     [3] UTF8String         proxy_auth         (client → proxy)
 *     [4] UTF8String         server_auth        (保留)
 *     [5] UTF8String         preconnection_blob
 *     [6] OCTET STRING       x224_connection_pdu
 *     [7] SEQUENCE OF OCTET STRING  server_cert_chain   (proxy → client)
 *     [8] (保留，未实现)
 *     [9] UTF8String         server_addr        (proxy → client)
 *   }
 * 所有字段都是 EXPLICIT 标签（0xA0|n），缺失即省略，没有长度前缀——WebSocket 消息边界 + DER 自描述长度。
 */

export const RDCLEANPATH_VERSION = 3390;
export const ERR_GENERAL = 1;
export const ERR_NEGOTIATION = 2;

const TAG_INTEGER = 0x02;
const TAG_OCTET = 0x04;
const TAG_UTF8 = 0x0c;
const TAG_SEQUENCE = 0x30;

/* ------------------------------ 编码 ------------------------------ */

function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

/** 无符号整数 → DER INTEGER（最小长度二补码，最高位为 1 时补 0x00） */
export function derInteger(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`非法整数: ${value}`);
  const bytes: number[] = [];
  let n = value;
  do {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(TAG_INTEGER, Buffer.from(bytes));
}

function derString(value: string): Buffer {
  return tlv(TAG_UTF8, Buffer.from(value, 'utf8'));
}

function derOctet(value: Buffer): Buffer {
  return tlv(TAG_OCTET, value);
}

function derSequence(items: Buffer[]): Buffer {
  return tlv(TAG_SEQUENCE, Buffer.concat(items));
}

/** EXPLICIT 包装：[n] → 0xA0|n */
function explicitField(n: number, content: Buffer): Buffer {
  return tlv(0xa0 | n, content);
}

export interface RDCleanPathRequest {
  version: number;
  destination: string;
  proxyAuth?: string;
  preconnectionBlob?: string;
  x224?: Buffer;
}

export interface RDCleanPathResponse {
  version: number;
  x224?: Buffer;
  serverCertChain?: Buffer[];
  serverAddr?: string;
}

export interface RDCleanPathErrorPdu {
  version: number;
  errorCode: number;
  httpStatus?: number;
  wsaError?: number;
  tlsAlert?: number;
  /** error_code=2 时携带服务器的 X.224 响应，用来提示"服务端要求 NLA"这类原因 */
  x224?: Buffer;
}

function topLevel(fields: Buffer[]): Buffer {
  return derSequence(fields);
}

export function encodeRequest(req: RDCleanPathRequest): Buffer {
  const fields: Buffer[] = [explicitField(0, derInteger(req.version || RDCLEANPATH_VERSION))];
  if (req.destination) fields.push(explicitField(2, derString(req.destination)));
  fields.push(explicitField(3, derString(req.proxyAuth ?? '')));
  if (req.preconnectionBlob) fields.push(explicitField(5, derString(req.preconnectionBlob)));
  if (req.x224?.length) fields.push(explicitField(6, derOctet(req.x224)));
  return topLevel(fields);
}

export function encodeResponse(res: RDCleanPathResponse): Buffer {
  const fields: Buffer[] = [explicitField(0, derInteger(res.version || RDCLEANPATH_VERSION))];
  if (res.x224?.length) fields.push(explicitField(6, derOctet(res.x224)));
  if (res.serverCertChain?.length) {
    fields.push(explicitField(7, derSequence(res.serverCertChain.map((c) => derOctet(c)))));
  }
  if (res.serverAddr) fields.push(explicitField(9, derString(res.serverAddr)));
  return topLevel(fields);
}

export function encodeError(pdu: RDCleanPathErrorPdu): Buffer {
  const errFields: Buffer[] = [explicitField(0, derInteger(pdu.errorCode))];
  if (pdu.httpStatus) errFields.push(explicitField(1, derInteger(pdu.httpStatus)));
  if (pdu.wsaError) errFields.push(explicitField(2, derInteger(pdu.wsaError)));
  if (pdu.tlsAlert) errFields.push(explicitField(3, derInteger(pdu.tlsAlert)));

  const fields: Buffer[] = [
    explicitField(0, derInteger(pdu.version || RDCLEANPATH_VERSION)),
    explicitField(1, derSequence(errFields)),
  ];
  if (pdu.x224?.length) fields.push(explicitField(6, derOctet(pdu.x224)));
  return topLevel(fields);
}

/* ------------------------------ 解码 ------------------------------ */

interface TlvNode {
  tag: number;
  value: Buffer;
  /** 整个 TLV（含 tag+length）占用的字节数 */
  size: number;
}

/** 读一个 TLV；数据不足返回 null */
function readTlv(buf: Buffer, offset = 0): TlvNode | null {
  if (buf.length - offset < 2) return null;
  const tag = buf[offset];
  let len = buf[offset + 1];
  let headerLen = 2;

  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('不支持的 DER 长度编码');
    if (buf.length - offset < 2 + n) return null;
    len = 0;
    for (let i = 0; i < n; i += 1) len = len * 256 + buf[offset + 2 + i];
    headerLen = 2 + n;
  }
  if (buf.length - offset < headerLen + len) return null;
  return {
    tag,
    value: buf.subarray(offset + headerLen, offset + headerLen + len),
    size: headerLen + len,
  };
}

function decodeInteger(node: TlvNode): number {
  if (node.tag !== TAG_INTEGER) throw new Error(`期望 INTEGER，实际 0x${node.tag.toString(16)}`);
  let value = 0;
  for (let i = 0; i < Math.min(node.value.length, 6); i += 1) {
    value = value * 256 + node.value[i];
  }
  return value;
}

function decodeString(node: TlvNode): string {
  return node.value.toString('utf8');
}

function decodeSequenceChildren(node: TlvNode): TlvNode[] {
  const out: TlvNode[] = [];
  let off = 0;
  while (off < node.value.length) {
    const child = readTlv(node.value, off);
    if (!child) break;
    out.push(child);
    off += child.size;
  }
  return out;
}

/**
 * 流式探测：判断缓冲区里是否已有一条完整的 RDCleanPath PDU。
 * 返回整条 PDU 的字节数；数据不够返回 null；非法数据抛错。
 */
export function detectPduLength(buf: Buffer): number | null {
  if (buf.length < 4) return null;
  if (buf[0] !== TAG_SEQUENCE) throw new Error('RDCleanPath PDU 不是 SEQUENCE');
  let len = buf[1];
  let headerLen = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('不支持的 DER 长度编码');
    if (buf.length < 2 + n) return null;
    len = 0;
    for (let i = 0; i < n; i += 1) len = len * 256 + buf[2 + i];
    headerLen = 2 + n;
  }
  const total = headerLen + len;
  if (buf.length < total) return null;

  // 首个字段必须是 version=3390，否则说明不是我们要的协议
  const first = readTlv(buf.subarray(headerLen, total));
  if (first && first.tag === 0xa0) {
    const inner = readTlv(first.value);
    if (inner && decodeInteger(inner) !== RDCLEANPATH_VERSION) {
      throw new Error('RDCleanPath 版本不匹配');
    }
  }
  return total;
}

export interface DecodedPdu {
  version: number;
  destination?: string;
  proxyAuth?: string;
  preconnectionBlob?: string;
  x224?: Buffer;
  serverAddr?: string;
  serverCertChain?: Buffer[];
  error?: { errorCode: number; httpStatus?: number; wsaError?: number; tlsAlert?: number };
}

function readOptionalInt(fields: Map<number, TlvNode>, idx: number): number | undefined {
  const outer = fields.get(idx);
  if (!outer) return undefined;
  const inner = readTlv(outer.value);
  return inner ? decodeInteger(inner) : undefined;
}

export function decodePdu(buf: Buffer): DecodedPdu {
  const outer = readTlv(buf, 0);
  if (!outer || outer.tag !== TAG_SEQUENCE) throw new Error('RDCleanPath PDU 格式错误');

  const fields = new Map<number, TlvNode>();
  for (const child of decodeSequenceChildren(outer)) {
    if ((child.tag & 0xe0) === 0xa0) fields.set(child.tag & 0x1f, child);
  }

  const pdu: DecodedPdu = { version: 0 };

  const versionNode = fields.get(0);
  if (versionNode) {
    const inner = readTlv(versionNode.value);
    if (inner) pdu.version = decodeInteger(inner);
  }

  const errorNode = fields.get(1);
  if (errorNode) {
    const seq = readTlv(errorNode.value);
    const errFields = new Map<number, TlvNode>();
    if (seq) {
      for (const child of decodeSequenceChildren(seq)) {
        if ((child.tag & 0xe0) === 0xa0) errFields.set(child.tag & 0x1f, child);
      }
    }
    pdu.error = {
      errorCode: readOptionalInt(errFields, 0) ?? 0,
      httpStatus: readOptionalInt(errFields, 1),
      wsaError: readOptionalInt(errFields, 2),
      tlsAlert: readOptionalInt(errFields, 3),
    };
  }

  const dest = fields.get(2);
  if (dest) {
    const inner = readTlv(dest.value);
    if (inner) pdu.destination = decodeString(inner);
  }
  const auth = fields.get(3);
  if (auth) {
    const inner = readTlv(auth.value);
    if (inner) pdu.proxyAuth = decodeString(inner);
  }
  const pcb = fields.get(5);
  if (pcb) {
    const inner = readTlv(pcb.value);
    if (inner) pdu.preconnectionBlob = decodeString(inner);
  }
  const x224 = fields.get(6);
  if (x224) {
    const inner = readTlv(x224.value);
    if (inner) pdu.x224 = Buffer.from(inner.value);
  }
  const chain = fields.get(7);
  if (chain) {
    const seq = readTlv(chain.value);
    if (seq) {
      pdu.serverCertChain = decodeSequenceChildren(seq)
        .filter((n) => n.tag === TAG_OCTET)
        .map((n) => Buffer.from(n.value));
    }
  }
  const addr = fields.get(9);
  if (addr) {
    const inner = readTlv(addr.value);
    if (inner) pdu.serverAddr = decodeString(inner);
  }

  return pdu;
}
