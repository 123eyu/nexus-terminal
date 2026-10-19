import { workspaceEmitter } from '../../composables/workspaceEvents';
import type { Ref } from 'vue';
import { logSync } from './log';
import {
  isValidFileManagerSyncPath,
  type SyncedFileManagerInfo,
  type SyncedFileManagerInstanceState,
  type WorkspaceSnapshot,
} from './types';

/**
 * 从快照恢复文件管理器状态（全局兼容路径 + 每实例路径）。
 *
 * 为什么通过事件而不是直接改 store：文件管理器组件可能是晚挂载的（侧栏 v-if），
 * 恢复时它还没订阅。`fileManager:navigateToPath` 由组件在 mounted 时消费，
 * 同时这里先把状态写进缓存表 —— 组件挂载后直接从缓存读到目标路径，不用等事件。
 *
 * 两处必须同时写的原因：
 * - `newKey`：当前会话 id（组件实际会按新 id 去找）
 * - 旧 key：快照里的旧 sessionId 可能还有组件在用（刷新恢复窗口期内）
 * 少写一个，表现就是"某个分屏的文件管理器路径没恢复"。
 */
export interface RestoreFileManagersDeps {
  snapshot: WorkspaceSnapshot;
  /** 快照旧 sessionId -> 当前 sessionId */
  resolveSessionId: (snapshotSessionId?: string) => string | null;
  /** 当前活动会话（全局兼容路径恢复时作为目标） */
  activeSessionId: string | null;
  fileManagerState: Ref<SyncedFileManagerInfo>;
  fileManagerInstances: Ref<Record<string, SyncedFileManagerInstanceState>>;
}

export function restoreFileManagersFromSnapshot(deps: RestoreFileManagersDeps): void {
  const { snapshot, resolveSessionId } = deps;

  // 5. 全局兼容路径（旧快照只有单实例时用）
  if (snapshot.fileManager) {
    deps.fileManagerState.value = { ...snapshot.fileManager };
    // 只有路径有效且不是根目录占位时才导航
    if (
      snapshot.fileManager.currentPath &&
      isValidFileManagerSyncPath(snapshot.fileManager.currentPath)
    ) {
      const fmSessionId = resolveSessionId(deps.activeSessionId || undefined);
      logSync(
        `正在恢复文件管理器全局兼容路径: ${snapshot.fileManager.currentPath} (会话: ${fmSessionId || 'all'})`
      );
      workspaceEmitter.emit('fileManager:navigateToPath', {
        path: snapshot.fileManager.currentPath,
        sessionId: fmSessionId || undefined,
      });
    }
  }

  // 5.1 每个实例的专属路径、搜索与滚动状态
  if (snapshot.fileManagers && Object.keys(snapshot.fileManagers).length > 0) {
    logSync(`正在恢复 ${Object.keys(snapshot.fileManagers).length} 个文件管理器实例状态...`);
    for (const item of Object.values(snapshot.fileManagers)) {
      const targetSessionId = resolveSessionId(item.sessionId);
      if (!targetSessionId) continue;

      const newKey = `${targetSessionId}:${item.instanceId}`;
      deps.fileManagerInstances.value[newKey] = {
        ...item,
        sessionId: targetSessionId,
      };
      // 旧 key 也留一份：刷新窗口期内可能还有组件按旧 id 取值
      if (item.sessionId !== targetSessionId) {
        deps.fileManagerInstances.value[`${item.sessionId}:${item.instanceId}`] = { ...item };
      }

      if (item.currentPath && isValidFileManagerSyncPath(item.currentPath)) {
        logSync(
          `正在恢复文件管理器实例 [会话: ${targetSessionId}, 实例: ${item.instanceId}] 路径: ${item.currentPath}, scrollTop: ${item.scrollTop ?? 0}`
        );
        workspaceEmitter.emit('fileManager:navigateToPath', {
          path: item.currentPath,
          sessionId: targetSessionId,
          instanceId: item.instanceId,
        });
      }
    }
  }
}
