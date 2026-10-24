/**
 * 文件管理器 pane 的「主机绑定」。
 *
 * 背景：FileManager 过去只会看 `activeSession` 那台机器 —— LayoutRenderer 对每个 ssh 会话
 * 都渲染一份 FileManager，用 `v-show` 只显示活动会话那一份。所以两个文件管理器永远同时
 * 盯着同一台主机，跨主机拖拽根本无从谈起。
 *
 * 这里给每个 pane（instanceId）记一台主机，让 pane 摆脱"跟随活动会话"。
 *
 * 存的是什么：**连接的 uuid**，不是本地自增 id，也不是 sessionId。
 *  - sessionId 会在 ssh:connected 时被后端 SID 顶替（见 sessionActions 的 sessionOrder 原位替换）；
 *  - connection id 是各端自增的，跨端同步过去会指到另一台机器上。
 *
 * 存到哪：`componentStateStore`（`settings.componentInstanceStates`），键
 * `fm_host_binding:<paneId>`。这个设置项本身在同步清单里（`layout.componentStates`），
 * 所以绑定会跟着「布局」一起跨端走，不必另做一套同步。localStorage 里的旧格式
 * （`nexus.fileManager.hostBindings`，paneId → 数字 id）只用于一次性迁移。
 *
 * 选中的主机没有开着终端时，会开一条**无终端会话**（headless）作为它的 SFTP 通道；
 * 这条会话由本 store 负责关闭（按 connectionId 引用计数），不归用户管。
 */
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { sessions } from './session/state';
import { useSessionStore } from './session.store';
import { useConnectionsStore } from './connections.store';
import { useComponentStateStore } from './componentState.store';

/** 旧格式的 localStorage 键（paneId → connectionId），仅用于迁移，读完即删 */
const LEGACY_STORAGE_KEY = 'nexus.fileManager.hostBindings';
/** 同步用的设置项键前缀 */
const STATE_KEY_PREFIX = 'fm_host_binding:';

/** paneId → 连接引用（uuid；后端没给 uuid 的极老数据退化成本地 `#<id>`） */
type BindingMap = Record<string, string>;

export const useFileManagerHostsStore = defineStore('fileManagerHosts', () => {
    const componentStateStore = useComponentStateStore();
    const connectionsStore = useConnectionsStore();

    const bindings = ref<BindingMap>({});
    /** 我们自己开出来的无终端会话，按 connectionId 记：只有这些才由我们关闭（纯本地运行时状态） */
    const ownedSessions = ref<Set<number>>(new Set());

    /** 从同步下来的组件状态里重建绑定表 */
    const loadBindings = () => {
        const next: BindingMap = {};
        for (const [key, value] of Object.entries(componentStateStore.states)) {
            if (!key.startsWith(STATE_KEY_PREFIX)) continue;
            if (typeof value !== 'string' || !value) continue;
            next[key.slice(STATE_KEY_PREFIX.length)] = value;
        }
        bindings.value = next;
    };

    const connectionRefOf = (connectionId: number): string => {
        const conn = connectionsStore.connections.find(c => Number(c.id) === connectionId);
        return conn?.uuid ? String(conn.uuid) : `#${connectionId}`;
    };

    const connectionIdFor = (paneId: string): number | null => {
        const ref_ = bindings.value[paneId];
        if (!ref_) return null;
        if (ref_.startsWith('#')) {
            const id = parseInt(ref_.slice(1), 10);
            return Number.isFinite(id) ? id : null;
        }
        const conn = connectionsStore.connections.find(c => String(c.uuid) === ref_);
        return conn ? Number(conn.id) : null;
    };

    /**
     * 把旧版 localStorage 里的「paneId → 数字 id」迁成 uuid 并写进同步状态。
     * 连接列表还没拉回来时先留着，等 connections 变化再试一次。
     */
    const migrateLegacyBindings = () => {
        if (typeof localStorage === 'undefined') return;
        const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (!raw) return;
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            localStorage.removeItem(LEGACY_STORAGE_KEY);
            return;
        }
        const pending: Record<string, number> = {};
        for (const [paneId, value] of Object.entries(parsed || {})) {
            const id = typeof value === 'number' ? value : parseInt(String(value), 10);
            if (!Number.isFinite(id)) continue;
            const conn = connectionsStore.connections.find(c => Number(c.id) === id);
            if (!conn) {
                // 连接列表还没到位（或这台机器上确实没有这条连接）：留着下次再试
                pending[paneId] = id;
                continue;
            }
            if (bindings.value[paneId]) continue; // 同步下来的值优先，不覆盖
            const ref_ = conn.uuid ? String(conn.uuid) : `#${id}`;
            bindings.value = { ...bindings.value, [paneId]: ref_ };
            componentStateStore.setState(STATE_KEY_PREFIX + paneId, ref_);
        }
        if (Object.keys(pending).length > 0) {
            localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(pending));
        } else {
            localStorage.removeItem(LEGACY_STORAGE_KEY);
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

    /** 这个 pane 当前该显示哪条会话；null = 没绑定（调用方回落到活动会话） */
    const sessionIdFor = (paneId: string): string | null => {
        const connectionId = connectionIdFor(paneId);
        if (connectionId == null) return null;
        return findSessionIdByConnection(connectionId);
    };

    const isBound = (paneId: string): boolean => !!bindings.value[paneId];

    /**
     * 确保这台主机有一条可用的 SFTP 通道。
     * 连接列表还没拉回来时返回 null —— 由调用方稍后重试，绝不在这里造一条空会话。
     */
    const ensureSession = (connectionId: number): string | null => {
        const existing = findSessionIdByConnection(connectionId);
        if (existing) return existing;

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

    /** 把某个 pane 钉到某台主机上（写进同步状态，另一端跟着走） */
    const bind = (paneId: string, connectionId: number): boolean => {
        const sessionId = ensureSession(connectionId);
        const ref_ = connectionRefOf(connectionId);
        bindings.value = { ...bindings.value, [paneId]: ref_ };
        componentStateStore.setState(STATE_KEY_PREFIX + paneId, ref_);
        return !!sessionId;
    };

    const unbind = (paneId: string) => {
        if (!(paneId in bindings.value)) return;
        const next = { ...bindings.value };
        delete next[paneId];
        bindings.value = next;
        void componentStateStore.removeState(STATE_KEY_PREFIX + paneId);
    };

    /**
     * pane 被销毁 / 改回跟随活动会话时调用：
     * 解除绑定，并在没有任何 pane 还引用这台主机时关掉我们开的无终端会话。
     */
    const release = async (paneId: string) => {
        const connectionId = connectionIdFor(paneId);
        unbind(paneId);
        if (connectionId == null) return;
        const stillUsed = Object.keys(bindings.value).some(id => connectionIdFor(id) === connectionId);
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

    // 初始：先读同步下来的状态，再尝试迁移旧格式
    loadBindings();
    migrateLegacyBindings();

    /**
     * 远端改了绑定（另一台设备选了主机）时跟着重建。
     * `revision` 由 componentStateStore 在每次「从后端整体重载」后自增；
     * 只在本机改的话走 setState，不触发 revision，不会有回环。
     */
    watch(
        () => componentStateStore.revision,
        () => {
            loadBindings();
            migrateLegacyBindings();
            restore();
        }
    );

    // 连接列表到位后：把还没解析出来的绑定补建出来（headless 会话需要真实连接）
    watch(
        () => connectionsStore.connections.length,
        () => {
            migrateLegacyBindings();
            restore();
        }
    );

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
