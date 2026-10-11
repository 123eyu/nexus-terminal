<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSshKeysStore, SshKeyBasicInfo } from '../stores/sshKeys.store';
import SshKeyManagementModal from './SshKeyManagementModal.vue';

const props = withDefaults(
  defineProps<{
    modelValue: number | null | undefined;
    placeholder?: string;
    disabled?: boolean;
    allowManage?: boolean;
    allowUndefined?: boolean;
    undefinedLabel?: string;
  }>(),
  {
    modelValue: null,
    placeholder: '',
    disabled: false,
    allowManage: true,
    allowUndefined: false,
    undefinedLabel: '',
  }
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: number | null | undefined): void;
}>();

const { t } = useI18n();
const sshKeysStore = useSshKeysStore();

const isOpen = ref(false);
const dropdownRef = ref<HTMLElement | null>(null);
const searchQuery = ref('');
const isManagementModalVisible = ref(false);

const keys = computed(() => sshKeysStore.sshKeys || []);
const isLoading = computed(() => sshKeysStore.isLoading);

// 当前选中的密钥对象
const selectedKey = computed(() => {
  if (props.modelValue === null || props.modelValue === undefined) return null;
  return keys.value.find((k) => k.id === props.modelValue) || null;
});

// 过滤后的密钥列表
const filteredKeys = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return keys.value;
  return keys.value.filter((k) => k.name.toLowerCase().includes(query));
});

const displayText = computed(() => {
  if (selectedKey.value) return selectedKey.value.name;
  if (props.allowUndefined && props.modelValue === undefined) {
    return props.undefinedLabel || t('connections.batchEdit.noChange', '-- 不更改 --');
  }
  if (props.modelValue === null) {
    return t('connections.form.noSshKey', '不使用密钥 (密码/无)');
  }
  return props.placeholder || t('sshKeys.selector.selectPlaceholder', '选择 SSH 密钥...');
});

const toggleDropdown = () => {
  if (props.disabled) return;
  isOpen.value = !isOpen.value;
  if (isOpen.value) {
    searchQuery.value = '';
    // 打开时若尚未加载则触发拉取
    if (keys.value.length === 0) {
      sshKeysStore.fetchSshKeys();
    }
  }
};

const selectKey = (id: number | null | undefined) => {
  emit('update:modelValue', id);
  isOpen.value = false;
  searchQuery.value = '';
};

const clearSelection = () => {
  emit('update:modelValue', props.allowUndefined ? undefined : null);
  searchQuery.value = '';
};

const openManagementModal = () => {
  isOpen.value = false;
  isManagementModalVisible.value = true;
  sshKeysStore.fetchSshKeys();
};

const closeManagementModal = () => {
  isManagementModalVisible.value = false;
  sshKeysStore.fetchSshKeys();
};

// 点击外部自动关闭
const handleClickOutside = (e: MouseEvent) => {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    isOpen.value = false;
  }
};

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
  if (keys.value.length === 0) {
    sshKeysStore.fetchSshKeys();
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside);
});
</script>

<template>
  <div ref="dropdownRef" class="relative w-full text-xs md:text-sm">
    <div class="flex items-center gap-2">
      <!-- 主触发下拉按钮 -->
      <button
        type="button"
        :disabled="props.disabled"
        @click="toggleDropdown"
        class="flex-1 flex items-center justify-between px-3 py-2 border border-border/70 rounded-xl bg-input text-foreground hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/40 transition duration-150 disabled:opacity-50 disabled:cursor-not-allowed shadow-2xs"
        :class="{ 'ring-2 ring-primary/40 border-primary': isOpen }"
      >
        <div class="flex items-center min-w-0 gap-2 truncate">
          <i
            :class="[
              'fas',
              selectedKey ? 'fa-key text-amber-400' : 'fa-shield-alt text-text-secondary',
              'flex-shrink-0 text-xs'
            ]"
          ></i>
          <span :class="selectedKey ? 'font-medium text-foreground' : 'text-text-secondary'" class="truncate">
            {{ displayText }}
          </span>
        </div>

        <div class="flex items-center gap-1.5 flex-shrink-0 text-text-secondary ml-2">
          <i
            v-if="(selectedKey || (props.allowUndefined && props.modelValue !== undefined)) && !props.disabled"
            @click.stop="clearSelection"
            class="fas fa-times hover:text-foreground p-0.5 rounded cursor-pointer text-xs"
            :title="t('common.clear', '清除选择')"
          ></i>
          <i :class="['fas fa-chevron-down text-xs transition-transform duration-200', { 'rotate-180': isOpen }]"></i>
        </div>
      </button>

      <!-- 快捷密钥管理按钮 -->
      <button
        v-if="props.allowManage"
        type="button"
        @click="openManagementModal"
        :disabled="props.disabled"
        class="h-9 w-9 shrink-0 flex items-center justify-center rounded-xl border border-border/70 bg-input text-text-secondary hover:text-foreground hover:border-primary/50 hover:bg-muted/50 transition-all cursor-pointer shadow-2xs disabled:opacity-50"
        :title="t('sshKeys.selector.manageKeysTitle', '管理 SSH 密钥')"
      >
        <i class="fas fa-cog text-xs"></i>
      </button>
    </div>

    <!-- 现代下拉弹出浮层 -->
    <div
      v-if="isOpen"
      class="absolute left-0 right-0 mt-1.5 z-50 bg-popover text-foreground border border-border/80 rounded-xl shadow-2xl overflow-hidden backdrop-blur-md animate-fadeIn"
    >
      <!-- 搜索栏 (当密钥总数多于 3 个时展示) -->
      <div v-if="keys.length > 3" class="p-2 border-b border-border/50">
        <div class="relative flex items-center">
          <i class="fas fa-search absolute left-2.5 text-text-secondary text-xs"></i>
          <input
            v-model="searchQuery"
            type="text"
            :placeholder="t('common.search', '搜索密钥...')"
            class="w-full pl-8 pr-2.5 py-1 text-xs rounded-lg border border-border/60 bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            @click.stop
          />
        </div>
      </div>

      <!-- 选项列表 -->
      <div class="p-1 max-h-56 overflow-y-auto space-y-0.5">
        <!-- 选项：不更改 (批量编辑模式) -->
        <button
          v-if="props.allowUndefined"
          type="button"
          @click="selectKey(undefined)"
          class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors duration-150 text-xs"
          :class="props.modelValue === undefined ? 'bg-primary/15 text-primary font-medium' : 'hover:bg-muted text-text-secondary hover:text-foreground'"
        >
          <i class="fas fa-minus w-4 text-center text-text-secondary"></i>
          <span class="flex-1 truncate">{{ props.undefinedLabel || t('connections.batchEdit.noChange', '-- 不更改 --') }}</span>
          <i v-if="props.modelValue === undefined" class="fas fa-check text-primary text-xs"></i>
        </button>

        <!-- 选项：不使用密钥 / 密码认证 -->
        <button
          type="button"
          @click="selectKey(null)"
          class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors duration-150 text-xs"
          :class="props.modelValue === null ? 'bg-primary/15 text-primary font-medium' : 'hover:bg-muted text-text-secondary hover:text-foreground'"
        >
          <i class="fas fa-shield-alt w-4 text-center text-text-secondary"></i>
          <span class="flex-1 truncate">{{ t('connections.form.noSshKey', '不使用密钥 (密码/无)') }}</span>
          <i v-if="props.modelValue === null" class="fas fa-check text-primary text-xs"></i>
        </button>

        <!-- 分割线 -->
        <div v-if="filteredKeys.length > 0" class="h-px bg-border/40 my-1"></div>

        <!-- 密钥列表 -->
        <button
          v-for="key in filteredKeys"
          :key="key.id"
          type="button"
          @click="selectKey(key.id)"
          class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors duration-150 text-xs"
          :class="props.modelValue === key.id ? 'bg-primary/15 text-primary font-medium' : 'hover:bg-muted text-foreground'"
        >
          <i class="fas fa-key text-amber-400 w-4 text-center"></i>
          <span class="flex-1 truncate font-medium">{{ key.name }}</span>
          <i v-if="props.modelValue === key.id" class="fas fa-check text-primary text-xs"></i>
        </button>

        <div v-if="keys.length === 0" class="px-3 py-3 text-xs text-text-secondary text-center italic">
          {{ t('sshKeys.modal.noKeys', '暂无已保存的 SSH 密钥') }}
        </div>
        <div v-else-if="filteredKeys.length === 0" class="px-3 py-3 text-xs text-text-secondary text-center">
          {{ t('common.noMatchingResults', '无匹配的密钥') }}
        </div>
      </div>

      <!-- 底部快捷新建/管理入口 -->
      <div v-if="props.allowManage" class="p-1.5 border-t border-border/50 bg-muted/30 flex items-center justify-between gap-1">
        <button
          type="button"
          @click="openManagementModal"
          class="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs text-primary hover:bg-primary/10 rounded-lg transition-colors duration-150 font-medium cursor-pointer"
        >
          <i class="fas fa-plus text-xs"></i>
          <span>{{ t('sshKeys.modal.addKey', '新建密钥') }}</span>
        </button>
        <button
          type="button"
          @click="openManagementModal"
          class="px-2.5 py-1.5 text-xs text-text-secondary hover:text-foreground hover:bg-muted rounded-lg transition-colors duration-150 cursor-pointer"
        >
          <span>{{ t('sshKeys.selector.manageKeysTitle', '管理密钥') }}</span>
        </button>
      </div>
    </div>

    <!-- 密钥管理弹窗 -->
    <SshKeyManagementModal v-if="isManagementModalVisible" @close="closeManagementModal" />
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