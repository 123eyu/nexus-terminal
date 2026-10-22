import type { Request } from 'express';
import { getDbInstance, runDb, getDb } from '../database/connection';
import { AuditLogService } from '../audit/audit.service';

/**
 * 桌面端「开机即用」：首次启动自动建一个 admin，密码为空。
 *
 * 为什么只对桌面端做：桌面端的后端是随安装包一起跑的 sidecar，用户打开软件就是想
 * 立刻用，不应该先被一个建账号向导拦住。Web / Docker 部署是暴露在网络里的服务，
 * 必须由部署者自己设密码，所以那条路继续走 needs-setup。
 *
 * 「密码为空」的存储方式：hashed_password 存空串。不用 bcrypt('') 是因为那样
 * 空密码会变成一个合法的密码值——任何人输空密码都能过。存空串让「没设置密码」
 * 成为一个可判定的状态，比「碰巧等于空密码的哈希」安全得多。
 */

/** hashed_password 为空串 == 该账号没有设置密码 */
export const NO_PASSWORD = '';

/**
 * 桌面端本机会话的有效期：1 年。
 * 桌面端应该「常驻登录」——关掉应用再打开不该重新登录一遍。
 */
export const DESKTOP_SESSION_MAX_AGE_MS = 315360000000;

/**
 * 当前登录是否要写成持久 cookie（关掉 WebView 也保留）。
 * 桌面端 + 本机请求：默认持久；其他部署仍然尊重「记住我」勾选项。
 */
export function shouldPersistSession(req: Request): boolean {
    return isDesktopRuntime() && isLocalRequest(req);
}

export function isPasswordSet(hashedPassword: string | null | undefined): boolean {
    return typeof hashedPassword === 'string' && hashedPassword.length > 0;
}

/** 后端是否跑在桌面客户端里（由 Tauri 启动 sidecar 时注入） */
export function isDesktopRuntime(): boolean {
    const raw = (process.env.NEXUS_DESKTOP || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * 请求是否来自本机。
 *
 * ⚠️ 必须用 socket.remoteAddress，不能用 req.ip：index.ts 里 `app.set('trust proxy', true)`，
 * req.ip 会采信客户端自己发来的 X-Forwarded-For，任何远程请求都能伪造成 127.0.0.1。
 * socket 上的对端地址无法伪造。
 */
export function isLocalRequest(req: Request): boolean {
    const addr = req.socket?.remoteAddress || '';
    if (addr === '::1') return true;
    // IPv4-mapped IPv6：::ffff:127.0.0.1
    const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    return /^127\./.test(v4);
}

/**
 * 桌面端首次启动时创建默认账号。已经存在任何用户就什么都不做。
 * 失败不阻断启动——建不出账号顶多回到「需要初始设置」的老流程。
 */
export async function ensureDesktopAdmin(): Promise<void> {
    if (!isDesktopRuntime()) return;

    try {
        const db = await getDbInstance();
        const row = await getDb<{ count: number }>(db, 'SELECT COUNT(*) as count FROM users');
        if ((row?.count ?? 0) > 0) return;

        const now = Math.floor(Date.now() / 1000);
        const result = await runDb(
            db,
            `INSERT INTO users (username, hashed_password, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
            ['admin', NO_PASSWORD, now, now]
        );

        console.log(`[Desktop] 首次启动，已自动创建默认账号 admin (ID: ${result.lastID})，当前未设置密码。`);
        new AuditLogService().logAction('ADMIN_AUTO_CREATED', {
            userId: result.lastID,
            username: 'admin',
            reason: 'desktop first run',
        });
    } catch (error: any) {
        console.error('[Desktop] 自动创建默认账号失败，将回退到初始设置流程:', error?.message || error);
    }
}
