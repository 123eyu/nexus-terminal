<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import MobileBottomSheet from './common/MobileBottomSheet.vue';
import TransferStatusBadge from './common/TransferStatusBadge.vue';
import { isBusyTransferStatus, resolveTransferTone } from '../utils/transfer-status';

interface TransferSubTask {
  subTaskId: string;
  connectionId: number;
  sourceItemName: string;
  status: 'queued' | 'connecting' | 'transferring' | 'completed' | 'failed' | 'cancelling' | 'cancelled';
  progress?: number;
  message?: string;
  transferMethodUsed?: 'rsync' | 'scp';
}

interface TransferTask {
  taskId: string;
  status: 'queued' | 'in-progress' | 'completed' | 'failed' | 'partially-completed' | 'cancelling' | 'cancelled';
  createdAt: string | Date;
  updatedAt: string | Date;
  subTasks: TransferSubTask[];
  overallProgress?: number;
  sourceConnectionId?: number;
  remoteTargetPath?: string;
}

const props = defineProps<{
  visible: boolean;
  transferTasks: TransferTask[];
  displayedTasks: TransferTask[];
  isLoading: boolean;
  errorLoading: string | null;
  activeTasksCount: number;
  getConnectionName: (id: number) => string;
  getDisplayStatus: (status: string) => string;
  formatDate: (date: string | Date) => string;
  isTaskCancellable: (status: any) => boolean;
  isTaskCancelling: (status: any) => boolean;
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'refresh'): void;
  (e: 'cancel-task', taskId: string): void;
}>();

const { t } = useI18n();

const handleClose = () => {
  emit('update:visible', false);
};

// --- 卡片展示用的小工具（与桌面端保持同一套语义） ---
const getTaskFileName = (task: TransferTask): string => {
  if (task.subTasks && task.subTasks.length > 0 && task.subTasks[0].sourceItemName) {
    return task.subTasks[0].sourceItemName;
  }
  return t('transferProgressModal.unknownFileName', '[文件名未知]');
};

const getTaskSourceName = (task: TransferTask): string => {
  if (task.sourceConnectionId) return props.getConnectionName(task.sourceConnectionId);
  return t('transferProgressModal.localSource', '本机');
};

const getTaskTargetPath = (task: TransferTask): string => {
  return task.remoteTargetPath || t('transferProgressModal.unknownTargetPath', '[目标路径未知]');
};

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
const barToneClass = (status: string): string => `tp-fill--${resolveTransferTone(status)}`;

// 子任务折叠：失败的任务自动展开一次（错误信息得能一眼看到），之后完全听用户的
const openTaskIds = ref<string[]>([]);
const autoOpenedTaskIds: string[] = [];

const isExpanded = (taskId: string): boolean => openTaskIds.value.includes(taskId);

const toggleTask = (taskId: string) => {
  const index = openTaskIds.value.indexOf(taskId);
  if (index >= 0) {
    openTaskIds.value.splice(index, 1);
  } else {
    openTaskIds.value.push(taskId);
  }
};

// ⚠️ 展开状态只能在 watch 里改，不能在渲染期改（渲染期改 ref = 抖动/死循环）
watch(
  () => props.transferTasks,
  (tasks) => {
    for (const task of tasks || []) {
      const failedLike = task.status === 'failed' || task.status === 'partially-completed';
      if (!failedLike || autoOpenedTaskIds.includes(task.taskId)) continue;
      autoOpenedTaskIds.push(task.taskId);
      if (!openTaskIds.value.includes(task.taskId)) openTaskIds.value.push(task.taskId);
    }
  },
  { immediate: true }
);

const activeSummary = computed(() => {
  if (props.activeTasksCount <= 0) return '';
  return t('transferProgressModal.runningTasks', { count: props.activeTasksCount }, `${props.activeTasksCount} 进行中`);
});
</script>

<template>
  <MobileBottomSheet
    :visible="props.visible"
    height="h-[85vh]"
    max-height="max-h-[85vh]"
    @close="handleClose"
  >
    <template #header-left>
      <!-- 刷新按钮 -->
      <button
        type="button"
        @click="emit('refresh')"
        :disabled="props.isLoading"
        class="tp-m-iconbtn"
        :title="t('common.refresh', '刷新')"
      >
        <i :class="['fas fa-sync-alt text-xs', { 'fa-spin': props.isLoading }]"></i>
      </button>

      <!-- 标题 + 进行中徽标 -->
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="tp-m-title">
          {{ t('transferProgressModal.title', '文件传输进度') }}
        </span>
        <span v-if="activeSummary" class="tp-m-live">
          <span class="tp-m-live__dot"></span>
          <span class="truncate">{{ activeSummary }}</span>
        </span>
      </div>
    </template>

    <!-- 任务列表区 -->
    <div class="flex-grow overflow-y-auto px-3 pt-2.5 pb-6 space-y-2.5 overscroll-contain">
      <!-- 首次加载 -->
      <div v-if="props.isLoading && props.transferTasks.length === 0" class="space-y-2.5">
        <div v-for="i in 3" :key="i" class="tp-m-card">
          <div class="tp-m-skeleton" style="width: 40%"></div>
          <div class="tp-m-skeleton tp-m-skeleton--sm" style="width: 70%"></div>
          <div class="tp-m-skeleton tp-m-skeleton--bar" style="width: 100%"></div>
        </div>
      </div>

      <!-- 加载出错（且无数据） -->
      <div v-else-if="props.errorLoading && props.displayedTasks.length === 0" class="tp-m-state">
        <div class="tp-m-state__icon tp-m-state__icon--error">
          <i class="fas fa-exclamation-triangle"></i>
        </div>
        <p class="tp-m-state__title">{{ t('transferProgressModal.errorLoadingTitle', '加载错误') }}</p>
        <p class="tp-m-state__text">{{ t('transferProgressModal.errorLoading', { error: props.errorLoading }) }}</p>
        <button type="button" class="tp-m-retry" @click="emit('refresh')">
          <i class="fas fa-sync-alt mr-1.5"></i>{{ t('common.retry', '重试') }}
        </button>
      </div>

      <!-- 空态 -->
      <div v-else-if="props.displayedTasks.length === 0" class="tp-m-state">
        <div class="tp-m-state__icon">
          <i class="fas fa-exchange-alt"></i>
        </div>
        <p class="tp-m-state__title">{{ t('transferProgressModal.noTasks', '当前没有活动的传输任务') }}</p>
        <p class="tp-m-state__text">{{ t('transferProgressModal.noTasksTip', '在文件管理器中发送或下载文件时会在此显示进度') }}</p>
      </div>

      <template v-else>
        <!-- 轮询失败但仍有旧数据：细提示，不清空列表 -->
        <div v-if="props.errorLoading" class="tp-m-inline-error">
          <i class="fas fa-exclamation-triangle"></i>
          <span class="truncate flex-1">{{ t('transferProgressModal.errorLoading', { error: props.errorLoading }) }}</span>
          <button type="button" @click="emit('refresh')">{{ t('common.retry', '重试') }}</button>
        </div>

        <div
          v-for="task in props.displayedTasks"
          :key="task.taskId"
          class="tp-m-card"
        >
          <!-- 条目名 + 状态 -->
          <div class="flex items-start gap-2">
            <div class="tp-m-card__icon" :class="`tp-card__icon--${resolveTransferTone(task.status)}`">
              <i class="fas fa-file-alt"></i>
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="tp-m-card__name" :title="getTaskFileName(task)">{{ getTaskFileName(task) }}</span>
                <TransferStatusBadge
                  :status="task.status"
                  :label="props.getDisplayStatus(task.status)"
                  size="xs"
                />
              </div>
              <div class="tp-m-route">
                <span class="tp-m-route__part" :title="getTaskSourceName(task)">{{ getTaskSourceName(task) }}</span>
                <i class="fas fa-arrow-right tp-m-route__arrow"></i>
                <span class="tp-m-route__part tp-m-route__part--path" :title="getTaskTargetPath(task)">{{ getTaskTargetPath(task) }}</span>
              </div>
            </div>
          </div>

          <!-- 整体进度 -->
          <div class="tp-m-progress">
            <div class="tp-m-progress__meta">
              <span>{{ t('transferProgressModal.task.overallProgress', '整体进度') }}</span>
              <span class="tp-m-progress__pct">
                {{ task.overallProgress !== undefined ? pctLabel(task.overallProgress) : t('transferProgressModal.progressUnknown', '进行中') }}
              </span>
            </div>
            <div class="tp-m-bar">
              <div
                v-if="task.overallProgress !== undefined"
                class="tp-m-bar__fill"
                :class="barToneClass(task.status)"
                :style="{ width: pctLabel(task.overallProgress) }"
              ></div>
              <div
                v-else-if="isBusyTransferStatus(task.status)"
                class="tp-m-bar__fill tp-m-bar__fill--indeterminate"
                :class="barToneClass(task.status)"
              ></div>
            </div>
          </div>

          <!-- 元信息 + 操作 -->
          <div class="tp-m-meta">
            <span class="tp-m-meta__date">
              <i class="far fa-clock"></i>{{ props.formatDate(task.createdAt) }}
            </span>
            <span v-for="method in getTaskMethods(task)" :key="method" class="tp-m-method">{{ method }}</span>
            <span class="flex-1"></span>
            <button
              v-if="props.isTaskCancellable(task.status)"
              type="button"
              @click="emit('cancel-task', task.taskId)"
              :disabled="props.isTaskCancelling(task.status)"
              class="tp-m-cancel"
              :title="props.isTaskCancelling(task.status) ? t('transferProgressModal.cancellingTooltip', '正在终止......') : t('transferProgressModal.cancelTaskTooltip', '终止任务')"
            >
              <i :class="['fas', props.isTaskCancelling(task.status) ? 'fa-spinner fa-spin' : 'fa-stop']"></i>
              <span>{{ props.isTaskCancelling(task.status) ? t('transferProgressModal.cancellingButton', '正在终止...') : t('transferProgressModal.cancelButton', '终止') }}</span>
            </button>
          </div>

          <!-- 子任务 -->
          <template v-if="task.subTasks && task.subTasks.length > 0">
            <button
              type="button"
              class="tp-m-toggle"
              :class="{ 'is-open': isExpanded(task.taskId) }"
              @click="toggleTask(task.taskId)"
            >
              <span>{{ t('transferProgressModal.subTasks.titleToggle', { count: task.subTasks.length }) }}</span>
              <i class="fas fa-chevron-down tp-m-toggle__chevron"></i>
            </button>

            <div v-if="isExpanded(task.taskId)" class="tp-m-subs">
              <div v-for="subTask in task.subTasks" :key="subTask.subTaskId" class="tp-m-sub">
                <div class="tp-m-sub__head">
                  <span class="tp-m-sub__name" :title="subTask.sourceItemName">{{ subTask.sourceItemName }}</span>
                  <TransferStatusBadge
                    :status="subTask.status"
                    :label="props.getDisplayStatus(subTask.status)"
                    size="xs"
                  />
                </div>
                <div v-if="subTask.progress !== undefined" class="tp-m-sub__progress">
                  <div class="tp-m-bar tp-m-bar--thin">
                    <div
                      class="tp-m-bar__fill"
                      :class="barToneClass(subTask.status)"
                      :style="{ width: pctLabel(subTask.progress) }"
                    ></div>
                  </div>
                  <span class="tp-m-sub__pct">{{ pctLabel(subTask.progress) }}</span>
                </div>
                <div class="tp-m-sub__meta">
                  <span class="tp-m-sub__target" :title="props.getConnectionName(subTask.connectionId)">
                    <i class="fas fa-server"></i>{{ props.getConnectionName(subTask.connectionId) }}
                  </span>
                  <span v-if="subTask.transferMethodUsed" class="tp-m-method tp-m-method--sm">{{ subTask.transferMethodUsed }}</span>
                </div>
                <p
                  v-if="subTask.message"
                  class="tp-m-sub__msg"
                  :class="{ 'tp-m-sub__msg--error': subTask.status === 'failed' }"
                >
                  {{ subTask.message }}
                </p>
              </div>
            </div>
          </template>
        </div>

        <p class="tp-m-foot">
          <i class="fas fa-arrows-rotate"></i>
          {{ t('transferProgressModal.autoRefreshHint', '每 5 秒自动刷新') }}
        </p>
      </template>
    </div>
  </MobileBottomSheet>
</template>

<style scoped>
/* ⚠️ style.css 的 `i, .fas, .far, .fab { color: var(--icon-color) }` 是未分层样式，
   会盖过一切继承色 → 需要跟文字同色的图标必须显式 inherit */
.tp-m-iconbtn i,
.tp-m-card__icon i,
.tp-m-cancel i,
.tp-m-toggle i,
.tp-m-route i,
.tp-m-meta i,
.tp-m-sub i,
.tp-m-state__icon i,
.tp-m-inline-error i,
.tp-m-foot i {
  color: inherit;
}

/* ===== 头部 ===== */
.tp-m-iconbtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  margin-left: -0.25rem;
  flex: none;
  border-radius: 8px;
  color: var(--text-color-secondary);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.tp-m-iconbtn:active:not(:disabled) {
  background-color: color-mix(in oklab, var(--text-color) 10%, transparent);
  color: var(--text-color);
}

.tp-m-iconbtn:disabled {
  opacity: 0.5;
}

.tp-m-title {
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.tp-m-live {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
  padding: 0.1rem 0.4rem;
  font-size: 10px;
  font-weight: 600;
  border-radius: 999px;
  color: var(--link-active-color);
  background-color: color-mix(in oklab, var(--link-active-color) 12%, transparent);
  border: 1px solid color-mix(in oklab, var(--link-active-color) 28%, transparent);
}

.tp-m-live__dot {
  width: 4px;
  height: 4px;
  flex: none;
  border-radius: 999px;
  background-color: var(--link-active-color);
  animation: tp-m-breathe 1.6s ease-in-out infinite;
}

@keyframes tp-m-breathe {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.3;
    transform: scale(0.7);
  }
}

/* ===== 卡片 ===== */
.tp-m-card {
  padding: 0.7rem 0.75rem;
  border-radius: 12px;
  border: 1px solid var(--border-color);
  background-color: color-mix(in oklab, var(--text-color) 3.5%, var(--app-bg-color));
}

.tp-m-card__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  flex: none;
  border-radius: 9px;
  font-size: 0.7rem;
  color: var(--text-color-secondary);
  background-color: color-mix(in oklab, var(--text-color) 7%, transparent);
}

/* 与桌面端共用同一组色调类名语义 */
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

.tp-m-card__name {
  min-width: 0;
  font-size: 0.8rem;
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-m-route {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin-top: 2px;
  min-width: 0;
  font-size: 10.5px;
  color: var(--text-color-secondary);
}

.tp-m-route__part {
  min-width: 0;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-m-route__part--path {
  max-width: 56%;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.tp-m-route__arrow {
  flex: none;
  font-size: 8px;
  opacity: 0.5;
}

/* ===== 进度 ===== */
.tp-m-progress {
  margin-top: 0.55rem;
}

.tp-m-progress__meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 0.25rem;
  font-size: 10px;
  color: var(--text-color-secondary);
}

.tp-m-progress__pct {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 600;
  color: var(--text-color);
}

.tp-m-bar {
  position: relative;
  width: 100%;
  height: 5px;
  border-radius: 999px;
  overflow: hidden;
  background-color: color-mix(in oklab, var(--text-color) 12%, transparent);
}

.tp-m-bar--thin {
  height: 3px;
}

.tp-m-bar__fill {
  height: 100%;
  border-radius: 999px;
  background-color: var(--link-active-color);
  transition: width 0.35s ease;
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

.tp-m-bar__fill--indeterminate {
  position: absolute;
  inset: 0 auto 0 0;
  width: 38%;
  animation: tp-m-indeterminate 1.4s ease-in-out infinite;
}

@keyframes tp-m-indeterminate {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(360%);
  }
}

/* ===== 元信息 / 操作 ===== */
.tp-m-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.45rem;
  font-size: 10px;
  color: var(--text-color-secondary);
}

.tp-m-meta__date {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-m-method {
  padding: 0.02rem 0.3rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 9.5px;
  border-radius: 5px;
  background-color: color-mix(in oklab, var(--text-color) 8%, transparent);
  color: color-mix(in oklab, var(--text-color) 80%, var(--app-bg-color));
}

.tp-m-method--sm {
  font-size: 9px;
}

.tp-m-cancel {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  flex: none;
  padding: 0.22rem 0.5rem;
  font-size: 10.5px;
  font-weight: 500;
  border-radius: 7px;
  cursor: pointer;
  color: var(--color-error);
  background-color: color-mix(in oklab, var(--color-error) 10%, transparent);
  transition: background-color 0.15s ease, transform 0.1s ease;
}

.tp-m-cancel:active:not(:disabled) {
  transform: scale(0.96);
  background-color: color-mix(in oklab, var(--color-error) 18%, transparent);
}

.tp-m-cancel:disabled {
  opacity: 0.6;
}

/* ===== 子任务折叠 ===== */
.tp-m-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  margin-top: 0.5rem;
  padding-top: 0.45rem;
  border-top: 1px solid color-mix(in oklab, var(--border-color) 70%, transparent);
  font-size: 10.5px;
  font-weight: 500;
  color: var(--link-active-color);
  cursor: pointer;
}

.tp-m-toggle__chevron {
  font-size: 9px;
  transition: transform 0.2s ease;
}

.tp-m-toggle.is-open .tp-m-toggle__chevron {
  transform: rotate(180deg);
}

.tp-m-subs {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: 0.45rem;
}

.tp-m-sub {
  padding: 0.4rem 0.5rem;
  border-radius: 8px;
  background-color: color-mix(in oklab, var(--text-color) 4%, var(--app-bg-color));
  border: 1px solid color-mix(in oklab, var(--border-color) 75%, transparent);
}

.tp-m-sub__head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}

.tp-m-sub__name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-m-sub__progress {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.3rem;
}

.tp-m-sub__pct {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 9.5px;
  color: var(--text-color-secondary);
}

.tp-m-sub__meta {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.25rem;
  font-size: 9.5px;
  color: var(--text-color-secondary);
}

.tp-m-sub__target {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-m-sub__msg {
  margin-top: 0.3rem;
  font-size: 9.5px;
  line-height: 1.45;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--text-color-secondary);
  word-break: break-word;
}

.tp-m-sub__msg--error {
  padding: 0.3rem 0.35rem;
  border-radius: 6px;
  color: color-mix(in oklab, var(--color-error) 82%, var(--text-color));
  background-color: color-mix(in oklab, var(--color-error) 9%, transparent);
}

/* ===== 状态页 ===== */
.tp-m-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 1rem;
  text-align: center;
}

.tp-m-state__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 3rem;
  height: 3rem;
  margin-bottom: 0.75rem;
  border-radius: 14px;
  font-size: 1.1rem;
  color: var(--text-color-secondary);
  background-color: color-mix(in oklab, var(--text-color) 7%, transparent);
}

.tp-m-state__icon--error {
  color: var(--color-error);
  background-color: color-mix(in oklab, var(--color-error) 12%, transparent);
}

.tp-m-state__title {
  font-size: 0.85rem;
  font-weight: 600;
}

.tp-m-state__text {
  margin-top: 0.25rem;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-color-secondary);
  word-break: break-word;
}

.tp-m-retry {
  margin-top: 0.85rem;
  padding: 0.35rem 0.9rem;
  font-size: 11.5px;
  font-weight: 500;
  border-radius: 8px;
  cursor: pointer;
  color: var(--color-error);
  background-color: color-mix(in oklab, var(--color-error) 12%, transparent);
}

.tp-m-inline-error {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.55rem;
  font-size: 10.5px;
  border-radius: 8px;
  color: color-mix(in oklab, var(--color-error) 80%, var(--text-color));
  background-color: color-mix(in oklab, var(--color-error) 9%, transparent);
}

.tp-m-inline-error button {
  flex: none;
  padding: 0.05rem 0.4rem;
  font-weight: 600;
  border-radius: 5px;
  background-color: color-mix(in oklab, var(--color-error) 14%, transparent);
  color: inherit;
  cursor: pointer;
}

/* ===== 骨架屏 / 页脚提示 ===== */
.tp-m-skeleton {
  height: 10px;
  border-radius: 5px;
  margin-bottom: 0.4rem;
  background-color: color-mix(in oklab, var(--text-color) 10%, transparent);
  animation: tp-m-shimmer 1.4s ease-in-out infinite;
}

.tp-m-skeleton--sm {
  height: 8px;
}

.tp-m-skeleton--bar {
  height: 5px;
  margin-bottom: 0;
}

@keyframes tp-m-shimmer {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 0.9;
  }
}

.tp-m-foot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  padding: 0.5rem 0 0;
  font-size: 10px;
  color: var(--text-color-secondary);
  opacity: 0.75;
}

@media (prefers-reduced-motion: reduce) {
  .tp-m-bar__fill,
  .tp-m-toggle__chevron {
    transition: none;
  }
  .tp-m-live__dot,
  .tp-m-skeleton,
  .tp-m-bar__fill--indeterminate {
    animation: none;
  }
}
</style>
