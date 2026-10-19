import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PRESET_ID,
  DEFAULT_PRESET_NAME,
  buildDefaultPresetFrom,
  buildPresetsSignature,
  reconcilePresets,
  sanitizeDefaultPresetName,
} from '../src/utils/layoutPreset.ts';
import { layoutShapeSignature } from '../src/utils/layoutTree.ts';
import type { LayoutNode, LayoutPreset } from '../src/types/layout.ts';

const builtinLayout: LayoutNode = {
  id: 'root',
  type: 'container',
  direction: 'horizontal',
  children: [
    { id: 'a', type: 'pane', component: 'connections', size: 20 },
    { id: 'b', type: 'pane', component: 'terminal', size: 80 },
  ],
};

const sidebars = { left: [], right: [] };

function preset(id: string, name: string, layout: LayoutNode = builtinLayout): LayoutPreset {
  return { id, name, layoutTree: layout, sidebarPanes: { left: [], right: [] } };
}

test('sanitizeDefaultPresetName：去掉历史星标与空白', () => {
  assert.equal(sanitizeDefaultPresetName('⭐ 默认布局'), DEFAULT_PRESET_NAME);
  assert.equal(sanitizeDefaultPresetName('  ★ 默认布局 '), DEFAULT_PRESET_NAME);
  assert.equal(sanitizeDefaultPresetName('我的布局'), '我的布局');
  assert.equal(sanitizeDefaultPresetName(''), DEFAULT_PRESET_NAME);
  assert.equal(sanitizeDefaultPresetName(undefined), DEFAULT_PRESET_NAME);
});

test('buildDefaultPresetFrom：深拷贝用户布局，改动结果不影响源对象', () => {
  const userTree: LayoutNode = { ...builtinLayout, children: [{ id: 'x', type: 'pane', component: 'terminal', size: 100 }] };
  const result = buildDefaultPresetFrom(userTree, sidebars, { tree: builtinLayout, sidebars });

  assert.equal(result.id, DEFAULT_PRESET_ID);
  assert.deepEqual(result.layoutTree, userTree);

  (result.layoutTree.children![0] as LayoutNode).size = 55;
  assert.equal(userTree.children![0].size, 100);
});

test('buildDefaultPresetFrom：用户布局为空时回落到出厂布局', () => {
  const result = buildDefaultPresetFrom(null, null, { tree: builtinLayout, sidebars });
  assert.deepEqual(result.layoutTree, builtinLayout, layoutShapeSignature);
  assert.deepEqual(result.sidebarPanes, sidebars);
});

test('reconcilePresets：过滤已废弃的内置模板', () => {
  const stored = [preset('preset-single-terminal', '单终端'), preset('preset-dual-terminals', '双终端')];
  const result = reconcilePresets(stored, preset(DEFAULT_PRESET_ID, DEFAULT_PRESET_NAME), builtinLayout, layoutShapeSignature);
  assert.deepEqual(result.map((p) => p.id), [DEFAULT_PRESET_ID]);
});

test('reconcilePresets：缺少默认预设时用用户当前布局补齐（而不是出厂布局）', () => {
  const userLayout: LayoutNode = { ...builtinLayout, children: [{ id: 'u', type: 'pane', component: 'fileManager', size: 100 }] };
  const seed = preset(DEFAULT_PRESET_ID, DEFAULT_PRESET_NAME, userLayout);
  const result = reconcilePresets([preset('preset-custom', '自定义')], seed, builtinLayout, layoutShapeSignature);

  assert.equal(result[0].id, DEFAULT_PRESET_ID);
  assert.deepEqual(result[0].layoutTree, userLayout);
});

test('reconcilePresets：出厂种子 + 用户有自己的布局 → 接管（修复升级时被覆盖的布局）', () => {
  const userLayout: LayoutNode = { ...builtinLayout, children: [{ id: 'u', type: 'pane', component: 'fileManager', size: 100 }] };
  const storedDefault = preset(DEFAULT_PRESET_ID, DEFAULT_PRESET_NAME, builtinLayout, layoutShapeSignature);
  const result = reconcilePresets([storedDefault], preset(DEFAULT_PRESET_ID, DEFAULT_PRESET_NAME, userLayout), builtinLayout, layoutShapeSignature);

  assert.deepEqual(result[0].layoutTree, userLayout);
  assert.ok(typeof result[0].updatedAt === 'number');
});

test('reconcilePresets：用户自己恢复成出厂布局时不接管（尊重用户选择）', () => {
  const storedDefault = preset(DEFAULT_PRESET_ID, DEFAULT_PRESET_NAME, builtinLayout, layoutShapeSignature);
  const seed = preset(DEFAULT_PRESET_ID, DEFAULT_PRESET_NAME, builtinLayout, layoutShapeSignature);
  const result = reconcilePresets([storedDefault], seed, builtinLayout, layoutShapeSignature);

  // 结构相同 → 不产生新的 updatedAt
  assert.equal(result[0].updatedAt, undefined);
});

test('reconcilePresets：非默认预设原样保留，默认预设名称被清洗且标记系统预设', () => {
  const stored = [
    preset('preset-custom', '我的布局'),
    { ...preset(DEFAULT_PRESET_ID, '⭐ 默认布局'), isSystem: undefined },
  ];
  const result = reconcilePresets(stored, preset(DEFAULT_PRESET_ID, DEFAULT_PRESET_NAME), builtinLayout, layoutShapeSignature);

  assert.deepEqual(result.map((p) => p.id), ['preset-custom', DEFAULT_PRESET_ID]);
  assert.equal(result[1].name, DEFAULT_PRESET_NAME);
  assert.equal(result[1].isSystem, true);
});

test('reconcilePresets：入参不是数组时也能返回可用列表', () => {
  const result = reconcilePresets(undefined as unknown as LayoutPreset[], preset(DEFAULT_PRESET_ID, DEFAULT_PRESET_NAME), builtinLayout, layoutShapeSignature);
  assert.deepEqual(result.map((p) => p.id), [DEFAULT_PRESET_ID]);
});

// --- buildPresetsSignature：跨端同步"是否真的变了"的判据 ---

test('buildPresetsSignature：数组顺序与 isDefault 不影响签名', () => {
  const a = { ...preset('preset-a', 'A'), isDefault: true };
  const b = preset('preset-b', 'B');

  const s1 = buildPresetsSignature([a, b], DEFAULT_PRESET_ID, { uuid1: 'preset-a' });
  const s2 = buildPresetsSignature([b, a], DEFAULT_PRESET_ID, { uuid1: 'preset-a' });

  assert.equal(s1, s2, '顺序不同不应被判为"内容变了"，否则每次切默认预设都会重推一遍');
});

test('buildPresetsSignature：绑定表顺序无关，内容变化必须能检出', () => {
  const p = preset('preset-a', 'A');

  const s1 = buildPresetsSignature([p], 'preset-a', { u1: 'preset-a', u2: 'preset-a' });
  const s2 = buildPresetsSignature([p], 'preset-a', { u2: 'preset-a', u1: 'preset-a' });
  assert.equal(s1, s2);

  const s3 = buildPresetsSignature([p], 'preset-a', { u1: 'preset-a' });
  assert.notEqual(s1, s3, '绑定少了一条必须被检出，否则 LWW 会漏掉这次更新');
});
