<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';

export interface FolderOption {
  id: number;
  name: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: number | null | undefined;
    folders: FolderOption[];
    placeholder?: string;
    disabled?: boolean;
    allowCreate?: boolean;
    uncategorizedLabel?: string;
  }>(),
  {
    modelValue: null,
    folders: () => [],
    placeholder: '',
    disabled: false,
    allowCreate: true,
    uncategorizedLabel: '',
  }
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: number | null): void;
  (e: 'create-folder', name: string): void;
}>();

const { t } = useI18n();

const isOpen = ref(false);
const triggerBtnRef = ref<HTMLButtonElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
const isCreating = ref(false);
const newFolderName = ref('');
const createInputRef = ref<HTMLInputElement | null>(null);

const currentFolder = computed(() => {
  if (props.modelValue === null || props.modelValue === undefined) return null;
  return props.folders.find((f) => f.id === props.modelValue) || null;
});

const defaultPlaceholder = computed(() => {
  return props.placeholder || t('folders.selectPlaceholder', '选择所属文件夹...');
});

const defaultUncategorizedText = computed(() => {
  return props.uncategorizedLabel || t('folders.uncategorized', '未分类');
});

const updatePosition = () => {
  if (typeof window === 'undefined' || !isOpen.value || !triggerBtnRef.value) return;

  const rect = triggerBtnRef.value.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const PADDING = 8;
  const GAP = 4;

  const width = Math.min(rect.width, viewportWidth - PADDING * 2);
  let left = rect.left;
  if (left + width > viewportWidth - PADDING) {
    left = viewportWidth - width - PADDING;
  }
  if (left < PADDING) {
    left = PADDING;
  }

  const menuHeight = menuRef.value ? menuRef.value.offsetHeight : 240;
  const spaceBelow = viewportHeight - rect.bottom - GAP - PADDING;
  const spaceAbove = rect.top - GAP - PADDING;

  let top = rect.bottom + GAP;
  // 当下方空间不足180px且上方空间更充裕时向上翻转
  if (spaceBelow < 180 && spaceAbove > spaceBelow) {
    top = Math.max(PADDING, rect.top - menuHeight - GAP);
  }

  menuStyle.value = {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
    width: `${width}px`,
    opacity: '1',
    pointerEvents: 'auto',
  };
};

const closeDropdown = () => {
  isOpen.value = false;
  isCreating.value = false;
  newFolderName.value = '';
  window.removeEventListener('resize', updatePosition);
  window.removeEventListener('scroll', updatePosition, true);
};

const toggleDropdown = async () => {
  if (props.disabled) return;
  isOpen.value = !isOpen.value;
  if (isOpen.value) {
    menuStyle.value = {
      position: 'fixed',
      opacity: '0',
      pointerEvents: 'none',
    };
    await nextTick();
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
  } else {
    closeDropdown();
  }
};

const selectFolder = (id: number | null) => {
  emit('update:modelValue', id);
  closeDropdown();
};

const startCreating = async () => {
  isCreating.value = true;
  newFolderName.value = '';
  await nextTick();
  updatePosition();
  setTimeout(() => {
    createInputRef.value?.focus();
  }, 50);
};

const handleConfirmCreate = () => {
  const trimmed = newFolderName.value.trim();
  if (!trimmed) {
    isCreating.value = false;
    return;
  }
  emit('create-folder', trimmed);
  closeDropdown();
};

const cancelCreating = async () => {
  isCreating.value = false;
  newFolderName.value = '';
  await nextTick();
  updatePosition();
};

onBeforeUnmount(() => {
  window.removeEventListener('resize', updatePosition);
  window.removeEventListener('scroll', updatePosition, true);
});
</script>

<template>
  <div class="relative w-full text-sm">
    <!-- Trigger Button -->
    <button
      ref="triggerBtnRef"
      type="button"
      :disabled="props.disabled"
      @click="toggleDropdown"
      class="w-full flex items-center justify-between px-3 py-2 border border-border/70 rounded-lg bg-input text-foreground hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/40 transition duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
      :class="{ 'ring-2 ring-primary/40 border-primary': isOpen }"
    >
      <div class="flex items-center min-w-0 gap-2 truncate">
        <i
          :class="[
            'fas',
            currentFolder ? 'fa-folder text-amber-400' : 'fa-inbox text-text-secondary',
            'flex-shrink-0'
          ]"
        ></i>
        <span v-if="currentFolder" class="truncate font-medium text-foreground">
          {{ currentFolder.name }}
        </span>
        <span v-else class="text-text-secondary truncate">
          {{ defaultUncategorizedText }}
        </span>
      </div>

      <div class="flex items-center gap-1.5 flex-shrink-0 text-text-secondary ml-2">
        <i
          v-if="currentFolder"
          @click.stop="selectFolder(null)"
          class="fas fa-times hover:text-foreground p-0.5 rounded cursor-pointer text-xs"
          :title="t('folders.clearToUncategorized', '设为未分类')"
        ></i>
        <i :class="['fas fa-chevron-down text-xs transition-transform duration-200', { 'rotate-180': isOpen }]"></i>
      </div>
    </button>

    <!-- Teleport Dropdown Menu to Body -->
    <Teleport to="body">
      <div v-if="isOpen" class="folder-select-portal-root">
        <!-- 透明背景点击遮罩 (解决外部点击关闭，层级极高) -->
        <div
          class="fixed inset-0 z-[99998] bg-transparent"
          @click.stop="closeDropdown"
        ></div>

        <!-- 下拉菜单浮层本体 -->
        <div
          ref="menuRef"
          class="fixed z-[99999] bg-popover text-popover-foreground border border-border rounded-xl shadow-2xl overflow-hidden backdrop-blur-md animate-fadeIn select-none"
          style="background-color: var(--popover-bg-color, var(--app-bg-color));"
          :style="menuStyle"
          @click.stop
        >
          <!-- Option: Uncategorized & Custom Folders -->
          <div class="p-1 max-h-56 overflow-y-auto space-y-0.5">
            <button
              type="button"
              @click="selectFolder(null)"
              class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors duration-150 text-xs sm:text-sm cursor-pointer"
              :class="modelValue === null || modelValue === undefined ? 'bg-primary/15 text-primary font-medium' : 'hover:bg-muted text-text-secondary hover:text-foreground'"
            >
              <i class="fas fa-inbox w-4 text-center text-text-secondary"></i>
              <span class="flex-1 truncate">{{ defaultUncategorizedText }}</span>
              <i v-if="modelValue === null || modelValue === undefined" class="fas fa-check text-primary text-xs"></i>
            </button>

            <!-- Divider -->
            <div v-if="props.folders.length > 0" class="h-px bg-border/40 my-1"></div>

            <!-- Custom Folders -->
            <button
              v-for="folder in props.folders"
              :key="folder.id"
              type="button"
              @click="selectFolder(folder.id)"
              class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors duration-150 text-xs sm:text-sm cursor-pointer"
              :class="modelValue === folder.id ? 'bg-primary/15 text-primary font-medium' : 'hover:bg-muted text-foreground'"
            >
              <i class="fas fa-folder text-amber-400 w-4 text-center"></i>
              <span class="flex-1 truncate">{{ folder.name }}</span>
              <i v-if="modelValue === folder.id" class="fas fa-check text-primary text-xs"></i>
            </button>

            <div v-if="props.folders.length === 0" class="px-3 py-2 text-xs text-text-secondary text-center italic">
              {{ t('folders.noCustomFolders', '暂无自定义文件夹') }}
            </div>
          </div>

          <!-- Footer: Quick Create -->
          <div v-if="props.allowCreate" class="p-1.5 border-t border-border/50 bg-muted/40">
            <div v-if="isCreating" class="flex items-center gap-1.5">
              <input
                ref="createInputRef"
                v-model="newFolderName"
                type="text"
                :placeholder="t('folders.newFolderPlaceholder', '输入新文件夹名称...')"
                class="flex-1 px-2.5 py-1 text-xs rounded-md border border-primary/50 bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                @keydown.enter.prevent="handleConfirmCreate"
                @keydown.esc.prevent="cancelCreating"
              />
              <button
                type="button"
                @click="handleConfirmCreate"
                class="px-2 py-1 bg-primary text-white text-xs rounded-md hover:bg-primary/90 flex-shrink-0 cursor-pointer"
              >
                {{ t('common.create', '创建') }}
              </button>
              <button
                type="button"
                @click="cancelCreating"
                class="px-2 py-1 text-xs text-text-secondary hover:text-foreground flex-shrink-0 cursor-pointer"
              >
                {{ t('common.cancel', '取消') }}
              </button>
            </div>

            <button
              v-else
              type="button"
              @click="startCreating"
              class="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs text-primary hover:bg-primary/10 rounded-lg transition-colors duration-150 font-medium cursor-pointer"
            >
              <i class="fas fa-plus text-xs"></i>
              <span>{{ t('folders.createNewFolder', '新建文件夹') }}</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.animate-fadeIn {
  animation: fadeIn 0.15s ease-out forwards;
}
</style>
