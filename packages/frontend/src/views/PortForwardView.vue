<template>
  <div class="flex flex-col h-full min-h-0 bg-background text-foreground">
    <!-- 头部：只留标题 + 新增 -->
    <div class="flex items-center justify-between px-3 h-10 flex-shrink-0 border-b border-border bg-header/40">
      <div class="flex items-center gap-2 min-w-0">
        <i class="fas fa-arrow-right-arrow-left text-sm"></i>
        <span class="text-sm font-semibold truncate">{{ $t('portForward.title', '端口转发') }}</span>
        <span v-if="activeConnectionName" class="text-xs text-text-secondary truncate">· {{ activeConnectionName }}</span>
      </div>
      <button
        type="button"
        class="w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:text-primary hover:bg-hover transition-colors pf-ibtn"
        :disabled="!connectionId"
        @click="openEditor()"
        :title="$t('portForward.add', '新建规则')"
      >
        <i class="fas fa-plus text-xs"></i>
      </button>
    </div>

    <!-- 没有活动连接 -->
    <div v-if="!connectionId" class="flex-grow flex flex-col items-center justify-center gap-2 text-text-secondary/60 px-4 text-center">
      <i class="fas fa-plug-circle-xmark text-2xl"></i>
      <span class="text-xs">{{ $t('portForward.noSession', '先打开一个 SSH 会话') }}</span>
    </div>

    <!-- 规则列表 -->
    <div v-else class="flex-grow overflow-y-auto custom-scroll px-2 py-2 space-y-1.5">
      <!-- 只有首屏（还没有数据）才占位转圈；后续刷新一律静默，否则一点按钮整个列表就消失再跳回来 -->
      <div v-if="loading && rules.length === 0" class="text-xs text-text-secondary text-center py-6">
        <i class="fas fa-spinner fa-spin mr-1"></i>
      </div>

      <div
        v-else-if="rules.length === 0"
        class="text-xs text-text-secondary/70 text-center py-8 px-3 border border-dashed border-border/60 rounded-lg"
      >
        {{ $t('portForward.empty', '还没有规则') }}
      </div>

      <div
        v-for="rule in rules"
        :key="rule.id"
        class="rounded-lg border border-border/70 bg-background-alt/40 px-2.5 py-2 hover:border-primary/40 transition-colors"
      >
        <div class="flex items-center gap-1.5">
          <span
            class="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded border flex-shrink-0 pf-type"
            :class="typeBadgeClass(rule.type)"
          >{{ typeBadge(rule.type) }}</span>
          <span class="text-xs font-mono text-foreground truncate">
            {{ rule.bind_host }}:{{ rule.bind_port }}
          </span>
          <i v-if="rule.type !== 'dynamic'" class="fas fa-arrow-right text-[9px] text-text-secondary/60 flex-shrink-0"></i>
          <span v-if="rule.type !== 'dynamic'" class="text-xs font-mono text-text-secondary truncate">
            {{ rule.target_host }}:{{ rule.target_port }}
          </span>
        </div>

        <div class="flex items-center justify-between mt-1.5">
          <span
            class="text-[11px] flex items-center gap-1.5 min-w-0 pf-status"
            :class="statusTextClass(rule)"
          >
            <!-- 状态点用 div 不用 <i>：全局 `i { color: var(--icon-color) }` 会盖掉继承色，圆点永远是灰的 -->
            <span class="w-1.5 h-1.5 rounded-full flex-shrink-0 transition-colors pf-dot" :class="dotClass(rule)"></span>
            <span v-if="statusOf(rule.id).running">{{ $t('portForward.running', '运行中') }}</span>
            <span v-else-if="statusOf(rule.id).error" class="truncate max-w-[140px]" :title="statusOf(rule.id).error">{{ statusOf(rule.id).error }}</span>
            <span v-else>{{ $t('portForward.stopped', '已停止') }}</span>
          </span>

          <div class="flex items-center gap-1">
            <button
              type="button"
              class="w-6 h-6 flex items-center justify-center rounded text-xs transition-colors disabled:opacity-60 pf-ibtn pf-action"
              :class="statusOf(rule.id).running ? 'pf-action--stop' : 'pf-action--start'"
              :disabled="busyIds.has(rule.id)"
              @click="toggleRule(rule)"
              :title="statusOf(rule.id).running ? $t('portForward.stop', '停止') : $t('portForward.start', '启动')"
            >
              <!-- 只让这一条转圈，不要整列表重绘 -->
              <i v-if="busyIds.has(rule.id)" class="fas fa-spinner fa-spin"></i>
              <i v-else :class="statusOf(rule.id).running ? 'fas fa-stop' : 'fas fa-play'"></i>
            </button>
            <button
              type="button"
              class="w-6 h-6 flex items-center justify-center rounded text-xs text-text-secondary hover:text-primary hover:bg-hover transition-colors pf-ibtn"
              @click="openEditor(rule)"
              :title="$t('common.edit', '编辑')"
            >
              <i class="fas fa-pen-to-square"></i>
            </button>
            <button
              type="button"
              class="w-6 h-6 flex items-center justify-center rounded text-xs text-text-secondary hover:bg-hover transition-colors pf-ibtn pf-del"
              @click="removeRule(rule)"
              :title="$t('common.delete', '删除')"
            >
              <i class="fas fa-trash-can"></i>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 新建 / 编辑 -->
    <div v-if="editing" class="flex-shrink-0 border-t border-border p-3 space-y-2 bg-background-alt/40">
      <div class="flex items-center gap-2">
        <AppSelect v-model="form.type" class="flex-1">
          <option value="local">{{ $t('portForward.type.local', '本地转发 (-L)') }}</option>
          <option value="dynamic">{{ $t('portForward.type.dynamic', '动态 SOCKS (-D)') }}</option>
          <option value="remote">{{ $t('portForward.type.remote', '远程转发 (-R)') }}</option>
        </AppSelect>
        <button class="text-xs text-text-secondary hover:text-foreground" @click="cancelEdit">
          <i class="fas fa-xmark"></i>
        </button>
      </div>

      <div class="flex items-center gap-1.5">
        <input
          v-model="form.bind_host"
          class="w-[92px] h-8 px-2 text-xs font-mono bg-background border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          :placeholder="$t('portForward.bindHost', '监听地址')"
        />
        <span class="text-text-secondary text-xs">:</span>
        <input
          v-model.number="form.bind_port"
          type="number"
          class="w-[72px] h-8 px-2 text-xs font-mono bg-background border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          :placeholder="$t('portForward.bindPort', '端口')"
        />
      </div>

      <div v-if="form.type !== 'dynamic'" class="flex items-center gap-1.5">
        <i class="fas fa-arrow-right text-[9px] text-text-secondary/60"></i>
        <input
          v-model="form.target_host"
          class="flex-1 h-8 px-2 text-xs font-mono bg-background border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          :placeholder="$t('portForward.targetHost', '目标地址')"
        />
        <span class="text-text-secondary text-xs">:</span>
        <input
          v-model.number="form.target_port"
          type="number"
          class="w-[72px] h-8 px-2 text-xs font-mono bg-background border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          :placeholder="$t('portForward.targetPort', '端口')"
        />
      </div>

      <div class="flex items-center justify-between">
        <label class="flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer">
          <input type="checkbox" v-model="form.auto_start" class="accent-primary" />
          {{ $t('portForward.autoStart', '随应用启动') }}
        </label>
        <button
          type="button"
          class="h-7 px-3 rounded-md text-xs font-medium bg-primary text-white hover:bg-primary-dark disabled:opacity-50"
          :disabled="saving"
          @click="save"
        >
          {{ $t('common.save', '保存') }}
        </button>
      </div>

      <p v-if="formError" class="text-[11px] text-red-400">{{ formError }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '../stores/session.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import apiClient from '../utils/apiClient';
import AppSelect from '../components/common/AppSelect.vue';

interface Rule {
  id: number;
  connection_id: number;
  type: 'local' | 'remote' | 'dynamic';
  bind_host: string;
  bind_port: number;
  target_host: string | null;
  target_port: number | null;
  auto_start: number;
}

interface Status {
  ruleId: number;
  running: boolean;
  error?: string;
  connCount?: number;
}

const sessionStore = useSessionStore();
const { activeSession } = storeToRefs(sessionStore);
const { showConfirmDialog } = useConfirmDialog();
const { t } = useI18n();

const connectionId = computed(() => {
  const raw = activeSession.value?.connectionId;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
});
const activeConnectionName = computed(() => activeSession.value?.connectionName ?? '');

const rules = ref<Rule[]>([]);
const statuses = ref<Record<number, Status>>({});
const loading = ref(false);
const saving = ref(false);
const formError = ref('');
// 正在启停的规则 id：只让对应那条的按钮转圈，列表本身不动
const busyIds = ref<Set<number>>(new Set());

const editing = ref(false);
const editingId = ref<number | null>(null);
const form = ref({
  type: 'local' as Rule['type'],
  bind_host: '127.0.0.1',
  bind_port: 8080,
  target_host: '127.0.0.1',
  target_port: 80,
  auto_start: true,
});

const statusOf = (id: number): Status => statuses.value[id] ?? { ruleId: id, running: false };

// 状态点：用实心 div 上色（<i> 会被全局 icon 颜色接管）
const dotClass = (rule: Rule) => {
  if (busyIds.value.has(rule.id)) return 'pf-dot--busy';
  const s = statusOf(rule.id);
  if (s.running) return 'pf-dot--running';
  if (s.error) return 'pf-dot--error';
  return '';
};

const statusTextClass = (rule: Rule) => {
  const s = statusOf(rule.id);
  if (s.running) return 'pf-status--running';
  if (s.error) return 'pf-status--error';
  return '';
};

const typeBadge = (t: Rule['type']) => (t === 'local' ? 'L' : t === 'dynamic' ? 'D' : 'R');
const typeBadgeClass = (t: Rule['type']) => {
  if (t === 'local') return 'pf-type--local';
  if (t === 'dynamic') return 'pf-type--dynamic';
  return 'pf-type--remote';
};

const load = async (silent = false) => {
  if (!connectionId.value) {
    rules.value = [];
    statuses.value = {};
    return;
  }
  if (!silent) loading.value = true;
  try {
    const res = await apiClient.get('/port-forwards', { params: { connectionId: connectionId.value } });
    rules.value = res.data.rules ?? [];
    statuses.value = Object.fromEntries((res.data.statuses ?? []).map((s: Status) => [s.ruleId, s]));
  } catch (err: any) {
    console.error('[PortForward] 加载失败:', err?.message);
  } finally {
    loading.value = false;
  }
};

const openEditor = (rule?: Rule) => {
  formError.value = '';
  editing.value = true;
  editingId.value = rule?.id ?? null;
  form.value = rule
    ? {
        type: rule.type,
        bind_host: rule.bind_host,
        bind_port: rule.bind_port,
        target_host: rule.target_host ?? '127.0.0.1',
        target_port: rule.target_port ?? 80,
        auto_start: !!rule.auto_start,
      }
    : { type: 'local', bind_host: '127.0.0.1', bind_port: 8080, target_host: '127.0.0.1', target_port: 80, auto_start: true };
};

const cancelEdit = () => {
  editing.value = false;
  editingId.value = null;
  formError.value = '';
};

const save = async () => {
  if (!connectionId.value) return;
  const payload = {
    type: form.value.type,
    bind_host: form.value.bind_host || '127.0.0.1',
    bind_port: Number(form.value.bind_port),
    target_host: form.value.type === 'dynamic' ? null : form.value.target_host,
    target_port: form.value.type === 'dynamic' ? null : Number(form.value.target_port),
    auto_start: form.value.auto_start,
  };
  if (!payload.bind_port || payload.bind_port < 1 || payload.bind_port > 65535) {
    formError.value = '监听端口不合法';
    return;
  }
  saving.value = true;
  formError.value = '';
  try {
    if (editingId.value) {
      await apiClient.put(`/port-forwards/${editingId.value}`, payload);
    } else {
      await apiClient.post('/port-forwards', payload, { params: { connectionId: connectionId.value } });
    }
    cancelEdit();
    await load(true);
  } catch (err: any) {
    formError.value = err?.response?.data?.message || err?.message || '保存失败';
  } finally {
    saving.value = false;
  }
};

const toggleRule = async (rule: Rule) => {
  if (busyIds.value.has(rule.id)) return;
  const running = statusOf(rule.id).running;
  busyIds.value.add(rule.id);
  try {
    if (running) {
      await apiClient.post(`/port-forwards/${rule.id}/stop`);
    } else {
      await apiClient.post(`/port-forwards/${rule.id}/start`);
    }
  } catch (err: any) {
    console.error('[PortForward] 启停失败:', err?.message);
  } finally {
    // 先刷到新状态再撤掉转圈，否则中间会闪一帧旧图标
    await load(true);
    busyIds.value.delete(rule.id);
  }
};

const removeRule = async (rule: Rule) => {
  const confirmed = await showConfirmDialog({
    message: t('portForward.confirmDelete', { target: `${rule.bind_host}:${rule.bind_port}` }),
  });
  if (!confirmed) return;
  try {
    await apiClient.delete(`/port-forwards/${rule.id}`);
    await load(true);
  } catch (err: any) {
    console.error('[PortForward] 删除失败:', err?.message);
  }
};

// 连接断开时会由后端自动重连，状态得跟着变，5s 静默刷一次
let pollTimer: ReturnType<typeof setInterval> | null = null;

watch(
  connectionId,
  id => {
    // 换会话时先把上一个会话的规则清掉，别让它们留在屏幕上被误认为新会话的
    rules.value = [];
    statuses.value = {};
    load();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    // 轮询也要静默：每 5 秒把列表换成转圈会一直闪
    if (id) pollTimer = setInterval(() => { if (!saving.value) load(true); }, 5000);
  },
  { immediate: true },
);

onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });
</script>

<style scoped>
/*
 * 状态色统一走语义变量 + color-mix。
 * 本项目没有 `.dark` 类，深浅主题靠 :root 变量整体切换，所以 `dark:` 前缀永远不会生效；
 * 直接写 text-emerald-400 / text-sky-400 这类固定色，在浅色底上会淡到几乎看不见。
 * 把状态色和 --text-color 混一混：浅色主题下自动加深、深色主题下自动提亮。
 */
.pf-status {
  color: var(--text-color-secondary);
}
.pf-status--running {
  color: color-mix(in oklab, var(--color-success) 78%, var(--text-color));
}
.pf-status--error {
  color: color-mix(in oklab, var(--color-error) 78%, var(--text-color));
}

.pf-dot {
  background-color: color-mix(in oklab, var(--text-color) 32%, transparent);
}
.pf-dot--running {
  background-color: color-mix(in oklab, var(--color-success) 88%, var(--text-color));
}
.pf-dot--error {
  background-color: color-mix(in oklab, var(--color-error) 88%, var(--text-color));
}
.pf-dot--busy {
  background-color: color-mix(in oklab, var(--text-color) 28%, transparent);
  animation: pf-pulse 1s ease-in-out infinite;
}

.pf-action {
  color: var(--text-color-secondary);
}
.pf-action--start {
  color: color-mix(in oklab, var(--color-success) 78%, var(--text-color));
}
.pf-action--stop {
  color: color-mix(in oklab, #ea580c 82%, var(--text-color));
}
.pf-action--start:hover {
  background-color: color-mix(in oklab, var(--color-success) 16%, transparent);
}
.pf-action--stop:hover {
  background-color: color-mix(in oklab, #ea580c 16%, transparent);
}
/* 全局 `i, .fas { color: var(--icon-color) }` 没有分层，会盖掉按钮自己的颜色 */
.pf-ibtn i {
  color: inherit;
}

.pf-del:hover {
  color: var(--color-error);
  background-color: color-mix(in oklab, var(--color-error) 14%, transparent);
}

.pf-type {
  color: color-mix(in oklab, var(--pf-accent) 78%, var(--text-color));
  border-color: color-mix(in oklab, var(--pf-accent) 42%, transparent);
  background-color: color-mix(in oklab, var(--pf-accent) 12%, transparent);
}
.pf-type--local {
  --pf-accent: #0284c7;
}
.pf-type--dynamic {
  --pf-accent: #7c3aed;
}
.pf-type--remote {
  --pf-accent: #d97706;
}

@keyframes pf-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
</style>
