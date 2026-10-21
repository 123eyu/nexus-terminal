import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodePdu,
  detectPduLength,
  encodeError,
  encodeRequest,
  encodeResponse,
  ERR_GENERAL,
  ERR_NEGOTIATION,
  RDCLEANPATH_VERSION,
} from '../src/remote/rdcleanpath.ts';

/**
 * RDCleanPath 的 DER 编解码必须和 IronRDP 的 Rust 实现逐字节兼容，
 * 否则浏览器那边的 WASM 客户端会报 "detection failed (invalid PDU)"，且完全看不出原因。
 */

test('最小 PDU：SEQUENCE { [0] 3390 } 的字节与规范样例一致', () => {
  // 规范里给的手工验算样例：30 06 A0 04 02 02 0D 3E
  const encoded = encodeResponse({ version: RDCLEANPATH_VERSION });
  assert.equal(encoded.toString('hex'), '3006a00402020d3e');
});

test('请求：destination / proxy_auth / X.224 都能往返', () => {
  const x224 = Buffer.from([0x0e, 0x00, 0x00, 0x00]);
  const encoded = encodeRequest({
    version: RDCLEANPATH_VERSION,
    destination: 'rdp.example.com:3389',
    proxyAuth: 'ticket-abc',
    x224,
  });

  const decoded = decodePdu(encoded);
  assert.equal(decoded.version, RDCLEANPATH_VERSION);
  assert.equal(decoded.destination, 'rdp.example.com:3389');
  assert.equal(decoded.proxyAuth, 'ticket-abc');
  assert.deepEqual(decoded.x224, x224);
  assert.equal(decoded.error, undefined);
});

test('请求：显式标签是 0xA0|n（EXPLICIT），不是 implicit 0x80|n', () => {
  const encoded = encodeRequest({
    version: RDCLEANPATH_VERSION,
    destination: 'h',
    proxyAuth: 't',
  });
  // 顶层 0x30，内部字段必须出现 A2（destination）与 A3（proxy_auth）
  assert.equal(encoded[0], 0x30);
  assert.ok(encoded.includes(0xa2), '缺少 [2] destination 的 EXPLICIT 标签');
  assert.ok(encoded.includes(0xa3), '缺少 [3] proxy_auth 的 EXPLICIT 标签');
  assert.ok(!encoded.includes(0x82) || encoded.indexOf(0x82) > 2, '不应出现 implicit 标签');
});

test('响应：证书链是 SEQUENCE OF OCTET STRING（多一层 0x30 嵌套）', () => {
  const cert1 = Buffer.from([1, 2, 3, 4]);
  const cert2 = Buffer.from([5, 6, 7]);
  const encoded = encodeResponse({
    version: RDCLEANPATH_VERSION,
    x224: Buffer.from([0x0e, 0x00, 0x00, 0x00]),
    serverCertChain: [cert1, cert2],
    serverAddr: '10.0.0.5',
  });

  const decoded = decodePdu(encoded);
  assert.equal(decoded.serverAddr, '10.0.0.5');
  assert.equal(decoded.serverCertChain?.length, 2);
  assert.deepEqual(decoded.serverCertChain?.[0], cert1);
  assert.deepEqual(decoded.serverCertChain?.[1], cert2);
});

test('错误 PDU：general error 带 wsa 码', () => {
  const encoded = encodeError({ version: RDCLEANPATH_VERSION, errorCode: ERR_GENERAL, wsaError: 10061 });
  const decoded = decodePdu(encoded);
  assert.equal(decoded.error?.errorCode, ERR_GENERAL);
  assert.equal(decoded.error?.wsaError, 10061);
});

test('错误 PDU：协商错误同时携带服务器 X.224 响应', () => {
  const x224 = Buffer.from([0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00]);
  const encoded = encodeError({ version: RDCLEANPATH_VERSION, errorCode: ERR_NEGOTIATION, x224 });
  const decoded = decodePdu(encoded);
  assert.equal(decoded.error?.errorCode, ERR_NEGOTIATION);
  assert.deepEqual(decoded.x224, x224);
});

test('detectPduLength：数据不足返回 null，收全后返回整条长度', () => {
  const encoded = encodeRequest({
    version: RDCLEANPATH_VERSION,
    destination: 'host:3389',
    proxyAuth: 't',
    x224: Buffer.alloc(20, 7),
  });
  for (let i = 0; i < encoded.length; i += 1) {
    assert.equal(detectPduLength(encoded.subarray(0, i)), null, `长度 ${i} 时应判为不完整`);
  }
  assert.equal(detectPduLength(encoded), encoded.length);
});

test('detectPduLength：版本号不对时直接抛错（避免把别的协议当 RDCleanPath）', () => {
  const bad = Buffer.from([0x30, 0x06, 0xa0, 0x04, 0x02, 0x02, 0x00, 0x01]);
  assert.throws(() => detectPduLength(bad), /版本/);
});

test('大整数长度：超过 127 字节的字段用长格式长度编码', () => {
  const x224 = Buffer.alloc(300, 0xaa);
  const encoded = encodeRequest({ version: RDCLEANPATH_VERSION, destination: 'h', proxyAuth: 't', x224 });
  const decoded = decodePdu(encoded);
  assert.equal(decoded.x224?.length, 300);
  assert.equal(detectPduLength(encoded), encoded.length);
});
