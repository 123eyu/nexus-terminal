/**
 * 文件管理器 pane 的「主机绑定」。
 *
 * 背景：FileManager 过去只会看 `activeSession` 那台机器 —— LayoutRenderer 对每个 ssh 会话
 * 都渲染一份 FileManager，用 `v-show` 只显示活动会话那一份。所以两个文件管理器永远同时
 * 盯着同一台主机，跨主机拖拽根本无从谈起。
 *
 * 这里给「某个布局里的某个 pane」记一台主机，让 pane 摆脱"跟随活动会话"。
 *
 * ## 为什么 key 必须带「所属会话」
 *
 * 布局里的 pane id 是**结构序号**（`container-0` / `terminal-1` / `pane-2`），每个会话的
 * 布局树都是从同一个预设克隆出来的 → **所有会话的同一个 pane 是同一个 id**。
 * 早期只按 paneId 存绑定，于是「在 A 会话把文件管理器切到 C」变成了全局设置：
 * 打开 B 会话，它的文件管理器也一起跑到 C 去了（用户报的就是这个）。
 *
 * 正确语义是：**每个会话（= 每个布局沙箱）各记一份**。没显式切过的时候，
 * 该会话里的每个文件管理器都默认显示这台主机自己的 SFTP —— 也就是跟随该会话。
 *
 * ## 为什么 owner 用连接 uuid 而不是 sessionId
 *
 * sessionId 每次刷新页面都会变（ssh:connected 后还会被后端 SID 顶替），拿它当持久化
 * key，刷新一次绑定就全丢。连接 uuid 才是跨刷新、跨端稳定且唯一的身份。
 *
 * ## 存的是什么
 *
 * **连接的 uuid**，不是本地自增 id，也不是 sessionId：connection id 是各端自增的，
 * 跨端同步过去会指到另一台机器上。
 *
 * 存到哪：`componentStateStore`（`settings.componentInstanceStates`），键
 * `fm_host_binding:<ownerKey>|<paneId>`。这个设置项本身在同步清单里
 * （`layout.componentStates`），所以绑定会跟着「布局」一起跨端走，不必另做一套同步。
 * localStorage 里的旧格式（`nexus.fileManager.hostBindings`，paneId → 数字 id）只用于一次性迁移。
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
/** ownerKey 与 paneId 之间的分隔符（paneId 只含字母数字与 `-`，不会冲突） */
const KEY_SEP = '|';

/** 复合键：`<ownerKey>|<paneId>` → 连接引用（uuid；后端没给 uuid 的极老数据退化成本地 `#<id>`） */
type BindingMap = Record<string, string>;

const compositeKey = (ownerKey: string | null, paneId: string): string | null =>
    ownerKey ? `${ownerKey}${KEY_SEP}${paneId}` : null;

export const useFileManagerHostsStore = defineStore('fileManagerHosts', () => {
    const componentStateStore = useComponentStateStore();
    const connectionsStore = useConnectionsStore();

    const bindings = ref<BindingMap>({});
    /** 我们自己开出来的无终端会话，按 connectionId 记：只有这些才由我们关闭（纯本地运行时状态） */
    const ownedSessions = ref<Set<number>>(new Set());

    /**
     * 当前有几个「真终端」会话（不含无终端会话）。
     *
     * 0 意味着工作区里一条标签都没有 —— 没有布局、没有 pane 要显示文件管理器。
     * 这个值既是「该不该补建无终端会话」的开关，也是「该不该把私有通道收掉」的开关。
     */
    const terminalSessionCount = (): number => {
        let n = 0;
        for (const session of sessions.value.values()) {
            if (!session.headless) n++;
        }
        return n;
    };

    /**
     * 布局归属键：一台主机上的同一份布局，绑定互通；不同主机各自独立。
     *
     * 解析不出来（会话还没建 / 连接列表没到）时返回 `s:<sessionId>`：
     * 至少同一页面生命周期内是稳定的，不会串到别的会话去。
     */
    const ownerKeyFor = (ownerSessionId?: string | null): string | null => {
        if (!ownerSessionId) return null;
        const connectionId = sessions.value.get(ownerSessionId)?.connectionId;
        if (connectionId !== undefined && connectionId !== null) {
            const conn = connectionsStore.connections.find(c => Number(c.id) === Number(connectionId));
            if (conn?.uuid) return `c:${conn.uuid}`;
        }
        return `s:${ownerSessionId}`;
    };

    /**
     * 从同步下来的组件状态里重建绑定表。
     *
     * 同时清理**旧格式**（`fm_host_binding:<paneId>`，没有 owner 段）：
     * 那种值是「所有主机共享」，正是这次要废掉的语义，留着只会在新会话里继续串台。
     */
    const loadBindings = () => {
        const next: BindingMap = {};
        const stale: string[] = [];
        for (const [key, value] of Object.entries(componentStateStore.states)) {
            if (!key.startsWith(STATE_KEY_PREFIX)) continue;
            if (typeof value !== 'string' || !value) continue;
            const rest = key.slice(STATE_KEY_PREFIX.length);
            const sep = rest.indexOf(KEY_SEP);
            if (sep <= 0) {
                // 旧格式：全局共享，直接作废
                stale.push(key);
                continue;
            }
            next[rest] = value;
        }
        bindings.value = next;
        if (stale.length > 0) {
            console.log('[FileManagerHosts] 清理旧格式（全局共享）的主机绑定:', stale);
            for (const key of stale) void componentStateStore.removeState(key);
        }
    };

    const connectionRefOf = (connectionId: number): string => {
        const conn = connectionsStore.connections.find(c => Number(c.id) === Number(connectionId));
        return conn?.uuid ? String(conn.uuid) : `#${connectionId}`;
    };

    const connectionIdFor = (paneId: string, ownerSessionId?: string | null): number | null => {
        const key = compositeKey(ownerKeyFor(ownerSessionId), paneId);
        if (!key) return null;
        const ref_ = bindings.value[key];
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
     *
     * 旧格式没有 owner 维度，迁到哪一份布局都不算对，所以只在**有明确归属**时迁移：
     * 交给第一个打开该 pane 的会话（调用方通过 `adoptLegacyBinding` 触发）。
     * 没有归属就先留在 localStorage，等调用方带 owner 来认领。
     */
    const readLegacyBindings = (): Record<string, number> => {
        if (typeof localStorage === 'undefined') return {};
        const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (!raw) return {};
        try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            const out: Record<string, number> = {};
            for (const [paneId, value] of Object.entries(parsed || {})) {
                const id = typeof value === 'number' ? value : parseInt(String(value), 10);
                if (Number.isFinite(id)) out[paneId] = id;
            }
            return out;
        } catch {
            localStorage.removeItem(LEGACY_STORAGE_KEY);
            return {};
        }
    };

    /**
     * 认领旧格式里某个 pane 的绑定（由第一个打开该 pane 的布局调用）。
     * 连接列表还没到位时留着，等 connections 变化再试一次。
     */
    const adoptLegacyBinding = (paneId: string, ownerSessionId?: string | null): boolean => {
        if (typeof localStorage === 'undefined') return false;
        const legacy = readLegacyBindings();
        if (!(paneId in legacy)) return false;
        const connectionId = legacy[paneId];
        const conn = connectionsStore.connections.find(c => Number(c.id) === connectionId);
        if (!conn) return false; // 连接列表还没到位，下次再试
        const key = compositeKey(ownerKeyFor(ownerSessionId), paneId);
        if (!key || bindings.value[key]) {
            // 已经有新语义的绑定了：旧的这条作废
            delete legacy[paneId];
        } else {
            const ref_ = conn.uuid ? String(conn.uuid) : `#${connectionId}`;
            bindings.value = { ...bindings.value, [key]: ref_ };
            componentStateStore.setState(STATE_KEY_PREFIX + key, ref_);
            delete legacy[paneId];
        }
        if (Object.keys(legacy).length > 0) {
            localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacy));
        } else {
            localStorage.removeItem(LEGACY_STORAGE_KEY);
        }
        return true;
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

    /** 这个 pane 当前该显示哪条会话；null = 该布局没绑过主机（调用方回落到它自己的会话） */
    const sessionIdFor = (paneId: string, ownerSessionId?: string | null): string | null => {
        const connectionId = connectionIdFor(paneId, ownerSessionId);
        if (connectionId == null) return null;
        return findSessionIdByConnection(connectionId);
    };

    const isBound = (paneId: string, ownerSessionId?: string | null): boolean => {
        const key = compositeKey(ownerKeyFor(ownerSessionId), paneId);
        return !!key && !!bindings.value[key];
    };

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

    /** 把某个 pane（在某一份布局里）钉到某台主机上（写进同步状态，另一端跟着走） */
    const bind = (paneId: string, connectionId: number, ownerSessionId?: string | null): boolean => {
        const key = compositeKey(ownerKeyFor(ownerSessionId), paneId);
        if (!key) {
            console.warn('[FileManagerHosts] 缺少所属会话，无法绑定主机');
            return false;
        }
        const sessionId = ensureSession(connectionId);
        const ref_ = connectionRefOf(connectionId);
        bindings.value = { ...bindings.value, [key]: ref_ };
        componentStateStore.setState(STATE_KEY_PREFIX + key, ref_);
        return !!sessionId;
    };

    const unbind = (paneId: string, ownerSessionId?: string | null) => {
        const key = compositeKey(ownerKeyFor(ownerSessionId), paneId);
        if (!key || !(key in bindings.value)) return;
        const next = { ...bindings.value };
        delete next[key];
        bindings.value = next;
        void componentStateStore.removeState(STATE_KEY_PREFIX + key);
    };

    /**
     * pane 被销毁 / 改回跟随活动会话时调用：
     * 解除绑定，并在**没有任何布局**还引用这台主机时关掉我们开的无终端会话。
     */
    const release = async (paneId: string, ownerSessionId?: string | null) => {
        const connectionId = connectionIdFor(paneId, ownerSessionId);
        unbind(paneId, ownerSessionId);
        if (connectionId == null) return;
        // 别的布局里可能还绑着这台主机：那种情况下会话不能关
        const stillUsed = Object.keys(bindings.value).some((key) =>
            referenceOfKey(key) === connectionId
        );
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

    /** 把复合键的值解回本地 connectionId（用于释放会话前的引用计数） */
    const referenceOfKey = (key: string): number | null => {
        const ref_ = bindings.value[key];
        if (!ref_) return null;
        if (ref_.startsWith('#')) {
            const id = parseInt(ref_.slice(1), 10);
            return Number.isFinite(id) ? id : null;
        }
        const conn = connectionsStore.connections.find(c => String(c.uuid) === ref_);
        return conn ? Number(conn.id) : null;
    };

    /** 恢复持久化的绑定（把还没建起来的会话补上） */
    const restore = (paneId?: string, ownerSessionId?: string | null) => {
        // 一条终端会话都没有时不补建。
        //
        // 触发时机就是「用户关掉最后一个标签」：绑定是按连接 uuid 存的、不随会话消失，
        // 这时再去 ensureSession 就等于在空工作区里悄悄开一条**没有标签**的会话，
        // 它随后被写进云端快照，下次打开网页就被当成标签恢复 ——
        // 用户看到的是「我刚关掉的连接又自己回来了」。
        // 刷新后恢复不需要担心：恢复流程建好会话，下面的 watch 会再补一次。
        if (terminalSessionCount() === 0) return;

        const keys = paneId
            ? [compositeKey(ownerKeyFor(ownerSessionId), paneId)].filter(Boolean) as string[]
            : Object.keys(bindings.value);
        for (const key of keys) {
            const connectionId = referenceOfKey(key);
            if (connectionId == null) continue;
            ensureSession(connectionId);
        }
    };

    /** 收掉所有我们自己开的无终端会话（工作区已经没有终端了，这些通道没有宿主） */
    const closeOwnedSessions = async () => {
        const connectionIds = Array.from(ownedSessions.value);
        if (connectionIds.length === 0) return;
        ownedSessions.value.clear();
        for (const connectionId of connectionIds) {
            const sessionId = findSessionIdByConnection(connectionId);
            const session = sessionId ? sessions.value.get(sessionId) : undefined;
            // 只关无终端会话：同连接上如果还有用户自己的终端，不能动
            if (!sessionId || !session?.headless) continue;
            try {
                await useSessionStore().closeSession(sessionId);
                console.log(`[FileManagerHosts] 工作区已无终端会话，关闭连接 ${connectionId} 的无终端会话 ${sessionId}`);
            } catch (err) {
                console.warn('[FileManagerHosts] 关闭无终端会话失败:', err);
            }
        }
    };

    // 初始：先读同步下来的状态（旧格式的 localStorage 迁移要等连接列表，见下方 watch）
    loadBindings();

    /**
     * 远端改了绑定（另一台设备选了主机）时跟着重建。
     * `revision` 由 componentStateStore 在每次「从后端整体重载」后自增；
     * 只在本机改的话走 setState，不触发 revision，不会有回环。
     */
    watch(
        () => componentStateStore.revision,
        () => {
            loadBindings();
            restore();
        }
    );

    // 连接列表到位后：把还没解析出来的绑定补建出来（headless 会话需要真实连接）
    watch(
        () => connectionsStore.connections.length,
        () => {
            restore();
        }
    );

    /**
     * 终端会话数变化是「工作区还在不在」的唯一信号：
     *
     * - 0 → 有：刷新/接管后恢复流程把会话建好了，这时才补建无终端通道
     *   （挂载早期 `restore()` 会因为「一条终端都没有」直接跳过，不补就永远缺通道）；
     * - 有 → 0：用户关掉了最后一个标签，私有通道没有宿主了，立即收掉 ——
     *   否则那条 SSH 会一直挂在后台（还会在下次接管时被挂进挂起池）。
     */
    watch(terminalSessionCount, (now, prev) => {
        if (now > 0 && prev === 0) {
            restore();
        } else if (now === 0 && prev > 0) {
            void closeOwnedSessions();
        }
    });

    return {
        bindings,
        ownerKeyFor,
        bind,
        unbind,
        release,
        restore,
        adoptLegacyBinding,
        ensureSession,
        sessionIdFor,
        connectionIdFor,
        isBound,
    };
});
