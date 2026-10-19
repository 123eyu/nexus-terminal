/**
 * 「已关闭待清理」会话清单 + 会话 ID 别名表（从 workspaceSync.store 抽出）。
 *
 * 这两份 localStorage 记录是"关闭会话后立刻刷新又复活"的唯一兜底：
 * 关闭动作会 DELETE 快照并立即保存，但请求还在路上时新页面已经 GET 到了旧快照。
 *
 * 三条约束（都是踩坑换来的）：
 * 1. 关闭瞬间必须**同步**写入，不能塞进防抖；
 * 2. 刷新恢复出来的会话是新 ID，快照里是旧 ID —— 必须靠别名表把两个都记上；
 * 3. 保存成功后只清"本次保存之前"记录的条目，否则保存途中关掉的会话会被误清。
 *
 * storage 用参数注入（而不是直接摸 localStorage），这样单测能用内存实现跑。
 * 本文件因此必须保持"零运行时依赖"（只能 import type），别名解析函数也由调用方注入。
 */

export const PENDING_REMOVED_SESSIONS_KEY = 'nexus_pending_removed_sessions';
export const SESSION_ID_ALIAS_KEY = 'nexus_session_id_alias';
export const MAX_PENDING_REMOVED_SESSIONS = 50;
export const MAX_SESSION_ID_ALIASES = 100;

/** 只依赖 getItem / setItem / removeItem，方便测试注入 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readPendingRemovedSessions(storage: StorageLike | undefined): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PENDING_REMOVED_SESSIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((id: unknown): id is string => typeof id === 'string' && !!id)
      : [];
  } catch {
    return [];
  }
}

export function readSessionIdAliases(storage: StorageLike | undefined): Record<string, string> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SESSION_ID_ALIAS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 记录一个"已关闭待清理"的会话（同步写入，页面立刻刷新也不会丢）。
 *
 * 同时记录别名表里的旧 ID：刷新恢复出来的会话是新 ID，云端快照里还躺着旧 ID
 * （快照要等约 1.8s 才沉淀新 ID）。只记新 ID 的话，下次加载按 ID 剔除就对不上 → 会话又回来了。
 */
export function markSessionRemovedPendingSync(
  sessionId: string,
  storage: StorageLike | undefined,
  resolveSnapshotId: (localId: string, aliases: Record<string, string>) => string | null
): void {
  if (!sessionId || !storage) return;
  try {
    const list = readPendingRemovedSessions(storage).filter((id) => id !== sessionId);
    list.push(sessionId);
    const aliased = resolveSnapshotId(sessionId, readSessionIdAliases(storage));
    if (aliased && !list.includes(aliased)) {
      list.push(aliased);
    }
    storage.setItem(
      PENDING_REMOVED_SESSIONS_KEY,
      JSON.stringify(list.slice(-MAX_PENDING_REMOVED_SESSIONS))
    );
  } catch {
    /* storage 不可用时忽略 */
  }
}

export function recordSessionIdAlias(
  localId: string,
  snapshotId: string,
  storage: StorageLike | undefined
): void {
  if (!localId || !snapshotId || localId === snapshotId || !storage) return;
  try {
    const map = readSessionIdAliases(storage);
    map[localId] = snapshotId;
    const keys = Object.keys(map);
    // 只保留最近 100 条，避免无限增长
    if (keys.length > MAX_SESSION_ID_ALIASES) {
      for (const k of keys.slice(0, keys.length - MAX_SESSION_ID_ALIASES)) delete map[k];
    }
    storage.setItem(SESSION_ID_ALIAS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** 保存成功后，移除"本次保存之前就已记录"的条目（保存途中新关掉的会话不会被误清） */
export function removePendingRemovedSessions(ids: string[], storage: StorageLike | undefined): void {
  if (!ids.length || !storage) return;
  try {
    const drop = new Set(ids);
    const remain = readPendingRemovedSessions(storage).filter((id) => !drop.has(id));
    if (remain.length === 0) {
      storage.removeItem(PENDING_REMOVED_SESSIONS_KEY);
    } else {
      storage.setItem(PENDING_REMOVED_SESSIONS_KEY, JSON.stringify(remain));
    }
  } catch {
    /* ignore */
  }
}

/** 取当前浏览器的 localStorage（SSR / 无痕受限时返回 undefined） */
export function getLocalStorageSafe(): StorageLike | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}
