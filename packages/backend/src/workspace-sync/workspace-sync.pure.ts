/**
 * 工作区快照的纯判定逻辑（不含 IO）。
 *
 * 这两段以前直接写在 WorkspaceSyncService 里，只能靠"打开两个浏览器窗口手动试"来验证。
 * 但它们恰恰是"会话莫名复活 / 被接管后还在写"这类问题的根源，所以抽出来做单测。
 */

export interface LeaseDecision {
  /** 本次写入是否被接受 */
  accepted: boolean;
  /** 当前租约持有者（被拒时前端据此进入接管遮罩） */
  activeClientId: string | null;
}

/**
 * 租约判定：只有持有租约的客户端能写快照。
 *
 * - 没有持有者（首次写入 / 记录被清）→ 任何人可写，并顺势成为持有者。
 * - 持有者就是自己 → 可写。
 * - 别人持有 → 拒绝，并把持有者回传。
 *
 * 为什么必须拒绝而不是"顺手改成本人"：被接管的旧页面只要触发一次自动保存
 * （关标签、改布局都会），就能把已关闭的会话写回快照，下次刷新又"复活"。
 */
export function evaluateLeaseWrite(
  leaseOwner: string | null | undefined,
  clientId: string
): LeaseDecision {
  const owner = leaseOwner || null;
  if (owner && owner !== clientId) {
    return { accepted: false, activeClientId: owner };
  }
  return { accepted: true, activeClientId: clientId };
}

interface SnapshotLike {
  sessions?: Array<{ sessionId: string }>;
  sessionOrder?: string[];
  activeSessionId?: string | null;
  fileManagers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 这条会话属于「另一个参与工作区同步的客户端」吗？
 *
 * 只有**绑过** clientId 的 ws 才算。`workspace:bind_client` 是所有终端 ws 在 onopen 时
 * 无条件发的，没绑上说明它根本不参与工作区同步：
 *   - 桌面端（工作区同步恒为关）
 *   - 旧版本 / 第三方客户端
 *   - ws 抢在 workspaceSync store 初始化（生成 clientId）之前就连上的窗口期
 * 这些会话绝不能因为「另开一个网页接管工作区」就被移交挂起 —— 用户看到的现象就是
 * 「挂起池里出现了一个我根本没在这个工作区打开过的连接」。
 */
export function isForeignWorkspaceClient(
  wsClientId: string | null | undefined,
  currentClientId: string
): boolean {
  if (typeof wsClientId !== 'string') return false;
  const id = wsClientId.trim();
  if (!id) return false;
  return id !== currentClientId;
}

/** 参与「该不该清掉这条接管遗留挂起」判定的字段（结构类型，便于单测） */
export interface TakeoverSuspendLike {
  /** 由第几轮工作区接管创建（手动挂起 / 断线自动挂起没有这个值） */
  takeoverRound?: number;
  manuallySuspended?: boolean;
  originalSessionId?: string;
}

/**
 * 「上一轮接管留下的、这一轮恢复再也用不到的」自动挂起条目 → 该清掉。
 *
 * 背景：`claimLease` 每换一次租约就把旧端在跑的会话移交给挂起池。新端恢复时只认领
 * **云端快照里还有的**那些会话，剩下的（旧端自己那一代会话、开出来还没等快照落库的、
 * 不参与同步的客户端会话）永远没人认领 —— 反复接管几次，挂起面板里就堆出一串
 * 看起来毫无缘由的会话。
 *
 * 只清三类都不满足的条目：
 *   1. 用户手动挂起的（关标签右键「挂起会话」）→ 永远归挂起面板
 *   2. 不是接管产生的（断线 / 刷新自动挂起）→ 有 `originalSessionId`，刷新时还要认领
 *   3. 本轮刚挂起来的 → 新端马上要 resume 它
 */
export function shouldPruneTakeoverSuspend(
  entry: TakeoverSuspendLike,
  currentRound: number,
  keepOriginalSessionIds: ReadonlySet<string>
): boolean {
  if (entry.manuallySuspended === true) return false;
  const round = entry.takeoverRound;
  if (typeof round !== 'number' || !Number.isFinite(round)) return false;
  if (round >= currentRound) return false;
  const original = entry.originalSessionId;
  if (!original) return false;
  return !keepOriginalSessionIds.has(original);
}

export interface RemoveSessionResult {
  /** 处理后的快照（输入不会被修改） */
  state: SnapshotLike;
  /** 剩余会话数 */
  remainingSessionsCount: number;
  /** 快照里本来就没有这个会话 */
  notFound: boolean;
}

/**
 * 从快照里精确剔除一个会话。
 *
 * 【铁律】只按 sessionId 匹配，绝不能因 connectionId 相同而误伤同连接下的其他会话。
 * 同时要维护 sessionOrder / activeSessionId / fileManagers，否则：
 * - sessionOrder 残留 → 恢复时按顺序找会话，找到不存在的 id 就中断
 * - activeSessionId 指向已删会话 → 刷新后打开一个空标签
 * - fileManagers 残留 → 组件状态内存泄漏（key 是 `${sessionId}:${instanceId}`）
 */
export function removeSessionFromSnapshot(
  state: SnapshotLike,
  targetSessionId: string
): RemoveSessionResult {
  if (!Array.isArray(state.sessions)) {
    return { state, remainingSessionsCount: 0, notFound: true };
  }

  const remaining = state.sessions.filter((s) => s?.sessionId !== targetSessionId);
  const notFound = remaining.length === state.sessions.length;
  const next: SnapshotLike = { ...state, sessions: remaining };

  if (Array.isArray(state.sessionOrder)) {
    next.sessionOrder = state.sessionOrder.filter((id) => id !== targetSessionId);
  }

  if (state.activeSessionId === targetSessionId) {
    next.activeSessionId = remaining.length > 0 ? remaining[remaining.length - 1].sessionId : null;
  }

  if (state.fileManagers) {
    const cleaned: Record<string, unknown> = {};
    for (const key of Object.keys(state.fileManagers)) {
      if (!key.startsWith(`${targetSessionId}:`)) {
        cleaned[key] = state.fileManagers[key];
      }
    }
    next.fileManagers = cleaned;
  }

  return { state: next, remainingSessionsCount: remaining.length, notFound };
}
