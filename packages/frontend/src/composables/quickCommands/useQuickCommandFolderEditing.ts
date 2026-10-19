import { ref, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuickCommandsStore, type GroupedQuickCommands } from '../../stores/quickCommands.store';
import { useQuickCommandTagsStore } from '../../stores/quickCommandTags.store';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';

/**
 * 快捷指令文件夹（标签）的「就地改名 / 新建」逻辑。
 *
 * 这段在桌面版和移动版里是逐字相同的 92 行，改一处必须记得改另一处 ——
 * 而且它有两个坑，注释里标出来免得后人再踩：
 *
 * 1. `editingTagId === 'untagged'` 不是"什么都不做"，而是"把未标记分组的命令
 *    全部挂到新建的标签下"。空名字直接取消，不会建一个空标签。
 * 2. `expandedGroups` 的 key 是**分组名**而不是 id，所以改名之后必须把
 *    展开状态从旧 key 搬到新 key，否则改名后分组会突然折叠。
 */
export interface QuickCommandFolderEditingDeps {
  /** 当前筛选/分组后的命令（来自 quickCommandsStore.filteredAndGroupedCommands） */
  groupedCommands: Ref<GroupedQuickCommands[]>;
  /** 分组展开状态，key 是分组名（不是 tagId） */
  expandedGroups: Ref<Record<string, boolean>>;
}

export function useQuickCommandFolderEditing(deps: QuickCommandFolderEditingDeps) {
  const quickCommandsStore = useQuickCommandsStore();
  const quickCommandTagsStore = useQuickCommandTagsStore();
  const uiNotificationsStore = useUiNotificationsStore();
  const { t } = useI18n();

  const editingTagId = ref<number | null | 'untagged'>(null);
  const editedTagName = ref('');

  const startEditingTag = (tagId: number | null, currentName: string) => {
    editingTagId.value = tagId === null ? 'untagged' : tagId;
    editedTagName.value = tagId === null ? '' : currentName; // "未标记"分组从空输入开始
  };

  const cancelEditingTag = () => {
    editingTagId.value = null;
  };

  async function finishEditingTag() {
    const currentEditingId = editingTagId.value;
    const newName = editedTagName.value.trim();
    const originalGroup = deps.groupedCommands.value.find((g) => g.tagId === currentEditingId);

    // 空名字一律取消（包括"未标记"分组，避免建出空标签）
    if (newName === '') {
      cancelEditingTag();
      return;
    }

    try {
      if (currentEditingId === 'untagged') {
        // --- 新建标签，并把"未标记"分组里的命令全部挂过去 ---
        const newTag = await quickCommandTagsStore.addTag(newName);
        if (newTag) {
          uiNotificationsStore.showSuccess(t('quickCommands.tags.createSuccess'));
          const untaggedGroup = deps.groupedCommands.value.find((g) => g.tagId === null);
          const commandIdsToAssign = untaggedGroup ? untaggedGroup.commands.map((c) => c.id) : [];

          if (commandIdsToAssign.length > 0) {
            // 成功/失败提示与列表刷新由 store action 内部处理
            await quickCommandsStore.assignCommandsToTagAction(commandIdsToAssign, newTag.id);
          } else {
            uiNotificationsStore.showInfo(t('quickCommands.tags.noCommandsToAssign'));
          }

          // 展开状态按分组名存，改名的同时要把状态搬过去
          const untaggedGroupName = t('quickCommands.untagged', '未标记');
          if (deps.expandedGroups.value[untaggedGroupName] !== undefined) {
            const currentState = deps.expandedGroups.value[untaggedGroupName];
            delete deps.expandedGroups.value[untaggedGroupName];
            deps.expandedGroups.value[newName] = currentState;
          }
        }
        // addTag 的失败提示由 store 内部弹出
        return;
      }

      if (typeof currentEditingId === 'number') {
        // --- 重命名已有标签 ---
        const originalTagName = originalGroup?.groupName;
        if (!originalTagName) {
          console.error(`[QuickCmdView] Cannot find original group name for tag ID ${currentEditingId}`);
          cancelEditingTag();
          return;
        }
        if (originalTagName === newName) {
          return; // 没有变化
        }

        const updateResult = await quickCommandTagsStore.updateTag(currentEditingId, newName);
        if (updateResult) {
          if (deps.expandedGroups.value[originalTagName] !== undefined) {
            const currentState = deps.expandedGroups.value[originalTagName];
            delete deps.expandedGroups.value[originalTagName];
            deps.expandedGroups.value[newName] = currentState;
          }
          // 名字可能与其他分组撞车，重新拉一次让分组结果与服务端一致
          await quickCommandsStore.fetchQuickCommands();
        }
      }
    } catch (error: any) {
      console.error('[QuickCmdView] Error during finishEditingTag:', error);
      uiNotificationsStore.showError(t('common.unexpectedError'));
    } finally {
      editingTagId.value = null; // 无论成功失败都退出编辑态
    }
  }

  return {
    editingTagId,
    editedTagName,
    startEditingTag,
    cancelEditingTag,
    finishEditingTag,
  };
}
