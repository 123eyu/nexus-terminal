import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PENDING_REMOVED_SESSIONS,
  MAX_SESSION_ID_ALIASES,
  PENDING_REMOVED_SESSIONS_KEY,
  SESSION_ID_ALIAS_KEY,
  markSessionRemovedPendingSync,
  readPendingRemovedSessions,
  readSessionIdAliases,
  recordSessionIdAlias,
  removePendingRemovedSessions,
  type StorageLike,
} from '../src/utils/pendingRemoval.ts';
import { resolveSnapshotSessionId } from '../src/utils/workspaceSnapshot.ts';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

// --- 待清理清单 ---

test('markSessionRemovedPendingSync：同一会话重复关闭不会写两条', () => {
  const s = memoryStorage();
  markSessionRemovedPendingSync('s1', s, resolveSnapshotSessionId);
  markSessionRemovedPendingSync('s1', s, resolveSnapshotSessionId);
  assert.deepEqual(readPendingRemovedSessions(s), ['s1']);
});

test('markSessionRemovedPendingSync：同时记录别名表里的快照旧 ID', () => {
  // 刷新恢复出来的会话是新本地 ID，快照里还是旧 ID；只记一个的话剔除会 miss → 会话复活
  const s = memoryStorage();
  recordSessionIdAlias('local-new', 'snapshot-old', s);
  markSessionRemovedPendingSync('local-new', s, resolveSnapshotSessionId);

  const list = readPendingRemovedSessions(s);
  assert.ok(list.includes('local-new'));
  assert.ok(list.includes('snapshot-old'));
});

test('markSessionRemovedPendingSync：只保留最近 N 条，防止 localStorage 无限增长', () => {
  const s = memoryStorage();
  for (let i = 1; i <= MAX_PENDING_REMOVED_SESSIONS + 5; i++) {
    markSessionRemovedPendingSync(`s${i}`, s, resolveSnapshotSessionId);
  }
  const list = readPendingRemovedSessions(s);
  assert.equal(list.length, MAX_PENDING_REMOVED_SESSIONS);
  // 保留的是最近的
  assert.equal(list[list.length - 1], `s${MAX_PENDING_REMOVED_SESSIONS + 5}`);
  assert.ok(!list.includes('s1'));
});

test('markSessionRemovedPendingSync：storage 不可用时静默返回', () => {
  assert.doesNotThrow(() => markSessionRemovedPendingSync('s1', undefined, resolveSnapshotSessionId));
  assert.doesNotThrow(() => markSessionRemovedPendingSync('', memoryStorage(), resolveSnapshotSessionId));
});

test('removePendingRemovedSessions：只清指定条目，保存途中新关掉的会话保留', () => {
  const s = memoryStorage();
  markSessionRemovedPendingSync('s1', s, resolveSnapshotSessionId);
  markSessionRemovedPendingSync('s2', s, resolveSnapshotSessionId);

  // 保存时只带上了 s1（s2 是在保存发起之后才关的）
  removePendingRemovedSessions(['s1'], s);
  assert.deepEqual(readPendingRemovedSessions(s), ['s2']);
});

test('removePendingRemovedSessions：清空后直接删 key（不留空数组）', () => {
  const s = memoryStorage();
  markSessionRemovedPendingSync('s1', s, resolveSnapshotSessionId);
  removePendingRemovedSessions(['s1'], s);
  assert.equal(s.dump()[PENDING_REMOVED_SESSIONS_KEY], undefined);
});

test('readPendingRemovedSessions：JSON 损坏或类型不对时返回空数组', () => {
  assert.deepEqual(readPendingRemovedSessions(memoryStorage({ [PENDING_REMOVED_SESSIONS_KEY]: '{oops' })), []);
  assert.deepEqual(readPendingRemovedSessions(memoryStorage({ [PENDING_REMOVED_SESSIONS_KEY]: '{"a":1}' })), []);
  assert.deepEqual(readPendingRemovedSessions(undefined), []);
});

test('readPendingRemovedSessions：过滤掉空串与非字符串条目', () => {
  const s = memoryStorage({ [PENDING_REMOVED_SESSIONS_KEY]: '["s1","",null,3]' });
  assert.deepEqual(readPendingRemovedSessions(s), ['s1']);
});

// --- 别名表 ---

test('recordSessionIdAlias：本地 ID 等于快照 ID 时不记录（没有别名关系）', () => {
  const s = memoryStorage();
  recordSessionIdAlias('same', 'same', s);
  assert.deepEqual(readSessionIdAliases(s), {});
});

test('recordSessionIdAlias：只保留最近 N 条', () => {
  const s = memoryStorage();
  for (let i = 1; i <= MAX_SESSION_ID_ALIASES + 3; i++) {
    recordSessionIdAlias(`local${i}`, `snap${i}`, s);
  }
  const map = readSessionIdAliases(s);
  assert.equal(Object.keys(map).length, MAX_SESSION_ID_ALIASES);
  assert.equal(map[`local${MAX_SESSION_ID_ALIASES + 3}`], `snap${MAX_SESSION_ID_ALIASES + 3}`);
});

test('readSessionIdAliases：数组或损坏内容不当成别名表', () => {
  assert.deepEqual(readSessionIdAliases(memoryStorage({ [SESSION_ID_ALIAS_KEY]: '[]' })), {});
  assert.deepEqual(readSessionIdAliases(memoryStorage({ [SESSION_ID_ALIAS_KEY]: 'nope' })), {});
});
