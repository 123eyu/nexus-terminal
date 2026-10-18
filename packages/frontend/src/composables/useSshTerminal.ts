import { ref, readonly, type Ref, ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { sessions as globalSessionsRef } from '../stores/session/state'; // +++ 导入全局 sessions state +++
// import { useWebSocketConnection } from './useWebSocketConnection'; // 移除全局导入
import type { Terminal } from 'xterm';
import type { SearchAddon, ISearchOptions } from '@xterm/addon-search'; // *** 移除 ISearchResult 导入 ***
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { WebSocketMessage, MessagePayload } from '../types/websocket.types';
import { useTerminalHighlightStore } from '../stores/terminal-highlight.store';
import { useWorkspaceSyncStore } from '../stores/workspaceSync.store';
import { useLayoutStore, getTerminalPaneIdsInLayout } from '../stores/layout.store';

// 定义与 WebSocket 相关的依赖接口
export interface SshTerminalDependencies {
    sendMessage: (message: WebSocketMessage) => void;
    onMessage: (type: string, handler: (payload: any, fullMessage?: WebSocketMessage) => void) => () => void;
    isConnected: ComputedRef<boolean>;
}

// 多终端分屏实例状态
export interface PaneTerminalInstance {
    paneId: string;
    terminal: Terminal;
    searchAddon: SearchAddon | null;
    serializeAddon?: SerializeAddon | null;
    isReady: boolean;
}

/**
 * 创建一个 SSH 终端管理器实例
 * @param sessionId 会话唯一标识符
 * @param wsDeps WebSocket 依赖对象
 * @param t i18n 翻译函数，从父组件传入
 * @returns SSH 终端管理器实例
 */
export function createSshTerminalManager(sessionId: string, wsDeps: SshTerminalDependencies, t: ReturnType<typeof useI18n>['t']) { // +++ Update type of t +++
    // 使用依赖注入的 WebSocket 函数
    const { sendMessage, onMessage, isConnected } = wsDeps;
    const highlightStore = useTerminalHighlightStore();

    // 多终端分屏实例 Map (支持同一连接挂载多个终端窗口)
    const terminalPanes = ref(new Map<string, PaneTerminalInstance>());
    const primaryPaneId = ref<string | null>(null);

    const terminalInstance = ref<Terminal | null>(null);
    const searchAddon = ref<SearchAddon | null>(null); // Keep searchAddon ref
    const serializeAddon = ref<SerializeAddon | null>(null); // 保存 SerializeAddon 实例
    // Removed search result state refs
    // const searchResultCount = ref(0);
    // const currentSearchResultIndex = ref(-1);
    const terminalOutputBuffer = ref<(string | Uint8Array)[]>([]); // 缓冲 WebSocket 消息直到终端准备好
    const isSshConnected = ref(false); // 跟踪 SSH 连接状态
    const hasConnectedBefore = ref(false); // 跟踪是否曾经连接过（用于识别重连事件）

    // 终端数据流防抖同步至云端工作区 (输出停歇 1.5s 后触发，命令执行中自动延后)
    let terminalSyncTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleTerminalSync = (delayMs: number = 1500) => {
        if (terminalSyncTimer) clearTimeout(terminalSyncTimer);
        terminalSyncTimer = setTimeout(() => {
            try {
                const workspaceSyncStore = useWorkspaceSyncStore();
                if (workspaceSyncStore.syncEnabled && !workspaceSyncStore.isRestoring && !workspaceSyncStore.isTakenOver) {
                    workspaceSyncStore.triggerDebouncedSave(0);
                }
            } catch {
                // Pinia 上下文未就绪时安全忽略
            }
        }, delayMs);
    };

    // 辅助函数：获取终端消息文本
    const getTerminalText = (key: string, params?: Record<string, any>): string => {
        // 确保 i18n key 存在，否则返回原始 key
        const translationKey = `workspace.terminal.${key}`;
        const translated = t(translationKey, params || {});
        return translated === translationKey ? key : translated;
    };

    // --- 终端事件处理 ---

    const handleTerminalReady = (payload: { terminal: Terminal; searchAddon: SearchAddon | null; serializeAddon?: SerializeAddon | null; paneId?: string }) => {
        const { terminal: term, searchAddon: addon, serializeAddon: sAddon, paneId } = payload;
        const effectivePaneId = paneId || 'primary';
        console.log(`[会话 ${sessionId}][SSH终端模块] 终端实例已就绪 (paneId: ${effectivePaneId})。SearchAddon: ${addon ? '存在' : '不存在'}, SerializeAddon: ${sAddon ? '存在' : '不存在'}`);

        const entry: PaneTerminalInstance = {
            paneId: effectivePaneId,
            terminal: term,
            searchAddon: addon,
            serializeAddon: sAddon || null,
            isReady: false
        };
        terminalPanes.value.set(effectivePaneId, entry);

        // 兜底：旧快照可能把"备用屏（TUI）"状态一起存了下来。
        // 这里先强制切回主屏，避免刷新后 Ctrl+C 退出 TUI 时回到一个空的备用屏、整块变黑。
        try {
            term.write('\x1b[?1049l\x1b[0m');
        } catch {
            /* 忽略 */
        }

        const currentSessionState = globalSessionsRef.value.get(sessionId);

        // --- 主终端锁定 ---
        // 必须用"当前实际渲染的树"（桌面端为活动会话的专属树）：
        // 其 paneId 与主布局树不是同一套，用错树会锁定一个不存在于 terminalPanes 的
        // paneId，导致 terminalInstance 永远不赋值、主通道判定失效。
        let treeTerminalIds: string[] = [];
        try {
            const layoutStore = useLayoutStore();
            treeTerminalIds = getTerminalPaneIdsInLayout(layoutStore.getActiveLayoutTree());
        } catch {
            // 忽略 store 异常
        }

        if (!primaryPaneId.value) {
            const recorded = (currentSessionState as any)?.primaryTerminalPaneId as string | undefined;
            primaryPaneId.value = (recorded && treeTerminalIds.includes(recorded) ? recorded : undefined)
                ?? treeTerminalIds[0]
                ?? effectivePaneId;
            if (currentSessionState) {
                (currentSessionState as any).primaryTerminalPaneId = primaryPaneId.value;
            }
            console.log(`[会话 ${sessionId}][SSH终端模块] 确定主终端 primaryPaneId 为: ${primaryPaneId.value} (当前就绪终端: ${effectivePaneId})`);
        } else if (treeTerminalIds.length > 0 && !treeTerminalIds.includes(primaryPaneId.value)) {
            // 已锁定的主终端在当前布局树里根本不存在了
            // （会话从 localStorage/后端恢复后布局树会重新生成 ID，或用户改过布局）
            console.warn(`[会话 ${sessionId}][SSH终端模块] 主终端 ${primaryPaneId.value} 已不在当前布局树中，重新选定为 ${effectivePaneId}`);
            primaryPaneId.value = effectivePaneId;
            if (currentSessionState) {
                (currentSessionState as any).primaryTerminalPaneId = primaryPaneId.value;
            }
        }

        // 如果是主终端，写入历史缓冲
        if (effectivePaneId === primaryPaneId.value) {
            terminalInstance.value = term;
            searchAddon.value = addon;
            serializeAddon.value = sAddon || null;

            // 1. 处理 SessionState.pendingOutput (来自 SSH_OUTPUT_CACHED_CHUNK 的早期数据)
            if (currentSessionState && currentSessionState.pendingOutput && currentSessionState.pendingOutput.length > 0) {
                currentSessionState.pendingOutput.forEach(data => {
                    const normalizedData = typeof data === 'string' ? data.replace(/\r?\n/g, '\r\n') : data;
                    term.write(sanitizeTuiTransition(highlightStore.highlight(normalizedData)));
                });
                currentSessionState.pendingOutput = []; // 清空
                if (currentSessionState.isResuming) {
                    currentSessionState.isResuming = false;
                }
            }

            // 2. 将此管理器内部缓冲的输出 (terminalOutputBuffer, 来自 ssh:output) 写入终端
            if (terminalOutputBuffer.value.length > 0) {
                terminalOutputBuffer.value.forEach(data => {
                    term.write(sanitizeTuiTransition(highlightStore.highlight(data)));
                });
                terminalOutputBuffer.value = []; // 清空内部缓冲区
            }
        } else {
            // 如果是分屏副终端，检查是否从云端同步中缓存了历史屏幕缓冲
            // 快照里存的是 pane#0/pane#1 这类稳定序号键（会话树每次刷新都会重编 paneId），
            // 先按序号换算，再退回按 paneId 直接取。
            const paneBufMap = (currentSessionState as any)?.lastTerminalPanesBuffer;
            let cachedPaneBuffer = paneBufMap?.[effectivePaneId];
            const usedKeys: string[] = cachedPaneBuffer ? [effectivePaneId] : [];
            if (!cachedPaneBuffer && paneBufMap) {
                try {
                    const layoutStore = useLayoutStore();
                    const order = layoutStore.getSessionTerminalPaneOrder(sessionId);
                    const idx = order.indexOf(effectivePaneId);
                    if (idx >= 0) {
                        cachedPaneBuffer = paneBufMap[`pane#${idx}`];
                        if (cachedPaneBuffer) usedKeys.push(`pane#${idx}`);
                    }
                } catch {
                    /* 忽略 store 异常 */
                }
            }
            if (cachedPaneBuffer && typeof cachedPaneBuffer === 'string' && cachedPaneBuffer.length > 0) {
                console.log(`[会话 ${sessionId}][SSH终端模块] 正在为分屏副终端 ${effectivePaneId} 回放云端同步历史缓冲 (长度: ${cachedPaneBuffer.length})...`);
                const normalized = cachedPaneBuffer.replace(/\r?\n/g, '\r\n').replace(/(\r\n)+$/, '');
                term.write(sanitizeTuiTransition(highlightStore.highlight(normalized)));
                // 消费掉这段缓存：workspaceSync 里还有一条"panes 已就绪时立即回放"的路径，
                // 不清掉会写第二遍，表现为刷新后终端里多出好几个重复的提示符。
                usedKeys.forEach((k) => {
                    try {
                        delete paneBufMap[k];
                    } catch {
                        /* noop */
                    }
                });
            }

            // 向后端请求开辟/复用独立的 Shell 通道！
            console.log(`[会话 ${sessionId}][SSH终端模块] 请求后端为分屏终端 ${effectivePaneId} 打开/复用独立 Shell 通道...`);
            sendMessage({
                type: 'ssh:pane_open',
                sessionId,
                payload: {
                    sessionId,
                    paneId: effectivePaneId,
                    cols: term.cols || 80,
                    rows: term.rows || 24,
                }
            });
        }
    };

    /**
     * 校验外部传入的 paneId 是否真的属于本会话。
     *
     * 命令输入栏 / 快捷指令传的是全局 layoutStore.activeTerminalPaneId，
     * 会话切换瞬间它可能还停留在别的会话的 paneId 上。若原样发给后端，
     * handleSshPaneInput 找不到 pane 会直接 return —— 数据静默丢失，
     * 用户看到的就是"新会话里发不出命令，点一下终端才好"。
     */
    const resolvePaneIdForSession = (paneId?: string): string | undefined => {
        if (paneId && !terminalPanes.value.has(paneId)) {
            console.warn(`[会话 ${sessionId}][SSH终端模块] paneId ${paneId} 不属于本会话，回退到主终端 ${primaryPaneId.value ?? '(none)'}`);
            return undefined;
        }
        return paneId;
    };

    const handleTerminalData = (data: string, paneId?: string) => {
        const targetPaneId = resolvePaneIdForSession(paneId) || primaryPaneId.value;
        if (targetPaneId && targetPaneId !== primaryPaneId.value) {
            // 分屏副终端走专属通道输入
            sendMessage({ type: 'ssh:pane_input', sessionId, payload: { sessionId, paneId: targetPaneId, data } });
        } else {
            // 主终端走标准主流输入
            sendMessage({ type: 'ssh:input', sessionId, payload: { sessionId, data } });
        }
    };

    const handleTerminalResize = (dimensions: { cols: number; rows: number }, paneId?: string) => {
        if (!isConnected.value) {
            console.log(`[SSH ${sessionId}] WebSocket not connected, skipping resize.`);
            return;
        }
        const targetPaneId = resolvePaneIdForSession(paneId) || primaryPaneId.value;
        if (targetPaneId && targetPaneId !== primaryPaneId.value) {
            sendMessage({ type: 'ssh:pane_resize', sessionId, payload: { sessionId, paneId: targetPaneId, cols: dimensions.cols, rows: dimensions.rows } });
        } else {
            sendMessage({ type: 'ssh:resize', sessionId, payload: { sessionId, ...dimensions } });
        }
    };

    const handleTerminalDispose = (paneId?: string) => {
        if (!paneId) return;
        console.log(`[会话 ${sessionId}][SSH终端模块] 收到终端注销请求: ${paneId}`);
        if (terminalPanes.value.has(paneId)) {
            terminalPanes.value.delete(paneId);
            if (paneId !== primaryPaneId.value) {
                sendMessage({ type: 'ssh:pane_close', sessionId, payload: { sessionId, paneId } });
            } else {
                // 如果主终端注销，但还有其他分屏终端，接替成为新主终端
                const remaining = Array.from(terminalPanes.value.values());
                if (remaining.length > 0) {
                    const nextPrimary = remaining[0];
                    primaryPaneId.value = nextPrimary.paneId;
                    terminalInstance.value = nextPrimary.terminal;
                    searchAddon.value = nextPrimary.searchAddon;
                    serializeAddon.value = nextPrimary.serializeAddon || null;
                    console.log(`[会话 ${sessionId}][SSH终端模块] 原主终端注销，推选 ${nextPrimary.paneId} 为新主终端`);
                } else {
                    primaryPaneId.value = null;
                    terminalInstance.value = null;
                    searchAddon.value = null;
                    serializeAddon.value = null;
                }
            }
        }
    };

    // --- WebSocket 消息处理 ---

    /**
     * 退出全屏 TUI（备用屏）时，程序通常先设置背景色再清屏，
     * `\e[2J` 就会用那块黑色填满整屏，背景图被一整块黑盖住。
     *
     * 这里在 `\e[?1049l` / `\e[?47l`（退出备用屏）之后立刻注入 SGR 重置，
     * 保证紧接着的清屏用的是默认背景（配合 Terminal 里的透明 theme）。
     */
    const sanitizeTuiTransition = <T extends string | Uint8Array>(raw: T): T => {
        if (typeof raw !== 'string' || !raw || raw.indexOf('\x1b[?') === -1) return raw;
        // 退出备用屏后：重置 SGR → 主动清屏 → 光标归位。
        // 主动清屏是为了覆盖"TUI 先设黑色背景、再清屏、最后才发 1049l"这种顺序，
        // 否则那块黑色会留在屏幕上（用户看到的"满屏黑"）。
        return raw.replace(/\x1b\[\?(?:1049|47)l/g, (m) => `${m}\x1b[0m\x1b[2J\x1b[H`) as T;
    };

    /**
     * 让处于全屏 TUI 的终端整屏重绘。
     *
     * TUI（btop/vim）只在收到 SIGWINCH（PTY 尺寸变化）时才重绘；
     * 刷新后前端只拿到增量数据，画面就会残缺。这里制造一次 cols+1 → cols 的尺寸抖动，
     * 后端 pty 收到新尺寸后会给 TUI 发 SIGWINCH，它就会整屏重画。
     */
    const forceTuiRedraw = (term: Terminal | null | undefined, delay = 400) => {
        if (!term) return;
        const run = () => {
            try {
                if (term.buffer.active.type !== 'alternate') return;
                const { cols, rows } = term;
                if (cols < 3) return;
                console.log(`[会话 ${sessionId}][SSH终端模块] 检测到全屏 TUI，触发尺寸抖动以强制整屏重绘`);
                // 用 +1 而不是 -1：减一可能让 TUI 判定"终端太小"（btop 会直接报 width too small）
                term.resize(cols + 1, rows);
                setTimeout(() => {
                    try { term.resize(cols, rows); } catch { /* noop */ }
                }, 150);
            } catch {
                /* noop */
            }
        };
        if (delay > 0) setTimeout(run, delay);
        else run();
    };

    const handleSshOutput = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        let outputData = payload;
        // 检查是否为 Base64 编码 (需要后端配合发送 encoding 字段)
        if (message?.encoding === 'base64' && typeof outputData === 'string') {
            try {
                // 使用更安全的Base64解码方式，保证中文字符正确解码
                const base64String = outputData;
                // 先用atob获取二进制字符串
                const binaryString = atob(base64String);
                // 创建Uint8Array存储二进制数据
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                // 直接使用原始二进制数据作为 Uint8Array 写入终端，避免编码转换问题
                outputData = bytes;
            } catch (e) {
                console.error(`[会话 ${sessionId}][SSH终端模块] Base64 解码失败:`, e, '原始数据:', message.payload);
                outputData = `\r\n[解码错误: ${e}]\r\n`; // 在终端显示解码错误
            }
        }
        // 如果不是 base64 或解码失败，确保它是字符串
        else if (typeof outputData !== 'string') {
             console.warn(`[会话 ${sessionId}][SSH终端模块] 收到非字符串 ssh:output payload:`, outputData);
             try {
                 outputData = JSON.stringify(outputData); // 尝试序列化
             } catch {
                 outputData = String(outputData); // 最后手段：强制转字符串
             }
        }

        // 由于直接使用原始二进制数据，不再需要过滤 OSC 184 序列
        // 相关代码已移除

        // --- 添加前端日志 ---
        // console.log(`[会话 ${sessionId}][SSH前端] 收到 ssh:output 原始 payload (解码前):`, payload);
        // console.log(`[会话 ${sessionId}][SSH前端] 解码后的数据 (尝试写入):`, outputData);
        // --------------------

        if (terminalInstance.value) {
            terminalInstance.value.write(sanitizeTuiTransition(highlightStore.highlight(outputData)));
            // 终端数据输出写入后安排 1.5s 防抖同步至云端工作区
            scheduleTerminalSync(1500);
        } else {
            // 如果终端还没准备好，先缓冲输出
            terminalOutputBuffer.value.push(outputData);
        }
    };

    const handleSshConnected = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        const incomingSessionId = (message as any)?.sessionId || (payload as any)?.sessionId;
        if (incomingSessionId && incomingSessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        isSshConnected.value = true; // 更新状态

        // 刷新/重连后，服务端如果还停在 btop 这类全屏 TUI 里，
        // 前端只会收到"增量"重绘数据，画面就是残缺的（缺面板、错位）。
        // TUI 只在收到 SIGWINCH 时才会整屏重绘，这里制造一次尺寸抖动触发它。
        // 注意：要覆盖**所有** pane，不能只处理主终端 —— 用户反馈第一个终端能自动矫正、
        // 其他终端不行，就是因为这里以前只拿了 terminalInstance（主终端）。
        setTimeout(() => {
            for (const [, entry] of terminalPanes.value.entries()) {
                forceTuiRedraw(entry.terminal, 0);
            }
        }, 800);

        // 主连接就绪，立刻为所有已挂载的分屏副终端打开独立 Shell 通道
        if (terminalPanes.value.size > 1) {
            console.log(`[会话 ${sessionId}][SSH终端模块] 主会话已连接，正在为 ${terminalPanes.value.size - 1} 个分屏副终端打开独立 Shell...`);
            for (const [pId, entry] of terminalPanes.value.entries()) {
                if (pId !== primaryPaneId.value) {
                    sendMessage({
                        type: 'ssh:pane_open',
                        sessionId,
                        payload: {
                            sessionId,
                            paneId: pId,
                            cols: entry.terminal.cols || 80,
                            rows: entry.terminal.rows || 24,
                        }
                    });
                }
            }
        }
        // 连接成功后聚焦终端 (仅桌面端自动聚焦，避免手机端自动弹出输入法)
        const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        if (!isMobileDevice) {
            terminalInstance.value?.focus();
        }

        if (terminalInstance.value) {
            // 如果之前连接过且断开后重新连上，输出一条醒目的重连成功分割线，完整保留原有历史
            if (hasConnectedBefore.value) {
                terminalInstance.value.writeln(`\r\n\x1b[32m--- [${getTerminalText('reconnectedMsg')}] ---\x1b[0m\r\n`);
            }
            hasConnectedBefore.value = true;

            const currentDimensions = { cols: terminalInstance.value.cols, rows: terminalInstance.value.rows };
            // 检查尺寸是否有效
            if (currentDimensions.cols > 0 && currentDimensions.rows > 0) {
                console.log(`[会话 ${sessionId}][SSH终端模块] SSH 连接成功，主动发送初始尺寸:`, currentDimensions);
                sendMessage({ type: 'ssh:resize', sessionId, payload: currentDimensions });
            } else {
                console.warn(`[会话 ${sessionId}][SSH终端模块] SSH 连接成功，但获取到的初始尺寸无效，跳过发送 resize:`, currentDimensions);
            }
        } else {
             hasConnectedBefore.value = true;
             console.warn(`[会话 ${sessionId}][SSH终端模块] SSH 连接成功，但 terminalInstance 不可用，无法发送初始 resize。`);
        }


        // 清空可能存在的旧缓冲（虽然理论上此时应该已经 ready 了）
        if (terminalOutputBuffer.value.length > 0) {
             console.warn(`[会话 ${sessionId}][SSH终端模块] SSH 连接时仍有缓冲数据，正在写入...`);
             terminalOutputBuffer.value.forEach(data => terminalInstance.value?.write(sanitizeTuiTransition(highlightStore.highlight(data))));
             terminalOutputBuffer.value = [];
        }
    };

    const handleSshDisconnected = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        const reason = payload || t('workspace.terminal.unknownReason'); // 使用 i18n 获取未知原因文本
        console.log(`[会话 ${sessionId}][SSH终端模块] SSH 会话已断开:`, reason);
        isSshConnected.value = false; // 更新状态
        terminalInstance.value?.writeln(`\r\n\x1b[31m${getTerminalText('disconnectMsg', { reason })}\x1b[0m`);
        // 可以在这里添加其他清理逻辑，例如禁用输入
    };

    const handleSshError = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        const errorMsg = payload || t('workspace.terminal.unknownSshError'); // 使用 i18n
        console.error(`[会话 ${sessionId}][SSH终端模块] SSH 错误:`, errorMsg);
        isSshConnected.value = false; // 更新状态
        terminalInstance.value?.writeln(`\r\n\x1b[31m${getTerminalText('genericErrorMsg', { message: errorMsg })}\x1b[0m`);
    };

    const handleSshStatus = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        // 这个消息现在由 useWebSocketConnection 处理以更新全局状态栏消息
        // 这里可以保留日志或用于其他特定于终端的 UI 更新（如果需要）
        const statusKey = payload?.key || 'unknown';
        const statusParams = payload?.params || {};
        console.log(`[会话 ${sessionId}][SSH终端模块] 收到 SSH 状态更新:`, statusKey, statusParams);
        // 可以在终端打印一些状态信息吗？
        // terminalInstance.value?.writeln(`\r\n\x1b[34m[状态: ${statusKey}]\x1b[0m`);
    };

    const handleInfoMessage = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        console.log(`[会话 ${sessionId}][SSH终端模块] 收到后端信息:`, payload);
        terminalInstance.value?.writeln(`\r\n\x1b[34m${getTerminalText('infoPrefix')} ${payload}\x1b[0m`);
    };

    const handleErrorMessage = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        // 通用错误也可能需要显示在终端
        const errorMsg = payload || t('workspace.terminal.unknownGenericError'); // 使用 i18n
        console.error(`[会话 ${sessionId}][SSH终端模块] 收到后端通用错误:`, errorMsg);
        terminalInstance.value?.writeln(`\r\n\x1b[31m${getTerminalText('errorPrefix')} ${errorMsg}\x1b[0m`);
    };

    // --- 多终端分屏 WebSocket 消息处理 ---

    const handleSshPaneOutput = (payload: any, message?: WebSocketMessage) => {
        const incomingSessionId = (message as any)?.sessionId || (payload as any)?.sessionId;
        if (incomingSessionId && incomingSessionId !== sessionId) return;
        const paneId = payload?.paneId;
        const rawData = payload?.data;
        if (!paneId || !rawData) return;

        const paneEntry = terminalPanes.value.get(paneId);
        if (!paneEntry || !paneEntry.terminal) return;

        let outputData: string | Uint8Array = rawData;
        if (message?.encoding === 'base64' && typeof rawData === 'string') {
            try {
                const binaryString = atob(rawData);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                outputData = bytes;
            } catch (e) {
                console.error(`[会话 ${sessionId}][分屏终端 ${paneId}] Base64 解码失败:`, e);
                outputData = `\r\n[分屏解码错误: ${e}]\r\n`;
            }
        }

        paneEntry.terminal.write(sanitizeTuiTransition(highlightStore.highlight(outputData)));
        scheduleTerminalSync(1500);
    };

    const handleSshPaneReady = (payload: any, message?: WebSocketMessage) => {
        const incomingSessionId = (message as any)?.sessionId || (payload as any)?.sessionId;
        if (incomingSessionId && incomingSessionId !== sessionId) return;
        const paneId = payload?.paneId;
        console.log(`[会话 ${sessionId}][SSH终端模块] 后端分屏终端 ${paneId} Shell 独立通道就绪`);
        const paneEntry = terminalPanes.value.get(paneId);
        if (paneEntry) {
            paneEntry.isReady = true;
            // 副终端如果是复用后端保活的 Shell（刷新前在跑 btop），前端同样只收到增量数据，
            // 画面会残缺。通道就绪后立刻抖动一次，让它整屏重绘。
            forceTuiRedraw(paneEntry.terminal, 500);
            // 通道就绪，立即向后端同步一次实际尺寸，触发服务端 PTY 更新尺寸
            if (paneEntry.terminal && paneEntry.terminal.cols > 0 && paneEntry.terminal.rows > 0) {
                sendMessage({
                    type: 'ssh:pane_resize',
                    sessionId,
                    payload: {
                        sessionId,
                        paneId,
                        cols: paneEntry.terminal.cols,
                        rows: paneEntry.terminal.rows,
                    }
                });
            }
        }
    };

    const handleSshPaneClosed = (payload: any, message?: WebSocketMessage) => {
        const incomingSessionId = (message as any)?.sessionId || (payload as any)?.sessionId;
        if (incomingSessionId && incomingSessionId !== sessionId) return;
        const paneId = payload?.paneId;
        console.log(`[会话 ${sessionId}][SSH终端模块] 分屏终端 ${paneId} Shell 通道已关闭`);
        const paneEntry = terminalPanes.value.get(paneId);
        if (paneEntry && paneEntry.terminal) {
            paneEntry.terminal.writeln(`\r\n\x1b[31m--- [${getTerminalText('disconnectMsg', { reason: '分屏会话已结束' })}] ---\x1b[0m\r\n`);
        }
    };

    // --- 注册 WebSocket 消息处理器 ---
    const unregisterHandlers: (() => void)[] = [];

    const registerSshHandlers = () => {
        unregisterHandlers.push(onMessage('ssh:output', handleSshOutput));
        unregisterHandlers.push(onMessage('ssh:connected', handleSshConnected));
        unregisterHandlers.push(onMessage('ssh:disconnected', handleSshDisconnected));
        unregisterHandlers.push(onMessage('ssh:error', handleSshError));
        unregisterHandlers.push(onMessage('ssh:status', handleSshStatus));
        unregisterHandlers.push(onMessage('info', handleInfoMessage));
        unregisterHandlers.push(onMessage('error', handleErrorMessage)); // 也处理通用错误
        // 注册分屏终端事件
        unregisterHandlers.push(onMessage('ssh:pane_output', handleSshPaneOutput));
        unregisterHandlers.push(onMessage('ssh:pane_ready', handleSshPaneReady));
        unregisterHandlers.push(onMessage('ssh:pane_closed', handleSshPaneClosed));
        console.log(`[会话 ${sessionId}][SSH终端模块] 已注册 SSH 相关消息处理器（含分屏）。`);
    };

    const unregisterAllSshHandlers = () => {
        console.log(`[会话 ${sessionId}][SSH终端模块] 注销 SSH 相关消息处理器...`);
        unregisterHandlers.forEach(unregister => unregister?.());
        unregisterHandlers.length = 0; // 清空数组
    };

    // 初始化时自动注册处理程序
    registerSshHandlers();

    // --- 清理函数 ---
    const cleanup = () => {
        if (terminalSyncTimer) {
            clearTimeout(terminalSyncTimer);
            terminalSyncTimer = null;
        }
        unregisterAllSshHandlers();
        // terminalInstance.value?.dispose(); // 终端实例的销毁由 TerminalComponent 负责
        terminalInstance.value = null;
        terminalPanes.value.clear();
        primaryPaneId.value = null;
        console.log(`[会话 ${sessionId}][SSH终端模块] 已清理。`);
    };

    /**
     * 直接发送数据到 SSH 会话 (例如，从命令输入栏)
     * @param data 要发送的字符串数据
     * @param paneId 目标分屏终端 ID，缺省时发往主终端
     */
    const sendData = (data: string, paneId?: string) => {
        handleTerminalData(data, paneId);
    };

    // --- 搜索相关方法 (移除计数逻辑) ---

    // 获取目标终端实例（支持分屏路由）
    const getTargetPaneEntry = (targetPaneId?: string | null): PaneTerminalInstance | null => {
        let pid = targetPaneId;
        if (!pid) {
            try {
                const layoutStore = useLayoutStore();
                pid = layoutStore.activeTerminalPaneId;
            } catch {}
        }
        if (!pid) {
            pid = primaryPaneId.value;
        }

        if (pid && terminalPanes.value.has(pid)) {
            return terminalPanes.value.get(pid)!;
        }
        if (primaryPaneId.value && terminalPanes.value.has(primaryPaneId.value)) {
            return terminalPanes.value.get(primaryPaneId.value)!;
        }
        if (terminalPanes.value.size > 0) {
            return Array.from(terminalPanes.value.values())[0];
        }
        return null;
    };

    const clearTerminal = (targetPaneId?: string | null): boolean => {
        const entry = getTargetPaneEntry(targetPaneId);
        if (entry?.terminal && typeof entry.terminal.clear === 'function') {
            console.log(`[会话 ${sessionId}][SSH终端模块] 正在清空终端 (paneId: ${entry.paneId})`);
            entry.terminal.clear();
            return true;
        }
        if (terminalInstance.value && typeof terminalInstance.value.clear === 'function') {
            terminalInstance.value.clear();
            return true;
        }
        return false;
    };

    const scrollToBottom = (targetPaneId?: string | null) => {
        const entry = getTargetPaneEntry(targetPaneId);
        if (entry?.terminal && typeof entry.terminal.scrollToBottom === 'function') {
            entry.terminal.scrollToBottom();
            return;
        }
        terminalInstance.value?.scrollToBottom();
    };

    const searchNext = (term: string, options?: ISearchOptions, targetPaneId?: string | null): boolean => {
        const entry = getTargetPaneEntry(targetPaneId);
        const addon = entry?.searchAddon || searchAddon.value;
        if (addon) {
            console.log(`[会话 ${sessionId}][SSH终端模块] 执行 searchNext: "${term}" (paneId: ${entry?.paneId || 'default'})`);
            return addon.findNext(term, options);
        }
        console.warn(`[会话 ${sessionId}][SSH终端模块] searchNext 调用失败，未找到有效 searchAddon。`);
        return false;
    };

    const searchPrevious = (term: string, options?: ISearchOptions, targetPaneId?: string | null): boolean => {
        const entry = getTargetPaneEntry(targetPaneId);
        const addon = entry?.searchAddon || searchAddon.value;
        if (addon) {
            console.log(`[会话 ${sessionId}][SSH终端模块] 执行 searchPrevious: "${term}" (paneId: ${entry?.paneId || 'default'})`);
            return addon.findPrevious(term, options);
        }
        console.warn(`[会话 ${sessionId}][SSH终端模块] searchPrevious 调用失败，未找到有效 searchAddon。`);
        return false;
    };

    const clearTerminalSearch = (targetPaneId?: string | null) => {
        if (targetPaneId) {
            const entry = getTargetPaneEntry(targetPaneId);
            if (entry?.searchAddon) {
                entry.searchAddon.clearDecorations();
            }
        } else {
            // 清理所有分屏终端的搜索高亮
            terminalPanes.value.forEach(p => {
                p.searchAddon?.clearDecorations();
            });
            searchAddon.value?.clearDecorations();
        }
        console.log(`[会话 ${sessionId}][SSH终端模块] 搜索高亮已清除。`);
    };


    // 返回工厂实例
    return {
        // 公共接口
        handleTerminalReady,
        handleTerminalData, // 这个处理来自 xterm.js 的输入
        handleTerminalResize,
        handleTerminalDispose,
        sendData, // 允许外部直接发送数据
        cleanup,
        // --- 清空与控制 ---
        clearTerminal,
        scrollToBottom,
        getTargetPaneEntry,
        // --- 搜索方法 ---
        searchNext,
        searchPrevious,
        clearTerminalSearch,
        // --- 序列化方法 (带完整 ANSI 样式) ---
        serializeTerminal: (): string | null => {
            // 处于备用屏（btop / vim / less 等全屏 TUI）时不要序列化。
            // 否则恢复出来的终端会停在备用屏里，用户退出 TUI（Ctrl+C）后回到空的正常屏，
            // 整块区域被"当前 SGR 背景"填满 —— 表现为刷新后终端变成一块黑。
            if (terminalInstance.value?.buffer?.active?.type === 'alternate') {
                console.log(`[会话 ${sessionId}][SSH终端模块] 当前处于 TUI 备用屏，跳过屏幕内容序列化`);
                return '';
            }
            if (serializeAddon.value) {
                try {
                    return serializeAddon.value.serialize();
                } catch (e) {
                    console.warn(`[会话 ${sessionId}][SSH终端模块] 序列化终端内容失败:`, e);
                }
            }
            return null;
        },
        // --- 多终端分屏全量序列化字典 (paneId -> ANSI Buffer) ---
        serializeAllPanes: (): Record<string, string> => {
            const result: Record<string, string> = {};
            for (const [pId, entry] of terminalPanes.value.entries()) {
                // 同上：备用屏（TUI）不参与快照，避免刷新后停在备用屏
                if (entry.terminal?.buffer?.active?.type === 'alternate') {
                    console.log(`[会话 ${sessionId}][分屏终端 ${pId}] 处于 TUI 备用屏，跳过序列化`);
                    continue;
                }
                if (entry.serializeAddon) {
                    try {
                        const s = entry.serializeAddon.serialize();
                        if (typeof s === 'string' && s.length > 0) {
                            result[pId] = s;
                            continue;
                        }
                    } catch (e) {
                        console.warn(`[会话 ${sessionId}][分屏终端 ${pId}] 序列化失败:`, e);
                    }
                }
                // 降级使用 buffer 遍历
                if (entry.terminal) {
                    const buffer = entry.terminal.buffer.active;
                    let lastNonEmpty = -1;
                    for (let i = buffer.length - 1; i >= 0; i--) {
                        const line = buffer.getLine(i);
                        if (line && line.translateToString(true).trim() !== '') {
                            lastNonEmpty = i;
                            break;
                        }
                    }
                    if (lastNonEmpty !== -1) {
                        let text = '';
                        for (let i = 0; i <= lastNonEmpty; i++) {
                            const line = buffer.getLine(i);
                            if (!line) continue;
                            const next = i < lastNonEmpty ? buffer.getLine(i + 1) : null;
                            if (next?.isWrapped) {
                                text += line.translateToString(false);
                            } else {
                                text += line.translateToString(true);
                                if (i < lastNonEmpty) text += '\r\n';
                            }
                        }
                        if (text) result[pId] = text;
                    }
                }
            }
            return result;
        },
        serializeAddon,
        // --- 暴露状态与多终端 Map ---
        isSshConnected: readonly(isSshConnected), // 暴露 SSH 连接状态 (只读)
        terminalInstance, // 暴露主 terminal 实例，以便 WorkspaceView 写入提示信息
        terminalPanes,
        primaryPaneId,
    };
}

// 保留兼容旧代码的函数（将在完全迁移后移除）
export function useSshTerminal(t: (key: string) => string) {
    console.warn('⚠️ 使用已弃用的 useSshTerminal() 全局单例。请迁移到 createSshTerminalManager() 工厂函数。');
    
    const terminalInstance = ref<Terminal | null>(null);
    
    const handleTerminalReady = (term: Terminal) => {
        console.log('[SSH终端模块][旧] 终端实例已就绪，但使用了已弃用的单例模式。');
        terminalInstance.value = term;
    };
    
    const handleTerminalData = (data: string) => {
        console.warn('[SSH终端模块][旧] 收到终端数据，但使用了已弃用的单例模式，无法发送。');
    };
    
    const handleTerminalResize = (dimensions: { cols: number; rows: number }) => {
        console.warn('[SSH终端模块][旧] 收到终端大小调整，但使用了已弃用的单例模式，无法发送。');
    };
    
    // 返回与旧接口兼容的空函数，以避免错误
    return {
        terminalInstance,
        handleTerminalReady,
        handleTerminalData,
        handleTerminalResize,
        registerSshHandlers: () => console.warn('[SSH终端模块][旧] 调用了已弃用的 registerSshHandlers'),
        unregisterAllSshHandlers: () => console.warn('[SSH终端模块][旧] 调用了已弃用的 unregisterAllSshHandlers'),
    };
}
