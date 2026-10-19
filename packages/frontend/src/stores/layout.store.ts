import { defineStore } from 'pinia';
import { ref, computed, shallowReactive, type Ref, type ComputedRef } from 'vue';
import apiClient from '../utils/apiClient';
import { useComponentStateStore } from './componentState.store';
import { useConnectionsStore } from './connections.store';
import { sessions as sessionStateMap } from './session/state';

import type {
  LayoutNode,
  LayoutPreset,
  PaneName,
  TerminalAutoExecConfig,
  TerminalPaneBackgroundConfig,
} from '../types/layout';
import {
  applySizesAtPath,
  cloneLayoutTreeWithStableIds,
  ensureNodeIds,
  findNodePath,
  getTerminalPaneIdsInLayout,
  layoutShapeSignature,
  randomId,
  reconcileTreePreservingIds,
} from '../utils/layoutTree';
import { usePaneFocus } from './layout/usePaneFocus';
import {
  DEFAULT_PRESET_ID,
  DEFAULT_PRESET_NAME,
  buildDefaultPresetFrom as buildDefaultPresetFromBase,
  reconcilePresets as reconcilePresetsBase,
} from '../utils/layoutPreset';
import { LEGACY_TEMPLATE_IDS } from '../utils/layoutPreset';

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
const LAYOUT_PRESETS_STORAGE_KEY = 'nexus_terminal_layout_presets';
const DEFAULT_PRESET_ID_STORAGE_KEY = 'nexus_terminal_default_preset_id';
const CONNECTION_LAYOUT_MAP_STORAGE_KEY = 'nexus_terminal_connection_layout_map';
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
  'dockerManager', 'suspendedSshSessions', 'multiLineCommandInput'
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
    // --- 预设与连接绑定管理 ---
  /**
   * 初始预设（同步，供首屏渲染与会话树创建立刻使用）。
   *
   * 关键：localStorage 里没有预设数据时，默认预设直接继承"用户当前正在使用的布局"
   * （layoutTree / sidebarPanes 的初始值也是同步从 localStorage 读出来的），
   * 而不是内置默认 —— 否则旧用户升级后，原有布局会被我们预设的默认布局覆盖。
   */
  function getInitialPresets(): LayoutPreset[] {
    const seedPreset = buildDefaultPresetFrom(layoutTree.value, sidebarPanes.value);
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(LAYOUT_PRESETS_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return reconcilePresets(parsed, seedPreset);
          }
        }
      } catch (e) {
        // ignore
      }
    }
    return [seedPreset];
  }

  function getInitialDefaultPresetId(): string {
    if (typeof localStorage !== 'undefined') {
      try {
        const saved = localStorage.getItem(DEFAULT_PRESET_ID_STORAGE_KEY);
        if (saved && !LEGACY_TEMPLATE_IDS.has(saved)) return saved;
      } catch (e) {
        // ignore
      }
    }
    return 'preset-default';
  }

  function getInitialConnectionLayoutMap(): Record<string, string> {
    if (typeof localStorage !== 'undefined') {
      try {
        const saved = localStorage.getItem(CONNECTION_LAYOUT_MAP_STORAGE_KEY);
        if (saved) {
          const map = JSON.parse(saved);
          for (const key in map) {
            if (LEGACY_TEMPLATE_IDS.has(map[key])) {
              delete map[key];
            }
          }
          return map;
        }
      } catch (e) {
        // ignore
      }
    }
    return {};
  }

  const layoutPresets = ref<LayoutPreset[]>(getInitialPresets());
  const defaultPresetId = ref<string>(getInitialDefaultPresetId());
  const connectionLayoutMap = ref<Record<string, string>>(getInitialConnectionLayoutMap()); // connectionId|connectionUuid -> presetId
  const activeEditingPresetId = ref<string>('preset-default'); // 当前正在配置器中编辑的预设 ID

  // 上一次成功同步给后端的内容签名：内容没变就不再 PUT。
  // 否则每次打开页面（initializePresetsAsync 收尾会 persist 一次）都会把后端的
  // updated_at 顶到最新，另一端的推送在 LWW 里永远比不过，跨端同步就成了单向的。
  let lastPersistedPresetsSignature: string | null = null;

  // 会话独立稳定布局树映射缓存 (sessionId -> LayoutNode)
  // 用 shallowReactive(Map) 保证"整体替换某会话的树"能触发桌面端重渲染：
  // 之前是裸 Map，刷新后模板读不到变化，表现为"保存布局没反应"。
  const sessionLayoutTreeMap = shallowReactive(new Map<string, LayoutNode>());

  /**
   * 每个会话树里终端 pane 的先序 ID 顺序。
   *
   * 会话树的 paneId 每次刷新都会重新生成，而云端同步快照是按 paneId 存终端屏幕内容的，
   * 直接对 key 会全部 miss（表现为"刷新后终端内容对不上/每次都不一样"）。
   * 这里用"先序序号"作为跨刷新稳定的逻辑键：pane#0、pane#1 ……
   */
  const sessionPaneOrderMap = new Map<string, string[]>();

  function recordSessionPaneOrder(sessionId: string, tree: LayoutNode) {
    sessionPaneOrderMap.set(sessionId, getTerminalPaneIdsInLayout(tree));
  }

  /** 取某会话终端 pane 的先序顺序（跨刷新稳定） */
  function getSessionTerminalPaneOrder(sessionId: string): string[] {
    return sessionPaneOrderMap.get(sessionId) ?? [];
  }


  // 初始化预设（layoutReady：主布局加载完成信号，见文件末尾的初始化顺序）
  function initializePresets(layoutReady?: Promise<unknown>) {
    void initializePresetsAsync(layoutReady);
  }

  /**
   * 预设加载：后端（跨端同步）> localStorage > 系统默认。
   *
   * 以前只读 localStorage，后端也没有 /settings/layout-presets 路由，
   * persistPresets 的 PUT 一直 404 被静默吞掉 —— 表现就是"桌面端和 Web 端预设互不同步"。
   *
   * 升级兼容：老用户没有预设数据时，默认预设取"他们当时正在用的布局"（settings.layout），
   * 绝不能用内置默认把它盖掉，所以这里必须先等主布局加载完成。
   */
  async function initializePresetsAsync(layoutReady?: Promise<unknown>) {
    if (layoutReady) {
      try {
        await layoutReady;
      } catch {
        /* 布局加载失败时退回本地缓存 */
      }
    }

    // 种子 = 用户当前布局（此时 layoutTree 已是最新：后端优先，其次 localStorage）
    const seedPreset = buildDefaultPresetFrom(layoutTree.value, sidebarPanes.value);

    let remote: { presets?: LayoutPreset[]; defaultPresetId?: string; connectionLayoutMap?: Record<string, string> } | null = null;
    try {
      const res = await apiClient.get('/settings/layout-presets');
      const data = res?.data as any;
      if (data && Array.isArray(data.presets) && data.presets.length > 0) remote = data;
    } catch {
      /* 首次部署 / 后端暂无数据 */
    }

    try {
      const rawPresets = remote
        ? JSON.stringify(remote.presets)
        : (typeof localStorage !== 'undefined' ? localStorage.getItem(LAYOUT_PRESETS_STORAGE_KEY) : null);
      const rawDefaultId = remote?.defaultPresetId
        || (typeof localStorage !== 'undefined' ? localStorage.getItem(DEFAULT_PRESET_ID_STORAGE_KEY) : null);
      const rawMap = remote?.connectionLayoutMap
        ? JSON.stringify(remote.connectionLayoutMap)
        : (typeof localStorage !== 'undefined' ? localStorage.getItem(CONNECTION_LAYOUT_MAP_STORAGE_KEY) : null);

      if (rawDefaultId && !LEGACY_TEMPLATE_IDS.has(rawDefaultId)) {
        defaultPresetId.value = rawDefaultId;
      } else {
        defaultPresetId.value = DEFAULT_PRESET_ID;
      }

      if (rawMap) {
        const parsedMap = JSON.parse(rawMap);
        for (const connId in parsedMap) {
          if (LEGACY_TEMPLATE_IDS.has(parsedMap[connId])) {
            delete parsedMap[connId];
          }
        }
        connectionLayoutMap.value = parsedMap;
      }

      if (rawPresets) {
        const parsed = JSON.parse(rawPresets);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // 过滤废弃模板 + 用当前布局补齐/修复默认预设
          layoutPresets.value = reconcilePresets(parsed, seedPreset);
        } else {
          layoutPresets.value = [seedPreset];
        }
      } else {
        // 老用户升级上来（后端与本地都没有预设数据）：把当前布局直接变成默认布局
        layoutPresets.value = [seedPreset];
      }

      // 后端已有数据时，先把"已和后端一致"的签名记下来再 persist ——
      // 这样纯读取不会把后端 updated_at 重新顶一遍（会挡住另一端的 LWW 推送）。
      // 后端为空时才需要真正 PUT 一次（把本地/种子数据种进去）。
      if (remote) {
        lastPersistedPresetsSignature = buildPresetsSignature(
          layoutPresets.value,
          defaultPresetId.value,
          connectionLayoutMap.value
        );
      }

      // 清洗后立即持久化更新本地和后端
      persistPresets();
    } catch (err) {
      console.warn('[Layout Store] 加载预设配置异常，使用当前布局作为默认预设:', err);
      layoutPresets.value = [seedPreset];
    }

    if (!layoutPresets.value.some(p => p.id === defaultPresetId.value)) {
      defaultPresetId.value = layoutPresets.value[0]?.id || DEFAULT_PRESET_ID;
    }

    layoutPresets.value.forEach(p => {
      p.isDefault = (p.id === defaultPresetId.value);
    });

    // 空闲工作区（没有打开任何会话）渲染的是主布局 settings.layout，
    // 它必须等于"全局默认预设"。否则：编辑过某个按连接绑定的预设后，
    // 关掉会话会看到那个预设的布局，刷新也还是它（数据已经写进 settings.layout 了）。
    // 这里做一次对齐，顺带把历史上被写脏的老数据自愈回来。
    //
    // ⚠️ 只对齐 layoutTree，不要动 sidebarPanes：
    // 侧栏是用户随时用左侧图标开关的"实时配置"（settings.sidebar），
    // 预设里的 sidebarPanes 只是它的快照，强行回写会把用户刚加进去的面板抹掉。
    const idlePreset = layoutPresets.value.find(p => p.id === defaultPresetId.value);
    if (idlePreset) {
      try {
        if (idlePreset.layoutTree
            && JSON.stringify(idlePreset.layoutTree) !== JSON.stringify(layoutTree.value)) {
          await updateLayoutTree(JSON.parse(JSON.stringify(idlePreset.layoutTree)));
        }
      } catch (idleSyncErr) {
        console.warn('[Layout Store] 对齐空闲工作区布局失败:', idleSyncErr);
      }
    }
  }

  /** 生成用于"是否真的变了"判断的稳定签名（排除 isDefault 之类的派生字段和数组顺序） */
  function buildPresetsSignature(
    presets: LayoutPreset[],
    defaultId: string,
    map: Record<string, string>
  ): string {
    const normalized = [...presets]
      .map(p => ({
        id: p.id,
        name: p.name,
        layoutTree: p.layoutTree,
        sidebarPanes: p.sidebarPanes,
        connectionIds: p.connectionIds || [],
        connectionUuids: p.connectionUuids || [],
        updatedAt: p.updatedAt || 0,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const normalizedMap: Record<string, string> = {};
    Object.keys(map || {}).sort().forEach(key => {
      normalizedMap[key] = map[key];
    });
    return JSON.stringify({ presets: normalized, defaultId, map: normalizedMap });
  }

  /**
   * 从后端重新拉取布局预设（跨端实时刷新）。
   *
   * 预设以前只在 Store 初始化时读一次，所以桌面端新建预设 / 改绑定之后，
   * Web 端必须刷新整页才看得见。这里提供"重载"入口：
   * - 打开布局管理器前调用一次（兜底，防止 WS 断线漏消息）
   * - 收到全局 sync:completed / sync:invalidated 时由 refreshAllStores 调用
   *
   * 只读不写回后端，避免把刚拉到的数据又被本机的旧缓存覆盖。
   */
  async function reloadPresetsFromServer(): Promise<boolean> {
    try {
      const res = await apiClient.get('/settings/layout-presets');
      const data = res?.data as any;
      if (!data || !Array.isArray(data.presets) || data.presets.length === 0) {
        return false;
      }

      const remoteMap: Record<string, string> =
        data.connectionLayoutMap && typeof data.connectionLayoutMap === 'object'
          ? data.connectionLayoutMap
          : {};
      const remoteDefaultId: string = data.defaultPresetId || DEFAULT_PRESET_ID;

      const beforeSignature = buildPresetsSignature(
        layoutPresets.value,
        defaultPresetId.value,
        connectionLayoutMap.value
      );
      const afterSignature = buildPresetsSignature(data.presets, remoteDefaultId, remoteMap);
      if (beforeSignature === afterSignature) {
        return false;
      }

      // 记录"加载前每个会话实际用的预设 + 布局"，用于判断哪些已打开会话需要重建布局
      const previousSessionLayout = new Map<string, { presetId: string; treeSignature: string }>();
      try {
        for (const [sessionId, session] of sessionStateMap.value) {
          const preset = getPresetForConnection(session.connectionId);
          previousSessionLayout.set(sessionId, {
            presetId: preset.id,
            treeSignature: JSON.stringify(preset.layoutTree),
          });
        }
      } catch {
        /* 会话状态不可用时跳过 */
      }

      const seedPreset = buildDefaultPresetFrom(layoutTree.value, sidebarPanes.value);
      layoutPresets.value = reconcilePresets(data.presets, seedPreset);
      defaultPresetId.value = remoteDefaultId;
      if (!layoutPresets.value.some(p => p.id === defaultPresetId.value)) {
        defaultPresetId.value = layoutPresets.value[0]?.id || DEFAULT_PRESET_ID;
      }
      layoutPresets.value.forEach(p => {
        p.isDefault = (p.id === defaultPresetId.value);
      });

      connectionLayoutMap.value = { ...remoteMap };

      // 本地此刻与后端一致，记下签名避免下一次 persist 无谓回写
      lastPersistedPresetsSignature = buildPresetsSignature(
        layoutPresets.value,
        defaultPresetId.value,
        connectionLayoutMap.value
      );

      if (!layoutPresets.value.some(p => p.id === activeEditingPresetId.value)) {
        activeEditingPresetId.value = defaultPresetId.value;
      }

      // 只落本地缓存，不回写后端
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(LAYOUT_PRESETS_STORAGE_KEY, JSON.stringify(layoutPresets.value));
          localStorage.setItem(DEFAULT_PRESET_ID_STORAGE_KEY, defaultPresetId.value);
          localStorage.setItem(CONNECTION_LAYOUT_MAP_STORAGE_KEY, JSON.stringify(connectionLayoutMap.value));
        }
      } catch {
        /* localStorage 不可用时忽略 */
      }

      // 已打开的会话：预设换了、或它用的预设布局变了，才重建（复用旧 paneId，终端不会被销毁）
      try {
        for (const [sessionId, session] of sessionStateMap.value) {
          const preset = getPresetForConnection(session.connectionId);
          const previous = previousSessionLayout.get(sessionId);
          const changed = !previous
            || previous.presetId !== preset.id
            || previous.treeSignature !== JSON.stringify(preset.layoutTree);
          if (changed) {
            refreshSessionLayoutTree(sessionId, session.connectionId);
          }
        }
      } catch (sessionErr) {
        console.warn('[Layout Store] 刷新会话布局树失败:', sessionErr);
      }

      console.log('[Layout Store] 已从后端重载布局预设（跨端同步）');
      return true;
    } catch (err: any) {
      console.warn('[Layout Store] 重载布局预设失败:', err?.message || err);
      return false;
    }
  }

  // 持久化预设
  async function persistPresets() {
    const signature = buildPresetsSignature(layoutPresets.value, defaultPresetId.value, connectionLayoutMap.value);
    const unchangedSinceLastPush = signature === lastPersistedPresetsSignature;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LAYOUT_PRESETS_STORAGE_KEY, JSON.stringify(layoutPresets.value));
        localStorage.setItem(DEFAULT_PRESET_ID_STORAGE_KEY, defaultPresetId.value);
        localStorage.setItem(CONNECTION_LAYOUT_MAP_STORAGE_KEY, JSON.stringify(connectionLayoutMap.value));
      }

      if (unchangedSinceLastPush) return;

      // 同步到后端
      await apiClient.put('/settings/layout-presets', {
        presets: layoutPresets.value,
        defaultPresetId: defaultPresetId.value,
        connectionLayoutMap: connectionLayoutMap.value,
      }).then(() => {
        lastPersistedPresetsSignature = signature;
      }).catch(err => {
        // 后端若暂无路由则静默降级到 LocalStorage
      });
    } catch (err) {
      console.error('[Layout Store] 保存预设配置失败:', err);
    }
  }

  // --- 连接绑定身份解析 ---
  // 连接在两端的本地自增 id 完全不同（同步按 uuid 合并、id 重新分配），
  // 所以绑定必须以 uuid 为准，本地 id 只用于兼容老数据。
  const isNumericConnectionRef = (value: string) => /^\d+$/.test(value);

  function findConnectionByRef(ref?: number | string | null) {
    if (ref === null || ref === undefined || ref === '') return null;
    const raw = String(ref);
    try {
      const connectionsStore = useConnectionsStore();
      const list = connectionsStore.connections || [];
      const byUuid = list.find(c => !!c.uuid && c.uuid === raw);
      if (byUuid) return byUuid;
      if (isNumericConnectionRef(raw)) {
        return list.find(c => String(c.id) === raw) ?? null;
      }
    } catch {
      /* Pinia 尚未就绪时忽略 */
    }
    return null;
  }

  /** 把连接 id / uuid 统一解析成 uuid（解析不到时，若本身就是 uuid 则原样返回） */
  function resolveConnectionUuid(ref?: number | string | null): string | null {
    if (ref === null || ref === undefined || ref === '') return null;
    const raw = String(ref);
    const conn = findConnectionByRef(raw);
    if (conn?.uuid) return conn.uuid;
    return isNumericConnectionRef(raw) ? null : raw;
  }

  // 根据连接 ID / UUID 获取对应预设
  function getPresetForConnection(connectionId?: number | string | null): LayoutPreset {
    const raw = connectionId === null || connectionId === undefined ? '' : String(connectionId);
    const uuid = raw ? resolveConnectionUuid(raw) : null;
    const numId = isNumericConnectionRef(raw) ? Number(raw) : NaN;

    // 1) UUID 绑定（跨端权威来源）
    if (uuid) {
      const mappedPresetId = connectionLayoutMap.value[uuid];
      if (mappedPresetId) {
        const found = layoutPresets.value.find(p => p.id === mappedPresetId);
        if (found) return found;
      }
      const matchedByUuid = layoutPresets.value.find(p => p.connectionUuids?.includes(uuid));
      if (matchedByUuid) return matchedByUuid;
    }

    // 2) 老数据兼容：只用"还没升级成 uuid 绑定"的预设做本地 id 匹配。
    //    否则升级后会被另一台设备留下的旧 id 抢走正确的 uuid 绑定。
    if (!isNaN(numId)) {
      const legacyPresetId = connectionLayoutMap.value[numId];
      if (legacyPresetId) {
        const found = layoutPresets.value.find(p => p.id === legacyPresetId && !p.connectionUuids?.length);
        if (found) return found;
      }
      const matched = layoutPresets.value.find(p => !p.connectionUuids?.length && p.connectionIds?.includes(numId));
      if (matched) return matched;
    }

    const defaultP = layoutPresets.value.find(p => p.id === defaultPresetId.value);
    if (defaultP) return defaultP;
    return layoutPresets.value[0] || getSystemDefaultPresets()[0];
  }

  // 为会话获取专属稳定布局树（0 毫秒秒切基石）
  function getLayoutTreeForSession(sessionId?: string | null, connectionId?: number | string | null): LayoutNode {
    if (!sessionId) {
      return getPresetForConnection(connectionId).layoutTree;
    }
    if (sessionLayoutTreeMap.has(sessionId)) {
      return sessionLayoutTreeMap.get(sessionId)!;
    }
    const preset = getPresetForConnection(connectionId);
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
    const preset = getPresetForConnection(connectionId);
    const oldTree = sessionLayoutTreeMap.get(sessionId);
    const dedicatedTree = oldTree
      ? reconcileTreePreservingIds(oldTree, preset.layoutTree)
      : cloneLayoutTreeWithStableIds(preset.layoutTree);
    sessionLayoutTreeMap.set(sessionId, dedicatedTree);
    recordSessionPaneOrder(sessionId, dedicatedTree);
    return dedicatedTree;
  }

  /** 某连接（会话）当前是否在用指定预设 */
  function isConnectionUsingPreset(connectionId: number | string | null | undefined, presetId: string): boolean {
    return getPresetForConnection(connectionId).id === presetId;
  }

  // 设为默认预设
  function setDefaultPreset(presetId: string) {
    defaultPresetId.value = presetId;
    layoutPresets.value.forEach(p => {
      p.isDefault = (p.id === presetId);
    });
    persistPresets();
  }

  // 绑定一组连接到特定预设
  function bindConnectionsToPreset(presetId: string, connIds: number[]) {
    const targetIds = new Set(connIds);
    const targetUuids = new Set<string>();
    for (const id of connIds) {
      const uuid = resolveConnectionUuid(id);
      if (uuid) targetUuids.add(uuid);
    }

    const targetPreset = layoutPresets.value.find(p => p.id === presetId);
    const prevIds = new Set(targetPreset?.connectionIds || []);
    const prevUuids = new Set(targetPreset?.connectionUuids || []);

    for (const preset of layoutPresets.value) {
      if (preset.id === presetId) {
        // 以弹窗里的勾选结果为准。旧实现是"与已有取并集"，
        // 所以取消勾选后连接依然绑着 —— 用户看到的"解绑没生效"就是这里。
        preset.connectionIds = Array.from(targetIds);
        preset.connectionUuids = Array.from(targetUuids);
      } else {
        if (preset.connectionIds?.length) {
          preset.connectionIds = preset.connectionIds.filter(id => !targetIds.has(id));
        }
        if (preset.connectionUuids?.length) {
          preset.connectionUuids = preset.connectionUuids.filter(uuid => !targetUuids.has(uuid));
        }
      }
    }

    // 先清掉本预设被取消勾选的连接，避免映射表残留把它们继续指过来
    for (const id of prevIds) {
      if (targetIds.has(id)) continue;
      const uuid = resolveConnectionUuid(id);
      if (!uuid || !targetUuids.has(uuid)) {
        if (connectionLayoutMap.value[id] === presetId) delete connectionLayoutMap.value[id];
        if (uuid && connectionLayoutMap.value[uuid] === presetId) delete connectionLayoutMap.value[uuid];
      }
    }
    for (const uuid of prevUuids) {
      if (!targetUuids.has(uuid) && connectionLayoutMap.value[uuid] === presetId) {
        delete connectionLayoutMap.value[uuid];
      }
    }

    // 映射表同时写 uuid 与本地 id：uuid 供跨端识别，id 兼容未升级的客户端
    for (const id of targetIds) {
      connectionLayoutMap.value[id] = presetId;
    }
    for (const uuid of targetUuids) {
      connectionLayoutMap.value[uuid] = presetId;
    }
    persistPresets();
  }

  // 移除某个连接的预设绑定 (恢复使用默认预设)
  function unbindConnection(connId: number) {
    const uuid = resolveConnectionUuid(connId);
    delete connectionLayoutMap.value[connId];
    if (uuid) delete connectionLayoutMap.value[uuid];
    for (const preset of layoutPresets.value) {
      if (preset.connectionIds) {
        preset.connectionIds = preset.connectionIds.filter(id => id !== connId);
      }
      if (uuid && preset.connectionUuids) {
        preset.connectionUuids = preset.connectionUuids.filter(item => item !== uuid);
      }
    }
    persistPresets();
  }

  // 创建/另存为新预设
  function createPreset(name: string, tree: LayoutNode, sidebars: { left: PaneName[]; right: PaneName[] }, connIds: number[] = []): LayoutPreset {
    const boundUuids = connIds
      .map(id => resolveConnectionUuid(id))
      .filter((uuid): uuid is string => !!uuid);
    const newPreset: LayoutPreset = {
      id: `preset-user-${generateId()}`,
      name: name.trim() || '自定义布局',
      isDefault: false,
      isSystem: false,
      layoutTree: JSON.parse(JSON.stringify(tree)),
      sidebarPanes: JSON.parse(JSON.stringify(sidebars)),
      connectionIds: connIds,
      connectionUuids: boundUuids,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    layoutPresets.value.push(newPreset);
    activeEditingPresetId.value = newPreset.id;
    if (connIds.length > 0) {
      bindConnectionsToPreset(newPreset.id, connIds);
    } else {
      persistPresets();
    }
    return newPreset;
  }

  // 更新现有预设
  function updatePreset(presetId: string, updates: Partial<LayoutPreset>) {
    const idx = layoutPresets.value.findIndex(p => p.id === presetId);
    if (idx === -1) return;
    const existing = layoutPresets.value[idx];
    layoutPresets.value[idx] = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };
    if (updates.connectionIds) {
      bindConnectionsToPreset(presetId, updates.connectionIds);
    } else {
      persistPresets();
    }
  }

  // 删除预设 (系统内置预设受保护禁止删除)
  function deletePreset(presetId: string): boolean {
    const target = layoutPresets.value.find(p => p.id === presetId);
    if (!target || target.isSystem) return false;
    if (defaultPresetId.value === presetId) {
      defaultPresetId.value = 'preset-default';
      const sysDef = layoutPresets.value.find(p => p.id === 'preset-default');
      if (sysDef) sysDef.isDefault = true;
    }
    if (target.connectionIds) {
      target.connectionIds.forEach(id => {
        delete connectionLayoutMap.value[id];
        const uuid = resolveConnectionUuid(id);
        if (uuid) delete connectionLayoutMap.value[uuid];
      });
    }
    if (target.connectionUuids) {
      target.connectionUuids.forEach(uuid => {
        delete connectionLayoutMap.value[uuid];
      });
    }
    layoutPresets.value = layoutPresets.value.filter(p => p.id !== presetId);
    if (activeEditingPresetId.value === presetId) {
      activeEditingPresetId.value = defaultPresetId.value;
    }
    persistPresets();
    return true;
  }

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
