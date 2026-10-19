import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileListItem } from '../../types/sftp.types';

export type FileManagerActionType = 'delete' | 'rename' | 'chmod' | 'newFile' | 'newFolder' | null;

export interface FileManagerActionModalProps {
  isVisible: boolean;
  actionType: FileManagerActionType;
  item: FileListItem | null;
  items: FileListItem[];
  initialValue: string;
}

/**
 * 文件操作确认弹窗（删除 / 重命名 / 改权限 / 新建文件 / 新建文件夹）的展示与校验逻辑。
 *
 * 桌面版和移动版曾经是两份独立的 .vue，script 部分 175 行里有 160 行逐字相同 ——
 * 改一个字（比如"权限必须 3~4 位八进制"）要记得改两遍，漏了就是两端行为不一致。
 * 现在两边共用这一份，模板各自保留（桌面是居中卡片，移动是底部弹层）。
 *
 * 三个校验细节值得留意：
 * 1. 重命名不改名字（trim 后与原名相同）时确认按钮禁用，避免无意义请求；
 * 2. chmod 必须匹配 `^[0-7]{3,4}$`，这是唯一会挡住非法权限值的地方；
 * 3. 「新建」类操作没有 item，标题/占位符必须走 fallback 文案，不能读 item.filename。
 */
export function useFileManagerActionModal(
  props: FileManagerActionModalProps,
  emit: {
    (e: 'close'): void;
    (e: 'confirm', value?: string): void;
  },
  options: { enableGlobalKeydown?: boolean } = {}
) {
  const { t } = useI18n();
  const inputValue = ref('');
  const inputRef = ref<HTMLInputElement | null>(null);

  const modalTitle = computed(() => {
    switch (props.actionType) {
      case 'delete':
        if (props.items.length > 1) {
          return t('fileManager.modals.titles.deleteMultiple', { count: props.items.length });
        } else if (props.items.length === 1) {
          return t('fileManager.modals.titles.delete', { name: props.items[0]?.filename || '' });
        } else {
          return t('fileManager.modals.titles.delete', { name: '' });
        }
      case 'rename':
        return t('fileManager.modals.titles.rename', { name: props.item?.filename || '' });
      case 'chmod':
        return t('fileManager.modals.titles.chmod', { name: props.item?.filename || '' });
      case 'newFile':
        return t('fileManager.modals.titles.newFile', '新建文件');
      case 'newFolder':
        return t('fileManager.modals.titles.newFolder', '新建文件夹');
      default:
        return '';
    }
  });

  const actionIconClass = computed(() => {
    switch (props.actionType) {
      case 'delete':
        return 'fas fa-trash-alt text-rose-500';
      case 'rename':
        return 'fas fa-signature text-amber-500';
      case 'chmod':
        return 'fas fa-key text-teal-500';
      case 'newFile':
        return 'far fa-file-alt text-primary';
      case 'newFolder':
        return 'fas fa-folder-plus text-amber-500';
      default:
        return 'fas fa-info-circle text-primary';
    }
  });

  const confirmButtonText = computed(() => {
    switch (props.actionType) {
      case 'delete':
        return t('fileManager.modals.buttons.delete', '删除');
      case 'rename':
        return t('fileManager.modals.buttons.rename', '重命名');
      case 'chmod':
        return t('fileManager.modals.buttons.changePermissions', '修改权限');
      case 'newFile':
      case 'newFolder':
        return t('fileManager.modals.buttons.create', '创建');
      default:
        return t('fileManager.modals.buttons.confirm', '确认');
    }
  });

  const messageText = computed(() => {
    if (props.actionType === 'delete') {
      if (props.items.length > 1) {
        const names = props.items.map((i) => i.filename).join(', ');
        return t('fileManager.modals.messages.confirmDeleteMultiple', {
          count: props.items.length,
          names,
        });
      } else if (props.items.length === 1 && props.items[0]) {
        const singleItem = props.items[0];
        const type = singleItem.attrs.isDirectory
          ? t('fileManager.modals.labels.folder', '文件夹')
          : t('fileManager.modals.labels.文件', '文件');
        return t('fileManager.modals.messages.confirmDelete', {
          type,
          name: singleItem.filename,
        });
      }
    }
    return '';
  });

  const showInput = computed(() =>
    ['rename', 'chmod', 'newFile', 'newFolder'].includes(props.actionType || '')
  );

  const inputLabel = computed(() => {
    switch (props.actionType) {
      case 'rename':
        return t('fileManager.modals.labels.newName', '新名称：');
      case 'chmod':
        return t('fileManager.modals.labels.newPermissions', '权限数值 (8进制)：');
      case 'newFile':
        return t('fileManager.modals.labels.fileName', '文件名：');
      case 'newFolder':
        return t('fileManager.modals.labels.folderName', '文件夹名：');
      default:
        return '';
    }
  });

  const inputPlaceholder = computed(() => {
    switch (props.actionType) {
      case 'rename':
        return props.item?.filename || t('fileManager.modals.placeholders.newName', '请输入新名称');
      case 'chmod':
        return props.initialValue || '0755';
      case 'newFile':
        return t('fileManager.modals.placeholders.newFile', '请输入文件名');
      case 'newFolder':
        return t('fileManager.modals.placeholders.newFolder', '请输入文件夹名');
      default:
        return '';
    }
  });

  const isConfirmDisabled = computed(() => {
    if (!showInput.value) return false;
    if (!inputValue.value.trim()) return true;
    if (props.actionType === 'rename' && inputValue.value.trim() === props.item?.filename) return true;
    if (props.actionType === 'chmod' && !/^[0-7]{3,4}$/.test(inputValue.value.trim())) return true;
    return false;
  });

  const closeModal = () => {
    emit('close');
  };

  const confirmAction = () => {
    if (isConfirmDisabled.value && showInput.value) return;
    if (
      props.actionType === 'chmod' &&
      inputValue.value.trim() &&
      !/^[0-7]{3,4}$/.test(inputValue.value.trim())
    ) {
      console.warn('Invalid chmod format submitted');
      return;
    }
    emit('confirm', inputValue.value.trim());
  };

  const handleGlobalKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      closeModal();
    } else if (event.key === 'Enter' && props.isVisible) {
      if (showInput.value) {
        if (!isConfirmDisabled.value) {
          confirmAction();
        }
      } else {
        confirmAction();
      }
    }
  };

  const enableKeydown = options.enableGlobalKeydown !== false;

  // 打开时回填初值并自动聚焦
  watch(
    () => props.isVisible,
    (newValue) => {
      if (newValue) {
        inputValue.value = props.initialValue || '';
        nextTick(() => {
          inputRef.value?.focus();
          inputRef.value?.select();
        });
        if (enableKeydown) document.addEventListener('keydown', handleGlobalKeydown);
      } else if (enableKeydown) {
        document.removeEventListener('keydown', handleGlobalKeydown);
      }
    }
  );

  onUnmounted(() => {
    if (enableKeydown) document.removeEventListener('keydown', handleGlobalKeydown);
  });

  return {
    inputValue,
    inputRef,
    modalTitle,
    actionIconClass,
    confirmButtonText,
    messageText,
    showInput,
    inputLabel,
    inputPlaceholder,
    isConfirmDisabled,
    closeModal,
    confirmAction,
    handleGlobalKeydown,
  };
}
