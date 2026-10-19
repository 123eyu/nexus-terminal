import { useSessionStore } from '../session.store';
import { useLayoutStore } from '../layout.store';
import { useConnectionsStore } from '../connections.store';
import { useTerminalHighlightStore } from '../terminal-highlight.store';
import { getLocalStorageSafe, recordSessionIdAlias as recordAlias } from '../../utils/pendingRemoval';
import { cleanTrailingPromptForReconnect } from './terminalBuffer';
import { logSync, logSyncWarn } from './log';
import type { WorkspaceSnapshot } from './types';

/**
 * 从快照恢复会话列表并建立「旧 sessionId -> 新 sessionId」映射。
 *
 * 这是整个恢复流程里最绕的一段，几个必须保持的行为：
 *
 * 1. **连接匹配是三级降级**：uuid（跨端权威）→ 连接名（跨端对齐）→ 整数主键（同库兜底）。
 *    两端的本地自增 id 不同，只认 id 会把会话挂到错误的连接上。
 * 2. **挂起会话优先消费**：服务端还留着 SSH 连接时直接唤醒（保留进程状态），
 *    唤醒成功就**不要**再回放 buffer —— 后端会通过 logData 自己回放，重复写会叠两层。
 * 3. **并发恢复但保持快照顺序**：`Promise.all` 只影响耗时，不影响 sessionOrder。
 * 4. **primaryTerminalPaneId 只记录不写入 manager**：会话树的 paneId 每次刷新都重新生成，
 *    写进 manager 会锁定一个不存在的分屏通道，命令直接发不出去。
 */
export interface RestoreSessionsDeps {
  snapshot: WorkspaceSnapshot;
  /**
   * 阶段 2 拉到的挂起会话池。**会被就地消费（splice）**，
   * 所以必须传同一个数组引用，否则后续会话会重复认领同一个挂起会话。
   */
  availableSuspended: any[];
}

export async function restoreSessionsFromSnapshot(
  deps: RestoreSessionsDeps
): Promise<Map<string, string>> {
  const sessionStore = useSessionStore();
  const layoutStore = useLayoutStore();
  const connectionsStore = useConnectionsStore();
  const highlightStore = useTerminalHighlightStore();

  const { snapshot, availableSuspended } = deps;
  const sessionIdMap = new Map<string, string>();

  if (!snapshot.sessions || snapshot.sessions.length === 0) {
    return sessionIdMap;
  }

  // 预先识别云端选中的目标激活会话（未记录则默认第 0 个）
  const targetActiveSessionSnapshotId = snapshot.activeSessionId || snapshot.sessions[0]?.sessionId;

  // 先同步匹配消费池，为并发恢复做预先规划
  const restorePlans = snapshot.sessions.map((s) => {
    // 多维三级匹配：1. UUID 跨库唯一标识 -> 2. 主机名称（跨端对齐）-> 3. 整数主键 ID（同库兜底）
    let connInfo = undefined;
    if (s.connectionUuid) {
      connInfo = connectionsStore.connections.find((c) => c.uuid && c.uuid === s.connectionUuid);
    }
    if (!connInfo && s.connectionName) {
      connInfo = connectionsStore.connections.find(
        (c) => c.name && c.name.trim().toLowerCase() === s.connectionName.trim().toLowerCase()
      );
    }
    if (!connInfo && s.connectionId !== undefined && s.connectionId !== null) {
      const connIdNum = Number(s.connectionId);
      connInfo = connectionsStore.connections.find((c) => c.id === connIdNum);
    }

    let matchedIdx = availableSuspended.findIndex(
      (item) => item.originalSessionId && item.originalSessionId === s.sessionId
    );

    if (matchedIdx === -1 && s.suspendSessionId) {
      matchedIdx = availableSuspended.findIndex(
        (item) => item.suspendSessionId === s.suspendSessionId
      );
    }

    if (matchedIdx === -1) {
      matchedIdx = availableSuspended.findIndex(
        (item) =>
          String(item.connectionId) === String(s.connectionId) ||
          item.connectionName === s.connectionName
      );
    }

    let matchedSuspended: any = undefined;
    if (matchedIdx !== -1) {
      matchedSuspended = availableSuspended[matchedIdx];
      availableSuspended.splice(matchedIdx, 1);
    }

    return {
      snapshotSession: s,
      connInfo,
      matchedSuspended,
      isTargetActive: s.sessionId === targetActiveSessionSnapshotId,
    };
  });

  // 严格保持快照中会话从左到右的原始顺序；并行恢复只为缩短耗时
  // 目标会话传 shouldActivate: true（第 0 毫秒聚焦），后台会话 false（静默加载）
  logSync(
    `开始全量并发恢复 ${restorePlans.length} 个会话（保持原始顺序），目标激活会话即时聚焦，其余会话静默后台加载...`
  );

  await Promise.all(
    restorePlans.map(async (plan) => {
      const s = plan.snapshotSession;
      let targetSessionId: string | null = null;
      let isResumed = false;
      const shouldActivateThis = plan.isTargetActive;

      if (plan.matchedSuspended) {
        logSync(
          `发现匹配的挂起会话，正在并发唤醒接管: ${plan.matchedSuspended.suspendSessionId} (${plan.matchedSuspended.connectionName}, isTargetActive=${shouldActivateThis})`
        );
        try {
          targetSessionId = await sessionStore.resumeSshSession(
            plan.matchedSuspended.suspendSessionId,
            shouldActivateThis
          );
          if (targetSessionId) {
            isResumed = true;
            logSync(`挂起会话已并发唤醒，新会话 ID: ${targetSessionId}，由服务端接管回放`);
          }
        } catch (err) {
          logSyncWarn(`恢复挂起会话失败，降级为并发新建会话:`, err);
        }
      }

      // 无挂起或恢复失败：并发新建会话（用本地查到的有效主键 ID）
      if (!targetSessionId && plan.connInfo) {
        logSync(
          `重新开启连接会话 (并发): ${plan.connInfo.name || plan.connInfo.host} (本地连接 ID: ${plan.connInfo.id}, 快照原 ID: ${s.connectionId}, isTargetActive=${shouldActivateThis})`
        );
        targetSessionId =
          sessionStore.openNewSession(plan.connInfo.id, undefined, shouldActivateThis) || null;
      }

      // 仍无目标：看本地是否已有属于该连接且未被映射的会话兜底
      if (!targetSessionId) {
        const matchedExisting = Array.from(sessionStore.sessions.values()).find(
          (existingSession) => {
            if (Array.from(sessionIdMap.values()).includes(existingSession.sessionId)) return false;
            if (plan.connInfo && String(existingSession.connectionId) === String(plan.connInfo.id))
              return true;
            if (s.connectionName && existingSession.connectionName === s.connectionName) return true;
            return String(existingSession.connectionId) === String(s.connectionId);
          }
        );
        if (matchedExisting) {
          targetSessionId = matchedExisting.sessionId;
          if (shouldActivateThis) {
            sessionStore.activateSession(targetSessionId);
          }
        }
      }

      if (!targetSessionId) return;

      sessionIdMap.set(s.sessionId, targetSessionId);
      // 记下"新 ID -> 快照旧 ID"，关闭会话时才能把快照里那份旧记录一起剔除
      recordAlias(targetSessionId, s.sessionId, getLocalStorageSafe());
      logSync(
        `建立会话 ID 映射: 旧 ${s.sessionId} -> 新 ${targetSessionId} (激活: ${shouldActivateThis})`
      );

      // 恢复单行命令输入框内容
      if (s.commandInputContent) {
        sessionStore.updateSessionCommandInput(targetSessionId, s.commandInputContent);
      }

      // 终端屏幕历史回放：resumeSshSession 唤醒的会话由后端 logData 自动回放，不能重复写
      if (s.terminalBuffer) {
        const sessionState = sessionStore.sessions.get(targetSessionId);
        if (sessionState) {
          (sessionState as any).lastTerminalBuffer = s.terminalBuffer;
          if (!isResumed) {
            logSync(
              `为新连接会话 ${targetSessionId} 回放快照保存的终端屏幕历史 (字符数: ${s.terminalBuffer.length})`
            );
            const cleanedBuffer = cleanTrailingPromptForReconnect(s.terminalBuffer);
            const highlightedData: string = highlightStore.highlight(cleanedBuffer) as string;

            if (sessionState.terminalManager?.terminalInstance?.value) {
              sessionState.terminalManager.terminalInstance.value.write(highlightedData);
              try {
                sessionState.terminalManager.terminalInstance.value.refresh(
                  0,
                  sessionState.terminalManager.terminalInstance.value.rows - 1
                );
              } catch {
                /* 终端尚未布局完成时 refresh 可能抛错，忽略 */
              }
            } else {
              if (!sessionState.pendingOutput) {
                sessionState.pendingOutput = [];
              }
              sessionState.pendingOutput.push(highlightedData);
            }
          }
        }
      } else if (s.terminalBuffer === '') {
        // 快照记录"已清屏"：当前会话有终端实例就立刻同步清空视口
        const sessionState = sessionStore.sessions.get(targetSessionId);
        if (sessionState) {
          if (sessionState.terminalManager?.terminalInstance?.value) {
            sessionState.terminalManager.terminalInstance.value.clear();
          }
          sessionState.pendingOutput = [];
          logSync(`为会话 ${targetSessionId} 同步清空终端屏幕视口`);
        }
      }

      // 多终端分屏历史回放：写到 lastTerminalPanesBuffer，并向已挂载的副终端回放
      if (s.terminalPanesBuffer) {
        const sessionState = sessionStore.sessions.get(targetSessionId);
        if (sessionState) {
          (sessionState as any).lastTerminalPanesBuffer = s.terminalPanesBuffer;
          const tm = sessionState.terminalManager as any;
          if (tm?.terminalPanes?.value && !isResumed) {
            const panesMap = tm.terminalPanes.value as Map<string, any>;
            // 快照存的是 pane#0/pane#1 稳定序号，要换算成当前会话树的真实 paneId
            const order = layoutStore.getSessionTerminalPaneOrder(targetSessionId);
            Object.entries(s.terminalPanesBuffer).forEach(([key, buf]) => {
              const pId = key.startsWith('pane#') ? order[Number(key.slice(5))] : key;
              if (!pId || pId === 'primary') return;
              const paneEntry = panesMap.get(pId);
              if (paneEntry?.instance?.value && buf) {
                logSync(
                  `为分屏终端 ${pId} (会话 ${targetSessionId}) 回放快照保存的屏幕历史 (字符数: ${buf.length})`
                );
                const cleaned = cleanTrailingPromptForReconnect(buf);
                const highlighted = highlightStore.highlight(cleaned) as string;
                paneEntry.instance.value.write(highlighted);
                try {
                  paneEntry.instance.value.refresh(0, paneEntry.instance.value.rows - 1);
                } catch {
                  /* 同上 */
                }
              }
            });
          }
        }
      }

      // 恢复主终端记录（只留作参考，不要写进 manager）
      // 会话树每次刷新都会重新生成 paneId，把旧 paneId 写进 primaryPaneId
      // 会锁定一个并不存在的分屏通道，导致命令发不出去。
      // manager 会在终端就绪时按"当前布局树的先序第一个终端"自行确定。
      if (s.primaryTerminalPaneId) {
        const sessionState = sessionStore.sessions.get(targetSessionId);
        if (sessionState) {
          (sessionState as any).primaryTerminalPaneId = s.primaryTerminalPaneId;
        }
      }

      // 恢复"该会话上次聚焦的终端"，多终端分屏时切回来能直接落在正确的那一屏
      if (s.focusedTerminalPaneId) {
        const sessionState = sessionStore.sessions.get(targetSessionId);
        if (sessionState) {
          sessionState.focusedTerminalPaneId = s.focusedTerminalPaneId;
          // 布局树的焦点同步发生在会话挂载时（早于这里），所以补一次，
          // 否则 activeTerminalPaneId 会停在默认的第一个终端上。
          if (sessionStore.activeSessionId === targetSessionId) {
            layoutStore.setActiveTerminalPaneId(s.focusedTerminalPaneId);
          }
        }
      }
    })
  );

  return sessionIdMap;
}

/**
 * 恢复会话标签栏的排布顺序。
 *
 * 快照里的顺序是**旧 sessionId**，必须经映射表翻译；映射不到的（会话已不存在）丢弃。
 * 之后把本地新增的会话追加到末尾 —— 否则新开的会话会因为不在快照里而消失于标签栏。
 */
export function restoreSessionOrder(deps: {
  snapshot: WorkspaceSnapshot;
  sessionIdMap: Map<string, string>;
}): string[] {
  const sessionStore = useSessionStore();
  const { snapshot, sessionIdMap } = deps;

  const rawOrderList = snapshot.sessionOrder || snapshot.sessions?.map((s) => s.sessionId) || [];
  const restoredSessionOrder: string[] = [];
  rawOrderList.forEach((oldId) => {
    const newId = sessionIdMap.get(oldId) || (sessionStore.sessions.has(oldId) ? oldId : null);
    if (newId && !restoredSessionOrder.includes(newId)) {
      restoredSessionOrder.push(newId);
    }
  });
  sessionStore.sessions.forEach((_, sId) => {
    if (!restoredSessionOrder.includes(sId)) {
      restoredSessionOrder.push(sId);
    }
  });

  if (restoredSessionOrder.length > 0) {
    logSync('从云端快照恢复会话标签排布顺序:', restoredSessionOrder);
    sessionStore.setSessionOrder(restoredSessionOrder, false);
  }
  return restoredSessionOrder;
}

/**
 * 构造「快照旧 sessionId -> 当前 sessionId」的解析器。
 *
 * 降级顺序（每一步都可能救回一个会话）：
 *   1. 旧 id 本身还在（同一次会话内刷新）
 *   2. 映射表命中且目标仍存在
 *   3. 按 connectionId 找本地同连接的会话
 *   4. 按连接名（忽略大小写）找
 *   5. 只剩一个会话时直接用它（单会话用户的兜底）
 *   6. 退到当前激活会话
 */
export function createSessionIdResolver(deps: {
  snapshot: WorkspaceSnapshot;
  sessionIdMap: Map<string, string>;
}): (oldId?: string | null, fallbackConnId?: number | string) => string | null {
  const sessionStore = useSessionStore();
  const { snapshot, sessionIdMap } = deps;

  return (oldId?: string | null, fallbackConnId?: number | string): string | null => {
    if (oldId && sessionStore.sessions.has(oldId)) return oldId;
    if (oldId && sessionIdMap.has(oldId)) {
      const mapped = sessionIdMap.get(oldId)!;
      if (sessionStore.sessions.has(mapped)) return mapped;
    }

    // 未显式提供 fallbackConnId 时，从快照里反查 oldId 对应的 connectionId
    let targetConnId = fallbackConnId;
    if (targetConnId === undefined && oldId && snapshot.sessions) {
      const sItem = snapshot.sessions.find((s) => s.sessionId === oldId);
      if (sItem) {
        targetConnId = sItem.connectionId;
      }
    }
    if (targetConnId !== undefined) {
      const matched = Array.from(sessionStore.sessions.values()).find(
        (item) => String(item.connectionId) === String(targetConnId)
      );
      if (matched) return matched.sessionId;
    }

    if (oldId && snapshot.sessions) {
      const sItem = snapshot.sessions.find((s) => s.sessionId === oldId);
      if (sItem && sItem.connectionName) {
        const matchedByName = Array.from(sessionStore.sessions.values()).find(
          (item) =>
            item.connectionName &&
            item.connectionName.trim().toLowerCase() === sItem.connectionName.trim().toLowerCase()
        );
        if (matchedByName) return matchedByName.sessionId;
      }
    }

    if (sessionStore.sessions.size === 1) {
      return sessionStore.sessions.keys().next().value || null;
    }
    return sessionStore.activeSessionId || null;
  };
}
