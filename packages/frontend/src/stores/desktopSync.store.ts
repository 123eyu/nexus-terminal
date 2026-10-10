import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import axios from 'axios';
import { isDesktopApp } from '../utils/platform';
import { useConnectionsStore } from './connections.store';

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
  const lastSyncTime = ref<number>(0);
  const autoSyncOnOpen = ref<boolean>(false);

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
    autoSyncOnOpen?: boolean;
  }): Promise<boolean> => {
    try {
      const res = await axios.post('/api/v1/desktop/sync/config', params);
      if (res.data?.success) {
        vpsUrl.value = params.vpsUrl.trim();
        apiKey.value = params.apiKey.trim();
        if (params.conflictStrategy) conflictStrategy.value = params.conflictStrategy;
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
  const triggerSync = async (): Promise<boolean> => {
    if (!isConfigured.value) {
      syncError.value = '未配置 VPS 域名或 API Key，无法执行同步';
      return false;
    }

    isSyncing.value = true;
    syncError.value = null;
    syncSuccessMessage.value = null;

    try {
      const res = await axios.post('/api/v1/desktop/sync/trigger', {
        vpsUrl: vpsUrl.value,
        apiKey: apiKey.value
      });

      if (res.data?.success) {
        lastSyncTime.value = res.data.lastSyncTime;
        syncStats.value = res.data.stats;
        syncSuccessMessage.value = `同步成功 (推送到云端: ${res.data.stats.pushed}，拉取到本地: ${res.data.stats.pulled})`;

        // 刷新本地连接列表
        try {
          const connectionsStore = useConnectionsStore();
          await connectionsStore.fetchConnections();
        } catch {}

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

  return {
    isDesktop,
    vpsUrl,
    apiKey,
    conflictStrategy,
    lastSyncTime,
    autoSyncOnOpen,
    isTesting,
    testLatency,
    testError,
    isSyncing,
    syncStats,
    syncError,
    syncSuccessMessage,
    isConfigured,
    fetchConfig,
    saveConfig,
    testConnection,
    triggerSync
  };
});
