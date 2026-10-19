import { useFileEditorStore } from '../fileEditor.store';
import { useSessionStore } from '../session.store';
import { logSync, logSyncWarn } from './log';
import type { SyncedFileTabInfo, WorkspaceSnapshot } from './types';

/**
 * 从快照恢复编辑器标签（全局共享池 + 每会话独立池）。
 *
 * 两套池子并存是因为 `shareFileEditorTabs`：
 * - 开（默认）：所有会话共用一份标签，恢复时写全局池；
 * - 关：每个会话有自己的一组标签，恢复时写该会话的 editorTabs。
 *
 * 两个容易踩的点：
 * 1. 标签 id 是 `${sessionId}:${filePath}`，而快照里的 sessionId 是**旧 id**，
 *    必须先用 resolveSessionId 映射成当前会话 id，否则标签会挂在已经不存在的会话下。
 * 2. 未修改的标签要在 SFTP 就绪后静默 reload 一次（校验远端最新内容），
 *    但**不能 await** —— 恢复流程要保证"秒开"，等 reload 会让界面卡在空白。
 */
export interface RestoreEditorsDeps {
  snapshot: WorkspaceSnapshot;
  /** 快照旧 sessionId -> 当前 sessionId（解析失败返回 null） */
  resolveSessionId: (snapshotSessionId: string) => string | null;
}

export function restoreEditorsFromSnapshot(deps: RestoreEditorsDeps): void {
  const fileEditorStore = useFileEditorStore();
  const sessionStore = useSessionStore();
  const { snapshot, resolveSessionId } = deps;

  // --- 全局共享池 ---
  if (snapshot.fileEditor && snapshot.fileEditor.tabs && snapshot.fileEditor.tabs.length > 0) {
    logSync(`正在恢复 ${snapshot.fileEditor.tabs.length} 个编辑器标签...`);
    for (const tab of snapshot.fileEditor.tabs) {
      const targetSessionId = resolveSessionId(tab.sessionId);
      if (!targetSessionId) {
        logSyncWarn(`无法解析标签 ${tab.filePath} 对应的会话 ID，跳过`);
        continue;
      }

      // 即时秒开呈现标签页，杜绝未就绪时报错与白屏
      const tabId = fileEditorStore.restoreTabFromSnapshot({
        ...tab,
        sessionId: targetSessionId,
      });

      // 恢复未保存内容
      if (tab.content) {
        fileEditorStore.updateFileContent(tabId, tab.content);
      }
      // 恢复滚动位置
      if (typeof tab.scrollTop === 'number' || typeof tab.scrollLeft === 'number') {
        fileEditorStore.updateTabScrollPosition(tabId, tab.scrollTop || 0, tab.scrollLeft || 0);
      }

      // SFTP 就绪后，对未修改的标签在后台静默 reload 校验远程最新数据（不 await，保证秒开）
      if (!tab.isModified) {
        fileEditorStore.reloadFile(tabId, true).catch(() => {});
      }
      logSync(
        `成功恢复编辑器标签: ${tab.filename} (Tab ID: ${tabId}, 编码: ${tab.selectedEncoding})`
      );
    }

    // 激活原编辑器活动标签
    if (snapshot.fileEditor.activeTabId) {
      const origParts = snapshot.fileEditor.activeTabId.split(':');
      const origSessionId = origParts[0];
      const origFilePath = snapshot.fileEditor.activeTabId.substring(origSessionId.length + 1);
      const mappedSessionId = resolveSessionId(origSessionId);
      if (mappedSessionId && origFilePath) {
        fileEditorStore.setActiveTab(`${mappedSessionId}:${origFilePath}`);
        logSync(`激活全局编辑器活动标签: ${mappedSessionId}:${origFilePath}`);
      }
    }
  }

  // --- 每个会话独立的标签池（shareFileEditorTabs=false）---
  if (snapshot.sessions && snapshot.sessions.length > 0) {
    for (const s of snapshot.sessions) {
      const targetSessionId = resolveSessionId(s.sessionId);
      if (!targetSessionId) continue;
      const currentSession = sessionStore.sessions.get(targetSessionId);
      if (!currentSession || !currentSession.editorTabs) continue;

      // 优先用会话自己的 editorTabs，老快照没有时从全局池里按会话过滤
      const tabsForThisSession: SyncedFileTabInfo[] =
        s.editorTabs && s.editorTabs.length > 0
          ? s.editorTabs
          : (snapshot.fileEditor?.tabs || []).filter((t) => t.sessionId === s.sessionId);

      if (tabsForThisSession.length > 0) {
        logSync(
          `正在恢复会话 ${targetSessionId} 的独立编辑器标签 (${tabsForThisSession.length} 个)...`
        );
        for (const tab of tabsForThisSession) {
          const tabId = `${targetSessionId}:${tab.filePath}`;
          const existing = currentSession.editorTabs.value.find(
            (t) => t.id === tabId || t.filePath === tab.filePath
          );
          if (existing) {
            if (typeof tab.content === 'string') existing.content = tab.content;
            if (tab.rawContentBase64) existing.rawContentBase64 = tab.rawContentBase64;
            if (typeof tab.isModified === 'boolean') existing.isModified = tab.isModified;
            if (typeof tab.scrollTop === 'number') existing.scrollTop = tab.scrollTop;
            if (typeof tab.scrollLeft === 'number') existing.scrollLeft = tab.scrollLeft;
          } else {
            currentSession.editorTabs.value.push({
              id: tabId,
              sessionId: targetSessionId,
              filePath: tab.filePath,
              filename: tab.filename || tab.filePath.split('/').pop() || '',
              content: tab.content || '',
              originalContent: tab.isModified ? '' : tab.content || '',
              rawContentBase64: tab.rawContentBase64 || null,
              language: tab.language || 'plaintext',
              selectedEncoding: tab.selectedEncoding || 'utf-8',
              isLoading: false,
              loadingError: null,
              isSaving: false,
              saveStatus: 'idle',
              saveError: null,
              isModified: !!tab.isModified,
              scrollTop: tab.scrollTop || 0,
              scrollLeft: tab.scrollLeft || 0,
              remoteMtime: undefined,
              remoteSize: undefined,
              hasExternalConflict: false,
            });
          }
        }
        // 激活会话自身的活动标签
        if (s.activeEditorTabId) {
          const origParts = s.activeEditorTabId.split(':');
          const origSessionId = origParts[0];
          const origFilePath = s.activeEditorTabId.substring(origSessionId.length + 1);
          currentSession.activeEditorTabId.value = `${targetSessionId}:${origFilePath}`;
          logSync(
            `激活会话 ${targetSessionId} 独立活动标签: ${currentSession.activeEditorTabId.value}`
          );
        }
      }
    }
  }
}
