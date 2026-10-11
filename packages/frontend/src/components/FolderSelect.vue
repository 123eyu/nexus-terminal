<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
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
const dropdownRef = ref<HTMLElement | null>(null);
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

const toggleDropdown = () => {
  if (props.disabled) return;
  isOpen.value = !isOpen.value;
  if (!isOpen.value) {
    isCreating.value = false;
    newFolderName.value = '';
  }
};

const selectFolder = (id: number | null) => {
  emit('update:modelValue', id);
  isOpen.value = false;
  isCreating.value = false;
  newFolderName.value = '';
};

const startCreating = () => {
  isCreating.value = true;
  newFolderName.value = '';
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
  isCreating.value = false;
  newFolderName.value = '';
};

const cancelCreating = () => {
  isCreating.value = false;
  newFolderName.value = '';
};

const handleClickOutside = (e: MouseEvent) => {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    isOpen.value = false;
    isCreating.value = false;
    newFolderName.value = '';
  }
};

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside);
});
</script>

<template>
  <div ref="dropdownRef" class="relative w-full text-sm">
    <!-- Trigger Button -->
    <button
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

    <!-- Dropdown Menu -->
    <div
      v-if="isOpen"
      class="absolute left-0 right-0 mt-1 z-50 bg-popover text-popover-foreground border border-border rounded-xl shadow-xl overflow-hidden backdrop-blur-md animate-fadeIn"
    >
      <!-- Option: Uncategorized -->
      <div class="p-1 max-h-56 overflow-y-auto space-y-0.5">
        <button
          type="button"
          @click="selectFolder(null)"
          class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors duration-150 text-xs sm:text-sm"
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
          class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors duration-150 text-xs sm:text-sm"
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
            class="px-2 py-1 bg-primary text-white text-xs rounded-md hover:bg-primary/90 flex-shrink-0"
          >
            {{ t('common.create', '创建') }}
          </button>
          <button
            type="button"
            @click="cancelCreating"
            class="px-2 py-1 text-xs text-text-secondary hover:text-foreground flex-shrink-0"
          >
            {{ t('common.cancel', '取消') }}
          </button>
        </div>

        <button
          v-else
          type="button"
          @click="startCreating"
          class="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs text-primary hover:bg-primary/10 rounded-lg transition-colors duration-150 font-medium"
        >
          <i class="fas fa-plus text-xs"></i>
          <span>{{ t('folders.createNewFolder', '新建文件夹') }}</span>
        </button>
      </div>
    </div>
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
