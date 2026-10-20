import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveOpenMode } from '../src/utils/fileOpenMode.ts';

/**
 * 「打开文件走内置编辑器还是系统默认程序」的判定。
 *
 * 这条规则被文件管理器（5 处入口）和终端右键菜单共用，判错的表现是：
 *   - 在 Web 上突然弹「外部程序打开失败」（浏览器里根本没有这个能力）
 *   - 或桌面端设了外部程序却还是弹内置编辑器（设置看起来"没生效"）
 */

test('Web / 移动端：无论设置是什么都走内置编辑器', () => {
  assert.equal(resolveOpenMode({ isDesktop: false, preference: 'external' }), 'builtin');
  assert.equal(resolveOpenMode({ isDesktop: false, preference: 'builtin' }), 'builtin');
});

test('桌面端 + external：走系统默认程序', () => {
  assert.equal(resolveOpenMode({ isDesktop: true, preference: 'external' }), 'external');
});

test('桌面端 + builtin：走内置编辑器', () => {
  assert.equal(resolveOpenMode({ isDesktop: true, preference: 'builtin' }), 'builtin');
});

test('设置缺失（新装 / 老数据）时默认内置编辑器', () => {
  assert.equal(resolveOpenMode({ isDesktop: true, preference: undefined }), 'builtin');
  assert.equal(resolveOpenMode({ isDesktop: true, preference: null }), 'builtin');
  assert.equal(resolveOpenMode({ isDesktop: true, preference: '' }), 'builtin');
});

test('设置值非法时不能误判成外部打开', () => {
  // 大小写 / 拼错 / 别的枚举值都只能退回内置编辑器，否则点了没反应
  assert.equal(resolveOpenMode({ isDesktop: true, preference: 'EXTERNAL' }), 'builtin');
  assert.equal(resolveOpenMode({ isDesktop: true, preference: 'system' }), 'builtin');
  assert.equal(resolveOpenMode({ isDesktop: true, preference: 'true' }), 'builtin');
});
