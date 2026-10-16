<script setup lang="ts">
import { ref, watch, computed, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFavoritePathsStore, type FavoritePathItem } from '../stores/favoritePaths.store';
import { useSessionStore } from '../stores/session.store';
import { useWorkspaceSyncStore } from '../stores/workspaceSync.store';
import MobileBottomSheet from './common/MobileBottomSheet.vue';

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
  if (props.currentPath && props.currentPath.trim().startsWith('/')) {
    return props.currentPath.trim();
  }
  const activeSession = sessionStore.activeSession;
  if (activeSession?.sftpManagers) {
    for (const mgr of activeSession.sftpManagers.values()) {
      const p = mgr.currentPath?.value;
      if (p && p.trim().startsWith('/')) {
        return p.trim();
      }
    }
  }
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
    const finalName = form.value.name.trim() || extractFolderNameFromPath(form.value.path.trim());
    if (isEditMode.value && form.value.id) {
      await favoritePathsStore.updateFavoritePath(form.value.id, {
        path: form.value.path.trim(),
        name: finalName,
      }, t);
    } else {
      await favoritePathsStore.addFavoritePath({
        path: form.value.path.trim(),
        name: finalName,
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
  <MobileBottomSheet
    :visible="props.isVisible"
    height="h-auto"
    max-height="max-h-[85vh]"
    :z-index="70"
    @close="closeModal"
  >
    <!-- 顶栏左侧标题 -->
    <template #header-left>
      <div class="flex items-center gap-2">
        <i class="fas fa-star text-amber-400"></i>
        <h3 class="text-base font-semibold text-foreground">
          {{ isEditMode ? t('favoritePaths.addEditForm.editTitle', '编辑收藏路径') : t('favoritePaths.addEditForm.addTitle', '添加常用路径') }}
        </h3>
      </div>
    </template>

    <div class="px-4 py-3 space-y-3.5">
      <!-- 表单区 -->
      <form @submit.prevent="handleSubmit" class="space-y-3.5">
        <div>
          <label for="favPath-mobile-name" class="block text-xs font-medium text-text-secondary mb-1.5">
            {{ t('favoritePaths.addEditForm.nameLabel', '显示名称 (可选)') }}
          </label>
          <input
            id="favPath-mobile-name"
            type="text"
            v-model="form.name"
            :disabled="isLoading"
            class="w-full h-11 px-3.5 bg-input border border-border rounded-xl text-base text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary shadow-xs transition-colors"
            :placeholder="t('favoritePaths.addEditForm.namePlaceholder', '例如：项目根目录、Nginx 配置')"
          />
        </div>

        <div>
          <div class="flex items-center justify-between mb-1.5">
            <label for="favPath-mobile-path" class="block text-xs font-medium text-text-secondary">
              {{ t('favoritePaths.addEditForm.pathLabel', '绝对路径') }}
              <span class="text-rose-500 ml-0.5">*</span>
            </label>
            <button
              v-if="activeFileManagerPath"
              type="button"
              @click="fillCurrentPath"
              class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-medium text-primary active:bg-primary/20 bg-primary/10 rounded-lg transition-colors cursor-pointer"
              :title="t('favoritePaths.addEditForm.fillCurrentPathTooltip', { path: activeFileManagerPath })"
            >
              <i class="fas fa-crosshairs text-[11px]"></i>
              <span>{{ t('favoritePaths.addEditForm.fillCurrentPath', '填入当前路径') }}</span>
            </button>
          </div>
          <input
            id="favPath-mobile-path"
            type="text"
            v-model="form.path"
            required
            :disabled="isLoading"
            class="w-full h-11 px-3.5 bg-input border border-border rounded-xl text-base font-mono text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary shadow-xs transition-colors"
            :placeholder="t('favoritePaths.addEditForm.pathPlaceholder', '/var/www/html 或 /root/data')"
          />
        </div>

        <div v-if="errorMessage" class="text-rose-500 text-xs p-2.5 bg-rose-500/10 border border-rose-500/20 rounded-xl">
          {{ errorMessage }}
        </div>
      </form>

      <!-- 底部双大按钮 -->
      <div class="flex items-center gap-3 pt-2">
        <button
          type="button"
          @click="closeModal"
          :disabled="isLoading"
          class="flex-1 h-11 rounded-xl bg-header/60 border border-border/80 text-foreground font-medium text-sm active:scale-95 transition-transform cursor-pointer"
        >
          {{ t('common.cancel', '取消') }}
        </button>
        <button
          type="button"
          @click="handleSubmit"
          :disabled="isLoading || !form.path.trim()"
          class="flex-1 h-11 rounded-xl bg-primary text-white font-medium text-sm active:scale-95 transition-transform disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {{ isLoading ? t('common.saving', '保存中...') : t('common.save', '保存') }}
        </button>
      </div>
    </div>
  </MobileBottomSheet>
</template>
