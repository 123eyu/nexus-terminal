import { watch } from 'vue';
import { logSyncWarn } from './log';

/**
 * 等待某个会话的 SFTP 通道就绪。
 *
 * 恢复流程里必须先等 SFTP 就绪再恢复文件管理器/编辑器路径，
 * 否则组件挂载时 `sftpManagers` 还没建好，`navigateToPath` 事件没人接。
 *
 * 注意这里是**轮询式 watch**（immediate: true 立刻检查一次），
 * 不是 setInterval —— 后者在超时后仍会继续跑，会泄漏。
 */
export function waitForSessionSftpReady(
  session: any,
  timeoutMs: number = 8000
): Promise<boolean> {
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
}
