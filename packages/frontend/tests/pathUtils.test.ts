import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractFolderNameFromPath, resolveRemotePath, parentOfRemotePath } from '../src/utils/pathUtils.ts';

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

// --- resolveRemotePath：新建文件/文件夹时输入框里的路径解析 ---

test('resolveRemotePath：纯文件名挂在当前目录下', () => {
  assert.equal(resolveRemotePath('/var/log', 'nginx.log'), '/var/log/nginx.log');
  assert.equal(resolveRemotePath('/', 'a.txt'), '/a.txt');
});

test('resolveRemotePath：./ 前缀等价于当前目录', () => {
  assert.equal(resolveRemotePath('/home/u', './asd/222/1.txt'), '/home/u/asd/222/1.txt');
  assert.equal(resolveRemotePath('/home/u', './/a//./b/'), '/home/u/a/b');
});

test('resolveRemotePath：../ 回退一级', () => {
  assert.equal(resolveRemotePath('/home/u', '../x/1.txt'), '/home/x/1.txt');
  assert.equal(resolveRemotePath('/home/u', '../../a'), '/a');
});

test('resolveRemotePath：回退到根就停在根（不会跑出 /）', () => {
  assert.equal(resolveRemotePath('/home', '../../../etc/passwd'), '/etc/passwd');
  assert.equal(resolveRemotePath('/', '..'), '/');
  assert.equal(resolveRemotePath('/', '../../..'), '/');
});

test('resolveRemotePath：绝对路径原样（再规范化）', () => {
  assert.equal(resolveRemotePath('/home/u', '/etc/nginx/conf.d'), '/etc/nginx/conf.d');
  assert.equal(resolveRemotePath('/home/u', '/etc//nginx/../nginx/a.conf'), '/etc/nginx/a.conf');
});

test('resolveRemotePath：空输入回落到当前目录', () => {
  assert.equal(resolveRemotePath('/home/u', ''), '/home/u');
  assert.equal(resolveRemotePath('/home/u', '   '), '/home/u');
});

test('parentOfRemotePath：取父目录', () => {
  assert.equal(parentOfRemotePath('/home/u/a/b.txt'), '/home/u/a');
  assert.equal(parentOfRemotePath('/a'), '/');
  assert.equal(parentOfRemotePath('/'), '/');
  assert.equal(parentOfRemotePath('/home/u/'), '/home');
});
