import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFavoritePathsStore, type FavoritePathItem } from '../stores/favoritePaths.store';
import { useSessionStore } from '../stores/session.store';
import { useWorkspaceSyncStore } from '../stores/workspaceSync.store';
import { extractFolderNameFromPath } from '../utils/pathUtils';

/**
 * 「新增/编辑常用路径」表单的逻辑（桌面 / 移动共用，143 行逐字相同）。
 *
 * `activeFileManagerPath` 的三级降级值得留意：外部传入 > 活动会话的 SFTP 管理器 > 云同步兼容层。
 * 少任何一级都会出现"明明在某个目录里，点『填入当前路径』却填不出来"。
 */
export interface FavoritePathFormProps {
  isVisible: boolean;
  pathData: FavoritePathItem | null;
  pathItem: FavoritePathItem | null;
  currentPath: string;
}

export function useFavoritePathForm(
  props: FavoritePathFormProps,
  emit: {
    (e: 'close'): void;
    (e: 'saveSuccess'): void;
  }
) {
  const { t } = useI18n();
  const favoritePathsStore = useFavoritePathsStore();
  const sessionStore = useSessionStore();
  const workspaceSyncStore = useWorkspaceSyncStore();

  const form = ref({
    id: '',
    path: '',
    name: '',
  });

  const effectivePathData = computed(() => props.pathData || props.pathItem || null);
  const isEditMode = computed(() => !effectivePathData.value?.id);
  const isLoading = ref(false);
  const errorMessage = ref<string | null>(null);

  // 当前文件管理器激活的路径（三级降级）
  const activeFileManagerPath = computed<string>(() => {
    // 1. 外部显式传入优先
    if (props.currentPath && props.currentPath.trim().startsWith('/')) {
      return props.currentPath.trim();
    }
    // 2. 活动会话的 SFTP 管理器
    const activeSession = sessionStore.activeSession;
    if (activeSession?.sftpManagers) {
      for (const mgr of activeSession.sftpManagers.values()) {
        const p = mgr.currentPath?.value;
        if (p && p.trim().startsWith('/')) {
          return p.trim();
        }
      }
    }
    // 3. 云同步的兼容层路径
    const syncPath = workspaceSyncStore.fileManagerState?.currentPath;
    if (syncPath && syncPath.trim().startsWith('/')) {
      return syncPath.trim();
    }
    return '';
  });

  // 点击填入当前路径
  const fillCurrentPath = () => {
    const p = activeFileManagerPath.value;
    if (!p) return;
    form.value.path = p;
    // 用户还没填名称时，智能填入文件夹名
    if (!form.value.name.trim()) {
      form.value.name = extractFolderNameFromPath(p);
    }
    errorMessage.value = null;
  };

  watch(
    () => props.isVisible,
    (newValue) => {
      if (newValue) {
        errorMessage.value = null;
        const target = effectivePathData.value;
        if (target) {
          form.value = {
            id: target.id,
            path: target.path,
            name: target.name || '',
          };
        } else {
          form.value = { id: '', path: '', name: '' };
        }
      }
    },
    { immediate: true }
  );

  const validateForm = (): boolean => {
    if (!form.value.path.trim()) {
      errorMessage.value = t(
        'favoritePaths.addEditForm.validation.pathRequired',
        '请输入有效路径'
      );
      return false;
    }
    errorMessage.value = null;
    return true;
  };

  const handleSubmit = async () => {
    if (!validateForm()) {
      return;
    }
    isLoading.value = true;
    errorMessage.value = null;
    try {
      const finalName =
        form.value.name.trim() || extractFolderNameFromPath(form.value.path.trim());
      if (isEditMode.value && form.value.id) {
        await favoritePathsStore.updateFavoritePath(
          form.value.id,
          {
            path: form.value.path.trim(),
            name: finalName,
          },
          t
        );
      } else {
        await favoritePathsStore.addFavoritePath(
          {
            path: form.value.path.trim(),
            name: finalName,
          },
          t
        );
      }
      emit('saveSuccess');
      closeModal();
    } catch (error: any) {
      console.error('Error saving favorite path:', error);
      errorMessage.value =
        error.message ||
        t('favoritePaths.addEditForm.errors.genericSaveError', '保存常用路径失败');
    } finally {
      isLoading.value = false;
    }
  };

  const closeModal = () => {
    if (!isLoading.value) {
      emit('close');
    }
  };

  return {
    form,
    effectivePathData,
    isEditMode,
    isLoading,
    errorMessage,
    activeFileManagerPath,
    extractFolderNameFromPath,
    fillCurrentPath,
    validateForm,
    handleSubmit,
    closeModal,
  };
}
