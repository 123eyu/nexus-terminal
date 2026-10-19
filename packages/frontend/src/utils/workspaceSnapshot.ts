/**
 * 工作区快照的纯变换函数（不碰 localStorage / 网络 / Pinia）。
 *
 * 抽出来的原因：这里承载的是"关掉会话后立刻刷新，它又回来了"这类最招人烦的 bug，
 * 判断过程却埋在 1400 行的 store 闭包里，只能靠手动刷页面验证。
 */

export interface SnapshotSessionLike {
  sessionId: string;
}

export interface SnapshotWithSessions {
  sessions: SnapshotSessionLike[];
  sessionOrder?: string[];
  activeSessionId?: string | null;
}

export interface FilterRemovedResult<T> {
  snapshot: T;
  /** 实际剔除的会话数，0 表示原样返回（引用不变） */
  removedCount: number;
}

/**
 * 按"已关闭待清理"清单剔除快照里的会话。
 *
 * 用户关掉会话后立刻刷新时，云端 GET 往往还返回旧快照（删除/保存请求还在路上），
 * 直接恢复就等于"关掉的会话又回来了"。恢复前用本地同步写入的清单过滤一次。
 *
 * 同时维护 `sessionOrder` 与 `activeSessionId`：
 * 被删的会话若正好是活动会话，回落到剩下列表的最后一个（与前端关标签的行为一致）。
 */
export function filterRemovedSessions<T extends SnapshotWithSessions>(
  snapshot: T,
  pendingIds: readonly string[]
): FilterRemovedResult<T> {
  if (!snapshot || !Array.isArray(snapshot.sessions) || pendingIds.length === 0) {
    return { snapshot, removedCount: 0 };
  }

  const pendingSet = new Set(pendingIds);
  const sessions = snapshot.sessions.filter((s) => !pendingSet.has(s.sessionId));
  const removedCount = snapshot.sessions.length - sessions.length;
  if (removedCount <= 0) {
    return { snapshot, removedCount: 0 };
  }

  const sessionOrder = Array.isArray(snapshot.sessionOrder)
    ? snapshot.sessionOrder.filter((id) => !pendingSet.has(id))
    : snapshot.sessionOrder;

  const activeSessionId =
    snapshot.activeSessionId && pendingSet.has(snapshot.activeSessionId)
      ? (sessions[sessions.length - 1]?.sessionId ?? null)
      : snapshot.activeSessionId;

  return {
    snapshot: { ...snapshot, sessions, sessionOrder, activeSessionId },
    removedCount,
  };
}

/**
 * 把"本地当前会话 ID"翻译回快照里的旧 ID。
 *
 * 刷新恢复出来的会话是新建的本地 ID，而快照要等恢复收尾才沉淀新 ID。
 * 这中间的窗口里关闭会话，只记本地 ID 是匹配不到快照的，需要借助别名表。
 */
export function resolveSnapshotSessionId(
  localSessionId: string,
  aliases: Record<string, string> | null | undefined
): string | null {
  if (!localSessionId || !aliases) return null;
  const mapped = aliases[localSessionId];
  if (!mapped || mapped === localSessionId) return null;
  return mapped;
}
