<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import AddConnectionForm from '../components/AddConnectionForm.vue'; 
import MobileDashboard from '../components/MobileDashboard.vue';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { hexToRgba } from '../utils/colorUtils';
import { useConnectionsStore } from '../stores/connections.store';
import { useAuditLogStore } from '../stores/audit.store';
import { useSessionStore } from '../stores/session.store';
import { useTagsStore } from '../stores/tags.store'; 
import type { TagInfo } from '../stores/tags.store'; 

import type { SortField, SortOrder } from '../stores/settings.store'; 
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import type { ConnectionInfo } from '../stores/connections.store';
import { storeToRefs } from 'pinia'; 
import { formatDistanceToNow } from 'date-fns';
import { zhCN, enUS, ja } from 'date-fns/locale';
import type { Locale } from 'date-fns';

const { t, locale } = useI18n();
const router = useRouter();
const { isMobile } = useDeviceDetection();
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1024);

const handleResize = () => {
  windowWidth.value = window.innerWidth;
};

const isMobileMode = computed(() => isMobile.value || windowWidth.value < 768);

const connectionsStore = useConnectionsStore();
const auditLogStore = useAuditLogStore();
const sessionStore = useSessionStore();
const tagsStore = useTagsStore(); 


const { connections, isLoading: isLoadingConnections } = storeToRefs(connectionsStore);
const { logs: auditLogs, isLoading: isLoadingLogs, totalLogs } = storeToRefs(auditLogStore);
const { tags, isLoading: isLoadingTags } = storeToRefs(tagsStore); 



const getConnectionCardStyle = (backgroundColor?: string | null) => {
  if (!backgroundColor) return {};
  return {
    '--conn-card-bg': hexToRgba(backgroundColor, 0.14),
    '--conn-card-hover-bg': hexToRgba(backgroundColor, 0.22),
    '--conn-card-border': hexToRgba(backgroundColor, 0.32),
    backgroundColor: 'var(--conn-card-bg)',
    borderColor: 'var(--conn-card-border)',
  };
};

const LS_SORT_BY_KEY = 'dashboard_connections_sort_by';
const LS_SORT_ORDER_KEY = 'dashboard_connections_sort_order';
const LS_FILTER_TAG_KEY = 'dashboard_connections_filter_tag'; 

// Initialize with localStorage values or defaults
const localSortBy = ref<SortField>(localStorage.getItem(LS_SORT_BY_KEY) as SortField || 'last_connected_at');
const localSortOrder = ref<SortOrder>(localStorage.getItem(LS_SORT_ORDER_KEY) as SortOrder || 'desc');
// +++ 初始化标签筛选状态，从 localStorage 读取，注意类型转换 (修正 ref 初始化) +++
const getInitialSelectedTagId = (): number | null => {
  const storedValue = localStorage.getItem(LS_FILTER_TAG_KEY);
  // 如果存储的值是 'null' 字符串或空，则返回 null，否则解析为数字
  return storedValue && storedValue !== 'null' ? parseInt(storedValue, 10) : null;
};
const selectedTagId = ref<number | null>(getInitialSelectedTagId());
const searchQuery = ref('');

// +++ 控制添加/编辑表单的显示状态 +++
const showAddEditConnectionForm = ref(false);
const connectionToEdit = ref<ConnectionInfo | null>(null);

const maxRecentLogs = 5;
 
const sortOptions: { value: SortField; labelKey: string }[] = [
  { value: 'last_connected_at', labelKey: 'dashboard.sortOptions.lastConnected' },
  { value: 'name', labelKey: 'dashboard.sortOptions.name' },
  { value: 'type', labelKey: 'dashboard.sortOptions.type' },
  { value: 'updated_at', labelKey: 'dashboard.sortOptions.updated' },
  { value: 'created_at', labelKey: 'dashboard.sortOptions.created' },
];

// +++ 修改计算属性，先筛选再排序 +++
const filteredAndSortedConnections = computed(() => {
  const sortBy = localSortBy.value;
  const sortOrderVal = localSortOrder.value;
  const factor = sortOrderVal === 'desc' ? -1 : 1;
  const filterTagId = selectedTagId.value;
  const query = searchQuery.value.toLowerCase().trim(); // +++ 获取搜索查询 +++
 
  // 1. Filter by selected tag
  let filteredByTag = filterTagId === null
    ? [...connections.value] // No tag selected, show all
    : connections.value.filter(conn => conn.tag_ids?.includes(filterTagId));
 
  // 2. Filter by search query
  let searchedConnections = filteredByTag;
  if (query) {
    searchedConnections = filteredByTag.filter(conn => {
      const nameMatch = conn.name?.toLowerCase().includes(query);
      const usernameMatch = conn.username?.toLowerCase().includes(query);
      const hostMatch = conn.host?.toLowerCase().includes(query);
      const portMatch = conn.port?.toString().includes(query);
      return nameMatch || usernameMatch || hostMatch || portMatch;
    });
  }
 
  // 3. Sort the searched connections
  return searchedConnections.sort((a, b) => {
    let valA: any;
    let valB: any;

    switch (sortBy) {
      case 'name':
        valA = a.name || '';
        valB = b.name || '';
        return valA.localeCompare(valB) * factor;
      case 'type':
        valA = a.type || '';
        valB = b.type || '';
        return valA.localeCompare(valB) * factor;
      case 'created_at':
        valA = a.created_at ?? 0;
        valB = b.created_at ?? 0;
        return (valA - valB) * factor;
      case 'updated_at':
        valA = a.updated_at ?? 0;
        valB = b.updated_at ?? 0;
        return (valA - valB) * factor;
      case 'last_connected_at':
        valA = a.last_connected_at ?? (sortOrderVal === 'desc' ? -Infinity : Infinity);
        valB = b.last_connected_at ?? (sortOrderVal === 'desc' ? -Infinity : Infinity);
        if (valA === valB) return 0;
        if (valA < valB) return -1 * factor;
        return 1 * factor;
      default:
        return 0;
    }
  });
});

const recentAuditLogs = computed(() => {
  return auditLogs.value.slice(0, maxRecentLogs);
});

onMounted(async () => {
  // Load saved preferences from localStorage (already done during ref initialization)

  // Fetch connections if not already loaded
  if (connections.value.length === 0) {
    try {
      await connectionsStore.fetchConnections();
    } catch (error) {
      console.error("加载连接列表失败:", error);
    }
  }

  // Fetch recent audit logs
  try {
    await auditLogStore.fetchLogs({
        page: 1,
        limit: maxRecentLogs,
        sortOrder: 'desc',
        isDashboardRequest: true
    });
  } catch (error) {
    console.error("加载审计日志失败:", error);
  }

  // +++ Fetch tags for filtering +++
  try {
    await tagsStore.fetchTags();
  } catch (error) {
    console.error("加载标签列表失败:", error);
  }
  window.addEventListener('resize', handleResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
});

const connectTo = (connection: ConnectionInfo) => {
  sessionStore.handleConnectRequest(connection);
};

const toggleSortOrder = () => {
  // Only update the local sort order state
  localSortOrder.value = localSortOrder.value === 'asc' ? 'desc' : 'asc';
};

const isAscending = computed(() => localSortOrder.value === 'asc'); // Use local state

// Watch for changes in local sort state and save to localStorage
watch(localSortBy, (newValue) => {
  localStorage.setItem(LS_SORT_BY_KEY, newValue);
});

watch(localSortOrder, (newValue) => {
  localStorage.setItem(LS_SORT_ORDER_KEY, newValue);
});

// +++ Watch for changes in selected tag and save to localStorage +++
watch(selectedTagId, (newValue) => {
  // Store 'null' as a string or the number
  localStorage.setItem(LS_FILTER_TAG_KEY, newValue === null ? 'null' : String(newValue));
});

const dateFnsLocales: Record<string, Locale> = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'ja-JP': ja,
  // 主语言回退
  'en': enUS,
  'zh': zhCN,
  'ja': ja,
};

// 修正函数签名，接受 number | null | undefined
const formatRelativeTime = (timestampInSeconds: number | null | undefined): string => {
  if (!timestampInSeconds) return t('connections.status.never');
  try {
    // 将秒级时间戳转换为毫秒级
    const timestampInMs = timestampInSeconds * 1000;
    // 检查转换后的值是否有效
    if (isNaN(timestampInMs)) {
        console.warn(`[Dashboard] Invalid timestamp received: ${timestampInSeconds}`);
        return String(timestampInSeconds); // 返回原始值或错误提示
    }
    const date = new Date(timestampInMs);

    const currentI18nLocale = locale.value; // 获取 vue-i18n 当前 locale (e.g., 'zh-CN')
    const langPart = currentI18nLocale.split('-')[0]; // 获取主语言部分 (e.g., 'zh')

    // 1. 尝试精确匹配 (e.g., 'zh-CN' -> zhCN)
    let targetDateFnsLocale = dateFnsLocales[currentI18nLocale];

    // 2. 如果无精确匹配，尝试匹配主语言 (e.g., 'zh' -> zhCN)
    if (!targetDateFnsLocale) {
      targetDateFnsLocale = dateFnsLocales[langPart];
    }

    // 3. 如果仍然找不到，回退到默认 enUS
    if (!targetDateFnsLocale) {
      console.warn(`[Dashboard] date-fns locale not found for ${currentI18nLocale} or ${langPart}. Falling back to en-US.`);
      targetDateFnsLocale = enUS; // 默认回退到 enUS
    }

    return formatDistanceToNow(date, { addSuffix: true, locale: targetDateFnsLocale });
  } catch (e) {
    console.error("格式化日期失败:", e);
    return String(timestampInSeconds); // 出错时返回原始字符串
  }
};

const getActionTranslation = (actionType: string): string => {
  // 尝试从 i18n 获取翻译，如果找不到则返回原始 actionType
  const key = `auditLog.actions.${actionType}`;
  const translated = t(key);
  // 如果翻译结果等于 key 本身，说明没有找到翻译
  return translated === key ? actionType : translated;
};

// 辅助函数：判断活动类型是否表示失败
const isFailedAction = (actionType: string): boolean => {
  const lowerCaseAction = actionType.toLowerCase();
  // 检查常见的失败关键词
  return lowerCaseAction.includes('fail') || lowerCaseAction.includes('error') || lowerCaseAction.includes('denied');
};

// +++ 恢复：根据 tag_ids 获取标签名称数组 +++
const getTagNames = (tagIds: number[] | undefined): string[] => {
  if (!tagIds || tagIds.length === 0) {
    return [];
  }
  const allTags = tags.value as TagInfo[];
  return tagIds
    .map(id => allTags.find(tag => tag.id === id)?.name)
    .filter((name): name is string => !!name); // 过滤掉未找到的标签并确保类型为 string
};

// +++ 打开添加表单 +++
const openAddConnectionForm = () => {
  connectionToEdit.value = null;
  showAddEditConnectionForm.value = true;
};

// +++ 打开编辑表单 +++
const openEditConnectionForm = (conn: ConnectionInfo) => {
  connectionToEdit.value = conn;
  showAddEditConnectionForm.value = true;
};

// +++ 处理表单关闭事件 +++
const handleFormClose = () => {
  showAddEditConnectionForm.value = false;
  connectionToEdit.value = null; // 清除编辑状态
};

// +++ 处理连接添加/更新成功事件 +++
const handleConnectionModified = async () => {
  showAddEditConnectionForm.value = false;
  connectionToEdit.value = null;
  await connectionsStore.fetchConnections(); // 重新加载连接列表
};
 
// --- 移除 selectTagFilter 函数 ---
 
</script>

<template>
  <!-- 移动端特化版本 -->
  <MobileDashboard v-if="isMobileMode" />

  <!-- 桌面端视图（保持原逻辑与布局 100% 不变） -->
  <div v-else class="p-4 md:p-6 lg:p-8 bg-background text-foreground">
    <h1 class="text-2xl font-semibold mb-6">{{ t('nav.dashboard') }}</h1>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:items-start">

      <!-- ==================== Left: Connection List Card ==================== -->
      <div
        class="text-card-foreground rounded-2xl overflow-hidden border border-border/80 shadow-md flex flex-col min-h-[440px]"
        style="background-color: var(--card-bg-color, var(--header-bg-color));"
      >
        <!-- 顶部工具栏 Toolbar -->
        <div class="px-4 py-3.5 border-b border-border/70 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-header/40 backdrop-blur-xs flex-shrink-0">
          <div class="flex items-center gap-2.5">
            <div class="w-7 h-7 rounded-lg bg-primary/15 border border-primary/25 flex items-center justify-center text-primary text-xs">
              <i class="fas fa-server"></i>
            </div>
            <div class="flex items-center gap-2">
              <h2 class="text-sm md:text-base font-bold text-foreground tracking-tight leading-none">
                {{ t('dashboard.connectionList', '连接列表') }}
              </h2>
              <span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-primary/15 text-primary border border-primary/20">
                {{ filteredAndSortedConnections.length }}
              </span>
            </div>
          </div>

          <div class="w-full sm:w-auto flex flex-wrap sm:flex-nowrap items-stretch sm:items-center gap-2">
            <!-- 搜索框 -->
            <div class="relative w-full sm:w-44">
              <i class="fas fa-search absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary text-xs pointer-events-none"></i>
              <input
                type="text"
                v-model="searchQuery"
                :placeholder="t('dashboard.searchConnectionsPlaceholder', '搜索连接...')"
                class="h-8 pl-7 pr-2.5 text-xs border border-border/70 rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary w-full shadow-2xs transition-all"
                style="background-color: var(--app-bg-color);"
              />
            </div>

            <div class="flex items-center gap-2">
              <!-- 标签筛选下拉 -->
              <select
                v-model="selectedTagId"
                class="h-8 px-2.5 text-xs border border-border/70 rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 appearance-none bg-no-repeat bg-right pr-7 shadow-2xs cursor-pointer transition-all"
                style="background-color: var(--app-bg-color); background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.5rem center; background-size: 14px 10px;"
                aria-label="Filter connections by tag"
                :disabled="isLoadingTags"
              >
                <option :value="null">{{ t('dashboard.filterTags.all', '所有标签') }}</option>
                <option v-if="isLoadingTags" disabled>{{ t('common.loading') }}</option>
                <option v-for="tag in (tags as TagInfo[])" :key="tag.id" :value="tag.id">
                  {{ tag.name }}
                </option>
              </select>

              <!-- 排序下拉 -->
              <select
                v-model="localSortBy"
                class="h-8 px-2.5 text-xs border border-border/70 rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 appearance-none bg-no-repeat bg-right pr-7 shadow-2xs cursor-pointer transition-all"
                style="background-color: var(--app-bg-color); background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.5rem center; background-size: 14px 10px;"
                aria-label="Sort connections by"
              >
                <option v-for="option in sortOptions" :key="option.value" :value="option.value">
                  {{ t(option.labelKey, option.value.replace('_', ' ')) }}
                </option>
              </select>

              <!-- 排序顺序切换按钮 -->
              <button
                @click="toggleSortOrder"
                class="h-8 w-8 border border-border/70 rounded-xl text-text-secondary hover:text-foreground hover:bg-header/60 focus:outline-none focus:ring-2 focus:ring-primary/40 flex items-center justify-center transition-all shadow-2xs cursor-pointer"
                style="background-color: var(--app-bg-color);"
                :aria-label="isAscending ? t('common.sortAscending') : t('common.sortDescending')"
                :title="isAscending ? t('common.sortAscending') : t('common.sortDescending')"
              >
                <i :class="['fas', isAscending ? 'fa-arrow-up-a-z' : 'fa-arrow-down-z-a', 'text-xs']"></i>
              </button>

              <!-- 新建连接按钮 -->
              <button
                @click="openAddConnectionForm"
                :title="t('connections.addConnection', '新建连接')"
                class="h-8 px-2.5 bg-primary text-white rounded-xl shadow-xs hover:bg-primary-hover active:scale-95 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all flex items-center gap-1.5 text-xs font-semibold cursor-pointer shrink-0"
              >
                <i class="fas fa-plus text-[10px]"></i>
                <span class="hidden sm:inline">{{ t('connections.new', '新建') }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 中间内容下沉画布：深沉深黑基底 -->
        <div
          class="flex-1 p-4 overflow-y-auto space-y-3"
          style="background-color: var(--app-bg-color);"
        >
          <div v-if="isLoadingConnections && filteredAndSortedConnections.length === 0" class="text-center text-text-secondary py-8">
            <i class="fas fa-spinner fa-spin text-primary mr-2"></i>{{ t('common.loading') }}
          </div>
          <ul v-else-if="filteredAndSortedConnections.length > 0" class="space-y-2.5">
            <li
              v-for="conn in filteredAndSortedConnections"
              :key="conn.id"
              class="flex items-center justify-between p-3.5 rounded-xl transition-all duration-150 border shadow-xs"
              :class="conn.background_color ? 'connection-colored-card' : 'border-border/70 hover:border-primary/40'"
              :style="conn.background_color ? getConnectionCardStyle(conn.background_color) : { backgroundColor: 'var(--card-bg-color, var(--header-bg-color))' }"
            >
              <div class="flex-grow mr-4 overflow-hidden">
                <span class="font-semibold text-xs md:text-sm block truncate flex items-center" :title="conn.name || ''">
                  <i
                    :class="[
                      'fas',
                      conn.type === 'VNC' ? 'fa-plug' : (conn.type === 'RDP' ? 'fa-desktop' : 'fa-server'),
                      'mr-2 w-4 text-center',
                      conn.background_color ? '' : 'text-primary'
                    ]"
                    :style="conn.background_color ? { color: conn.background_color } : {}"
                  ></i>
                  <span class="text-foreground">{{ conn.name || conn.host || t('connections.unnamedFallback', '未命名连接') }}</span>
                </span>
                <span class="text-xs text-text-secondary font-mono block truncate mt-0.5" :title="`${conn.username}@${conn.host}:${conn.port}`">
                  {{ conn.username }}@{{ conn.host }}:{{ conn.port }}
                </span>
                <span class="text-[11px] text-text-secondary/80 block mt-1">
                  {{ t('dashboard.lastConnected', '上次连接:') }} {{ formatRelativeTime(conn.last_connected_at) }}
                </span>
                <div v-if="getTagNames(conn.tag_ids).length > 0" class="flex flex-wrap gap-1 mt-1.5">
                  <span
                    v-for="tagName in getTagNames(conn.tag_ids)"
                    :key="tagName"
                    class="px-2 py-0.5 text-[10px] rounded-lg border border-border/60 text-text-secondary font-medium"
                    style="background-color: var(--app-bg-color);"
                  >
                    {{ tagName }}
                  </span>
                </div>
              </div>

              <div class="flex items-center space-x-2 flex-shrink-0">
                <button
                  @click="openEditConnectionForm(conn)"
                  class="h-7 w-7 rounded-lg text-text-secondary hover:text-foreground border border-border/70 hover:bg-header/70 flex items-center justify-center transition-all cursor-pointer shadow-2xs"
                  style="background-color: var(--app-bg-color);"
                  :title="t('common.edit', '编辑')"
                >
                  <i class="fas fa-pencil-alt text-xs"></i>
                </button>
                <button
                  @click="connectTo(conn)"
                  class="h-7 px-3 bg-primary text-white rounded-lg shadow-xs hover:bg-primary-hover active:scale-95 transition-all text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <i class="fas fa-play text-[10px]"></i>
                  <span>{{ t('connections.actions.connect', '连接') }}</span>
                </button>
              </div>
            </li>
          </ul>
          <div v-else-if="!isLoadingConnections && searchQuery && filteredAndSortedConnections.length === 0" class="text-center text-text-secondary py-8 text-xs">
            {{ t('dashboard.noConnectionsMatchSearch', '没有连接匹配搜索条件') }}
          </div>
          <div v-else-if="!isLoadingConnections && selectedTagId !== null && filteredAndSortedConnections.length === 0" class="text-center text-text-secondary py-8 text-xs">
            {{ t('dashboard.noConnectionsWithTag', '该标签下没有连接记录') }}
          </div>
          <div v-else class="text-center text-text-secondary py-8 text-xs">
            {{ t('dashboard.noConnections', '没有连接记录') }}
          </div>
        </div>
      </div>

      <!-- ==================== Right: Recent Activity Card ==================== -->
      <div
        class="text-card-foreground rounded-2xl overflow-hidden border border-border/80 shadow-md flex flex-col min-h-[440px]"
        style="background-color: var(--card-bg-color, var(--header-bg-color));"
      >
        <!-- 顶部工具栏 Toolbar -->
        <div class="px-4 py-3.5 border-b border-border/70 flex items-center justify-between bg-header/40 backdrop-blur-xs flex-shrink-0">
          <div class="flex items-center gap-2.5">
            <div class="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/25 flex items-center justify-center text-amber-500 text-xs">
              <i class="fas fa-history"></i>
            </div>
            <h2 class="text-sm md:text-base font-bold text-foreground tracking-tight leading-none">
              {{ t('dashboard.recentActivity', '最近活动') }}
            </h2>
          </div>
        </div>

        <!-- 中间内容下沉画布：深沉深黑基底 -->
        <div
          class="flex-1 p-4 overflow-y-auto space-y-2.5"
          style="background-color: var(--app-bg-color);"
        >
          <div v-if="isLoadingLogs && recentAuditLogs.length === 0" class="text-center text-text-secondary py-8">
            <i class="fas fa-spinner fa-spin text-primary mr-2"></i>{{ t('common.loading') }}
          </div>
          <ul v-else-if="recentAuditLogs.length > 0" class="space-y-2.5">
            <li
              v-for="log in recentAuditLogs"
              :key="log.id"
              class="p-3.5 rounded-xl border border-border/70 hover:border-border transition-all duration-150 shadow-xs"
              style="background-color: var(--card-bg-color, var(--header-bg-color));"
            >
              <div class="flex justify-between items-start mb-1.5">
                <span class="font-semibold text-xs md:text-sm" :class="isFailedAction(log.action_type) ? 'text-error' : 'text-foreground'">
                  {{ getActionTranslation(log.action_type) }}
                </span>
                <span class="text-[11px] text-text-secondary flex-shrink-0 ml-2 font-mono">
                  {{ formatRelativeTime(log.timestamp) }}
                </span>
              </div>
              <p class="text-xs text-text-secondary break-words font-mono leading-relaxed">{{ log.details }}</p>
            </li>
          </ul>
          <div v-else class="text-center text-text-secondary py-8 text-xs">
            {{ t('dashboard.noRecentActivity', '没有最近活动记录') }}
          </div>
        </div>

        <!-- 底部 Footer 操作栏 -->
        <div class="px-4 py-3 border-t border-border/70 bg-header/40 backdrop-blur-xs flex items-center justify-end flex-shrink-0">
          <RouterLink
            :to="{ name: 'AuditLogs' }"
            class="text-xs font-semibold text-primary hover:text-primary-hover flex items-center gap-1.5 transition-colors group cursor-pointer"
          >
            <span>{{ t('dashboard.viewFullAuditLog', '查看完整审计日志') }}</span>
            <i class="fas fa-arrow-right text-[10px] transform group-hover:translate-x-0.5 transition-transform"></i>
          </RouterLink>
        </div>
      </div>

    </div>
    <!-- Add/Edit Connection Form Modal -->
    <AddConnectionForm
      v-if="showAddEditConnectionForm"
      :connectionToEdit="connectionToEdit"
      :is-mobile="false"
      @close="handleFormClose"
      @connection-added="handleConnectionModified"
      @connection-updated="handleConnectionModified"
    />
  </div>
</template>
<style scoped>
.connection-colored-card:hover {
  background-color: var(--conn-card-hover-bg, var(--conn-card-bg)) !important;
  border-color: var(--conn-card-border) !important;
}
</style>
