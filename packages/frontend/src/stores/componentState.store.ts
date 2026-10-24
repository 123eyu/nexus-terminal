import { defineStore } from 'pinia';
import { ref } from 'vue';
import apiClient from '../utils/apiClient';

const LS_COMPONENT_STATES_KEY = 'nexus_component_instance_states';

export const useComponentStateStore = defineStore('componentState', () => {
  // 状态字典：存储如 "qc_view_mode:desktop:pane-1": "grid"
  const states = ref<Record<string, any>>({});
  const isLoaded = ref(false);
  /**
   * 版本号：每次「从后端整体重载」都会 +1。
   *
   * 已挂载的组件（文件管理器 / 快捷指令 / 目录树…）都是把状态读进本地 ref 之后就不再管了，
   * 所以另一台设备（比如桌面客户端）改了视图模式，即使数据已经被同步到本机数据库，
   * 页面上的组件也不会重读 —— 表现就是「另一边改了，这边没反应，得刷新整页」。
   * 让这些组件 watch 这个版本号即可无感跟进。
   */
  const revision = ref(0);

  // 初始化：先从 localStorage 加载缓存，然后从后端拉取最新数据
  const initialize = async () => {
    try {
      if (typeof localStorage !== 'undefined') {
        const localCached = localStorage.getItem(LS_COMPONENT_STATES_KEY);
        if (localCached) {
          try {
            states.value = { ...JSON.parse(localCached), ...states.value };
          } catch {
            // ignore
          }
        }
      }

      const response = await apiClient.get<Record<string, any>>('/settings/component-instance-states');
      if (response && response.data && typeof response.data === 'object') {
        states.value = { ...states.value, ...response.data };
        syncToLocalStorage();
      }
    } catch (error) {
      console.warn('[ComponentStateStore] 获取后端组件状态失败，使用本地缓存:', error);
    } finally {
      isLoaded.value = true;
      revision.value += 1;
    }
  };

  /**
   * 从后端整体重载（供同步完成/被其他设备改动时调用）
   * 与 initialize 的区别：不再拿 localStorage 兜底合并 —— 那边可能是旧值，
   * 合并回去等于把刚同步下来的改动又盖掉。
   */
  const reloadFromServer = async () => {
    try {
      const response = await apiClient.get<Record<string, any>>('/settings/component-instance-states');
      if (response && response.data && typeof response.data === 'object') {
        const next = response.data;
        // 内容没变就别动 revision：同步失效信号很密集（每条命令历史都会广播一次），
        // 每次都 +1 会让文件管理器/快捷指令白白重跑一遍 watcher，白屏抖动。
        if (JSON.stringify(next) === JSON.stringify(states.value)) return;
        states.value = { ...next };
        syncToLocalStorage();
        revision.value += 1;
      }
    } catch (error) {
      console.warn('[ComponentStateStore] 重新拉取组件状态失败:', error);
    }
  };

  const syncToLocalStorage = () => {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(LS_COMPONENT_STATES_KEY, JSON.stringify(states.value));
      } catch (e) {
        console.warn('[ComponentStateStore] 无法同步到 localStorage:', e);
      }
    }
  };

  /**
   * 获取组件状态项
   */
  const getState = <T = any>(key: string, defaultValue?: T): T => {
    if (key in states.value && states.value[key] !== undefined && states.value[key] !== null) {
      return states.value[key] as T;
    }
    // 降级尝试 localStorage
    if (typeof localStorage !== 'undefined') {
      const fallbackLocal = localStorage.getItem(`comp_state:${key}`);
      if (fallbackLocal !== null) {
        try {
          return JSON.parse(fallbackLocal) as T;
        } catch {
          return fallbackLocal as unknown as T;
        }
      }
    }
    return defaultValue as T;
  };

  // 防抖后端保存队列
  let pendingUpdates: Record<string, any> = {};
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const flushUpdatesToBackend = async () => {
    if (Object.keys(pendingUpdates).length === 0) return;
    const toSend = { ...pendingUpdates };
    pendingUpdates = {};
    try {
      await apiClient.put('/settings/component-instance-states', toSend);
    } catch (error) {
      console.error('[ComponentStateStore] 同步组件状态至后端失败:', error);
    }
  };

  /**
   * 设置组件状态项（本地即时响应 + 异步持久化至后端）
   */
  const setState = (key: string, value: any) => {
    states.value[key] = value;
    syncToLocalStorage();
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`comp_state:${key}`, typeof value === 'string' ? value : JSON.stringify(value));
      } catch {}
    }

    pendingUpdates[key] = value;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushUpdatesToBackend, 300);
  };

  /**
   * 移除指定组件状态项
   */
  const removeState = async (key: string) => {
    delete states.value[key];
    syncToLocalStorage();
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`comp_state:${key}`);
    }

    pendingUpdates[key] = null; // null 通知后端删除
    if (saveTimer) clearTimeout(saveTimer);
    await flushUpdatesToBackend();
  };

  /**
   * 清理孤立/不存在的组件实例存储项
   * @param activeInstanceIds 当前存活的 instanceId 集合
   * @param prefixes 需要受检的前缀列表，如 ['qc_view_mode', 'tree_show_files']
   */
  const cleanupOrphanedStates = async (activeInstanceIds: Set<string>, prefixes: string[] = ['qc_view_mode', 'tree_show_files', 'fm_view_mode', 'fm_col_order']) => {
    const keysToDelete: string[] = [];

    for (const key of Object.keys(states.value)) {
      // 匹配 key 结构：prefix:platform:instanceId
      for (const prefix of prefixes) {
        if (key.startsWith(`${prefix}:`)) {
          const parts = key.split(':');
          if (parts.length >= 3) {
            const instanceId = parts.slice(2).join(':'); // 还原 instanceId
            // 白名单内置实例不清理：如 modal、default、sidebar-left、sidebar-right
            const isPermanent = ['modal', 'default', 'sidebar-left', 'sidebar-right'].includes(instanceId);
            if (!isPermanent && !activeInstanceIds.has(instanceId)) {
              keysToDelete.push(key);
            }
          }
          break;
        }
      }
    }

    if (keysToDelete.length > 0) {
      console.log('[ComponentStateStore] 检测到不存在的组件实例，正在清理孤立项:', keysToDelete);
      for (const k of keysToDelete) {
        delete states.value[k];
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(`comp_state:${k}`);
        }
      }
      syncToLocalStorage();
      try {
        await apiClient.post('/settings/component-instance-states/cleanup', { keysToDelete });
        console.log('[ComponentStateStore] 成功从后端移除孤立组件存储项');
      } catch (err) {
        console.error('[ComponentStateStore] 调用后端清理接口失败:', err);
      }
    }
  };

  return {
    states,
    isLoaded,
    revision,
    initialize,
    reloadFromServer,
    getState,
    setState,
    removeState,
    cleanupOrphanedStates,
  };
});
