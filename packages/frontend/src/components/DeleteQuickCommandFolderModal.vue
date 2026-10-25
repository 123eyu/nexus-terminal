<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';

interface Props {
  visible: boolean;
  folderName: string;
  commandCount: number;
  isLoading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isLoading: false,
});

const emit = defineEmits<{
  (e: 'confirm', deleteCommands: boolean): void;
  (e: 'close'): void;
}>();

const { t } = useI18n();

// 是否连同指令一起删除：false = 仅删除分组（保留指令并移回未分类）；true = 连同指令彻底删除
const deleteCommands = ref(false);

watch(() => props.visible, (newVal) => {
  if (newVal) {
    deleteCommands.value = false;
  }
});

const handleConfirm = () => {
  if (props.isLoading) return;
  emit('confirm', deleteCommands.value);
};

const handleCancel = () => {
  if (props.isLoading) return;
  emit('close');
};

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && props.visible && !props.isLoading) {
    handleCancel();
  }
};

watch(() => props.visible, (isVisible) => {
  if (isVisible) {
    document.addEventListener('keydown', handleKeydown);
  } else {
    document.removeEventListener('keydown', handleKeydown);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <teleport to="body">
    <div
      v-if="props.visible"
      class="fixed inset-0 z-[9999] flex items-center justify-center bg-overlay/80 p-4 transition-opacity animate-in fade-in duration-200"
      @mousedown.self="handleCancel"
    >
      <div
        class="bg-background text-foreground p-6 rounded-2xl shadow-2xl border border-border/80 w-full max-w-md flex flex-col gap-5 select-none"
        style="background-color: var(--app-bg-color);"
        role="dialog"
        aria-modal="true"
      >
        <!-- 头部标题 -->
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-error/15 text-error flex items-center justify-center flex-shrink-0">
            <i class="fas fa-trash-alt text-base"></i>
          </div>
          <div class="flex-1 min-w-0">
            <h3 class="text-base font-semibold text-foreground truncate">
              {{ t('folders.deleteFolderTitle', { name: props.folderName }, `删除分组 "${props.folderName}"`) }}
            </h3>
            <p class="text-xs text-text-secondary mt-0.5">
              {{ t('folders.deleteFolderNotice', { count: props.commandCount }, `该分组下包含 ${props.commandCount} 条快捷指令`) }}
            </p>
          </div>
        </div>

        <!-- 选项单选卡片 -->
        <div class="flex flex-col gap-2.5">
          <!-- 选项 1：仅删除分组（保留指令） -->
          <div
            @click="deleteCommands = false"
            class="flex items-start gap-3 p-3.5 rounded-xl border transition-all cursor-pointer"
            :class="[
              !deleteCommands
                ? 'border-primary/60 bg-primary/10 ring-1 ring-primary/40 shadow-xs'
                : 'border-border/60 hover:bg-muted/40 hover:border-border'
            ]"
          >
            <div class="mt-0.5 flex-shrink-0">
              <input
                type="radio"
                name="deleteOption"
                :checked="!deleteCommands"
                @change="deleteCommands = false"
                class="w-4 h-4 text-primary focus:ring-primary focus:ring-offset-0 cursor-pointer"
              />
            </div>
            <div class="flex-1 text-left">
              <div class="text-sm font-medium text-foreground">
                <span>{{ t('folders.keepCommands', '仅删除分组，保留指令') }}</span>
              </div>
            </div>
          </div>

          <!-- 选项 2：连同指令一起彻底删除 -->
          <div
            @click="deleteCommands = true"
            class="flex items-start gap-3 p-3.5 rounded-xl border transition-all cursor-pointer"
            :class="[
              deleteCommands
                ? 'border-error/60 bg-error/10 ring-1 ring-error/40 shadow-xs'
                : 'border-border/60 hover:bg-muted/40 hover:border-border'
            ]"
          >
            <div class="mt-0.5 flex-shrink-0">
              <input
                type="radio"
                name="deleteOption"
                :checked="deleteCommands"
                @change="deleteCommands = true"
                class="w-4 h-4 text-error focus:ring-error focus:ring-offset-0 cursor-pointer"
              />
            </div>
            <div class="flex-1 text-left">
              <div class="text-sm font-medium text-error">
                <span>{{ t('folders.deleteWithCommands', '连同里面的指令一起删除') }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 底部按钮操作栏 -->
        <div class="flex justify-end items-center gap-3 pt-1">
          <button
            @click="handleCancel"
            :disabled="props.isLoading"
            type="button"
            class="px-4 py-2 rounded-xl text-xs md:text-sm font-medium transition-colors border border-border/60 text-text-secondary hover:bg-muted/60 hover:text-foreground cursor-pointer disabled:opacity-50"
          >
            {{ t('common.cancel', '取消') }}
          </button>
          <button
            @click="handleConfirm"
            :disabled="props.isLoading"
            type="button"
            class="px-4 py-2 text-xs md:text-sm font-medium text-white rounded-xl transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2 shadow-xs"
            :class="[
              deleteCommands
                ? 'bg-error hover:bg-error/90 active:scale-98'
                : 'bg-primary hover:bg-primary-hover active:scale-98'
            ]"
          >
            <span>{{ deleteCommands ? t('folders.confirmDeleteAll', '确认彻底删除') : t('folders.confirmDeleteFolder', '确认删除分组') }}</span>
          </button>
        </div>
      </div>
    </div>
  </teleport>
</template>
