import * as path from 'path';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid'; 
import { Client, ConnectConfig, SFTPWrapper } from 'ssh2';
import { InitiateTransferPayload, TransferTask, TransferSubTask } from './transfers.types';
import { getConnectionWithDecryptedCredentials } from '../connections/connection.service';
import type { ConnectionWithFolders, DecryptedConnectionCredentials } from '../types/connection.types';
// 命令拼装抽成纯函数（rsync 源路径的尾斜杠会改变语义，见 transfer-command.ts 注释）
import { buildTransferCommandString, escapeShellArg } from './transfer-command';
import { serializeTransferTask } from './transfers.serialize';
import { RSYNC_PROBE_SCRIPT, parseRsyncProbe, buildRsyncInstallCommands } from './rsync-installer';
// 兜底通道：两台机器都不需要装任何东西，后端自己读源、写目标
import { relayTransfer, createSftp } from './transfers.relay';

/** 进度文案里用的体积格式化（只用于人读，不参与任何判断） */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}


export class TransfersService {
  private transferTasks: Map<string, TransferTask> = new Map();
  private taskAbortControllers: Map<string, AbortController> = new Map(); // +++ 用于存储任务的 AbortController +++
  private readonly TEMP_KEY_PREFIX = 'nexus_target_key_';
  // 目标机密码 / 私钥口令也要落到源机 /tmp（交给 sshpass -f 读），
  // 这样密码不会出现在 `ps aux` 的完整命令行里
  private readonly TEMP_SECRET_PREFIX = 'nexus_target_secret_';
  private readonly MAX_CONCURRENT_SUB_TASKS = 5; 

  constructor() {
    console.info('[TransfersService] Initialized.');
  }

  public async initiateNewTransfer(payload: InitiateTransferPayload, userId: string | number): Promise<TransferTask> {
    const taskId = uuidv4();
    const now = new Date();
    const subTasks: TransferSubTask[] = [];
    const abortController = new AbortController(); 
    this.taskAbortControllers.set(taskId, abortController); 

    // 每个 (目标服务器, 源文件) 组合都是一个子任务
    for (const connectionId of payload.connectionIds) { // 目标服务器ID列表
      for (const item of payload.sourceItems) { // 源服务器上的文件/目录列表
        const subTaskId = uuidv4();
        subTasks.push({
          subTaskId,
          connectionId, // 这是目标服务器的ID
          sourceItemName: item.name, // 源文件的名称，用于标识
          status: 'queued',
          startTime: now,
        });
      }
    }

    const newTask: TransferTask = {
      taskId,
      status: 'queued',
      userId,
      createdAt: now,
      updatedAt: now,
      subTasks,
      payload, // payload 包含 sourceConnectionId
    };

    this.transferTasks.set(taskId, newTask);
    console.info(`[TransfersService] New transfer task created: ${taskId} for source ${payload.sourceConnectionId} with ${subTasks.length} sub-tasks.`);

    // 异步启动传输，不阻塞当前请求
    this.processTransferTask(taskId, abortController.signal).catch(error => { // +++ 传递 signal +++
        console.error(`[TransfersService] Error processing task ${taskId} in background:`, error);
        // 如果不是因为终止操作导致的错误，则更新状态
        if (error.name !== 'AbortError') {
          this.updateOverallTaskStatus(taskId, 'failed', `Background processing error: ${error.message}`);
        }
    });

    return { ...newTask }; // 返回任务的副本
  }

  public async cancelTransferTask(taskId: string, userId: string | number): Promise<boolean> {
    const task = this.transferTasks.get(taskId);
    if (!task || task.userId !== userId) {
      console.warn(`[TransfersService] Attempt to cancel non-existent task ${taskId} or task not owned by user ${userId}.`);
      return false;
    }

    const abortController = this.taskAbortControllers.get(taskId);
    if (abortController) {
      console.info(`[TransfersService] Cancelling task ${taskId}.`);
      abortController.abort(); // 触发终止信号

      // 更新主任务状态
      // 假设 'cancelling' 和 'cancelled' 是有效的状态
      if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') {
        this.updateOverallTaskStatus(taskId, 'cancelling', 'Task cancellation initiated by user.');
        // 可以在 processTransferTask 的 finally 中将状态设置为 'cancelled'
      }

      // 更新所有未完成的子任务状态
      task.subTasks.forEach(subTask => {
        if (subTask.status !== 'completed' && subTask.status !== 'failed' && subTask.status !== 'cancelled') {
          this.updateSubTaskStatus(taskId, subTask.subTaskId, 'cancelled', subTask.progress, 'Cancelled due to parent task cancellation.');
        }
      });
      
      return true;
    }
    console.warn(`[TransfersService] No AbortController found for task ${taskId} to cancel.`);
    return false;
  }

  private buildSshConnectConfig(
    connectionInfo: ConnectionWithFolders,
    credentials: DecryptedConnectionCredentials
  ): ConnectConfig {
    const config: ConnectConfig = {
      host: connectionInfo.host,
      port: connectionInfo.port || 22,
      username: connectionInfo.username,
      readyTimeout: 20000, // 20 seconds
      keepaliveInterval: 10000, // 10 seconds
    };
    if (connectionInfo.auth_method === 'password' && credentials.decryptedPassword) {
      config.password = credentials.decryptedPassword;
    } else if (connectionInfo.auth_method === 'key' && credentials.decryptedPrivateKey) {
      config.privateKey = credentials.decryptedPrivateKey;
      if (credentials.decryptedPassphrase) {
        config.passphrase = credentials.decryptedPassphrase;
      }
    }
    return config;
  }

  private async processTransferTask(taskId: string, signal: AbortSignal): Promise<void> { // +++ 接收 AbortSignal +++
    const task = this.transferTasks.get(taskId);
    if (!task) {
      console.error(`[TransfersService] Task ${taskId} not found for processing.`);
      return;
    }

    if (signal.aborted) {
      console.info(`[TransfersService] Task ${taskId} was cancelled before processing started.`);
      this.updateOverallTaskStatus(taskId, 'cancelled', 'Cancelled before start.');
      this.taskAbortControllers.delete(taskId); // 清理
      return;
    }

    this.updateOverallTaskStatus(taskId, 'in-progress');
    let sourceSshClient: Client | undefined;

    try {
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
      const sourceConnectionResult = await getConnectionWithDecryptedCredentials(task.payload.sourceConnectionId);
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');

      if (!sourceConnectionResult || !sourceConnectionResult.connection) {
        throw new Error(`Source connection with ID ${task.payload.sourceConnectionId} not found or inaccessible.`);
      }
      const { connection: sourceConnection, ...sourceCredentials } = sourceConnectionResult;

      sourceSshClient = new Client();
      const sourceConnectConfig = this.buildSshConnectConfig(sourceConnection, sourceCredentials);

      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new DOMException('Transfer cancelled by user.', 'AbortError'));

        const onAbort = () => {
          sourceSshClient?.end(); // 尝试关闭连接
          reject(new DOMException('Transfer cancelled by user.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });

        sourceSshClient!
          .on('ready', () => {
            signal.removeEventListener('abort', onAbort);
            console.info(`[TransfersService] SSH connection established to source server ${sourceConnection.host} for task ${taskId}.`);
            resolve();
          })
          .on('error', (err) => {
            signal.removeEventListener('abort', onAbort);
            console.error(`[TransfersService] SSH connection error to source server ${sourceConnection.host} for task ${taskId}:`, err);
            reject(err);
          })
          .on('close', () => {
             signal.removeEventListener('abort', onAbort);
             console.info(`[TransfersService] SSH connection closed to source server ${sourceConnection.host} for task ${taskId}.`);
          })
          .connect(sourceConnectConfig);
      });

      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');

      // New concurrent processing logic for sub-tasks
      const subTaskExecutionPromises: Promise<void>[] = []; // Stores promises for all initiated sub-tasks
      let currentlyActiveSubTasks = 0;
      const maxConcurrentSubTasks = this.MAX_CONCURRENT_SUB_TASKS;
      let currentSubTaskIndex = 0; // Points to the next sub-task in task.subTasks to be processed
      const totalSubTasks = task.subTasks.length;

      console.info(`[TransfersService] Task ${taskId}: Starting to process ${totalSubTasks} sub-tasks with max concurrency of ${maxConcurrentSubTasks}.`);

      // Wrapper function to process a single sub-task and manage active counts
      const processSingleSubTaskWrapper = async (subTask: TransferSubTask, subTaskIndexForLog: number): Promise<void> => {
        console.info(`[TransfersService] Task ${taskId}: Sub-task ${subTask.subTaskId} (index ${subTaskIndexForLog}) started. Active: ${currentlyActiveSubTasks}/${maxConcurrentSubTasks}`);
        
        if (signal.aborted) {
          this.updateSubTaskStatus(taskId, subTask.subTaskId, 'cancelled', undefined, 'Cancelled before start.');
          console.info(`[TransfersService] Task ${taskId}: Sub-task ${subTask.subTaskId} cancelled before processing.`);
          return; // Do not process this sub-task
        }

        const currentSourceItem = task.payload.sourceItems.find(it => it.name === subTask.sourceItemName);
        if (!currentSourceItem) {
          this.updateSubTaskStatus(taskId, subTask.subTaskId, 'failed', undefined, `Source item '${subTask.sourceItemName}' not found in payload.`);
          console.warn(`[TransfersService] Task ${taskId}: Sub-task ${subTask.subTaskId} (item: ${subTask.sourceItemName}) - Source item not found.`);
          return;
        }

        try {
          if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
          this.updateSubTaskStatus(taskId, subTask.subTaskId, 'connecting', undefined, `Preparing transfer for ${currentSourceItem.name} to target ID ${subTask.connectionId}`);
          console.info(`[TransfersService] Task ${taskId}: Sub-task ${subTask.subTaskId} (item: ${currentSourceItem.name}) - Connecting to target ID ${subTask.connectionId}.`);
          
          const targetConnectionResult = await getConnectionWithDecryptedCredentials(subTask.connectionId);
          if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');

          if (!targetConnectionResult || !targetConnectionResult.connection) {
            this.updateSubTaskStatus(taskId, subTask.subTaskId, 'failed', undefined, `Target connection with ID ${subTask.connectionId} not found.`);
            return;
          }
          const { connection: targetConnection, ...targetCredentials } = targetConnectionResult;

          await this.executeRemoteTransferOnSource(
            taskId,
            subTask.subTaskId,
            sourceSshClient!,
            sourceConnection,
            currentSourceItem,
            targetConnection,
            targetCredentials,
            task.payload.remoteTargetPath,
            task.payload.transferMethod,
            signal // +++ Pass signal +++
          );
        } catch (subTaskError: any) {
          if (subTaskError.name === 'AbortError') {
            this.updateSubTaskStatus(taskId, subTask.subTaskId, 'cancelled', undefined, 'Sub-task cancelled by user.');
            console.info(`[TransfersService] Task ${taskId}: Sub-task ${subTask.subTaskId} (item: ${currentSourceItem.name}) was cancelled.`);
          } else {
            console.error(`[TransfersService] Task ${taskId}: Error in sub-task ${subTask.subTaskId} (item: ${currentSourceItem.name}) wrapper:`, subTaskError.message, subTaskError.stack);
            const subTaskInstance = task.subTasks.find(st => st.subTaskId === subTask.subTaskId);
            if (subTaskInstance && subTaskInstance.status !== 'failed' && subTaskInstance.status !== 'completed' && subTaskInstance.status !== 'cancelled') {
               this.updateSubTaskStatus(taskId, subTask.subTaskId, 'failed', undefined, subTaskError.message || `Unknown error in sub-task ${subTask.subTaskId} wrapper.`);
            }
          }
        }
      };
      
      await new Promise<void>((resolveAllTasksCompleted, rejectAllTasksCompleted) => {
        const onAbortOverall = () => {
          console.info(`[TransfersService] Task ${taskId}: Overall cancellation signal received during sub-task processing phase.`);
          // Attempt to clean up / signal running sub-tasks is handled by individual sub-task signal checks
          rejectAllTasksCompleted(new DOMException('Transfer cancelled by user.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbortOverall, { once: true });

        const launchNextSubTaskIfPossible = () => {
          if (signal.aborted) { // Check before launching new sub-tasks
            console.info(`[TransfersService] Task ${taskId}: Abort signal detected, not launching more sub-tasks.`);
            if (currentlyActiveSubTasks === 0) resolveAllTasksCompleted(); // If no tasks are active, resolve.
            return;
          }

          while (currentlyActiveSubTasks < maxConcurrentSubTasks && currentSubTaskIndex < totalSubTasks) {
            const subTaskToProcess = task.subTasks[currentSubTaskIndex];
            // If sub-task is already marked (e.g. cancelled by overall cancel before it started), skip.
            if (subTaskToProcess.status === 'cancelled') {
                console.info(`[TransfersService] Task ${taskId}: Skipping already cancelled sub-task ${subTaskToProcess.subTaskId}`);
                currentSubTaskIndex++;
                if (currentSubTaskIndex === totalSubTasks && currentlyActiveSubTasks === 0) {
                     signal.removeEventListener('abort', onAbortOverall);
                     resolveAllTasksCompleted();
                }
                continue; // check next sub-task
            }

            const capturedIndexForLog = currentSubTaskIndex;
            currentlyActiveSubTasks++;
            currentSubTaskIndex++;

            const taskPromise = processSingleSubTaskWrapper(subTaskToProcess, capturedIndexForLog)
              .finally(() => {
                currentlyActiveSubTasks--;
                if (signal.aborted && currentlyActiveSubTasks === 0) {
                   console.info(`[TransfersService] Task ${taskId}: All active sub-tasks finished after main abort signal.`);
                   signal.removeEventListener('abort', onAbortOverall);
                   resolveAllTasksCompleted(); // All active tasks completed/aborted after main signal
                   return;
                }
                if (currentSubTaskIndex < totalSubTasks && !signal.aborted) {
                  launchNextSubTaskIfPossible();
                } else if (currentlyActiveSubTasks === 0) {
                  console.info(`[TransfersService] Task ${taskId}: All ${totalSubTasks} sub-tasks have completed or been skipped after processing.`);
                  signal.removeEventListener('abort', onAbortOverall);
                  resolveAllTasksCompleted();
                }
              });
            subTaskExecutionPromises.push(taskPromise);
          }
          if (currentSubTaskIndex === totalSubTasks && currentlyActiveSubTasks === 0 && !signal.aborted) {
             console.info(`[TransfersService] Task ${taskId}: All sub-tasks processed (no active, no more to launch).`);
             signal.removeEventListener('abort', onAbortOverall);
             resolveAllTasksCompleted();
          }
        };

        if (totalSubTasks === 0) {
            console.info(`[TransfersService] Task ${taskId}: No sub-tasks to process.`);
            signal.removeEventListener('abort', onAbortOverall);
            resolveAllTasksCompleted();
            return;
        }
        if (signal.aborted) { // Check if cancelled even before starting the loop
            console.info(`[TransfersService] Task ${taskId}: Cancelled before sub-task loop initiation.`);
            task.subTasks.forEach(st => { // Mark all sub-tasks as cancelled
                 if(st.status !== 'completed' && st.status !== 'failed') this.updateSubTaskStatus(taskId, st.subTaskId, 'cancelled', undefined, 'Task cancelled before sub-task execution.');
            });
            signal.removeEventListener('abort', onAbortOverall);
            rejectAllTasksCompleted(new DOMException('Transfer cancelled by user.', 'AbortError'));
            return;
        }
        launchNextSubTaskIfPossible();
      });
      
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.info(`[TransfersService] Task ${taskId} processing was aborted.`);
        this.updateOverallTaskStatus(taskId, 'cancelled', 'Transfer cancelled by user.');
      } else {
        console.error(`[TransfersService] Major error processing task ${taskId}:`, error);
        this.updateOverallTaskStatus(taskId, 'failed', error.message || 'Failed to process task due to a major error.');
      }
    } finally {
      if (sourceSshClient) { // 直接检查 sourceSshClient 是否存在
        try {
          sourceSshClient.end();
          console.info(`[TransfersService] SSH connection to source server explicitly closed for task ${taskId}.`);
        } catch (e) {
          console.warn(`[TransfersService] Error ending sourceSshClient for task ${taskId}:`, e)
        }
      }
      this.finalizeOverallTaskStatus(taskId); // Ensure final status is set
      this.taskAbortControllers.delete(taskId); 
      if (task) { // task 可能未定义如果 taskId 错误
        console.info(`[TransfersService] Task ${taskId} processing finished. Final status: ${task.status}.`);
      } else {
        console.info(`[TransfersService] Task ${taskId} processing finished (task object was not found at the end).`);
      }
    }
  }

  private async checkCommandOnSource(client: Client, command: string): Promise<string | null> {
    return new Promise((resolve) => {
      const checkCmd = `command -v ${escapeShellArg(command)} 2>/dev/null`;
      client.exec(checkCmd, (err, stream) => {
        if (err) {
          return resolve(null);
        }
        let stdout = '';
        stream
          .on('data', (data: Buffer) => stdout += data.toString())
          .on('close', (code: number) => {
            const foundPath = stdout.trim();
            if (code === 0 && foundPath) {
              resolve(foundPath);
            } else {
              resolve(null);
            }
          })
          .stderr.on('data', (data: Buffer) => { 
          });
      });
    });
  }

  // --- rsync 自动安装 -------------------------------------------------------
  // 每台主机只尝试一次；并发子任务共享同一个 Promise，避免 5 个子任务同时 apt install
  private rsyncInstallAttempts: Map<string, Promise<boolean>> = new Map();

  /** 在已连接的 client 上跑一条命令，带超时（安装命令可能很久，绝不能无限等） */
  private execCommandOnClient(
    client: Client,
    command: string,
    timeoutMs = 30000
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const settle = (code: number | null, timedOut = false) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      };

      client.exec(command, (err, stream) => {
        if (err) return settle(null);
        timer = setTimeout(() => {
          try { stream.close(); } catch { /* stream 可能已关闭 */ }
          settle(null, true);
        }, timeoutMs);
        stream
          .on('data', (data: Buffer) => { stdout += data.toString(); })
          .on('close', (code: number | null) => settle(code));
        stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      });
    });
  }

  /**
   * 探测包管理器 + 提权能力，然后尝试装 rsync。
   * 只要有一环不满足就安静放弃（不弹密码、不挂死），交给调用方回退。
   */
  private async installRsyncViaClient(client: Client, hostLabel: string): Promise<boolean> {
    const probe = await this.execCommandOnClient(client, RSYNC_PROBE_SCRIPT, 15000);
    const info = parseRsyncProbe(probe.stdout);
    const commands = buildRsyncInstallCommands(info);

    if (commands.length === 0) {
      console.info(
        `[TransfersService] ${hostLabel}: rsync 缺失，但没有可用的包管理器或没有免密提权，跳过自动安装 ` +
        `(pm=${info.packageManager || 'none'}, root=${info.isRoot}, passwordlessSudo=${info.hasPasswordlessSudo})`
      );
      return false;
    }

    for (const command of commands) {
      console.info(`[TransfersService] ${hostLabel}: 尝试自动安装 rsync → ${command}`);
      const result = await this.execCommandOnClient(client, command, 180000);
      if (result.timedOut) {
        console.warn(`[TransfersService] ${hostLabel}: 自动安装 rsync 超时（180s），放弃该命令`);
        continue;
      }
      if (result.code !== 0) {
        console.warn(`[TransfersService] ${hostLabel}: 自动安装 rsync 失败 (code=${result.code}): ${(result.stderr || '').trim().slice(-300)}`);
        continue;
      }
      const check = await this.execCommandOnClient(client, 'command -v rsync', 10000);
      if (check.code === 0 && check.stdout.trim()) {
        console.info(`[TransfersService] ${hostLabel}: 已自动安装 rsync (${check.stdout.trim()})`);
        return true;
      }
      console.warn(`[TransfersService] ${hostLabel}: 安装命令返回 0，但 rsync 仍然找不到`);
    }
    return false;
  }

  private ensureRsyncOnce(key: string, run: () => Promise<boolean>): Promise<boolean> {
    const existing = this.rsyncInstallAttempts.get(key);
    if (existing) return existing;
    const attempt = run().catch((error: any) => {
      console.warn(`[TransfersService] 自动安装 rsync 出错 (${key}):`, error?.message || error);
      return false;
    });
    this.rsyncInstallAttempts.set(key, attempt);
    return attempt;
  }

  private static hostKey(prefix: string, connection: ConnectionWithFolders): string {
    return `${prefix}:${connection.username}@${connection.host}:${connection.port || 22}`;
  }

  /** 源机复用当前已连的 client（不需要重连） */
  private async ensureRsyncOnSource(client: Client, sourceConnection: ConnectionWithFolders): Promise<string | null> {
    const installed = await this.ensureRsyncOnce(
      TransfersService.hostKey('source', sourceConnection),
      () => this.installRsyncViaClient(client, `source ${sourceConnection.host}`)
    );
    if (!installed) return null;
    return this.checkCommandOnSource(client, 'rsync');
  }

  private async ensureRsyncOnTargetServer(
    targetConnection: ConnectionWithFolders,
    targetCredentials: DecryptedConnectionCredentials
  ): Promise<string | null> {
    const installed = await this.ensureRsyncOnce(
      TransfersService.hostKey('target', targetConnection),
      async () => {
        const client = new Client();
        try {
          await new Promise<void>((resolve, reject) => {
            client
              .on('ready', () => resolve())
              .on('error', (err) => reject(err))
              .connect(this.buildSshConnectConfig(targetConnection, targetCredentials));
          });
          return await this.installRsyncViaClient(client, `target ${targetConnection.host}`);
        } catch (error: any) {
          console.warn(`[TransfersService] target ${targetConnection.host}: 连接失败，无法自动安装 rsync:`, error?.message || error);
          return false;
        } finally {
          try { client.end(); } catch { /* 已断开 */ }
        }
      }
    );
    if (!installed) return null;
    return this.checkCommandOnTargetServer(targetConnection, targetCredentials, 'rsync');
  }

  private async checkCommandOnTargetServer(targetConnection: ConnectionWithFolders, targetCredentials: DecryptedConnectionCredentials, command: string): Promise<string | null> {
    const targetClient = new Client();
    const connectConfig = this.buildSshConnectConfig(targetConnection, targetCredentials);
    let foundCommandPath: string | null = null;


    try {
      await new Promise<void>((resolve, reject) => {
        targetClient
          .on('ready', () => {
            console.info(`[TransfersService] SSH connection established to target server ${targetConnection.host} for command check.`);
            resolve();
          })
          .on('error', (err) => {
            console.error(`[TransfersService] SSH connection error to target server ${targetConnection.host} for command check:`, err);
            reject(err);
          })
          .on('close', () => {
             console.info(`[TransfersService] SSH connection closed to target server ${targetConnection.host} after command check.`);
          })
          .connect(connectConfig);
      });

      foundCommandPath = await new Promise((resolve) => {
        const checkCmd = `command -v ${escapeShellArg(command)} 2>/dev/null`;
        targetClient.exec(checkCmd, (err, stream) => {
          if (err) {
            return resolve(null);
          }
          let stdout = '';
          stream
            .on('data', (data: Buffer) => stdout += data.toString())
            .on('close', (code: number) => {
              const pathOutput = stdout.trim();
              if (code === 0 && pathOutput) {
                resolve(pathOutput);
              } else {
                resolve(null);
              }
            })
            .stderr.on('data', (data: Buffer) => {
            });
        });
      });
    } catch (error) {
      foundCommandPath = null; // Ensure it's null on error
    } finally {
      targetClient.end();
    }
    return foundCommandPath;
  }
 
  /** 把一段敏感内容（私钥 / 密码 / 口令）以 0600 权限写到源机指定路径 */
  private async uploadSecretToSourceViaSftp(client: Client, secretContent: string, remotePath: string): Promise<void> {
    const SFTP_UPLOAD_TIMEOUT_MS = 30000; // 30 seconds timeout for SFTP credential upload

    return new Promise((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | null = null;
      let sftpSession: SFTPWrapper | null = null; // To ensure sftp.end() can be called in timeout

      const cleanupAndReject = (errMsg: string, errObj?: any) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        sftpSession?.end();
        reject(new Error(errMsg));
      };

      timeoutHandle = setTimeout(() => {
        cleanupAndReject(`SFTP upload to ${remotePath} timed out after ${SFTP_UPLOAD_TIMEOUT_MS / 1000}s.`);
      }, SFTP_UPLOAD_TIMEOUT_MS);

      client.sftp((err, sftp) => {
        sftpSession = sftp; // Store session for potential cleanup
        if (err) {
          return cleanupAndReject(`SFTP session error for credential upload: ${err.message}`, err);
        }
        if (!sftp) {
          return cleanupAndReject(`SFTP session error: SFTP object is null.`);
        }
        const stream = sftp.createWriteStream(remotePath, { mode: 0o600 });
        
        stream.on('error', (writeErr: Error) => {
          cleanupAndReject(`Failed to write credential to ${remotePath} on source: ${writeErr.message}`, writeErr);
        });

        // Listen to 'close' instead of 'finish' for more reliability
        stream.on('close', () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          console.info(`[TransfersService] Temporary credential uploaded to source at ${remotePath}`);
          sftp.end();
          resolve();
        });
 
        let contentToWrite = secretContent;
        if (!contentToWrite.endsWith('\n')) {
          contentToWrite += '\n';
        }
        stream.end(contentToWrite);
      });
    });
  }
 
  private async deleteFileOnSourceViaSftp(client: Client, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(new Error(`SFTP session error for credential deletion: ${err.message}`));
        sftp.unlink(remotePath, (unlinkErr) => {
          sftp.end(); // Ensure sftp session is closed
          if (unlinkErr) {
            // Log but don't necessarily reject if file just wasn't there (though it should be)
            console.warn(`[TransfersService] Failed to delete temporary credential ${remotePath} from source:`, unlinkErr);
            return reject(new Error(`Failed to delete ${remotePath} from source: ${unlinkErr.message}`));
          }
          console.info(`[TransfersService] Temporary credential ${remotePath} deleted from source.`);
          resolve();
        });
      });
    });
  }
  
private async executeRemoteTransferOnSource(
  taskId: string,
  subTaskId: string,
  sourceSshClient: Client,
  sourceConnectionForInfo: ConnectionWithFolders,
  sourceItem: { name: string; path: string; type: 'file' | 'directory' },
  targetConnection: ConnectionWithFolders,
  targetCredentials: DecryptedConnectionCredentials,
  remoteTargetPathOnTarget: string,
  transferMethodPreference: 'auto' | 'rsync' | 'scp' | 'relay',
  signal: AbortSignal // +++ Add AbortSignal parameter +++
): Promise<void> {
  if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
  this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 0, `Initializing remote transfer for ${sourceItem.name}`);
  let tempTargetKeyPathOnSource: string | undefined;
  let tempTargetSecretPathOnSource: string | undefined;

    try {
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');

      // 用户显式选了「经由本机中转」：不用探测任何命令，直接走 SFTP 双向拷贝
      if (transferMethodPreference === 'relay') {
        await this.executeRelayTransfer(
          taskId, subTaskId, sourceSshClient, sourceItem,
          targetConnection, targetCredentials, remoteTargetPathOnTarget, signal
        );
        return;
      }
      // Pass signal to these check commands if they are made to support it. For now, they are quick.
      const sshpassPath = await this.checkCommandOnSource(sourceSshClient, 'sshpass' /*, signal */);
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
      const scpPathOnSource = await this.checkCommandOnSource(sourceSshClient, 'scp' /*, signal */);
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');

      let executableCommandPath: string | null = null;
      let commandTypeForLogic: 'rsync' | 'scp' | undefined = undefined; // Initialize as undefined
      let rsyncPathOnTarget: string | null = null;

      let rsyncPathOnSource = await this.checkCommandOnSource(sourceSshClient, 'rsync' /*, signal */);
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');

      // rsync 缺失 → 先尝试自动安装一次（用户不必自己登上机器 apt install）
      if (!rsyncPathOnSource && transferMethodPreference !== 'scp') {
        this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 2, `rsync not found on source (${sourceConnectionForInfo.host}), trying to install it automatically...`);
        rsyncPathOnSource = await this.ensureRsyncOnSource(sourceSshClient, sourceConnectionForInfo);
        if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
      }

      if (rsyncPathOnSource && transferMethodPreference !== 'scp') {
        rsyncPathOnTarget = await this.checkCommandOnTargetServer(targetConnection, targetCredentials, 'rsync' /*, signal */);
        if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
        if (!rsyncPathOnTarget) {
          this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 3, `rsync not found on target (${targetConnection.host}), trying to install it automatically...`);
          rsyncPathOnTarget = await this.ensureRsyncOnTargetServer(targetConnection, targetCredentials);
          if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
        }
      }

      if (transferMethodPreference === 'auto') {
        if (rsyncPathOnSource && rsyncPathOnTarget) {
          executableCommandPath = rsyncPathOnSource;
          commandTypeForLogic = 'rsync';
        } else if (scpPathOnSource) {
          // rsync 装不上（没有包管理器/没有免密提权/安装失败）就退回 scp，别让传输直接失败
          executableCommandPath = scpPathOnSource;
          commandTypeForLogic = 'scp';
        } else {
          // 源机上既没有 rsync（也装不上）又没有 scp —— 常见于极简容器/嵌入式系统。
          // 交给后端中转，整条链路就只剩「能不能 SSH 上去」这一个前提了。
          this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 4, `Neither rsync nor scp is available on source (${sourceConnectionForInfo.host}), falling back to relay transfer...`);
          console.info(`[TransfersService] Sub-task ${subTaskId}: 源机 ${sourceConnectionForInfo.host} 没有 rsync/scp，改用经由本机中转`);
          await this.executeRelayTransfer(
            taskId, subTaskId, sourceSshClient, sourceItem,
            targetConnection, targetCredentials, remoteTargetPathOnTarget, signal
          );
          return;
        }
      } else if (transferMethodPreference === 'rsync') {
        if (!rsyncPathOnSource) throw new Error(`Rsync preferred but not available on source for ${sourceItem.name}, and automatic installation did not succeed.`);
        if (!rsyncPathOnTarget) throw new Error(`Rsync preferred, but not available on target for ${sourceItem.name}, and automatic installation did not succeed.`);
        executableCommandPath = rsyncPathOnSource;
        commandTypeForLogic = 'rsync';
      } else if (transferMethodPreference === 'scp') {
        if (!scpPathOnSource) throw new Error(`SCP preferred but not available on source for ${sourceItem.name}.`);
        executableCommandPath = scpPathOnSource;
        commandTypeForLogic = 'scp';
      }

      if (!executableCommandPath || !commandTypeForLogic) {
        throw new Error(`Could not determine a valid transfer command for ${sourceItem.name}.`);
      }
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');

      this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 5, `Using ${commandTypeForLogic}.`);
      
      // +++ Declare and initialize cmdOptions here +++
      const cmdOptions: {
        targetUserAndHost: string;
        sshPortOption?: string;
        sshIdentityFileOption?: string;
        sshPassCommand?: string;
      } = {
        targetUserAndHost: `${targetConnection.username}@${targetConnection.host}`,
        sshPortOption: targetConnection.port ? (commandTypeForLogic === 'scp' ? `-P ${targetConnection.port}` : (commandTypeForLogic === 'rsync' ? `-p ${targetConnection.port}` : undefined)) : undefined,
      };
      const subTaskToUpdate = this.transferTasks.get(taskId)?.subTasks.find(st => st.subTaskId === subTaskId);
      if (subTaskToUpdate) subTaskToUpdate.transferMethodUsed = commandTypeForLogic;

      // +++ 自动创建目标目录 +++
      this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 6, `Ensuring target directory ${escapeShellArg(remoteTargetPathOnTarget)} exists on ${targetConnection.host}.`);
      const targetClientForMkdir = new Client();
      const targetConnectConfigForMkdir = this.buildSshConnectConfig(targetConnection, targetCredentials);
      try {
        if (signal.aborted) throw new DOMException('Transfer cancelled by user (before mkdir).', 'AbortError');
        await new Promise<void>((resolveMkdir, rejectMkdir) => {
          let mkdirStreamClosed = false;
          const onAbortMkdir = () => {
            if (!mkdirStreamClosed) { 
                targetClientForMkdir.end();
            }
            rejectMkdir(new DOMException('Mkdir operation cancelled by user.', 'AbortError'));
          };
          signal.addEventListener('abort', onAbortMkdir, { once: true });

          targetClientForMkdir.on('ready', () => {
            if (signal.aborted) { // Check signal again after ready, before exec
              signal.removeEventListener('abort', onAbortMkdir);
              targetClientForMkdir.end();
              return rejectMkdir(new DOMException('Mkdir operation cancelled by user (on ready).', 'AbortError'));
            }
            const mkdirCommand = `mkdir -p ${escapeShellArg(remoteTargetPathOnTarget)}`;
            targetClientForMkdir.exec(mkdirCommand, (err, stream) => {
              if (err) {
                signal.removeEventListener('abort', onAbortMkdir);
                targetClientForMkdir.end();
                return rejectMkdir(err);
              }
              let mkdirStderr = '';
              stream.on('close', (code: number) => {
                mkdirStreamClosed = true;
                signal.removeEventListener('abort', onAbortMkdir);
                targetClientForMkdir.end();
                if (code === 0) {
                  console.info(`[TransfersService] Sub-task ${subTaskId}: Target directory ${remoteTargetPathOnTarget} ensured on ${targetConnection.host}.`);
                  resolveMkdir();
                } else {
                  rejectMkdir(new Error(`Failed to create directory ${remoteTargetPathOnTarget} on ${targetConnection.host}. Exit code: ${code}. Stderr: ${mkdirStderr.trim()}`));
                }
              }).on('data', (data: Buffer) => {
              }).stderr.on('data', (data: Buffer) => {
                mkdirStderr += data.toString();
              }).on('error', (streamErr: Error) => { 
                mkdirStreamClosed = true;
                signal.removeEventListener('abort', onAbortMkdir);
                targetClientForMkdir.end();
                rejectMkdir(streamErr);
              });
            });
          }).on('error', (connErr: Error) => {
            signal.removeEventListener('abort', onAbortMkdir);
            rejectMkdir(connErr);
          }).on('close', () => { 
            signal.removeEventListener('abort', onAbortMkdir); 
          }).connect(targetConnectConfigForMkdir);
        });

        if (signal.aborted) throw new DOMException('Transfer cancelled by user (after mkdir attempt).', 'AbortError');
        this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 8, `Target directory ensured. Preparing transfer command.`);

      } catch (mkdirError: any) {
        if (targetClientForMkdir && (targetClientForMkdir as any)._sock && !(targetClientForMkdir as any)._sock.destroyed) {
             try { targetClientForMkdir.end(); } catch (e) { /* ignore */ }
        }
        console.error(`[TransfersService] Sub-task ${subTaskId}: Failed to ensure target directory ${remoteTargetPathOnTarget} on ${targetConnection.host}:`, mkdirError.message);
        if (mkdirError.name === 'AbortError') {
             this.updateSubTaskStatus(taskId, subTaskId, 'cancelled', undefined, `Directory creation cancelled: ${mkdirError.message}`);
             throw mkdirError; 
        }
        this.updateSubTaskStatus(taskId, subTaskId, 'failed', undefined, `Failed to create target directory: ${mkdirError.message}`);
        throw new Error(`Failed to create target directory ${remoteTargetPathOnTarget}: ${mkdirError.message}`); // This will be caught by the outer try-catch
      }
      // +++ 结束自动创建目标目录 +++

      if (targetConnection.auth_method === 'key' && targetCredentials.decryptedPrivateKey) {
        if (targetCredentials.decryptedPassphrase && !sshpassPath && transferMethodPreference === 'auto') {
          // 带 passphrase 的私钥在源机上无法免交互使用（需要一个 pty 去应答提示），
          // 而 sshpass 又没装 → 与其报错，不如用后端中转，密码/口令都在后端内存里用完即弃
          this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 8, `Target key has a passphrase but sshpass is missing on source, falling back to relay transfer...`);
          console.info(`[TransfersService] Sub-task ${subTaskId}: 目标私钥带 passphrase 且源机无 sshpass，改用经由本机中转`);
          await this.executeRelayTransfer(
            taskId, subTaskId, sourceSshClient, sourceItem,
            targetConnection, targetCredentials, remoteTargetPathOnTarget, signal
          );
          return;
        }

        const randomSuffix = crypto.randomBytes(6).toString('hex');
        tempTargetKeyPathOnSource = path.posix.join('/tmp', `${this.TEMP_KEY_PREFIX}${randomSuffix}`);
        await this.uploadSecretToSourceViaSftp(sourceSshClient, targetCredentials.decryptedPrivateKey, tempTargetKeyPathOnSource);
        if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
        cmdOptions.sshIdentityFileOption = `-i ${escapeShellArg(tempTargetKeyPathOnSource)}`;
        if (targetCredentials.decryptedPassphrase && !sshpassPath) {
          throw new Error(
            `Target key has a passphrase, but sshpass is not available on source for ${sourceItem.name}. ` +
            `Switch the transfer method to "Auto" / "Relay via this server", or install sshpass on ${sourceConnectionForInfo.host}.`
          );
        }
        if (targetCredentials.decryptedPassphrase && sshpassPath) {
          const passSuffix = crypto.randomBytes(6).toString('hex');
          tempTargetSecretPathOnSource = path.posix.join('/tmp', `${this.TEMP_SECRET_PREFIX}${passSuffix}`);
          await this.uploadSecretToSourceViaSftp(sourceSshClient, targetCredentials.decryptedPassphrase, tempTargetSecretPathOnSource);
          // ⚠️ sshpass 默认只匹配包含 "assword" 的提示，而私钥口令的提示是
          // "Enter passphrase for key '/tmp/xxx':" —— 不加 -P 永远等不到，命令会一直挂到超时。
          // 口令走 -f 临时文件而不是 -p：否则 `ps aux` 能看到完整命令行。
          cmdOptions.sshPassCommand = `${escapeShellArg(sshpassPath)} -P passphrase -f ${escapeShellArg(tempTargetSecretPathOnSource)}`;
        }
      } else if (targetConnection.auth_method === 'password' && targetCredentials.decryptedPassword) {
        if (!sshpassPath) {
          if (transferMethodPreference === 'auto') {
            // 「源机密钥登录、目标机密码登录」最常见的翻车点就在这里：
            // 最小化安装的 VPS 基本都没有 sshpass，而这一路必须在源机上免交互喂密码。
            this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 8, `sshpass is missing on source (${sourceConnectionForInfo.host}), falling back to relay transfer...`);
            console.info(`[TransfersService] Sub-task ${subTaskId}: 目标用密码认证但源机没有 sshpass，改用经由本机中转`);
            await this.executeRelayTransfer(
              taskId, subTaskId, sourceSshClient, sourceItem,
              targetConnection, targetCredentials, remoteTargetPathOnTarget, signal
            );
            return;
          }
          throw new Error(
            `Target uses password auth, but sshpass is not available on source for ${sourceItem.name}. ` +
            `Switch the transfer method to "Auto" / "Relay via this server", or install sshpass on ${sourceConnectionForInfo.host}.`
          );
        }
        const passSuffix = crypto.randomBytes(6).toString('hex');
        tempTargetSecretPathOnSource = path.posix.join('/tmp', `${this.TEMP_SECRET_PREFIX}${passSuffix}`);
        await this.uploadSecretToSourceViaSftp(sourceSshClient, targetCredentials.decryptedPassword, tempTargetSecretPathOnSource);
        // 密码落成 0600 临时文件交给 sshpass -f，命令行里只留路径
        cmdOptions.sshPassCommand = `${escapeShellArg(sshpassPath)} -f ${escapeShellArg(tempTargetSecretPathOnSource)}`;
      } else if (targetConnection.auth_method === 'key' && !targetCredentials.decryptedPrivateKey) {
         throw new Error(`Target connection ${targetConnection.name} is key-based but no private key found.`);
      }
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
      
      const commandToExecute = buildTransferCommandString(
        sourceItem.path, sourceItem.type === 'directory', remoteTargetPathOnTarget,
        executableCommandPath, commandTypeForLogic, cmdOptions
      );
      this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 10, `Executing: ${commandTypeForLogic}`);
      
      await new Promise<void>((resolveCmd, rejectCmd) => {
        let streamClosed = false;
        const onAbortCmd = () => {
          if (!streamClosed) {
            console.warn(`[TransfersService] Abort signal received for command stream of sub-task ${subTaskId}. Attempting to close stream.`);
          }
          rejectCmd(new DOMException('Command cancelled by user.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbortCmd, { once: true });

        const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
        const timeoutHandle = setTimeout(() => {
          signal.removeEventListener('abort', onAbortCmd);
          if (!streamClosed) rejectCmd(new Error(`${commandTypeForLogic} command timed out for ${sourceItem.name}.`));
        }, COMMAND_TIMEOUT_MS);

        const execOptions: { pty?: boolean } = {};
        if (cmdOptions.sshPassCommand) execOptions.pty = true;

        sourceSshClient.exec(commandToExecute, execOptions, (err, stream) => {
          if (signal.aborted && !streamClosed) { // Check signal immediately after exec callback
             clearTimeout(timeoutHandle);
             signal.removeEventListener('abort', onAbortCmd);
             stream?.close(); // Attempt to close if stream exists
             return rejectCmd(new DOMException('Command cancelled by user (at exec).', 'AbortError'));
          }
          if (err) {
            clearTimeout(timeoutHandle);
            signal.removeEventListener('abort', onAbortCmd);
            return rejectCmd(new Error(`Failed to execute command: ${err.message}`));
          }

          stream.on('data', (data: Buffer) => {
            if (signal.aborted) return; // Stop processing data if aborted
            // ... (progress update logic)
            if (commandTypeForLogic === 'rsync') {
              const output = data.toString();
              const progressMatch = output.match(/(\d+)%/);
              if (progressMatch && progressMatch[1]) {
                this.updateSubTaskStatus(taskId, subTaskId, 'transferring', parseInt(progressMatch[1], 10));
              }
            } else {
                this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 50, 'SCP in progress...');
            }
          });
          let stderrCombined = '';
          stream.stderr.on('data', (data: Buffer) => {
            if (signal.aborted) return;
            stderrCombined += data.toString();
          });
          stream.on('close', (code: number | null) => {
            streamClosed = true;
            clearTimeout(timeoutHandle);
            signal.removeEventListener('abort', onAbortCmd);
            if (signal.aborted) { // Check if aborted during the command run
              return rejectCmd(new DOMException('Command cancelled by user (on close).', 'AbortError'));
            }
            if (code === 0) {
              this.updateSubTaskStatus(taskId, subTaskId, 'completed', 100, `${commandTypeForLogic} successful.`);
              resolveCmd();
            } else {
              rejectCmd(new Error(`${commandTypeForLogic} failed. Code: ${code}. Stderr: ${stderrCombined.trim()}`));
            }
          });
          stream.on('error', (streamErr: Error) => {
            streamClosed = true;
            clearTimeout(timeoutHandle);
            signal.removeEventListener('abort', onAbortCmd);
             if (signal.aborted && streamErr.message.includes('closed')) { // If aborted and stream closed, treat as AbortError
                return rejectCmd(new DOMException('Command stream error due to cancellation.', 'AbortError'));
             }
            rejectCmd(streamErr);
          });
        });
      });

    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.info(`[TransfersService] executeRemoteTransferOnSource for sub-task ${subTaskId} (item: ${sourceItem.name}) was aborted.`);
        // Status will be updated to 'cancelled' by the caller or here if not already
        const subTaskInstance = this.transferTasks.get(taskId)?.subTasks.find(st => st.subTaskId === subTaskId);
        if (subTaskInstance && subTaskInstance.status !== 'cancelled') {
            this.updateSubTaskStatus(taskId, subTaskId, 'cancelled', undefined, error.message);
        }
      } else {
        console.error(`[TransfersService] executeRemoteTransferOnSource error for sub-task ${subTaskId} (item: ${sourceItem.name}):`, error);
        this.updateSubTaskStatus(taskId, subTaskId, 'failed', undefined, error.message || `Remote transfer execution failed for ${sourceItem.name}.`);
      }
      throw error; // Re-throw to be caught by processSingleSubTaskWrapper
    } finally {
      // 临时私钥 / 密码文件都留在源机 /tmp 上，删不干净就是凭据泄漏
      for (const tempPath of [tempTargetKeyPathOnSource, tempTargetSecretPathOnSource]) {
        if (!tempPath) continue;
        try {
          // TODO: Make deleteFileOnSourceViaSftp accept signal
          await this.deleteFileOnSourceViaSftp(sourceSshClient, tempPath);
        } catch (cleanupError) {
          console.warn(`[TransfersService] Failed to cleanup temp credential ${tempPath} on source for sub-task ${subTaskId}:`, cleanupError);
        }
      }
    }
  }

  /**
   * 经由本机（后端）中转：SFTP 读源 → 直接 pipe 写目标。
   *
   * 这条路线**不需要源机上有 rsync / scp / sshpass**，也不用把目标私钥落到源机 /tmp，
   * 是「源机密钥登录 + 目标机密码登录」这类组合最稳的走法。
   * 代价是流量要过一次后端，所以只在 rsync/scp 前置条件不满足时才自动降级到这里。
   */
  private async executeRelayTransfer(
    taskId: string,
    subTaskId: string,
    sourceSshClient: Client,
    sourceItem: { name: string; path: string; type: 'file' | 'directory' },
    targetConnection: ConnectionWithFolders,
    targetCredentials: DecryptedConnectionCredentials,
    remoteTargetPathOnTarget: string,
    signal: AbortSignal
  ): Promise<void> {
    const subTaskToUpdate = this.transferTasks.get(taskId)?.subTasks.find(st => st.subTaskId === subTaskId);
    if (subTaskToUpdate) subTaskToUpdate.transferMethodUsed = 'relay';

    this.updateSubTaskStatus(
      taskId, subTaskId, 'transferring', 5,
      `Relaying ${sourceItem.name} through this server to ${targetConnection.host}...`
    );

    const targetClient = new Client();
    let sourceSftp: SFTPWrapper | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          try { targetClient.end(); } catch { /* 已断开 */ }
          reject(new DOMException('Transfer cancelled by user.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        targetClient
          .on('ready', () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          })
          .on('error', (err) => {
            signal.removeEventListener('abort', onAbort);
            reject(err);
          })
          .connect(this.buildSshConnectConfig(targetConnection, targetCredentials));
      });

      sourceSftp = await createSftp(sourceSshClient);
      const targetSftp = await createSftp(targetClient);

      const result = await relayTransfer({
        sourceSftp,
        targetSftp,
        sourcePath: sourceItem.path,
        isDirectory: sourceItem.type === 'directory',
        targetParentDir: remoteTargetPathOnTarget,
        signal,
        onPreparing: (message) => {
          this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 8, message);
        },
        onProgress: (transferred, total, currentPath) => {
          const progress = total > 0
            ? 8 + Math.min(90, Math.floor((transferred / total) * 90))
            : 50;
          const suffix = currentPath ? ` (${currentPath})` : '';
          this.updateSubTaskStatus(
            taskId, subTaskId, 'transferring', progress,
            `Relaying${suffix}: ${formatBytes(transferred)} / ${formatBytes(total)}`
          );
        },
      });

      this.updateSubTaskStatus(
        taskId, subTaskId, 'completed', 100,
        `Relay transfer completed (${result.files} file(s), ${formatBytes(result.bytes)}).`
      );
    } finally {
      if (sourceSftp) {
        try { sourceSftp.end(); } catch { /* 已断开 */ }
      }
      try { targetClient.end(); } catch { /* 已断开 */ }
    }
  }

  // --- Status Update and Retrieval Methods (largely unchanged) ---

  public async getTransferTaskDetails(taskId: string, userId: string | number): Promise<TransferTask | null> {
    const task = this.transferTasks.get(taskId);
    console.debug(`[TransfersService] Retrieving details for task: ${taskId} for user: ${userId}`);
    if (task && task.userId === userId) {
      return serializeTransferTask(task);
    }
    if (task && task.userId !== userId) {
        console.warn(`[TransfersService] User ${userId} attempted to access task ${taskId} owned by ${task.userId}.`);
        return null;
    }
    return null;
  }

  public async getAllTransferTasks(userId: string | number): Promise<TransferTask[]> {
    console.debug(`[TransfersService] Retrieving all transfer tasks for user: ${userId}.`);
    return Array.from(this.transferTasks.values())
      .filter(task => task.userId === userId)
      .map(task => serializeTransferTask(task));
  }

  public updateSubTaskStatus(
    taskId: string,
    subTaskId: string,
    newStatus: TransferSubTask['status'],
    progress?: number,
    message?: string
  ): void {
    const task = this.transferTasks.get(taskId);
    if (task) {
      const subTask = task.subTasks.find(st => st.subTaskId === subTaskId);
      if (subTask) {
        // Prevent overwriting a final state with a transient one unless it's a retry mechanism (not implemented here)
        if ((subTask.status === 'completed' || subTask.status === 'failed') && (newStatus !== 'completed' && newStatus !== 'failed')) {
            console.warn(`[TransfersService] Attempted to update final sub-task ${subTaskId} status '${subTask.status}' to '${newStatus}'. Ignoring.`);
            return;
        }

        subTask.status = newStatus;
        if (progress !== undefined) subTask.progress = Math.min(100, Math.max(0, progress)); // Clamp progress
        if (message !== undefined) subTask.message = message;
        if ((newStatus === 'completed' || newStatus === 'failed') && !subTask.endTime) {
            subTask.endTime = new Date();
        }
        task.updatedAt = new Date();
        this.updateOverallTaskStatusBasedOnSubTasks(taskId); // Important: update overall task
        console.info(`[TransfersService] Sub-task ${subTaskId} (task ${taskId}) updated: ${newStatus}, progress: ${subTask.progress}%, msg: "${subTask.message}"`);
      } else {
        console.warn(`[TransfersService] Sub-task ${subTaskId} not found for task ${taskId} during status update.`);
      }
    } else {
      console.warn(`[TransfersService] Task ${taskId} not found during sub-task status update.`);
    }
  }

  private updateOverallTaskStatus(taskId: string, newStatus: TransferTask['status'], message?: string): void {
    const task = this.transferTasks.get(taskId);
    if (task) {
        const isCurrentStatusFinal = task.status === 'completed' || task.status === 'failed' || task.status === 'partially-completed';
        // Check if newStatus is one of the transient states
        const isNewStatusTransient = newStatus === 'queued' || newStatus === 'in-progress';

        if (isCurrentStatusFinal && isNewStatusTransient) {
            // If current status is final and new status is transient, ignore the update.
            console.warn(`[TransfersService] Attempted to update final task ${taskId} status '${task.status}' to transient '${newStatus}'. Ignoring.`);
            return;
        }

        // Proceed with the update if:
        // 1. Current status is not final.
        // 2. Current status is final, and newStatus is also a final state (e.g., 'partially-completed' to 'failed').
        task.status = newStatus;
        task.updatedAt = new Date();
        // Overall task message could be an aggregation or just the first major error.
        // For simplicity, not adding detailed message aggregation here.
        console.info(`[TransfersService] Overall status for task ${taskId} directly updated to: ${newStatus}` + (message ? ` (Msg: ${message})` : ''));
    }
  }

  private updateOverallTaskStatusBasedOnSubTasks(taskId: string): void {
    const task = this.transferTasks.get(taskId);
    if (!task) return;

    let completedCount = 0;
    let failedCount = 0;
    let inProgressCount = 0;
    let queuedCount = 0;
    let totalProgress = 0;
    const numSubTasks = task.subTasks.length;

    if (numSubTasks === 0) {
      task.overallProgress = 0;
      return;
    }

    task.subTasks.forEach(st => {
      switch (st.status) {
        case 'completed':
          completedCount++;
          totalProgress += 100;
          break;
        case 'failed':
          failedCount++;
          break;
        case 'transferring':
        case 'connecting': 
          inProgressCount++;
          totalProgress += (st.progress !== undefined ? st.progress : (st.status === 'connecting' ? 5 : 0)); // Small progress for connecting
          break;
        case 'queued':
          queuedCount++;
          break;
      }
    });

    task.overallProgress = numSubTasks > 0 ? Math.round(totalProgress / numSubTasks) : 0;

    let newOverallStatus: TransferTask['status'];
    if (failedCount === numSubTasks) {
      newOverallStatus = 'failed';
    } else if (completedCount === numSubTasks) {
      newOverallStatus = 'completed';
    } else if (failedCount > 0 && (completedCount + failedCount === numSubTasks)) {
      newOverallStatus = 'partially-completed';
    } else if (inProgressCount > 0 || (queuedCount > 0 && (failedCount > 0 || completedCount > 0))) {
      // If anything is in progress, or if some are queued while others are done/failed, it's in-progress
      newOverallStatus = 'in-progress';
    } else if (queuedCount === numSubTasks) {
      newOverallStatus = 'queued'; // All subtasks are still queued
    } else {
      newOverallStatus = 'in-progress'; // Or 'partially-completed' if completedCount > 0
      if (completedCount > 0 && queuedCount > 0 && failedCount === 0 && inProgressCount === 0) {
        newOverallStatus = 'partially-completed'; // More accurate for this specific mix
      }
    }
    
    if (task.status !== newOverallStatus) {
        console.info(`[TransfersService] Task ${taskId} overall status changing from ${task.status} to ${newOverallStatus} (P: ${task.overallProgress}%)`);
        task.status = newOverallStatus;
    }
    task.updatedAt = new Date();
  }

  private finalizeOverallTaskStatus(taskId: string): void {
    const task = this.transferTasks.get(taskId);
    if (!task) return;
    this.updateOverallTaskStatusBasedOnSubTasks(taskId); // Recalculate based on final sub-task states
    console.info(`[TransfersService] Finalized overall status for task ${taskId}: ${task.status}, progress: ${task.overallProgress}%`);
  }
}