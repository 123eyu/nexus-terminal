import { ref, type Ref } from 'vue';
import apiClient from '../../utils/apiClient';
import { useConnectionsStore } from '../connections.store';
import { sessions as sessionStateMap } from '../session/state';
import type { LayoutNode, LayoutPreset, PaneName } from '../../types/layout';
import {
  DEFAULT_PRESET_ID,
  LEGACY_TEMPLATE_IDS,
  buildPresetsSignature,
} from '../../utils/layoutPreset';
import { randomId } from '../../utils/layoutTree';

const LAYOUT_PRESETS_STORAGE_KEY = 'nexus_terminal_layout_presets';
const DEFAULT_PRESET_ID_STORAGE_KEY = 'nexus_terminal_default_preset_id';
const CONNECTION_LAYOUT_MAP_STORAGE_KEY = 'nexus_terminal_connection_layout_map';

interface SidebarPanes {
  left: PaneName[];
  right: PaneName[];
}

export interface LayoutPresetsDeps {
  layoutTree: Ref<LayoutNode | null>;
  sidebarPanes: Ref<SidebarPanes>;
  /** 空闲工作区对齐用（预设 = 全局默认时必须回写 settings.layout） */
  updateLayoutTree: (tree: LayoutNode | null) => Promise<void>;
  /** 用"用户当前布局"构造默认预设（自动带出厂布局兜底） */
  buildSeedPreset: (
    tree: LayoutNode | null | undefined,
    sidebars: SidebarPanes | null | undefined
  ) => LayoutPreset;
  /** 存储预设与出厂预设对齐（注入，避免本文件运行时依赖 layoutTree） */
  reconcileStoredPresets: (stored: LayoutPreset[], seedPreset: LayoutPreset) => LayoutPreset[];
  getSystemDefaultPresets: () => LayoutPreset[];
}

/**
 * 布局预设与连接绑定（从 layout.store 拆出）。
 *
 * 为什么单独一个文件：
 * - 这块决定"跨端同步是不是单向的"：每次 persist 都会顶后端的 updated_at，
 *   另一端的推送在 LWW 里就永远比不过。所以"内容没变就不 PUT"这条判据必须显眼。
 * - 升级兼容也在这里：老用户没有预设数据时，默认预设必须取"他当时正在用的布局"，
 *   绝不能拿内置默认盖掉。
 *
 * 与 sessionTrees 的双向关系用一个注册器解开：
 * sessionTrees 需要 getPresetForConnection（构造时注入），
 * 本模块需要 refreshSessionLayoutTree（运行时注册，初始是 no-op）。
 */
export function useLayoutPresets(deps: LayoutPresetsDeps) {
  const { layoutTree, sidebarPanes, updateLayoutTree } = deps;

  // 会话树刷新器：由 store 在 sessionTrees 创建后注册（避免双向 import / TDZ）
  let refreshSessionTree: (sessionId: string, connectionId?: number | string | null) => unknown = () => {};
  function registerSessionTreeRefresher(
    fn: (sessionId: string, connectionId?: number | string | null) => unknown
  ) {
    refreshSessionTree = fn;
  }

  /**
   * 初始预设（同步，供首屏渲染与会话树创建立刻使用）。
   *
   * 关键：localStorage 里没有预设数据时，默认预设直接继承"用户当前正在使用的布局"
   * （layoutTree / sidebarPanes 的初始值也是同步从 localStorage 读出来的），
   * 而不是内置默认 —— 否则旧用户升级后，原有布局会被我们预设的默认布局覆盖。
   */
  function getInitialPresets(): LayoutPreset[] {
    const seedPreset = deps.buildSeedPreset(layoutTree.value, sidebarPanes.value);
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(LAYOUT_PRESETS_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return deps.reconcileStoredPresets(parsed, seedPreset);
          }
        }
      } catch {
        /* 本地缓存损坏时退回种子预设 */
      }
    }
    return [seedPreset];
  }

  function getInitialDefaultPresetId(): string {
    if (typeof localStorage !== 'undefined') {
      try {
        const saved = localStorage.getItem(DEFAULT_PRESET_ID_STORAGE_KEY);
        if (saved && !LEGACY_TEMPLATE_IDS.has(saved)) return saved;
      } catch {
        /* ignore */
      }
    }
    return DEFAULT_PRESET_ID;
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
      } catch {
        /* ignore */
      }
    }
    return {};
  }

  const layoutPresets = ref<LayoutPreset[]>(getInitialPresets());
  const defaultPresetId = ref<string>(getInitialDefaultPresetId());
  /** connectionId | connectionUuid -> presetId */
  const connectionLayoutMap = ref<Record<string, string>>(getInitialConnectionLayoutMap());
  /** 当前正在配置器中编辑的预设 ID */
  const activeEditingPresetId = ref<string>(DEFAULT_PRESET_ID);

  // 上一次成功同步给后端的内容签名：内容没变就不再 PUT。
  // 否则每次打开页面（initializePresetsAsync 收尾会 persist 一次）都会把后端的
  // updated_at 顶到最新，另一端的推送在 LWW 里永远比不过，跨端同步就成了单向的。
  let lastPersistedPresetsSignature: string | null = null;

  // 初始化预设（layoutReady：主布局加载完成信号）
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
    const seedPreset = deps.buildSeedPreset(layoutTree.value, sidebarPanes.value);

    let remote: {
      presets?: LayoutPreset[];
      defaultPresetId?: string;
      connectionLayoutMap?: Record<string, string>;
    } | null = null;
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
        : typeof localStorage !== 'undefined'
          ? localStorage.getItem(LAYOUT_PRESETS_STORAGE_KEY)
          : null;
      const rawDefaultId =
        remote?.defaultPresetId ||
        (typeof localStorage !== 'undefined'
          ? localStorage.getItem(DEFAULT_PRESET_ID_STORAGE_KEY)
          : null);
      const rawMap = remote?.connectionLayoutMap
        ? JSON.stringify(remote.connectionLayoutMap)
        : typeof localStorage !== 'undefined'
          ? localStorage.getItem(CONNECTION_LAYOUT_MAP_STORAGE_KEY)
          : null;

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
          layoutPresets.value = deps.reconcileStoredPresets(parsed, seedPreset);
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

    if (!layoutPresets.value.some((p) => p.id === defaultPresetId.value)) {
      defaultPresetId.value = layoutPresets.value[0]?.id || DEFAULT_PRESET_ID;
    }

    layoutPresets.value.forEach((p) => {
      p.isDefault = p.id === defaultPresetId.value;
    });

    // 空闲工作区（没有打开任何会话）渲染的是主布局 settings.layout，
    // 它必须等于"全局默认预设"。否则：编辑过某个按连接绑定的预设后，
    // 关掉会话会看到那个预设的布局，刷新也还是它（数据已经写进 settings.layout 了）。
    // 这里做一次对齐，顺带把历史上被写脏的老数据自愈回来。
    //
    // ⚠️ 只对齐 layoutTree，不要动 sidebarPanes：
    // 侧栏是用户随时用左侧图标开关的"实时配置"（settings.sidebar），
    // 预设里的 sidebarPanes 只是它的快照，强行回写会把用户刚加进去的面板抹掉。
    const idlePreset = layoutPresets.value.find((p) => p.id === defaultPresetId.value);
    if (idlePreset) {
      try {
        if (
          idlePreset.layoutTree &&
          JSON.stringify(idlePreset.layoutTree) !== JSON.stringify(layoutTree.value)
        ) {
          await updateLayoutTree(JSON.parse(JSON.stringify(idlePreset.layoutTree)));
        }
      } catch (idleSyncErr) {
        console.warn('[Layout Store] 对齐空闲工作区布局失败:', idleSyncErr);
      }
    }
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

      const seedPreset = deps.buildSeedPreset(layoutTree.value, sidebarPanes.value);
      layoutPresets.value = deps.reconcileStoredPresets(data.presets, seedPreset);
      defaultPresetId.value = remoteDefaultId;
      if (!layoutPresets.value.some((p) => p.id === defaultPresetId.value)) {
        defaultPresetId.value = layoutPresets.value[0]?.id || DEFAULT_PRESET_ID;
      }
      layoutPresets.value.forEach((p) => {
        p.isDefault = p.id === defaultPresetId.value;
      });

      connectionLayoutMap.value = { ...remoteMap };

      // 本地此刻与后端一致，记下签名避免下一次 persist 无谓回写
      lastPersistedPresetsSignature = buildPresetsSignature(
        layoutPresets.value,
        defaultPresetId.value,
        connectionLayoutMap.value
      );

      if (!layoutPresets.value.some((p) => p.id === activeEditingPresetId.value)) {
        activeEditingPresetId.value = defaultPresetId.value;
      }

      // 只落本地缓存，不回写后端
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(LAYOUT_PRESETS_STORAGE_KEY, JSON.stringify(layoutPresets.value));
          localStorage.setItem(DEFAULT_PRESET_ID_STORAGE_KEY, defaultPresetId.value);
          localStorage.setItem(
            CONNECTION_LAYOUT_MAP_STORAGE_KEY,
            JSON.stringify(connectionLayoutMap.value)
          );
        }
      } catch {
        /* localStorage 不可用时忽略 */
      }

      // 已打开的会话：预设换了、或它用的预设布局变了，才重建（复用旧 paneId，终端不会被销毁）
      try {
        for (const [sessionId, session] of sessionStateMap.value) {
          const preset = getPresetForConnection(session.connectionId);
          const previous = previousSessionLayout.get(sessionId);
          const changed =
            !previous ||
            previous.presetId !== preset.id ||
            previous.treeSignature !== JSON.stringify(preset.layoutTree);
          if (changed) {
            refreshSessionTree(sessionId, session.connectionId);
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
    const signature = buildPresetsSignature(
      layoutPresets.value,
      defaultPresetId.value,
      connectionLayoutMap.value
    );
    const unchangedSinceLastPush = signature === lastPersistedPresetsSignature;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LAYOUT_PRESETS_STORAGE_KEY, JSON.stringify(layoutPresets.value));
        localStorage.setItem(DEFAULT_PRESET_ID_STORAGE_KEY, defaultPresetId.value);
        localStorage.setItem(
          CONNECTION_LAYOUT_MAP_STORAGE_KEY,
          JSON.stringify(connectionLayoutMap.value)
        );
      }

      if (unchangedSinceLastPush) return;

      // 同步到后端
      await apiClient
        .put('/settings/layout-presets', {
          presets: layoutPresets.value,
          defaultPresetId: defaultPresetId.value,
          connectionLayoutMap: connectionLayoutMap.value,
        })
        .then(() => {
          lastPersistedPresetsSignature = signature;
        })
        .catch(() => {
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
      const byUuid = list.find((c) => !!c.uuid && c.uuid === raw);
      if (byUuid) return byUuid;
      if (isNumericConnectionRef(raw)) {
        return list.find((c) => String(c.id) === raw) ?? null;
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
        const found = layoutPresets.value.find((p) => p.id === mappedPresetId);
        if (found) return found;
      }
      const matchedByUuid = layoutPresets.value.find((p) => p.connectionUuids?.includes(uuid));
      if (matchedByUuid) return matchedByUuid;
    }

    // 2) 老数据兼容：只用"还没升级成 uuid 绑定"的预设做本地 id 匹配。
    //    否则升级后会被另一台设备留下的旧 id 抢走正确的 uuid 绑定。
    if (!isNaN(numId)) {
      const legacyPresetId = connectionLayoutMap.value[numId];
      if (legacyPresetId) {
        const found = layoutPresets.value.find(
          (p) => p.id === legacyPresetId && !p.connectionUuids?.length
        );
        if (found) return found;
      }
      const matched = layoutPresets.value.find(
        (p) => !p.connectionUuids?.length && p.connectionIds?.includes(numId)
      );
      if (matched) return matched;
    }

    const defaultP = layoutPresets.value.find((p) => p.id === defaultPresetId.value);
    if (defaultP) return defaultP;
    return layoutPresets.value[0] || deps.getSystemDefaultPresets()[0];
  }

  /** 某连接（会话）当前是否在用指定预设 */
  function isConnectionUsingPreset(
    connectionId: number | string | null | undefined,
    presetId: string
  ): boolean {
    return getPresetForConnection(connectionId).id === presetId;
  }

  // 设为默认预设
  function setDefaultPreset(presetId: string) {
    defaultPresetId.value = presetId;
    layoutPresets.value.forEach((p) => {
      p.isDefault = p.id === presetId;
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

    const targetPreset = layoutPresets.value.find((p) => p.id === presetId);
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
          preset.connectionIds = preset.connectionIds.filter((id) => !targetIds.has(id));
        }
        if (preset.connectionUuids?.length) {
          preset.connectionUuids = preset.connectionUuids.filter((uuid) => !targetUuids.has(uuid));
        }
      }
    }

    // 先清掉本预设被取消勾选的连接，避免映射表残留把它们继续指过来
    for (const id of prevIds) {
      if (targetIds.has(id)) continue;
      const uuid = resolveConnectionUuid(id);
      if (!uuid || !targetUuids.has(uuid)) {
        if (connectionLayoutMap.value[id] === presetId) delete connectionLayoutMap.value[id];
        if (uuid && connectionLayoutMap.value[uuid] === presetId)
          delete connectionLayoutMap.value[uuid];
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
        preset.connectionIds = preset.connectionIds.filter((id) => id !== connId);
      }
      if (uuid && preset.connectionUuids) {
        preset.connectionUuids = preset.connectionUuids.filter((item) => item !== uuid);
      }
    }
    persistPresets();
  }

  // 创建/另存为新预设
  function createPreset(
    name: string,
    tree: LayoutNode,
    sidebars: SidebarPanes,
    connIds: number[] = []
  ): LayoutPreset {
    const boundUuids = connIds
      .map((id) => resolveConnectionUuid(id))
      .filter((uuid): uuid is string => !!uuid);
    const newPreset: LayoutPreset = {
      id: `preset-user-${randomId()}`,
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
    const idx = layoutPresets.value.findIndex((p) => p.id === presetId);
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
    const target = layoutPresets.value.find((p) => p.id === presetId);
    if (!target || target.isSystem) return false;
    if (defaultPresetId.value === presetId) {
      defaultPresetId.value = DEFAULT_PRESET_ID;
      const sysDef = layoutPresets.value.find((p) => p.id === DEFAULT_PRESET_ID);
      if (sysDef) sysDef.isDefault = true;
    }
    if (target.connectionIds) {
      target.connectionIds.forEach((id) => {
        delete connectionLayoutMap.value[id];
        const uuid = resolveConnectionUuid(id);
        if (uuid) delete connectionLayoutMap.value[uuid];
      });
    }
    if (target.connectionUuids) {
      target.connectionUuids.forEach((uuid) => {
        delete connectionLayoutMap.value[uuid];
      });
    }
    layoutPresets.value = layoutPresets.value.filter((p) => p.id !== presetId);
    if (activeEditingPresetId.value === presetId) {
      activeEditingPresetId.value = defaultPresetId.value;
    }
    persistPresets();
    return true;
  }

  return {
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
  };
}
