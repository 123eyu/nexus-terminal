import { shallowReactive } from 'vue';
import type { LayoutNode, LayoutPreset } from '../../types/layout';
import {
  applySizesAtPath,
  cloneLayoutTreeWithStableIds,
  findNodePath,
  getTerminalPaneIdsInLayout,
  reconcileTreePreservingIds,
} from '../../utils/layoutTree';

/**
 * 会话专属布局树（从 layout.store 拆出）。
 *
 * 背景：桌面端每个会话都有一棵独立的布局树，paneId 与主布局树不通用。
 * 这层缓存必须满足三个不变量，以前混在 1400 行文件里很难保证：
 *
 * 1. `sessionLayoutTreeMap` 必须是 shallowReactive(Map)，裸 Map 改动不会触发渲染
 *    （表现为"保存布局没反应"）。
 * 2. paneId 只用作运行时标识，**不能当持久化 key**。云端快照按"先序序号"
 *    （pane#0 / pane#1）存终端内容，否则刷新后 key 全变，终端内容对不上。
 * 3. 刷新布局要 reconcile 复用旧 ID，否则已挂载的 xterm 会被整体重建
 *    （断连 + 丢滚动历史 + 副终端重新登录）。
 */
export function useSessionLayoutTrees(deps: {
  /** 取某连接该用的预设（预设层的职责，用注入避免循环依赖） */
  getPresetForConnection: (connectionId?: number | string | null) => LayoutPreset;
}) {
  // sessionId -> 会话自己的布局树
  const sessionLayoutTreeMap = shallowReactive(new Map<string, LayoutNode>());

  /**
   * 每个会话树里终端 pane 的先序 ID 顺序（跨刷新稳定的逻辑键）。
   */
  const sessionPaneOrderMap = new Map<string, string[]>();

  /**
   * sessionId -> 该会话的连接 ID。
   *
   * 只为了「改尺寸时找出同样用这个预设的其他会话」——会话树之间唯一的关系就是共享预设，
   * 而预设是按连接解析的。由 `getLayoutTreeForSession`（桌面端为每个会话取树时）顺手记下，
   * 免得这里反向 import session store 引成环。
   */
  const sessionConnectionMap = new Map<string, number | string | null>();

  function recordSessionPaneOrder(sessionId: string, tree: LayoutNode) {
    sessionPaneOrderMap.set(sessionId, getTerminalPaneIdsInLayout(tree));
  }

  /** 取某会话终端 pane 的先序顺序（跨刷新稳定） */
  function getSessionTerminalPaneOrder(sessionId: string): string[] {
    return sessionPaneOrderMap.get(sessionId) ?? [];
  }

  function getLayoutTreeForSession(
    sessionId?: string | null,
    connectionId?: number | string | null
  ): LayoutNode {
    if (!sessionId) {
      return deps.getPresetForConnection(connectionId).layoutTree;
    }
    sessionConnectionMap.set(sessionId, connectionId ?? null);
    if (sessionLayoutTreeMap.has(sessionId)) {
      return sessionLayoutTreeMap.get(sessionId)!;
    }
    const preset = deps.getPresetForConnection(connectionId);
    const dedicatedTree = cloneLayoutTreeWithStableIds(preset.layoutTree);
    sessionLayoutTreeMap.set(sessionId, dedicatedTree);
    recordSessionPaneOrder(sessionId, dedicatedTree);
    return dedicatedTree;
  }

  // 会话关闭时释放专属布局树
  function clearSessionLayoutTree(sessionId: string) {
    sessionLayoutTreeMap.delete(sessionId);
    sessionPaneOrderMap.delete(sessionId);
    sessionConnectionMap.delete(sessionId);
  }

  // 刷新某会话的布局树（当配置更新时触发）
  // 保留可复用节点的旧 ID，避免已挂载终端被无谓销毁重建
  function refreshSessionLayoutTree(sessionId: string, connectionId?: number | string | null) {
    const preset = deps.getPresetForConnection(connectionId);
    const oldTree = sessionLayoutTreeMap.get(sessionId);
    const dedicatedTree = oldTree
      ? reconcileTreePreservingIds(oldTree, preset.layoutTree)
      : cloneLayoutTreeWithStableIds(preset.layoutTree);
    sessionLayoutTreeMap.set(sessionId, dedicatedTree);
    recordSessionPaneOrder(sessionId, dedicatedTree);
    return dedicatedTree;
  }

  /**
   * 把「拖动分割条」改出来的尺寸同步给**共用同一个预设的其他会话树**。
   *
   * 会话树是各自克隆、各自缓存的：只改当前这棵，切到同一布局的另一个会话仍然显示旧尺寸
   * （预设虽然已经写回，但那个会话的树早就克隆好了，不会自己 reconcile）——
   * 表现就是「A 里拉好尺寸，切到 B 还是原样，只有刷新网页才生效」。
   *
   * 只同步「同预设」的会话：不同预设哪怕结构一样，也是两套独立配置。
   * 路径按 paneId 在原树里重新定位，找不到就跳过（结构被单独改过的会话不动）。
   */
  function syncSizesToSessionsSharingPreset(opts: {
    /** 已经就地更新过的那棵树，跳过 */
    exceptSessionId: string | null;
    /** 这些会话必须共用这个预设才跟着改 */
    presetId: string;
    /** 改动的容器节点（会话树里的 paneId/containerId） */
    nodeId: string;
    sizes: { index: number; size: number }[];
  }): number {
    let changed = 0;
    for (const [sessionId, tree] of Array.from(sessionLayoutTreeMap.entries())) {
      if (sessionId === opts.exceptSessionId) continue;
      const preset = deps.getPresetForConnection(sessionConnectionMap.get(sessionId) ?? null);
      if (!preset || preset.id !== opts.presetId) continue;
      const path = findNodePath(tree, opts.nodeId);
      if (!path) continue;
      const next = applySizesAtPath(tree, path, opts.sizes);
      if (!next || JSON.stringify(next) === JSON.stringify(tree)) continue;
      sessionLayoutTreeMap.set(sessionId, next);
      changed += 1;
    }
    return changed;
  }

  return {
    sessionLayoutTreeMap,
    recordSessionPaneOrder,
    getSessionTerminalPaneOrder,
    getLayoutTreeForSession,
    clearSessionLayoutTree,
    refreshSessionLayoutTree,
    syncSizesToSessionsSharingPreset,
  };
}
