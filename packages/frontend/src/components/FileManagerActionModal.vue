<script setup lang="ts">
import { type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileListItem } from '../types/sftp.types';
import MobileFileManagerActionModal from './MobileFileManagerActionModal.vue';
import FilePermissionEditor from './FilePermissionEditor.vue';
import { useFileManagerActionModal, type FileManagerActionConfirmPayload } from '../composables/file-manager/useFileManagerActionModal';

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
  isMobile: {
    type: Boolean,
    default: false,
  },
});

// 模板里直接用了 t(...)，保留一份（composable 内部另有自己的实例）
const { t } = useI18n();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirm', payload?: FileManagerActionConfirmPayload): void;
}>();

// 展示与校验逻辑两端共用（见 composables/file-manager/useFileManagerActionModal.ts）
const {
  inputValue,
  inputRef,
  ownerValue,
  groupValue,
  isChmodAction,
  currentUid,
  currentGid,
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
} = useFileManagerActionModal(props, emit, { enableGlobalKeydown: true });
</script>

<template>
  <!-- 移动端专属弹窗抽屉 -->
  <MobileFileManagerActionModal
    v-if="isMobile"
    :is-visible="isVisible"
    :action-type="actionType"
    :item="item"
    :items="items"
    :initial-value="initialValue"
    @close="closeModal"
    @confirm="confirmAction"
  />

  <!-- 桌面端常规居中弹窗 -->
  <div v-else-if="isVisible" class="fixed inset-0 z-[100]">
    <div class="fixed inset-0 bg-overlay flex justify-center items-center z-[100] p-4" @click.self="closeModal">
        <div class="bg-background text-foreground p-5 rounded-lg shadow-xl border border-border w-full flex flex-col relative"
             :class="isChmodAction ? 'max-w-lg' : 'max-w-md'">
          <!-- Close Button -->
          <button class="absolute top-3 right-3 p-1 text-text-secondary hover:text-foreground z-10" @click="closeModal" :title="t('fileManager.modals.buttons.close', 'Close')">
             <i class="fas fa-times text-sm"></i>
          </button>

          <!-- Title -->
          <h3 class="text-xl font-semibold text-center mb-4 flex-shrink-0 flex items-center justify-center gap-2">
            <i :class="actionIconClass"></i>
            <span>{{ modalTitle }}</span>
          </h3>

          <!-- Content -->
          <div class="flex-grow mb-6 text-sm">
            <p v-if="actionType === 'delete'" class="text-center whitespace-pre-wrap">
              {{ messageText }}
            </p>

            <!-- 权限：rwx 勾选网格 + 八进制 + 所有者/所属组 -->
            <FilePermissionEditor
              v-if="isChmodAction"
              v-model:mode="inputValue"
              v-model:owner="ownerValue"
              v-model:group="groupValue"
              :current-uid="currentUid"
              :current-gid="currentGid"
            />

            <div v-else-if="showInput">
              <label :for="`fileManagerActionInput-${actionType}`" class="block text-sm font-medium text-text-secondary mb-1">
                {{ inputLabel }}
              </label>
              <input
                :id="`fileManagerActionInput-${actionType}`"
                ref="inputRef"
                type="text"
                v-model="inputValue"
                :placeholder="inputPlaceholder"
                class="w-full px-3 py-2 bg-input border border-border rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary sm:text-sm text-foreground"
              />
            </div>
          </div>

          <!-- Actions -->
          <div class="flex justify-end gap-3 flex-shrink-0">
            <button
              @click="closeModal"
              type="button"
              class="px-4 py-2 rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 dark:focus:ring-offset-background-dark text-sm font-medium transition-colors duration-150 bg-background border border-border/50 text-text-secondary hover:bg-border hover:text-foreground"
            >
              {{ t('fileManager.modals.buttons.cancel', 'Cancel') }}
            </button>
            <button
              @click="confirmAction"
              type="button"
              :disabled="isConfirmDisabled"
              class="px-4 py-2 text-sm font-medium text-white rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-background-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              :class="{
                'bg-red-600 hover:bg-red-700 focus:ring-red-500': actionType === 'delete',
                'bg-primary hover:bg-primary-hover focus:ring-primary': actionType !== 'delete'
              }"
            >
              {{ confirmButtonText }}
            </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
</style>