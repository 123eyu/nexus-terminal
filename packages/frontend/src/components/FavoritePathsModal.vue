<script setup lang="ts">
import { ref, computed, onMounted, watch, onBeforeUnmount, nextTick, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFavoritePathsStore, type FavoritePathItem, type FavoritePathScope } from '../stores/favoritePaths.store';
import AddEditFavoritePathForm from './AddEditFavoritePathForm.vue';
import FavoritePathTransferModal from './FavoritePathTransferModal.vue';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import MobileFavoritePathsModal from './MobileFavoritePathsModal.vue';
import {
  writeFavoriteScopePreference,
  resolveInitialFavoriteScope,
} from '../utils/favoriteScopePreference';

const PADDING = 8; // px

const props = defineProps({
  isVisible: {
    type: Boolean,
    required: true,
  },
  triggerElement: {
    type: Object as PropType<HTMLElement | null>,
    default: null,
  },
  isMobile: {
    type: Boolean,
    default: false,
  },
  currentPath: {
    type: String,
    default: '',
  },
  /** 当前文件管理器所在主机（连接 uuid）：决定「本机专属」这一组显示哪些 */
  hostUuid: {
    type: String as PropType<string | null>,
    default: null,
  },
});

const emit = defineEmits(['close', 'navigateToPath', 'openFavoriteFile']);

const { t } = useI18n();
const favoritePathsStore = useFavoritePathsStore();
const { showConfirmDialog } = useConfirmDialog();

const searchTerm = ref('');
const showAddEditModal = ref(false);
const showTransferModal = ref(false);
const editingPathItem = ref<FavoritePathItem | null>(null);
const modalContentRef = ref<HTMLElement | null>(null);
const modalStyle = ref<Record<string, string>>({});
const searchInputRef = ref<HTMLInputElement | null>(null);
const listContainerRef = ref<HTMLElement | null>(null);
const selectedIndex = ref<number>(0);

/**
 * 列表当前看的是「本机专属」还是「全局」。
 * 记住上一次选的（`nexus:file_manager_favorite_scope`），不用每次打开都切一遍；
 * 没记住过才回到「本机专属」——从文件管理器里打开收藏夹，想找的几乎都是这台机器上的路径。
 */
const activeScope = ref<FavoritePathScope>(resolveInitialFavoriteScope(props.hostUuid));

const scopedPaths = computed(() =>
  favoritePathsStore.favoritePathsFor(activeScope.value, props.hostUuid || null)
);

const filteredPaths = computed(() => {
  if (!searchTerm.value) {
    return scopedPaths.value;
  }
  const lowerSearchTerm = searchTerm.value.toLowerCase();
  return scopedPaths.value.filter(
    (p) =>
      p.path.toLowerCase().includes(lowerSearchTerm) ||
      (p.name && p.name.toLowerCase().includes(lowerSearchTerm))
  );
});

const toggleScope = () => {
  activeScope.value = activeScope.value === 'host' ? 'global' : 'host';
  // 只有用户真的按了才记 —— 打开时因为缺主机上下文回落成「全局」不算意图
  writeFavoriteScopePreference(activeScope.value);
  // 列表整体换了一套，选中项跟着回到第一条
  selectedIndex.value = filteredPaths.value.length > 0 ? 0 : -1;
};

// 当过滤结果变动时，纠偏当前选中的索引
watch(filteredPaths, (newList) => {
  if (newList.length === 0) {
    selectedIndex.value = -1;
  } else if (selectedIndex.value >= newList.length || selectedIndex.value < 0) {
    selectedIndex.value = 0;
  }
}, { immediate: true });

const scrollToSelectedItem = () => {
  nextTick(() => {
    if (!listContainerRef.value) return;
    const selectedEl = listContainerRef.value.querySelector(`[data-index="${selectedIndex.value}"]`) as HTMLElement;
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  });
};

const handleSearchKeyDown = (event: KeyboardEvent) => {
  const list = filteredPaths.value;
  if (list.length === 0) {
    if (event.key === 'Escape' || event.code === 'Escape') {
      event.preventDefault();
      closeModal();
    }
    return;
  }

  const isDown = event.key === 'ArrowDown' || event.code === 'ArrowDown';
  const isUp = event.key === 'ArrowUp' || event.code === 'ArrowUp';
  const isEnter = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';
  const isEsc = event.key === 'Escape' || event.code === 'Escape';

  if (isDown) {
    event.preventDefault();
    selectedIndex.value = (selectedIndex.value + 1) % list.length;
    scrollToSelectedItem();
  } else if (isUp) {
    event.preventDefault();
    selectedIndex.value = (selectedIndex.value - 1 + list.length) % list.length;
    scrollToSelectedItem();
  } else if (isEnter) {
    event.preventDefault();
    if (selectedIndex.value >= 0 && selectedIndex.value < list.length) {
      handleItemClick(list[selectedIndex.value]);
    }
  } else if (isEsc) {
    event.preventDefault();
    closeModal();
  }
};

const currentSortBy = computed(() => favoritePathsStore.currentSortBy);

const sortButtonIcon = computed(() => {
  return currentSortBy.value === 'name' ? 'fas fa-sort-alpha-down' : 'fas fa-clock';
});

const toggleSort = () => {
  const newSortBy = currentSortBy.value === 'name' ? 'last_used_at' : 'name';
  favoritePathsStore.setSortBy(newSortBy);
};

const closeModal = () => {
  // 收起收藏夹时把子面板一起关掉，否则浮层没了、迁移面板还孤零零挂在屏幕上
  showTransferModal.value = false;
  emit('close');
};

// 移动端把「点开一个文件收藏」透传回桌面端的父组件（模板里写内联对象类型注解 vue-tsc 会报语法错）
const forwardOpenFavoriteFile = (payload: { path: string; name?: string }) => {
  emit('openFavoriteFile', payload);
};

/** is_file 后端存的是 0/1，兼容一下布尔与字符串 */
const isFileFavorite = (item: FavoritePathItem): boolean => Number(item.is_file) === 1;

const handleItemClick = async (pathItem: FavoritePathItem) => {
  try {
    await favoritePathsStore.markPathAsUsed(pathItem.id, t);
  } catch (error) {
    console.error('Failed to mark path as used:', error);
  }
  // 收藏的是文件 → 直接打开；是目录 → 照旧跳转
  if (isFileFavorite(pathItem)) {
    emit('openFavoriteFile', { path: pathItem.path, name: pathItem.name });
  } else {
    emit('navigateToPath', pathItem.path);
  }
  closeModal();
};

const openAddModal = () => {
  editingPathItem.value = null;
  showAddEditModal.value = true;
};

const openEditModal = (pathItem: FavoritePathItem) => {
  editingPathItem.value = { ...pathItem };
  showAddEditModal.value = true;
};

/** 打开「迁移收藏」面板：源就是当前看的那一组 */
const openTransferModal = () => {
  showTransferModal.value = true;
};

const handleDelete = async (pathItem: FavoritePathItem) => {
  const confirmed = await showConfirmDialog({
    message: t('favoritePaths.confirmDelete', { name: pathItem.name || pathItem.path })
  });
  if (confirmed) {
    try {
      await favoritePathsStore.deleteFavoritePath(pathItem.id, t);
    } catch (error) {
      console.error('Failed to delete favorite path from modal:', error);
    }
  }
};

const isPositioned = ref(false);

const updatePosition = () => {
  if (props.isMobile) return;
  if (!props.triggerElement || !modalContentRef.value) return;

  const triggerRect = props.triggerElement.getBoundingClientRect();
  const modalRect = modalContentRef.value.getBoundingClientRect();

  if (triggerRect.width === 0 && triggerRect.height === 0) return;

  const modalWidth = modalRect.width || 320;
  const modalHeight = modalRect.height || 280;
  const windowHeight = window.innerHeight;
  const windowWidth = window.innerWidth;

  // 1. 水平定位：面包屑按钮多在右侧，优先让弹窗右侧与按钮对齐，避免右侧溢出
  let left = triggerRect.right - modalWidth;
  if (left < PADDING) {
    left = triggerRect.left;
  }
  if (left + modalWidth > windowWidth - PADDING) {
    left = windowWidth - modalWidth - PADDING;
  }
  if (left < PADDING) {
    left = PADDING;
  }

  // 2. 垂直定位：默认优先向下展示（按钮下方）
  let top = triggerRect.bottom + PADDING;
  const spaceBelow = windowHeight - triggerRect.bottom - PADDING;
  const spaceAbove = triggerRect.top - PADDING;

  // 仅在下方空间不足且上方空间更大时才向上展开
  if (top + modalHeight > windowHeight - PADDING) {
    if (spaceAbove >= modalHeight || spaceAbove > spaceBelow) {
      top = Math.max(PADDING, triggerRect.top - modalHeight - PADDING);
    } else {
      top = Math.max(PADDING, windowHeight - modalHeight - PADDING);
    }
  }

  modalStyle.value = {
    position: 'fixed',
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  };
  isPositioned.value = true;
};

const handleClickOutside = (event: MouseEvent) => {
  if (props.isMobile) return;
  if (props.triggerElement && props.triggerElement.contains(event.target as Node)) {
    return;
  }
  if (modalContentRef.value && !modalContentRef.value.contains(event.target as Node)) {
    // 打开子面板（编辑表单 / 迁移面板）时，点它们内部不该把收藏夹一起收掉
    if (!showAddEditModal.value && !showTransferModal.value) { 
      closeModal();
    }
  }
};

watch(() => props.isVisible, (newValue: boolean) => {
  if (newValue) {
    searchTerm.value = '';
    activeScope.value = resolveInitialFavoriteScope(props.hostUuid);
    selectedIndex.value = filteredPaths.value.length > 0 ? 0 : -1;
    isPositioned.value = false;
    if (!props.isMobile) {
      document.addEventListener('mousedown', handleClickOutside);
      nextTick(() => {
        updatePosition();
        window.addEventListener('resize', updatePosition);
        searchInputRef.value?.focus();
      });
    }
  } else {
    isPositioned.value = false;
    document.removeEventListener('mousedown', handleClickOutside);
    window.removeEventListener('resize', updatePosition);
  }
});

onMounted(() => {
  if (props.isVisible && !props.isMobile) {
    searchTerm.value = ''; 
    activeScope.value = resolveInitialFavoriteScope(props.hostUuid);
    selectedIndex.value = filteredPaths.value.length > 0 ? 0 : -1;
    isPositioned.value = false;
    document.addEventListener('mousedown', handleClickOutside);
    nextTick(() => { 
      updatePosition();
      window.addEventListener('resize', updatePosition);
      searchInputRef.value?.focus();
    });
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside);
  window.removeEventListener('resize', updatePosition);
});
</script>

<template>
  <!-- 移动端：委托给专门的 MobileFavoritePathsModal -->
  <MobileFavoritePathsModal
    v-if="props.isMobile"
    :is-visible="props.isVisible"
    :current-path="props.currentPath"
    :host-uuid="props.hostUuid"
    @close="closeModal"
    @navigate-to-path="(p: string) => emit('navigateToPath', p)"
    @open-favorite-file="forwardOpenFavoriteFile"
  />

  <!-- 桌面端常规绝对定位下拉浮层 (通过 Teleport 挂载到 body，避免被局部容器包含块或尺寸挤压干扰) -->
  <Teleport to="body" v-else>
    <div
      v-if="isVisible"
      ref="modalContentRef"
      :style="modalStyle"
      class="fixed z-[1001] w-72 md:w-80 rounded-md bg-background shadow-lg border border-border/50 max-h-80 flex flex-col overflow-hidden transition-opacity duration-150"
      :class="isPositioned ? 'opacity-100' : 'opacity-0 pointer-events-none'"
    >
      <!-- 作用域切换 + 迁移：切换换下面这份列表，迁移把这一组的收藏搬到别处 -->
      <div class="px-2 pt-2 flex-shrink-0 flex items-center gap-1.5">
        <button
          type="button"
          @click="toggleScope"
          class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium border transition-colors cursor-pointer"
          :class="activeScope === 'host'
            ? 'bg-primary/10 text-primary border-primary/30 hover:bg-primary/20'
            : 'bg-background text-text-secondary border-border hover:bg-primary/10 hover:text-primary'"
        >
          <i :class="activeScope === 'host' ? 'fas fa-server' : 'fas fa-globe'" class="text-[11px]"></i>
          <span>{{ activeScope === 'host' ? t('favoritePaths.scope.host', '本机专属') : t('favoritePaths.scope.global', '全局') }}</span>
          <i class="fas fa-sync-alt text-[9px] opacity-50"></i>
        </button>
        <button
          type="button"
          @click="openTransferModal"
          class="inline-flex items-center justify-center w-7 h-7 rounded-md border border-border bg-background text-text-secondary transition-colors cursor-pointer hover:bg-primary/10 hover:text-primary"
          :title="t('favoritePaths.transfer.title', '迁移收藏')"
        >
          <i class="fas fa-exchange-alt text-[11px]"></i>
        </button>
      </div>

      <!-- Toolbar: Search and Add Button -->
      <div class="p-2 flex-shrink-0 flex items-center gap-2">
        <div class="relative flex-grow">
          <input
            ref="searchInputRef"
            type="text"
            v-model="searchTerm"
            :placeholder="t('favoritePaths.searchPlaceholder', 'Search by name or path...')"
            @keydown="handleSearchKeyDown"
            class="w-full bg-input border border-border rounded-md pl-2.5 pr-2 py-1.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
          />
        </div>
        <button
          @click="toggleSort"
          class="flex items-center justify-center w-8 h-8 bg-background border border-border text-text-secondary rounded-lg text-sm cursor-pointer shadow-sm transition-colors duration-200 ease-in-out hover:bg-primary/10 hover:text-primary focus:outline-none flex-shrink-0"
        >
          <i :class="sortButtonIcon"></i>
        </button>
        <button
          @click="openAddModal"
          class="flex items-center justify-center w-8 h-8 bg-primary text-white border-none rounded-lg text-sm font-semibold cursor-pointer shadow-md transition-colors duration-200 ease-in-out hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary flex-shrink-0"
          :title="t('favoritePaths.addNew', 'Add new favorite path')"
        >
          <i class="fas fa-plus text-base"></i>
        </button>
      </div>

      <!-- Path List -->
      <div ref="listContainerRef" class="overflow-y-auto flex-grow p-1 text-sm select-none">
        <div v-if="favoritePathsStore.isLoading && filteredPaths.length === 0" class="p-3 text-center text-text-secondary">
          {{ t('favoritePaths.loading', 'Loading favorite paths...') }}
        </div>
        <div v-else-if="!favoritePathsStore.isLoading && filteredPaths.length === 0" class="p-3 text-center text-text-secondary">
          {{ searchTerm ? t('favoritePaths.noResults', 'No matching paths found') : t('favoritePaths.noFavorites', 'No favorite paths yet. Add one!') }}
        </div>
        <div
          v-else
          v-for="(favPath, idx) in filteredPaths"
          :key="favPath.id"
          :data-index="idx"
          class="group flex items-center justify-between p-1.5 rounded cursor-pointer transition-colors duration-150 text-foreground"
          :class="[
            idx === selectedIndex
              ? 'bg-primary/15'
              : 'hover:bg-primary/10'
          ]"
          @click="handleItemClick(favPath)"
          @mouseenter="selectedIndex = idx"
        >
          <div class="truncate flex-grow mr-2">
            <span v-if="favPath.name" class="font-medium block truncate text-foreground">
              <i v-if="isFileFavorite(favPath)" class="fas fa-file text-[10px] mr-1 text-text-secondary"></i>{{ favPath.name }}
            </span>
            <span class="text-xs text-text-secondary block truncate font-normal">{{ favPath.path }}</span>
          </div>
          <div class="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              @click.stop="openEditModal(favPath)"
              class="p-1 text-text-secondary hover:text-primary rounded"
              :title="t('common.edit')"
            >
              <i class="fas fa-edit text-xs"></i>
            </button>
            <button
              @click.stop="handleDelete(favPath)"
              class="p-1 text-text-secondary hover:text-red-500 rounded"
              :title="t('common.delete')"
            >
              <i class="fas fa-trash-alt text-xs"></i>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Add/Edit Modal (Desktop) -->
    <AddEditFavoritePathForm
      :is-visible="showAddEditModal"
      :path-data="editingPathItem"
      :current-path="props.currentPath"
      :host-uuid="props.hostUuid"
      :is-mobile="false"
      @close="showAddEditModal = false"
    />

    <!-- 迁移收藏（移动 / 复制到全局或某台主机） -->
    <FavoritePathTransferModal
      :is-visible="showTransferModal"
      :source-scope="activeScope"
      :host-uuid="props.hostUuid"
      :is-mobile="false"
      @close="showTransferModal = false"
    />
  </Teleport>
</template>
