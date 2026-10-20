<script setup lang="ts">
import { type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileListItem } from '../types/sftp.types';
import { useFileManagerActionModal } from '../composables/file-manager/useFileManagerActionModal';
// 同上：必须显式导入，否则退化成未知自定义元素、内容裸渲染
import MobileBottomSheet from './common/MobileBottomSheet.vue';

const props = defineProps({
  isVisible: {
    type: Boolean,
    required: true,
  },
  actionType: {
    type: String as PropType<'delete' | 'rename' | 'chmod' | 'newFile' | 'newFolder' | null>,
    default: null,
  },
  item: {
    type: Object as PropType<FileListItem | null>,
    default: null,
  },
  items: {
    type: Array as PropType<FileListItem[]>,
    default: () => [],
  },
  initialValue: {
    type: String,
    default: '',
  },
});

// 模板里直接用了 t(...)，保留一份（composable 内部另有自己的实例）
const { t } = useI18n();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirm', value?: string): void;
}>();

// 展示与校验逻辑两端共用（见 composables/file-manager/useFileManagerActionModal.ts）
const {
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
} = useFileManagerActionModal(props, emit, { enableGlobalKeydown: false });
</script>

<template>
  <MobileBottomSheet
    :visible="props.isVisible"
    height="h-auto"
    max-height="max-h-[85vh]"
    :z-index="100"
    @close="closeModal"
  >
    <!-- 顶栏左侧标题与图标 -->
    <template #header-left>
      <div class="flex items-center gap-2">
        <i :class="actionIconClass"></i>
        <h3 class="text-base font-semibold text-foreground">{{ modalTitle }}</h3>
      </div>
    </template>

    <div class="px-4 py-3 space-y-3.5">
      <!-- 表单内容区 -->
      <div>
        <p v-if="actionType === 'delete'" class="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">
          {{ messageText }}
        </p>

        <div v-if="showInput" class="space-y-2">
          <label :for="`fileManagerActionInput-mobile-${actionType}`" class="block text-xs font-medium text-text-secondary">
            {{ inputLabel }}
          </label>
          <input
            :id="`fileManagerActionInput-mobile-${actionType}`"
            ref="inputRef"
            type="text"
            v-model="inputValue"
            :placeholder="inputPlaceholder"
            class="w-full h-11 px-3.5 bg-input border border-border rounded-xl text-base text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary shadow-xs transition-colors"
          />
          <p v-if="actionType === 'chmod' && inputValue.trim() && !/^[0-7]{3,4}$/.test(inputValue.trim())" class="text-xs text-rose-500">
            {{ t('fileManager.errors.invalidPermissionsFormat', '请输入有效的 8 进制权限格式 (例如 755 或 0755)') }}
          </p>
          <p v-else-if="actionType === 'chmod'" class="text-xs text-text-secondary">
            {{ t('fileManager.modals.chmodHelp', '格式为 3 或 4 位八进制数字，如 755 (rwxr-xr-x) 或 644 (rw-r--r--)') }}
          </p>
        </div>
      </div>

      <!-- 底部双大按钮并排操作区 -->
      <div class="flex items-center gap-3 pt-2">
        <button
          @click="closeModal"
          type="button"
          class="flex-1 h-11 rounded-xl bg-header/60 border border-border/80 text-foreground font-medium text-sm active:scale-95 transition-transform cursor-pointer"
        >
          {{ t('fileManager.modals.buttons.cancel', '取消') }}
        </button>
        <button
          @click="confirmAction"
          type="button"
          :disabled="isConfirmDisabled"
          class="flex-1 h-11 rounded-xl font-medium text-sm text-white active:scale-95 transition-transform disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          :class="{
            'bg-rose-600 active:bg-rose-700': actionType === 'delete',
            'bg-primary active:bg-primary-hover': actionType !== 'delete'
          }"
        >
          {{ confirmButtonText }}
        </button>
      </div>
    </div>
  </MobileBottomSheet>
</template>
