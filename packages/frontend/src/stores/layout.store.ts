import { defineStore } from 'pinia';
import { ref, computed, watch, type Ref, type ComputedRef } from 'vue';
import apiClient from '../utils/apiClient';
import { useComponentStateStore } from './componentState.store';

// 定义所有可用面板的名称
export type PaneName = 'connections' | 'terminal' | 'commandBar' | 'fileManager' | 'editor' | 'statusMonitor' | 'commandHistory' | 'quickCommands' | 'dockerManager' | 'suspendedSshSessions' | 'multiLineCommandInput';

// 定义终端自动执行指令配置接口
export interface TerminalAutoExecConfig {
  defaultCommand?: string; // 通用默认自动执行指令
  connectionCommands?: Record<string, string>; // 连接专属自动执行指令 (key: connectionId)
}

// 定义布局节点接口
export interface LayoutNode {
  id: string; // 唯一 ID
  type: 'pane' | 'container'; // 节点类型：面板或容器
  component?: PaneName; // 如果 type 是 'pane'，指定要渲染的组件
  direction?: 'horizontal' | 'vertical'; // 如果 type 是 'container'，指定分割方向
  children?: LayoutNode[]; // 如果 type 是 'container'，包含子节点数组
  size?: number; // 节点在父容器中的大小比例 (例如 20, 50, 30)
  terminalAutoExec?: TerminalAutoExecConfig; // 终端自动执行指令配置
}

// 本地存储的 Key
const LAYOUT_STORAGE_KEY = 'nexus_terminal_layout_config';
const SIDEBAR_STORAGE_KEY = 'nexus_terminal_sidebar_config'; // 新增侧栏配置 Key

// 生成唯一 ID 的辅助函数
function generateId(): string {
  // 简单实现，实际项目中可能使用更健壮的库如 uuid
  return Math.random().toString(36).substring(2, 15);
}

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

// +++ 递归确保节点及其子节点都有 ID +++
function ensureNodeIds(node: LayoutNode | null): LayoutNode | null {
    if (!node) return null;

    // 确保当前节点有 ID
    if (!node.id) {
        node.id = generateId();
    }

    // 递归处理子节点
    if (node.type === 'container' && node.children) {
        node.children = node.children.map(child => ensureNodeIds(child)).filter(Boolean) as LayoutNode[];
    }

    return node;
}

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

  // 计算当前未在布局或侧栏中使用的面板（可用于配置器中添加）
  const availablePanes: ComputedRef<PaneName[]> = computed(() => {
    const used = usedPanes.value;
    return allPossiblePanes.value.filter(pane => !used.has(pane));
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
  // We still might want debounce if updates happen rapidly outside the configurator (e.g., pane resize)
  let persistLayoutDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedPersistLayout = () => {
      if (persistLayoutDebounceTimer) clearTimeout(persistLayoutDebounceTimer);
      persistLayoutDebounceTimer = setTimeout(async () => { // Make async
          await persistLayoutTree(); // Await the async persist function
      }, 1000);
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
  // 递归查找并更新节点大小
  function findAndUpdateNodeSize(node: LayoutNode | null, nodeId: string, childrenSizes: { index: number; size: number }[]): LayoutNode | null {
    if (!node) return null;
    if (node.id === nodeId && node.type === 'container' && node.children) {
      const updatedChildren = [...node.children];
      childrenSizes.forEach(({ index, size }) => {
        if (updatedChildren[index]) {
          updatedChildren[index] = { ...updatedChildren[index], size: size };
        }
      });
      return { ...node, children: updatedChildren };
    }

    if (node.type === 'container' && node.children) {
      const updatedChildren = node.children.map(child => findAndUpdateNodeSize(child, nodeId, childrenSizes));
      // 检查是否有子节点被更新
      if (updatedChildren.some((child, index) => child !== node.children![index])) {
        return { ...node, children: updatedChildren.filter(Boolean) as LayoutNode[] };
      }
    }
    return node; // 未找到或未更新，返回原节点
  }


  // 更新特定容器节点的子节点大小
  function updateNodeSizes(nodeId: string, childrenSizes: { index: number; size: number }[]) {
    console.log(`[Layout Store] 请求更新节点 ${nodeId} 的子节点大小:`, childrenSizes);
    const originalJson = JSON.stringify(layoutTree.value); // Store original state
    const updatedTree = findAndUpdateNodeSize(layoutTree.value, nodeId, childrenSizes);

    if (updatedTree && JSON.stringify(updatedTree) !== originalJson) { // Compare with original JSON
       layoutTree.value = updatedTree;
       console.log(`[Layout Store] 节点 ${nodeId} 的子节点大小已更新，触发防抖保存。`);
       // --- Use debounced persist for resize ---
       debouncedPersistLayout();
    } else {
       console.log(`[Layout Store] 未找到节点 ${nodeId} 或大小未改变。`);
    }
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
   // ... (existing try/catch logic for backend and localStorage) ...
   // Ensure apiClient calls are awaited if they return promises
   try {
     console.log('[Layout Store] Attempting to save main layout to backend...');
     await apiClient.put('/settings/layout', layoutTree.value); // await
     console.log('[Layout Store] 主布局已成功保存到后端 (sent value):', layoutTree.value);
   } catch (error) {
     console.error('[Layout Store] 保存主布局到后端失败:', error);
   }
   // localStorage is synchronous
   try {
     const layoutToSave = JSON.stringify(layoutTree.value);
     localStorage.setItem(LAYOUT_STORAGE_KEY, layoutToSave);
     console.log('[Layout Store] 主布局已自动保存到 localStorage (saved value):', layoutToSave);
   } catch (error) {
     console.error('[Layout Store] 保存主布局到 localStorage 失败:', error);
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
  // --- 终端多窗格聚焦管理 (方案 A) ---
  const activeTerminalPaneId = ref<string | null>(null);

  // 提取当前布局树中所有终端 pane ID
  function collectTerminalPaneIds(node: LayoutNode | null): string[] {
    if (!node) return [];
    const ids: string[] = [];
    if (node.type === 'pane' && node.component === 'terminal') {
      ids.push(node.id);
    } else if (node.type === 'container' && node.children) {
      for (const child of node.children) {
        ids.push(...collectTerminalPaneIds(child));
      }
    }
    return ids;
  }

  const currentTerminalPaneIds = computed(() => {
    return collectTerminalPaneIds(layoutTree.value);
  });

  // 监听布局树终端节点变化，若当前聚焦 ID 不存在则重置
  watch(currentTerminalPaneIds, (paneIds) => {
    if (paneIds.length === 0) {
      activeTerminalPaneId.value = null;
    } else if (!activeTerminalPaneId.value || !paneIds.includes(activeTerminalPaneId.value)) {
      activeTerminalPaneId.value = paneIds[0];
    }
  }, { immediate: true });

  function setActiveTerminalPaneId(paneId: string | null) {
    activeTerminalPaneId.value = paneId;
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

  // --- 初始化 ---
  // Store 创建时自动初始化布局和侧栏
  initializeLayout();
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
   generateId,
    getAllActivePaneIds: () => getAllActivePaneIds(layoutTree.value),
   toggleLayoutVisibility,
   loadHeaderVisibility,
   toggleHeaderVisibility,
   getSystemDefaultLayout,
   getSystemDefaultSidebarPanes, // <--- 暴露获取默认侧栏配置的方法
   setActiveTerminalPaneId,
   cycleTerminalFocus,
   // Persist actions (可选暴露，如果需要手动触发)
   // persistLayoutTree,
   // persistSidebarPanes,
 };
});
