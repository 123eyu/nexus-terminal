import type { TransferTask } from './transfers.types';

/**
 * 把内部任务对象拍成「对外的状态响应」。
 *
 * ⚠️ 前端要靠这里的字段画出「**哪台服务器**上的什么 → **哪台服务器**上的哪个路径」：
 *    - sourceConnectionId  源服务器
 *    - targetConnectionIds 目标服务器（去重；一个任务可以同时发往多台）
 *    - sourceItems         源条目（含完整路径，name 用于卡片标题）
 *    - remoteTargetPath    目标目录
 * 少任何一个，任务卡就只能显示出一半的信息（曾经就漏了目标服务器）。
 *
 * 抽成纯函数是为了能单测：不碰 DB、不碰 SSH。
 */
export function serializeTransferTask(task: TransferTask) {
  const payload = task.payload || ({} as TransferTask['payload']);

  return {
    ...task,
    subTasks: task.subTasks.map(st => ({ ...st })),
    sourceConnectionId: payload.sourceConnectionId,
    targetConnectionIds: [...new Set(payload.connectionIds || [])],
    sourceItems: (payload.sourceItems || []).map(item => ({ ...item })),
    remoteTargetPath: payload.remoteTargetPath,
  };
}
