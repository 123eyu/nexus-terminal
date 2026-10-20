// packages/backend/src/sftp/services/external-open.watcher.ts
import fs from 'fs';
import { ClientState } from '../../websocket/types';
import { broadcastFrontendEvent } from '../../websocket/frontend-events';
import { shouldTreatAsConflict } from './external-open.util';
import {
    downloadRemoteFileToLocal,
    getRemoteMtimeSeconds,
    uploadLocalFileToRemote,
} from './external-open.transfer';

/**
 * 「外部编辑器打开」的回传监听器。
 *
 * 场景：桌面端把远程文件落成本地副本交给系统默认程序（VSCode / Sublime / 记事本…），
 * 用户在外部程序里保存后，本地副本 mtime 会变 —— 这里轮询发现变化就自动传回远程。
 *
 * 为什么用轮询而不是 fs.watch：
 *   编辑器"原子保存"（写临时文件再 rename 覆盖）会让 inotify / RDCW 直接丢 watch 目标，
 *   Windows 上尤其常见；而这里最多盯几个文件，1.2s 一次 stat 的成本可以忽略。
 *
 * 冲突策略：上传前对比远程 mtime 与"下载时的基线"。远程被别人改过 → 不上传，
 * 推一条 external-open:conflict 给前端，由用户决定「覆盖远程」还是「放弃本地改动」。
 *
 * 生命周期：连接关闭 / 本地副本被删 / 空闲超过 12 小时 → 自动摘掉，不留定时器。
 */

export interface ExternalOpenEntryInit {
    /** 打开者的用户 id（事件只给本人页面看） */
    userId: number | string | null;
    /** 数据库连接 id（前端用来区分是哪个连接的文件） */
    connectionId: number;
    /** 远程绝对路径 */
    remotePath: string;
    /** 本地副本绝对路径（同时也作为监听 key） */
    localPath: string;
    /** 下载完成时远程文件的 mtime（秒），冲突判定基线 */
    remoteMtimeS: number | null;
    /** 本地副本当前已与远程对齐的 mtime（毫秒） */
    localMtimeMs: number;
    /** 每次 tick 重新拿会话：会话被关闭 / 挂起后要停止监听 */
    resolveSession: () => ClientState | null;
}

interface ExternalOpenEntry extends ExternalOpenEntryInit {
    /** 已处理过的本地 mtime，用来判断"又变了" */
    localMtimeMs: number;
    /** 已处理过的本地文件大小（mtime 可能因文件系统精度相同，用大小兜底） */
    localSize: number;
    /** 检测到变化的时间戳（用于等编辑器写完，防抖） */
    changeSeenAt: number;
    /** 有未决冲突时为 true：不自动上传，等用户决议 */
    conflictPending: boolean;
    uploading: boolean;
    updatedAt: number;
}

const TICK_INTERVAL_MS = 1200;   // 轮询间隔
const SETTLE_MS = 700;           // 发现变化后再等一会儿，避开"先 truncate 再写"的中间态
const MAX_IDLE_MS = 12 * 60 * 60 * 1000; // 12 小时没动静就不再盯

class ExternalOpenWatcher {
    private entries = new Map<string, ExternalOpenEntry>();
    private timer: NodeJS.Timeout | null = null;

    /** 登记一个刚被外部打开的文件，开始监听本地改动 */
    register(init: ExternalOpenEntryInit): void {
        // 以登记当下的真实 stat 为基线：调用方传的 mtime 可能与落地写入有几毫秒偏差，
        // 直接采信会让"打开后立刻保存"被漏掉。
        const stat = this.tryStat(init.localPath);
        this.entries.set(init.localPath, {
            ...init,
            localMtimeMs: stat?.mtimeMs ?? init.localMtimeMs,
            localSize: stat?.size ?? 0,
            changeSeenAt: 0,
            conflictPending: false,
            uploading: false,
            updatedAt: Date.now(),
        });
        this.ensureTimer();
        console.log(`[ExternalOpen] 开始监听本地改动: ${init.localPath} → ${init.remotePath}`);
    }

    /** 停止监听某个本地副本（会话关闭 / 文件被删时） */
    unregister(localPath: string): void {
        if (this.entries.delete(localPath)) {
            console.log(`[ExternalOpen] 停止监听: ${localPath}`);
        }
        this.stopTimerIfIdle();
    }

    /** 当前监听数量（日志 / 冒烟测试用） */
    size(): number {
        return this.entries.size;
    }

    /** 某个本地副本是否还在监听 */
    has(localPath: string): boolean {
        return this.entries.has(localPath);
    }

    /**
     * 用户对冲突做出选择：
     *   overwrite —— 用本地副本覆盖远程
     *   reload    —— 丢掉本地改动，重新从远程拉一份
     * 返回 { ok, remoteMtimeS } 供前端提示。
     */
    async resolve(
        localPath: string,
        action: 'overwrite' | 'reload'
    ): Promise<{ ok: boolean; message?: string; remoteMtimeS?: number | null }> {
        const entry = this.entries.get(localPath);
        if (!entry) {
            return { ok: false, message: '该文件已不在监听列表（可能连接已断开或已超时）' };
        }
        const session = entry.resolveSession();
        if (!session) {
            this.unregister(localPath);
            return { ok: false, message: '连接已断开，无法同步回远程' };
        }

        entry.uploading = true;
        try {
            if (action === 'overwrite') {
                await uploadLocalFileToRemote(session, entry.localPath, entry.remotePath);
                entry.remoteMtimeS = await getRemoteMtimeSeconds(session, entry.remotePath);
                this.refreshLocalBaseline(entry);
                entry.conflictPending = false;
                entry.updatedAt = Date.now();
                this.emit('external-open:synced', entry, { size: this.safeSize(entry.localPath) });
                return { ok: true, remoteMtimeS: entry.remoteMtimeS };
            }

            // reload：远程覆盖本地（注意同步 localMtimeMs，否则下一轮会被当成"本地改了"）
            await downloadRemoteFileToLocal(session, entry.remotePath, entry.localPath);
            entry.remoteMtimeS = await getRemoteMtimeSeconds(session, entry.remotePath);
            this.refreshLocalBaseline(entry);
            entry.conflictPending = false;
            entry.changeSeenAt = 0;
            entry.updatedAt = Date.now();
            this.emit('external-open:reloaded', entry, {});
            return { ok: true, remoteMtimeS: entry.remoteMtimeS };
        } catch (error: any) {
            console.error(`[ExternalOpen] 冲突处理失败 (${action} ${entry.remotePath}):`, error);
            return { ok: false, message: error?.message || String(error) };
        } finally {
            entry.uploading = false;
        }
    }

    private emit(type: string, entry: ExternalOpenEntry, extra: Record<string, unknown>): void {
        const sent = broadcastFrontendEvent({
            type,
            payload: {
                userId: entry.userId,
                connectionId: entry.connectionId,
                remotePath: entry.remotePath,
                localPath: entry.localPath,
                fileName: entry.remotePath.substring(entry.remotePath.lastIndexOf('/') + 1),
                ...extra,
            },
        });
        if (sent === 0) {
            console.log(`[ExternalOpen] ${type} 没有在线页面可推送（前端可能已关闭）`);
        }
    }

    private ensureTimer(): void {
        if (this.timer) return;
        this.timer = setInterval(() => { void this.tick(); }, TICK_INTERVAL_MS);
        // 别让监听器拖住进程退出
        this.timer.unref?.();
    }

    private stopTimerIfIdle(): void {
        if (this.entries.size === 0 && this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private safeLocalMtime(localPath: string): number | null {
        try {
            return fs.statSync(localPath).mtimeMs;
        } catch {
            return null;
        }
    }

    private tryStat(localPath: string): fs.Stats | null {
        try {
            return fs.statSync(localPath);
        } catch {
            return null;
        }
    }

    /** 把「本地已与远程对齐」的基线重置为当前磁盘状态（mtime + size 必须一起更新） */
    private refreshLocalBaseline(entry: ExternalOpenEntry, stat?: fs.Stats): void {
        const current = stat ?? this.tryStat(entry.localPath);
        if (!current) return;
        entry.localMtimeMs = current.mtimeMs;
        entry.localSize = current.size;
    }

    private safeSize(localPath: string): number | null {
        try {
            return fs.statSync(localPath).size;
        } catch {
            return null;
        }
    }

    private async tick(): Promise<void> {
        if (this.entries.size === 0) {
            this.stopTimerIfIdle();
            return;
        }

        for (const entry of [...this.entries.values()]) {
            // 1. 长时间没动静 → 摘掉
            if (Date.now() - entry.updatedAt > MAX_IDLE_MS) {
                this.unregister(entry.localPath);
                continue;
            }

            // 2. 会话没了（用户关了连接/退出）→ 摘掉
            const session = entry.resolveSession();
            if (!session) {
                console.log(`[ExternalOpen] 会话已结束，停止监听 ${entry.remotePath}`);
                this.unregister(entry.localPath);
                continue;
            }

            // 3. 本地副本被删 → 摘掉
            let stat: fs.Stats;
            try {
                stat = fs.statSync(entry.localPath);
            } catch {
                this.unregister(entry.localPath);
                continue;
            }

            // 4. 有未决冲突 / 正在上传 → 本轮不处理
            if (entry.conflictPending || entry.uploading) continue;

            // 5. 本地没变化：mtime 没前进、大小也没变，才算没改
            //    （不能给固定容差——"打开后立刻保存"会被几百毫秒的容差整段吞掉；
            //     而 mtime 精度不足的场景用文件大小兜底）
            const mtimeAdvanced = stat.mtimeMs > entry.localMtimeMs;
            const sizeChanged = stat.size !== entry.localSize;
            if (!mtimeAdvanced && !sizeChanged) {
                entry.changeSeenAt = 0;
                continue;
            }

            // 6. 发现变化：先等编辑器写完（防抖），再真正回传
            if (!entry.changeSeenAt) {
                entry.changeSeenAt = Date.now();
                continue;
            }
            if (Date.now() - entry.changeSeenAt < SETTLE_MS) continue;

            entry.changeSeenAt = 0;
            await this.syncEntry(entry, session, stat);
        }
    }

    private async syncEntry(entry: ExternalOpenEntry, session: ClientState, stat: fs.Stats): Promise<void> {
        entry.uploading = true;
        try {
            const currentRemoteMtime = await getRemoteMtimeSeconds(session, entry.remotePath);

            if (shouldTreatAsConflict(entry.remoteMtimeS, currentRemoteMtime)) {
                // 远程在本地编辑期间被改过：不覆盖，交给用户决定
                entry.conflictPending = true;
                this.refreshLocalBaseline(entry, stat); // 先记下，避免每轮重复提示
                entry.updatedAt = Date.now();
                console.warn(`[ExternalOpen] 检测到远程已被修改，暂停自动回传: ${entry.remotePath}`);
                this.emit('external-open:conflict', entry, {
                    localMtimeMs: stat.mtimeMs,
                    remoteMtimeS: currentRemoteMtime,
                    baselineMtimeS: entry.remoteMtimeS,
                });
                return;
            }

            await uploadLocalFileToRemote(session, entry.localPath, entry.remotePath);
            // 基线必须重读：上传本身会刷新远程 mtime，沿用旧值会让下一次保存被误判成冲突
            entry.remoteMtimeS =
                (await getRemoteMtimeSeconds(session, entry.remotePath)) ?? currentRemoteMtime ?? Math.floor(Date.now() / 1000);
            entry.localMtimeMs = this.safeLocalMtime(entry.localPath) ?? stat.mtimeMs;
            entry.localSize = this.safeSize(entry.localPath) ?? stat.size;
            entry.updatedAt = Date.now();
            console.log(`[ExternalOpen] 已自动回传: ${entry.localPath} → ${entry.remotePath} (${stat.size} 字节)`);
            this.emit('external-open:synced', entry, { size: stat.size });
        } catch (error: any) {
            entry.updatedAt = Date.now();
            console.error(`[ExternalOpen] 自动回传失败 (${entry.remotePath}):`, error);
            this.emit('external-open:error', entry, { message: error?.message || String(error) });
        } finally {
            entry.uploading = false;
        }
    }
}

/** 全局单例：一个进程只跑一个轮询器 */
export const externalOpenWatcher = new ExternalOpenWatcher();
