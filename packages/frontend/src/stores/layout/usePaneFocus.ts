import { ref, computed, watch, shallowRef, type Ref } from 'vue';
import { sessions as sessionStateMap, activeSessionId as activeSessionIdRef } from '../session/state';
import type { LayoutNode } from '../../types/layout';
import { getTerminalPaneIdsInLayout } from '../../utils/layoutTree';

/**
 * 终端多窗格聚焦管理（从 layout.store 拆出）。
 *
 * 为什么单独一个文件：
 * - 这块是"最容易静默出错"的状态机（paneId 错了不会报错，后端直接丢弃输入），
 *   和布局树/预设的 CRUD 混在一个 1491 行文件里很难看清依赖。
 * - 它只依赖 layoutTree 一个外部状态，其余（会话状态、活动会话）都是全局单例。
 *
 * 关键不变量：
 * - `activeTerminalPaneId` 必须是「当前实际渲染那棵树」里的 paneId。
 *   桌面端用会话树（activeLayoutTreeOverride），不是主 layoutTree —— 两套 paneId 不通用。
 * - 写 `focusedTerminalPaneId` 要用 `activeSessionId`（同步），不能用
 *   `activeLayoutSessionId`（由 DesktopWorkspaceView 的 watch 异步写，切会话瞬间会写错会话）。
 */
export function usePaneFocus(layoutTree: Ref<LayoutNode | null>) {
  const activeTerminalPaneId = ref<string | null>(null);

  /**
   * 当前"实际渲染"的布局树覆盖值。
   *
   * 桌面端每个会话都有独立的会话树（pane ID 与主布局树不同），
   * 如果聚焦校正仍然盯着 layoutTree，就会出现：
   * 切到新会话后 activeTerminalPaneId 还停留在上一个会话的 paneId，
   * 命令输入框把数据发到不存在的分屏通道 → 后端直接丢弃 → "发不出去"。
   */
  const activeLayoutTreeOverride = shallowRef<LayoutNode | null>(null);
  /** override 对应的会话（用于把"拖动分屏/改尺寸"写回正确的会话树） */
  const activeLayoutSessionId = ref<string | null>(null);
  /** override 对应的连接（用于把尺寸写回该会话使用的预设，否则刷新会回到旧尺寸） */
  const activeLayoutConnectionId = ref<number | string | null>(null);

  const currentTerminalPaneIds = computed(() => {
    return getTerminalPaneIdsInLayout(activeLayoutTreeOverride.value ?? layoutTree.value);
  });

  // 监听布局树终端节点变化，若当前聚焦 ID 不存在则重置
  watch(
    currentTerminalPaneIds,
    (paneIds) => {
      if (paneIds.length === 0) {
        activeTerminalPaneId.value = null;
      } else if (!activeTerminalPaneId.value || !paneIds.includes(activeTerminalPaneId.value)) {
        activeTerminalPaneId.value = paneIds[0];
      }
    },
    { immediate: true }
  );

  /**
   * 把"当前可见的会话布局树"设为聚焦校正的依据。
   * 传 null 表示回退到主布局树（无活动会话时）。
   */
  function syncActiveTerminalPaneFromTree(
    tree: LayoutNode | null,
    sessionId: string | null = null,
    connectionId: number | string | null = null
  ) {
    activeLayoutTreeOverride.value = tree;
    activeLayoutSessionId.value = sessionId;
    activeLayoutConnectionId.value = connectionId;
    const ids = getTerminalPaneIdsInLayout(tree ?? layoutTree.value);

    // 优先恢复"这个会话上次聚焦的终端"（多终端分屏场景），而不是默认第一个
    const preferred = sessionId
      ? sessionStateMap.value.get(sessionId)?.focusedTerminalPaneId
      : undefined;

    if (ids.length === 0) {
      activeTerminalPaneId.value = null;
    } else if (preferred && ids.includes(preferred)) {
      activeTerminalPaneId.value = preferred;
    } else if (!activeTerminalPaneId.value || !ids.includes(activeTerminalPaneId.value)) {
      activeTerminalPaneId.value = ids[0];
    }
    return activeTerminalPaneId.value;
  }

  /** 当前实际渲染的布局树（桌面端为活动会话的专属树） */
  function getActiveLayoutTree(): LayoutNode | null {
    return activeLayoutTreeOverride.value ?? layoutTree.value;
  }

  function setActiveTerminalPaneId(paneId: string | null) {
    activeTerminalPaneId.value = paneId;
    // 记住"这个会话聚焦的是哪个终端"：切回会话 / 云端恢复时直接聚焦到它。
    // 用 activeSessionId 而不是 activeLayoutSessionId —— 后者由 DesktopWorkspaceView 的
    // watch 异步写入，切会话瞬间点终端可能还没更新到新会话。
    const sessionId = activeSessionIdRef.value || activeLayoutSessionId.value;
    if (sessionId && paneId) {
      const session = sessionStateMap.value.get(sessionId);
      if (session && session.focusedTerminalPaneId !== paneId) {
        session.focusedTerminalPaneId = paneId;
      }
    }
  }

  // 循环切换终端焦点 (默认 Alt+` 触发)
  function cycleTerminalFocus(direction: 'next' | 'prev' = 'next'): string | null {
    const ids = currentTerminalPaneIds.value;
    if (ids.length === 0) return null;
    if (ids.length === 1) {
      activeTerminalPaneId.value = ids[0];
      return ids[0];
    }
    const currentIndex = activeTerminalPaneId.value ? ids.indexOf(activeTerminalPaneId.value) : -1;
    let nextIndex = 0;
    if (currentIndex === -1) {
      nextIndex = 0;
    } else if (direction === 'next') {
      nextIndex = (currentIndex + 1) % ids.length;
    } else {
      nextIndex = (currentIndex - 1 + ids.length) % ids.length;
    }
    const targetId = ids[nextIndex];
    activeTerminalPaneId.value = targetId;
    return targetId;
  }

  return {
    activeTerminalPaneId,
    activeLayoutTreeOverride,
    activeLayoutSessionId,
    activeLayoutConnectionId,
    currentTerminalPaneIds,
    syncActiveTerminalPaneFromTree,
    getActiveLayoutTree,
    setActiveTerminalPaneId,
    cycleTerminalFocus,
  };
}
