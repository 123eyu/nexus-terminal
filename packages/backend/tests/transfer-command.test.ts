import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTransferCommandString,
  escapeShellArg,
  stripTrailingSlashes,
} from '../src/transfers/transfer-command.ts';

const TARGET = { targetUserAndHost: 'root@10.0.0.2', sshPortOption: '-P 2222' };
const RSYNC = { targetUserAndHost: 'root@10.0.0.2', sshPortOption: '-p 2222' };

test('发送目录：rsync 源路径不能带尾斜杠（否则内容被摊进目标目录）', () => {
  const cmd = buildTransferCommandString('/data/test', true, '/root/docker', '/usr/bin/rsync', 'rsync', RSYNC);
  // 期望：/root/docker/test，而不是把 test 里的东西直接倒进 /root/docker
  assert.ok(cmd.includes(`'/data/test'`), `源路径应为 '/data/test'，实际命令：${cmd}`);
  assert.ok(!cmd.includes(`/data/test/'`), `源路径不应带尾斜杠：${cmd}`);
  assert.ok(cmd.endsWith(`root@10.0.0.2:'/root/docker/'`), `目标应为父目录：${cmd}`);
});

test('发送目录：源路径本来就有尾斜杠时会被归一化', () => {
  const cmd = buildTransferCommandString('/data/test///', true, '/root/docker', '/usr/bin/rsync', 'rsync', RSYNC);
  assert.ok(cmd.includes(`'/data/test'`), `应去掉多余尾斜杠：${cmd}`);
  assert.ok(!cmd.includes('/data/test/'), `不应残留斜杠：${cmd}`);
});

test('发送目录：scp 同样不补尾斜杠，并带 -r', () => {
  const cmd = buildTransferCommandString('/data/test', true, '/root/docker', '/usr/bin/scp', 'scp', TARGET);
  assert.ok(cmd.includes(' -r '), `目录应带 -r：${cmd}`);
  assert.ok(cmd.includes(`'/data/test'`), `源路径不带斜杠：${cmd}`);
  assert.ok(!cmd.includes('/data/test/'), `不应有尾斜杠：${cmd}`);
  assert.ok(cmd.includes(`root@10.0.0.2:'/root/docker/'`), `目标为父目录：${cmd}`);
});

test('发送文件：scp 不带 -r，目标仍是父目录（文件名由 scp 保留）', () => {
  const cmd = buildTransferCommandString('/data/a.txt', false, '/root/docker', '/usr/bin/scp', 'scp', TARGET);
  assert.ok(!cmd.includes(' -r '), `文件不应带 -r：${cmd}`);
  assert.ok(cmd.includes(`'/data/a.txt'`), cmd);
});

test('目标路径带不带尾斜杠都归一成 <dir>/', () => {
  const a = buildTransferCommandString('/x', false, '/root/docker', '/usr/bin/scp', 'scp', TARGET);
  const b = buildTransferCommandString('/x', false, '/root/docker/', '/usr/bin/scp', 'scp', TARGET);
  assert.equal(a, b);
  assert.ok(a.endsWith(`:'/root/docker/'`), a);
});

test('根目录不会被 stripTrailingSlashes 清成空串', () => {
  assert.equal(stripTrailingSlashes('/'), '/');
  assert.equal(stripTrailingSlashes('///'), '/');
  assert.equal(stripTrailingSlashes('/a/b/'), '/a/b');
  assert.equal(stripTrailingSlashes('/a/b'), '/a/b');
});

test('路径里的单引号按 shell 规则转义', () => {
  assert.equal(escapeShellArg(`/data/it's`), `'/data/it'\\''s'`);
  const cmd = buildTransferCommandString(`/data/it's`, true, '/root/docker', '/usr/bin/rsync', 'rsync', RSYNC);
  assert.ok(cmd.includes(`'/data/it'\\''s'`), cmd);
});

test('rsync 的端口要进 -e "ssh -p X"，不是命令行裸 -p', () => {
  const cmd = buildTransferCommandString('/data/test', true, '/root/docker', '/usr/bin/rsync', 'rsync', RSYNC);
  assert.ok(cmd.includes('-e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222"'), cmd);
  assert.ok(!cmd.includes('-avz --progress -p 2222'), `-p 不能在 -e 之外：${cmd}`);
});

test('sshpass 前缀放在命令最前面', () => {
  const cmd = buildTransferCommandString('/data/test', true, '/root/docker', '/usr/bin/scp', 'scp', {
    ...TARGET,
    sshPassCommand: `'/usr/bin/sshpass' -p 'pa ss'`,
  });
  assert.ok(cmd.startsWith(`'/usr/bin/sshpass' -p 'pa ss' /usr/bin/scp `), cmd);
});
