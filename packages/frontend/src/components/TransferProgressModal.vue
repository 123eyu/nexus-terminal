<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import apiClient from '../utils/apiClient';
import { useConnectionsStore } from '../stores/connections.store';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { resolveTransferTone, isBusyTransferStatus } from '../utils/transfer-status';
import TransferStatusBadge from './common/TransferStatusBadge.vue';
import MobileTransferProgressModal from './MobileTransferProgressModal.vue';

interface Props {
  visible: boolean;
  isMobile?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isMobile: undefined,
});
const emit = defineEmits(['update:visible']);
const { t, locale } = useI18n();
const connectionsStore = useConnectionsStore();
const { isMobile: detectedMobile } = useDeviceDetection();

/** 一次最多展示多少条任务（后端可能留着历史记录） */
const MAX_VISIBLE_TASKS = 5;

// 视口尺寸响应式监听
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1024);
const handleResize = () => {
  windowWidth.value = window.innerWidth;
};

onMounted(() => {
  window.addEventListener('resize', handleResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
});

const isMobileMode = computed(() => {
  if (typeof props.isMobile === 'boolean') {
    return props.isMobile;
  }
  return detectedMobile.value || windowWidth.value < 768;
});

// Helper function to get connection name by ID
const getConnectionName = (connectionId: number): string => {
  const connection = connectionsStore.connections?.find((c: any) => c.id === connectionId);
  if (connection && connection.name) {
    return connection.name;
  }
  return t('transferProgressModal.connectionIdFallback', { connectionId }, `连接ID: ${connectionId}`);
};

// 数据结构参考
interface TransferSubTask {
  subTaskId: string;
  connectionId: number;
  sourceItemName: string;
  status: 'queued' | 'connecting' | 'transferring' | 'completed' | 'failed' | 'cancelling' | 'cancelled'; // +++ 新增状态 +++
  progress?: number; // 0-100
  message?: string;
  transferMethodUsed?: 'rsync' | 'scp';
}

interface TransferTask {
  taskId: string;
  status: 'queued' | 'in-progress' | 'completed' | 'failed' | 'partially-completed' | 'cancelling' | 'cancelled'; // +++ 新增状态 +++
  createdAt: string | Date;
  updatedAt: string | Date;
  subTasks: TransferSubTask[];
  overallProgress?: number;
  sourceConnectionId?: number;
  remoteTargetPath?: string;
}

const transferTasks = ref<TransferTask[]>([]);
const isLoading = ref(false);
const errorLoading = ref<string | null>(null);
/** 至少成功拉取过一次 —— 轮询期间的 isLoading 不能被当成「空态」 */
const hasLoadedOnce = ref(false);
const pollingIntervalId = ref<number | null>(null);

// Computed property for sorted and limited tasks
const displayedTasks = computed(() => {
  // Create a new array to avoid mutating the original transferTasks ref directly during sort
  return [...transferTasks.value]
    .sort((a, b) => {
      // Ensure createdAt is treated as a Date object for comparison
      const dateA = new Date(a.createdAt);
      const dateB = new Date(b.createdAt);
      return dateB.getTime() - dateA.getTime(); // For descending order (newest first)
    })
    .slice(0, MAX_VISIBLE_TASKS); // Limit to the 5 newest tasks
});

// 计算正在进行中的任务数量
const activeTasksCount = computed(() => {
  return transferTasks.value.filter(t => isBusyTransferStatus(t.status)).length;
});

/** 头部副标题：有多少条就明说，别让用户以为旧任务丢了 */
const subtitleText = computed(() => {
  const total = transferTasks.value.length;
  if (total > MAX_VISIBLE_TASKS) {
    return t(
      'transferProgressModal.subtitleTruncated',
      { shown: MAX_VISIBLE_TASKS, total },
      `显示最近 ${MAX_VISIBLE_TASKS} 条（共 ${total} 条）`
    );
  }
  return t('transferProgressModal.subtitle', '最近的文件传输任务');
});

const fetchTransferTasks = async () => {
  isLoading.value = true;
  errorLoading.value = null;
  try {
    const response = await apiClient.get<{ data: TransferTask[] }>('/transfers/status');
    const rawTasks = Array.isArray(response.data.data) ? response.data.data : (Array.isArray(response.data) ? response.data : []);
    transferTasks.value = rawTasks.map(task => {
      // 优先信任后端已经是 'cancelled' 或其他最终状态
      if (['completed', 'failed', 'cancelled', 'partially-completed'].includes(task.status)) {
        return task;
      }
      // 对于仍在进行中或正在取消中的任务
      if (['in-progress', 'cancelling', 'queued', 'connecting', 'transferring'].includes(task.status)) {
        // 如果它有子任务，并且所有子任务都已是 'cancelled'
        if (task.subTasks && task.subTasks.length > 0 && task.subTasks.every((st: TransferSubTask) => st.status === 'cancelled')) {
          // 则认为主任务也应该被标记为 'cancelled'
          // 这有助于处理后端主任务状态更新延迟或遗漏的情况
          return { ...task, status: 'cancelled' as TransferTask['status'] };
        }
        // 如果任务状态是 'cancelling' 但它没有子任务 (或子任务列表为空)
        // 这种情况也应视为已取消
        else if (task.status === 'cancelling' && (!task.subTasks || task.subTasks.length === 0)) {
            return { ...task, status: 'cancelled' as TransferTask['status'] };
        }
      }
      return task;
    });
    hasLoadedOnce.value = true;

    // 失败的任务自动展开子任务：错误信息藏在折叠区里等于没报错
    for (const task of transferTasks.value) {
      if (!isFailedLike(task.status) || autoOpenedTaskIds.includes(task.taskId)) continue;
      autoOpenedTaskIds.push(task.taskId);
      if (!openTaskIds.value.includes(task.taskId)) openTaskIds.value.push(task.taskId);
    }
  } catch (error: any) {
    console.error("Failed to fetch transfer tasks:", error);
    errorLoading.value = error.response?.data?.message || error.message || t('transferProgressModal.error.unknown', '未知错误');
  } finally {
    isLoading.value = false;
  }
};

const isFailedLike = (status: string) => status === 'failed' || status === 'partially-completed';

const getDisplayStatus = (status: string): string => {
  const statusKeyMap: Record<string, string> = {
    'queued': 'transferProgressModal.status.queued',
    'in-progress': 'transferProgressModal.status.inProgress',
    'completed': 'transferProgressModal.status.completed',
    'failed': 'transferProgressModal.status.failed',
    'partially-completed': 'transferProgressModal.status.partiallyCompleted',
    'connecting': 'transferProgressModal.status.connecting',
    'transferring': 'transferProgressModal.status.transferring',
    'cancelling': 'transferProgressModal.status.cancelling',
    'cancelled': 'transferProgressModal.status.cancelled',
  };
  // 提供一个默认的回退文本，以防i18n key缺失
  const defaultText = status.charAt(0).toUpperCase() + status.slice(1).replace('-', ' ');
  return t(statusKeyMap[status] || `status.${status}`, defaultText);
};

const formatDate = (dateInput: string | Date): string => {
  if (!dateInput) return '';
  try {
    // +++ 使用 i18n 的 locale 进行日期格式化 +++
    return new Date(dateInput).toLocaleString(locale.value, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch (e) {
    return String(dateInput);
  }
};

// --- 卡片展示用的小工具 ---

/** 主标题：优先取第一个子任务的条目名（通常就是用户点的那一项） */
const getTaskFileName = (task: TransferTask): string => {
  if (task.subTasks && task.subTasks.length > 0 && task.subTasks[0].sourceItemName) {
    return task.subTasks[0].sourceItemName;
  }
  return t('transferProgressModal.unknownFileName', '[文件名未知]');
};

/** 源服务器名（无 sourceConnectionId 时视为本机） */
const getTaskSourceName = (task: TransferTask): string => {
  if (task.sourceConnectionId) {
    return getConnectionName(task.sourceConnectionId);
  }
  return t('transferProgressModal.localSource', '本机');
};

/** 目标路径（空则回退提示） */
const getTaskTargetPath = (task: TransferTask): string => {
  return task.remoteTargetPath || t('transferProgressModal.unknownTargetPath', '[目标路径未知]');
};

const getTaskIcon = (task: TransferTask): string => {
  if (task.subTasks && task.subTasks.length > 1) return 'fa-layer-group';
  return 'fa-file-alt';
};

/** 一条任务里用到的方法（rsync / scp），去重后展示成小徽标 */
const getTaskMethods = (task: TransferTask): string[] => {
  const methods = new Set<string>();
  for (const st of task.subTasks || []) {
    if (st.transferMethodUsed) methods.add(st.transferMethodUsed);
  }
  return [...methods];
};

const pctValue = (value?: number): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
};

const pctLabel = (value?: number): string => `${Math.round(pctValue(value))}%`;

/** 进度条填充色只取决于色调，和状态徽标保持同一套语义 */
const barToneClass = (status: string): string => `tp-fill--${resolveTransferTone(status)}`;

// --- 子任务折叠状态（失败任务会在轮询时自动展开一次） ---
const openTaskIds = ref<string[]>([]);
const autoOpenedTaskIds: string[] = [];

const isTaskOpen = (taskId: string): boolean => openTaskIds.value.includes(taskId);

const toggleTask = (taskId: string) => {
  const index = openTaskIds.value.indexOf(taskId);
  if (index >= 0) {
    openTaskIds.value.splice(index, 1);
  } else {
    openTaskIds.value.push(taskId);
  }
};

onMounted(() => {
  if (props.visible) {
    fetchTransferTasks();
    if (pollingIntervalId.value === null) {
       pollingIntervalId.value = window.setInterval(fetchTransferTasks, 5000);
    }
  }
});

onUnmounted(() => {
  if (pollingIntervalId.value !== null) {
    clearInterval(pollingIntervalId.value);
    pollingIntervalId.value = null;
  }
});

watch(() => props.visible, (newVisible) => {
  if (newVisible) {
    fetchTransferTasks(); // 模态框可见时立即获取一次数据
    if (pollingIntervalId.value === null) { // 只有在没有定时器时才启动
      pollingIntervalId.value = window.setInterval(fetchTransferTasks, 5000);
    }
  } else {
    if (pollingIntervalId.value !== null) {
      clearInterval(pollingIntervalId.value);
      pollingIntervalId.value = null;
    }
  }
}, { immediate: false });

// --- 模态框可见性控制 ---
const internalVisible = ref(props.visible);

// 监听 props.visible 的变化来更新 internalVisible
watch(() => props.visible, (newVisibleValue) => {
  internalVisible.value = newVisibleValue;
}, { immediate: true }); // 确保初始状态同步

// 监听 internalVisible 的变化来 emit update:visible
watch(internalVisible, (newVal) => {
  if (newVal !== props.visible) {
    emit('update:visible', newVal);
  }
});

const handleClose = () => {
  internalVisible.value = false;
};

// ESC 关闭（只在桌面端弹窗可见时生效，别把快捷键泄漏给终端）
const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && internalVisible.value) {
    event.stopPropagation();
    handleClose();
  }
};

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
});

const isTaskCancellable = (taskStatus: TransferTask['status']): boolean => {
  return ['queued', 'in-progress', 'connecting', 'transferring', 'cancelling'].includes(taskStatus);
};

const isTaskCancelling = (taskStatus: TransferTask['status']): boolean => {
  return taskStatus === 'cancelling';
};

const handleCancelTask = async (taskId: string) => {
  try {
    await apiClient.post(`/transfers/cancel/${taskId}`);
    const taskBeingCancelled = transferTasks.value.find(t => t.taskId === taskId);
    if (taskBeingCancelled && ['queued', 'in-progress', 'connecting', 'transferring'].includes(taskBeingCancelled.status)) {
      taskBeingCancelled.status = 'cancelling';
    }

    // 立即刷新一次列表，或者等待下一次轮询
    fetchTransferTasks();
  } catch (error: any) {
    console.error(`Failed to cancel task ${taskId}:`, error);
  }
};

</script>

<template>
  <!-- ==================== 移动端特化视图 (抽离至独立组件) ==================== -->
  <MobileTransferProgressModal
    v-if="isMobileMode"
    v-model:visible="internalVisible"
    :transfer-tasks="transferTasks"
    :displayed-tasks="displayedTasks"
    :is-loading="isLoading"
    :error-loading="errorLoading"
    :active-tasks-count="activeTasksCount"
    :get-connection-name="getConnectionName"
    :get-display-status="getDisplayStatus"
    :format-date="formatDate"
    :is-task-cancellable="isTaskCancellable"
    :is-task-cancelling="isTaskCancelling"
    @refresh="fetchTransferTasks"
    @cancel-task="handleCancelTask"
  />

  <!-- ==================== 桌面端视图 (居中固定模态框) ==================== -->
  <Teleport v-else to="body">
    <div
      v-if="internalVisible"
      class="fixed inset-0 bg-overlay flex justify-center items-center z-50 p-4"
      @click.self="handleClose"
    >
      <div
        class="tp-modal bg-background text-foreground"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tp-modal-title"
        :style="{ borderColor: 'var(--border-color)' }"
      >
        <!-- Header -->
        <header class="tp-head">
          <div class="tp-head__icon">
            <i class="fas fa-exchange-alt"></i>
          </div>
          <div class="tp-head__text">
            <h3 id="tp-modal-title" class="tp-head__title">{{ t('transferProgressModal.title', '文件传输进度') }}</h3>
            <p class="tp-head__subtitle">{{ subtitleText }}</p>
          </div>

          <span v-if="activeTasksCount > 0" class="tp-live">
            <span class="tp-live__dot"></span>
            {{ t('transferProgressModal.runningTasks', { count: activeTasksCount }, `${activeTasksCount} 进行中`) }}
          </span>

          <div class="tp-head__actions">
            <button
              type="button"
              class="tp-iconbtn"
              :disabled="isLoading"
              :title="t('common.refresh', '刷新')"
              @click="fetchTransferTasks"
            >
              <i :class="['fas fa-sync-alt', { 'fa-spin': isLoading }]"></i>
            </button>
            <button
              type="button"
              class="tp-iconbtn"
              :title="t('common.close', '关闭')"
              @click="handleClose"
            >
              <i class="fas fa-times"></i>
            </button>
          </div>
        </header>

        <!-- Content -->
        <div class="tp-body custom-scrollbar">
          <!-- 首次加载：骨架屏，避免先闪一下空态 -->
          <div v-if="!hasLoadedOnce && isLoading" class="tp-stack">
            <div v-for="i in 3" :key="i" class="tp-card tp-card--skeleton">
              <div class="tp-skeleton__line" style="width: 34%"></div>
              <div class="tp-skeleton__line tp-skeleton__line--sm" style="width: 62%"></div>
              <div class="tp-skeleton__line tp-skeleton__line--bar" style="width: 100%"></div>
            </div>
          </div>

          <!-- 加载失败且一条都没有 -->
          <div v-else-if="errorLoading && displayedTasks.length === 0" class="tp-state tp-state--error">
            <div class="tp-state__icon"><i class="fas fa-exclamation-triangle"></i></div>
            <p class="tp-state__title">{{ t('transferProgressModal.errorLoadingTitle', '加载错误') }}</p>
            <p class="tp-state__text">{{ t('transferProgressModal.errorLoading', { error: errorLoading }) }}</p>
            <button type="button" class="tp-btn tp-btn--ghost" @click="fetchTransferTasks">
              <i class="fas fa-sync-alt mr-1.5"></i>{{ t('common.retry', '重试') }}
            </button>
          </div>

          <!-- 空态 -->
          <div v-else-if="displayedTasks.length === 0" class="tp-state">
            <div class="tp-state__icon"><i class="fas fa-exchange-alt"></i></div>
            <p class="tp-state__title">{{ t('transferProgressModal.noTasks', '当前没有活动的传输任务') }}</p>
            <p class="tp-state__text">{{ t('transferProgressModal.noTasksTip', '在文件管理器中发送或下载文件时会在此显示进度') }}</p>
          </div>

          <template v-else>
            <!-- 轮询失败但还有旧数据：降级成一条细提示，不要把列表清空 -->
            <div v-if="errorLoading" class="tp-inline-error">
              <i class="fas fa-exclamation-triangle"></i>
              <span class="truncate">{{ t('transferProgressModal.errorLoading', { error: errorLoading }) }}</span>
              <button type="button" class="tp-inline-error__retry" @click="fetchTransferTasks">
                {{ t('common.retry', '重试') }}
              </button>
            </div>

            <div class="tp-stack">
              <article v-for="task in displayedTasks" :key="task.taskId" class="tp-card">
                <!-- 第一行：条目名 + 状态 + 终止 -->
                <div class="tp-card__head">
                  <div class="tp-card__icon" :class="`tp-card__icon--${resolveTransferTone(task.status)}`">
                    <i :class="['fas', getTaskIcon(task)]"></i>
                  </div>

                  <div class="tp-card__ident">
                    <div class="tp-card__name-row">
                      <span class="tp-card__name" :title="getTaskFileName(task)">{{ getTaskFileName(task) }}</span>
                      <TransferStatusBadge
                        :status="task.status"
                        :label="getDisplayStatus(task.status)"
                        size="xs"
                      />
                    </div>
                    <div class="tp-route">
                      <span class="tp-route__part" :title="getTaskSourceName(task)">{{ getTaskSourceName(task) }}</span>
                      <i class="fas fa-arrow-right tp-route__arrow"></i>
                      <span class="tp-route__part tp-route__part--path" :title="getTaskTargetPath(task)">{{ getTaskTargetPath(task) }}</span>
                    </div>
                  </div>

                  <button
                    v-if="isTaskCancellable(task.status)"
                    type="button"
                    class="tp-cancel"
                    :disabled="isTaskCancelling(task.status)"
                    :title="isTaskCancelling(task.status) ? t('transferProgressModal.cancellingTooltip', '正在终止......') : t('transferProgressModal.cancelTaskTooltip', '终止任务')"
                    @click="handleCancelTask(task.taskId)"
                  >
                    <i :class="['fas', isTaskCancelling(task.status) ? 'fa-spinner fa-spin' : 'fa-stop']"></i>
                    <span>{{ isTaskCancelling(task.status) ? t('transferProgressModal.cancellingButton', '正在终止...') : t('transferProgressModal.cancelButton', '终止') }}</span>
                  </button>
                </div>

                <!-- 整体进度：没有数值且仍在跑时给不确定态动画 -->
                <div class="tp-progress">
                  <div class="tp-progress__meta">
                    <span>{{ t('transferProgressModal.task.overallProgress', '整体进度') }}</span>
                    <span class="tp-progress__pct">
                      {{ task.overallProgress !== undefined ? pctLabel(task.overallProgress) : t('transferProgressModal.progressUnknown', '进行中') }}
                    </span>
                  </div>
                  <div class="tp-bar">
                    <div
                      v-if="task.overallProgress !== undefined"
                      class="tp-bar__fill"
                      :class="barToneClass(task.status)"
                      :style="{ width: pctLabel(task.overallProgress) }"
                    ></div>
                    <div
                      v-else-if="isBusyTransferStatus(task.status)"
                      class="tp-bar__fill tp-bar__fill--indeterminate"
                      :class="barToneClass(task.status)"
                    ></div>
                  </div>
                </div>

                <!-- 元信息行 -->
                <div class="tp-meta">
                  <span class="tp-meta__item" :title="formatDate(task.createdAt)">
                    <i class="far fa-clock"></i>
                    {{ formatDate(task.createdAt) }}
                  </span>
                  <span v-for="method in getTaskMethods(task)" :key="method" class="tp-method">{{ method }}</span>
                  <span class="tp-meta__spacer"></span>
                  <button
                    v-if="task.subTasks && task.subTasks.length > 0"
                    type="button"
                    class="tp-toggle"
                    @click="toggleTask(task.taskId)"
                  >
                    {{ t('transferProgressModal.subTasks.titleToggle', { count: task.subTasks.length }) }}
                    <i :class="['fas fa-chevron-down tp-toggle__chevron', { 'is-open': isTaskOpen(task.taskId) }]"></i>
                  </button>
                  <span v-else class="tp-meta__muted">{{ t('transferProgressModal.subTasks.noSubTasks', '没有子任务') }}</span>
                </div>

                <!-- 子任务 -->
                <div v-if="task.subTasks && task.subTasks.length > 0 && isTaskOpen(task.taskId)" class="tp-subs">
                  <div v-for="subTask in task.subTasks" :key="subTask.subTaskId" class="tp-sub">
                    <div class="tp-sub__head">
                      <span class="tp-sub__name" :title="subTask.sourceItemName">{{ subTask.sourceItemName }}</span>
                      <TransferStatusBadge
                        :status="subTask.status"
                        :label="getDisplayStatus(subTask.status)"
                        size="xs"
                      />
                    </div>
                    <div v-if="subTask.progress !== undefined" class="tp-sub__progress">
                      <div class="tp-bar tp-bar--thin">
                        <div
                          class="tp-bar__fill"
                          :class="barToneClass(subTask.status)"
                          :style="{ width: pctLabel(subTask.progress) }"
                        ></div>
                      </div>
                      <span class="tp-sub__pct">{{ pctLabel(subTask.progress) }}</span>
                    </div>
                    <div class="tp-sub__meta">
                      <span class="tp-sub__target" :title="getConnectionName(subTask.connectionId)">
                        <i class="fas fa-server"></i>{{ getConnectionName(subTask.connectionId) }}
                      </span>
                      <span v-if="subTask.transferMethodUsed" class="tp-method tp-method--sm">{{ subTask.transferMethodUsed }}</span>
                    </div>
                    <p
                      v-if="subTask.message"
                      class="tp-sub__msg"
                      :class="{ 'tp-sub__msg--error': subTask.status === 'failed' }"
                    >
                      {{ subTask.message }}
                    </p>
                  </div>
                </div>
              </article>
            </div>
          </template>
        </div>

        <!-- Footer -->
        <footer class="tp-foot">
          <span class="tp-foot__hint">
            <i class="fas fa-arrows-rotate"></i>
            {{ t('transferProgressModal.autoRefreshHint', '每 5 秒自动刷新') }}
          </span>
          <button type="button" class="tp-btn" @click="handleClose">
            {{ t('common.close', '关闭') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.bg-overlay {
  background-color: var(--overlay-bg-color, rgba(0, 0, 0, 0.6));
}

/* ⚠️ style.css 第 168 行的 `i, .fas, .far, .fab { color: var(--icon-color) }` 是**未分层**的
   普通 CSS，会无条件盖过继承来的颜色（cascade layers 规则），所以需要跟文字同色的图标
   必须在这里显式 inherit，否则永远是那一枚灰图标。 */
.tp-iconbtn i,
.tp-head__icon i,
.tp-card__icon i,
.tp-cancel i,
.tp-route i,
.tp-meta i,
.tp-toggle i,
.tp-sub i,
.tp-state__icon i,
.tp-inline-error i,
.tp-foot__hint i {
  color: inherit;
}

/* ===== 模态框外壳 ===== */
.tp-modal {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 720px;
  max-height: 85vh;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

/* ===== 头部 ===== */
.tp-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex: none;
  padding: 0.9rem 1rem 0.85rem 1.1rem;
  border-bottom: 1px solid var(--border-color);
  background-color: color-mix(in oklab, var(--header-bg-color, var(--app-bg-color)) 70%, var(--app-bg-color));
}

.tp-head__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  flex: none;
  border-radius: 10px;
  font-size: 0.8rem;
  color: var(--link-active-color);
  background-color: color-mix(in oklab, var(--link-active-color) 14%, transparent);
  border: 1px solid color-mix(in oklab, var(--link-active-color) 26%, transparent);
}

.tp-head__text {
  min-width: 0;
}

.tp-head__title {
  font-size: 0.95rem;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-head__subtitle {
  margin-top: 1px;
  font-size: 11px;
  color: var(--text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-live {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  flex: none;
  margin-left: auto;
  padding: 0.15rem 0.5rem;
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
  color: var(--link-active-color);
  background-color: color-mix(in oklab, var(--link-active-color) 12%, transparent);
  border: 1px solid color-mix(in oklab, var(--link-active-color) 28%, transparent);
}

.tp-live__dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background-color: var(--link-active-color);
  animation: tp-breathe 1.6s ease-in-out infinite;
}

.tp-head__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
  margin-left: auto;
}

/* .tp-live 也用了 margin-left:auto，两者共存时由 DOM 顺序决定谁先靠右 */
.tp-live + .tp-head__actions {
  margin-left: 0.5rem;
}

.tp-iconbtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  font-size: 0.75rem;
  border-radius: 8px;
  color: var(--text-color-secondary);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.tp-iconbtn:hover:not(:disabled) {
  color: var(--text-color);
  background-color: color-mix(in oklab, var(--text-color) 8%, transparent);
}

.tp-iconbtn:disabled {
  opacity: 0.55;
  cursor: default;
}

/* ===== 主体 ===== */
.tp-body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 0.85rem 1rem;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.tp-stack {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

/* ===== 任务卡片 ===== */
.tp-card {
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--border-color);
  border-radius: 11px;
  background-color: color-mix(in oklab, var(--text-color) 3%, var(--app-bg-color));
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.tp-card:hover {
  border-color: color-mix(in oklab, var(--text-color) 18%, var(--border-color));
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.tp-card__head {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
}

.tp-card__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.9rem;
  height: 1.9rem;
  flex: none;
  border-radius: 9px;
  font-size: 0.72rem;
  color: var(--text-color-secondary);
  background-color: color-mix(in oklab, var(--text-color) 7%, transparent);
}

.tp-card__icon--success {
  color: var(--color-success);
  background-color: color-mix(in oklab, var(--color-success) 12%, transparent);
}
.tp-card__icon--danger {
  color: var(--color-error);
  background-color: color-mix(in oklab, var(--color-error) 12%, transparent);
}
.tp-card__icon--warning {
  color: var(--color-warning);
  background-color: color-mix(in oklab, var(--color-warning) 14%, transparent);
}
.tp-card__icon--info {
  color: var(--link-active-color);
  background-color: color-mix(in oklab, var(--link-active-color) 12%, transparent);
}

.tp-card__ident {
  min-width: 0;
  flex: 1 1 auto;
}

.tp-card__name-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
}

.tp-card__name {
  font-size: 0.84rem;
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-route {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  margin-top: 2px;
  min-width: 0;
  font-size: 11px;
  color: var(--text-color-secondary);
}

.tp-route__part {
  min-width: 0;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-route__part--path {
  max-width: 56%;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: color-mix(in oklab, var(--text-color) 78%, var(--app-bg-color));
}

.tp-route__arrow {
  flex: none;
  font-size: 8px;
  opacity: 0.5;
}

/* 终止按钮 */
.tp-cancel {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  flex: none;
  padding: 0.22rem 0.5rem;
  font-size: 11px;
  font-weight: 500;
  border-radius: 7px;
  cursor: pointer;
  color: var(--color-error);
  background-color: color-mix(in oklab, var(--color-error) 10%, transparent);
  transition: background-color 0.15s ease, opacity 0.15s ease;
}

.tp-cancel:hover:not(:disabled) {
  background-color: color-mix(in oklab, var(--color-error) 18%, transparent);
}

.tp-cancel:disabled {
  opacity: 0.6;
  cursor: default;
}

/* ===== 进度 ===== */
.tp-progress {
  margin-top: 0.55rem;
}

.tp-progress__meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 0.25rem;
  font-size: 10.5px;
  color: var(--text-color-secondary);
}

.tp-progress__pct {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-color);
}

.tp-bar {
  position: relative;
  width: 100%;
  height: 5px;
  border-radius: 999px;
  overflow: hidden;
  background-color: color-mix(in oklab, var(--text-color) 12%, transparent);
}

.tp-bar--thin {
  height: 3px;
}

.tp-bar__fill {
  height: 100%;
  border-radius: 999px;
  background-color: var(--link-active-color);
  transition: width 0.35s ease, background-color 0.2s ease;
}

.tp-fill--success {
  background-color: var(--color-success);
}
.tp-fill--danger {
  background-color: var(--color-error);
}
.tp-fill--warning {
  background-color: var(--color-warning);
}
.tp-fill--info {
  background-color: var(--link-active-color);
}
.tp-fill--neutral {
  background-color: var(--text-color-secondary);
}

/* 宽度未知时的不确定态：一条来回扫动的滑块 */
.tp-bar__fill--indeterminate {
  position: absolute;
  inset: 0 auto 0 0;
  width: 38%;
  opacity: 0.85;
  animation: tp-indeterminate 1.4s ease-in-out infinite;
}

@keyframes tp-indeterminate {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(360%);
  }
}

/* ===== 元信息行 ===== */
.tp-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.45rem;
  font-size: 10.5px;
  color: var(--text-color-secondary);
}

.tp-meta__item {
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-meta__spacer {
  flex: 1 1 auto;
}

.tp-meta__muted {
  opacity: 0.7;
}

.tp-method {
  padding: 0.05rem 0.35rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  font-weight: 500;
  text-transform: lowercase;
  border-radius: 5px;
  color: color-mix(in oklab, var(--text-color) 80%, var(--app-bg-color));
  background-color: color-mix(in oklab, var(--text-color) 8%, transparent);
}

.tp-method--sm {
  font-size: 9.5px;
}

.tp-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.1rem 0.35rem;
  font-size: 10.5px;
  font-weight: 500;
  border-radius: 6px;
  cursor: pointer;
  color: var(--link-active-color);
  transition: background-color 0.15s ease;
}

.tp-toggle:hover {
  background-color: color-mix(in oklab, var(--link-active-color) 10%, transparent);
}

.tp-toggle__chevron {
  font-size: 9px;
  transition: transform 0.2s ease;
}

.tp-toggle__chevron.is-open {
  transform: rotate(180deg);
}

/* ===== 子任务 ===== */
.tp-subs {
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  padding-left: 0.55rem;
  border-top: 1px solid color-mix(in oklab, var(--border-color) 70%, transparent);
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.tp-sub {
  padding: 0.45rem 0.55rem;
  border-radius: 8px;
  background-color: color-mix(in oklab, var(--text-color) 4%, var(--app-bg-color));
  border: 1px solid color-mix(in oklab, var(--border-color) 75%, transparent);
}

.tp-sub__head {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
}

.tp-sub__name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-sub__progress {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.3rem;
}

.tp-sub__pct {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  color: var(--text-color-secondary);
}

.tp-sub__meta {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.25rem;
  font-size: 10px;
  color: var(--text-color-secondary);
}

.tp-sub__target {
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-sub__msg {
  margin-top: 0.3rem;
  font-size: 10px;
  line-height: 1.45;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--text-color-secondary);
  word-break: break-word;
}

.tp-sub__msg--error {
  padding: 0.3rem 0.4rem;
  border-radius: 6px;
  color: color-mix(in oklab, var(--color-error) 82%, var(--text-color));
  background-color: color-mix(in oklab, var(--color-error) 9%, transparent);
}

/* ===== 状态页（空 / 错误） ===== */
.tp-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem 1rem;
  text-align: center;
}

.tp-state__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 3rem;
  height: 3rem;
  margin-bottom: 0.75rem;
  border-radius: 14px;
  font-size: 1.15rem;
  color: var(--text-color-secondary);
  background-color: color-mix(in oklab, var(--text-color) 7%, transparent);
}

.tp-state--error .tp-state__icon {
  color: var(--color-error);
  background-color: color-mix(in oklab, var(--color-error) 12%, transparent);
}

.tp-state__title {
  font-size: 0.85rem;
  font-weight: 600;
}

.tp-state__text {
  margin-top: 0.25rem;
  max-width: 26rem;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-color-secondary);
  word-break: break-word;
}

.tp-state .tp-btn {
  margin-top: 0.85rem;
}

.tp-inline-error {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.6rem;
  padding: 0.4rem 0.55rem;
  font-size: 11px;
  border-radius: 8px;
  color: color-mix(in oklab, var(--color-error) 80%, var(--text-color));
  background-color: color-mix(in oklab, var(--color-error) 9%, transparent);
  border: 1px solid color-mix(in oklab, var(--color-error) 22%, transparent);
}

.tp-inline-error__retry {
  flex: none;
  margin-left: auto;
  padding: 0.05rem 0.4rem;
  font-weight: 600;
  border-radius: 5px;
  cursor: pointer;
  color: inherit;
  background-color: color-mix(in oklab, var(--color-error) 14%, transparent);
}

/* ===== 骨架屏 ===== */
.tp-card--skeleton {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.tp-skeleton__line {
  height: 10px;
  border-radius: 5px;
  background-color: color-mix(in oklab, var(--text-color) 10%, transparent);
  animation: tp-shimmer 1.4s ease-in-out infinite;
}

.tp-skeleton__line--sm {
  height: 8px;
}

.tp-skeleton__line--bar {
  height: 5px;
}

@keyframes tp-shimmer {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 0.9;
  }
}

/* ===== 底部 ===== */
.tp-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex: none;
  padding: 0.7rem 1rem;
  border-top: 1px solid var(--border-color);
  background-color: color-mix(in oklab, var(--header-bg-color, var(--app-bg-color)) 70%, var(--app-bg-color));
}

.tp-foot__hint {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 10.5px;
  color: var(--text-color-secondary);
  opacity: 0.85;
}

.tp-btn {
  padding: 0.35rem 1rem;
  font-size: 12px;
  font-weight: 500;
  border-radius: 8px;
  cursor: pointer;
  color: var(--button-text-color);
  background-color: var(--button-bg-color);
  transition: background-color 0.15s ease, transform 0.1s ease;
}

.tp-btn:hover {
  background-color: var(--button-hover-bg-color, var(--button-bg-color));
}

.tp-btn:active {
  transform: translateY(0.5px);
}

.tp-btn--ghost {
  color: var(--text-color);
  background-color: color-mix(in oklab, var(--text-color) 8%, transparent);
}

.tp-btn--ghost:hover {
  background-color: color-mix(in oklab, var(--text-color) 14%, transparent);
}

@keyframes tp-breathe {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.3;
    transform: scale(0.72);
  }
}

/* ===== 滚动条 ===== */
.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(128, 128, 128, 0.3);
  border-radius: 10px;
  border: 2px solid transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background-color: rgba(128, 128, 128, 0.5);
}

.custom-scrollbar {
  scrollbar-width: thin;
  scrollbar-color: rgba(128, 128, 128, 0.3) transparent;
}

@media (prefers-reduced-motion: reduce) {
  .tp-bar__fill,
  .tp-toggle__chevron,
  .tp-card {
    transition: none;
  }
  .tp-live__dot,
  .tp-skeleton__line,
  .tp-bar__fill--indeterminate {
    animation: none;
  }
}
</style>
