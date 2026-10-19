import { useI18n } from 'vue-i18n';
import { useSessionStore } from '../../stores/session.store';
import { useConnectionsStore } from '../../stores/connections.store';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';
import { useWorkspaceEventEmitter } from '../workspaceEvents';
import type { QuickCommandFE } from '../../stores/quickCommands.store';

export type QuickCommandMenuAction = 'execute' | 'edit' | 'copy' | 'sendToAllSessions' | 'delete';

/**
 * 快捷指令右键菜单的动作分发（桌面 / 移动共用）。
 *
 * 之所以单独抽：`sendToAllSessions` 里的"哪些会话算数"是个容易写错的判据 ——
 * 必须同时满足「连接状态是 connected」且「连接类型是 SSH」。
 * 少了后者会把 RDP/VNC 会话也算进来，命令发过去直接报错。
 * 以前这段在桌面版和移动版各有一份，改一处很容易漏另一处。
 */
export interface QuickCommandMenuActionsDeps {
  closeContextMenu: () => void;
  executeCommand: (cmd: QuickCommandFE) => void;
  openEditForm: (cmd: QuickCommandFE) => void;
  copyCommand: (command: string) => void;
  confirmDelete: (cmd: QuickCommandFE) => void;
}

export function useQuickCommandMenuActions(deps: QuickCommandMenuActionsDeps) {
  const sessionStore = useSessionStore();
  const connectionsStore = useConnectionsStore();
  const uiNotificationsStore = useUiNotificationsStore();
  const emitWorkspaceEvent = useWorkspaceEventEmitter();
  const { t } = useI18n();

  /** 可以接收命令的会话：已连接 + 连接类型为 SSH */
  function getSendableSshSessions() {
    return Array.from(sessionStore.sessions.values()).filter((s: any) => {
      if (s.wsManager?.connectionStatus?.value !== 'connected') return false;
      const connInfo = connectionsStore.connections.find((c) => c.id === Number(s.connectionId));
      return connInfo?.type === 'SSH';
    });
  }

  function handleQuickCommandMenuAction(action: QuickCommandMenuAction, command: QuickCommandFE) {
    deps.closeContextMenu();
    switch (action) {
      case 'execute':
        deps.executeCommand(command);
        break;
      case 'edit':
        deps.openEditForm(command);
        break;
      case 'copy':
        deps.copyCommand(command.command);
        break;
      case 'sendToAllSessions': {
        const sessions = getSendableSshSessions();
        if (sessions.length > 0) {
          sessions.forEach((session: any) => {
            emitWorkspaceEvent('terminal:sendCommand', {
              sessionId: session.sessionId,
              command: command.command,
            });
          });
          uiNotificationsStore.addNotification({
            message: t('quickCommands.notifications.sentToAllSessions', { count: sessions.length }),
            type: 'success',
          });
        } else {
          uiNotificationsStore.addNotification({
            message: t('quickCommands.notifications.noActiveSshSessions'),
            type: 'info',
          });
        }
        break;
      }
      case 'delete':
        deps.confirmDelete(command);
        break;
    }
  }

  return { handleQuickCommandMenuAction, getSendableSshSessions };
}
