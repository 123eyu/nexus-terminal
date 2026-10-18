import { defineStore } from 'pinia';
import { ref, computed, watch, shallowRef, shallowReactive, type Ref, type ComputedRef } from 'vue';
import apiClient from '../utils/apiClient';
import { useComponentStateStore } from './componentState.store';
import { sessions as sessionStateMap, activeSessionId as activeSessionIdRef } from './session/state';

// 定义所有可用面板的名称
export type PaneName = 'connections' | 'terminal' | 'commandBar' | 'fileManager' | 'editor' | 'statusMonitor' | 'commandHistory' | 'quickCommands' | 'dockerManager' | 'suspendedSshSessions' | 'multiLineCommandInput';

// 定义终端自动执行指令配置接口
export interface TerminalAutoExecConfig {
  defaultCommand?: string; // 通用默认自动执行指令
  connectionCommands?: Record<string, string>; // 连接专属自动执行指令 (key: connectionId)
}

// 定义终端窗格专属背景配置接口
export interface TerminalPaneBackgroundConfig {
  mode?: 'inherit' | 'transparent' | 'none' | 'custom'; // inherit: 跟随全局(默认); transparent: 纯透明; none: 经典纯黑/无背景; custom: 专属壁纸
  customImage?: string; // 专属壁纸路径或 URL
  overlayOpacity?: number; // 专属暗色蒙版不透明度 (0-1)
}

// 定义布局节点接口

// 定义布局预设接口
export interface LayoutPreset {
  id: string; // 唯一 ID (如 "preset-default", "preset-single-terminal", 或自定义 uuid)
  name: string; // 预设名称 (如 "默认工作区", "纯粹全屏终端", "双终端分屏")
  isDefault?: boolean; // 是否为全局默认布局
  isSystem?: boolean; // 是否为系统内置预设 (不可删除)
  layoutTree: LayoutNode; // 主布局树
  sidebarPanes: { left: PaneName[]; right: PaneName[] }; // 侧栏配置
  connectionIds?: number[]; // 绑定使用此预设的连接 ID 列表
  createdAt?: number;
  updatedAt?: number;
}

export interface LayoutNode {
  id: string; // 唯一 ID
  type: 'pane' | 'container'; // 节点类型：面板或容器
  component?: PaneName; // 如果 type 是 'pane'，指定要渲染的组件
  direction?: 'horizontal' | 'vertical'; // 如果 type 是 'container'，指定分割方向
  children?: LayoutNode[]; // 如果 type 是 'container'，包含子节点数组
  size?: number; // 节点在父容器中的大小比例 (例如 20, 50, 30)
  terminalAutoExec?: TerminalAutoExecConfig; // 终端自动执行指令配置
  terminalBackground?: TerminalPaneBackgroundConfig; // 终端专属背景样式配置
}

// 本地存储的 Key
const LAYOUT_STORAGE_KEY = 'nexus_terminal_layout_config';
const SIDEBAR_STORAGE_KEY = 'nexus_terminal_sidebar_config';
const LAYOUT_PRESETS_STORAGE_KEY = 'nexus_terminal_layout_presets';
const DEFAULT_PRESET_ID_STORAGE_KEY = 'nexus_terminal_default_preset_id';
const CONNECTION_LAYOUT_MAP_STORAGE_KEY = 'nexus_terminal_connection_layout_map';
 // 新增侧栏配置 Key

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


// 已废弃的历史内置模板 ID 列表（用于自动清洗 localStorage 中的历史残留）
export const LEGACY_TEMPLATE_IDS = new Set([
  'preset-single-terminal',
  'preset-dual-terminals',
  'preset-terminal-files',
]);

// 全局默认预设的固定 ID 与出厂名称
const DEFAULT_PRESET_ID = 'preset-default';
const DEFAULT_PRESET_NAME = '默认布局';

// 深拷贝（切断与主布局树的引用，避免编辑预设时污染当前工作区）
function cloneTree<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 布局结构签名：忽略节点 ID，只比较 类型/组件/方向/尺寸/层级。
 * 用来判断某个预设的布局是否仍是"未编辑过的出厂默认"。
 */
function layoutShapeSignature(node: LayoutNode | null | undefined): string {
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

/**
 * 用"用户当前正在使用的布局"生成全局默认预设。
 *
 * 升级兼容的核心：旧版本没有预设概念，用户攒下来的工作区布局只存在
 * settings.layout / localStorage 里。如果直接塞一个硬编码的内置默认，
 * 用户升级后看到的布局就被我们预设的默认布局覆盖掉了。
 */
function buildDefaultPresetFrom(
  tree: LayoutNode | null | undefined,
  sidebars: { left: PaneName[]; right: PaneName[] } | null | undefined
): LayoutPreset {
  return {
    id: DEFAULT_PRESET_ID,
    name: DEFAULT_PRESET_NAME,
    isDefault: true,
    isSystem: true,
    layoutTree: tree ? cloneTree(tree) : getDefaultLayout(),
    sidebarPanes: sidebars ? cloneTree(sidebars) : getDefaultSidebarPanes(),
    connectionIds: [],
  };
}

// 默认预设名称清洗：不再带星标（历史数据里可能残留 "⭐ 默认布局"）
function sanitizeDefaultPresetName(name: string | undefined): string {
  const cleaned = (name || '').replace(/^[\s★☆⭐]+/, '').trim();
  return cleaned || DEFAULT_PRESET_NAME;
}

/**
 * 把"存储里的预设列表"与系统默认预设对齐：
 * 1. 过滤掉已废弃的内置模板；
 * 2. 缺 preset-default 时用 seedPreset（用户当前布局）补齐，而不是内置默认；
 * 3. 已存在但仍是"未编辑过的出厂种子"时，同样换成 seedPreset ——
 *    修复早前升级时默认布局已经盖掉用户布局的用户。
 */
function reconcilePresets(stored: LayoutPreset[], seedPreset: LayoutPreset): LayoutPreset[] {
  const list = (Array.isArray(stored) ? stored : [])
    .filter(p => p && typeof p.id === 'string' && !LEGACY_TEMPLATE_IDS.has(p.id));

  const idx = list.findIndex(p => p.id === DEFAULT_PRESET_ID);
  if (idx === -1) {
    list.unshift(seedPreset);
    return list;
  }

  const existing = list[idx];
  if (existing.id === DEFAULT_PRESET_ID) {
    existing.name = sanitizeDefaultPresetName(existing.name);
    existing.isSystem = true;
  }

  const builtinSignature = layoutShapeSignature(getDefaultLayout());
  const isPristineSeed =
    existing.name === DEFAULT_PRESET_NAME &&
    !!existing.layoutTree &&
    layoutShapeSignature(existing.layoutTree) === builtinSignature;
  const userHasOwnLayout = layoutShapeSignature(seedPreset.layoutTree) !== builtinSignature;

  // 只有"预设还是出厂种子 + 用户现有布局确实是自己攒的"才接管，
  // 避免覆盖用户手动恢复成出厂默认之后的状态。
  if (isPristineSeed && userHasOwnLayout) {
    list[idx] = {
      ...existing,
      layoutTree: cloneTree(seedPreset.layoutTree),
      sidebarPanes: cloneTree(seedPreset.sidebarPanes),
      updatedAt: Date.now(),
    };
  }

  return list;
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
export function getTerminalPaneIdsInLayout(node: LayoutNode | null): string[] {
  const ids: string[] = [];
  if (!node) return ids;

  function traverse(currentNode: LayoutNode) {
    if (currentNode.type === 'pane' && currentNode.component === 'terminal' && currentNode.id) {
      ids.push(currentNode.id);
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

  /** 找出节点在树里的索引路径（跨"主树 / 会话树 / 预设树"定位同一结构位置） */
  function findNodePath(node: LayoutNode | null, id: string, path: number[] = []): number[] | null {
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
  function applySizesAtPath(node: LayoutNode | null, path: number[], sizes: { index: number; size: number }[]): LayoutNode | null {
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
      if (layoutTree.value) {
        const syncedMainTree = applySizesAtPath(layoutTree.value, path, childrenSizes);
        if (syncedMainTree) {
          layoutTree.value = syncedMainTree;
          debouncedPersistLayout();
        }
      }
    } else {
      layoutTree.value = nextTree;
      debouncedPersistLayout();
    }
    console.log(`[Layout Store] 节点 ${nodeId} 的尺寸已更新（${activeTree ? '会话树 + 预设' : '主布局树'}）`);
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

  function getInitialConnectionLayoutMap(): Record<number, string> {
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
  const connectionLayoutMap = ref<Record<number, string>>(getInitialConnectionLayoutMap()); // connectionId -> presetId
  const activeEditingPresetId = ref<string>('preset-default'); // 当前正在配置器中编辑的预设 ID

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
    sessionPaneOrderMap.set(sessionId, collectTerminalPaneIds(tree));
  }

  /** 取某会话终端 pane 的先序顺序（跨刷新稳定） */
  function getSessionTerminalPaneOrder(sessionId: string): string[] {
    return sessionPaneOrderMap.get(sessionId) ?? [];
  }


  // 深度克隆节点并赋以全新唯一 ID
  function cloneLayoutTreeWithNewIds(node: LayoutNode): LayoutNode {
    const cloned: LayoutNode = {
      ...node,
      id: generateId(),
    };
    if (node.children && Array.isArray(node.children)) {
      cloned.children = node.children.map(child => cloneLayoutTreeWithNewIds(child));
    }
    return cloned;
  }

  /**
   * 克隆并赋"结构序号"ID：第 0 个终端叫 terminal-0、第 1 个叫 terminal-1……
   *
   * 重要：paneId 会被发给后端当作 `paneStreams` 的 key。以前用随机 ID，
   * 每次刷新都换一套 key，后端找不到旧通道 → 重新开 shell → 每个副终端
   * 都重新打印一遍登录 banner。改成序号后，刷新时能命中同一个通道并复用。
   */
  function cloneLayoutTreeWithStableIds(node: LayoutNode): LayoutNode {
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
  function reconcileTreePreservingIds(oldNode: LayoutNode | null, newNode: LayoutNode): LayoutNode {
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
  }

  // 持久化预设
  async function persistPresets() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LAYOUT_PRESETS_STORAGE_KEY, JSON.stringify(layoutPresets.value));
        localStorage.setItem(DEFAULT_PRESET_ID_STORAGE_KEY, defaultPresetId.value);
        localStorage.setItem(CONNECTION_LAYOUT_MAP_STORAGE_KEY, JSON.stringify(connectionLayoutMap.value));
      }

      // 同步到后端
      await apiClient.put('/settings/layout-presets', {
        presets: layoutPresets.value,
        defaultPresetId: defaultPresetId.value,
        connectionLayoutMap: connectionLayoutMap.value,
      }).catch(err => {
        // 后端若暂无路由则静默降级到 LocalStorage
      });
    } catch (err) {
      console.error('[Layout Store] 保存预设配置失败:', err);
    }
  }

  // 根据连接 ID 获取对应预设
  function getPresetForConnection(connectionId?: number | string | null): LayoutPreset {
    const numId = Number(connectionId);
    if (!isNaN(numId) && connectionLayoutMap.value[numId]) {
      const targetPresetId = connectionLayoutMap.value[numId];
      const found = layoutPresets.value.find(p => p.id === targetPresetId);
      if (found) return found;
    }
    if (!isNaN(numId)) {
      const matched = layoutPresets.value.find(p => p.connectionIds?.includes(numId));
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
    for (const preset of layoutPresets.value) {
      if (preset.id === presetId) {
        preset.connectionIds = Array.from(new Set([...(preset.connectionIds || []), ...connIds]));
      } else if (preset.connectionIds) {
        preset.connectionIds = preset.connectionIds.filter(id => !targetIds.has(id));
      }
    }
    for (const id of connIds) {
      connectionLayoutMap.value[id] = presetId;
    }
    persistPresets();
  }

  // 移除某个连接的预设绑定 (恢复使用默认预设)
  function unbindConnection(connId: number) {
    delete connectionLayoutMap.value[connId];
    for (const preset of layoutPresets.value) {
      if (preset.connectionIds) {
        preset.connectionIds = preset.connectionIds.filter(id => id !== connId);
      }
    }
    persistPresets();
  }

  // 创建/另存为新预设
  function createPreset(name: string, tree: LayoutNode, sidebars: { left: PaneName[]; right: PaneName[] }, connIds: number[] = []): LayoutPreset {
    const newPreset: LayoutPreset = {
      id: `preset-user-${generateId()}`,
      name: name.trim() || '自定义布局',
      isDefault: false,
      isSystem: false,
      layoutTree: JSON.parse(JSON.stringify(tree)),
      sidebarPanes: JSON.parse(JSON.stringify(sidebars)),
      connectionIds: connIds,
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
      });
    }
    layoutPresets.value = layoutPresets.value.filter(p => p.id !== presetId);
    if (activeEditingPresetId.value === presetId) {
      activeEditingPresetId.value = defaultPresetId.value;
    }
    persistPresets();
    return true;
  }

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

  /**
   * 当前"实际渲染"的布局树。
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
    return collectTerminalPaneIds(activeLayoutTreeOverride.value ?? layoutTree.value);
  });

  // 监听布局树终端节点变化，若当前聚焦 ID 不存在则重置
  watch(currentTerminalPaneIds, (paneIds) => {
    if (paneIds.length === 0) {
      activeTerminalPaneId.value = null;
    } else if (!activeTerminalPaneId.value || !paneIds.includes(activeTerminalPaneId.value)) {
      activeTerminalPaneId.value = paneIds[0];
    }
  }, { immediate: true });

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
    const ids = collectTerminalPaneIds(tree ?? layoutTree.value);

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
