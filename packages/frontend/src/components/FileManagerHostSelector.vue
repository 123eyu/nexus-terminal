<script setup lang="ts">
/**
 * 文件管理器左上角的「当前主机」选择器。
 *
 * 位置刻意放在面包屑行最左端而不是工具栏：主机和路径同属「我在哪」，
 * 而工具栏已经塞了十个控件，再加一个下拉会把右侧的文字标签挤成图标。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useConnectionsStore } from '../stores/connections.store';
import { useFileManagerHostsStore } from '../stores/fileManagerHosts.store';
import { useSessionStore } from '../stores/session.store';

const props = defineProps<{
  /** 文件管理器 pane 的实例 ID，与 LayoutRenderer 传下来的一致 */
  paneId: string;
  /** 当前这份实例正在显示的连接 ID */
  currentConnectionId: string;
  isConnected: boolean;
  isMobile?: boolean;
}>();

const { t } = useI18n();
const connectionsStore = useConnectionsStore();
const hostsStore = useFileManagerHostsStore();
const sessionStore = useSessionStore();

const open = ref(false);
const query = ref('');
const rootRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);

const isPinned = computed(() => hostsStore.isBound(props.paneId));

const activeConnectionId = computed(() => {
  const activeSession = sessionStore.activeSession;
  return activeSession ? String(activeSession.connectionId) : null;
});

const currentConnection = computed(() => {
  const id = Number(props.currentConnectionId);
  return connectionsStore.connections.find(c => Number(c.id) === id) || null;
});

const label = computed(() => currentConnection.value?.name || t('fileManager.hostSelector.placeholder'));

/** 能开 SFTP 的只有 SSH 连接 */
const candidates = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  return connectionsStore.connections
    .filter(c => c.type === 'SSH')
    .filter(c => {
      if (!keyword) return true;
      return c.name.toLowerCase().includes(keyword)
        || c.host.toLowerCase().includes(keyword)
        || (c.username || '').toLowerCase().includes(keyword);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
});

const close = () => {
  open.value = false;
  query.value = '';
};

const toggle = async () => {
  if (open.value) {
    close();
    return;
  }
  open.value = true;
  if (connectionsStore.connections.length === 0) {
    connectionsStore.fetchConnections().catch((err) => console.error('[HostSelector] 拉取连接列表失败:', err));
  }
  await nextTick();
  searchInputRef.value?.focus();
};

const selectConnection = (connectionId: number) => {
  if (!hostsStore.bind(props.paneId, connectionId)) {
    // 连接列表还没到位 / 建会话失败时也会记下绑定，这里只提示一下不必阻断
    console.warn(`[HostSelector] 连接 ${connectionId} 的会话尚未就绪，稍后会自动重试`);
  }
  close();
};

const followActiveSession = async () => {
  close();
  await hostsStore.release(props.paneId);
};

const onDocumentPointerDown = (event: PointerEvent) => {
  if (!open.value) return;
  const root = rootRef.value;
  if (root && event.target instanceof Node && root.contains(event.target)) return;
  close();
};

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && open.value) {
    event.stopPropagation();
    close();
  }
};

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onKeydown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onKeydown, true);
});

// 面板被切成别的 pane / 换实例时把展开状态收掉，避免残留在下一个 pane 上
watch(() => props.paneId, () => close());
</script>

<template>
  <div ref="rootRef" class="relative flex-shrink-0 self-stretch flex items-center">
    <button
      type="button"
      class="group flex items-center gap-1.5 h-6 max-w-[190px] pl-1.5 pr-1 rounded text-xs transition-colors cursor-pointer select-none"
      :class="isPinned
        ? 'text-primary bg-primary/10 hover:bg-primary/20'
        : 'text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10'"
      :title="t('fileManager.hostSelector.tooltip', { host: currentConnection?.host || '' })"
      @click.stop="toggle"
    >
      <span
        class="w-1.5 h-1.5 rounded-full flex-shrink-0"
        :class="isConnected ? 'bg-emerald-500' : 'bg-text-secondary/40'"
      ></span>
      <span class="truncate">{{ label }}</span>
      <i v-if="isPinned" class="fas fa-thumbtack text-[8px] flex-shrink-0 opacity-70"></i>
      <i class="fas fa-caret-down text-[9px] flex-shrink-0 opacity-60"></i>
    </button>

    <div
      v-if="open"
      class="absolute left-0 top-full mt-1 z-50 w-64 max-h-80 flex flex-col rounded-md border border-border bg-background shadow-lg overflow-hidden"
    >
      <div class="p-1.5 border-b border-border/60">
        <input
          ref="searchInputRef"
          v-model="query"
          type="text"
          class="w-full h-7 px-2 rounded text-xs bg-input text-foreground border border-border focus:outline-none focus:ring-1 focus:ring-primary select-text"
          :placeholder="t('fileManager.hostSelector.searchPlaceholder')"
          @keydown.esc.stop="close"
        />
      </div>

      <ul class="flex-grow overflow-y-auto py-1">
        <li v-if="candidates.length === 0" class="px-2 py-3 text-xs text-text-secondary text-center">
          {{ t('fileManager.hostSelector.empty') }}
        </li>
        <li v-for="connection in candidates" :key="connection.id">
          <button
            type="button"
            class="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors cursor-pointer"
            :class="String(connection.id) === props.currentConnectionId
              ? 'bg-primary/10 text-primary'
              : 'text-foreground hover:bg-black/5 dark:hover:bg-white/10'"
            @click.stop="selectConnection(connection.id)"
          >
            <i class="fas fa-server text-[10px] flex-shrink-0 opacity-60"></i>
            <span class="truncate flex-grow">{{ connection.name }}</span>
            <span class="text-[10px] text-text-secondary flex-shrink-0 truncate max-w-[90px]">{{ connection.host }}</span>
            <i
              v-if="String(connection.id) === props.currentConnectionId"
              class="fas fa-check text-[10px] flex-shrink-0"
            ></i>
          </button>
        </li>
      </ul>

      <div v-if="isPinned" class="border-t border-border/60 p-1">
        <button
          type="button"
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-text-secondary hover:text-foreground hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
          @click.stop="followActiveSession"
        >
          <i class="fas fa-link-slash text-[10px]"></i>
          <span class="truncate">{{ t('fileManager.hostSelector.followActive') }}</span>
          <span v-if="activeConnectionId" class="text-[10px] opacity-60 ml-auto truncate max-w-[80px]">
            {{ sessionStore.activeSession?.connectionName }}
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
