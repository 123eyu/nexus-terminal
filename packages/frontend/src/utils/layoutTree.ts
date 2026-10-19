import type { LayoutNode } from '../types/layout';

/**
 * 布局树的纯函数集合。
 *
 * 这些函数以前散在 layout.store.ts 里（有的在 defineStore 闭包内），
 * 导致：① 没法单独测试；② 每次改布局逻辑都要在一个 1700 行的文件里翻找。
 * 它们只依赖传入的树，不碰 Pinia / Vue 响应式 / 网络，因此可以放心下沉到这里。
 *
 * 约束：本文件除 `import type` 外不得引入任何运行时依赖 —— 单测用
 * `node --experimental-strip-types --test` 直接跑它，类型导入会被擦除。
 */

/** 生成唯一 ID（旧的 13 位 base36 随机串，行为保持不变） */
export function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/** 深拷贝（切断与主布局树的引用，避免编辑预设时污染当前工作区） */
export function cloneTree<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 布局结构签名：忽略节点 ID，只比较 类型/组件/方向/尺寸/层级。
 * 用来判断某个预设的布局是否仍是"未编辑过的出厂默认"。
 */
export function layoutShapeSignature(node: LayoutNode | null | undefined): string {
  if (!node) return '';
  const strip = (n: LayoutNode): unknown => {
    const out: Record<string, unknown> = { t: n.type };
    if (n.component) out.c = n.component;
    if (n.direction) out.d = n.direction;
    if (typeof n.size === 'number') out.s = Math.round(n.size * 1000) / 1000;
    if (n.children) out.k = n.children.map(strip);
    return out;
  };
  try {
    return JSON.stringify(strip(node));
  } catch {
    return '';
  }
}

/** 递归补齐缺失的节点 ID（原地修改并返回同一棵树） */
export function ensureNodeIds(
  node: LayoutNode | null,
  makeId: () => string = randomId
): LayoutNode | null {
  if (!node) return null;

  if (!node.id) {
    node.id = makeId();
  }

  if (node.type === 'container' && node.children) {
    node.children = node.children
      .map((child) => ensureNodeIds(child, makeId))
      .filter(Boolean) as LayoutNode[];
  }

  return node;
}

/** 找出节点在树里的索引路径（跨"主树 / 会话树 / 预设树"定位同一结构位置） */
export function findNodePath(
  node: LayoutNode | null,
  id: string,
  path: number[] = []
): number[] | null {
  if (!node) return null;
  if (node.id === id) return path;
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      const found = findNodePath(node.children[i], id, [...path, i]);
      if (found) return found;
    }
  }
  return null;
}

/** 按索引路径把子节点尺寸写到目标树（结构与来源树一致时才生效） */
export function applySizesAtPath(
  node: LayoutNode | null,
  path: number[],
  sizes: { index: number; size: number }[]
): LayoutNode | null {
  if (!node) return null;
  if (path.length === 0) {
    if (node.type !== 'container' || !node.children) return node;
    const children = node.children.map((child, index) => {
      const hit = sizes.find((s) => s.index === index);
      return hit ? { ...child, size: hit.size } : child;
    });
    return { ...node, children };
  }
  const [head, ...rest] = path;
  if (!node.children || !node.children[head]) return node;
  const children = [...node.children];
  const updated = applySizesAtPath(children[head], rest, sizes);
  if (!updated) return node;
  children[head] = updated;
  return { ...node, children };
}

/**
 * 克隆并赋"结构序号"ID：第 0 个终端叫 terminal-0、第 1 个叫 terminal-1……
 *
 * 重要：paneId 会被发给后端当作 `paneStreams` 的 key。以前用随机 ID，
 * 每次刷新都换一套 key，后端找不到旧通道 → 重新开 shell → 每个副终端
 * 都重新打印一遍登录 banner。改成序号后，刷新时能命中同一个通道并复用。
 */
export function cloneLayoutTreeWithStableIds(node: LayoutNode): LayoutNode {
  const counter = { pane: 0, terminal: 0, container: 0 };
  const walk = (n: LayoutNode): LayoutNode => {
    let id: string;
    if (n.type === 'pane') {
      id = n.component === 'terminal' ? `terminal-${counter.terminal++}` : `pane-${counter.pane++}`;
    } else {
      id = `container-${counter.container++}`;
    }
    const out: LayoutNode = { ...n, id };
    if (n.children && Array.isArray(n.children)) {
      out.children = n.children.map(walk);
    }
    return out;
  };
  return walk(node);
}

/**
 * 按"结构位置 + 同类型组件"把旧树里的 pane/container ID 迁移到新树上。
 *
 * 目的：布局管理器保存后需要把新结构应用到已打开的会话，
 * 但如果无脑用 cloneLayoutTreeWithNewIds，所有 paneId 都会变，
 * 已挂载的 xterm 会被重建（断连、丢滚动历史）。
 * 这里尽量复用旧 ID，只有真正被删除/新增的节点才换新 ID。
 */
export function reconcileTreePreservingIds(
  oldNode: LayoutNode | null,
  newNode: LayoutNode
): LayoutNode {
  const sameKind = !!oldNode
    && oldNode.type === newNode.type
    && oldNode.component === newNode.component
    && (newNode.type !== 'container' || oldNode.direction === newNode.direction);

  const out: LayoutNode = { ...newNode };
  if (sameKind && oldNode) out.id = oldNode.id;

  if (newNode.children) {
    const oldChildren = sameKind && oldNode?.children ? oldNode.children : [];
    const used = new Set<number>();
    out.children = newNode.children.map((child, index) => {
      // 先按位置匹配，再按同类组件在旧兄弟中查找（应对"删除中间某个容器"导致的错位）
      let candidate: LayoutNode | null = oldChildren[index] ?? null;
      if (!candidate || candidate.type !== child.type || candidate.component !== child.component) {
        candidate = oldChildren.find((c, i) =>
          !used.has(i) && c.type === child.type && c.component === child.component) ?? null;
      }
      if (candidate) {
        const ci = oldChildren.indexOf(candidate);
        if (ci >= 0) used.add(ci);
      }
      return reconcileTreePreservingIds(candidate, child);
    });
  }
  return out;
}

/** 递归收集树里所有终端面板的 ID（按先序） */
export function getTerminalPaneIdsInLayout(node: LayoutNode | null): string[] {
  const ids: string[] = [];
  if (!node) return ids;
  const traverse = (currentNode: LayoutNode) => {
    if (currentNode.type === 'pane' && currentNode.component === 'terminal' && currentNode.id) {
      ids.push(currentNode.id);
    }
    if (currentNode.type === 'container' && currentNode.children) {
      currentNode.children.forEach(traverse);
    }
  };
  traverse(node);
  return ids;
}
