import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  countCommandsInFolder,
  resolveCommandFolderColor,
  resolveFolderColor,
} from '../src/utils/quickCommandDisplay.ts';

const folders = [
  { id: 1, background_color: '#ff0000' },
  { id: 2, background_color: null },
  { id: 3 },
];

test('resolveFolderColor：取文件夹自定义底色', () => {
  assert.equal(resolveFolderColor(folders, 1), '#ff0000');
});

test('resolveFolderColor：颜色为空 / 文件夹不存在 / 无 id 时返回 null', () => {
  assert.equal(resolveFolderColor(folders, 2), null);
  assert.equal(resolveFolderColor(folders, 3), null);
  assert.equal(resolveFolderColor(folders, 999), null);
  assert.equal(resolveFolderColor(folders, null), null);
  assert.equal(resolveFolderColor(folders, 0), null);
});

test('resolveCommandFolderColor：分组遍历时以分组 tagId 为准', () => {
  const cmd = { tagIds: [1] };
  // 分组是 2（无颜色），命令自己挂在 1 上 —— 应该跟随分组
  assert.equal(resolveCommandFolderColor(folders, cmd, 2), null);
  assert.equal(resolveCommandFolderColor(folders, cmd, 1), '#ff0000');
});

test('resolveCommandFolderColor：没有分组时取命令自己的第一个标签', () => {
  assert.equal(resolveCommandFolderColor(folders, { tagIds: [1, 2] }), '#ff0000');
  assert.equal(resolveCommandFolderColor(folders, { tagIds: [] }), null);
  assert.equal(resolveCommandFolderColor(folders, {}), null);
});

test('countCommandsInFolder：all 统计全部', () => {
  const list = [{ tagIds: [1] }, { tagIds: [2, 1] }, {}];
  assert.equal(countCommandsInFolder(list, 'all'), 3);
});

test('countCommandsInFolder：untagged 只统计无标签的', () => {
  const list = [{ tagIds: [1] }, { tagIds: [] }, {}, { tagIds: undefined as any }];
  assert.equal(countCommandsInFolder(list, 'untagged'), 3);
});

test('countCommandsInFolder：按标签统计（一条命令可属于多个文件夹）', () => {
  const list = [{ tagIds: [1] }, { tagIds: [1, 2] }, { tagIds: [2] }, {}];
  assert.equal(countCommandsInFolder(list, 1), 2);
  assert.equal(countCommandsInFolder(list, 2), 2);
  assert.equal(countCommandsInFolder(list, 9), 0);
});
