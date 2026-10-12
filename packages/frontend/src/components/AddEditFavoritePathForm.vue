<script setup lang="ts">
import { ref, watch, computed, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFavoritePathsStore, type FavoritePathItem } from '../stores/favoritePaths.store';
import { useSessionStore } from '../stores/session.store';
import { useWorkspaceSyncStore } from '../stores/workspaceSync.store';
import MobileAddEditFavoritePathForm from './MobileAddEditFavoritePathForm.vue';

const props = defineProps({
  isVisible: {
    type: Boolean,
    required: true,
  },
  pathData: {
    type: Object as PropType<FavoritePathItem | null>,
    default: null,
  },
  pathItem: {
    type: Object as PropType<FavoritePathItem | null>,
    default: null,
  },
  currentPath: {
    type: String,
    default: '',
  },
  isMobile: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(['close', 'saveSuccess']);

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

// 获取当前文件管理器激活的当前路径
const activeFileManagerPath = computed<string>(() => {
  // 1. 若外部明确传入了 currentPath，优先采用
  if (props.currentPath && props.currentPath.trim().startsWith('/')) {
    return props.currentPath.trim();
  }
  // 2. 从当前活跃会话的 SFTP 管理器读取
  const activeSession = sessionStore.activeSession;
  if (activeSession?.sftpManagers) {
    for (const mgr of activeSession.sftpManagers.values()) {
      const p = mgr.currentPath?.value;
      if (p && p.trim().startsWith('/')) {
        return p.trim();
      }
    }
  }
  // 3. 从工作区同步 Store 获取兼容层路径
  const syncPath = workspaceSyncStore.fileManagerState?.currentPath;
  if (syncPath && syncPath.trim().startsWith('/')) {
    return syncPath.trim();
  }
  return '';
});

// 从路径提取默认文件夹名称
const extractFolderNameFromPath = (fullPath: string): string => {
  if (!fullPath || fullPath === '/') return 'root';
  const clean = fullPath.endsWith('/') ? fullPath.slice(0, -1) : fullPath;
  const lastSlash = clean.lastIndexOf('/');
  return lastSlash >= 0 ? clean.substring(lastSlash + 1) : clean;
};

// 点击填入当前路径
const fillCurrentPath = () => {
  const p = activeFileManagerPath.value;
  if (!p) return;
  form.value.path = p;
  // 若用户尚未填写名称，智能填入文件夹名字
  if (!form.value.name.trim()) {
    form.value.name = extractFolderNameFromPath(p);
  }
  errorMessage.value = null;
};

watch(() => props.isVisible, (newValue) => {
  if (newValue) {
    errorMessage.value = null;
    const target = effectivePathData.value;
    if (target) {
      form.value = { 
        id: target.id, 
        path: target.path, 
        name: target.name || '' 
      };
    } else {
      form.value = { id: '', path: '', name: '' };
    }
  }
}, { immediate: true });

const validateForm = (): boolean => {
  if (!form.value.path.trim()) {
    errorMessage.value = t('favoritePaths.addEditForm.validation.pathRequired', '请输入有效路径');
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
    if (isEditMode.value && form.value.id) {
      await favoritePathsStore.updateFavoritePath(form.value.id, {
        path: form.value.path,
        name: form.value.name || undefined,
      }, t);
    } else {
      await favoritePathsStore.addFavoritePath({
        path: form.value.path,
        name: form.value.name || undefined,
      }, t);
    }
    emit('saveSuccess');
    closeModal();
  } catch (error: any) {
    console.error('Error saving favorite path:', error);
    errorMessage.value = error.message || t('favoritePaths.addEditForm.errors.genericSaveError', '保存常用路径失败');
  } finally {
    isLoading.value = false;
  }
};

const closeModal = () => {
  if (!isLoading.value) {
    emit('close');
  }
};
</script>

<template>
  <!-- 移动端专属弹窗抽屉 -->
  <MobileAddEditFavoritePathForm
    v-if="isMobile"
    :is-visible="isVisible"
    :path-data="effectivePathData"
    :current-path="activeFileManagerPath"
    @close="closeModal"
    @save-success="emit('saveSuccess')"
  />

  <!-- 桌面端常规居中弹窗 -->
  <div v-else-if="isVisible" class="fixed inset-0 z-[70]">
    <div 
      class="fixed inset-0 flex items-center justify-center bg-[var(--overlay-bg-color)]"
      @click.self="closeModal"
    >
      <div class="bg-background text-foreground shadow-xl rounded-lg w-full max-w-md flex flex-col overflow-hidden m-4 p-6">
        <!-- Header -->
        <h2 class="m-0 mb-6 text-center text-xl font-semibold">
          {{ isEditMode ? t('favoritePaths.addEditForm.editTitle', 'Edit Favorite Path') : t('favoritePaths.addEditForm.addTitle', 'Add New Favorite Path') }}
        </h2>

        <!-- Form Body -->
        <form @submit.prevent="handleSubmit" class="space-y-4 flex-grow overflow-y-auto">
          <div>
            <label for="favPath-name" class="block text-sm font-medium text-text-secondary mb-1">
              {{ t('favoritePaths.addEditForm.nameLabel', 'Name (Optional)') }}
            </label>
            <input
              id="favPath-name"
              type="text"
              v-model="form.name"
              :disabled="isLoading"
              class="w-full bg-input border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
              :placeholder="t('favoritePaths.addEditForm.namePlaceholder', 'My Documents')"
            />
          </div>
          <div>
            <div class="flex items-center justify-between mb-1">
              <label for="favPath-path" class="block text-sm font-medium text-text-secondary">
                {{ t('favoritePaths.addEditForm.pathLabel', 'Path') }}
                <span class="text-rose-500 ml-0.5">*</span>
              </label>
              <button
                v-if="activeFileManagerPath"
                type="button"
                @click="fillCurrentPath"
                class="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium text-primary hover:text-primary-hover bg-primary/10 hover:bg-primary/20 rounded transition-colors cursor-pointer"
                :title="t('favoritePaths.addEditForm.fillCurrentPathTooltip', { path: activeFileManagerPath })"
              >
                <i class="fas fa-crosshairs text-[11px]"></i>
                <span>{{ t('favoritePaths.addEditForm.fillCurrentPath', '填入当前路径') }}</span>
              </button>
            </div>
            <input
              id="favPath-path"
              type="text"
              v-model="form.path"
              required
              :disabled="isLoading"
              class="w-full bg-input border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
              :placeholder="t('favoritePaths.addEditForm.pathPlaceholder', '/example/folder/path')"
            />
          </div>

          <div v-if="errorMessage" class="text-rose-500 text-sm p-2 bg-rose-500/10 rounded-md">
            {{ errorMessage }}
          </div>
        </form>

        <!-- Footer -->
        <div class="flex justify-end mt-8 pt-4 border-t border-border/50">
          <button
            type="button"
            @click="closeModal"
            :disabled="isLoading"
            class="py-2 px-5 rounded-lg text-sm font-medium transition-colors duration-150 bg-background border border-border/50 text-text-secondary hover:bg-border hover:text-foreground mr-3">
            {{ t('common.cancel', 'Cancel') }}
          </button>
          <button
            type="submit"
            @click="handleSubmit"
            :disabled="isLoading || !form.path.trim()"
            class="py-2 px-5 rounded-lg text-sm font-semibold transition-colors duration-150 bg-primary text-white border-none shadow-md hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed">
            {{ isLoading ? t('common.saving', 'Saving...') : t('common.save', 'Save') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
</style>