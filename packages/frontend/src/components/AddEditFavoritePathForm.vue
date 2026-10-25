<script setup lang="ts">
import { type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { type FavoritePathItem } from '../stores/favoritePaths.store';
import MobileAddEditFavoritePathForm from './MobileAddEditFavoritePathForm.vue';
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
  /** 当前文件管理器所在主机（连接 uuid），决定「本机专属」落到哪台机器 */
  hostUuid: {
    type: String as PropType<string | null>,
    default: null,
  },
  isMobile: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(['close', 'saveSuccess']);

// 模板里用 t(...)
const { t } = useI18n();

// 表单逻辑两端共用（见 composables/useFavoritePathForm.ts）
const {
  form,
  canUseHostScope,
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
  <!-- 移动端专属弹窗抽屉 -->
  <MobileAddEditFavoritePathForm
    v-if="isMobile"
    :is-visible="isVisible"
    :path-data="effectivePathData"
    :current-path="activeFileManagerPath"
    :host-uuid="props.hostUuid"
    @close="closeModal"
    @save-success="emit('saveSuccess')"
  />

  <!-- 桌面端常规居中弹窗（z 要高于收藏夹浮层的 z-[1001]，否则浮层会盖住「保存」按钮吞掉点击） -->
  <div v-else-if="isVisible" class="fixed inset-0 z-[1100]">
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

          <div>
            <span class="block text-sm font-medium text-text-secondary mb-1">
              {{ t('favoritePaths.addEditForm.scopeLabel', '收藏范围') }}
            </span>
            <div class="inline-flex p-0.5 rounded-lg bg-input border border-border">
              <button
                type="button"
                :disabled="!canUseHostScope || isLoading"
                @click="form.scope = 'host'"
                class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                :class="form.scope === 'host' ? 'bg-primary text-white shadow-sm' : 'text-text-secondary hover:text-foreground'"
              >
                <i class="fas fa-server text-[10px]"></i>
                <span>{{ t('favoritePaths.scope.host', '本机专属') }}</span>
              </button>
              <button
                type="button"
                :disabled="isLoading"
                @click="form.scope = 'global'"
                class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                :class="form.scope === 'global' ? 'bg-primary text-white shadow-sm' : 'text-text-secondary hover:text-foreground'"
              >
                <i class="fas fa-globe text-[10px]"></i>
                <span>{{ t('favoritePaths.scope.global', '全局') }}</span>
              </button>
            </div>
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
            {{ t('common.save', 'Save') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
</style>