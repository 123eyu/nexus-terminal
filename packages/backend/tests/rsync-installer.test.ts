import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRsyncProbe,
  buildRsyncInstallCommands,
  type RsyncInstallProbe,
} from '../src/transfers/rsync-installer.ts';

const probe = (overrides: Partial<RsyncInstallProbe> = {}): RsyncInstallProbe => ({
  packageManager: 'apt-get',
  isRoot: true,
  hasPasswordlessSudo: false,
  ...overrides,
});

test('解析探测脚本输出', () => {
  assert.deepEqual(parseRsyncProbe('PM=apt-get\nROOT=1\nSUDO=0\n'), {
    packageManager: 'apt-get',
    isRoot: true,
    hasPasswordlessSudo: false,
  });

  assert.deepEqual(parseRsyncProbe('PM=apk\nROOT=0\nSUDO=1\n'), {
    packageManager: 'apk',
    isRoot: false,
    hasPasswordlessSudo: true,
  });

  // 没有包管理器时 PM 是空串
  assert.equal(parseRsyncProbe('PM=\nROOT=0\nSUDO=0\n').packageManager, null);
  // 乱七八糟的输出不能炸，也不能把未知 PM 当成已知的
  assert.equal(parseRsyncProbe('garbage').packageManager, null);
  assert.equal(parseRsyncProbe('PM=brew\nROOT=1').packageManager, null);
});

test('root 直接装，不加 sudo', () => {
  const commands = buildRsyncInstallCommands(probe());
  assert.equal(commands.length, 2, 'apt 失败后还有一次「先 update 再装」的兜底');
  assert.equal(commands[0], 'env DEBIAN_FRONTEND=noninteractive apt-get install -y rsync');
  assert.ok(!commands[0].includes('sudo'));
});

test('非 root 但有免密 sudo → 用 sudo -n（绝不弹密码）', () => {
  const commands = buildRsyncInstallCommands(probe({ isRoot: false, hasPasswordlessSudo: true }));
  assert.ok(commands[0].startsWith('sudo -n env '), commands[0]);
  assert.ok(commands[0].includes('apt-get install -y rsync'));
  // fallback 的 update 与 install 两段都要带提权前缀，否则第二段会以普通用户身份失败
  assert.equal(commands[1].split(' && ').length, 2);
  for (const part of commands[1].split(' && ')) {
    assert.ok(part.startsWith('sudo -n '), part);
  }
});

test('非 root 且没有免密 sudo → 一条命令都不给（别挂死在密码提示上）', () => {
  assert.deepEqual(buildRsyncInstallCommands(probe({ isRoot: false, hasPasswordlessSudo: false })), []);
  assert.deepEqual(buildRsyncInstallCommands(probe({ packageManager: null })), []);
});

test('各发行版的安装命令', () => {
  const first = (packageManager: RsyncInstallProbe['packageManager']) =>
    buildRsyncInstallCommands(probe({ packageManager }))[0];

  assert.equal(first('apk'), 'apk add --no-cache rsync');
  assert.equal(first('dnf'), 'dnf install -y rsync');
  assert.equal(first('yum'), 'yum install -y rsync');
  assert.equal(first('zypper'), 'zypper --non-interactive install rsync');
  assert.equal(first('pacman'), 'pacman -Sy --noconfirm --needed rsync');
  // 只有 apt 需要「更新索引后重试」
  assert.equal(buildRsyncInstallCommands(probe({ packageManager: 'apk' })).length, 1);
});
