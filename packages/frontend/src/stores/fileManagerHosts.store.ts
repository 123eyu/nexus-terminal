/**
 * 文件管理器 pane 的「主机绑定」。
 *
 * 背景：FileManager 过去只会看 `activeSession` 那台机器 —— LayoutRenderer 对每个 ssh 会话
 * 都渲染一份 FileManager，用 `v-show` 只显示活动会话那一份。所以两个文件管理器永远同时
 * 盯着同一台主机，跨主机拖拽根本无从谈起。
 *
 * 这里给每个 pane（instanceId）记一个 connectionId，让 pane 摆脱"跟随活动会话"。
 * 之所以存 connectionId 而不是 sessionId：sessionId 会在 ssh:connected 时被后端的 SID
 * 顶替（见 sessionActions 的 sessionOrder 原位替换），存下来必然失效。
 *
 * 选中的主机没有开着终端时，会开一条**无终端会话**（headless）作为它的 SFTP 通道；
 * 这条会话由本 store 负责关闭（按 connectionId 引用计数），不归用户管。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { sessions } from './session/state';
import { useSessionStore } from './session.store';
import { useConnectionsStore } from './connections.store';

const STORAGE_KEY = 'nexus.fileManager.hostBindings';

type BindingMap = Record<string, number>;

const readBindings = (): BindingMap => {
    if (typeof localStorage === 'undefined') return {};
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object') return {};
        const result: BindingMap = {};
        for (const [paneId, value] of Object.entries(parsed as Record<string, unknown>)) {
            const num = typeof value === 'number' ? value : parseInt(String(value), 10);
            if (!Number.isNaN(num)) result[paneId] = num;
        }
        return result;
    } catch {
        return {};
    }
};

export const useFileManagerHostsStore = defineStore('fileManagerHosts', () => {
    const bindings = ref<BindingMap>(readBindings());
    /** 我们自己开出来的无终端会话，按 connectionId 记：只有这些才由我们关闭 */
    const ownedSessions = ref<Set<number>>(new Set());

    const persist = () => {
        if (typeof localStorage === 'undefined') return;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings.value));
        } catch (err) {
            console.warn('[FileManagerHosts] 保存主机绑定失败:', err);
        }
    };

    /**
     * 按 connectionId 找一条可用的 ssh 会话（含无终端会话）。
     * 优先拿我们自己开的，避免抢占用户正在用的终端会话。
     */
    const findSessionIdByConnection = (connectionId: number): string | null => {
        const target = String(connectionId);
        let fallback: string | null = null;
        for (const [sessionId, session] of sessions.value.entries()) {
            if (session.kind !== 'ssh') continue;
            if (String(session.connectionId) !== target) continue;
            if (session.headless) return sessionId;
            if (!fallback) fallback = sessionId;
        }
        return fallback;
    };

    const connectionIdFor = (paneId: string): number | null => {
        const value = bindings.value[paneId];
        return typeof value === 'number' ? value : null;
    };

    /** 这个 pane 当前该显示哪条会话；null = 没绑定（调用方回落到活动会话） */
    const sessionIdFor = (paneId: string): string | null => {
        const connectionId = connectionIdFor(paneId);
        if (connectionId == null) return null;
        return findSessionIdByConnection(connectionId);
    };

    const isBound = (paneId: string): boolean => connectionIdFor(paneId) != null;

    /**
     * 确保这台主机有一条可用的 SFTP 通道。
     * 连接列表还没拉回来时返回 null —— 由调用方稍后重试，绝不在这里造一条空会话。
     */
    const ensureSession = (connectionId: number): string | null => {
        const existing = findSessionIdByConnection(connectionId);
        if (existing) return existing;

        const connectionsStore = useConnectionsStore();
        const known = connectionsStore.connections.some(c => Number(c.id) === connectionId);
        if (!known) return null;

        const sessionStore = useSessionStore();
        const newSessionId = sessionStore.openNewSession(connectionId, undefined, false, { headless: true });
        if (!newSessionId) {
            console.error(`[FileManagerHosts] 为连接 ${connectionId} 创建无终端会话失败`);
            return null;
        }
        ownedSessions.value.add(connectionId);
        console.log(`[FileManagerHosts] 已为连接 ${connectionId} 建立无终端会话 ${newSessionId}`);
        return newSessionId;
    };

    /** 把某个 pane 钉到某台主机上 */
    const bind = (paneId: string, connectionId: number): boolean => {
        const sessionId = ensureSession(connectionId);
        // 会话没建起来也照样记下绑定：连接列表稍后到位时它能自动生效
        bindings.value = { ...bindings.value, [paneId]: connectionId };
        persist();
        return !!sessionId;
    };

    const unbind = (paneId: string) => {
        if (!(paneId in bindings.value)) return;
        const next = { ...bindings.value };
        delete next[paneId];
        bindings.value = next;
        persist();
    };

    /**
     * pane 被销毁 / 改回跟随活动会话时调用：
     * 解除绑定，并在没有任何 pane 还引用这台主机时关掉我们开的无终端会话。
     */
    const release = async (paneId: string) => {
        const connectionId = connectionIdFor(paneId);
        unbind(paneId);
        if (connectionId == null) return;
        const stillUsed = Object.values(bindings.value).some(id => id === connectionId);
        if (stillUsed) return;
        if (!ownedSessions.value.has(connectionId)) return; // 借来的会话不归我们关
        const sessionId = findSessionIdByConnection(connectionId);
        ownedSessions.value.delete(connectionId);
        if (!sessionId) return;
        try {
            await useSessionStore().closeSession(sessionId);
            console.log(`[FileManagerHosts] 已关闭连接 ${connectionId} 的无终端会话 ${sessionId}`);
        } catch (err) {
            console.warn('[FileManagerHosts] 关闭无终端会话失败:', err);
        }
    };

    /** 恢复持久化的绑定（把还没建起来的会话补上） */
    const restore = (paneId?: string) => {
        const paneIds = paneId ? [paneId] : Object.keys(bindings.value);
        for (const id of paneIds) {
            const connectionId = connectionIdFor(id);
            if (connectionId == null) continue;
            ensureSession(connectionId);
        }
    };

    return {
        bindings,
        bind,
        unbind,
        release,
        restore,
        ensureSession,
        sessionIdFor,
        connectionIdFor,
        isBound,
    };
});
