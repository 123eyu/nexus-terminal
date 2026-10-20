// packages/backend/src/sftp/services/external-open.util.ts
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';

/**
 * 「桌面端用系统默认程序打开远程文件」用到的纯工具函数。
 *
 * 单独放一个模块的原因：外部打开既涉及落盘路径（controller 用）、又涉及回传时的冲突判定
 * （watcher 用），而且这些判断需要能单测 —— 放在 controller 里就没法在不拉起 express / ws 的
 * 情况下测。
 */

export const EXTERNAL_OPEN_DIR_NAME = 'nexus-terminal/opened-files';

/** 本地副本目录：<系统临时目录>/nexus-terminal/opened-files */
export function getExternalOpenDir(): string {
    return path.join(os.tmpdir(), EXTERNAL_OPEN_DIR_NAME);
}

/**
 * 清理 48 小时前的旧副本，避免临时目录无限堆积。
 * 临时目录不是关键路径，失败只忽略不抛错。
 */
export function cleanupExternalOpenDir(dir: string, now: number = Date.now()): void {
    try {
        const expireMs = 48 * 60 * 60 * 1000;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const full = path.join(dir, entry.name);
            try {
                if (now - fs.statSync(full).mtimeMs > expireMs) {
                    fs.unlinkSync(full);
                }
            } catch { /* 单个文件清理失败不影响整体 */ }
        }
    } catch { /* 目录不存在或不可读：忽略 */ }
}

/**
 * 给本地副本生成稳定的文件名：同一 (连接, 远程路径) 永远是同一个文件，
 * 这样连续打开同一个文件不会在临时目录里堆一串副本，外部程序的"最近文件"也不会重复，
 * 回传监听也只需要盯一个路径。
 */
export function buildLocalCopyPath(dir: string, connectionId: number, remotePath: string): string {
    const baseName = path.basename(remotePath) || 'remote-file';
    // 只保留安全字符，避免把路径分隔符 / 控制字符带进本地文件名
    const safeName = baseName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
    const digest = crypto.createHash('sha1').update(`${connectionId}:${remotePath}`).digest('hex').slice(0, 12);
    return path.join(dir, `${digest}-${safeName}`);
}

/**
 * 本地改动回传前，判断远程是否被别人改过。
 *
 * mtime 是秒级精度（SFTP attrs 就是秒），且不同文件系统的取整方式可能差 1 秒，
 * 所以给 1 秒容差；两边任一拿不到（null）时按"没冲突"处理 —— 宁可回传，也别因为服务器
 * 不支持返回 mtime 就把功能彻底卡死。
 */
export function shouldTreatAsConflict(
    baselineMtimeS: number | null | undefined,
    currentMtimeS: number | null | undefined,
    toleranceS: number = 1
): boolean {
    if (baselineMtimeS === null || baselineMtimeS === undefined) return false;
    if (currentMtimeS === null || currentMtimeS === undefined) return false;
    return Math.abs(Math.round(currentMtimeS) - Math.round(baselineMtimeS)) > toleranceS;
}
