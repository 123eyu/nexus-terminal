<script setup lang="ts">
import { ref, watch, onBeforeUnmount, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  largeFilePromptState,
  confirmLargeFilePrompt,
  cancelLargeFilePrompt,
} from '../composables/file-manager/useLargeFilePrompt';
import { formatFileSize } from '../utils/fileFormatters';

/**
 * 打开大文件前的确认弹窗（在 App.vue 挂一次）。
 * 触发与结算逻辑见 useLargeFilePrompt：openRemoteFile 会 await 它的结果。
 */
const { t } = useI18n();

const remember = ref(false);

const state = computed(() => largeFilePromptState.value);
const visible = computed(() => state.value !== null);

// 每次重新弹都把勾选清掉，避免上一次的"记住"被无意沿用
watch(visible, (v) => {
  if (v) remember.value = false;
});

const sizeText = computed(() => {
  const s = state.value;
  if (!s) return '';
  return formatFileSize(s.sizeBytes);
});

const handleConfirm = () => {
  confirmLargeFilePrompt(remember.value);
};

const handleCancel = () => {
  cancelLargeFilePrompt();
};

const handleKeydown = (event: KeyboardEvent) => {
  if (!visible.value) return;
  if (event.key === 'Escape') handleCancel();
  // Ctrl/Cmd + Enter 直接打开，键盘党不用摸鼠标
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) handleConfirm();
};

watch(visible, (v) => {
  if (v) document.addEventListener('keydown', handleKeydown);
  else document.removeEventListener('keydown', handleKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-[9999] flex items-center justify-center bg-overlay p-4"
      @mousedown.self="handleCancel"
    >
      <div
        class="bg-background text-foreground p-5 rounded-2xl shadow-2xl border border-border/80 w-full max-w-md flex flex-col"
        style="background-color: var(--app-bg-color)"
        role="dialog"
        aria-modal="true"
      >
        <h3 class="text-lg font-semibold mb-3 flex items-center gap-2">
          <i class="fas fa-file-lines text-primary text-base"></i>
          {{ t('fileManager.largeFile.title', '打开大文件') }}
        </h3>

        <div class="mb-4 text-sm">
          <div class="rounded-lg border border-border/70 bg-header/40 px-3 py-2 text-xs space-y-1">
            <div class="flex items-center justify-between gap-3">
              <span class="text-text-secondary">{{ t('fileManager.largeFile.fileName', '文件名') }}</span>
              <span class="font-mono truncate text-foreground" :title="state?.fileName">{{ state?.fileName }}</span>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class="text-text-secondary">{{ t('fileManager.largeFile.fileSize', '大小') }}</span>
              <span class="font-mono text-foreground">{{ sizeText }}</span>
            </div>
          </div>
        </div>

        <label class="flex items-center gap-2 mb-5 text-xs text-text-secondary cursor-pointer select-none">
          <input type="checkbox" v-model="remember" class="accent-primary w-3.5 h-3.5 cursor-pointer" />
          <span>{{ t('fileManager.largeFile.remember', '记住（以后不再提示）') }}</span>
        </label>

        <div class="flex justify-end gap-3 flex-shrink-0">
          <button
            type="button"
            @click="handleCancel"
            class="px-4 py-2 rounded-md text-sm font-medium transition-colors bg-background border border-border/50 text-text-secondary hover:bg-border hover:text-foreground"
          >
            {{ t('common.cancel', '取消') }}
          </button>
          <button
            type="button"
            @click="handleConfirm"
            class="px-4 py-2 text-sm font-medium text-white rounded-md transition-colors bg-primary hover:bg-primary-hover"
          >
            {{ t('fileManager.largeFile.openAnyway', '仍然打开') }}
          </button>
        </div>
      </div>
    </div>
  </teleport>
</template>
