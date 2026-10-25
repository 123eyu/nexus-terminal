import { ref, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuickCommandsStore, type GroupedQuickCommands } from '../../stores/quickCommands.store';
import { useQuickCommandFoldersStore } from '../../stores/quickCommandFolders.store';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';

/**
 * 快捷指令文件夹（标签）的「就地改名 / 新建」逻辑。
 *
 * 这段在桌面版和移动版里是逐字相同的 92 行，改一处必须记得改另一处 ——
 * 而且它有两个坑，注释里标出来免得后人再踩：
 *
 * 1. `editingFolderId === 'untagged'` 不是"什么都不做"，而是"把未标记分组的命令
 *    全部挂到新建的标签下"。空名字直接取消，不会建一个空标签。
 * 2. `expandedGroups` 的 key 是**分组名**而不是 id，所以改名之后必须把
 *    展开状态从旧 key 搬到新 key，否则改名后分组会突然折叠。
 */
export interface QuickCommandFolderEditingDeps {
  /** 当前筛选/分组后的命令（来自 quickCommandsStore.filteredAndGroupedCommands） */
  groupedCommands: Ref<GroupedQuickCommands[]>;
  /** 分组展开状态，key 是分组名（不是 folderId） */
  expandedGroups: Ref<Record<string, boolean>>;
  /** 新建成功后的附加动作（桌面侧栏需要切到新文件夹） */
  onFolderCreated?: (folderId: number) => void;
  /** 删除成功后的附加动作（桌面侧栏需要把选中项回退到 'all'） */
  onFolderDeleted?: (folderId: number) => void;
}

export function useQuickCommandFolderEditing(deps: QuickCommandFolderEditingDeps) {
  const quickCommandsStore = useQuickCommandsStore();
  const quickCommandFoldersStore = useQuickCommandFoldersStore();
  const uiNotificationsStore = useUiNotificationsStore();
  const { t } = useI18n();

  const editingFolderId = ref<number | null | 'untagged'>(null);
  const editedFolderName = ref('');

  // 新建文件夹
  const isCreatingFolderModal = ref(false);
  const newQuickCommandFolderName = ref('');

  // 删除文件夹
  const showDeleteFolderModal = ref(false);
  const folderToDelete = ref<{ id: number; name: string } | null>(null);
  const isDeletingFolder = ref(false);

  const startEditingFolder = (folderId: number | null, currentName: string) => {
    editingFolderId.value = folderId === null ? 'untagged' : folderId;
    editedFolderName.value = folderId === null ? '' : currentName; // "未标记"分组从空输入开始
  };

  const cancelEditingFolder = () => {
    editingFolderId.value = null;
  };

  async function finishEditingFolder() {
    const currentEditingId = editingFolderId.value;
    const newName = editedFolderName.value.trim();
    const originalGroup = deps.groupedCommands.value.find((g) => g.folderId === currentEditingId);

    // 空名字一律取消（包括"未标记"分组，避免建出空标签）
    if (newName === '') {
      cancelEditingFolder();
      return;
    }

    try {
      if (currentEditingId === 'untagged') {
        // --- 新建标签，并把"未标记"分组里的命令全部挂过去 ---
        const newFolder = await quickCommandFoldersStore.addFolder(newName);
        if (newFolder) {
          // 成功提示由 store 统一弹（这里再弹一次会出现「文件夹已创建」+ 别的两条通知）
          const untaggedGroup = deps.groupedCommands.value.find((g) => g.folderId === null);
          const commandIdsToAssign = untaggedGroup ? untaggedGroup.commands.map((c) => c.id) : [];

          if (commandIdsToAssign.length > 0) {
            // 成功/失败提示与列表刷新由 store action 内部处理
            await quickCommandsStore.assignCommandsToFolderAction(commandIdsToAssign, newFolder.id);
          } else {
            uiNotificationsStore.showInfo(t('quickCommands.folders.noCommandsToAssign'));
          }

          // 展开状态按分组名存，改名的同时要把状态搬过去
          const untaggedGroupName = t('quickCommands.untagged', '未分类');
          if (deps.expandedGroups.value[untaggedGroupName] !== undefined) {
            const currentState = deps.expandedGroups.value[untaggedGroupName];
            delete deps.expandedGroups.value[untaggedGroupName];
            deps.expandedGroups.value[newName] = currentState;
          }
        }
        // addFolder 的失败提示由 store 内部弹出
        return;
      }

      if (typeof currentEditingId === 'number') {
        // --- 重命名已有标签 ---
        const originalFolderName = originalGroup?.groupName;
        if (!originalFolderName) {
          console.error(`[QuickCmdView] Cannot find original group name for folder ID ${currentEditingId}`);
          cancelEditingFolder();
          return;
        }
        if (originalFolderName === newName) {
          return; // 没有变化
        }

        const updateResult = await quickCommandFoldersStore.updateFolder(currentEditingId, newName);
        if (updateResult) {
          if (deps.expandedGroups.value[originalFolderName] !== undefined) {
            const currentState = deps.expandedGroups.value[originalFolderName];
            delete deps.expandedGroups.value[originalFolderName];
            deps.expandedGroups.value[newName] = currentState;
          }
          // 名字可能与其他分组撞车，重新拉一次让分组结果与服务端一致
          await quickCommandsStore.fetchQuickCommands();
        }
      }
    } catch (error: any) {
      console.error('[QuickCmdView] Error during finishEditingFolder:', error);
      uiNotificationsStore.showError(t('common.unexpectedError'));
    } finally {
      editingFolderId.value = null; // 无论成功失败都退出编辑态
    }
  }

  /** 新建文件夹（来自输入框弹窗） */
  async function confirmCreateFolder() {
    const name = newQuickCommandFolderName.value.trim();
    if (!name) return;
    try {
      const created = await quickCommandFoldersStore.createFolder(name);
      if (created) {
        await quickCommandFoldersStore.fetchFolders();
        await quickCommandsStore.fetchQuickCommands();
        deps.onFolderCreated?.(created.id);
        isCreatingFolderModal.value = false;
        newQuickCommandFolderName.value = '';
      }
    } catch (error: any) {
      uiNotificationsStore.showError(error?.message || t('common.unexpectedError'));
    }
  }

  /** 打开删除确认弹窗 */
  function handleDeleteFolder(folderId: number, folderName: string, event?: Event) {
    if (event) event.stopPropagation();
    folderToDelete.value = { id: folderId, name: folderName };
    showDeleteFolderModal.value = true;
  }

  /** 确认删除（deleteCommands 决定里面的命令是删掉还是移到未标记） */
  async function confirmDeleteFolder(deleteCommands: boolean) {
    if (!folderToDelete.value) return;
    const fid = folderToDelete.value.id;
    isDeletingFolder.value = true;
    try {
      const success = await quickCommandFoldersStore.deleteFolder(fid, deleteCommands);
      if (success) {
        showDeleteFolderModal.value = false;
        folderToDelete.value = null;
        deps.onFolderDeleted?.(fid);
        await Promise.all([
          quickCommandFoldersStore.fetchFolders(),
          quickCommandsStore.fetchQuickCommands(),
        ]);
      }
    } catch (error: any) {
      uiNotificationsStore.showError(error?.message || t('common.unexpectedError'));
    } finally {
      isDeletingFolder.value = false;
    }
  }

  return {
    editingFolderId,
    editedFolderName,
    startEditingFolder,
    cancelEditingFolder,
    finishEditingFolder,
    isCreatingFolderModal,
    newQuickCommandFolderName,
    showDeleteFolderModal,
    folderToDelete,
    isDeletingFolder,
    confirmCreateFolder,
    handleDeleteFolder,
    confirmDeleteFolder,
  };
}
