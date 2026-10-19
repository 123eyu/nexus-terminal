<script setup lang="ts">
import { type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { type FavoritePathItem } from '../stores/favoritePaths.store';
import { useFavoritePathForm } from '../composables/useFavoritePathForm';

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

// 模板里用 t(...)
const { t } = useI18n();

// 表单逻辑两端共用（见 composables/useFavoritePathForm.ts）
const {
  form,
  effectivePathData,
  isEditMode,
  isLoading,
  errorMessage,
  activeFileManagerPath,
  fillCurrentPath,
  validateForm,
  handleSubmit,
  closeModal,
} = useFavoritePathForm(props, emit);
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
