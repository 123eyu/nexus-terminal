<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 快捷指令面板内的删除确认遮罩。
 *
 * 刻意**不用 teleport 到 body、不是 fixed 定位**：桌面端删指令 / 删文件夹的确认要落在
 * 组件自己身上（遮住本面板的内容，而不是整屏弹一个对话框）。所以外层必须是
 * `absolute inset-0`，宿主容器需要有 `relative`。
 */
interface Props {
  visible: boolean;
  /** command = 删单条指令（只有一个确认动作）；folder = 删文件夹（要选「指令怎么办」） */
  kind: 'command' | 'folder';
  /** command: 指令名称；folder: 文件夹名称 */
  name?: string;
  /** 仅 folder：文件夹里有几条指令 */
  commandCount?: number;
  busy?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  name: '',
  commandCount: 0,
  busy: false,
});

const emit = defineEmits<{
  (e: 'confirm', deleteCommands: boolean): void;
  (e: 'close'): void;
}>();

const { t } = useI18n();

// false = 仅删除文件夹（指令移回未分类）；true = 连同指令一起彻底删除
const deleteCommands = ref(false);

watch(
  () => props.visible,
  (visible) => {
    if (visible) deleteCommands.value = false;
  }
);

const isFolder = computed(() => props.kind === 'folder');

const title = computed(() =>
  isFolder.value
    ? t('folders.deleteFolderTitle', { name: props.name })
    : t('common.delete')
);

const message = computed(() =>
  isFolder.value
    ? t('folders.deleteFolderNotice', { count: props.commandCount })
    : t('quickCommands.confirmDelete', { name: props.name })
);

const confirmLabel = computed(() => {
  if (!isFolder.value) return t('common.delete');
  return deleteCommands.value
    ? t('folders.confirmDeleteAll')
    : t('folders.confirmDeleteFolder');
});

const handleClose = () => {
  if (props.busy) return;
  emit('close');
};

const handleConfirm = () => {
  if (props.busy) return;
  emit('confirm', isFolder.value ? deleteCommands.value : true);
};

const handleKeydown = (event: KeyboardEvent) => {
  if (!props.visible) return;
  if (event.key === 'Escape') {
    event.stopPropagation();
    handleClose();
  }
};

watch(
  () => props.visible,
  (visible) => {
    if (visible) document.addEventListener('keydown', handleKeydown, true);
    else document.removeEventListener('keydown', handleKeydown, true);
  }
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown, true);
});
</script>

<template>
  <div
    v-if="visible"
    class="absolute inset-0 z-40 flex items-center justify-center p-3 bg-overlay/70"
    data-qc-delete-overlay
    @mousedown.self="handleClose"
  >
    <div
      class="w-full max-w-sm max-h-full overflow-y-auto p-3 rounded-xl border border-border/80 shadow-2xl flex flex-col gap-2.5 select-none"
      style="background-color: var(--app-bg-color);"
      role="dialog"
      aria-modal="true"
      data-qc-delete-card
    >
      <!-- 标题 + 说明 -->
      <div class="flex items-start gap-2.5">
        <div class="w-8 h-8 rounded-full bg-error/15 text-error flex items-center justify-center flex-shrink-0">
          <i class="fas fa-trash-alt text-xs"></i>
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="text-sm font-semibold text-foreground truncate">{{ title }}</h3>
          <p class="text-xs text-text-secondary mt-0.5 leading-relaxed break-words">{{ message }}</p>
        </div>
      </div>

      <!-- 删文件夹：先选里面的指令怎么办 -->
      <div v-if="isFolder" class="flex flex-col gap-1.5">
        <button
          type="button"
          data-qc-delete-option-keep
          class="flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left text-xs transition-colors cursor-pointer"
          :class="deleteCommands
            ? 'border-border/60 text-foreground hover:bg-muted/40'
            : 'border-primary/60 bg-primary/10 text-foreground ring-1 ring-primary/40'"
          @click="deleteCommands = false"
        >
          <i :class="['fas', deleteCommands ? 'fa-circle' : 'fa-circle-dot', 'text-[10px]', deleteCommands ? 'text-text-secondary/40' : 'text-primary']"></i>
          <span class="truncate">{{ t('folders.keepCommands') }}</span>
        </button>
        <button
          type="button"
          data-qc-delete-option-all
          class="flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left text-xs transition-colors cursor-pointer"
          :class="deleteCommands
            ? 'border-error/60 bg-error/10 text-error ring-1 ring-error/40'
            : 'border-border/60 text-foreground hover:bg-muted/40'"
          @click="deleteCommands = true"
        >
          <i :class="['fas', deleteCommands ? 'fa-circle-dot' : 'fa-circle', 'text-[10px]', deleteCommands ? 'text-error' : 'text-text-secondary/40']"></i>
          <span class="truncate">{{ t('folders.deleteWithCommands') }}</span>
        </button>
      </div>

      <!-- 操作 -->
      <div class="flex items-center justify-end gap-2 pt-0.5">
        <button
          type="button"
          data-qc-delete-cancel
          :disabled="busy"
          class="px-3 py-1.5 rounded-lg text-xs font-medium border border-border/60 text-text-secondary hover:bg-muted/60 hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
          @click="handleClose"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          data-qc-delete-confirm
          :disabled="busy"
          class="px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors cursor-pointer disabled:opacity-50"
          :class="isFolder && !deleteCommands ? 'bg-primary hover:bg-primary-hover' : 'bg-error hover:bg-error/90'"
          @click="handleConfirm"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
