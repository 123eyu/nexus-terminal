// packages/frontend/src/composables/workspaceEvents.ts
import mitt from 'mitt';
import type { ConnectionInfo } from '../stores/connections.store';
import type { Terminal as XtermTerminal } from 'xterm';

// 定义事件载荷类型
export type WorkspaceEventPayloads = {
  // Terminal Events
  'terminal:input': { sessionId: string; data: string; paneId?: string };
  'terminal:resize': { sessionId: string; dims: { cols: number; rows: number }; paneId?: string };
  'terminal:ready': { sessionId: string; terminal: XtermTerminal; searchAddon: any; serializeAddon?: any; paneId?: string };
  'terminal:dispose': { sessionId: string; paneId?: string };
  'terminal:sendCommand': { command: string; sessionId?: string; paneId?: string }; // sessionId/paneId 可选，用于指定目标
  'terminal:clear': void; // sessionId 可选，默认为 active
  'terminal:scrollToBottomRequest': { sessionId: string; paneId?: string };
  'terminal:stabilizedResize': { sessionId: string; width: number; height: number; paneId?: string }; // 用于传递稳定后的尺寸
  'terminal:cwdChanged': { sessionId: string; cwd: string; paneId?: string }; // 终端当前工作目录变更事件


  // Editor Events
  'editor:closeTab': { tabId: string };
  'editor:activateTab': { tabId: string };
  'editor:updateContent': { tabId: string; content: string };
  'editor:saveTab': { tabId: string };
  'editor:changeEncoding': { tabId: string; encoding: string };
  'editor:closeOtherTabs': { tabId: string };
  'editor:closeTabsToRight': { tabId: string };
  'editor:closeTabsToLeft': { tabId: string };
  'editor:updateScrollPosition': { tabId: string; scrollTop: number; scrollLeft: number };
 
  // Connection Events
  'connection:connect': { connectionId: number }; // 来自 WorkspaceConnectionList 或其他地方
  'connection:openNewSession': { connectionId: number }; // 来自 WorkspaceConnectionList
  'connection:requestAdd': void; // 来自 WorkspaceConnectionList 或 TerminalTabBar
  'connection:requestEdit': { connectionInfo: ConnectionInfo }; // 来自 WorkspaceConnectionList 或 TerminalTabBar

  // Search Events (主要由 CommandInputBar 或 PaneTitleBar 发出)
  /** options 带上来后，终端才能按"正则/整词/大小写"扫描滚动条标记 */
  'search:start': {
    term: string;
    sessionId?: string;
    options?: { regex?: boolean; wholeWord?: boolean; caseSensitive?: boolean };
  }; // sessionId 可选，用于指定搜索目标终端
  'search:findNext': void;
  'search:findPrevious': void;
  'search:close': void;
  /** 终端回报搜索结果（index 为 -1 表示无匹配或超出高亮上限） */
  'search:results': { sessionId?: string; paneId?: string; index: number; count: number };
  /** 终端扫描完 buffer 后广播命中行号，供滚动条画标记（totalLines 用于换算比例） */
  'search:markers': {
    sessionId?: string;
    paneId?: string;
    matchLines: number[];
    totalLines: number;
    /** 当前聚焦的匹配序号（-1 表示没有命中） */
    index?: number;
  };

  // Session Management Events (主要由 TerminalTabBar 发出)
  'session:activate': { sessionId: string };
  'session:close': { sessionId: string };
  'session:closeOthers': { targetSessionId: string };
  'session:closeToRight': { targetSessionId: string };
  'session:closeToLeft': { targetSessionId: string };
  /** 只断开通道、保留标签：SSH 由 WorkspaceView 处理，RDP/VNC 由 RemoteSessionPane 自己处理 */
  'session:disconnect': { sessionId: string };
  /** 重新连接已断开的会话，同样是 SSH / 远程桌面各自响应 */
  'session:reconnect': { sessionId: string };

  // UI Interaction Events
  'ui:openLayoutConfigurator': void;
'ui:openTransferProgressModal': void; // 请求打开文件传输进度模态框
  // 'ui:toggleVirtualKeyboard': void; // 如果决定迁移 CommandInputBar 的这个事件
  'fileManager:openModalRequest': { sessionId: string }; // 请求打开文件管理器模态框
  'fileManager:itemsMoved': { sessionId: string; sourceDir: string; targetDir: string }; // 跨窗格/内部文件移动完成通知
  'fileManager:navigateToPath': { path: string; sessionId?: string; instanceId?: string }; // 在布局中文件管理器中导航到指定路径 (支持指定 instanceId)
  'fileManager:setDirectoryTreeVisible': { instanceId: string; show: boolean }; // 同一组件实例多会话同步目录树显隐
  'fileManager:setViewMode': { instanceId: string; viewMode: 'list' | 'tile' }; // 同一组件实例多会话同步视图模式
  'fileManager:setDirectoryTreeWidth': { instanceId: string; width: number }; // 同一组件实例多会话同步目录树宽度

  // Suspended SSH Session Events
  'suspendedSession:actionCompleted': void; // Emitted when a resume/remove action is completed

  // Quick Command Events
  'quickCommand:executeProcessed': { command: string; sessionId?: string };
  'quickCommand:requestAdd': { initialCommand?: string }; // 请求打开添加快捷指令表单并填入初始内容

  // Command Input Fill Event (供历史记录/快捷指令等填入命令行或多行输入框)
  'commandInput:fill': { command: string };

  // Workspace Sync & Mutual Exclusion Events
  'workspace:takeoverKickout': { activeClientId: string };
  'workspace:requestStateSave': void;
};

// 创建 mitt 事件发射器实例
export const workspaceEmitter = mitt<WorkspaceEventPayloads>();

/**
 * Composable to get the workspace event emitter function.
 * @returns The emit function from the mitt instance.
 */
export function useWorkspaceEventEmitter() {
  return workspaceEmitter.emit;
}

/**
 * Composable to get the workspace event subscriber function.
 * @returns The 'on' function from the mitt instance for subscribing to events.
 */
export function useWorkspaceEventSubscriber() {
  return workspaceEmitter.on;
}

/**
 * Composable to get the workspace event unsubscriber function.
 * @returns The 'off' function from the mitt instance for unsubscribing from events.
 */
export function useWorkspaceEventOff() {
  return workspaceEmitter.off;
}