import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import axios from 'axios';
import { isDesktopApp } from '../utils/platform';
import { useConnectionsStore } from './connections.store';

export type SyncModuleKey = 'appearance' | 'layout' | 'commandHistory' | 'quickCommands' | 'connections';

export interface SyncModuleOption {
  key: SyncModuleKey;
  label: string;
  description: string;
}

export const SYNC_MODULE_OPTIONS: SyncModuleOption[] = [
  { key: 'appearance', label: '外观样式', description: '终端背景、配色主题与界面外观设置' },
  { key: 'layout', label: '工作区布局', description: '面板布局树、侧栏与界面布局设置' },
  { key: 'commandHistory', label: '命令历史', description: '终端历史执行命令记录' },
  { key: 'quickCommands', label: '快捷指令', description: '常用快捷指令及其分类标签' },
  { key: 'connections', label: '连接', description: 'SSH 连接、代理、密钥、分组与常用路径' },
];

const DEFAULT_MODULES: SyncModuleKey[] = ['appearance', 'layout', 'commandHistory', 'quickCommands', 'connections'];

function loadPersistedModules(): SyncModuleKey[] {
  try {
    const raw = localStorage.getItem('nexus_sync_selected_modules');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {}
  return [...DEFAULT_MODULES];
}

export type SyncMode = 'bidirectional' | 'cloud_to_local' | 'local_to_cloud';

function loadPersistedSyncMode(): SyncMode {
  try {
    const raw = localStorage.getItem('nexus_sync_mode');
    if (raw && ['bidirectional', 'cloud_to_local', 'local_to_cloud'].includes(raw)) {
      return raw as SyncMode;
    }
  } catch {}
  return 'bidirectional';
}

export interface DesktopSyncStats {
  pushed: number;
  pulled: number;
  conflictsResolved: number;
}

export const useDesktopSyncStore = defineStore('desktopSync', () => {
  const isDesktop = ref(isDesktopApp());

  const vpsUrl = ref<string>('');
  const apiKey = ref<string>('');
  const conflictStrategy = ref<string>('lww');
  const syncMode = ref<SyncMode>(loadPersistedSyncMode());
  const lastSyncTime = ref<number>(0);
  const autoSyncOnOpen = ref<boolean>(false);
  const selectedModules = ref<SyncModuleKey[]>(loadPersistedModules());

  const setSyncMode = (mode: SyncMode) => {
    syncMode.value = mode;
    try {
      localStorage.setItem('nexus_sync_mode', mode);
    } catch {}
  };

  const setSelectedModules = (modules: SyncModuleKey[]) => {
    selectedModules.value = [...modules];
    try {
      localStorage.setItem('nexus_sync_selected_modules', JSON.stringify(modules));
    } catch {}
  };

  const isTesting = ref<boolean>(false);
  const testLatency = ref<number | null>(null);
  const testError = ref<string | null>(null);

  const isSyncing = ref<boolean>(false);
  const syncStats = ref<DesktopSyncStats | null>(null);
  const syncError = ref<string | null>(null);
  const syncSuccessMessage = ref<string | null>(null);

  /**
   * 是否已配置有效的 VPS 域名与 API Key
   */
  const isConfigured = computed(() => {
    return vpsUrl.value.trim().length > 0 && apiKey.value.trim().length > 0;
  });

  /**
   * 从桌面端本地接口读取同步配置
   */
  const fetchConfig = async (): Promise<void> => {
    if (!isDesktop.value) return;
    try {
      const res = await axios.get('/api/v1/desktop/sync/config');
      if (res.data?.success && res.data.config) {
        vpsUrl.value = res.data.config.vpsUrl || '';
        apiKey.value = res.data.config.apiKey || '';
        conflictStrategy.value = res.data.config.conflictStrategy || 'lww';
        if (res.data.config.syncMode) {
          setSyncMode(res.data.config.syncMode);
        }
        lastSyncTime.value = res.data.config.lastSyncTime || 0;
        autoSyncOnOpen.value = !!res.data.config.autoSyncOnOpen;
      }
    } catch (err: any) {
      console.warn('[DesktopSyncStore] 获取同步配置失败:', err);
    }
  };

  /**
   * 保存同步配置
   */
  const saveConfig = async (params: {
    vpsUrl: string;
    apiKey: string;
    conflictStrategy?: string;
    syncMode?: SyncMode;
    autoSyncOnOpen?: boolean;
  }): Promise<boolean> => {
    try {
      const res = await axios.post('/api/v1/desktop/sync/config', params);
      if (res.data?.success) {
        vpsUrl.value = params.vpsUrl.trim();
        apiKey.value = params.apiKey.trim();
        if (params.conflictStrategy) conflictStrategy.value = params.conflictStrategy;
        if (params.syncMode) setSyncMode(params.syncMode);
        if (typeof params.autoSyncOnOpen === 'boolean') autoSyncOnOpen.value = params.autoSyncOnOpen;
        return true;
      }
      return false;
    } catch (err: any) {
      console.error('[DesktopSyncStore] 保存同步配置失败:', err);
      throw new Error(err.response?.data?.error || err.message);
    }
  };

  /**
   * 测试与远程 VPS 的连通性
   */
  const testConnection = async (targetUrl?: string, targetKey?: string): Promise<{ success: boolean; latencyMs?: number; error?: string | null }> => {
    isTesting.value = true;
    testLatency.value = null;
    testError.value = null;

    try {
      const res = await axios.post('/api/v1/desktop/sync/test', {
        vpsUrl: targetUrl !== undefined ? targetUrl : vpsUrl.value,
        apiKey: targetKey !== undefined ? targetKey : apiKey.value
      });

      if (res.data?.success) {
        testLatency.value = res.data.latencyMs;
        return { success: true, latencyMs: res.data.latencyMs };
      } else {
        const errorMsg = res.data?.error || '连接测试失败';
        testError.value = errorMsg;
        return { success: false, error: errorMsg };
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || err.message || '网络连接超时';
      testError.value = errorMsg;
      return { success: false, error: errorMsg };
    } finally {
      isTesting.value = false;
    }
  };

  /**
   * 触发一次双向增量同步
   */
  const showFirstSyncModal = ref(false);
  const isFirstSync = computed(() => !lastSyncTime.value || lastSyncTime.value === 0);

  /**
   * 触发一次同步 (支持模式: bidirectional, cloud_to_local, local_to_cloud，并支持按模块筛选)
   */
  const triggerSync = async (
    mode?: SyncMode,
    modulesOverride?: SyncModuleKey[]
  ): Promise<boolean> => {
    if (!isConfigured.value) {
      syncError.value = '未配置 VPS 域名或 API Key，无法执行同步';
      return false;
    }

    const activeMode = mode || syncMode.value || 'bidirectional';
    const activeModules = modulesOverride || selectedModules.value;
    if (activeModules.length === 0) {
      syncError.value = '请至少选择一个需要同步的数据模块';
      return false;
    }

    isSyncing.value = true;
    syncError.value = null;
    syncSuccessMessage.value = null;
    showFirstSyncModal.value = false;

    try {
      const res = await axios.post('/api/v1/desktop/sync/trigger', {
        vpsUrl: vpsUrl.value,
        apiKey: apiKey.value,
        mode: activeMode,
        modules: activeModules
      });

      if (res.data?.success) {
        setSyncMode(activeMode);
        lastSyncTime.value = res.data.lastSyncTime;
        syncStats.value = res.data.stats;
        const pushedCount = res.data.stats?.pushed || 0;
        const pulledCount = res.data.stats?.pulled || 0;
        if (pushedCount === 0 && pulledCount === 0) {
          syncSuccessMessage.value = '同步完成：数据已是最新，无待同步变更';
        } else {
          syncSuccessMessage.value = `同步成功 (推送到云端: ${pushedCount}，拉取到本地: ${pulledCount})`;
        }

        // 按需刷新本地数据
        await refreshAllStores(activeModules);

        return true;
      } else {
        syncError.value = res.data?.error || '同步执行失败';
        return false;
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || err.message || '同步请求失败';
      syncError.value = errorMsg;
      return false;
    } finally {
      isSyncing.value = false;
    }
  };

  /**
   * 请求同步：初次同步时弹出方向选择确认，否则直接执行双向合并
   */
  const requestSync = async (forcePrompt: boolean = false): Promise<boolean> => {
    if (forcePrompt) {
      showFirstSyncModal.value = true;
      return false;
    }
    if (!isConfigured.value) return false;
    if (isFirstSync.value) {
      showFirstSyncModal.value = true;
      return false;
    }
    return triggerSync(syncMode.value);
  };

  /**
   * 刷新本地各模块 Store 数据 (供 WS 实时同步完成通知或手动同步复用)
   */
  const refreshAllStores = async (modules?: SyncModuleKey[]) => {
    const active = modules || selectedModules.value;
    try {
      if (active.includes('connections')) {
        const connectionsStore = useConnectionsStore();
        await connectionsStore.fetchConnections();
        const { useTagsStore } = await import('./tags.store');
        const tagsStore = useTagsStore();
        await tagsStore.fetchTags();
        const { useSshKeysStore } = await import('./sshKeys.store');
        const sshKeysStore = useSshKeysStore();
        await sshKeysStore.fetchSshKeys();
        const { useProxiesStore } = await import('./proxies.store');
        const proxiesStore = useProxiesStore();
        await proxiesStore.fetchProxies();
        const { useFavoritePathsStore } = await import('./favoritePaths.store');
        const favoritePathsStore = useFavoritePathsStore();
        await favoritePathsStore.fetchFavoritePaths((_k, d) => d);
      }
      if (active.includes('quickCommands')) {
        const { useQuickCommandsStore } = await import('./quickCommands.store');
        const { useQuickCommandTagsStore } = await import('./quickCommandTags.store');
        const qcStore = useQuickCommandsStore();
        const qcTagsStore = useQuickCommandTagsStore();
        await qcStore.fetchQuickCommands();
        await qcTagsStore.fetchTags();
      }
      if (active.includes('appearance')) {
        const { useAppearanceStore } = await import('./appearance.store');
        const appearanceStore = useAppearanceStore();
        await appearanceStore.loadInitialAppearanceData();
      }
      if (active.includes('layout')) {
        const { useSettingsStore } = await import('./settings.store');
        const settingsStore = useSettingsStore();
        await settingsStore.loadInitialSettings();
      }
      if (active.includes('commandHistory')) {
        const { useCommandHistoryStore } = await import('./commandHistory.store');
        const cmdHistStore = useCommandHistoryStore();
        await cmdHistStore.fetchHistory();
      }
    } catch (e: any) {
      console.warn('[DesktopSyncStore] 刷新本地数据发生警告:', e);
    }
  };

  return {
    isDesktop,
    vpsUrl,
    apiKey,
    conflictStrategy,
    syncMode,
    setSyncMode,
    lastSyncTime,
    autoSyncOnOpen,
    selectedModules,
    setSelectedModules,
    isTesting,
    testLatency,
    testError,
    isSyncing,
    syncStats,
    syncError,
    syncSuccessMessage,
    isConfigured,
    isFirstSync,
    showFirstSyncModal,
    fetchConfig,
    saveConfig,
    testConnection,
    triggerSync,
    requestSync,
    refreshAllStores
  };
});
