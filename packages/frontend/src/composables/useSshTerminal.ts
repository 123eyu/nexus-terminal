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

        // 如果尚未选定主终端，优先将当前终端视为主终端
        if (!primaryPaneId.value) {
            primaryPaneId.value = effectivePaneId;
            terminalInstance.value = term;
            searchAddon.value = addon;
            serializeAddon.value = sAddon || null;
        }

        // 如果是主终端，写入历史缓冲
        if (effectivePaneId === primaryPaneId.value) {
            // 1. 处理 SessionState.pendingOutput (来自 SSH_OUTPUT_CACHED_CHUNK 的早期数据)
            const currentSessionState = globalSessionsRef.value.get(sessionId);
            if (currentSessionState && currentSessionState.pendingOutput && currentSessionState.pendingOutput.length > 0) {
                currentSessionState.pendingOutput.forEach(data => {
                    const normalizedData = typeof data === 'string' ? data.replace(/\r?\n/g, '\r\n') : data;
                    term.write(highlightStore.highlight(normalizedData));
                });
                currentSessionState.pendingOutput = []; // 清空
                if (currentSessionState.isResuming) {
                    currentSessionState.isResuming = false;
                }
            }

            // 2. 将此管理器内部缓冲的输出 (terminalOutputBuffer, 来自 ssh:output) 写入终端
            if (terminalOutputBuffer.value.length > 0) {
                terminalOutputBuffer.value.forEach(data => {
                    term.write(highlightStore.highlight(data));
                });
                terminalOutputBuffer.value = []; // 清空内部缓冲区
            }
        } else {
            // 如果是分屏副终端，向后端请求开辟独立的 Shell 通道！
            console.log(`[会话 ${sessionId}][SSH终端模块] 请求后端为分屏终端 ${effectivePaneId} 打开独立 Shell 通道...`);
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

    const handleTerminalData = (data: string, paneId?: string) => {
        const targetPaneId = paneId || primaryPaneId.value;
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
        const targetPaneId = paneId || primaryPaneId.value;
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
            terminalInstance.value.write(highlightStore.highlight(outputData));
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
             terminalOutputBuffer.value.forEach(data => terminalInstance.value?.write(highlightStore.highlight(data)));
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

        paneEntry.terminal.write(highlightStore.highlight(outputData));
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

    // Removed countOccurrences helper function

    const searchNext = (term: string, options?: ISearchOptions): boolean => {
        if (searchAddon.value) {
            console.log(`[会话 ${sessionId}][SSH终端模块] 执行 searchNext: "${term}"`);
            const found = searchAddon.value.findNext(term, options);
            // Removed manual count and state update
            return found;
        }
        console.warn(`[会话 ${sessionId}][SSH终端模块] searchNext 调用失败，searchAddon 不可用。`);
        // Removed state reset on failure
        return false;
    };

    const searchPrevious = (term: string, options?: ISearchOptions): boolean => {
        if (searchAddon.value) {
             console.log(`[会话 ${sessionId}][SSH终端模块] 执行 searchPrevious: "${term}"`);
            const found = searchAddon.value.findPrevious(term, options);
            // Removed manual count and state update
            return found;
        }
         console.warn(`[会话 ${sessionId}][SSH终端模块] searchPrevious 调用失败，searchAddon 不可用。`);
         // Removed state reset on failure
        return false;
    };

    const clearTerminalSearch = () => {
        if (searchAddon.value) {
            console.log(`[会话 ${sessionId}][SSH终端模块] 清除搜索高亮。`);
            searchAddon.value.clearDecorations();
        }
        // Removed state reset
        console.log(`[会话 ${sessionId}][SSH终端模块] 搜索高亮已清除 (状态不再管理)。`);
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
        // --- 搜索方法 ---
        searchNext,
        searchPrevious,
        clearTerminalSearch,
        // --- 序列化方法 (带完整 ANSI 样式) ---
        serializeTerminal: (): string | null => {
            if (serializeAddon.value) {
                try {
                    return serializeAddon.value.serialize();
                } catch (e) {
                    console.warn(`[会话 ${sessionId}][SSH终端模块] 序列化终端内容失败:`, e);
                }
            }
            return null;
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
