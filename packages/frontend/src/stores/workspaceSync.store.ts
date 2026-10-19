import { defineStore, storeToRefs } from 'pinia';
import { ref, computed, nextTick, shallowRef, watch } from 'vue';
import { v4 as uuidv4 } from 'uuid';
import apiClient from '../utils/apiClient';
import { isDesktopApp } from '../utils/platform';
import { useSessionStore } from './session.store';
import { lastUserSwitchAt } from './session/state';
import { useFileEditorStore, type FileTab } from './fileEditor.store';
import { useConnectionsStore } from './connections.store';
import { useUiNotificationsStore } from './uiNotifications.store';
import { useTerminalHighlightStore } from './terminal-highlight.store';
import { useLayoutStore, type LayoutNode, type PaneName } from './layout.store';
import { workspaceEmitter } from '../composables/workspaceEvents';
import { filterRemovedSessions, resolveSnapshotSessionId } from '../utils/workspaceSnapshot';
import {
  isValidFileManagerSyncPath,
  type SyncedFileManagerInfo,
  type SyncedFileManagerInstanceState,
  type SyncedFileTabInfo,
  type SyncedMultiLineCommandInfo,
  type SyncedSessionInfo,
  type WorkspaceSnapshot,
} from './workspaceSync/types';
import { collectWorkspaceSnapshot } from './workspaceSync/collectSnapshot';
import { logSync, logSyncError, logSyncWarn } from './workspaceSync/log';
import { restoreEditorsFromSnapshot } from './workspaceSync/restoreEditors';
import { restoreFileManagersFromSnapshot } from './workspaceSync/restoreFileManagers';

// 快照类型是所有快照读写方的公共契约，这里重新导出，既有 import 路径保持不变。
export type {
  SyncedFileManagerInfo,
  SyncedFileManagerInstanceState,
  SyncedFileTabInfo,
  SyncedMultiLineCommandInfo,
  SyncedSessionInfo,
  WorkspaceSnapshot,
} from './workspaceSync/types';
import {
  getLocalStorageSafe,
  markSessionRemovedPendingSync as markSessionRemovedPendingSyncIn,
  readPendingRemovedSessions as readPendingRemovedSessionsIn,
  readSessionIdAliases as readSessionIdAliasesIn,
  recordSessionIdAlias as recordSessionIdAliasIn,
  removePendingRemovedSessions as removePendingRemovedSessionsIn,
} from '../utils/pendingRemoval';

const SYNC_ENABLED_STORAGE_KEY = 'nexus_workspace_sync_enabled';
const CLIENT_ID_SESSION_KEY = 'nexus_workspace_sync_client_id';

/**
 * "已关闭、但可能还没同步到云端" 的会话清单。
 *
 * 关掉一个会话后立刻刷新页面时，closeSession 发出的两个请求
 * （DELETE /workspace-sync/sessions/:id、POST /workspace-sync/save）都还在路上，
 * 页面的下一次 GET 会先读到"还带着这个会话"的旧快照 → 已关闭的会话又活过来了。
 * 所以关闭的那一刻就同步写一份清单到 localStorage，加载快照时先把这些会话剔除掉。
 *
 * 具体实现（含存储 key、上限、别名表）在 utils/pendingRemoval.ts，那里可被单测直接覆盖。
 */

// --- 「已关闭待清理」清单与 ID 别名表（实现见 utils/pendingRemoval.ts）---
const storage = () => getLocalStorageSafe();

const readPendingRemovedSessions = (): string[] => readPendingRemovedSessionsIn(storage());

/** 记录一个"已关闭待清理"的会话（同步写入，页面立刻刷新也不会丢） */
export const markSessionRemovedPendingSync = (sessionId: string): void => {
  markSessionRemovedPendingSyncIn(sessionId, storage(), resolveSnapshotSessionId);
};

const readSessionIdAliases = (): Record<string, string> => readSessionIdAliasesIn(storage());

const recordSessionIdAlias = (localId: string, snapshotId: string): void => {
  recordSessionIdAliasIn(localId, snapshotId, storage());
};

/** 保存成功后，移除"本次保存之前就已记录"的条目（保存途中新关掉的会话不会被误清） */
const removePendingRemovedSessions = (ids: string[]): void => {
  removePendingRemovedSessionsIn(ids, storage());
};

// 诊断日志统一格式见 stores/workspaceSync/log.ts

/**
 * 清理快照终端文本末尾悬空的 Shell 提示符行（用于新建立 SSH 连接时，防止旧 Prompt 与新 Shell 登录 Prompt 重复叠加）
 */
const cleanTrailingPromptForReconnect = (text: string): string => {
  if (!text) return '';
  const normalized = text.replace(/\r?\n/g, '\r\n');
  const lines = normalized.split('\r\n');
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    // 剥离 ANSI 转义序列后判断是否为悬空的 shell 提示符（例如 root@localhost:~# 或 user@host:~$ ）
    const plainLastLine = lastLine.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trimEnd();
    if (plainLastLine && /[#$%>]\s*$/.test(plainLastLine)) {
      lines.pop(); // 裁剪掉末尾尚未执行命令的旧提示符行，留给新连接的远程 Shell 真实输出
      return lines.join('\r\n') + (lines.length > 0 ? '\r\n' : '');
    }
  }
  return normalized;
};

export const useWorkspaceSyncStore = defineStore('workspaceSync', () => {
  const sessionStore = useSessionStore();

  // 1. 同步开关：桌面端强制禁用 (false)，Web端默认开启 (true)
  const syncEnabled = ref<boolean>(
    isDesktopApp()
      ? false
      : (typeof localStorage !== 'undefined'
          ? localStorage.getItem(SYNC_ENABLED_STORAGE_KEY) !== 'false'
          : true)
  );

  // 2. 客户端唯一标识 (基于 sessionStorage，保证单标签页刷新保持、多标签/跨设备互斥)
  const getOrCreateClientId = (): string => {
    if (typeof sessionStorage !== 'undefined') {
      let cid = sessionStorage.getItem(CLIENT_ID_SESSION_KEY);
      if (!cid) {
        cid = `client_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
        sessionStorage.setItem(CLIENT_ID_SESSION_KEY, cid);
      }
      return cid;
    }
    return `client_${Date.now()}`;
  };

  const clientId = ref<string>(getOrCreateClientId());

  // 3. 被接管与遮罩状态
  const isTakenOver = ref<boolean>(false);
  const takeoverByClientId = ref<string | null>(null);

  // 4. 正在同步、恢复与初始化标记 (防止死循环与空快照冲刷)
  const isInitialized = ref<boolean>(false);
  const isSyncing = ref<boolean>(false);
  const isRestoring = ref<boolean>(false);
  /**
   * 页面正在卸载（刷新/关闭标签）。
   *
   * 卸载时 `cleanupAllSessions()` 会清空会话列表，如果这期间的 watcher 又触发了一次
   * "保存工作区"，就会把**空的会话列表**写进云端快照 —— 刷新后会话全没了。
   */
  const isUnloading = ref<boolean>(false);
  /** 是否已经成功从云端恢复过一次（用于阻止"恢复前空会话覆盖快照"） */
  let hasRestoredOnce = false;
  const lastSyncTime = ref<number | null>(null);

  // 5. 文件管理器当前状态缓存（全局兼容层）
  const fileManagerState = ref<SyncedFileManagerInfo>({
    currentPath: '',
    isSearchActive: false,
    searchQuery: '',
    scrollTop: 0,
  });

  // 5.1 多实例文件管理器状态映射 (key: `${sessionId}:${instanceId}`)
  const fileManagerInstances = ref<Record<string, SyncedFileManagerInstanceState>>({});

  // 6. 多行命令输入框状态缓存
  const multiLineCommandState = ref<SyncedMultiLineCommandInfo>({
    currentContent: '',
    sessionDrafts: {},
  });

  // 7. 会话映射表 (旧 sessionId -> 新 sessionId)
  const activeSessionIdMap = ref<Map<string, string>>(new Map());

  const getOriginalSessionId = (currentSessionId: string): string | null => {
    for (const [origId, newId] of activeSessionIdMap.value.entries()) {
      if (newId === currentSessionId) return origId;
    }
    return null;
  };

  // 获取特定会话与实例的文件管理器保存状态
  const getSavedFileManagerInstanceState = (sessionId: string, instanceId: string): SyncedFileManagerInstanceState | null => {
    const key = `${sessionId}:${instanceId}`;
    if (fileManagerInstances.value[key]) {
      return fileManagerInstances.value[key];
    }
    // 尝试通过 session 映射反查原始会话 ID
    const origSessionId = getOriginalSessionId(sessionId);
    if (origSessionId) {
      const origKey = `${origSessionId}:${instanceId}`;
      if (fileManagerInstances.value[origKey]) {
        return fileManagerInstances.value[origKey];
      }
    }
    // 回退到同会话任意实例或全局默认
    for (const [k, v] of Object.entries(fileManagerInstances.value)) {
      if (k.startsWith(`${sessionId}:`) || (origSessionId && k.startsWith(`${origSessionId}:`))) return v;
    }
    return null;
  };

  // 获取特定会话与实例的有效保存路径（仅对有快照保存记录的会话有效，新会话严格返回 null）
  const getSavedFileManagerPath = (sessionId: string, instanceId: string): string | null => {
    const inst = getSavedFileManagerInstanceState(sessionId, instanceId);
    if (inst?.currentPath && isValidFileManagerSyncPath(inst.currentPath)) {
      return inst.currentPath;
    }
    // 严禁回退到全局 fileManagerState.value.currentPath，避免用户新创建的独立会话被错误继承旧会话的路径
    return null;
  };

  // 更新特定文件管理器实例的状态
  const updateFileManagerInstanceState = (
    sessionId: string,
    instanceId: string,
    partial: Partial<SyncedFileManagerInstanceState>
  ) => {
    const key = `${sessionId}:${instanceId}`;
    const current = fileManagerInstances.value[key] || {
      instanceId,
      sessionId,
      currentPath: '',
      isSearchActive: false,
      searchQuery: '',
      scrollTop: 0,
      scrollRatio: 0,
    };
    fileManagerInstances.value[key] = { ...current, ...partial };

    // 跨端双向映射同步保障：
    // 当移动端模态框 (fm-modal-) 或任意实例更新路径/滚动时，同步对齐该会话下的所有关联实例
    const origSessionId = getOriginalSessionId(sessionId);
    for (const [k, inst] of Object.entries(fileManagerInstances.value)) {
      if (k !== key && (k.startsWith(`${sessionId}:`) || (origSessionId && k.startsWith(`${origSessionId}:`)))) {
        fileManagerInstances.value[k] = {
          ...inst,
          ...(partial.currentPath ? { currentPath: partial.currentPath } : {}),
          ...(partial.scrollTop !== undefined ? { scrollTop: partial.scrollTop } : {}),
          ...(partial.scrollRatio !== undefined ? { scrollRatio: partial.scrollRatio } : {}),
        };
      }
    }

    // 如果是当前活动会话的实例，同步更新单实例兼容层
    const sessionStore = useSessionStore();
    if (sessionStore.activeSessionId === sessionId) {
      fileManagerState.value = {
        currentPath: fileManagerInstances.value[key].currentPath,
        isSearchActive: fileManagerInstances.value[key].isSearchActive,
        searchQuery: fileManagerInstances.value[key].searchQuery,
        scrollTop: fileManagerInstances.value[key].scrollTop,
        scrollRatio: fileManagerInstances.value[key].scrollRatio,
      };
    }

    if (syncEnabled.value && !isRestoring.value && !isTakenOver.value) {
      triggerDebouncedSave();
    }
  };

  // 更新文件管理器状态 (兼容单实例调用)
  const updateFileManagerState = (partial: Partial<SyncedFileManagerInfo>) => {
    fileManagerState.value = { ...fileManagerState.value, ...partial };
    if (syncEnabled.value && !isRestoring.value && !isTakenOver.value) {
      triggerDebouncedSave();
    }
  };

  // 更新多行命令状态
  const updateMultiLineCommandState = (partial: Partial<SyncedMultiLineCommandInfo>) => {
    multiLineCommandState.value = { ...multiLineCommandState.value, ...partial };
    if (syncEnabled.value && !isRestoring.value && !isTakenOver.value) {
      triggerDebouncedSave();
    }
  };

  // 切换同步开关
  const toggleSyncEnabled = async () => {
    if (isDesktopApp()) return;
    syncEnabled.value = !syncEnabled.value;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SYNC_ENABLED_STORAGE_KEY, String(syncEnabled.value));
    }
    if (syncEnabled.value) {
      logSync('用户开启工作区实时云端同步');
      // 开启时立即声明接管并保存一次当前工作区
      await claimTakeover();
      triggerDebouncedSave(0);
    } else {
      logSync('用户关闭工作区实时云端同步');
    }
  };

  // 收集当前整个工作区完整快照
  // 采集实现见 stores/workspaceSync/collectSnapshot.ts（204 行）
  const collectCurrentWorkspaceState = (): WorkspaceSnapshot =>
    collectWorkspaceSnapshot({
      syncEnabled: syncEnabled.value,
      fileManagerState: fileManagerState.value,
      fileManagerInstances: fileManagerInstances.value,
      multiLineCommandState: multiLineCommandState.value,
    });

  // 防抖计时器
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const triggerDebouncedSave = (delayMs: number = 800) => {
    if (isDesktopApp() || !syncEnabled.value || !isInitialized.value || isRestoring.value || isTakenOver.value || isUnloading.value) return;

    if (saveTimer) {
      clearTimeout(saveTimer);
    }

    saveTimer = setTimeout(async () => {
      await saveWorkspaceToCloud();
    }, delayMs);
  };

  // 保存工作区到云端 (仅 Web 端有效)
  const saveWorkspaceToCloud = async (): Promise<boolean> => {
    if (isDesktopApp() || !syncEnabled.value || !isInitialized.value || isRestoring.value || isTakenOver.value || isUnloading.value) return false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      const snapshot = collectCurrentWorkspaceState();
      // 本次保存真正落地后，这一批"已关闭待清理"记录就没用了（只清本次保存之前记下的）
      const pendingAtSaveStart = readPendingRemovedSessions();
      // 首屏/恢复前的"空会话"绝不允许覆盖云端已有的快照。
      // 否则页面刚加载、会话还没恢复完时，任意一次 watcher 触发都会把空列表写上去，
      // 下次刷新就"会话全没了"（这个问题以前随机出现，就是这个空窗期）。
      if (snapshot.sessions.length === 0 && !hasRestoredOnce) {
        logSync('跳过空快照保存：尚未完成首次恢复');
        return false;
      }
      isSyncing.value = true;
      logSync('正在将工作区快照保存至云端...', {
        sessionsCount: snapshot.sessions.length,
        tabsCount: snapshot.fileEditor.tabs.length,
        tabs: snapshot.fileEditor.tabs.map(t => `${t.filename}(${t.selectedEncoding})`),
        fileManagerPath: snapshot.fileManager.currentPath,
      });

      // 保存到后端数据库
      const res = await apiClient.post('/workspace-sync/save', {
        clientId: clientId.value,
        state: snapshot,
      });

      if (res.data?.success) {
        const payload = res.data.data as { accepted?: boolean; activeClientId?: string | null } | undefined;
        if (payload && payload.accepted === false) {
          /**
           * 租约已被接管的客户端调用过 claim，本次写入被后端拒绝。
           * 这里必须让本端立刻进入遮罩：否则被接管的旧页面还会继续用"旧状态"覆盖云端，
           * 表现就是——在另一个页面关掉的会话，刷新后又回来了。
           */
          logSyncWarn(`本次保存被拒绝：工作区租约已归 ${payload.activeClientId || '其它客户端'}，当前端进入接管遮罩`);
          isTakenOver.value = true;
          takeoverByClientId.value = payload.activeClientId || null;
          if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
          }
          return false;
        }
        lastSyncTime.value = Date.now();
        removePendingRemovedSessions(pendingAtSaveStart);
        logSync('工作区快照已成功持久化至云端数据库！时间:', new Date().toLocaleTimeString());
        return true;
      }
      return false;
    } catch (err: any) {
      logSyncWarn('保存工作区到云端失败:', err.message);
      return false;
    } finally {
      isSyncing.value = false;
    }
  };

  // 声明接管 (Claim Lease) (仅 Web 端有效)
  const claimTakeover = async (): Promise<boolean> => {
    if (isDesktopApp()) return false;
    try {
      logSync(`当前客户端 (${clientId.value}) 正在声明工作区接管权...`);

      const res = await apiClient.post('/workspace-sync/claim', {
        clientId: clientId.value,
      });

      if (res.data?.success) {
        isTakenOver.value = false;
        takeoverByClientId.value = null;
        logSync(`接管权声明成功！当前客户端独占工作区操作。`);
        return true;
      }
      return false;
    } catch (err: any) {
      logSyncError('声明接管租约失败:', err);
      return false;
    }
  };

  // 处理被其它客户端接管的踢出通知 (仅 Web 端有效)
  const handleTakeoverKickout = (targetActiveClientId: string) => {
    if (isDesktopApp()) return;
    if (targetActiveClientId && targetActiveClientId !== clientId.value) {
      logSyncWarn(`工作区已被新客户端 (${targetActiveClientId}) 接管，当前客户端进入全局遮罩模式`);
      isTakenOver.value = true;
      takeoverByClientId.value = targetActiveClientId;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
    }
  };

  // 等待会话 SFTP 状态就绪的辅助方法
  const waitForSessionSftpReady = (session: any, timeoutMs: number = 8000): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!session || !session.wsManager) {
        return resolve(false);
      }
      if (session.wsManager.isSftpReady?.value) {
        return resolve(true);
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      let stopWatch: (() => void) | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (stopWatch) stopWatch();
      };

      timer = setTimeout(() => {
        cleanup();
        logSyncWarn(`等待会话 ${session.sessionId} SFTP 就绪超时 (${timeoutMs}ms)`);
        resolve(false);
      }, timeoutMs);

      stopWatch = watch(
        () => session.wsManager.isSftpReady?.value,
        (ready) => {
          if (ready) {
            cleanup();
            resolve(true);
          }
        },
        { immediate: true }
      );
    });
  };

  // 恢复工作区状态快照到前端各个模块
  /**
   * 应用"已关闭待清理"清单：把快照里那些刚被关掉、但删除/保存请求还没到账的会话剔除。
   *
   * 用户关掉会话后立刻刷新时，云端 GET 往往还返回旧快照（带着那个会话），
   * 直接恢复就等于"关掉的会话又回来了"。这里在恢复前先按本地记录剔除。
   */
  const consumePendingRemovedSessions = <T extends WorkspaceSnapshot>(snapshot: T): T => {
    const pending = readPendingRemovedSessions();
    if (!pending.length) return snapshot;

    const { snapshot: filtered, removedCount } = filterRemovedSessions(snapshot, pending);
    if (removedCount > 0) {
      logSyncWarn(`云端快照里还留着 ${removedCount} 个刚关闭的会话（关闭后立即刷新导致），已在恢复前剔除`);
    }
    return filtered;
  };

  const restoreWorkspaceFromSnapshot = async (snapshot: WorkspaceSnapshot) => {
    if (!snapshot) return;

    const sessionStore = useSessionStore();
    const fileEditorStore = useFileEditorStore();
    const connectionsStore = useConnectionsStore();
    const notifStore = useUiNotificationsStore();
    const highlightStore = useTerminalHighlightStore();
    const layoutStore = useLayoutStore();

    isRestoring.value = true;
    // 记录恢复起点：之后只要用户手动切过标签（lastUserSwitchAt > 这个值），
    // 整个恢复流程就不再抢焦点。
    const restoreStartedAt = Date.now();
    notifStore.setSilenced(true);
    logSync('开始从云端快照恢复工作区全量状态...', {
      sessionsCount: snapshot.sessions?.length || 0,
      tabsCount: snapshot.fileEditor?.tabs?.length || 0,
      activeSessionId: snapshot.activeSessionId,
      fileManagerPath: snapshot.fileManager?.currentPath,
    });

    try {
      // 0. 布局与侧栏不再从工作区快照恢复 —— 它们有自己的持久化（settings.layout / layoutPresets），
      //    快照里的副本是"上一次保存时"的旧值（布局变更后快照要 1.5s 才落库）。
      //    以前在这里 updateLayoutTree(snapshot.layout.layoutTree) 会用旧尺寸把刚调好的布局盖回去，
      //    表现为"改完立刻刷新 → 先变回旧的，等 SSH 恢复后又跳回新的"。
      //    现在布局只认 layout store 自己加载的 settings.layout，快照只负责会话/编辑器/文件管理器。

      // 1. 确保连接配置已加载
      if (!connectionsStore.connections || connectionsStore.connections.length === 0) {
        try {
          await connectionsStore.fetchConnections();
          logSync(`已加载可用连接列表，总数: ${connectionsStore.connections.length}`);
        } catch (e) {
          logSyncWarn('加载连接列表失败:', e);
        }
      }

      // 2. 检查云端挂起会话（旧端被接管时会自动挂起）
      let availableSuspended: any[] = [];
      try {
        await sessionStore.fetchSuspendedSshSessions({ showLoadingIndicator: false });
        availableSuspended = [...(sessionStore.suspendedSshSessions || [])];
        logSync(`已拉取挂起会话列表，可用挂起数: ${availableSuspended.length}`, availableSuspended);
      } catch (e) {
        logSyncWarn('获取挂起会话列表失败:', e);
      }

      // 3. 恢复会话列表并建立会话 ID 映射 (快照旧 sessionId -> 当前实际 sessionId)
      const sessionIdMap = new Map<string, string>();

      if (snapshot.sessions && snapshot.sessions.length > 0) {
        // 预先识别云端选中的目标激活会话（若未记录则默认第 0 个）
        const targetActiveSessionSnapshotId = snapshot.activeSessionId || snapshot.sessions[0]?.sessionId;

        // 先同步匹配消费池，为并发恢复做预先规划
        const restorePlans = snapshot.sessions.map((s) => {
          // 多维三级匹配：1. UUID 跨库唯一标识 -> 2. 主机名称 (跨端对齐) -> 3. 整数主键 ID (同库兜底)
          let connInfo = undefined;
          if (s.connectionUuid) {
            connInfo = connectionsStore.connections.find(c => c.uuid && c.uuid === s.connectionUuid);
          }
          if (!connInfo && s.connectionName) {
            connInfo = connectionsStore.connections.find(
              c => c.name && c.name.trim().toLowerCase() === s.connectionName.trim().toLowerCase()
            );
          }
          if (!connInfo && s.connectionId !== undefined && s.connectionId !== null) {
            const connIdNum = Number(s.connectionId);
            connInfo = connectionsStore.connections.find(c => c.id === connIdNum);
          }

          let matchedIdx = availableSuspended.findIndex(
            item => item.originalSessionId && item.originalSessionId === s.sessionId
          );

          if (matchedIdx === -1 && s.suspendSessionId) {
            matchedIdx = availableSuspended.findIndex(
              item => item.suspendSessionId === s.suspendSessionId
            );
          }

          if (matchedIdx === -1) {
            matchedIdx = availableSuspended.findIndex(
              item => String(item.connectionId) === String(s.connectionId) || item.connectionName === s.connectionName
            );
          }

          let matchedSuspended: any = undefined;
          if (matchedIdx !== -1) {
            matchedSuspended = availableSuspended[matchedIdx];
            availableSuspended.splice(matchedIdx, 1);
          }

          const isTargetActive = (s.sessionId === targetActiveSessionSnapshotId);

          return {
            snapshotSession: s,
            connInfo,
            matchedSuspended,
            isTargetActive,
          };
        });

        // 严格保持快照中会话从左到右的原始顺序，杜绝打乱会话栏排列
        // 并行恢复所有会话：目标会话传入 shouldActivate: true（从第 0 毫秒即刻聚焦），后台会话传入 shouldActivate: false（静默并发）
        logSync(`开始全量并发恢复 ${restorePlans.length} 个会话（保持原始顺序），目标激活会话即时聚焦，其余会话静默后台加载...`);
        await Promise.all(
          restorePlans.map(async (plan) => {
            const s = plan.snapshotSession;
            let targetSessionId: string | null = null;
            let isResumed = false;
            const shouldActivateThis = plan.isTargetActive;

            if (plan.matchedSuspended) {
              logSync(`发现匹配的挂起会话，正在并发唤醒接管: ${plan.matchedSuspended.suspendSessionId} (${plan.matchedSuspended.connectionName}, isTargetActive=${shouldActivateThis})`);
              try {
                targetSessionId = await sessionStore.resumeSshSession(plan.matchedSuspended.suspendSessionId, shouldActivateThis);
                if (targetSessionId) {
                  isResumed = true;
                  logSync(`挂起会话已并发唤醒，新会话 ID: ${targetSessionId}，由服务端接管回放`);
                }
              } catch (err) {
                logSyncWarn(`恢复挂起会话失败，降级为并发新建会话:`, err);
              }
            }

            // 若无挂起或恢复失败，则并发新建会话 (使用本地查到的有效主键 ID)
            if (!targetSessionId && plan.connInfo) {
              logSync(`重新开启连接会话 (并发): ${plan.connInfo.name || plan.connInfo.host} (本地连接 ID: ${plan.connInfo.id}, 快照原 ID: ${s.connectionId}, isTargetActive=${shouldActivateThis})`);
              targetSessionId = sessionStore.openNewSession(plan.connInfo.id, undefined, shouldActivateThis) || null;
            }

            // 若仍无 targetSessionId，检查本地是否已有属于该连接且未被映射的会话兜底
            if (!targetSessionId) {
              const matchedExisting = Array.from(sessionStore.sessions.values()).find(
                existingSession => {
                  if (Array.from(sessionIdMap.values()).includes(existingSession.sessionId)) return false;
                  if (plan.connInfo && String(existingSession.connectionId) === String(plan.connInfo.id)) return true;
                  if (s.connectionName && existingSession.connectionName === s.connectionName) return true;
                  return String(existingSession.connectionId) === String(s.connectionId);
                }
              );
              if (matchedExisting) {
                targetSessionId = matchedExisting.sessionId;
                if (shouldActivateThis) {
                  sessionStore.activateSession(targetSessionId);
                }
              }
            }

            if (targetSessionId) {
              sessionIdMap.set(s.sessionId, targetSessionId);
              // 记下"新 ID -> 快照旧 ID"，关闭会话时才能把快照里那份旧记录一起剔除
              recordSessionIdAlias(targetSessionId, s.sessionId);
              logSync(`建立会话 ID 映射: 旧 ${s.sessionId} -> 新 ${targetSessionId} (激活: ${shouldActivateThis})`);

              // 恢复单行命令输入框内容
              if (s.commandInputContent) {
                sessionStore.updateSessionCommandInput(targetSessionId, s.commandInputContent);
              }

              // 终端屏幕历史回放：如果是 resumeSshSession 唤醒的，后端会通过 logData 自动回放，此处无需重复写入
              if (s.terminalBuffer) {
                const sessionState = sessionStore.sessions.get(targetSessionId);
                if (sessionState) {
                  (sessionState as any).lastTerminalBuffer = s.terminalBuffer;
                  if (!isResumed) {
                    logSync(`为新连接会话 ${targetSessionId} 回放快照保存的终端屏幕历史 (字符数: ${s.terminalBuffer.length})`);
                    const cleanedBuffer = cleanTrailingPromptForReconnect(s.terminalBuffer);
                    const highlightedData: string = highlightStore.highlight(cleanedBuffer) as string;

                    if (sessionState.terminalManager?.terminalInstance?.value) {
                      sessionState.terminalManager.terminalInstance.value.write(highlightedData);
                      try {
                        sessionState.terminalManager.terminalInstance.value.refresh(0, sessionState.terminalManager.terminalInstance.value.rows - 1);
                      } catch {}
                    } else {
                      if (!sessionState.pendingOutput) {
                        sessionState.pendingOutput = [];
                      }
                      sessionState.pendingOutput.push(highlightedData);
                    }
                  }
                }
              } else if (s.terminalBuffer === '') {
                // 快照中记录终端已清屏，若当前会话存在终端实例则立即同步清空视口
                const sessionState = sessionStore.sessions.get(targetSessionId);
                if (sessionState) {
                  if (sessionState.terminalManager?.terminalInstance?.value) {
                    sessionState.terminalManager.terminalInstance.value.clear();
                  }
                  sessionState.pendingOutput = [];
                  logSync(`为会话 ${targetSessionId} 同步清空终端屏幕视口`);
                }
              }

              // 多终端分屏历史回放：保存至 sessionState.lastTerminalPanesBuffer，并向已挂载的副终端回放
              if (s.terminalPanesBuffer) {
                const sessionState = sessionStore.sessions.get(targetSessionId);
                if (sessionState) {
                  (sessionState as any).lastTerminalPanesBuffer = s.terminalPanesBuffer;
                  const tm = sessionState.terminalManager as any;
                  if (tm?.terminalPanes?.value && !isResumed) {
                    const panesMap = tm.terminalPanes.value as Map<string, any>;
                    // 快照里存的是 pane#0/pane#1 这样的稳定序号，需要换算成当前这棵会话树的真实 paneId
                    const order = layoutStore.getSessionTerminalPaneOrder(targetSessionId);
                    Object.entries(s.terminalPanesBuffer).forEach(([key, buf]) => {
                      const pId = key.startsWith('pane#') ? order[Number(key.slice(5))] : key;
                      if (!pId || pId === 'primary') return;
                      const paneEntry = panesMap.get(pId);
                      if (paneEntry?.instance?.value && buf) {
                        logSync(`为分屏终端 ${pId} (会话 ${targetSessionId}) 回放快照保存的屏幕历史 (字符数: ${buf.length})`);
                        const cleaned = cleanTrailingPromptForReconnect(buf);
                        const highlighted = highlightStore.highlight(cleaned) as string;
                        paneEntry.instance.value.write(highlighted);
                        try {
                          paneEntry.instance.value.refresh(0, paneEntry.instance.value.rows - 1);
                        } catch {}
                      }
                    });
                  }
                }
              }

              // 恢复主终端记录（只留作参考，不要直接写进 manager）
              // 会话树每次刷新都会重新生成 paneId，把旧 paneId 写进 primaryPaneId
              // 会锁定一个并不存在的分屏通道，导致命令发不出去。
              // manager 会在终端就绪时按"当前布局树的先序第一个终端"自行确定。
              if (s.primaryTerminalPaneId) {
                const sessionState = sessionStore.sessions.get(targetSessionId);
                if (sessionState) {
                  (sessionState as any).primaryTerminalPaneId = s.primaryTerminalPaneId;
                }
              }

              // 恢复"该会话上次聚焦的终端"，多终端分屏时切回来能直接落在正确的那一屏
              if (s.focusedTerminalPaneId) {
                const sessionState = sessionStore.sessions.get(targetSessionId);
                if (sessionState) {
                  sessionState.focusedTerminalPaneId = s.focusedTerminalPaneId;
                  // 布局树的焦点同步发生在会话挂载时（早于这里），所以补一次，
                  // 否则 activeTerminalPaneId 会停在默认的第一个终端上。
                  if (sessionStore.activeSessionId === targetSessionId) {
                    layoutStore.setActiveTerminalPaneId(s.focusedTerminalPaneId);
                  }
                }
              }
            }
          })
        );
      }

      // 同步全局 activeSessionIdMap
      activeSessionIdMap.value = new Map(sessionIdMap);

      // 4. 同步恢复快照中的会话标签排布顺序至本地 sessionOrder (映射旧 sessionId 为新 sessionId)
      const rawOrderList = snapshot.sessionOrder || snapshot.sessions?.map(s => s.sessionId) || [];
      const restoredSessionOrder: string[] = [];
      rawOrderList.forEach(oldId => {
        const newId = sessionIdMap.get(oldId) || (sessionStore.sessions.has(oldId) ? oldId : null);
        if (newId && !restoredSessionOrder.includes(newId)) {
          restoredSessionOrder.push(newId);
        }
      });
      sessionStore.sessions.forEach((_, sId) => {
        if (!restoredSessionOrder.includes(sId)) {
          restoredSessionOrder.push(sId);
        }
      });
      if (restoredSessionOrder.length > 0) {
        logSync('从云端快照恢复会话标签排布顺序:', restoredSessionOrder);
        sessionStore.setSessionOrder(restoredSessionOrder, false);
      }

      // 会话 SessionId 解析器 (解决新设备/重连后会话 ID 重新生成的问题)
      const resolveSessionId = (oldId?: string | null, fallbackConnId?: number | string): string | null => {
        if (oldId && sessionStore.sessions.has(oldId)) return oldId;
        if (oldId && sessionIdMap.has(oldId)) {
          const mapped = sessionIdMap.get(oldId)!;
          if (sessionStore.sessions.has(mapped)) return mapped;
        }
        // 如果未显式提供 fallbackConnId，尝试从快照 sessions 中自动反查 oldId 对应的 connectionId
        let targetConnId = fallbackConnId;
        if (targetConnId === undefined && oldId && snapshot.sessions) {
          const sItem = snapshot.sessions.find(s => s.sessionId === oldId);
          if (sItem) {
            targetConnId = sItem.connectionId;
          }
        }
        if (targetConnId !== undefined) {
          const matched = Array.from(sessionStore.sessions.values()).find(
            item => String(item.connectionId) === String(targetConnId)
          );
          if (matched) return matched.sessionId;
        }
        if (oldId && snapshot.sessions) {
          const sItem = snapshot.sessions.find(s => s.sessionId === oldId);
          if (sItem && sItem.connectionName) {
            const matchedByName = Array.from(sessionStore.sessions.values()).find(
              item => item.connectionName && item.connectionName.trim().toLowerCase() === sItem.connectionName.trim().toLowerCase()
            );
            if (matchedByName) return matchedByName.sessionId;
          }
        }
        if (sessionStore.sessions.size === 1) {
          return sessionStore.sessions.keys().next().value || null;
        }
        return sessionStore.activeSessionId || null;
      };

      // 恢复激活会话 ID (优先通过 sessionIdMap，次选通过快照中记录的 connectionId)
      if (snapshot.activeSessionId) {
        const activeSessionSnapshot = snapshot.sessions?.find(s => s.sessionId === snapshot.activeSessionId);
        const fallbackConnId = activeSessionSnapshot?.connectionId;
        const mappedActiveId = resolveSessionId(snapshot.activeSessionId, fallbackConnId);
        if (mappedActiveId) {
          if (sessionStore.activeSessionId !== mappedActiveId) {
            if (lastUserSwitchAt.value > restoreStartedAt) {
              logSync('恢复过程中用户已手动切换会话，跳过激活对齐');
            } else {
              sessionStore.activateSession(mappedActiveId, { silent: true });
              logSync(`已对齐激活目标会话: ${mappedActiveId}`);
            }
          } else {
            logSync(`目标会话在启动时已先行聚焦激活: ${mappedActiveId}，无需重复切换`);
          }
        }
      } else if (sessionStore.sessions.size > 0 && !sessionStore.activeSessionId) {
        const firstId = sessionStore.sessions.keys().next().value;
        if (firstId) {
          sessionStore.activateSession(firstId);
          logSync(`快照未指定激活会话，默认激活第一个会话: ${firstId}`);
        }
      }

      // 3.2 预先迁移并填充文件管理器和多行命令状态，确保组件在挂载时即可立即感知目标路径
      if (snapshot.fileManager) {
        fileManagerState.value = { ...snapshot.fileManager };
      }
      if (snapshot.fileManagers && Object.keys(snapshot.fileManagers).length > 0) {
        for (const item of Object.values(snapshot.fileManagers)) {
          const targetSessionId = resolveSessionId(item.sessionId);
          if (targetSessionId) {
            const newKey = `${targetSessionId}:${item.instanceId}`;
            fileManagerInstances.value[newKey] = {
              ...item,
              sessionId: targetSessionId,
            };
          }
        }
      }
      if (snapshot.multiLineCommandInput) {
        multiLineCommandState.value = { ...snapshot.multiLineCommandInput };
      }

      // 3.5 等待所有会话的 SFTP 就绪（最多等待 8 秒，保障文件管理器与编辑器平稳对接）
      const activeSessions = Array.from(sessionStore.sessions.values());
      if (activeSessions.length > 0) {
        logSync('正在等待会话 SFTP 就绪...');
        await Promise.all(activeSessions.map(sess => waitForSessionSftpReady(sess, 8000)));
        logSync('会话 SFTP 就绪阶段完成');
      }

      // 4/4.1 编辑器标签恢复（实现见 stores/workspaceSync/restoreEditors.ts）
      restoreEditorsFromSnapshot({ snapshot, resolveSessionId });

      // 5/5.1 文件管理器恢复（实现见 stores/workspaceSync/restoreFileManagers.ts）
      restoreFileManagersFromSnapshot({
        snapshot,
        resolveSessionId,
        activeSessionId: sessionStore.activeSessionId,
        fileManagerState,
        fileManagerInstances,
      });

      // 6. 恢复多行命令输入框状态
      if (snapshot.multiLineCommandInput) {
        multiLineCommandState.value = { ...snapshot.multiLineCommandInput };
        logSync(`已恢复多行命令输入框草稿内容`);
      }

      // 7. 最终确保工作区精准切换到上次激活的会话（防止异步加载与渲染过程中被其它事件打断）
      //    但如果用户在恢复期间已经手动点过标签，就必须尊重用户的选择，不能把他拽回去。
      if (snapshot.activeSessionId) {
        const activeSessionSnapshot = snapshot.sessions?.find(s => s.sessionId === snapshot.activeSessionId);
        const fallbackConnId = activeSessionSnapshot?.connectionId;
        const finalActiveId = resolveSessionId(snapshot.activeSessionId, fallbackConnId);
        if (finalActiveId) {
          await nextTick();
          if (sessionStore.activeSessionId !== finalActiveId) {
            if (lastUserSwitchAt.value > restoreStartedAt) {
              logSync('恢复收尾：检测到用户已手动切换会话，跳过最终激活对齐');
            } else {
              logSync(`恢复收尾，最终对齐激活会话至: ${finalActiveId}`);
              sessionStore.activateSession(finalActiveId, { silent: true });
            }
          }
        }
      }

      // 8. 恢复弹窗编辑器显隐状态
      if (snapshot.fileEditor?.isOpen) {
        const targetSessionId = resolveSessionId(snapshot.activeSessionId) || sessionStore.activeSessionId;
        logSync(`从云端快照恢复弹窗编辑器为打开状态 (sessionId: ${targetSessionId})`);
        fileEditorStore.openPopup('', targetSessionId);
      } else {
        fileEditorStore.closePopup();
        logSync('从云端快照恢复弹窗编辑器为关闭状态');
      }

      hasRestoredOnce = true;
      logSync('恭喜！工作区全量状态无缝恢复完成！');
    } catch (err: any) {
      logSyncError('恢复工作区发生错误:', err);
    } finally {
      setTimeout(() => {
        isRestoring.value = false;
        notifStore.setSilenced(false);
        /**
         * 恢复收尾：把"新会话 ID"沉淀回云端快照。
         *
         * 必须放在 isRestoring 放开之后 —— 以前是在恢复结束时 schedule 一个 1000ms 的保存，
         * 而 isRestoring 要到 1500ms 才放开，那次保存永远被自己拦掉，
         * 快照里就一直留着上一轮的旧 sessionId（关闭会话时按 ID 剔除会因此对不上）。
         */
        if (syncEnabled.value && !isTakenOver.value) {
          triggerDebouncedSave(300);
        }
      }, 1500);
    }
  };

  // 监听活动会话切换，自动触发云端状态防抖保存
  watch(
    () => sessionStore.activeSessionId,
    (newActiveId, oldActiveId) => {
      if (newActiveId && newActiveId !== oldActiveId && syncEnabled.value && !isRestoring.value && !isTakenOver.value) {
        logSync(`检测到活动会话切换为: ${newActiveId}，安排云端状态防抖同步`);
        triggerDebouncedSave();
      }
    }
  );

  // 监听布局与侧栏结构变化，自动触发工作区防抖保存
  const layoutStore = useLayoutStore();
  watch(
    () => [layoutStore.layoutTree, layoutStore.sidebarPanes],
    () => {
      if (syncEnabled.value && !isRestoring.value && !isTakenOver.value) {
        logSync('检测到工作区布局或侧栏配置调整，安排云端状态防抖同步');
        triggerDebouncedSave(1500);
      }
    },
    { deep: true }
  );

  // 初始化同步服务 (页面加载时调用，仅 Web 端有效)
  const initSync = async () => {
    if (isDesktopApp() || !syncEnabled.value) return;

    try {
      logSync('正在拉取云端工作区快照进行初始化...');
      const res = await apiClient.get('/workspace-sync');
      if (res.data?.success && res.data?.data) {
        const { state: cloudState, activeClientId } = res.data.data;
        logSync(`获取到云端快照，最后活跃客户端: ${activeClientId}，当前客户端: ${clientId.value}`);

        // 声明接管（后端会自动挂起旧端活动会话）
        await claimTakeover();

        if (cloudState && cloudState.syncEnabled) {
          await restoreWorkspaceFromSnapshot(consumePendingRemovedSessions(cloudState));
        } else {
          logSync('云端快照未开启同步或为空，跳过状态恢复');
        }
      }
    } catch (err: any) {
      logSyncWarn('初始化工作区同步失败:', err.message);
    } finally {
      isInitialized.value = true;
      logSync('工作区同步初始化完毕，isInitialized 状态锁已放行。');
    }
  };

  // 从云端获取最新快照并无缝恢复 (仅 Web 端有效)
  const restoreWorkspaceFromCloud = async (): Promise<boolean> => {
    if (isDesktopApp()) return false;
    try {
      logSync('正在从云端拉取最新工作区快照进行恢复...');
      const res = await apiClient.get('/workspace-sync');
      if (res.data?.success && res.data?.data) {
        const { state: cloudState } = res.data.data;
        if (cloudState && cloudState.syncEnabled) {
          await restoreWorkspaceFromSnapshot(consumePendingRemovedSessions(cloudState));
          return true;
        }
      }
      return false;
    } catch (err: any) {
      logSyncWarn('从云端恢复工作区快照失败:', err.message);
      return false;
    }
  };

  return {
    syncEnabled,
    clientId,
    isTakenOver,
    takeoverByClientId,
    isSyncing,
    isRestoring,
    isUnloading,
    markUnloading: () => {
      isUnloading.value = true;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
    },
    lastSyncTime,
    fileManagerState,
    fileManagerInstances,
    multiLineCommandState,
    getSavedFileManagerInstanceState,
    getSavedFileManagerPath,
    updateFileManagerInstanceState,
    updateFileManagerState,
    updateMultiLineCommandState,
    toggleSyncEnabled,
    collectCurrentWorkspaceState,
    triggerDebouncedSave,
    saveWorkspaceToCloud,
    claimTakeover,
    handleTakeoverKickout,
    restoreWorkspaceFromSnapshot,
    restoreWorkspaceFromCloud,
    initSync,
  };
});
