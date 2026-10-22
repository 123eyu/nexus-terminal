import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serializeTransferTask } from '../src/transfers/transfers.serialize.ts';
import type { TransferTask } from '../src/transfers/transfers.types.ts';

/**
 * 这些断言守的是「前端能不能画出 A 服务器 → B 服务器」。
 * 曾经状态接口只回 sourceConnectionId + remoteTargetPath，前端因此只能显示
 * 「源服务器 (文件名 -> 路径)」，用户看不出文件被发到了哪台服务器。
 */
function makeTask(overrides: Partial<TransferTask> = {}): TransferTask {
  return {
    taskId: 't-1',
    status: 'in-progress',
    userId: 1,
    createdAt: new Date('2026-10-22T10:00:00Z'),
    updatedAt: new Date('2026-10-22T10:00:05Z'),
    subTasks: [
      {
        subTaskId: 's-1',
        connectionId: 2,
        sourceItemName: 'nginx-config',
        status: 'transferring',
        progress: 40,
        transferMethodUsed: 'rsync',
      },
      {
        subTaskId: 's-2',
        connectionId: 2,
        sourceItemName: 'nginx-config',
        status: 'queued',
      },
    ],
    payload: {
      sourceConnectionId: 1,
      connectionIds: [2, 3, 2],
      sourceItems: [{ name: 'nginx-config', path: '/etc/nginx', type: 'directory' }],
      remoteTargetPath: '/root/docker',
      transferMethod: 'auto',
    },
    ...overrides,
  };
}

test('状态响应必须带源服务器、目标服务器、源条目与目标路径', () => {
  const serialized = serializeTransferTask(makeTask());

  assert.equal(serialized.sourceConnectionId, 1, '少了源服务器 ID，前端画不出起点');
  assert.deepEqual(serialized.targetConnectionIds, [2, 3], '目标服务器必须去重且保留顺序');
  assert.deepEqual(
    serialized.sourceItems,
    [{ name: 'nginx-config', path: '/etc/nginx', type: 'directory' }],
    '源条目要带完整路径，卡片才知道文件原来在哪'
  );
  assert.equal(serialized.remoteTargetPath, '/root/docker');
  assert.equal(serialized.subTasks.length, 2);
});

test('子任务必须深拷贝：返回值被前端/调用方改动不能污染内部任务', () => {
  const task = makeTask();
  const serialized = serializeTransferTask(task);
  serialized.subTasks[0].progress = 99;

  assert.equal(task.subTasks[0].progress, 40);
});

test('payload 缺字段时不能抛异常（老任务/脏数据也要能列出来）', () => {
  const task = makeTask();
  // @ts-expect-error 故意构造不完整 payload
  task.payload = { sourceConnectionId: 7 };

  const serialized = serializeTransferTask(task);
  assert.equal(serialized.sourceConnectionId, 7);
  assert.deepEqual(serialized.targetConnectionIds, []);
  assert.deepEqual(serialized.sourceItems, []);
  assert.equal(serialized.remoteTargetPath, undefined);
});
