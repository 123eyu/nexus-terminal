/**
 * 工作区同步的诊断日志（统一前缀与配色）。
 *
 * 单独成文的原因：采集/恢复拆分到多个文件后，日志格式必须保持一致，
 * 否则排查"哪一步没恢复上"时要按文件去猜前缀。
 */
const PREFIX = '%c[WorkspaceSync]';

export const logSync = (message: string, ...args: any[]) => {
  console.log(`${PREFIX} ${message}`, 'color: #10b981; font-weight: bold;', ...args);
};

export const logSyncWarn = (message: string, ...args: any[]) => {
  console.warn(`${PREFIX} ${message}`, 'color: #f59e0b; font-weight: bold;', ...args);
};

export const logSyncError = (message: string, ...args: any[]) => {
  console.error(`${PREFIX} ${message}`, 'color: #ef4444; font-weight: bold;', ...args);
};
