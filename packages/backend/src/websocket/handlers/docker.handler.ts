import { AuthenticatedWebSocket, ClientState, DockerContainer, DockerStats } from '../types';
import { parsePortsString } from '../utils';
import { clientStates, settingsService } from '../state';
import { findConnectionByIdWithTags } from '../../connections/connection.repository';
import { buildDockerExecCommand, buildShellProbeCommand, parseShellProbeOutput } from '../../docker/exec-command';
import WebSocket from 'ws';

const DEFAULT_DOCKER_STATUS_INTERVAL_SECONDS = 2;

export async function fetchRemoteDockerStatus(state: ClientState): Promise<{ available: boolean; containers: DockerContainer[] }> {
    if (!state || !state.sshClient) {
        console.warn(`[fetchRemoteDockerStatus] SSH client not available or not connected for session ${state?.ws?.sessionId}.`);
        throw new Error('SSH client not available or not connected');
    }

    let allContainers: DockerContainer[] = [];
    const statsMap = new Map<string, DockerStats>();

    try {
        // 直接执行 docker ps 命令，单次 exec 完成可用性探测与容器数据拉取，极大降低 SSH 通道占用与竞争
        const psCommand = "docker ps -a --no-trunc --format '{{json .}}'";
        const { stdout: psStdout, stderr: psStderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            if (!state.sshClient) {
                return reject(new Error('SSH client disconnected before command execution.'));
            }
            state.sshClient.exec(psCommand, { pty: false }, (err, stream) => {
                if (err) return reject(err);
                stream.on('data', (data: Buffer) => { stdout += data.toString(); });
                stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
                stream.on('close', () => resolve({ stdout, stderr }));
                stream.on('error', (execErr: Error) => reject(execErr));
            });
        });

        const isExplicitlyUnavailable = 
            psStderr.includes('command not found') ||
            psStderr.includes('docker: not found') ||
            psStderr.includes('permission denied') ||
            psStderr.includes('Cannot connect to the Docker daemon') ||
            psStderr.includes('Is the docker daemon running');

        if (isExplicitlyUnavailable) {
            console.warn(`[fetchRemoteDockerStatus] Docker unavailable or inaccessible on session ${state.ws?.sessionId}. Stderr: ${psStderr.trim()}`);
            return { available: false, containers: [] };
        } else if (psStderr) {
            console.warn(`[fetchRemoteDockerStatus] Docker ps command stderr on session ${state.ws?.sessionId}: ${psStderr.trim()}`);
        }

        const lines = psStdout.trim() ? psStdout.trim().split('\n') : [];
        allContainers = lines
            .map(line => {
                try {
                    const data = JSON.parse(line);
                    const container: DockerContainer = {
                        id: data.ID,
                        Names: typeof data.Names === 'string' ? data.Names.split(',') : (data.Names || []),
                        Image: data.Image || '',
                        ImageID: data.ImageID || '',
                        Command: data.Command || '',
                        Created: data.CreatedAt || 0,
                        State: data.State || 'unknown',
                        Status: data.Status || '',
                        Ports: parsePortsString(data.Ports),
                        Labels: data.Labels || {},
                        stats: null
                    };
                    return container;
                } catch (parseError) {
                    console.error(`[fetchRemoteDockerStatus] Failed to parse container JSON line for session ${state.ws.sessionId}: ${line}`, parseError);
                    return null;
                }
            })
            .filter((container): container is DockerContainer => container !== null);
    } catch (error: any) {
        console.warn(`[fetchRemoteDockerStatus] Error executing docker ps for session ${state.ws?.sessionId}:`, error.message);
        // 如果是 SSH 通道占用或断开等基础设施瞬态错误，直接抛出，绝不向前端广播为 Docker 不可用
        throw error;
    }

    const runningContainerIds = allContainers.filter(c => c.State === 'running').map(c => c.id);

    if (runningContainerIds.length > 0) {
        try {
            const statsCommand = `docker stats ${runningContainerIds.join(' ')} --no-stream --format '{{json .}}'`;
            const { stdout: statsStdout, stderr: statsStderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
                let stdout = '';
                let stderr = '';
                if (!state.sshClient) {
                    return reject(new Error('SSH client disconnected before command execution.'));
                }
                state.sshClient.exec(statsCommand, { pty: false }, (err, stream) => {
                    if (err) return reject(err);
                    stream.on('data', (data: Buffer) => { stdout += data.toString(); });
                    stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
                    stream.on('close', () => resolve({ stdout, stderr }));
                    stream.on('error', (execErr: Error) => reject(execErr));
                });
            });

            if (statsStderr) {
                console.warn(`[fetchRemoteDockerStatus] Docker stats command stderr on session ${state.ws.sessionId}: ${statsStderr.trim()}`);
            }

            const statsLines = statsStdout.trim() ? statsStdout.trim().split('\n') : [];
            statsLines.forEach(line => {
                try {
                    const statsData = JSON.parse(line) as DockerStats;
                    if (statsData.ID) {
                        statsMap.set(statsData.ID, statsData);
                    }
                } catch (parseError) {
                    console.error(`[fetchRemoteDockerStatus] Failed to parse stats JSON line for session ${state.ws.sessionId}: ${line}`, parseError);
                }
            });
        } catch (error: any) {
            console.warn(`[fetchRemoteDockerStatus] Error executing docker stats for session ${state.ws.sessionId}:`, error.message);
        }
    }

    allContainers.forEach(container => {
        const shortId = container.id.substring(0, 12);
        const stats = statsMap.get(container.id) || statsMap.get(shortId);
        if (stats) {
            container.stats = stats;
        }
    });

    return { available: true, containers: allContainers };
}

export async function handleDockerGetStatus(ws: AuthenticatedWebSocket, sessionId: string | undefined): Promise<void> {
    const state = sessionId ? clientStates.get(sessionId) : undefined;
    if (!state) {
        console.warn(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的 docker:get_status 请求，但无活动会话状态。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:status:error', payload: { message: 'Session state not found.' } }));
        return;
    }
    if (!state.sshClient) {
        console.warn(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的 docker:get_status 请求，但无活动 SSH 连接。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:status:error', payload: { message: 'SSH connection not active.' } }));
        return;
    }
    try {
        const statusPayload = await fetchRemoteDockerStatus(state);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:status:update', sessionId, payload: statusPayload }));
    } catch (error: any) {
        console.error(`WebSocket: 手动执行远程 Docker 状态命令失败 for session ${sessionId}:`, error);
        const errorMessage = error.message || 'Unknown error fetching status';
        const isUnavailable = errorMessage.includes('command not found') || errorMessage.includes('Cannot connect to the Docker daemon');
        if (ws.readyState === WebSocket.OPEN) {
            if (isUnavailable) {
                ws.send(JSON.stringify({ type: 'docker:status:update', sessionId, payload: { available: false, containers: [] } }));
            } else {
                ws.send(JSON.stringify({ type: 'docker:status:error', sessionId, payload: { message: `Failed to get remote Docker status: ${errorMessage}` } }));
            }
        }
    }
}

export async function handleDockerCommand(ws: AuthenticatedWebSocket, sessionId: string | undefined, payload: any): Promise<void> {
    const state = sessionId ? clientStates.get(sessionId) : undefined;
    if (!state || !state.sshClient) {
        console.warn(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的 docker:command 请求，但无活动 SSH 连接。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:command:error', payload: { command: payload?.command, message: 'SSH connection not active.' } }));
        return;
    }
    const { containerId, command } = payload || {};
    if (!containerId || typeof containerId !== 'string' || !command || !['start', 'stop', 'restart', 'remove'].includes(command)) {
        console.error(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的无效 docker:command 请求。Payload:`, payload);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:command:error', payload: { command: command, message: 'Invalid containerId or command.' } }));
        return;
    }

    console.log(`WebSocket: Processing command '${command}' for container '${containerId}' on session ${sessionId}...`);
    try {
        const cleanContainerId = containerId.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!cleanContainerId) throw new Error('Invalid container ID format after sanitization.');

        let dockerCliCommand: string;
        switch (command) {
            case 'start': dockerCliCommand = `docker start ${cleanContainerId}`; break;
            case 'stop': dockerCliCommand = `docker stop ${cleanContainerId}`; break;
            case 'restart': dockerCliCommand = `docker restart ${cleanContainerId}`; break;
            case 'remove': dockerCliCommand = `docker rm -f ${cleanContainerId}`; break;
            default: throw new Error(`Unsupported command: ${command}`);
        }

        await new Promise<void>((resolve, reject) => {
            if (!state.sshClient) {
                return reject(new Error('SSH client disconnected before command execution.'));
            }
            state.sshClient.exec(dockerCliCommand, { pty: false }, (err, stream) => {
                if (err) return reject(err);
                let stderr = '';
                stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
                stream.on('close', (code: number | null) => {
                    if (code === 0) {
                        console.log(`WebSocket: 远程 Docker 命令 (${dockerCliCommand}) on session ${sessionId} 执行成功。`);
                        resolve();
                    } else {
                        console.error(`WebSocket: 远程 Docker 命令 (${dockerCliCommand}) on session ${sessionId} 执行失败 (Code: ${code}). Stderr: ${stderr}`);
                        reject(new Error(`Command failed with code ${code}. ${stderr || 'No stderr output.'}`));
                    }
                });
                stream.on('error', (execErr: Error) => reject(execErr));
            });
        });

        // Request a status update after a short delay
        setTimeout(() => {
            const currentState = clientStates.get(sessionId!); // Re-fetch state as it might have changed
            if (currentState && currentState.ws.readyState === WebSocket.OPEN) {
                currentState.ws.send(JSON.stringify({ type: 'request_docker_status_update' }));
            }
        }, 500);

    } catch (error: any) {
        console.error(`WebSocket: 执行远程 Docker 命令 (${command} for ${containerId}) 失败 for session ${sessionId}:`, error);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:command:error', payload: { command, containerId, message: `Failed to execute remote command: ${error.message}` } }));
    }
}

export async function handleDockerGetStats(ws: AuthenticatedWebSocket, sessionId: string | undefined, payload: any): Promise<void> {
    const state = sessionId ? clientStates.get(sessionId) : undefined;
    if (!state || !state.sshClient) {
        console.warn(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的 docker:get_stats 请求，但无活动 SSH 连接。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId: payload?.containerId, message: 'SSH connection not active.' } }));
        return;
    }
    if (!payload || !payload.containerId) {
        console.warn(`WebSocket: Invalid payload for docker:get_stats in session ${sessionId}:`, payload);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId: payload?.containerId, message: 'Missing containerId.' } }));
        return;
    }

    const containerId = payload.containerId;
    console.log(`WebSocket: Handling docker:get_stats for container ${containerId} in session ${sessionId}`);
    const command = `docker stats ${containerId} --no-stream --format '{{json .}}'`;

    try {
        const execResult = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            if (!state.sshClient) {
                return reject(new Error('SSH client disconnected before command execution.'));
            }
            state.sshClient.exec(command, { pty: false }, (err, stream) => {
                if (err) return reject(err);
                stream.on('data', (data: Buffer) => { stdout += data.toString(); });
                stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
                stream.on('close', () => resolve({ stdout, stderr }));
                stream.on('error', (execErr: Error) => reject(execErr));
            });
        });

        if (execResult.stderr) {
            console.error(`WebSocket: Docker stats stderr for ${containerId} in session ${sessionId}: ${execResult.stderr}`);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId, message: execResult.stderr.trim() || 'Error executing stats command.' } }));
            return;
        }

        if (!execResult.stdout) {
            console.warn(`WebSocket: No stats output for container ${containerId} in session ${sessionId}. Might be stopped or error occurred.`);
            if (!execResult.stderr && ws.readyState === WebSocket.OPEN) {
                 ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId, message: 'No stats data received (container might be stopped).' } }));
            }
            return;
        }

        try {
            const statsData = JSON.parse(execResult.stdout.trim());
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:update', payload: { containerId, stats: statsData } }));
        } catch (parseError) {
            console.error(`WebSocket: Failed to parse docker stats JSON for ${containerId} in session ${sessionId}: ${execResult.stdout}`, parseError);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId, message: 'Failed to parse stats data.' } }));
        }

    } catch (error: any) {
        console.error(`WebSocket: Failed to execute docker stats for ${containerId} in session ${sessionId}:`, error);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'docker:stats:error', payload: { containerId, message: error.message || 'Failed to fetch Docker stats.' } }));
    }
}

/**
 * 探测容器里可用的交互式 shell（用于「进入容器」的默认命令）。
 *
 * 为什么要在后端探测：只用 `docker exec <id> bash` 是不够的 ——
 * Alpine/BusyBox 只有 ash/sh，Windows 容器只有 powershell/cmd，distroless 甚至没有 shell。
 * 一次 SSH exec 里把候选列表挨个试一遍，把结果回给前端缓存。
 */
export async function detectContainerShell(state: ClientState, containerId: string): Promise<{ shell: string; os: string }> {
    const cleanId = containerId.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!cleanId) throw new Error('Invalid container ID format after sanitization.');
    if (!state.sshClient) throw new Error('SSH client not available or not connected');

    const cached = state.dockerShellCache?.get(cleanId);
    if (cached) return { shell: cached, os: '' };

    const output = await new Promise<string>((resolve, reject) => {
        if (!state.sshClient) return reject(new Error('SSH client disconnected before command execution.'));
        let stdout = '';
        let settled = false;
        // docker daemon 无响应时不能把前端「进入容器」按死：8s 直接返回空结果
        const timer = setTimeout(() => { settled = true; resolve(stdout); }, 8000);
        state.sshClient.exec(buildShellProbeCommand(cleanId), { pty: false }, (err, stream) => {
            if (err) { clearTimeout(timer); return reject(err); }
            stream.on('data', (data: Buffer) => { stdout += data.toString(); });
            stream.stderr.on('data', () => { /* 探测期的报错本来就是预期噪音 */ });
            stream.on('close', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(stdout); } });
            stream.on('error', (execErr: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(execErr); } });
        });
    });

    const { shell, os } = parseShellProbeOutput(output);
    if (shell) {
        if (!state.dockerShellCache) state.dockerShellCache = new Map();
        state.dockerShellCache.set(cleanId, shell);
    }
    return { shell, os };
}

/**
 * 处理「进入容器」：读连接上配置的命令模板，需要时探测 shell，回一条成品命令给前端。
 *
 * 放在后端做的原因：连接的 `docker_exec_command` 本来就在库里（不用前端再查一遍连接），
 * 探测又必须走 SSH（前端拿不到远端 shell）。
 */
export async function handleDockerGetExecCommand(ws: AuthenticatedWebSocket, sessionId: string | undefined, payload: any): Promise<void> {
    const state = sessionId ? clientStates.get(sessionId) : undefined;
    const containerId = typeof payload?.containerId === 'string' ? payload.containerId : '';
    const containerName = typeof payload?.containerName === 'string' ? payload.containerName : '';
    const requestId = payload?.requestId;

    const reply = (data: Record<string, unknown>) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'docker:exec_command', sessionId, payload: { containerId, containerName, requestId, ...data } }));
        }
    };

    if (!state || !state.sshClient) { reply({ error: 'SSH connection not active.' }); return; }
    const cleanId = containerId.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!cleanId) { reply({ error: 'Missing or invalid containerId.' }); return; }

    try {
        let template = '';
        if (state.dbConnectionId) {
            try {
                const conn = await findConnectionByIdWithTags(state.dbConnectionId);
                template = (conn?.docker_exec_command || '').trim();
            } catch (err: any) {
                // 读配置失败不该挡住「进入容器」，退化成自动探测
                console.warn(`[docker:get_exec_command] 读取连接 ${state.dbConnectionId} 的 docker_exec_command 失败:`, err.message);
            }
        }
        const needsShell = !template || template.toLowerCase() === 'auto' || template.includes('{shell}');
        let shell = '';
        if (needsShell) {
            const detected = await detectContainerShell(state, cleanId);
            shell = detected.shell;
        }
        const command = buildDockerExecCommand({ containerId: cleanId, containerName, template, shell });
        console.log(`[docker:get_exec_command] 会话 ${sessionId} 容器 ${cleanId} → ${command}`);
        reply({ command, shell, auto: !template || template.toLowerCase() === 'auto' });
    } catch (error: any) {
        console.warn(`[docker:get_exec_command] 会话 ${sessionId} 容器 ${cleanId} 失败:`, error.message);
        // 探测失败也要能进容器：退回最保守的 sh
        reply({ command: buildDockerExecCommand({ containerId: cleanId, containerName, template: '', shell: 'sh' }), shell: 'sh', auto: true, error: error.message });
    }
}

export async function startDockerStatusPolling(sessionId: string): Promise<void> {
    const state = clientStates.get(sessionId);
    if (!state) {
        console.warn(`[Docker Polling] Cannot start polling for non-existent session ${sessionId}`);
        return;
    }

    console.log(`WebSocket: 会话 ${sessionId} 正在启动 Docker 状态轮询...`);
    let dockerPollIntervalMs = DEFAULT_DOCKER_STATUS_INTERVAL_SECONDS * 1000;
    try {
        const intervalSetting = await settingsService.getSetting('dockerStatusIntervalSeconds');
        if (intervalSetting) {
            const intervalSeconds = parseInt(intervalSetting, 10);
            if (!isNaN(intervalSeconds) && intervalSeconds >= 1) {
                dockerPollIntervalMs = intervalSeconds * 1000;
                console.log(`[Docker Polling] Using interval from settings: ${intervalSeconds}s (${dockerPollIntervalMs}ms) for session ${sessionId}`);
            } else {
                 console.warn(`[Docker Polling] Invalid interval setting '${intervalSetting}' found. Using default ${dockerPollIntervalMs}ms for session ${sessionId}`);
            }
        } else {
            console.log(`[Docker Polling] No interval setting found. Using default ${dockerPollIntervalMs}ms for session ${sessionId}`);
        }
    } catch (settingError) {
         console.error(`[Docker Polling] Error fetching interval setting for session ${sessionId}. Using default ${dockerPollIntervalMs}ms:`, settingError);
    }

    // Clear existing interval if any, to prevent multiple pollers for the same session
    if (state.dockerStatusIntervalId) {
        clearInterval(state.dockerStatusIntervalId);
        console.log(`[Docker Polling] Cleared existing Docker status interval for session ${sessionId}.`);
    }

    const dockerIntervalId = setInterval(async () => {
        const currentState = clientStates.get(sessionId); // Re-fetch state in case it changed (e.g., disconnected)
        if (!currentState || currentState.ws.readyState !== WebSocket.OPEN || !currentState.sshClient) {
            console.log(`[Docker Polling] Session ${sessionId} no longer valid, WS closed, or SSH disconnected. Stopping poll.`);
            clearInterval(dockerIntervalId);
            if (currentState && currentState.dockerStatusIntervalId === dockerIntervalId) { // Ensure we only delete our own interval ID
                delete currentState.dockerStatusIntervalId;
            }
            return;
        }
        try {
            const statusPayload = await fetchRemoteDockerStatus(currentState);
            if (currentState.ws.readyState === WebSocket.OPEN) { // Check again before sending
                currentState.ws.send(JSON.stringify({ type: 'docker:status:update', sessionId, payload: statusPayload }));
            }
        } catch (error: any) {
            console.warn(`[Docker Polling] 探测 Docker 状态失败 (会话 ${sessionId}):`, error.message);
            const errorMessage = error.message || '';
            const isUnavailable = errorMessage.includes('command not found') || errorMessage.includes('Cannot connect to the Docker daemon') || errorMessage.includes('not recognized');
            if (isUnavailable) {
                console.log(`[Docker Polling] 判定远程主机无可用 Docker 守护进程，自动熔断停止周期轮询 (会话: ${sessionId})`);
                clearInterval(dockerIntervalId);
                if (currentState && currentState.dockerStatusIntervalId === dockerIntervalId) {
                    delete currentState.dockerStatusIntervalId;
                }
            }
        }
    }, dockerPollIntervalMs);
    state.dockerStatusIntervalId = dockerIntervalId;

    // Initial fetch
    const initialState = clientStates.get(sessionId);
    if (initialState && initialState.ws.readyState === WebSocket.OPEN && initialState.sshClient) {
        console.log(`[Docker Initial Fetch] Fetching status for session ${sessionId}...`);
        try {
            const statusPayload = await fetchRemoteDockerStatus(initialState);
            if (initialState.ws.readyState === WebSocket.OPEN) { // Check again
                initialState.ws.send(JSON.stringify({ type: 'docker:status:update', sessionId, payload: statusPayload }));
            }
        } catch (error: any) {
            console.warn(`[Docker Initial Fetch] 首次获取 Docker 状态失败 for session ${sessionId}:`, error.message);
            if (initialState.ws.readyState === WebSocket.OPEN) {
                 const errorMessage = error.message || 'Unknown error during initial fetch';
                 const isUnavailable = errorMessage.includes('command not found') || errorMessage.includes('Cannot connect to the Docker daemon') || errorMessage.includes('not recognized');
                 if (isUnavailable) {
                     // 明确检测到无 Docker 进程，停止后续轮询以节约带宽与性能
                     if (initialState.dockerStatusIntervalId) {
                         clearInterval(initialState.dockerStatusIntervalId);
                         delete initialState.dockerStatusIntervalId;
                     }
                     initialState.ws.send(JSON.stringify({ type: 'docker:status:update', sessionId, payload: { available: false, containers: [] } }));
                 } else {
                     initialState.ws.send(JSON.stringify({ type: 'docker:status:error', sessionId, payload: { message: `Initial Docker status fetch failed: ${errorMessage}` } }));
                 }
            }
        }
    }
}