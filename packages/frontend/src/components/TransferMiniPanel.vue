<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import apiClient from '../utils/apiClient';
import { useConnectionsStore } from '../stores/connections.store';
import { useTransferMiniPanelStore } from '../stores/transferMiniPanel.store';
import { isBusyTransferStatus, pctLabel, resolveTransferTone, type TransferTone } from '../utils/transfer-status';
import { buildTransferTaskView } from '../utils/transfer-task-view';
import TransferStatusBadge from './common/TransferStatusBadge.vue';

/**
 * 跨主机拖拽传输的右下角小窗。
 *
 * 与大弹窗的区别只有三点：位置固定在右下角、可以折叠成一行、**全部成功后自行销毁**。
 * 失败/部分失败时保留，等用户看过点关闭 —— 这条是用户明确要求的：
 * 「全部完成后窗口自动销毁，如果有错误就不销毁，不过用户点击关闭就销毁」。
 */
const POLL_INTERVAL_MS = 1500;
/** 全部成功后再留一会儿，别让进度条一闪而过 */
const AUTO_CLOSE_DELAY_MS = 1600;

const { t } = useI18n();
const connectionsStore = useConnectionsStore();
const panel = useTransferMiniPanelStore();

interface TransferSubTaskLike {
  subTaskId: string;
  connectionId: number;
  sourceItemName: string;
  status: string;
  progress?: number;
  message?: string;
  transferMethodUsed?: 'rsync' | 'scp' | 'relay';
}

interface TransferTaskLike {
  taskId: string;
  status: string;
  createdAt: string | Date;
  updatedAt?: string | Date;
  subTasks?: TransferSubTaskLike[];
  overallProgress?: number;
  sourceConnectionId?: number;
  remoteTargetPath?: string;
  targetConnectionIds?: number[];
  sourceItems?: Array<{ name: string; path: string; type: 'file' | 'directory' }>;
}

const tasks = ref<TransferTaskLike[]>([]);
const loadError = ref<string | null>(null);
let pollTimer: number | null = null;
let autoCloseTimer: number | null = null;

const getConnectionName = (connectionId: number): string => {
  const connection = connectionsStore.connections?.find((c: any) => c.id === connectionId);
  if (connection?.name) return connection.name;
  return t('transferProgressModal.connectionIdFallback', { connectionId }, `连接ID: ${connectionId}`);
};

const statusLabel = (status: string): string => {
  const map: Record<string, string> = {
    queued: 'transferProgressModal.status.queued',
    'in-progress': 'transferProgressModal.status.inProgress',
    completed: 'transferProgressModal.status.completed',
    failed: 'transferProgressModal.status.failed',
    'partially-completed': 'transferProgressModal.status.partiallyCompleted',
    connecting: 'transferProgressModal.status.connecting',
    transferring: 'transferProgressModal.status.transferring',
    cancelling: 'transferProgressModal.status.cancelling',
    cancelled: 'transferProgressModal.status.cancelled',
  };
  const fallback = status.charAt(0).toUpperCase() + status.slice(1).replace('-', ' ');
  return t(map[status] || `status.${status}`, fallback);
};

const toneFillClass = (tone: TransferTone) => `tmp-fill--${tone}`;

const isFailedLike = (status: string) => status === 'failed' || status === 'partially-completed';

/**
 * 失败原因必须就地可见：小窗存在的意义就是「不用打开大弹窗也知道出了什么事」。
 * 后端把逐项目的原因放在子任务上，取第一条失败信息代表整条任务。
 */
const failureMessage = (task: TransferTaskLike): string => {
  const failedSub = task.subTasks?.find((sub) => sub.status === 'failed' && sub.message);
  return failedSub?.message || t('transferMiniPanel.failed', '传输失败');
};

/** 只认本批任务：同一批里连续拖多个只累加，不重复开窗 */
const ourTasks = computed(() =>
  tasks.value
    .filter((task) => new Date(task.createdAt).getTime() >= panel.batchStartedAt - 3000)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 6)
);

const taskViews = computed(() =>
  ourTasks.value.map((task) => ({
    task,
    view: buildTransferTaskView(task as any, { t: t as any, getConnectionName, maxTargetNames: 1 }),
  }))
);

const busyCount = computed(() => ourTasks.value.filter((task) => isBusyTransferStatus(task.status)).length);
const failedCount = computed(
  () => ourTasks.value.filter((task) => task.status === 'failed' || task.status === 'partially-completed').length
);
const allCompleted = computed(
  () => ourTasks.value.length > 0 && ourTasks.value.every((task) => task.status === 'completed')
);

/** 折叠时那一行要说明当前到底在干什么 */
const summaryText = computed(() => {
  if (failedCount.value > 0) {
    return t('transferMiniPanel.hasError', { count: failedCount.value }, `${failedCount.value} 项失败`);
  }
  if (busyCount.value > 0) {
    const first = ourTasks.value.find((task) => isBusyTransferStatus(task.status));
    const pct = first?.overallProgress !== undefined ? ` ${pctLabel(first.overallProgress)}` : '';
    return `${t('transferMiniPanel.activeCount', { count: busyCount.value }, `${busyCount.value} 项进行中`)}${pct}`;
  }
  if (ourTasks.value.length > 0) {
    return t('transferMiniPanel.allDone', '已全部完成');
  }
  return t('transferMiniPanel.preparing', '正在准备…');
});

const fetchTasks = async () => {
  try {
    const response = await apiClient.get<{ data: TransferTaskLike[] }>('/transfers/status');
    const raw = Array.isArray((response.data as any)?.data)
      ? ((response.data as any).data as TransferTaskLike[])
      : Array.isArray(response.data)
        ? (response.data as unknown as TransferTaskLike[])
        : [];
    tasks.value = raw;
    loadError.value = null;
  } catch (error: any) {
    loadError.value = error?.response?.data?.message || error?.message || t('transferProgressModal.error.unknown', '未知错误');
  }
};

const cancelAutoClose = () => {
  if (autoCloseTimer !== null) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  }
};

const scheduleAutoClose = () => {
  if (autoCloseTimer !== null) return;
  autoCloseTimer = window.setTimeout(() => {
    autoCloseTimer = null;
    // 复核一次：这 1.6 秒里没有新任务插进来才销毁
    if (ourTasks.value.length > 0 && ourTasks.value.every((task) => task.status === 'completed')) {
      panel.close();
    }
  }, AUTO_CLOSE_DELAY_MS);
};

watch(
  () => [allCompleted.value, failedCount.value, busyCount.value] as const,
  () => {
    panel.reportIdle(failedCount.value === 0 && busyCount.value === 0);
    if (allCompleted.value) scheduleAutoClose();
    else cancelAutoClose();
  },
  { immediate: true }
);

const handleCancelTask = async (taskId: string) => {
  try {
    await apiClient.post(`/transfers/cancel/${taskId}`);
    await fetchTasks();
  } catch (error) {
    console.error('[TransferMiniPanel] 终止任务失败:', error);
  }
};

onMounted(() => {
  void fetchTasks();
  pollTimer = window.setInterval(() => void fetchTasks(), POLL_INTERVAL_MS);
});

onUnmounted(() => {
  cancelAutoClose();
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});
</script>

<template>
  <aside class="tmp" :class="{ 'tmp--collapsed': panel.collapsed }" role="status" aria-live="polite">
    <!-- 标题行：点哪儿都能折叠，只有 ✕ 是关闭 -->
    <header class="tmp-head" @click="panel.toggleCollapsed()">
      <span class="tmp-head__icon" :class="{ 'tmp-head__icon--busy': busyCount > 0, 'tmp-head__icon--error': failedCount > 0 }">
        <i class="fas fa-arrow-right-arrow-left"></i>
      </span>
      <span class="tmp-head__title">{{ t('transferMiniPanel.title', '跨主机传输') }}</span>
      <span class="tmp-head__summary" :class="{ 'tmp-head__summary--error': failedCount > 0 }">{{ summaryText }}</span>
      <button
        type="button"
        class="tmp-iconbtn"
        :title="panel.collapsed ? t('transferMiniPanel.expand', '展开') : t('transferMiniPanel.collapse', '收起')"
        @click.stop="panel.toggleCollapsed()"
      >
        <i :class="['fas', panel.collapsed ? 'fa-chevron-up' : 'fa-chevron-down']"></i>
      </button>
      <button
        type="button"
        class="tmp-iconbtn"
        :title="t('transferMiniPanel.close', '关闭')"
        @click.stop="panel.close()"
      >
        <i class="fas fa-xmark"></i>
      </button>
    </header>

    <div v-if="!panel.collapsed" class="tmp-body">
      <p v-if="loadError" class="tmp-error">
        <i class="fas fa-triangle-exclamation"></i>
        <span>{{ loadError }}</span>
      </p>

      <p v-else-if="ourTasks.length === 0" class="tmp-empty">
        {{ t('transferMiniPanel.preparing', '正在准备…') }}
      </p>

      <template v-else>
        <article v-for="{ task, view } in taskViews" :key="task.taskId" class="tmp-card">
          <div class="tmp-card__row">
            <span class="tmp-card__icon" :class="`tmp-card__icon--${view.tone}`">
              <i :class="['fas', view.icon]"></i>
            </span>
            <span class="tmp-card__name" :title="view.primaryNameTitle">{{ view.primaryName }}</span>
            <TransferStatusBadge :status="task.status" :label="statusLabel(task.status)" size="xs" />
            <button
              v-if="isBusyTransferStatus(task.status)"
              type="button"
              class="tmp-cancel"
              :title="t('transferProgressModal.cancelTaskTooltip', '终止任务')"
              @click="handleCancelTask(task.taskId)"
            >
              <i class="fas fa-stop"></i>
            </button>
          </div>

          <div class="tmp-route" :title="view.routeTitle">
            <span class="tmp-route__text">{{ view.sourceName }}</span>
            <i class="fas fa-arrow-right tmp-route__arrow"></i>
            <span v-for="(name, index) in view.targetNames" :key="`${name}-${index}`" class="tmp-route__text tmp-route__text--target">{{ name }}</span>
            <span v-if="view.hiddenTargetCount > 0" class="tmp-route__more">+{{ view.hiddenTargetCount }}</span>
            <span class="tmp-route__path" :title="view.pathTitle">{{ view.targetPathLabel }}</span>
          </div>

          <div class="tmp-bar">
            <div
              v-if="task.overallProgress !== undefined"
              class="tmp-bar__fill"
              :class="toneFillClass(resolveTransferTone(task.status))"
              :style="{ width: pctLabel(task.overallProgress) }"
            ></div>
            <div
              v-else-if="isBusyTransferStatus(task.status)"
              class="tmp-bar__fill tmp-bar__fill--indeterminate"
              :class="toneFillClass(resolveTransferTone(task.status))"
            ></div>
          </div>

          <p v-if="isFailedLike(task.status)" class="tmp-card__error" :title="failureMessage(task)">
            {{ failureMessage(task) }}
          </p>
        </article>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.tmp {
  position: fixed;
  right: 0.9rem;
  bottom: 0.9rem;
  z-index: 60;
  display: flex;
  flex-direction: column;
  width: 336px;
  max-width: calc(100vw - 1.8rem);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background-color: var(--app-bg-color);
  box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.35);
  overflow: hidden;
  /* 面板本身不拦截空白区域的手势，只有内容区才吃事件 */
  pointer-events: auto;
}

/* ---- 标题行 ---- */
.tmp-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.45rem 0.4rem 0.5rem;
  cursor: pointer;
  user-select: none;
  background-color: color-mix(in oklab, var(--header-bg-color, var(--app-bg-color)) 70%, var(--app-bg-color));
}

.tmp-head__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 5px;
  font-size: 9px;
  color: var(--link-active-color);
  background-color: color-mix(in oklab, var(--link-active-color) 16%, transparent);
}

.tmp-head__icon--busy i {
  animation: tmp-nudge 1.4s ease-in-out infinite;
}

.tmp-head__icon--error {
  color: var(--color-error);
  background-color: color-mix(in oklab, var(--color-error) 16%, transparent);
}

@keyframes tmp-nudge {
  0%, 100% { transform: translateX(-1px); }
  50% { transform: translateX(1px); }
}

.tmp-head__title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-color);
  flex: none;
}

.tmp-head__summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--text-color-secondary);
}

.tmp-head__summary--error {
  color: var(--color-error);
}

.tmp-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-color-secondary);
  font-size: 10px;
  cursor: pointer;
}

.tmp-iconbtn:hover {
  color: var(--text-color);
  background-color: color-mix(in oklab, var(--text-color) 10%, transparent);
}

/* ⚠️ style.css 的 `i, .fas, .far, .fab { color: var(--icon-color) }` 是未分层样式，
   会盖过一切继承色 → 需要跟文字同色的图标必须显式 inherit */
.tmp-iconbtn i,
.tmp-head__icon i,
.tmp-card__icon i,
.tmp-cancel i,
.tmp-error i {
  color: inherit;
}

/* ---- 主体 ---- */
.tmp-body {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.4rem;
  max-height: min(34vh, 300px);
  overflow-y: auto;
  overscroll-behavior: contain;
  border-top: 1px solid var(--border-color);
}

.tmp-empty,
.tmp-error {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0;
  padding: 0.3rem 0.35rem;
  font-size: 10.5px;
  color: var(--text-color-secondary);
}

.tmp-error {
  color: var(--color-error);
}

.tmp-card {
  display: flex;
  flex-direction: column;
  gap: 0.28rem;
  padding: 0.38rem 0.42rem;
  border-radius: 7px;
  background-color: color-mix(in oklab, var(--text-color) 5%, transparent);
}

.tmp-card__row {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
}

.tmp-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  border-radius: 4px;
  font-size: 8px;
}

.tmp-card__icon--success {
  color: var(--color-success);
  background-color: color-mix(in oklab, var(--color-success) 18%, transparent);
}
.tmp-card__icon--danger {
  color: var(--color-error);
  background-color: color-mix(in oklab, var(--color-error) 18%, transparent);
}
.tmp-card__icon--warning {
  color: var(--color-warning);
  background-color: color-mix(in oklab, var(--color-warning) 18%, transparent);
}
.tmp-card__icon--info {
  color: var(--link-active-color);
  background-color: color-mix(in oklab, var(--link-active-color) 18%, transparent);
}
.tmp-card__icon--neutral {
  color: var(--text-color-secondary);
  background-color: color-mix(in oklab, var(--text-color-secondary) 18%, transparent);
}

.tmp-card__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-color);
}

.tmp-cancel {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-color-secondary);
  font-size: 8px;
  cursor: pointer;
}

.tmp-cancel:hover {
  color: var(--color-error);
  background-color: color-mix(in oklab, var(--color-error) 14%, transparent);
}

.tmp-route {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  font-size: 9.5px;
  color: var(--text-color-secondary);
}

.tmp-route__text {
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tmp-route__text--target {
  color: var(--text-color);
  opacity: 0.9;
}

.tmp-route__arrow {
  flex: none;
  font-size: 7px;
  opacity: 0.7;
  color: inherit;
}

.tmp-route__more {
  flex: none;
  opacity: 0.8;
}

.tmp-route__path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: right;
  opacity: 0.8;
}

.tmp-bar {
  position: relative;
  height: 3px;
  border-radius: 999px;
  overflow: hidden;
  background-color: color-mix(in oklab, var(--text-color) 12%, transparent);
}

.tmp-bar__fill {
  height: 100%;
  border-radius: 999px;
  background-color: var(--link-active-color);
  transition: width 0.35s ease, background-color 0.2s ease;
}

.tmp-fill--success {
  background-color: var(--color-success);
}
.tmp-fill--danger {
  background-color: var(--color-error);
}
.tmp-fill--warning {
  background-color: var(--color-warning);
}
.tmp-fill--info {
  background-color: var(--link-active-color);
}
.tmp-fill--neutral {
  background-color: var(--text-color-secondary);
}

.tmp-bar__fill--indeterminate {
  position: absolute;
  inset: 0 auto 0 0;
  width: 38%;
  opacity: 0.85;
  animation: tmp-indeterminate 1.4s ease-in-out infinite;
}

.tmp-card__error {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9.5px;
  color: var(--color-error);
}

@keyframes tmp-indeterminate {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(280%); }
}

@media (prefers-reduced-motion: reduce) {
  .tmp-bar__fill,
  .tmp-head__icon--busy i {
    transition: none;
    animation: none;
  }
  .tmp-bar__fill--indeterminate {
    animation: none;
    width: 60%;
  }
}
</style>
