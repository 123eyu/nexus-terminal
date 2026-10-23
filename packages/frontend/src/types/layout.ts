/**
 * 布局领域类型（从 layout.store.ts 抽出，供纯函数模块与测试复用）。
 *
 * layout.store 会把这些类型重新导出，因此既有 `import type { LayoutNode } from '../stores/layout.store'`
 * 仍然有效，不需要改调用方。
 */

/** 所有可用面板的名称 */
export type PaneName =
  | 'connections'
  | 'terminal'
  | 'commandBar'
  | 'fileManager'
  | 'editor'
  | 'statusMonitor'
  | 'commandHistory'
  | 'quickCommands'
  | 'dockerManager'
  | 'suspendedSshSessions'
  | 'multiLineCommandInput'
  /** 端口转发：仅桌面端、且只能停靠在侧栏 */
  | 'portForward';

/** 终端自动执行指令配置 */
export interface TerminalAutoExecConfig {
  defaultCommand?: string;
  connectionCommands?: Record<string, string>;
}

/** 终端窗格专属背景配置 */
export interface TerminalPaneBackgroundConfig {
  mode?: 'inherit' | 'transparent' | 'none' | 'custom';
  customImage?: string;
  overlayOpacity?: number;
}

/** 布局节点（容器或面板） */
export interface LayoutNode {
  id: string;
  type: 'pane' | 'container';
  component?: PaneName;
  direction?: 'horizontal' | 'vertical';
  children?: LayoutNode[];
  size?: number;
  terminalAutoExec?: TerminalAutoExecConfig;
  terminalBackground?: TerminalPaneBackgroundConfig;
}

/** 布局预设 */
export interface LayoutPreset {
  id: string;
  name: string;
  isDefault?: boolean;
  isSystem?: boolean;
  layoutTree: LayoutNode;
  sidebarPanes: { left: PaneName[]; right: PaneName[] };
  /** 本地数据库自增 ID，跨端无意义，仅作本机缓存 */
  connectionIds?: number[];
  /** 跨端稳定的连接绑定（权威来源） */
  connectionUuids?: string[];
  createdAt?: number;
  updatedAt?: number;
}
