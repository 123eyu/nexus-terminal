import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import {
  buildLocalCopyPath,
  getExternalOpenDir,
  shouldTreatAsConflict,
} from '../src/sftp/services/external-open.util.ts';

/**
 * 外部编辑器回传的两个关键判定：
 *   1. 本地副本路径必须"同一文件永远同一路径"（否则每点一次堆一个副本，监听也盯不住）
 *   2. 冲突判定必须不误报（误报=每次保存都弹窗）也不漏报（漏报=直接覆盖别人的修改）
 */

// --- 本地副本路径 ---

test('buildLocalCopyPath：同一 (连接, 路径) 稳定不变', () => {
  const dir = '/tmp/x';
  const a = buildLocalCopyPath(dir, 7, '/etc/nginx/nginx.conf');
  const b = buildLocalCopyPath(dir, 7, '/etc/nginx/nginx.conf');
  assert.equal(a, b);
});

test('buildLocalCopyPath：不同连接 / 不同路径互不冲突', () => {
  const dir = '/tmp/x';
  const base = buildLocalCopyPath(dir, 7, '/etc/hosts');
  assert.notEqual(base, buildLocalCopyPath(dir, 8, '/etc/hosts'));
  assert.notEqual(base, buildLocalCopyPath(dir, 7, '/etc/hostname'));
});

test('buildLocalCopyPath：保留原文件名（系统按扩展名选程序）并且不含路径分隔符', () => {
  // 用真实的临时目录做前缀，避免 Windows / POSIX 分隔符差异影响断言
  const dir = path.join(os.tmpdir(), 'nexus-test-external');
  const p = buildLocalCopyPath(dir, 1, '/var/log/app/runtime.log');
  assert.ok(p.endsWith('-runtime.log'), p);
  // 目录分隔符只能来自 dir 前缀本身
  assert.equal(path.dirname(p), dir);
});

test('buildLocalCopyPath：文件名里带非法字符会被替换掉', () => {
  const p = buildLocalCopyPath('/tmp/x', 1, '/tmp/a:b*c?.txt');
  const name = path.basename(p);
  assert.ok(!/[:*?]/.test(name), name);
  assert.ok(name.endsWith('.txt'), name);
});

test('getExternalOpenDir：落在系统临时目录下，不污染用户目录', () => {
  const dir = getExternalOpenDir();
  assert.ok(dir.startsWith(os.tmpdir()), dir);
});

// --- 冲突判定 ---

test('shouldTreatAsConflict：mtime 未变 → 不冲突（正常自动回传）', () => {
  assert.equal(shouldTreatAsConflict(1700000000, 1700000000), false);
});

test('shouldTreatAsConflict：1 秒内差异算同一时刻（SFTP mtime 只有秒精度）', () => {
  assert.equal(shouldTreatAsConflict(1700000000, 1700000001), false);
});

test('shouldTreatAsConflict：远程确实被改过 → 冲突', () => {
  assert.equal(shouldTreatAsConflict(1700000000, 1700000060), true);
});

test('shouldTreatAsConflict：任一 mtime 拿不到时按不冲突处理（不能让功能卡死）', () => {
  assert.equal(shouldTreatAsConflict(null, 1700000000), false);
  assert.equal(shouldTreatAsConflict(1700000000, null), false);
  assert.equal(shouldTreatAsConflict(undefined, undefined), false);
});

test('shouldTreatAsConflict：支持自定义容差', () => {
  assert.equal(shouldTreatAsConflict(1700000000, 1700000005, 10), false);
  assert.equal(shouldTreatAsConflict(1700000000, 1700000020, 10), true);
});
