import { defineStore } from 'pinia';
import { ref, computed, type Ref, type ComputedRef } from 'vue';
import apiClient from '../utils/apiClient';
import { useComponentStateStore } from './componentState.store';

import type {
  LayoutNode,
  LayoutPreset,
  PaneName,
  TerminalAutoExecConfig,
  TerminalPaneBackgroundConfig,
} from '../types/layout';
import {
  applySizesAtPath,
  ensureNodeIds,
  findNodePath,
  layoutShapeSignature,
  randomId,
} from '../utils/layoutTree';
import { usePaneFocus } from './layout/usePaneFocus';
import { useSessionLayoutTrees } from './layout/useSessionLayoutTrees';
import { useLayoutPresets } from './layout/useLayoutPresets';
import {
  DEFAULT_PRESET_ID,
  DEFAULT_PRESET_NAME,
  buildDefaultPresetFrom as buildDefaultPresetFromBase,
  reconcilePresets as reconcilePresetsBase,
} from '../utils/layoutPreset';

export { LEGACY_TEMPLATE_IDS } from '../utils/layoutPreset';

// 布局领域类型集中在 types/layout.ts 定义；这里重新导出，既有 import 路径保持不变。
export type {
  LayoutNode,
  LayoutPreset,
  PaneName,
  TerminalAutoExecConfig,
  TerminalPaneBackgroundConfig,
} from '../types/layout';
export { getTerminalPaneIdsInLayout } from '../utils/layoutTree';

// 本地存储的 Key
const LAYOUT_STORAGE_KEY = 'nexus_terminal_layout_config';
const SIDEBAR_STORAGE_KEY = 'nexus_terminal_sidebar_config';
 // 新增侧栏配置 Key

// 纯函数模块里的随机 ID 生成器（保持旧的 13 位 base36 行为）
const generateId = randomId;

// 定义默认布局结构 (根据用户提供的配置更新，但使用 generateId)
const getDefaultLayout = (): LayoutNode => ({
  id: generateId(), // Generate new ID
  type: "container",
  direction: "horizontal",
  children: [
    {
      id: generateId(), // Generate new ID
      type: "container",
      direction: "vertical",
      children: [
        {
          id: generateId(), // Generate new ID
          type: "pane",
          component: "statusMonitor",
          size: 44.56372126372345 // 使用用户提供的 size
        },
        {
          id: generateId(), // Generate new ID
          type: "pane",
          component: "commandHistory",
          size: 26.235651482670775 // 使用用户提供的 size
        },
        {
          id: generateId(), // Generate new ID
          type: "pane",
          component: "quickCommands",
          size: 29.200627253605774 // 使用用户提供的 size
        }
      ],
      size: 14.59006012147659 // 使用用户提供的 size
    },
    {
      id: generateId(), // Generate new ID
      type: "container",
      direction: "vertical",
      size: 58.02787988626151, // 使用用户提供的 size
      children: [
        {
          id: generateId(), // Generate new ID
          type: "pane",
          component: "terminal",
          size: 59.94833664833884 // 使用用户提供的 size
        },
        {
          id: generateId(), // Generate new ID
          type: "pane",
          component: "commandBar",
          size: 5 // 使用用户提供的 size
        },
        {
          id: generateId(), // Generate new ID
          type: "pane",
          component: "fileManager",
          size: 35.05166335166116 // 使用用户提供的 size
        }
      ]
    },
    {
      id: generateId(), // Generate new ID
      type: "container",
      direction: "vertical",
      size: 27.3820599922619, // 使用用户提供的 size
      children: [
        {
          id: generateId(), // Generate new ID
          type: "pane",
          component: "editor",
          size: 100 // 使用用户提供的 size
        }
      ]
    }
  ]
});

// 定义默认侧栏配置 (根据用户提供的配置更新)
const getDefaultSidebarPanes = (): { left: PaneName[], right: PaneName[] } => ({
  "left": [
    "connections",
    "dockerManager"
  ],
  "right": []
});


// 预设相关的纯逻辑（命名清洗、默认预设构造、与出厂预置对齐）下沉到 utils/layoutPreset.ts

/** 用"当前工作区布局"作为兜底构造默认预设（store 内版本，自动带上出厂布局） */
function buildDefaultPresetFrom(
  tree: LayoutNode | null | undefined,
  sidebars: { left: PaneName[]; right: PaneName[] } | null | undefined
): LayoutPreset {
  return buildDefaultPresetFromBase(tree, sidebars, {
    tree: getDefaultLayout(),
    sidebars: getDefaultSidebarPanes(),
  });
}

/** store 内版本：用出厂布局判断"预设是否还是未编辑过的种子" */
function reconcilePresets(stored: LayoutPreset[], seedPreset: LayoutPreset): LayoutPreset[] {
  return reconcilePresetsBase(stored, seedPreset, getDefaultLayout(), layoutShapeSignature);
}

// 获取系统基础初始预设列表（出厂内置默认，仅作为最后兜底，不硬编码任何内置模板）
export const getSystemDefaultPresets = (): LayoutPreset[] => [
  {
    id: DEFAULT_PRESET_ID,
    name: DEFAULT_PRESET_NAME,
    isDefault: true,
    isSystem: true,
    layoutTree: getDefaultLayout(),
    sidebarPanes: getDefaultSidebarPanes(),
    connectionIds: [],
  }
];

// 递归查找主布局树中使用的面板
function getMainLayoutUsedPaneNames(node: LayoutNode | null): Set<PaneName> {
  const usedNames = new Set<PaneName>();
  if (!node) return usedNames;

  function traverse(currentNode: LayoutNode) {
    if (currentNode.type === 'pane' && currentNode.component) {
      usedNames.add(currentNode.component);
    } else if (currentNode.type === 'container' && currentNode.children) {
      currentNode.children.forEach(traverse);
    }
  }

  traverse(node);
  return usedNames;
}

// 获取所有使用的面板（主布局 + 侧栏）
function getAllUsedPaneNames(mainNode: LayoutNode | null, sidebars: { left: PaneName[], right: PaneName[] }): Set<PaneName> {
  const usedNames = getMainLayoutUsedPaneNames(mainNode);
  sidebars.left.forEach(pane => usedNames.add(pane));
  sidebars.right.forEach(pane => usedNames.add(pane));
  return usedNames;
}

// 收集布局树中所有激活的实例 ID (Pane ID)
export function getAllActivePaneIds(node: LayoutNode | null): Set<string> {
  const ids = new Set<string>();
  if (!node) return ids;

  function traverse(currentNode: LayoutNode) {
    if (currentNode.id) {
      ids.add(currentNode.id);
    }
    if (currentNode.type === 'container' && currentNode.children) {
      currentNode.children.forEach(traverse);
    }
  }

  traverse(node);
  return ids;
}

// 收集主布局中所有终端节点的 paneId 列表（按视觉先序深度优先遍历：从左到右、从上到下，顺序严格确定）
// --- Validation Helper ---
// Checks if a value is a valid PaneName
function isValidPaneName(value: any, allPanes: PaneName[]): value is PaneName {
    return typeof value === 'string' && allPanes.includes(value as PaneName);
}

// Checks if an array contains only unique, valid PaneName strings
function isValidPaneNameArray(arr: any, allPanes: PaneName[]): arr is PaneName[] {
    if (!Array.isArray(arr)) return false;
    const seen = new Set<PaneName>();
    for (const item of arr) {
        if (!isValidPaneName(item, allPanes) || seen.has(item)) {
            return false; // Not a valid PaneName or duplicate found
        }
        seen.add(item);
    }
    return true; // All items are unique and valid PaneNames
}


const ALL_POSSIBLE_PANES: PaneName[] = [
  'connections', 'terminal', 'commandBar', 'fileManager',
  'editor', 'statusMonitor', 'commandHistory', 'quickCommands',
  'dockerManager', 'suspendedSshSessions', 'multiLineCommandInput', 'portForward'
];

// 同步获取初始布局结构（优先从 localStorage 读取，杜绝打开工作区时全屏显示加载中占位）
function getInitialLayout(): LayoutNode {
  if (typeof localStorage !== 'undefined') {
    try {
      const savedLayout = localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (savedLayout) {
        const parsed = JSON.parse(savedLayout) as LayoutNode;
        const processed = ensureNodeIds(parsed);
        if (processed) return processed;
      }
    } catch (e) {
      // ignore
    }
  }
  return ensureNodeIds(getDefaultLayout()) || getDefaultLayout();
}

// 同步获取初始侧栏配置
function getInitialSidebarPanes(): { left: PaneName[], right: PaneName[] } {
  if (typeof localStorage !== 'undefined') {
    try {
      const savedSidebars = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (savedSidebars) {
        const parsed = JSON.parse(savedSidebars) as { left: any[], right: any[] };
        if (parsed && isValidPaneNameArray(parsed.left, ALL_POSSIBLE_PANES) && isValidPaneNameArray(parsed.right, ALL_POSSIBLE_PANES)) {
          return parsed as { left: PaneName[], right: PaneName[] };
        }
      }
    } catch (e) {
      // ignore
    }
  }
  return getDefaultSidebarPanes();
}

// 定义 Store
export const useLayoutStore = defineStore('layout', () => {
  // --- 状态 ---
  // 主布局树结构（优先从本地存储秒开恢复，绝不初始化为 null）
  const layoutTree: Ref<LayoutNode | null> = ref(getInitialLayout());
  // 侧栏面板配置（优先从本地存储恢复）
  const sidebarPanes: Ref<{ left: PaneName[], right: PaneName[] }> = ref(getInitialSidebarPanes());
  // 所有理论上可用的面板名称
  const allPossiblePanes: Ref<PaneName[]> = ref([...ALL_POSSIBLE_PANES]);
  // 控制布局（Header/Footer）可见性的状态
  const isLayoutVisible: Ref<boolean> = ref(true); // 控制整体布局（Header/Footer）可见性

  // --- 分端独立存储：桌面端与移动端主导航栏（Header）可见性 ---
  const LS_HEADER_VISIBLE_DESKTOP = 'nexus_nav_bar_visible_desktop';
  const LS_HEADER_VISIBLE_MOBILE = 'nexus_nav_bar_visible_mobile';

  function isMobilePlatform(): boolean {
    if (typeof window === 'undefined') return false;
    const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    return isMobileUA || window.innerWidth < 768;
  }

  const desktopHeaderVisible = ref<boolean>(
    typeof localStorage !== 'undefined' && localStorage.getItem(LS_HEADER_VISIBLE_DESKTOP) !== null
      ? localStorage.getItem(LS_HEADER_VISIBLE_DESKTOP) === 'true'
      : true
  );

  const mobileHeaderVisible = ref<boolean>(
    typeof localStorage !== 'undefined' && localStorage.getItem(LS_HEADER_VISIBLE_MOBILE) !== null
      ? localStorage.getItem(LS_HEADER_VISIBLE_MOBILE) === 'true'
      : false // 移动端默认隐藏，最大化利用小屏终端空间
  );

  // 控制主导航栏（Header）可见性的状态（自动对应当前端并保持外部响应式兼容）
  const isHeaderVisible: Ref<boolean> = ref(
    isMobilePlatform() ? mobileHeaderVisible.value : desktopHeaderVisible.value
  );

  function syncCurrentHeaderVisibility() {
    isHeaderVisible.value = isMobilePlatform() ? mobileHeaderVisible.value : desktopHeaderVisible.value;
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', syncCurrentHeaderVisibility);
  }

  // --- 计算属性 ---
  // 计算当前布局和侧栏中正在使用的所有面板
  const usedPanes: ComputedRef<Set<PaneName>> = computed(() => getAllUsedPaneNames(layoutTree.value, sidebarPanes.value));

  // --- 终端多窗格聚焦（拆到 stores/layout/usePaneFocus.ts）---
  // 必须在这里就调用：updateNodeSizes 等动作会用到 activeLayoutTreeOverride。
  const {
    activeTerminalPaneId,
    activeLayoutTreeOverride,
    activeLayoutSessionId,
    activeLayoutConnectionId,
    currentTerminalPaneIds,
    syncActiveTerminalPaneFromTree,
    getActiveLayoutTree,
    setActiveTerminalPaneId,
    cycleTerminalFocus,
  } = usePaneFocus(layoutTree);

  // 计算当前未在布局或侧栏中使用的面板（可用于配置器中添加）
  const availablePanes: ComputedRef<PaneName[]> = computed(() => {
    const used = usedPanes.value;
    // terminal 作为核心多实例分屏组件，始终保留在可用面板列表中，支持多次拉取
    return allPossiblePanes.value.filter(pane => pane === 'terminal' || !used.has(pane));
  });

  // --- Actions ---
  // 初始化布局和侧栏配置 (SWR 架构：后台非阻塞并发校验对齐，不阻断前台 UI 渲染)
  async function initializeLayout() {
    console.log('[Layout Store] Starting initializeLayout in background...');

    try {
      const [layoutRes, sidebarRes] = await Promise.all([
        apiClient.get<LayoutNode | null>('/settings/layout').catch(err => {
          console.warn('[Layout Store] Failed to fetch layout from backend:', err);
          return { data: null };
        }),
        apiClient.get<{ left: any[], right: any[] } | null>('/settings/sidebar').catch(err => {
          console.warn('[Layout Store] Failed to fetch sidebar from backend:', err);
          return { data: null };
        }),
      ]);

      if (layoutRes.data) {
        const processed = ensureNodeIds(layoutRes.data);
        if (processed) {
          layoutTree.value = processed;
          try {
            localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(processed));
          } catch (lsError) {
            console.error('[Layout Store] Failed to save processed layout to localStorage:', lsError);
          }
        }
      }

      if (sidebarRes.data &&
          isValidPaneNameArray(sidebarRes.data.left, allPossiblePanes.value) &&
          isValidPaneNameArray(sidebarRes.data.right, allPossiblePanes.value)) {
        sidebarPanes.value = sidebarRes.data as { left: PaneName[], right: PaneName[] };
        try {
          localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(sidebarRes.data));
        } catch (lsError) {
          console.error('[Layout Store] Failed to save backend sidebar config to localStorage:', lsError);
        }
      }
    } catch (error) {
      console.warn('[Layout Store] Error during background layout sync:', error);
    }

    if (!layoutTree.value) {
      layoutTree.value = getInitialLayout();
    }
    console.log('[Layout Store] initializeLayout finished.');
    // 异步触发孤立组件状态检查与清理
    try {
      const componentStateStore = useComponentStateStore();
      const activePaneIds = getAllActivePaneIds(layoutTree.value);
      activePaneIds.add('modal');
      activePaneIds.add('default');
      activePaneIds.add('sidebar-left');
      activePaneIds.add('sidebar-right');
      void componentStateStore.cleanupOrphanedStates(activePaneIds);
    } catch (e) {
      console.warn('[Layout Store] 孤立组件状态检查跳过或失败:', e);
    }
    // --- 移除最终状态的详细日志，避免冗余 ---
    // console.log('[Layout Store] Final layoutTree.value:', JSON.stringify(layoutTree.value, null, 2));
    // console.log('[Layout Store] Final sidebarPanes.value:', JSON.stringify(sidebarPanes.value, null, 2));
  }

  // --- Helper for debounced persistence ---
  // 拖分割条会连续产生大量尺寸更新。localStorage 必须每次都同步写：
  // 旧实现整个持久化都塞进 1s 防抖里，用户"拖完立刻刷新"时定时器还没触发，
  // 本地存的一直是旧尺寸 → 刚进页面先显示旧布局（要等会话恢复才跳成新的）。
  // 只有后端 PUT 留防抖，避免拖动期间把请求打爆。
  const persistLayoutTreeLocal = () => {
      if (typeof localStorage === 'undefined') return;
      try {
          localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layoutTree.value));
      } catch (error) {
          console.warn('[Layout Store] 主布局写入 localStorage 失败:', error);
      }
  };

  let persistLayoutDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // 后端 PUT 还没发出去（还在防抖窗口里）—— 页面卸载时要立刻补发，
  // 否则下次加载会拿到后端的旧布局，把刚同步好的 localStorage 覆盖回去。
  let hasPendingBackendPersist = false;
  const debouncedPersistLayout = () => {
      // 先同步落本地，刷新/关页都不会丢
      persistLayoutTreeLocal();
      hasPendingBackendPersist = true;
      if (persistLayoutDebounceTimer) clearTimeout(persistLayoutDebounceTimer);
      persistLayoutDebounceTimer = setTimeout(async () => { // Make async
          hasPendingBackendPersist = false;
          persistLayoutDebounceTimer = null;
          await persistLayoutTree(); // Await the async persist function
      }, 600);
  };

  /**
   * 页面卸载前把"还没发出去的后端保存"补发出去。
   *
   * 必须用 `keepalive`：页面正在卸载时普通请求会被浏览器直接取消。
   * 布局树只有 1KB 级别，远小于 keepalive 的 64KB 限制。
   */
  const flushLayoutPersist = () => {
      if (!hasPendingBackendPersist) return;
      hasPendingBackendPersist = false;
      if (persistLayoutDebounceTimer) {
          clearTimeout(persistLayoutDebounceTimer);
          persistLayoutDebounceTimer = null;
      }
      persistLayoutTreeLocal();
      try {
          void fetch('/api/v1/settings/layout', {
              method: 'PUT',
              keepalive: true,
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(layoutTree.value),
          }).catch(() => { /* 卸载过程中失败可忽略 */ });
      } catch {
          /* noop */
      }
  };

  // 更新整个布局树（通常由配置器保存时调用）
  async function updateLayoutTree(newTree: LayoutNode | null) { // Make async
    // 可选：添加验证逻辑
    if (newTree) {
        // TODO: Add validation
    }
    // Check if the tree actually changed before updating and persisting
    if (JSON.stringify(newTree) !== JSON.stringify(layoutTree.value)) {
        layoutTree.value = newTree;
        console.log('[Layout Store] 布局树已更新。 New tree:', newTree);
        // --- Directly call persist ---
        await persistLayoutTree(); // Await persistence directly
    } else {
        console.log('[Layout Store] updateLayoutTree called but tree is unchanged.');
    }
  }

  // 更新侧栏配置
  async function updateSidebarPanes(newPanes: { left: PaneName[], right: PaneName[] }) { // Make async
    // --- Add Validation ---
    if (newPanes &&
        isValidPaneNameArray(newPanes.left, allPossiblePanes.value) &&
        isValidPaneNameArray(newPanes.right, allPossiblePanes.value))
    {
        // Check if panes actually changed
        if (JSON.stringify(newPanes) !== JSON.stringify(sidebarPanes.value)) {
            sidebarPanes.value = newPanes as { left: PaneName[], right: PaneName[] }; // Assign validated data
            console.log('[Layout Store] 侧栏配置已通过验证并更新。 New sidebarPanes value:', JSON.parse(JSON.stringify(sidebarPanes.value)));
            // --- Directly call persist ---
            await persistSidebarPanes(); // Await persistence directly
        } else {
             console.log('[Layout Store] updateSidebarPanes called but panes are unchanged.');
        }
    } else {
        console.error('[Layout Store] updateSidebarPanes 接收到无效的侧栏配置数据，未更新状态:', newPanes);
        // 可选：抛出错误或通知用户
    }
  }

  // 更新特定容器节点的子节点大小
  function updateNodeSizes(nodeId: string, childrenSizes: { index: number; size: number }[]) {
    // 关键：桌面端渲染的是"会话专属树"，其 paneId 与主布局树不是同一套。
    // 旧实现只拿 nodeId 去主树里找，必然找不到 → 拖动分割条完全不生效，
    // 刷新后按预设重建又回到原尺寸（用户看到的就是"调整没保存"）。
    const activeTree = activeLayoutTreeOverride.value;
    const target = activeTree ?? layoutTree.value;
    const path = findNodePath(target, nodeId);

    if (!path) {
      const mainPath = findNodePath(layoutTree.value, nodeId);
      if (!mainPath || !layoutTree.value) {
        console.log(`[Layout Store] 未找到节点 ${nodeId}，忽略尺寸更新。`);
        return;
      }
      layoutTree.value = applySizesAtPath(layoutTree.value, mainPath, childrenSizes);
      debouncedPersistLayout();
      return;
    }

    const nextTree = applySizesAtPath(target, path, childrenSizes);
    if (!nextTree || JSON.stringify(nextTree) === JSON.stringify(target)) return;

    if (activeTree) {
      const sessionId = activeLayoutSessionId.value;
      if (sessionId) {
        // shallowReactive 的 Map：整体替换才会触发桌面端重渲染
        sessionLayoutTreeMap.set(sessionId, nextTree);
      }
      activeLayoutTreeOverride.value = nextTree;

      // 同时写回该会话使用的预设 —— 会话树是每次刷新从预设克隆出来的，
      // 不写回预设的话，刷新后尺寸又回到旧值。
      const preset = getPresetForConnection(activeLayoutConnectionId.value);
      if (preset?.layoutTree) {
        const updatedPresetTree = applySizesAtPath(preset.layoutTree, path, childrenSizes);
        if (updatedPresetTree) updatePreset(preset.id, { layoutTree: updatedPresetTree });
      }

      // 首帧渲染用的是主布局树（来自 localStorage）。不同步的话，
      // 刷新时就会"先闪一下默认预设的尺寸，再跳到真实尺寸"。
      //
      // ⚠️ 只有活动会话用的就是**全局默认预设**时才同步主树：
      // 主树 = 空闲工作区布局，被非默认预设（按连接绑定的那套）改掉的话，
      // 关掉会话后空闲工作区会变成那个预设的样子，刷新也回不来。
      const isDefaultPresetActive = preset?.id === defaultPresetId.value;
      if (isDefaultPresetActive && layoutTree.value) {
        const syncedMainTree = applySizesAtPath(layoutTree.value, path, childrenSizes);
        if (syncedMainTree) {
          layoutTree.value = syncedMainTree;
          debouncedPersistLayout();
        }
      }
    } else {
      layoutTree.value = nextTree;
      debouncedPersistLayout();

      // 没有活动会话时改的是"主布局树"，但会话打开后渲染的是从**预设**克隆的会话树。
      // 不同步写回默认预设的话，没会话时调好的尺寸一开会话就变回旧值。
      const defaultPreset = getPresetForConnection(null);
      if (defaultPreset?.layoutTree) {
        const updatedDefaultTree = applySizesAtPath(defaultPreset.layoutTree, path, childrenSizes);
        if (updatedDefaultTree) updatePreset(defaultPreset.id, { layoutTree: updatedDefaultTree });
      }
    }
    console.log(`[Layout Store] 节点 ${nodeId} 的尺寸已更新（${activeTree ? '会话树 + 预设' : '主布局树 + 默认预设'}）`);
  }
  // 切换布局（Header/Footer）的可见性
  function toggleLayoutVisibility() {
    isLayoutVisible.value = !isLayoutVisible.value;
    console.log(`[Layout Store] 布局可见性切换为: ${isLayoutVisible.value}`);
    // 注意：这个状态目前不与后端同步
  }

  // 从后端/缓存加载主导航栏可见性设置 (分端加载)
  async function loadHeaderVisibility() {
    const isMobile = isMobilePlatform();
    const platform = isMobile ? 'mobile' : 'desktop';
    console.log(`[Layout Store] Attempting to load header visibility for ${platform}...`);
    try {
      // --- 调用后端 API (携带 platform 参数区分桌面端与移动端) ---
      const response = await apiClient.get<{ visible: boolean }>(`/settings/nav-bar-visibility?platform=${platform}`);
      if (response && typeof response.data.visible === 'boolean') {
        const val = response.data.visible;
        if (isMobile) {
          mobileHeaderVisible.value = val;
          if (typeof localStorage !== 'undefined') localStorage.setItem(LS_HEADER_VISIBLE_MOBILE, String(val));
        } else {
          desktopHeaderVisible.value = val;
          if (typeof localStorage !== 'undefined') localStorage.setItem(LS_HEADER_VISIBLE_DESKTOP, String(val));
        }
        isHeaderVisible.value = val;
        console.log(`[Layout Store] Header visibility for ${platform} loaded from backend: ${val}`);
      }
    } catch (error) {
      console.warn(`[Layout Store] Failed to load header visibility for ${platform} from backend:`, error);
      // 出错时同步当前本地状态
      syncCurrentHeaderVisibility();
    }
  }

  // 切换主导航栏可见性并同步到后端 (分端存储，互不干扰)
  async function toggleHeaderVisibility() {
    const isMobile = isMobilePlatform();
    const platform = isMobile ? 'mobile' : 'desktop';
    const currentVal = isMobile ? mobileHeaderVisible.value : desktopHeaderVisible.value;
    const newValue = !currentVal;

    console.log(`[Layout Store] Toggling header visibility for ${platform} to: ${newValue}`);

    if (isMobile) {
      mobileHeaderVisible.value = newValue;
      if (typeof localStorage !== 'undefined') localStorage.setItem(LS_HEADER_VISIBLE_MOBILE, String(newValue));
    } else {
      desktopHeaderVisible.value = newValue;
      if (typeof localStorage !== 'undefined') localStorage.setItem(LS_HEADER_VISIBLE_DESKTOP, String(newValue));
    }
    isHeaderVisible.value = newValue; // 立即更新当前端 UI

    try {
      // --- 调用后端 API (携带 platform 字段实现分端持久化) ---
      await apiClient.put('/settings/nav-bar-visibility', { visible: newValue, platform });
      console.log(`[Layout Store] Header visibility for ${platform} saved to backend.`);
    } catch (error) {
      console.error(`[Layout Store] Failed to save header visibility for ${platform} to backend:`, error);
    }
  }

 // 获取系统内置的默认布局
 function getSystemDefaultLayout(): LayoutNode {
   console.log('[Layout Store] Getting system default layout.');
   return getDefaultLayout(); // 直接调用内部函数
 }

 // 获取系统内置的默认侧栏配置
 function getSystemDefaultSidebarPanes(): { left: PaneName[], right: PaneName[] } {
     console.log('[Layout Store] Getting system default sidebar panes.');
     return getDefaultSidebarPanes();
 }

 // 将当前主布局树持久化到后端和 localStorage
 async function persistLayoutTree() { // Make async
   // 先同步写 localStorage，再发网络请求。
   // 反过来的话，PUT 还没返回用户就刷新/关页 → 本地还是旧布局（"改完立刻刷新就回去了"）。
   persistLayoutTreeLocal();
   try {
     console.log('[Layout Store] Attempting to save main layout to backend...');
     await apiClient.put('/settings/layout', layoutTree.value); // await
     console.log('[Layout Store] 主布局已成功保存到后端 (sent value):', layoutTree.value);
   } catch (error) {
     console.error('[Layout Store] 保存主布局到后端失败:', error);
   }
    // 布局保存后，检查并清理不存在的组件实例对应的持久化设置
    try {
      const componentStateStore = useComponentStateStore();
      const activePaneIds = getAllActivePaneIds(layoutTree.value);
      activePaneIds.add('modal');
      activePaneIds.add('default');
      activePaneIds.add('sidebar-left');
      activePaneIds.add('sidebar-right');
      void componentStateStore.cleanupOrphanedStates(activePaneIds);
    } catch (e) {
      console.warn('[Layout Store] 孤立组件状态检查跳过或失败:', e);
    }
 }

 // 将当前侧栏配置持久化到后端和 localStorage
 async function persistSidebarPanes() { // Make async
    // ... (existing try/catch logic for backend and localStorage) ...
    try {
         console.log('[Layout Store] Attempting to save sidebar config to backend...');
         await apiClient.put('/settings/sidebar', sidebarPanes.value); // await
         console.log('[Layout Store] 侧栏配置已成功保存到后端。');
     } catch (error) {
         console.error('[Layout Store] 保存侧栏配置到后端失败:', error);
     }
     // localStorage is synchronous
     try {
         const sidebarsToSave = JSON.stringify(sidebarPanes.value);
         localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarsToSave);
         console.log('[Layout Store] 侧栏配置已自动保存到 localStorage。');
     } catch (error) {
         console.error('[Layout Store] 保存侧栏配置到 localStorage 失败:', error);
     }
 }


 // --- REMOVE the old watchers that called persist ---
 // watch(layoutTree, ...); // REMOVE THIS
 // watch(sidebarPanes, ...); // REMOVE THIS
  // --- 预设与连接绑定（状态与动作见 stores/layout/useLayoutPresets.ts）---
  const {
    layoutPresets,
    defaultPresetId,
    connectionLayoutMap,
    activeEditingPresetId,
    initializePresets,
    reloadPresetsFromServer,
    persistPresets,
    findConnectionByRef,
    resolveConnectionUuid,
    getPresetForConnection,
    isConnectionUsingPreset,
    setDefaultPreset,
    bindConnectionsToPreset,
    unbindConnection,
    createPreset,
    updatePreset,
    deletePreset,
    registerSessionTreeRefresher,
  } = useLayoutPresets({
    layoutTree,
    sidebarPanes,
    updateLayoutTree,
    buildSeedPreset: buildDefaultPresetFrom,
    reconcileStoredPresets: reconcilePresets,
    getSystemDefaultPresets,
  });

  // 会话独立布局树（缓存与不变量见 stores/layout/useSessionLayoutTrees.ts）
  const {
    sessionLayoutTreeMap,
    recordSessionPaneOrder,
    getSessionTerminalPaneOrder,
    getLayoutTreeForSession,
    clearSessionLayoutTree,
    refreshSessionLayoutTree,
  } = useSessionLayoutTrees({ getPresetForConnection });

  // 把会话树刷新器交给预设层（reloadPresetsFromServer 用它决定哪些已打开会话要重建）
  registerSessionTreeRefresher(refreshSessionLayoutTree);

  // --- 终端多窗格聚焦管理 ---
  // 实现已拆到 stores/layout/usePaneFocus.ts（在文件上方调用并解构）。
  // 这里曾是一个 110 行的状态机：collectTerminalPaneIds / activeLayoutTreeOverride /
  // syncActiveTerminalPaneFromTree / setActiveTerminalPaneId / cycleTerminalFocus。

  // --- 初始化 ---
  // Store 创建时自动初始化布局和侧栏。
  // 顺序有讲究：预设必须等主布局（后端 settings.layout）加载完再决定"默认布局"取谁的内容，
  // 否则老用户升级上来会先被我们内置的默认布局覆盖一次。
  const layoutInitPromise = initializeLayout();
  initializePresets(layoutInitPromise);
  // 单独加载 Header 可见性（如果需要与布局初始化分开）
  loadHeaderVisibility();


 // --- 返回 ---
 return {
   // State
   layoutTree,
   sidebarPanes, // <--- 暴露侧栏状态
   allPossiblePanes,
   isLayoutVisible,
   isHeaderVisible,
   activeTerminalPaneId,
   // Computed
   currentTerminalPaneIds,
   availablePanes,
   usedPanes,
   // Actions
   updateLayoutTree,
   updateSidebarPanes, // <--- 暴露侧栏更新 action
   initializeLayout,
   updateNodeSizes,
   flushLayoutPersist,
   generateId,
    getAllActivePaneIds: () => getAllActivePaneIds(layoutTree.value),
   toggleLayoutVisibility,
   loadHeaderVisibility,
   toggleHeaderVisibility,
   getSystemDefaultLayout,
   getSystemDefaultSidebarPanes, // <--- 暴露获取默认侧栏配置的方法
   setActiveTerminalPaneId,
   syncActiveTerminalPaneFromTree,
   getActiveLayoutTree,
    // Presets & Connection Layout Mapping
    layoutPresets,
    defaultPresetId,
    connectionLayoutMap,
    activeEditingPresetId,
    getSystemDefaultPresets,
    getPresetForConnection,
    resolveConnectionUuid,
    reloadPresetsFromServer,
    getLayoutTreeForSession,
    clearSessionLayoutTree,
    refreshSessionLayoutTree,
    getSessionTerminalPaneOrder,
    isConnectionUsingPreset,
    setDefaultPreset,
    bindConnectionsToPreset,
    unbindConnection,
    createPreset,
    updatePreset,
    deletePreset,
    persistPresets,

   cycleTerminalFocus,
   // Persist actions (可选暴露，如果需要手动触发)
   // persistLayoutTree,
   // persistSidebarPanes,
 };
});
