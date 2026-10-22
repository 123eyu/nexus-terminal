import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  expandHostRange,
  parseScriptLine,
  parseScriptSingleLine,
  parseScriptText,
  tokenizeArgs,
} from '../src/utils/scriptConnectionParser.ts';

test('tokenizeArgs：引号里的空格不切', () => {
  assert.deepEqual(tokenizeArgs('a "b c" \'d e\''), ['a', '"b c"', "'d e'"]);
});

test('expandHostRange：短写 ~ 展开', () => {
  assert.deepEqual(expandHostRange('10.0.0.10~12').hosts, ['10.0.0.10', '10.0.0.11', '10.0.0.12']);
});

test('expandHostRange：整段写法等价', () => {
  assert.deepEqual(expandHostRange('10.0.0.10~10.0.0.12').hosts, ['10.0.0.10', '10.0.0.11', '10.0.0.12']);
});

test('expandHostRange：跨 C 段报 invalidRange', () => {
  const r = expandHostRange('10.0.0.10~10.0.1.12');
  assert.deepEqual(r.hosts, []);
  assert.equal(r.error?.code, 'invalidRange');
});

test('expandHostRange：起大于止报 invalidRange', () => {
  assert.equal(expandHostRange('10.0.0.20~10').error?.code, 'invalidRange');
});

test('expandHostRange：普通主机名原样返回，不报错', () => {
  assert.deepEqual(expandHostRange('web-01.example.com').hosts, ['web-01.example.com']);
});

test('expandHostRange：整段 0~255 允许（上限就是一个 C 段）', () => {
  const r = expandHostRange('10.0.0.0~255');
  assert.equal(r.error, undefined);
  assert.equal(r.hosts.length, 256);
});

test('选项式：用户名/端口/密码/名称/文件夹/备注', () => {
  const res = parseScriptLine('admin@10.0.0.5:2222 -p "P@ss word" -name 生产网关 -folder 生产 -note "别乱动 here"');
  assert.ok('items' in res);
  if (!('items' in res)) return;
  const c = res.items[0];
  assert.equal(c.type, 'SSH');
  assert.equal(c.host, '10.0.0.5');
  assert.equal(c.port, 2222);
  assert.equal(c.username, 'admin');
  assert.equal(c.password, 'P@ss word');
  assert.equal(c.name, '生产网关');
  assert.deepEqual(c.tags, ['生产']);
  assert.equal(c.note, '别乱动 here');
  assert.equal(c.auth_method, 'password');
});

test('OpenSSH 命令行：-p 数字当端口，-i 当密钥', () => {
  const res = parseScriptLine('ssh -p 2222 -i my-key root@10.0.0.5');
  assert.ok('items' in res);
  if (!('items' in res)) return;
  const c = res.items[0];
  assert.equal(c.port, 2222);
  assert.equal(c.keyName, 'my-key');
  assert.equal(c.auth_method, 'key');
});

test('URL 形式：rdp:// 带内嵌密码，端口默认 3389', () => {
  const res = parseScriptLine('rdp://Administrator:pass@1.2.3.4:3389');
  assert.ok('items' in res);
  if (!('items' in res)) return;
  const c = res.items[0];
  assert.equal(c.type, 'RDP');
  assert.equal(c.password, 'pass');
  assert.equal(c.port, 3389);
  assert.equal(c.username, 'Administrator');
});

test('冒号四段式：host:port:user:pass', () => {
  const res = parseScriptLine('10.0.0.5:22:root:p@ss');
  assert.ok('items' in res);
  if (!('items' in res)) return;
  assert.equal(res.items[0].username, 'root');
  assert.equal(res.items[0].password, 'p@ss');
});

test('空格四段式：host port user pass', () => {
  const res = parseScriptLine('10.0.0.5 2222 deploy s3cret');
  assert.ok('items' in res);
  if (!('items' in res)) return;
  assert.equal(res.items[0].port, 2222);
  assert.equal(res.items[0].username, 'deploy');
  assert.equal(res.items[0].password, 's3cret');
});

test('新选项：文件传输协议 / 背景色 / 跳板机链', () => {
  const res = parseScriptLine('root@10.0.0.5 -p pass -protocol scp -color "#3b82f6" -jump bastion1,bastion2');
  assert.ok('items' in res);
  if (!('items' in res)) return;
  const c = res.items[0];
  assert.equal(c.fileProtocol, 'scp');
  assert.equal(c.backgroundColor, '#3b82f6');
  assert.deepEqual(c.jumpNames, ['bastion1', 'bastion2']);
});

test('IP 范围 + 自定义名：每台主机都带上末位后缀', () => {
  const res = parseScriptLine('root@10.0.0.10~11 -p pass -name web');
  assert.ok('items' in res);
  if (!('items' in res)) return;
  assert.equal(res.items.length, 2);
  assert.deepEqual(res.items.map((c) => c.host), ['10.0.0.10', '10.0.0.11']);
  assert.deepEqual(res.items.map((c) => c.name), ['web-10', 'web-11']);
  assert.equal(res.items[0].rangeSource, '10.0.0.10~11');
});

test('IP 范围不带自定义名：名字用各自主机', () => {
  const res = parseScriptLine('root@10.0.0.10~11 -p pass');
  assert.ok('items' in res);
  if (!('items' in res)) return;
  assert.deepEqual(res.items.map((c) => c.name), ['root@10.0.0.10', 'root@10.0.0.11']);
});

test('错误码：SSH 既没密码也没密钥', () => {
  const res = parseScriptLine('root@10.0.0.5');
  assert.ok('code' in res);
  if (!('code' in res)) return;
  assert.equal(res.code, 'missingCredential');
});

test('错误码：RDP 没密码', () => {
  const res = parseScriptLine('rdp://1.2.3.4:3389');
  assert.ok('code' in res);
  if (!('code' in res)) return;
  assert.equal(res.code, 'missingPassword');
});

test('错误码：协议值不合法', () => {
  const res = parseScriptLine('root@10.0.0.5 -p pass -protocol ftp');
  assert.ok('code' in res);
  if (!('code' in res)) return;
  assert.equal(res.code, 'invalidProtocol');
});

test('错误码：颜色值不合法', () => {
  const res = parseScriptLine('root@10.0.0.5 -p pass -color red');
  assert.ok('code' in res);
  if (!('code' in res)) return;
  assert.equal(res.code, 'invalidColor');
});

test('错误码：选项缺值', () => {
  const res = parseScriptLine('root@10.0.0.5 -p');
  assert.ok('code' in res);
  if (!('code' in res)) return;
  assert.equal(res.code, 'missingValue');
});

test('错误码：端口不合法', () => {
  const res = parseScriptLine('root@10.0.0.5 -port 99999 -p pass');
  assert.ok('code' in res);
  if (!('code' in res)) return;
  assert.equal(res.code, 'invalidPort');
});

test('注释与空行算 skipped', () => {
  assert.deepEqual(parseScriptLine('# 注释'), { skipped: true });
  assert.deepEqual(parseScriptLine('   '), { skipped: true });
  assert.deepEqual(parseScriptLine('// x'), { skipped: true });
});

test('parseScriptSingleLine：兼容老调用方，只给第一台', () => {
  const res = parseScriptSingleLine('root@10.0.0.10~11 -p pass');
  assert.equal(res.data?.host, '10.0.0.10');
  assert.equal(res.error, undefined);
});

test('parseScriptText：错误行进 rows 且带 code，合法行拍平', () => {
  const text = ['# 表头', 'root@10.0.0.5 -p pass', 'root@10.0.0.6', 'root@10.0.0.10~11 -p pass'].join('\n');
  const r = parseScriptText(text);
  assert.equal(r.totalLines, 4);
  assert.equal(r.skippedLines, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].lineIndex, 3);
  assert.equal(r.errors[0].code, 'missingCredential');
  assert.equal(r.validConnections.length, 3); // 1 + 展开的 2
  assert.equal(r.rows.length, 4);
  assert.equal(r.rows[2].errorCode, 'missingCredential');
  assert.equal(r.rows[3].items.length, 2);
});
