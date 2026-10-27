// packages/frontend/src/stores/session/state.ts

import { ref, shallowRef } from 'vue';
import type { SessionState } from './types';
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

// --- SSH Suspend Mode State ---
export const suspendedSshSessions = ref<SuspendedSshSession[]>([]);
export const isLoadingSuspendedSessions = ref<boolean>(false);
/**
 * 是否已经成功拉过一次挂起列表。
 *
 * 有它之后，「加载中」只属于真正的首屏：3 秒轮询、ws 重连、面板每次打开
 * 都会重新请求一次，如果每次都亮加载态，面板就会一遍遍从列表闪成转圈再闪回来。
 * 列表是空的也算拉过一次 —— 空态是正确结果，不该每次打开都重走一遍过渡。
 */
export const suspendedSshSessionsLoaded = ref<boolean>(false);