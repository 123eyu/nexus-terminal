import { useSettingsStore, type TerminalRightClickBehavior, type TerminalContextMenuSettings, DEFAULT_TERMINAL_CONTEXT_MENU_ITEMS } from '../../stores/settings.store';
import { useI18n } from 'vue-i18n';
import {
  useBooleanSettingControl,
  useNumberSettingControl,
  useSettingControl,
  useStringSettingControl,
} from './useSettingControl';

/**
 * 「工作区」设置页用到的全部设置项。
 *
 * 每个设置项的实现都收敛到 useSettingControl：
 * 以前这里是一个设置项 20 行（4 个 ref + handler + watch + 4 个 return），
 * 20 个设置项 = 400 行纯样板，且漏写 watch 会让"其它端改了值这边不刷新"。
 *
 * 对外暴露的字段名保持原样，模板不需要改动。
 */
export function useWorkspaceSettings() {
  const settingsStore = useSettingsStore();
  const { t } = useI18n();

  // --- Markdown 默认视图模式（桌面端 / 移动端）---
  const markdownDefaultViewMode = useStringSettingControl({
    key: 'markdownDefaultViewMode',
    defaultValue: 'split',
    successMessage: () => t('common.saved'),
    errorMessage: () => t('common.saveFailed'),
  });

  const markdownDefaultViewModeMobile = useStringSettingControl({
    key: 'markdownDefaultViewModeMobile',
    defaultValue: 'preview',
    successMessage: () => t('common.saved'),
    errorMessage: () => t('common.saveFailed'),
  });

  // --- 弹窗编辑器 / 弹窗文件管理器 / 共享编辑器标签页 ---
  const popupEditor = useBooleanSettingControl({
    key: 'showPopupFileEditor',
    defaultValue: true,
    successMessage: () => t('settings.popupEditor.success.saved'),
    errorMessage: () => t('settings.popupEditor.error.saveFailed'),
  });

  const shareTabs = useBooleanSettingControl({
    key: 'shareFileEditorTabs',
    defaultValue: true,
    successMessage: () => t('settings.shareEditorTabs.success.saved'),
    errorMessage: () => t('settings.shareEditorTabs.error.saveFailed'),
  });

  const showPopupFileManager = useBooleanSettingControl({
    key: 'showPopupFileManager',
    defaultValue: false,
    successMessage: () => t('settings.popupFileManager.success.saved'),
    errorMessage: () => t('settings.popupFileManager.error.saveFailed'),
  });

  // --- 终端选中自动复制 ---
  const autoCopy = useBooleanSettingControl({
    key: 'autoCopyOnSelect',
    defaultValue: false,
    successMessage: () => t('settings.autoCopyOnSelect.success.saved'),
    errorMessage: () => t('settings.autoCopyOnSelect.error.saveFailed'),
  });

  // --- 工作区侧边栏固定 ---
  const workspaceSidebarPersistent = useBooleanSettingControl({
    key: 'workspaceSidebarPersistent',
    defaultValue: false,
    successMessage: () => t('settings.workspace.success.sidebarPersistentSaved'),
    errorMessage: () => t('settings.workspace.error.sidebarPersistentSaveFailed'),
  });

  // --- 命令输入同步目标 ---
  const commandInputSyncTarget = useStringSettingControl({
    key: 'commandInputSyncTarget',
    defaultValue: 'none',
    successMessage: () => t('settings.commandInputSync.success.saved', '同步目标已保存'),
    errorMessage: () => t('settings.commandInputSync.error.saveFailed', '保存同步目标失败'),
  });

  // --- 标签显示（有专用接口，需要传原生 boolean）---
  const showConnectionTags = useBooleanSettingControl({
    key: 'showConnectionTags',
    defaultValue: true,
    nativeBoolean: true,
    successMessage: () => t('settings.workspace.success.showConnectionTagsSaved', '连接标签显示设置已保存'),
    errorMessage: () => t('settings.workspace.error.showConnectionTagsSaveFailed', '保存连接标签显示设置失败'),
  });

  const showQuickCommandTags = useBooleanSettingControl({
    key: 'showQuickCommandTags',
    defaultValue: true,
    nativeBoolean: true,
    successMessage: () => t('settings.workspace.success.showQuickCommandTagsSaved', '快捷指令标签显示设置已保存'),
    errorMessage: () => t('settings.workspace.error.showQuickCommandTagsSaveFailed', '保存快捷指令标签显示设置失败'),
  });

  // --- 终端回滚行数（0 = 不限制，空值回落 5000）---
  const terminalScrollbackLimit = useNumberSettingControl({
    key: 'terminalScrollbackLimit',
    defaultValue: 5000,
    validate: (value) => {
      if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 0)) {
        throw new Error(t('settings.terminalScrollback.error.invalidInput', '请输入一个有效的非负整数。'));
      }
    },
    serialize: (value) => (value === null || value === undefined ? '5000' : String(value)),
    successMessage: () => t('settings.terminalScrollback.success.saved', '终端回滚行数设置已保存。'),
    errorMessage: () => t('settings.terminalScrollback.error.saveFailed', '保存终端回滚行数设置失败。'),
  });

  // --- 文件管理器 ---
  const fileManagerShowDeleteConfirmation = useBooleanSettingControl({
    key: 'fileManagerShowDeleteConfirmation',
    defaultValue: true,
    successMessage: () => t('settings.workspace.fileManagerDeleteConfirmSuccess', '文件管理器删除确认设置已保存。'),
    errorMessage: () => t('settings.workspace.fileManagerDeleteConfirmError', '保存文件管理器删除确认设置失败。'),
  });

  const fileManagerDoubleClickToOpen = useBooleanSettingControl({
    key: 'fileManagerDoubleClickToOpen',
    defaultValue: false,
    successMessage: () => t('settings.workspace.fileManagerDoubleClickToOpenSuccess', '双击打开文件/文件夹设置已保存。'),
    errorMessage: () => t('settings.workspace.fileManagerDoubleClickToOpenError', '保存双击打开文件/文件夹设置失败。'),
  });

  const fileManagerHighlightChanges = useBooleanSettingControl({
    key: 'fileManagerHighlightChanges',
    defaultValue: true,
    successMessage: () => t('settings.workspace.fileManagerHighlightChangesSuccess', '文件列表变动高亮设置已保存。'),
    errorMessage: () => t('settings.workspace.fileManagerHighlightChangesError', '保存文件列表变动高亮设置失败。'),
  });

  // --- 终端 ---
  const terminalNoWrap = useBooleanSettingControl({
    key: 'terminalNoWrap',
    defaultValue: false,
    successMessage: () => t('settings.workspace.terminalNoWrapSuccess', '终端不换行设置已保存。'),
    errorMessage: () => t('settings.workspace.terminalNoWrapError', '保存终端不换行设置失败。'),
  });

  const terminalEnableRightClickPaste = useBooleanSettingControl({
    key: 'terminalEnableRightClickPaste',
    defaultValue: true,
    successMessage: () => t('settings.workspace.terminalRightClickPasteSuccess', '终端右键粘贴设置已保存。'),
    errorMessage: () => t('settings.workspace.terminalRightClickPasteError', '保存终端右键粘贴设置失败。'),
  });

  const terminalSwitchPaneShortcut = useSettingControl<string>({
    key: 'terminalSwitchPaneShortcut',
    defaultValue: 'Alt+`',
    parse: (raw) => raw,
    // 空串回落默认键位，避免用户清空后无法切分屏
    validate: (value) => {
      if (!value || !value.trim()) {
        throw new Error(t('settings.workspace.terminalSwitchPaneShortcutError', '保存分屏终端切换快捷键失败。'));
      }
    },
    persist: async (value) => {
      const normalized = value.trim() || 'Alt+`';
      terminalSwitchPaneShortcut.local.value = normalized;
      await settingsStore.updateTerminalSwitchPaneShortcut(normalized);
    },
    clearMessageAfterMs: 3000,
    successMessage: () => t('settings.workspace.terminalSwitchPaneShortcutSuccess', '分屏终端切换快捷键已保存。'),
    errorMessage: () => t('settings.workspace.terminalSwitchPaneShortcutError', '保存分屏终端切换快捷键失败。'),
  });

  const terminalRightClickBehavior = useSettingControl<TerminalRightClickBehavior>({
    key: 'terminalRightClickBehavior',
    defaultValue: 'contextMenu',
    parse: (raw) => raw as TerminalRightClickBehavior,
    persist: (value) => settingsStore.updateTerminalRightClickBehavior(value),
    successMessage: () => t('common.saved', '已保存'),
    errorMessage: () => t('common.saveFailed', '保存失败'),
  });

  const terminalContextMenuItems = useSettingControl<TerminalContextMenuSettings>({
    key: 'terminalContextMenuItems',
    defaultValue: { ...DEFAULT_TERMINAL_CONTEXT_MENU_ITEMS },
    parse: (raw) => {
      try {
        const parsed = JSON.parse(raw);
        return {
          copy: parsed.copy !== false,
          paste: parsed.paste !== false,
          openPath: parsed.openPath !== false,
          openFile: parsed.openFile !== false,
          saveQuickCommand: parsed.saveQuickCommand !== false,
        };
      } catch {
        return { ...DEFAULT_TERMINAL_CONTEXT_MENU_ITEMS };
      }
    },
    persist: (value) => settingsStore.updateTerminalContextMenuItems(value),
    successMessage: () => t('common.saved', '已保存'),
    errorMessage: () => t('common.saveFailed', '保存失败'),
  });

  // --- 状态监视器显示 IP ---
  const statusMonitorShowIp = useBooleanSettingControl({
    key: 'showStatusMonitorIpAddress',
    defaultValue: false,
    successMessage: () => t('common.saved'),
    errorMessage: () => t('settings.statusMonitorShowIp.error.saveFailed', 'Failed to save status monitor IP display setting.'),
  });

  return {
    // 兼容原有模板的字段名
    popupEditorEnabled: popupEditor.local,
    popupEditorLoading: popupEditor.loading,
    popupEditorMessage: popupEditor.message,
    popupEditorSuccess: popupEditor.success,
    handleUpdatePopupEditorSetting: popupEditor.save,

    shareTabsEnabled: shareTabs.local,
    shareTabsLoading: shareTabs.loading,
    shareTabsMessage: shareTabs.message,
    shareTabsSuccess: shareTabs.success,
    handleUpdateShareTabsSetting: shareTabs.save,

    autoCopyEnabled: autoCopy.local,
    autoCopyLoading: autoCopy.loading,
    autoCopyMessage: autoCopy.message,
    autoCopySuccess: autoCopy.success,
    handleUpdateAutoCopySetting: autoCopy.save,

    workspaceSidebarPersistentEnabled: workspaceSidebarPersistent.local,
    workspaceSidebarPersistentLoading: workspaceSidebarPersistent.loading,
    workspaceSidebarPersistentMessage: workspaceSidebarPersistent.message,
    workspaceSidebarPersistentSuccess: workspaceSidebarPersistent.success,
    handleUpdateWorkspaceSidebarSetting: workspaceSidebarPersistent.save,

    commandInputSyncTargetLocal: commandInputSyncTarget.local,
    commandInputSyncLoading: commandInputSyncTarget.loading,
    commandInputSyncMessage: commandInputSyncTarget.message,
    commandInputSyncSuccess: commandInputSyncTarget.success,
    handleUpdateCommandInputSyncTarget: commandInputSyncTarget.save,

    showConnectionTagsLocal: showConnectionTags.local,
    showConnectionTagsLoading: showConnectionTags.loading,
    showConnectionTagsMessage: showConnectionTags.message,
    showConnectionTagsSuccess: showConnectionTags.success,
    handleUpdateShowConnectionTags: showConnectionTags.save,

    showQuickCommandTagsLocal: showQuickCommandTags.local,
    showQuickCommandTagsLoading: showQuickCommandTags.loading,
    showQuickCommandTagsMessage: showQuickCommandTags.message,
    showQuickCommandTagsSuccess: showQuickCommandTags.success,
    handleUpdateShowQuickCommandTags: showQuickCommandTags.save,

    terminalScrollbackLimitLocal: terminalScrollbackLimit.local,
    terminalScrollbackLimitLoading: terminalScrollbackLimit.loading,
    terminalScrollbackLimitMessage: terminalScrollbackLimit.message,
    terminalScrollbackLimitSuccess: terminalScrollbackLimit.success,
    handleUpdateTerminalScrollbackLimit: terminalScrollbackLimit.save,

    fileManagerShowDeleteConfirmationLocal: fileManagerShowDeleteConfirmation.local,
    fileManagerShowDeleteConfirmationLoading: fileManagerShowDeleteConfirmation.loading,
    fileManagerShowDeleteConfirmationMessage: fileManagerShowDeleteConfirmation.message,
    fileManagerShowDeleteConfirmationSuccess: fileManagerShowDeleteConfirmation.success,
    handleUpdateFileManagerDeleteConfirmation: fileManagerShowDeleteConfirmation.save,

    fileManagerDoubleClickToOpenLocal: fileManagerDoubleClickToOpen.local,
    fileManagerDoubleClickToOpenLoading: fileManagerDoubleClickToOpen.loading,
    fileManagerDoubleClickToOpenMessage: fileManagerDoubleClickToOpen.message,
    fileManagerDoubleClickToOpenSuccess: fileManagerDoubleClickToOpen.success,
    handleUpdateFileManagerDoubleClickToOpen: fileManagerDoubleClickToOpen.save,

    fileManagerHighlightChangesLocal: fileManagerHighlightChanges.local,
    fileManagerHighlightChangesLoading: fileManagerHighlightChanges.loading,
    fileManagerHighlightChangesMessage: fileManagerHighlightChanges.message,
    fileManagerHighlightChangesSuccess: fileManagerHighlightChanges.success,
    handleUpdateFileManagerHighlightChanges: fileManagerHighlightChanges.save,

    terminalEnableRightClickPasteLocal: terminalEnableRightClickPaste.local,
    terminalEnableRightClickPasteLoading: terminalEnableRightClickPaste.loading,
    terminalEnableRightClickPasteMessage: terminalEnableRightClickPaste.message,
    terminalEnableRightClickPasteSuccess: terminalEnableRightClickPaste.success,
    handleUpdateTerminalRightClickPasteSetting: terminalEnableRightClickPaste.save,

    terminalRightClickBehaviorLocal: terminalRightClickBehavior.local,
    terminalRightClickBehaviorLoading: terminalRightClickBehavior.loading,
    terminalRightClickBehaviorMessage: terminalRightClickBehavior.message,
    terminalRightClickBehaviorSuccess: terminalRightClickBehavior.success,
    handleUpdateTerminalRightClickBehavior: terminalRightClickBehavior.save,

    terminalContextMenuItemsLocal: terminalContextMenuItems.local,
    terminalContextMenuItemsLoading: terminalContextMenuItems.loading,
    terminalContextMenuItemsMessage: terminalContextMenuItems.message,
    terminalContextMenuItemsSuccess: terminalContextMenuItems.success,
    handleUpdateTerminalContextMenuItems: terminalContextMenuItems.save,

    terminalNoWrapLocal: terminalNoWrap.local,
    terminalNoWrapLoading: terminalNoWrap.loading,
    terminalNoWrapMessage: terminalNoWrap.message,
    terminalNoWrapSuccess: terminalNoWrap.success,
    handleUpdateTerminalNoWrapSetting: terminalNoWrap.save,

    terminalSwitchPaneShortcutLocal: terminalSwitchPaneShortcut.local,
    terminalSwitchPaneShortcutLoading: terminalSwitchPaneShortcut.loading,
    terminalSwitchPaneShortcutMessage: terminalSwitchPaneShortcut.message,
    terminalSwitchPaneShortcutSuccess: terminalSwitchPaneShortcut.success,
    handleUpdateTerminalSwitchPaneShortcut: terminalSwitchPaneShortcut.save,

    showPopupFileManagerLocal: showPopupFileManager.local,
    showPopupFileManagerLoading: showPopupFileManager.loading,
    showPopupFileManagerMessage: showPopupFileManager.message,
    showPopupFileManagerSuccess: showPopupFileManager.success,
    handleUpdateShowPopupFileManager: showPopupFileManager.save,

    statusMonitorShowIpEnabled: statusMonitorShowIp.local,
    statusMonitorShowIpLoading: statusMonitorShowIp.loading,
    statusMonitorShowIpMessage: statusMonitorShowIp.message,
    statusMonitorShowIpSuccess: statusMonitorShowIp.success,
    handleUpdateStatusMonitorShowIpSetting: statusMonitorShowIp.save,

    markdownDefaultViewModeLocal: markdownDefaultViewMode.local,
    markdownDefaultViewModeLoading: markdownDefaultViewMode.loading,
    markdownDefaultViewModeMessage: markdownDefaultViewMode.message,
    markdownDefaultViewModeSuccess: markdownDefaultViewMode.success,
    handleUpdateMarkdownDefaultViewMode: markdownDefaultViewMode.save,

    markdownDefaultViewModeMobileLocal: markdownDefaultViewModeMobile.local,
    markdownDefaultViewModeMobileLoading: markdownDefaultViewModeMobile.loading,
    markdownDefaultViewModeMobileMessage: markdownDefaultViewModeMobile.message,
    markdownDefaultViewModeMobileSuccess: markdownDefaultViewModeMobile.success,
    handleUpdateMarkdownDefaultViewModeMobile: markdownDefaultViewModeMobile.save,
  };
}
