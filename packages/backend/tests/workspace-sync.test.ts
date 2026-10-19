import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateLeaseWrite,
  removeSessionFromSnapshot,
} from '../src/workspace-sync/workspace-sync.pure.ts';

// --- 租约判定 ---

test('evaluateLeaseWrite：无持有者时首个写入者获得租约', () => {
  assert.deepEqual(evaluateLeaseWrite(null, 'tab-a'), { accepted: true, activeClientId: 'tab-a' });
  assert.deepEqual(evaluateLeaseWrite(undefined, 'tab-a'), { accepted: true, activeClientId: 'tab-a' });
  assert.deepEqual(evaluateLeaseWrite('', 'tab-a'), { accepted: true, activeClientId: 'tab-a' });
});

test('evaluateLeaseWrite：持有者自己写入始终可写', () => {
  assert.deepEqual(evaluateLeaseWrite('tab-a', 'tab-a'), { accepted: true, activeClientId: 'tab-a' });
});

test('evaluateLeaseWrite：被接管后旧客户端的写入必须被拒，并回传持有者', () => {
  // 这是"关闭会话后刷新又复活"的根因：旧页面自动保存把会话写回去了
  const decision = evaluateLeaseWrite('tab-b', 'tab-a');
  assert.equal(decision.accepted, false);
  assert.equal(decision.activeClientId, 'tab-b');
});

// --- 快照剔除会话 ---

const baseSnapshot = () => ({
  sessions: [
    { sessionId: 's1', connectionId: 7 },
    { sessionId: 's2', connectionId: 7 },
    { sessionId: 's3', connectionId: 9 },
  ],
  sessionOrder: ['s1', 's2', 's3'],
  activeSessionId: 's2',
  fileManagers: {
    's1:terminal-0': { currentPath: '/' },
    's2:default': { currentPath: '/root' },
    's3:terminal-0': { currentPath: '/etc' },
  },
});

test('removeSessionFromSnapshot：只删目标会话，同连接的其他会话必须保留', () => {
  const result = removeSessionFromSnapshot(baseSnapshot(), 's1');
  assert.deepEqual(result.state.sessions!.map((s) => s.sessionId), ['s2', 's3']);
  assert.equal(result.remainingSessionsCount, 2);
  assert.equal(result.notFound, false);
});

test('removeSessionFromSnapshot：同步维护 sessionOrder 与 activeSessionId', () => {
  const result = removeSessionFromSnapshot(baseSnapshot(), 's2');
  assert.deepEqual(result.state.sessionOrder, ['s1', 's3']);
  // 删的是当前活动会话 → 回落到剩余列表最后一个
  assert.equal(result.state.activeSessionId, 's3');
});

test('removeSessionFromSnapshot：删到最后一个会话时 activeSessionId 置空', () => {
  const snap = {
    sessions: [{ sessionId: 'only' }],
    sessionOrder: ['only'],
    activeSessionId: 'only',
    fileManagers: { 'only:default': {} },
  };
  const result = removeSessionFromSnapshot(snap, 'only');
  assert.equal(result.remainingSessionsCount, 0);
  assert.equal(result.state.activeSessionId, null);
  assert.deepEqual(result.state.sessionOrder, []);
});

test('removeSessionFromSnapshot：只清理该会话的文件管理器实例状态', () => {
  const result = removeSessionFromSnapshot(baseSnapshot(), 's2');
  assert.deepEqual(Object.keys(result.state.fileManagers!), ['s1:terminal-0', 's3:terminal-0']);
});

test('removeSessionFromSnapshot：不修改入参（快照可安全用于回滚）', () => {
  const snap = baseSnapshot();
  const before = JSON.stringify(snap);
  removeSessionFromSnapshot(snap, 's1');
  assert.equal(JSON.stringify(snap), before);
});

test('removeSessionFromSnapshot：目标不存在时保持原样并标记 notFound', () => {
  const result = removeSessionFromSnapshot(baseSnapshot(), 'missing');
  assert.equal(result.notFound, true);
  assert.equal(result.remainingSessionsCount, 3);
});

test('removeSessionFromSnapshot：快照没有 sessions 字段时不抛错', () => {
  const result = removeSessionFromSnapshot({}, 's1');
  assert.equal(result.notFound, true);
  assert.equal(result.remainingSessionsCount, 0);
});
