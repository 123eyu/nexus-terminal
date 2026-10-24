import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectRelayEntries,
  joinRemotePath,
  type RelayEntry,
} from '../src/transfers/transfers.relay.ts';

/* ------------------------------------------------------------------ */
/* joinRemotePath：SFTP 只认 /，绝不能出现 Windows 反斜杠                */
/* ------------------------------------------------------------------ */

test('joinRemotePath：普通拼接', () => {
  assert.equal(joinRemotePath('/data', 'docs'), '/data/docs');
});

test('joinRemotePath：base 已有尾斜杠时不会拼出 //', () => {
  assert.equal(joinRemotePath('/data/', 'docs'), '/data/docs');
});

test('joinRemotePath：根目录', () => {
  assert.equal(joinRemotePath('/', 'docs'), '/docs');
});

test('joinRemotePath：空 name 原样返回 base（根条目自身）', () => {
  assert.equal(joinRemotePath('/data/docs', ''), '/data/docs');
});

test('joinRemotePath：空 base 时返回 name', () => {
  assert.equal(joinRemotePath('', 'docs'), 'docs');
});

test('joinRemotePath：绝不引入反斜杠（后端可能跑在 Windows 上）', () => {
  const joined = joinRemotePath('/relay-received', 'docs/a.txt');
  assert.ok(!joined.includes('\\'), joined);
  assert.equal(joined, '/relay-received/docs/a.txt');
});

/* ------------------------------------------------------------------ */
/* collectRelayEntries：相对路径 / 递归顺序 / 符号链接                    */
/* ------------------------------------------------------------------ */

interface FakeNode {
  dir?: boolean;
  link?: boolean;
  size?: number;
  mode?: number;
  children?: string[];
}

function makeStats(node: FakeNode) {
  return {
    size: node.size ?? 0,
    mode: node.mode ?? (node.dir ? 0o040755 : 0o100644),
    isDirectory: () => !!node.dir,
    isFile: () => !node.dir && !node.link,
    isSymbolicLink: () => !!node.link,
  };
}

function makeSftp(tree: Record<string, FakeNode>) {
  return {
    lstat(targetPath: string, callback: (err: Error | null | undefined, stats?: any) => void) {
      const node = tree[targetPath];
      if (!node) {
        const error: any = new Error(`No such file: ${targetPath}`);
        error.code = 2;
        return callback(error);
      }
      callback(null, makeStats(node));
    },
    readdir(targetPath: string, callback: (err: Error | null | undefined, list?: any[]) => void) {
      const node = tree[targetPath];
      if (!node || !node.dir) {
        const error: any = new Error(`Not a directory: ${targetPath}`);
        error.code = 2;
        return callback(error);
      }
      const list = (node.children ?? []).map((name) => ({
        filename: name,
        longname: name,
        attrs: makeStats(tree[joinRemotePath(targetPath, name)] ?? {}),
      }));
      callback(null, list);
    },
  } as any;
}

test('collectRelayEntries：目录先于其子项出现，且 relativePath 相对传输根', async () => {
  const sftp = makeSftp({
    '/data/docs': { dir: true, children: ['a.txt', 'sub'] },
    '/data/docs/a.txt': { size: 7 },
    '/data/docs/sub': { dir: true, children: ['b.txt'] },
    '/data/docs/sub/b.txt': { size: 11 },
  });

  const entries = await collectRelayEntries(sftp, '/data/docs', true);

  assert.deepEqual(
    entries.map((entry) => [entry.relativePath, entry.isDirectory]),
    [
      ['', true],
      ['a.txt', false],
      ['sub', true],
      ['sub/b.txt', false],
    ]
  );
  assert.equal(entries[0].remotePath, '/data/docs');
  assert.equal(entries[3].remotePath, '/data/docs/sub/b.txt');
  assert.equal(entries[3].size, 11);
});

test('collectRelayEntries：单文件只有一条，relativePath 为空', async () => {
  const sftp = makeSftp({ '/data/a.txt': { size: 4 } });
  const entries = await collectRelayEntries(sftp, '/data/a.txt', false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].relativePath, '');
  assert.equal(entries[0].isDirectory, false);
  assert.equal(entries[0].size, 4);
});

test('collectRelayEntries：符号链接被跳过并上报（避免把外挂盘树拉进来）', async () => {
  const sftp = makeSftp({
    '/data/docs': { dir: true, children: ['real.txt', 'link.txt', 'linkdir'] },
    '/data/docs/real.txt': { size: 3 },
    '/data/docs/link.txt': { link: true },
    '/data/docs/linkdir': { link: true },
  });

  const skipped: string[] = [];
  const entries = await collectRelayEntries(sftp, '/data/docs', true, undefined, (p) => skipped.push(p));

  assert.deepEqual(entries.map((entry) => entry.relativePath), ['', 'real.txt']);
  assert.deepEqual(skipped.sort(), ['/data/docs/link.txt', '/data/docs/linkdir']);
});

test('collectRelayEntries：已经 abort 时抛 AbortError，不会白扫一遍', async () => {
  const sftp = makeSftp({ '/data/docs': { dir: true, children: [] } });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => collectRelayEntries(sftp, '/data/docs', true, controller.signal),
    (error: any) => error?.name === 'AbortError'
  );
});

test('collectRelayEntries：条目类型满足 RelayEntry 结构', async () => {
  const sftp = makeSftp({ '/data/a.txt': { size: 1, mode: 0o100640 } });
  const entries: RelayEntry[] = await collectRelayEntries(sftp, '/data/a.txt', false);
  assert.equal(entries[0].mode, 0o100640);
});
