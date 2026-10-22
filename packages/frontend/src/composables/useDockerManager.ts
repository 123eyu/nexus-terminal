import { ref, readonly, watch, computed, type Ref, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '../stores/settings.store';
import { storeToRefs } from 'pinia';
import type { WebSocketMessage, MessagePayload } from '../types/websocket.types';

// --- Interfaces (Copied from DockerManager.vue) ---
interface PortInfo {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: 'tcp' | 'udp' | string;
}

export interface DockerContainer { // Exporting for potential use elsewhere
  id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Command: string;
  Created: number;
  State: 'created' | 'restarting' | 'running' | 'removing' | 'paused' | 'exited' | 'dead' | string;
  Status: string;
  Ports: PortInfo[];
  Labels: Record<string, string>;
  stats?: DockerStats | null;
}

export interface DockerStats { // Exporting for potential use elsewhere
    ID: string;
    Name: string;
    CPUPerc: string;
    MemUsage: string;
    MemPerc: string;
    NetIO: string;
    BlockIO: string;
    PIDs: string;
}

// --- WebSocket Dependencies Interface ---
// Similar to other composables, defining dependencies for WS communication
export interface DockerManagerDependencies {
    sendMessage: (message: WebSocketMessage) => void;
    onMessage: (type: string, handler: (payload: any, fullMessage?: WebSocketMessage) => void) => () => void;
    isConnected: ComputedRef<boolean>;
    // We might need isSshReady or similar if Docker commands depend on SSH being fully ready
    // For now, isConnected might suffice, assuming WS connection implies SSH readiness for Docker
}

/**
 * Creates a Docker manager instance for a specific session.
 * @param sessionId The unique identifier for the session.
 * @param wsDeps WebSocket dependencies object.
 * @param i18n The i18n instance (t function).
 * @returns Docker manager instance.
 */
export function createDockerManager(sessionId: string, wsDeps: DockerManagerDependencies, i18n: { t: (key: string, params?: any) => string }) {
    const { sendMessage, onMessage, isConnected } = wsDeps;
    const { t } = i18n; // Use the passed i18n instance

    // --- State ---
    const containers = ref<DockerContainer[]>([]);
    const isLoading = ref(false);
    const error = ref<string | null>(null);
    const isDockerAvailable = ref(true); // Assume available until checked
    const expandedContainerIds = ref<Set<string>>(new Set());
    const initialLoadDone = ref(false);
    let refreshInterval: ReturnType<typeof setInterval> | null = null;
    let wsUnsubscribeHooks: (() => void)[] = [];
    /**
     * 「进入容器」是异步的：后端要读连接上配置的命令模板，必要时还要在容器里探一次 shell。
     * 用 requestId 把 ws 响应和点击对上，超时就退回 `docker exec -it <id> sh`，不让按钮卡死。
     */
    const pendingEnterCommands = new Map<string, (payload: any) => void>();

    // --- Settings Store ---
    // Settings need to be accessed here as well for default expansion
    const settingsStore = useSettingsStore();
    const { dockerDefaultExpandBoolean } = storeToRefs(settingsStore);

    // --- Methods ---

    // Clear existing WebSocket listeners
    const clearWsListeners = () => {
        if (wsUnsubscribeHooks.length > 0) {
            wsUnsubscribeHooks.forEach(unsub => unsub());
            wsUnsubscribeHooks = [];
        }
    };

    // Request Docker status via WebSocket
    const requestDockerStatus = (force = false) => {
        if (!isConnected.value) {
            containers.value = [];
            isLoading.value = false;
            error.value = t('dockerManager.error.sshDisconnected');
            isDockerAvailable.value = false;
            expandedContainerIds.value.clear();
            initialLoadDone.value = false;
            if (refreshInterval) clearInterval(refreshInterval);
            refreshInterval = null;
            return;
        }

        // 若已被判定为远程主机无 Docker，且非用户手动强制触发刷新，直接熔断跳过周期轮询
        if (!force && isDockerAvailable.value === false) {
            if (refreshInterval) {
                clearInterval(refreshInterval);
                refreshInterval = null;
            }
            return;
        }

        // 自愈保障：若 WebSocket 监听器丢失，自动补齐注册
        if (wsUnsubscribeHooks.length === 0) {
            setupWsListeners();
        }

        isLoading.value = true;
        error.value = null; // Clear previous error
        sendMessage({ type: 'docker:get_status', sessionId }); // Ensure sessionId is included if needed by backend routing
    };

    // Setup WebSocket listeners
    const setupWsListeners = () => {
        clearWsListeners(); // Clear previous listeners first
        if (!isConnected.value) {
             console.warn(`[DockerManager ${sessionId}] Cannot setup listeners, WebSocket not connected.`);
             return;
        }

        const unsubStatus = onMessage('docker:status:update', (payload, message) => {
            if (message?.sessionId && message.sessionId !== sessionId) return; // Ignore messages for other sessions
            isLoading.value = false;

            if (payload && typeof payload.available === 'boolean') {
                isDockerAvailable.value = payload.available;
                if (!payload.available) {
                    // 主机明确无 Docker，停止前端无效周期轮询
                    if (refreshInterval) {
                        clearInterval(refreshInterval);
                        refreshInterval = null;
                    }
                }
                if (payload.available && Array.isArray(payload.containers)) {
                    containers.value = payload.containers as DockerContainer[];
                    error.value = null;

                    // Clean up expansion state
                    const currentIds = new Set(containers.value.map(c => c.id));
                    const idsToRemove = new Set<string>();
                    expandedContainerIds.value.forEach(id => {
                        if (!currentIds.has(id)) idsToRemove.add(id);
                    });
                    idsToRemove.forEach(id => expandedContainerIds.value.delete(id));

                    // Handle default expand on initial load
                    if (!initialLoadDone.value && dockerDefaultExpandBoolean.value) {
                        containers.value.forEach(container => {
                            if (!expandedContainerIds.value.has(container.id)) {
                                expandedContainerIds.value.add(container.id);
                            }
                        });
                        initialLoadDone.value = true;
                    }
                } else {
                    containers.value = [];
                    error.value = null;
                    expandedContainerIds.value.clear();
                }
            } else {
                isDockerAvailable.value = false;
                if (refreshInterval) {
                    clearInterval(refreshInterval);
                    refreshInterval = null;
                }
                containers.value = [];
                error.value = t('dockerManager.error.invalidResponse');
                expandedContainerIds.value.clear();
            }
        });

        const unsubStatusError = onMessage('docker:status:error', (payload, message) => {
            if (message?.sessionId && message.sessionId !== sessionId) return;
            console.warn(`[DockerManager ${sessionId}] 收到 docker:status:error`, payload);
            isLoading.value = false;
            const errMsg = String(payload?.message || t('dockerManager.error.fetchFailed'));
            error.value = errMsg;
            // 只有当明确检测到系统无 Docker 或未运行时，才置为不可用并熔断停止轮询
            if (errMsg.includes('command not found') || errMsg.includes('Cannot connect to the Docker daemon') || errMsg.includes('permission denied')) {
                isDockerAvailable.value = false;
                if (refreshInterval) {
                    clearInterval(refreshInterval);
                    refreshInterval = null;
                }
            }
            containers.value = [];
            expandedContainerIds.value.clear();
        });

        const unsubCommandError = onMessage('docker:command:error', (payload, message) => {
            if (message?.sessionId && message.sessionId !== sessionId) return;
            console.error(`[DockerManager ${sessionId}] Received docker:command:error`, payload);
            // How to notify UI? Maybe set an error ref? Or rely on status update?
            // For now, just log. UI component could show a generic error or use a notification system.
            // Consider adding a transient commandError ref if needed.
        });

        const unsubRequestUpdate = onMessage('request_docker_status_update', (payload, message) => {
            if (message?.sessionId && message.sessionId !== sessionId) return;
            requestDockerStatus(); // Trigger a status refresh immediately
        });

        // 「进入容器」的成品命令（后端读连接配置 + 必要时探测 shell 后返回）
        const unsubExecCommand = onMessage('docker:exec_command', (payload, message) => {
            if (message?.sessionId && message.sessionId !== sessionId) return;
            const rid = payload?.requestId;
            if (!rid) return;
            const waiter = pendingEnterCommands.get(rid);
            if (waiter) {
                pendingEnterCommands.delete(rid);
                waiter(payload);
            }
        });

        wsUnsubscribeHooks.push(unsubStatus, unsubStatusError, unsubCommandError, unsubRequestUpdate, unsubExecCommand);
    };

    /**
     * 取「进入容器」要执行的命令。
     *
     * 命令由后端**按容器**探测得出（bash → ash → sh，Windows 容器 powershell → pwsh → cmd），
     * 探不到就退回 sh。刻意没有连接级配置：同一台主机上的容器本来就是不同发行版。
     */
    const getEnterCommand = (containerId: string): Promise<string> => {
        const fallback = `docker exec -it ${containerId} sh`;
        if (!isConnected.value) return Promise.resolve(fallback);
        if (wsUnsubscribeHooks.length === 0) setupWsListeners();
        const requestId = `enter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return new Promise<string>((resolve) => {
            const timer = setTimeout(() => {
                pendingEnterCommands.delete(requestId);
                console.warn(`[DockerManager ${sessionId}] 获取进入容器命令超时，回退 ${fallback}`);
                resolve(fallback);
            }, 12000);
            pendingEnterCommands.set(requestId, (payload: any) => {
                clearTimeout(timer);
                const cmd = typeof payload?.command === 'string' ? payload.command.trim() : '';
                if (payload?.error) console.warn(`[DockerManager ${sessionId}] 获取进入容器命令失败:`, payload.error);
                resolve(cmd || fallback);
            });
            sendMessage({ type: 'docker:get_exec_command', sessionId, payload: { containerId, requestId } });
        });
    };

    // Send command for a specific container via WebSocket
    const sendDockerCommand = (containerId: string, command: 'start' | 'stop' | 'restart' | 'remove') => {
        if (!isConnected.value) {
            console.warn(`[DockerManager ${sessionId}] Cannot send command, WebSocket not connected.`);
            return;
        }
        if (!isDockerAvailable.value) {
           console.warn(`[DockerManager ${sessionId}] Cannot send command, remote Docker is not available.`);
           return;
        }

        sendMessage({
            type: 'docker:command',
            sessionId, // Include sessionId if needed by backend routing
            payload: { containerId, command }
        });
        // Optionally trigger a status refresh sooner after a command
        // setTimeout(requestDockerStatus, 500);
    };

    // Toggle expansion state for a container
    const toggleExpand = (containerId: string) => {
        if (expandedContainerIds.value.has(containerId)) {
            expandedContainerIds.value.delete(containerId);
        } else {
            expandedContainerIds.value.add(containerId);
        }
    };

    // --- Lifecycle Management ---

    // Reset state function
    const resetStateAndInterval = () => {
        containers.value = [];
        isLoading.value = false;
        error.value = null;
        isDockerAvailable.value = true; // Assume available until checked
        expandedContainerIds.value.clear();
        initialLoadDone.value = false;

        if (refreshInterval) {
            clearInterval(refreshInterval);
            refreshInterval = null;
        }
        clearWsListeners();
    };

    // Watch for connection changes to manage listeners and interval
    watch(isConnected, (newIsConnected) => {
        if (newIsConnected) {
            console.log(`[DockerManager ${sessionId}] SSH/WS 连接已建立或重连成功，正在恢复 Docker 监听与探测...`);
            error.value = null;
            // 连接恢复时重置为初始状态，避免遗留断开时的不可用状态
            isDockerAvailable.value = true;
            setupWsListeners();
            requestDockerStatus();

            if (!refreshInterval) {
                refreshInterval = setInterval(requestDockerStatus, 15000);
            }
        } else {
            // Connection lost
            resetStateAndInterval();
            error.value = t('dockerManager.error.sshDisconnected');
            isDockerAvailable.value = false;
        }
    }, { immediate: false });

    // Cleanup function to be called when the session ends
    const cleanup = () => {
        pendingEnterCommands.forEach((waiter) => waiter({ error: 'session closed' }));
        pendingEnterCommands.clear();
        resetStateAndInterval(); // Clears listeners and interval
    };

    // --- Initial Setup ---
    if (isConnected.value) {
        setupWsListeners();
        requestDockerStatus();
        if (!refreshInterval) {
            refreshInterval = setInterval(requestDockerStatus, 15000);
        }
    } else {
        error.value = t('dockerManager.error.sshDisconnected');
        isDockerAvailable.value = false;
    }


    // --- Exposed Interface ---
    return {
        // Readonly State
        containers: readonly(containers),
        isLoading: readonly(isLoading),
        error: readonly(error),
        isDockerAvailable: readonly(isDockerAvailable),
        expandedContainerIds: readonly(expandedContainerIds), // UI needs this read-only

        // Methods
        requestDockerStatus, // Might be useful for manual refresh button in UI
        sendDockerCommand,
        toggleExpand, // UI needs this to handle clicks
        getEnterCommand, // 「进入容器」：后端按容器探测 shell 生成命令

        // Lifecycle
        cleanup,
    };
}

// Export the type of the returned manager instance
export type DockerManagerInstance = ReturnType<typeof createDockerManager>;