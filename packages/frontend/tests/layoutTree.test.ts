import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applySizesAtPath,
  cloneLayoutTreeWithStableIds,
  cloneTree,
  ensureNodeIds,
  findNodePath,
  getTerminalPaneIdsInLayout,
  layoutShapeSignature,
  reconcileTreePreservingIds,
} from '../src/utils/layoutTree.ts';
import type { LayoutNode } from '../src/types/layout.ts';

/** 前端默认布局的简化版：左连接列表 | 右半区上下分屏（终端 + 文件管理器） */
function sampleTree(): LayoutNode {
  return {
    id: 'root',
    type: 'container',
    direction: 'horizontal',
    children: [
      { id: 'pane-connections', type: 'pane', component: 'connections', size: 20 },
      {
        id: 'right',
        type: 'container',
        direction: 'vertical',
        size: 80,
        children: [
          { id: 'terminal-a', type: 'pane', component: 'terminal', size: 60 },
          { id: 'pane-files', type: 'pane', component: 'fileManager', size: 40 },
        ],
      },
    ],
  };
}

test('cloneLayoutTreeWithStableIds：按结构序号发 ID，且多次调用结果一致', () => {
  const tree = sampleTree();
  const first = cloneLayoutTreeWithStableIds(tree);
  const second = cloneLayoutTreeWithStableIds(tree);

  assert.deepEqual(getTerminalPaneIdsInLayout(first), ['terminal-0']);
  assert.equal(first.children![0].id, 'pane-0');
  assert.equal(first.children![1].id, 'container-1');
  assert.equal(first.children![1].children![0].id, 'terminal-0');
  assert.equal(first.children![1].children![1].id, 'pane-1');
  // paneId 会作为后端 paneStreams 的 key，必须跨刷新稳定
  assert.deepEqual(first, second);
  // 原树不应被改动
  assert.equal(tree.children![0].id, 'pane-connections');
});

test('reconcileTreePreservingIds：结构不变时完整复用旧 ID', () => {
  const oldTree = cloneLayoutTreeWithStableIds(sampleTree());
  const newTree = cloneLayoutTreeWithStableIds(sampleTree());

  // 先把新树 ID 全部打乱，模拟"从预设克隆出来的全新 ID"
  for (const n of [newTree, ...(newTree.children || [])]) n.id = `fresh-${n.id}`;

  const merged = reconcileTreePreservingIds(oldTree, newTree);
  assert.equal(merged.id, oldTree.id);
  assert.equal(merged.children![0].id, oldTree.children![0].id);
  assert.equal(merged.children![1].id, oldTree.children![1].id);
  assert.equal(merged.children![1].children![0].id, oldTree.children![1].children![0].id);
});

test('reconcileTreePreservingIds：删除中间节点后，剩余节点仍按组件匹配到旧 ID', () => {
  const oldTree = cloneLayoutTreeWithStableIds(sampleTree());

  const newTree: LayoutNode = {
    id: 'root-new',
    type: 'container',
    direction: 'horizontal',
    children: [
      { id: 'c-new', type: 'pane', component: 'connections', size: 20 },
      { id: 'f-new', type: 'pane', component: 'fileManager', size: 80 },
    ],
  };

  const merged = reconcileTreePreservingIds(oldTree, newTree);
  // 连接列表在最外层，位置和组件都没变 → 复用旧 ID
  assert.equal(merged.children![0].id, 'pane-0');
  // 文件管理器原本嵌在右侧容器里，被提升到根级属于真实的结构变化，
  // 这一层没有可复用的旧兄弟节点，保留新树自己的 ID（不能瞎匹配到别的面板）
  assert.equal(merged.children![1].id, 'f-new');
});

test('reconcileTreePreservingIds：分割方向变化视为新容器，不复用旧 ID', () => {
  const oldTree = cloneLayoutTreeWithStableIds(sampleTree());
  const newTree = cloneLayoutTreeWithStableIds(sampleTree());
  // 模拟从预设克隆出来的全新 ID
  newTree.children![1].id = 'fresh-right';
  newTree.children![1].direction = 'horizontal';

  const merged = reconcileTreePreservingIds(oldTree, newTree);
  assert.equal(merged.children![1].id, 'fresh-right');
  // 叶子节点仍可复用
  assert.equal(merged.children![1].children![0].id, oldTree.children![1].children![0].id);
});

test('findNodePath / applySizesAtPath：只改命中的那一层且不修改原树', () => {
  const tree = sampleTree();
  const path = findNodePath(tree, 'right');
  assert.deepEqual(path, [1]);

  assert.deepEqual(findNodePath(tree, 'root'), []);
  assert.equal(findNodePath(tree, 'nope'), null);
  assert.equal(findNodePath(null, 'root'), null);

  const updated = applySizesAtPath(tree, path!, [{ index: 0, size: 30 }, { index: 1, size: 70 }])!;
  assert.equal(updated.children![1].children![0].size, 30);
  assert.equal(updated.children![1].children![1].size, 70);
  // 根节点尺寸未受影响
  assert.equal(updated.children![0].size, 20);
  // 原树保持不变
  assert.equal(tree.children![1].children![0].size, 60);
});

test('applySizesAtPath：路径不存在时原样返回', () => {
  const tree = sampleTree();
  const same = applySizesAtPath(tree, [9, 9], [{ index: 0, size: 50 }]);
  assert.equal(same, tree);
  assert.equal(applySizesAtPath(null, [], []), null);
});

test('layoutShapeSignature：忽略节点 ID，但能察觉结构与尺寸变化', () => {
  const a = sampleTree();
  const b = cloneLayoutTreeWithStableIds(a);
  assert.equal(layoutShapeSignature(a), layoutShapeSignature(b));

  const resized = cloneTree(a);
  resized.children![0].size = 22;
  assert.notEqual(layoutShapeSignature(a), layoutShapeSignature(resized));

  const restructured = cloneTree(a);
  delete restructured.children![1];
  assert.notEqual(layoutShapeSignature(a), layoutShapeSignature(restructured));

  assert.equal(layoutShapeSignature(null), '');
});

test('ensureNodeIds：补齐缺失 ID 并保留已有 ID', () => {
  const tree: LayoutNode = {
    id: '',
    type: 'container',
    direction: 'horizontal',
    children: [
      { id: 'keep-me', type: 'pane', component: 'terminal' },
      { id: '', type: 'pane', component: 'fileManager' },
    ],
  };

  let seq = 0;
  const filled = ensureNodeIds(tree, () => `gen-${seq++}`)!;

  assert.equal(filled.id, 'gen-0');
  assert.equal(filled.children![0].id, 'keep-me');
  assert.equal(filled.children![1].id, 'gen-1');
  assert.equal(ensureNodeIds(null), null);
});

test('getTerminalPaneIdsInLayout：只收集终端面板，按先序返回', () => {
  const tree: LayoutNode = {
    id: 'root',
    type: 'container',
    direction: 'vertical',
    children: [
      { id: 't1', type: 'pane', component: 'terminal' },
      {
        id: 'inner',
        type: 'container',
        direction: 'horizontal',
        children: [
          { id: 'files', type: 'pane', component: 'fileManager' },
          { id: 't2', type: 'pane', component: 'terminal' },
        ],
      },
    ],
  };

  assert.deepEqual(getTerminalPaneIdsInLayout(tree), ['t1', 't2']);
  assert.deepEqual(getTerminalPaneIdsInLayout(null), []);
});
