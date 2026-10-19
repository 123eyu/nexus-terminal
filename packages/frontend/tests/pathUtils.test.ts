import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractFolderNameFromPath } from '../src/utils/pathUtils.ts';

test('extractFolderNameFromPath：取最后一段', () => {
  assert.equal(extractFolderNameFromPath('/var/log/nginx'), 'nginx');
});

test('extractFolderNameFromPath：根目录返回 root（不能返回空名字）', () => {
  assert.equal(extractFolderNameFromPath('/'), 'root');
  assert.equal(extractFolderNameFromPath(''), 'root');
});

test('extractFolderNameFromPath：尾斜杠先剥掉', () => {
  assert.equal(extractFolderNameFromPath('/var/log/nginx/'), 'nginx');
});

test('extractFolderNameFromPath：单段绝对路径', () => {
  assert.equal(extractFolderNameFromPath('/home'), 'home');
  assert.equal(extractFolderNameFromPath('/a'), 'a');
});

test('extractFolderNameFromPath：相对/无斜杠输入原样返回', () => {
  assert.equal(extractFolderNameFromPath('nginx'), 'nginx');
});
