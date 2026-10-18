// packages/frontend/src/stores/session/state.ts

import { ref, shallowRef } from 'vue';
import type { SessionState } from './types';
// 修正导入路径
import type { ConnectionInfo } from '../connections.store'; // 路径: packages/frontend/src/stores/connections.store.ts
import type { SuspendedSshSession } from '../../types/ssh-suspend.types'; // 路径: packages/frontend/src/types/ssh-suspend.types.ts

// 使用 shallowRef 避免深度响应性问题，保留管理器实例内部的响应性
export const sessions = shallowRef<Map<string, SessionState>>(new Map());
export const activeSessionId = ref<string | null>(null);

/**
 * 用户最后一次"手动切换标签"的时间戳。
 *
 * 云端同步恢复是异步的（先建会话、再逐个 resume、最后还要"收尾对齐"），
 * 恢复过程中用户已经点去别的标签时，恢复流程不该再把他拽回快照里记录的那个。
 * 任何非 silent 的 activateSession 调用都会刷新这个时间戳。
 */
export const lastUserSwitchAt = ref(0);
const initialSessionOrder: string[] = (() => {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem('sessionOrder');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {
        // ignore JSON parse error
      }
    }
  }
  return [];
})();
export const sessionOrder = ref<string[]>(initialSessionOrder);

// --- RDP Modal State ---
export const isRdpModalOpen = ref(false);
export const rdpConnectionInfo = ref<ConnectionInfo | null>(null);

// --- VNC Modal State ---
export const isVncModalOpen = ref(false);
export const vncConnectionInfo = ref<ConnectionInfo | null>(null);

// --- SSH Suspend Mode State ---
export const suspendedSshSessions = ref<SuspendedSshSession[]>([]);
export const isLoadingSuspendedSessions = ref<boolean>(false);