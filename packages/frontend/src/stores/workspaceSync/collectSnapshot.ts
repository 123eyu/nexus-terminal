import { useSessionStore } from '../session.store';
import { useFileEditorStore } from '../fileEditor.store';
import { useLayoutStore } from '../layout.store';
import { useConnectionsStore } from '../connections.store';
import {
  isValidFileManagerSyncPath,
  type SyncedFileManagerInfo,
  type SyncedFileManagerInstanceState,
  type SyncedFileTabInfo,
  type SyncedMultiLineCommandInfo,
  type SyncedSessionInfo,
  type WorkspaceSnapshot,
} from './types';

/**
 * 采集当前工作区快照（从 workspaceSync.store 抽出，204 行）。
 *
 * 这里有几个不显然但必须保留的约束，都是线上问题换来的：
 *
 * 1. **会话顺序按标签栏真实排布**，不是 Map 的插入顺序 —— 否则刷新后标签会乱序。
 * 2. **全屏 TUI（btop/vim/less）的备用屏不能存**。界面文字没有保存价值，
 *    存下来会让刷新后的终端变成一块静态 UI，退出 TUI 时还会留一片黑。
 * 3. **分屏 buffer 的 key 必须是先序序号**（pane#0 / pane#1）。
 *    会话树的 paneId 每次刷新都会重新生成，直接拿 paneId 当 key，恢复时必然全部 miss。
 */
export interface CollectSnapshotDeps {
  syncEnabled: boolean;
  fileManagerState: SyncedFileManagerInfo;
  fileManagerInstances: Record<string, SyncedFileManagerInstanceState>;
  multiLineCommandState: SyncedMultiLineCommandInfo;
}

export function collectWorkspaceSnapshot(deps: CollectSnapshotDeps): WorkspaceSnapshot {
  const sessionStore = useSessionStore();
  const fileEditorStore = useFileEditorStore();
  const layoutStore = useLayoutStore();
  const connectionsStore = useConnectionsStore();

  // 1. 收集会话信息（严格按照当前标签栏真实的排布顺序收集！）
  const orderedTabs = sessionStore.sessionTabsWithStatus || [];
  const orderedSessionIds = orderedTabs.map((t) => t.sessionId);
  const allSessionIds = Array.from(sessionStore.sessions.keys());
  const sortedSessionIds = [
    ...orderedSessionIds.filter((id) => allSessionIds.includes(id)),
    ...allSessionIds.filter((id) => !orderedSessionIds.includes(id)),
  ];

  const sessionsList: SyncedSessionInfo[] = [];
  sortedSessionIds.forEach((sId) => {
    const s = sessionStore.sessions.get(sId);
    if (!s) return;
    // 终端屏幕缓冲区：优先用 SerializeAddon（带完整 ANSI 转义、RGB 真彩与格式）
    let terminalBuffer = '';
    if (s.terminalManager && typeof (s.terminalManager as any).serializeTerminal === 'function') {
      const serialized = (s.terminalManager as any).serializeTerminal();
      if (typeof serialized === 'string') {
        terminalBuffer = serialized;
      }
    }

    // SerializeAddon 未激活或未输出时，降级用文本缓冲区提取兜底
    if (!terminalBuffer && s.terminalManager?.terminalInstance?.value) {
      const term = s.terminalManager.terminalInstance.value;
      const buffer = term.buffer.active;
      // 全屏 TUI 正在使用备用屏：界面文字没有保存价值，
      // 存下来反而会让刷新后的终端变成一块静态 UI，退出 TUI 时还会留下一片黑。
      if (buffer.type !== 'alternate') {
        let lastNonEmptyLineIndex = -1;
        for (let i = buffer.length - 1; i >= 0; i--) {
          const line = buffer.getLine(i);
          if (line && line.translateToString(true).trim() !== '') {
            lastNonEmptyLineIndex = i;
            break;
          }
        }
        if (lastNonEmptyLineIndex !== -1) {
          let result = '';
          for (let i = 0; i <= lastNonEmptyLineIndex; i++) {
            const line = buffer.getLine(i);
            if (!line) continue;
            const nextLine = i < lastNonEmptyLineIndex ? buffer.getLine(i + 1) : null;
            const isNextWrapped = nextLine ? nextLine.isWrapped : false;
            if (isNextWrapped) {
              result += line.translateToString(false);
            } else {
              result += line.translateToString(true);
              if (i < lastNonEmptyLineIndex) {
                result += '\r\n';
              }
            }
          }
          terminalBuffer = result;
        }
      }
    }

    if (
      !terminalBuffer &&
      (s as any).lastTerminalBuffer &&
      s.terminalManager?.terminalInstance?.value?.buffer?.active?.type !== 'alternate'
    ) {
      terminalBuffer = (s as any).lastTerminalBuffer;
    }

    // 多终端分屏各 pane 独立序列化 buffer
    let terminalPanesBuffer: Record<string, string> | undefined = undefined;
    if (s.terminalManager && typeof (s.terminalManager as any).serializeAllPanes === 'function') {
      const panesBuf = (s.terminalManager as any).serializeAllPanes();
      if (panesBuf && Object.keys(panesBuf).length > 0) {
        // 会话树的 paneId 每次刷新都会重新生成，
        // 直接拿 paneId 当 key，恢复时必然全部 miss —— 表现就是"刷新后终端内容对不上"。
        // 这里统一改写成跨刷新稳定的先序序号键：pane#0 / pane#1 ……
        const order = layoutStore.getSessionTerminalPaneOrder(sId);
        const normalized: Record<string, string> = {};
        for (const [pid, buf] of Object.entries(panesBuf)) {
          const idx = order.indexOf(pid);
          normalized[idx >= 0 ? `pane#${idx}` : pid] = buf as string;
        }
        terminalPanesBuffer = normalized;
      }
    }
    if (!terminalPanesBuffer && (s as any).lastTerminalPanesBuffer) {
      terminalPanesBuffer = (s as any).lastTerminalPanesBuffer;
    }
    if (terminalPanesBuffer) {
      (s as any).lastTerminalPanesBuffer = terminalPanesBuffer;
    }

    // 会话自身独立的编辑器标签页（shareFileEditorTabs=false 时）
    let sessionSpecificTabs: SyncedFileTabInfo[] | undefined = undefined;
    if (s.editorTabs?.value && Array.isArray(s.editorTabs.value) && s.editorTabs.value.length > 0) {
      sessionSpecificTabs = s.editorTabs.value.map((tab) => ({
        id: tab.id,
        sessionId: tab.sessionId || sId,
        filePath: tab.filePath,
        filename: tab.filename,
        content: tab.content,
        rawContentBase64: tab.rawContentBase64 || null,
        isModified: tab.isModified,
        language: tab.language,
        selectedEncoding: tab.selectedEncoding,
        scrollTop: tab.scrollTop || 0,
        scrollLeft: tab.scrollLeft || 0,
      }));
    }

    const matchedConn = connectionsStore.connections.find(
      (c) => String(c.id) === String(s.connectionId)
    );
    sessionsList.push({
      sessionId: sId,
      connectionId: s.connectionId,
      connectionName: s.connectionName,
      connectionUuid: matchedConn?.uuid,
      commandInputContent: s.commandInputContent.value || '',
      suspendSessionId: (s as any).suspendSessionId,
      terminalBuffer: terminalBuffer !== undefined ? terminalBuffer : '',
      terminalPanesBuffer,
      primaryTerminalPaneId:
        (s as any).primaryTerminalPaneId || s.terminalManager?.primaryPaneId?.value || undefined,
      focusedTerminalPaneId: s.focusedTerminalPaneId || undefined,
      editorTabs: sessionSpecificTabs,
      activeEditorTabId: s.activeEditorTabId?.value || null,
    });
  });

  // 2. 收集全局编辑器标签（共享模式及全局数据池）
  const editorTabsList: SyncedFileTabInfo[] = fileEditorStore.orderedTabs.map((tab) => ({
    id: tab.id,
    sessionId: tab.sessionId,
    filePath: tab.filePath,
    filename: tab.filename,
    content: tab.content,
    rawContentBase64: tab.rawContentBase64 || null,
    isModified: tab.isModified,
    language: tab.language,
    selectedEncoding: tab.selectedEncoding,
    scrollTop: tab.scrollTop || 0,
    scrollLeft: tab.scrollLeft || 0,
  }));

  // 3. 收集所有会话的所有文件管理器实例
  const allFileManagers: Record<string, SyncedFileManagerInstanceState> = {};
  sessionStore.sessions.forEach((s, sId) => {
    if (s.sftpManagers) {
      s.sftpManagers.forEach((mgr, instId) => {
        const key = `${sId}:${instId}`;
        const cached = deps.fileManagerInstances[key] || ({} as SyncedFileManagerInstanceState);
        const realPath =
          mgr.currentPath?.value && isValidFileManagerSyncPath(mgr.currentPath.value)
            ? mgr.currentPath.value
            : cached.currentPath && isValidFileManagerSyncPath(cached.currentPath)
              ? cached.currentPath
              : '';
        allFileManagers[key] = {
          sessionId: sId,
          instanceId: instId,
          currentPath: realPath,
          isSearchActive: cached.isSearchActive || false,
          searchQuery: cached.searchQuery || '',
          scrollTop: cached.scrollTop || 0,
          scrollRatio: typeof cached.scrollRatio === 'number' ? cached.scrollRatio : 0,
        };
      });
    }
  });

  // 确定主文件管理器兼容路径
  let realFmPath = deps.fileManagerState.currentPath;
  const currentActiveSession = sessionStore.activeSessionId
    ? sessionStore.sessions.get(sessionStore.activeSessionId)
    : null;
  if (currentActiveSession?.sftpManagers) {
    for (const mgr of currentActiveSession.sftpManagers.values()) {
      const p = mgr.currentPath?.value;
      if (p && isValidFileManagerSyncPath(p)) {
        realFmPath = p;
        break;
      }
    }
  }

  return {
    syncEnabled: deps.syncEnabled,
    activeSessionId: sessionStore.activeSessionId,
    sessions: sessionsList,
    sessionOrder: sortedSessionIds,
    layout: {
      layoutTree: layoutStore.layoutTree ? JSON.parse(JSON.stringify(layoutStore.layoutTree)) : null,
      sidebarPanes: layoutStore.sidebarPanes
        ? JSON.parse(JSON.stringify(layoutStore.sidebarPanes))
        : undefined,
    },
    fileEditor: {
      isOpen: fileEditorStore.isPopupOpen,
      activeTabId: fileEditorStore.activeTabId,
      tabs: editorTabsList,
    },
    fileManager: {
      ...deps.fileManagerState,
      currentPath: realFmPath,
    },
    fileManagers: allFileManagers,
    multiLineCommandInput: { ...deps.multiLineCommandState },
    updatedAt: Math.floor(Date.now() / 1000),
  };
}
