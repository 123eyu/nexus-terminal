import { shallowReactive } from 'vue';
import type { LayoutNode, LayoutPreset } from '../../types/layout';
import { cloneLayoutTreeWithStableIds, getTerminalPaneIdsInLayout, reconcileTreePreservingIds } from '../../utils/layoutTree';

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

  return {
    sessionLayoutTreeMap,
    recordSessionPaneOrder,
    getSessionTerminalPaneOrder,
    getLayoutTreeForSession,
    clearSessionLayoutTree,
    refreshSessionLayoutTree,
  };
}
