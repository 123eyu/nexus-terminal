/**
 * 「关标签 = 后台挂起」的客户端实现。
 *
 * 为什么不复用 `SSH_MARK_FOR_SUSPEND`：
 * 那个只是打一个标记，真正的移交要等 WebSocket 断开时后端才做；
 * 而关标签走的是 `close(1000, '客户端主动断开')`，后端会把这种关闭判定成「显式关闭」，
 * 先把 `isMarkedForSuspend` 清掉、再直接 destroy SSH —— 标记根本救不回来。
 *
 * 所以这里发一条 `SSH_SUSPEND_NOW`，让后端当场把 SSH 移交给挂起池，
 * 等 ACK 确认已经交接完成，前端才敢清理标签（此时 ws 怎么关都碰不到 SSH 了）。
 */
import type { SessionState } from '../types';

export interface SuspendNowResult {
  ok: boolean;
  error?: string;
}

type PendingResolver = (result: SuspendNowResult) => void;

/** sessionId -> 等待 ACK 的兑现函数。支持同时关多个标签 */
const pending = new Map<string, PendingResolver>();

/** 等不到 ACK 不能把关标签卡死，超时就退回「直接断开」 */
const ACK_TIMEOUT_MS = 2500;

/**
 * ACK 到达时兑现等待中的关闭动作。
 * 返回 false 表示没有在等（比如用户根本没走关标签路径）。
 */
export const resolveSuspendNowAck = (sessionId: string, result: SuspendNowResult): boolean => {
  const resolver = pending.get(sessionId);
  if (!resolver) return false;
  pending.delete(sessionId);
  resolver(result);
  return true;
};

/**
 * 取终端当前可见内容的完整文本（含 scrollback）。
 * 挂起后回放要靠它，所以不能只截最后几屏，行尾空白要剪、自动折行的行不能插换行。
 */
export const extractTerminalBuffer = (session: SessionState | undefined): string => {
  const term = session?.terminalManager?.terminalInstance?.value;
  if (!term) return '';
  const buffer = term.buffer.active;

  let lastNonEmptyLineIndex = -1;
  for (let i = buffer.length - 1; i >= 0; i--) {
    const line = buffer.getLine(i);
    if (line && line.translateToString(true).trim() !== '') {
      lastNonEmptyLineIndex = i;
      break;
    }
  }
  if (lastNonEmptyLineIndex === -1) return '';

  let result = '';
  for (let i = 0; i <= lastNonEmptyLineIndex; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;

    const nextLine = i < lastNonEmptyLineIndex ? buffer.getLine(i + 1) : null;
    const isNextWrapped = nextLine ? nextLine.isWrapped : false;

    if (isNextWrapped) {
      // 下一行是自动折行产生的：保留整行字符且不插换行，否则会变阶梯
      result += line.translateToString(false);
    } else {
      result += line.translateToString(true);
      if (i < lastNonEmptyLineIndex) result += '\r\n';
    }
  }
  return result;
};

/**
 * 把当前 SSH 会话转入后台挂起。只有 ok=true 才说明后端已经接管，可以安全丢开连接。
 */
export const suspendSessionNow = (session: SessionState): Promise<SuspendNowResult> => {
  const sessionId = session.sessionId;
  const wsManager = session.wsManager;

  if (session.kind !== 'ssh') {
    return Promise.resolve({ ok: false, error: 'not-ssh-session' });
  }
  if (!wsManager || !wsManager.isConnected.value) {
    return Promise.resolve({ ok: false, error: 'websocket-not-connected' });
  }

  return new Promise<SuspendNowResult>((resolve) => {
    let settled = false;
    const finish = (result: SuspendNowResult) => {
      if (settled) return;
      settled = true;
      pending.delete(sessionId);
      resolve(result);
    };

    pending.set(sessionId, finish);

    setTimeout(() => {
      if (!settled) {
        console.warn(`[SuspendNow] 等待挂起确认超时 (${ACK_TIMEOUT_MS}ms)，降级为直接断开: ${sessionId}`);
        finish({ ok: false, error: 'ack-timeout' });
      }
    }, ACK_TIMEOUT_MS);

    wsManager.sendMessage({
      type: 'SSH_SUSPEND_NOW',
      payload: { sessionId, initialBuffer: extractTerminalBuffer(session) || undefined },
    } as any);
  });
};
