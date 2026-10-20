// packages/frontend/src/composables/file-manager/useExternalOpenSync.ts
import i18n from '../../i18n';
import apiClient from '../../utils/apiClient';
import { useAuthStore } from '../../stores/auth.store';
import { useDialogStore } from '../../stores/dialog.store';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';
import { subscribeGlobalEvent } from '../useGlobalSyncListener';

/**
 * 「外部编辑器打开远程文件」的回传反馈。
 *
 * 后端 watcher 在外部程序保存本地副本后会自动传回远程，并通过 /ws/events 推三类事件：
 *   external-open:synced    —— 已回传（toast 成功）
 *   external-open:reloaded  —— 冲突时选了"放弃本地改动"，已用远程覆盖本地副本
 *   external-open:conflict  —— 远程在编辑期间被别人改过，需要用户决定（覆盖远程 / 放弃本地）
 *   external-open:error     —— 回传失败
 *
 * 冲突弹窗走全局 ConfirmDialog（useDialogStore.showDialog），确认=覆盖远程、取消=放弃本地改动。
 * 多个文件同时冲突时串行弹，避免弹窗互相盖掉。
 */

export interface ExternalOpenEventPayload {
  userId?: number | string | null;
  connectionId?: number;
  remotePath?: string;
  localPath?: string;
  fileName?: string;
  size?: number | null;
  message?: string;
}

let initialized = false;
/** 串行处理冲突决议，保证同一时刻只有一个确认框 */
let conflictChain: Promise<void> = Promise.resolve();

function t(key: string, fallback: string): string {
  const translate = i18n.global.t as (k: string, f?: string) => string;
  return translate(key, fallback);
}

/** 事件是否属于当前登录用户（/ws/events 不区分用户，只能前端自己过滤） */
function isCurrentUser(payload: ExternalOpenEventPayload | undefined): boolean {
  if (!payload) return false;
  if (payload.userId === undefined || payload.userId === null) return true;
  const authStore = useAuthStore();
  const myId = authStore.user?.id;
  if (myId === undefined || myId === null) return true;
  return String(myId) === String(payload.userId);
}

/**
 * 在 App 挂载时调用一次（单例）。
 * 注意：依赖 initGlobalSyncListener() 建立的 /ws/events 连接，但不强依赖调用顺序。
 */
export function initExternalOpenSync(): void {
  if (initialized) return;
  initialized = true;

  const notifications = useUiNotificationsStore();
  const dialogStore = useDialogStore();

  subscribeGlobalEvent('external-open:synced', (message: any) => {
    const payload: ExternalOpenEventPayload = message?.payload || {};
    if (!isCurrentUser(payload)) return;
    notifications.showSuccess(
      t('fileManager.externalSync.synced', '已同步回远程服务器') + (payload.fileName ? `: ${payload.fileName}` : '')
    );
  });

  subscribeGlobalEvent('external-open:reloaded', (message: any) => {
    const payload: ExternalOpenEventPayload = message?.payload || {};
    if (!isCurrentUser(payload)) return;
    notifications.showInfo(
      t('fileManager.externalSync.reloaded', '已用远程版本覆盖本地副本') + (payload.fileName ? `: ${payload.fileName}` : '')
    );
  });

  subscribeGlobalEvent('external-open:error', (message: any) => {
    const payload: ExternalOpenEventPayload = message?.payload || {};
    if (!isCurrentUser(payload)) return;
    const detail = payload.message ? ` (${payload.message})` : '';
    notifications.showError(
      t('fileManager.externalSync.failed', '同步回远程失败') + (payload.fileName ? `: ${payload.fileName}` : '') + detail
    );
  });

  subscribeGlobalEvent('external-open:conflict', (message: any) => {
    const payload: ExternalOpenEventPayload = message?.payload || {};
    if (!isCurrentUser(payload)) return;
    if (!payload.localPath) return;

    conflictChain = conflictChain
      .then(async () => {
        const confirmText = t('fileManager.externalSync.overwriteRemote', '覆盖远程');
        const cancelText = t('fileManager.externalSync.discardLocal', '放弃本地改动');
        const name = payload.fileName || payload.remotePath || '';
        const overwrite = await dialogStore.showDialog({
          title: t('fileManager.externalSync.conflictTitle', '远程文件已被修改'),
          message:
            t(
              'fileManager.externalSync.conflictMessage',
              '你正在外部编辑器里修改的文件，远程版本在此期间也被改过了。要用你的本地修改覆盖远程，还是放弃本地改动、重新拉取远程版本？'
            ) + (name ? `\n\n${name}` : ''),
          confirmText,
          cancelText,
        });

        try {
          await apiClient.post(
            '/sftp/open-external/resolve',
            { localPath: payload.localPath, action: overwrite ? 'overwrite' : 'reload' },
            { timeout: 120000 }
          );
          if (overwrite) {
            notifications.showSuccess(
              t('fileManager.externalSync.overwriteDone', '已用本地修改覆盖远程') + (name ? `: ${name}` : '')
            );
          } else {
            notifications.showInfo(
              t('fileManager.externalSync.discardDone', '已放弃本地改动，本地副本已更新为远程版本') + (name ? `: ${name}` : '')
            );
          }
        } catch (error: any) {
          const detail = error?.response?.data?.message || error?.message || '';
          notifications.showError(
            t('fileManager.externalSync.resolveFailed', '处理失败') + (detail ? `: ${detail}` : '')
          );
        }
      })
      .catch((error: any) => {
        console.warn('[ExternalOpenSync] 处理冲突事件失败:', error);
      });
  });
}
