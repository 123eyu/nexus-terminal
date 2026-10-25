import { AuthenticatedWebSocket } from '../websocket/types';
import * as workspaceSyncRepo from './workspace-sync.repository';
import { clientStates } from '../websocket/state';
import { sshSuspendService } from '../ssh-suspend/ssh-suspend.service';
import { temporaryLogStorageService } from '../ssh-suspend/temporary-log-storage.service';
import { evaluateLeaseWrite, isForeignWorkspaceClient, removeSessionFromSnapshot } from './workspace-sync.pure';

export interface WorkspaceSyncStatePayload {
    syncEnabled: boolean;
    activeSessionId?: string | null;
    sessions?: Array<{
        sessionId: string;
        connectionId: string | number;
        connectionName: string;
        isSuspended?: boolean;
        suspendSessionId?: string;
        commandInputContent?: string;
        terminalBuffer?: string;
        editorTabs?: Array<{
            id: string;
            sessionId: string;
            filePath: string;
            filename: string;
            content?: string;
            rawContentBase64?: string | null;
            isModified?: boolean;
            language?: string;
            selectedEncoding?: string;
            scrollTop?: number;
            scrollLeft?: number;
        }>;
        activeEditorTabId?: string | null;
    }>;
    fileEditor?: {
        activeTabId: string | null;
        tabs: Array<{
            id: string;
            sessionId: string;
            filePath: string;
            filename: string;
            content?: string;
            rawContentBase64?: string | null;
            isModified?: boolean;
            language?: string;
            selectedEncoding?: string;
            scrollTop?: number;
            scrollLeft?: number;
        }>;
    };
    fileManager?: {
        currentPath: string;
        isSearchActive: boolean;
        searchQuery: string;
        scrollTop?: number;
        scrollRatio?: number;
    };
    fileManagers?: Record<string, {
        instanceId: string;
        sessionId: string;
        currentPath: string;
        isSearchActive: boolean;
        searchQuery: string;
        scrollTop?: number;
        scrollRatio?: number;
    }>;
    multiLineCommandInput?: {
        currentContent: string;
        sessionDrafts?: Record<string, string>;
    };
    updatedAt?: number;
}

export class WorkspaceSyncService {
    // 维护 userId -> Set<AuthenticatedWebSocket>
    private userSockets = new Map<number, Set<AuthenticatedWebSocket>>();

    /**
     * 维护 userId -> 「第几轮接管」。
     *
     * 每次租约真正换人 +1，用来给这一轮移交出去的挂起条目打标：
     * 下一轮接管时就能认出「上一轮留下的、这一轮没人会去 resume 的孤儿」并清掉。
     * 只存在内存里 —— 重启后挂起池本来就是空的，不需要持久化。
     */
    private takeoverRounds = new Map<number, number>();

    /**
     * 注册客户端 WebSocket 连接
     */
    public registerSocket(userId: number, ws: AuthenticatedWebSocket, clientId?: string): void {
        if (!this.userSockets.has(userId)) {
            this.userSockets.set(userId, new Set());
        }
        this.userSockets.get(userId)!.add(ws);
        if (clientId) {
            (ws as any).syncClientId = clientId;
        }

        ws.on('close', () => {
            this.unregisterSocket(userId, ws);
        });
    }

    /**
     * 注销客户端 WebSocket 连接
     */
    public unregisterSocket(userId: number, ws: AuthenticatedWebSocket): void {
        const set = this.userSockets.get(userId);
        if (set) {
            set.delete(ws);
            if (set.size === 0) {
                this.userSockets.delete(userId);
            }
        }
    }

    /**
     * 绑定或更新 WebSocket 的 syncClientId
     */
    public bindSocketClientId(userId: number, ws: AuthenticatedWebSocket, clientId: string): void {
        (ws as any).syncClientId = clientId;
        if (!this.userSockets.has(userId)) {
            this.userSockets.set(userId, new Set());
        }
        this.userSockets.get(userId)!.add(ws);
    }

    /**
     * 获取指定用户的工作区快照
     */
    public async getState(userId: number): Promise<{
        state: WorkspaceSyncStatePayload | null;
        activeClientId: string | null;
        updatedAt: number | null;
    }> {
        const record = await workspaceSyncRepo.getWorkspaceSyncRecord(userId);
        if (!record || !record.state) {
            return { state: null, activeClientId: null, updatedAt: null };
        }
        try {
            const parsedState = JSON.parse(record.state);
            return {
                state: parsedState,
                activeClientId: record.activeClientId,
                updatedAt: record.updatedAt
            };
        } catch (e) {
            console.error(`[WorkspaceSyncService] 解析用户 ${userId} 工作区 JSON 失败:`, e);
            return { state: null, activeClientId: record.activeClientId, updatedAt: record.updatedAt };
        }
    }

    /**
     * 将该用户属于其他客户端的活动 SSH 会话自动移交给挂起服务，实现真正的无缝接管
     *
     * @param takeoverRound 本轮接管编号，会写进挂起条目，供下一轮清理孤儿用
     */
    public async suspendOtherClientsSessions(
        userId: number,
        currentClientId: string,
        takeoverRound?: number
    ): Promise<void> {
        let snapshotSessions: any[] = [];
        try {
            const record = await workspaceSyncRepo.getWorkspaceSyncRecord(userId);
            if (record?.state) {
                const parsed = JSON.parse(record.state);
                if (Array.isArray(parsed.sessions)) {
                    snapshotSessions = parsed.sessions;
                }
            }
        } catch (e) {
            // ignore
        }

        for (const [sessionId, state] of clientStates.entries()) {
            const wsClientId = (state.ws as any)?.syncClientId;
            // 只接管「另一个**参与工作区同步**的客户端」的会话：
            // 没绑过 clientId 的 ws（桌面端、旧客户端、ws 抢在 store 初始化前连上的窗口期）
            // 不属于这个工作区，把它们挂走就是"挂起池里冒出一个我没打开过的连接"。
            const isForeignClient = isForeignWorkspaceClient(wsClientId, currentClientId);
            // 匹配同一用户、非当前声明接管客户端、且具有活跃 SSH 连接的会话
            if (
                state.ws?.userId === userId &&
                isForeignClient &&
                !state.isMarkedForSuspend &&
                state.sshClient &&
                state.sshShellStream
            ) {
                console.log(`[WorkspaceSyncService] 发现用户 ${userId} 旧客户端 (${wsClientId || 'unknown'}) 的活动会话 ${sessionId}，正在移交挂起...`);
                state.isMarkedForSuspend = true;
                if (!state.suspendLogPath) {
                    state.suspendLogPath = sessionId;
                }

                // 写入终端屏幕最新历史 (精准覆盖或清空)
                const matchedSync = snapshotSessions.find((s: any) => s.sessionId === sessionId);
                if (matchedSync && typeof matchedSync.terminalBuffer === 'string') {
                    try {
                        console.log(`[WorkspaceSyncService] 为挂起会话 ${sessionId} 覆盖同步终端屏幕历史 (字符数: ${matchedSync.terminalBuffer.length})...`);
                        await temporaryLogStorageService.ensureLogDirectoryExists();
                        const normalized = matchedSync.terminalBuffer ? matchedSync.terminalBuffer.replace(/\r?\n/g, '\r\n') : '';
                        const formatted = normalized || '';
                        await temporaryLogStorageService.overwriteLog(state.suspendLogPath, formatted);
                    } catch (logErr) {
                        console.warn(`[WorkspaceSyncService] 覆盖写入终端历史日志失败:`, logErr);
                    }
                }

                const takeoverDetails = {
                    userId,
                    originalSessionId: sessionId,
                    sshClient: state.sshClient,
                    channel: state.sshShellStream,
                    connectionName: state.connectionName || '未知连接',
                    connectionId: String(state.dbConnectionId),
                    logIdentifier: state.suspendLogPath,
                    // 打上本轮编号：下一轮接管才知道它是"上一轮留下的孤儿"
                    takeoverRound,
                };
                const sshClientToPass = state.sshClient;
                const channelToPass = state.sshShellStream;
                state.sshClient = undefined as any;
                state.sshShellStream = undefined;
                state.isSuspendedByService = true;

                try {
                    const newSuspendId = await sshSuspendService.takeOverMarkedSession({
                        ...takeoverDetails,
                        sshClient: sshClientToPass,
                        channel: channelToPass,
                    });
                    console.log(`[WorkspaceSyncService] 会话 ${sessionId} 成功由 SshSuspendService 接管挂起，suspendId: ${newSuspendId}`);
                } catch (err: any) {
                    console.error(`[WorkspaceSyncService] 挂起旧客户端会话 ${sessionId} 失败:`, err);
                    channelToPass?.end();
                    sshClientToPass?.end();
                    state.isSuspendedByService = false;
                }
            }
        }
    }

    /**
     * 客户端声明接管工作区租约，并通知其他客户端进入遮罩状态
     *
     * 【幂等】同一个客户端重复声明（挂载前预取 + 恢复流程、刷新、连点「接管」）
     * 不能再去"移交别人的会话"—— 那时候没有别人的会话可移交，白白多跑一遍
     * `suspendOtherClientsSessions`，还会把本端自己的会话当成别的客户端的。
     */
    public async claimLease(userId: number, clientId: string): Promise<void> {
        console.log(`[WorkspaceSyncService] 用户 ${userId} 客户端 ${clientId} 正在声明接管工作区...`);

        let currentOwner: string | null = null;
        try {
            const record = await workspaceSyncRepo.getWorkspaceSyncRecord(userId);
            currentOwner = record?.activeClientId || null;
        } catch (e) {
            // 读不到就当换人，按原逻辑走
        }

        if (currentOwner === clientId) {
            console.log(`[WorkspaceSyncService] 客户端 ${clientId} 已持有租约，跳过会话移交（幂等声明）`);
            await workspaceSyncRepo.claimWorkspaceLease(userId, clientId);
            this.notifyOtherClientsTakeover(userId, clientId);
            return;
        }

        const round = (this.takeoverRounds.get(userId) || 0) + 1;
        this.takeoverRounds.set(userId, round);
        console.log(`[WorkspaceSyncService] 用户 ${userId} 第 ${round} 轮接管：${currentOwner || '（无）'} -> ${clientId}`);

        await workspaceSyncRepo.claimWorkspaceLease(userId, clientId);
        // 1. 自动挂起旧客户端的 SSH 活动会话
        await this.suspendOtherClientsSessions(userId, clientId, round);
        // 2. 清掉上几轮接管留下、这一轮已经没人认领的挂起条目
        await this.pruneOrphanTakeoverSuspends(userId, round);
        // 3. 广播踢出/遮罩通知
        this.notifyOtherClientsTakeover(userId, clientId);
    }

    /**
     * 清理「上一轮接管留下、这一轮恢复再也用不到」的自动挂起条目。
     *
     * 新端恢复时只认领云端快照里还有的会话，其余（旧端自己那一代、快照还没落库的新会话、
     * 不参与同步的客户端会话）永远没人认领 —— 不清理的话，反复接管几次挂起面板就堆成一串。
     * 快照为空 / 读失败时**不动手**：宁可留着，也不能把正常挂起清光。
     */
    private async pruneOrphanTakeoverSuspends(userId: number, round: number): Promise<void> {
        const keep = new Set<string>();
        try {
            const record = await workspaceSyncRepo.getWorkspaceSyncRecord(userId);
            if (!record?.state) return;
            const parsed = JSON.parse(record.state);
            const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
            if (sessions.length === 0) return;
            for (const item of sessions) {
                if (item?.sessionId) keep.add(String(item.sessionId));
            }
        } catch (e) {
            return;
        }

        try {
            const removed = await sshSuspendService.pruneOrphanTakeoverSessions(userId, round, keep);
            if (removed.length > 0) {
                console.log(
                    `[WorkspaceSyncService] 第 ${round} 轮接管：清掉 ${removed.length} 个上轮遗留的挂起条目 (${removed.join(', ')})`
                );
            }
        } catch (err: any) {
            console.warn(`[WorkspaceSyncService] 清理上轮遗留挂起条目失败:`, err?.message || err);
        }
    }

    /**
     * 保存工作区状态快照
     *
     * 【租约校验】只有持有租约的客户端才能写入。
     *
     * 以前这里无条件覆盖，而且会顺手把 active_client_id 改成调用方 —— 于是被接管的旧页面
     * 只要触发一次"关标签 / 改布局"的自动保存，就能把已关闭的会话重新写回快照，
     * 下次刷新又"复活"。现在非持有者的写入直接拒绝，并把当前持有者回传，
     * 前端据此自己进入接管遮罩（不依赖 WebSocket 踢出消息，断线重连也不会失忆）。
     */
    public async saveState(
        userId: number,
        clientId: string,
        state: WorkspaceSyncStatePayload
    ): Promise<{ accepted: boolean; activeClientId: string | null }> {
        const record = await workspaceSyncRepo.getWorkspaceSyncRecord(userId);
        const leaseOwner = record?.activeClientId || null;

        // 判定逻辑抽到 workspace-sync.pure.ts（被接管后旧客户端的自动保存必须被拒，
        // 否则会出现"关闭会话后刷新又复活"）
        const decision = evaluateLeaseWrite(leaseOwner, clientId);
        if (!decision.accepted) {
            console.warn(
                `[WorkspaceSyncService] 拒绝非租约持有者 ${clientId} 的快照写入（当前持有者: ${decision.activeClientId}），`
                + `会话数 ${Array.isArray((state as any)?.sessions) ? (state as any).sessions.length : '?'}`
            );
            return decision;
        }

        const serialized = JSON.stringify(state);
        await workspaceSyncRepo.saveWorkspaceSyncRecord(userId, serialized, clientId);
        // 保存时确保持有租约，并确保其他端被遮罩
        this.notifyOtherClientsTakeover(userId, clientId);
        return { accepted: true, activeClientId: clientId };
    }

    /**
     * 向同一用户的其他客户端推送接管踢出通知
     */
    public notifyOtherClientsTakeover(userId: number, activeClientId: string): void {
        const sockets = this.userSockets.get(userId);
        if (!sockets) return;

        const kickoutMessage = JSON.stringify({
            type: 'workspace:takeover_kickout',
            payload: {
                activeClientId,
                reason: 'taken_over_by_another_tab',
                timestamp: Date.now()
            }
        });

        for (const ws of sockets) {
            const socketClientId = (ws as any).syncClientId;
            // 如果连接有效且不属于当前接管客户端，则发送被踢出通知
            if (ws.readyState === 1 /* WebSocket.OPEN */ && (!socketClientId || socketClientId !== activeClientId)) {
                console.log(`[WorkspaceSyncService] 通知客户端 ${socketClientId || 'unbound'} 已被 ${activeClientId} 接管`);
                try {
                    ws.send(kickoutMessage);
                } catch (err: any) {
                    console.error(`[WorkspaceSyncService] 发送接管消息到 ${socketClientId} 失败:`, err.message);
                }
            }
        }
    }

    /**
     * 强制彻底销毁指定的会话：
     * 1. 强制杀死该会话的底层 SSH 客户端与通道流，绝不转入挂起；
     * 2. 强制清理挂起服务池中属于该会话的残留记录；
     * 3. 强制从数据库 workspace_sync 快照中剔除该会话并立即落盘。
     * 【核心铁律】：严格仅针对特定的 targetSessionId，绝不能因 connectionId 相同而误伤同连接下的其他活跃会话！
     */
    public async destroySessionCompletely(
        userId: number,
        targetSessionId: string
    ): Promise<{ success: boolean; remainingSessionsCount: number }> {
        console.log(`[WorkspaceSyncService] 开始强制彻底销毁会话: ${targetSessionId} (用户: ${userId})`);

        // 1. 强制切断底层 SSH 客户端与通道流（仅针对目标 targetSessionId）
        const state = clientStates.get(targetSessionId);
        if (state && (!state.ws?.userId || state.ws.userId === userId)) {
            console.log(`[WorkspaceSyncService] 强制切断并关闭活动 SSH 连接: ${targetSessionId}`);
            state.isExplicitlyClosed = true;
            state.isMarkedForSuspend = false;
            state.closeReason = 'client_explicit_destroy';
            try {
                state.sshShellStream?.destroy?.();
                state.sshShellStream?.end?.();
                state.sshClient?.destroy?.();
                state.sshClient?.end?.();
            } catch (e) {
                console.warn(`[WorkspaceSyncService] 切断 SSH 连接发生非致命错误:`, e);
            }
            state.sshClient = undefined as any;
            state.sshShellStream = undefined;
            clientStates.delete(targetSessionId);
        }

        // 2. 强制清理挂起服务池中残留的该会话（仅针对目标 targetSessionId）
        try {
            await sshSuspendService.terminateSuspendedSession(userId, targetSessionId);
            const userSuspended = (sshSuspendService as any).getUserSessions?.(userId);
            if (userSuspended) {
                for (const [suspId, suspSess] of userSuspended.entries()) {
                    if (suspId === targetSessionId || suspSess.originalSessionId === targetSessionId) {
                        console.log(`[WorkspaceSyncService] 强制清理残留挂起条目: ${suspId}`);
                        await sshSuspendService.terminateSuspendedSession(userId, suspId);
                    }
                }
            }
        } catch (e) {
            console.warn(`[WorkspaceSyncService] 清理挂起条目异常:`, e);
        }

        // 3. 强制从数据库 workspace_sync 快照中剔除该会话并立即落盘（仅针对目标 targetSessionId）
        let remainingSessionsCount = 0;
        try {
            const record = await workspaceSyncRepo.getWorkspaceSyncRecord(userId);
            if (record && record.state) {
                const parsedState = JSON.parse(record.state);
                if (Array.isArray(parsedState.sessions)) {
                    const beforeCount = parsedState.sessions.length;
                    // 剔除规则抽到 workspace-sync.pure.ts：只按 sessionId 匹配，
                    // 绝不动同连接下的其他会话；顺带维护 sessionOrder / activeSessionId / fileManagers
                    const { state: nextState, remainingSessionsCount: remaining } = removeSessionFromSnapshot(
                        parsedState,
                        targetSessionId
                    );
                    remainingSessionsCount = remaining;

                    // 立即原子写入数据库落盘
                    await workspaceSyncRepo.saveWorkspaceSyncRecord(
                        userId,
                        JSON.stringify(nextState),
                        record.activeClientId || 'system'
                    );
                    console.log(`[WorkspaceSyncService] 数据库快照已强制剔除会话 ${targetSessionId} (原数量: ${beforeCount}, 剩余: ${remainingSessionsCount})`);
                }
            }
        } catch (dbErr) {
            console.error(`[WorkspaceSyncService] 数据库快照剔除会话落盘失败:`, dbErr);
        }

        return { success: true, remainingSessionsCount };
    }
}

export const workspaceSyncService = new WorkspaceSyncService();
