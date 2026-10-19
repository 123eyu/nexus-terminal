import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffDirectoryChildren, fileAttributesChanged } from '../src/utils/fileListDiff.ts';
import type { FileListItem } from '../src/types/sftp.types.ts';

function item(filename: string, overrides: Partial<FileListItem['attrs']> = {}): FileListItem {
  return {
    filename,
    longname: `-rw-r--r-- 1 root root 0 ${filename}`,
    attrs: {
      size: 0,
      uid: 0,
      gid: 0,
      mode: 0o644,
      atime: 0,
      mtime: 1000,
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
      ...overrides,
    },
  };
}

const node = (i: FileListItem) => ({ filename: i.filename, longname: i.longname, attrs: i.attrs });

test('文件内容/时间/权限/类型都没变时不算更新', () => {
  assert.equal(fileAttributesChanged(item('a').attrs, item('a').attrs), false);
});

test('任一展示字段变化都算更新', () => {
  const base = item('a');
  assert.equal(fileAttributesChanged(base.attrs, item('a', { size: 1 }).attrs), true);
  assert.equal(fileAttributesChanged(base.attrs, item('a', { mtime: 2000 }).attrs), true);
  assert.equal(fileAttributesChanged(base.attrs, item('a', { mode: 0o755 }).attrs), true);
  assert.equal(fileAttributesChanged(base.attrs, item('a', { isDirectory: true }).attrs), true);
  assert.equal(fileAttributesChanged(base.attrs, item('a', { isSymbolicLink: true }).attrs), true);
});

test('atime/uid/gid 变化不触发高亮（不展示）', () => {
  assert.equal(fileAttributesChanged(item('a').attrs, item('a', { atime: 9, uid: 9, gid: 9 }).attrs), false);
});

test('diff：识别新增 / 删除 / 修改', () => {
  const existing = [node(item('keep')), node(item('gone')), node(item('touch'))];
  const incoming = [item('keep'), item('touch', { size: 42 }), item('fresh')];

  const diff = diffDirectoryChildren(existing, incoming);

  assert.deepEqual(diff.removed, ['gone']);
  assert.deepEqual(diff.updated.map((u) => u.node.filename), ['touch']);
  assert.deepEqual(diff.added.map((a) => a.filename), ['fresh']);
  // 更新项带回服务端的最新属性，调用方据此原地写回
  assert.equal(diff.updated[0].item.attrs.size, 42);
});

test('diff：完全一致时三项都为空（不会误打高亮）', () => {
  const list = [item('a'), item('b')];
  const diff = diffDirectoryChildren(list.map(node), list);
  assert.deepEqual(diff, { removed: [], updated: [], added: [] });
});

test('diff：首次加载（现有为空）时全部算新增', () => {
  const diff = diffDirectoryChildren([], [item('a'), item('b')]);
  assert.deepEqual(diff.added.map((a) => a.filename), ['a', 'b']);
  assert.deepEqual(diff.removed, []);
});

test('diff：目录条目被清空时全部算删除', () => {
  const diff = diffDirectoryChildren([node(item('a')), node(item('b'))], []);
  assert.deepEqual(diff.removed, ['a', 'b']);
  assert.deepEqual(diff.added, []);
});
