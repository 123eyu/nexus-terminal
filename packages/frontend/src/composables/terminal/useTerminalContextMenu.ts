import { ref, type Ref } from 'vue';
import { storeToRefs } from 'pinia';
import type { Terminal } from 'xterm';
import { useSettingsStore } from '../../stores/settings.store';
import { openRemoteFile } from '../file-manager/useFileOpenMode';
import { useWorkspaceEventEmitter } from '../workspaceEvents';

/**
 * 终端右键交互（从 Terminal.vue 拆出，约 138 行）。
 *
 * 行为由设置项 `terminalRightClickBehavior` 决定，五种模式 + 默认菜单：
 *   none / paste / copy / openPath / openFile / saveQuickCommand / contextMenu
 *
 * 默认模式下的核心铁律（注释里的原话）：**未选中文本直接粘贴，选中文本才弹菜单**。
 * 这是终端最常用的交互，改这里前先确认两种场景都走通。
 */
export interface TerminalContextMenuDeps {
  /** 取当前 xterm 实例（实例会在挂载时才创建，所以用 getter 而不是直接传引用） */
  getTerminal: () => Terminal | null;
  getSessionId: () => string;
  /** 右键监听挂在哪个元素上 */
  containerRef: Ref<HTMLElement | null>;
}

export function useTerminalContextMenu(deps: TerminalContextMenuDeps) {
  const settingsStore = useSettingsStore();
  const emitWorkspaceEvent = useWorkspaceEventEmitter();
  const { terminalRightClickBehaviorString } = storeToRefs(settingsStore);

  const showContextMenu = ref(false);
  const contextMenuPosition = ref({ x: 0, y: 0 });
  const contextMenuSelectedText = ref('');

  const executePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const term = deps.getTerminal();
      if (text && term) {
        term.focus();
        term.paste(text);
      }
    } catch (err) {
      console.error('[Terminal] Failed to paste:', err);
    }
  };

  const executeCopy = async (text: string) => {
    try {
      if (text) {
        await navigator.clipboard.writeText(text);
      }
    } catch (err) {
      console.error('[Terminal] Failed to copy:', err);
    }
  };

  /** 去掉选中文本两侧可能带的引号（用户选中一段带引号的路径很常见） */
  const stripQuotes = (text: string) => text.trim().replace(/^['"]|['"]$/g, '');

  const executeOpenPath = (pathText: string) => {
    const cleanPath = stripQuotes(pathText);
    if (!cleanPath) return;
    emitWorkspaceEvent('fileManager:navigateToPath', {
      path: cleanPath,
      sessionId: deps.getSessionId(),
    });
  };

  const executeOpenFile = (filePathText: string) => {
    const cleanPath = stripQuotes(filePathText);
    if (!cleanPath) return;
    const fileName = cleanPath.substring(cleanPath.lastIndexOf('/') + 1) || cleanPath;
    const sessionId = deps.getSessionId();

    // 与文件管理器共用同一套分流：桌面端可能走"系统默认程序打开"
    void openRemoteFile({
      sessionId,
      instanceId: 'terminal',
      path: cleanPath,
      fileName,
    });
  };

  const executeSaveQuickCommand = (cmdText: string) => {
    const cleanCmd = cmdText.trim();
    if (!cleanCmd) return;
    emitWorkspaceEvent('quickCommand:requestAdd', {
      initialCommand: cleanCmd,
    });
  };

  const handleContextMenu = async (event: MouseEvent) => {
    const behavior = terminalRightClickBehaviorString.value;
    if (behavior === 'none') {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    const selection = deps.getTerminal()?.getSelection()?.trim() || '';

    if (behavior === 'paste') {
      await executePaste();
      return;
    }
    if (behavior === 'copy') {
      if (selection) await executeCopy(selection);
      return;
    }
    if (behavior === 'openPath') {
      if (selection) executeOpenPath(selection);
      return;
    }
    if (behavior === 'openFile') {
      if (selection) executeOpenFile(selection);
      return;
    }
    if (behavior === 'saveQuickCommand') {
      if (selection) executeSaveQuickCommand(selection);
      return;
    }

    // 默认模式 contextMenu：未选中直接粘贴；选中则弹菜单
    if (!selection) {
      await executePaste();
    } else {
      contextMenuSelectedText.value = selection;
      contextMenuPosition.value = { x: event.clientX, y: event.clientY };
      showContextMenu.value = true;
    }
  };

  const handleContextMenuAction = async (action: string) => {
    const selection = contextMenuSelectedText.value || deps.getTerminal()?.getSelection()?.trim() || '';
    switch (action) {
      case 'copy':
        if (selection) await executeCopy(selection);
        {
          const term = deps.getTerminal();
          if (term) term.focus();
        }
        break;
      case 'paste':
        await executePaste();
        break;
      case 'openPath':
        if (selection) executeOpenPath(selection);
        break;
      case 'openFile':
        if (selection) executeOpenFile(selection);
        break;
      case 'saveQuickCommand':
        if (selection) executeSaveQuickCommand(selection);
        break;
    }
    showContextMenu.value = false;
  };

  const addContextMenuListener = () => {
    if (deps.containerRef.value) {
      deps.containerRef.value.addEventListener('contextmenu', handleContextMenu);
    }
  };

  const removeContextMenuListener = () => {
    if (deps.containerRef.value) {
      deps.containerRef.value.removeEventListener('contextmenu', handleContextMenu);
    }
  };

  return {
    showContextMenu,
    contextMenuPosition,
    contextMenuSelectedText,
    handleContextMenu,
    handleContextMenuAction,
    addContextMenuListener,
    removeContextMenuListener,
  };
}
