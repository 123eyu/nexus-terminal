export interface InitiateTransferPayload {
  sourceConnectionId: number; // ID of the source server (Server A)
  connectionIds: number[];    // IDs of the target servers (Server B, C, etc.)
  sourceItems: { name: string; path: string; type: 'file' | 'directory' }[];
  remoteTargetPath: string;
  /**
   * - `auto`：按 rsync → scp → relay（经由本机中转）的优先级自动选
   * - `rsync` / `scp`：用户显式指定，缺前置条件直接报错
   * - `relay`：强制经由后端中转，不依赖源机上的任何命令
   */
  transferMethod: 'auto' | 'rsync' | 'scp' | 'relay';
}

export interface TransferSubTask {
  subTaskId: string;
  connectionId: number;
  sourceItemName: string;
  status: 'queued' | 'connecting' | 'transferring' | 'completed' | 'failed' | 'cancelling' | 'cancelled'; // +++ 新增状态 +++
  progress?: number; // 0-100
  message?: string; // 例如错误信息
  transferMethodUsed?: 'rsync' | 'scp' | 'relay';
  startTime?: Date;
  endTime?: Date;
}

export interface TransferTask {
  taskId: string;
  status: 'queued' | 'in-progress' | 'completed' | 'failed' | 'partially-completed' | 'cancelling' | 'cancelled'; // +++ 新增状态 +++
  userId: string | number; // 添加用户ID字段
  createdAt: Date;
  updatedAt: Date;
  subTasks: TransferSubTask[];
  overallProgress?: number; // 0-100, 根据子任务计算
  payload: InitiateTransferPayload; // 存储原始请求负载，方便追溯
}