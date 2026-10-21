<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSessionStore } from '../../stores/session.store';
import { useConnectionsStore } from '../../stores/connections.store';
import RdpView from './RdpView.vue';
import VncView from './VncView.vue';

/**
 * RDP / VNC 会话的工作区面板。
 *
 * 和 SSH 不一样，远程桌面没有"分屏布局"这个概念可讲：
 * 它就是一个完整的桌面画面，所以这里不接 LayoutRenderer，
 * 直接由面板自己占满整个工作区（专用布局，用户不可编辑）。
 *
 * 面板只负责外壳：状态、重新连接、Ctrl+Alt+Del、剪贴板；
 * 协议与解码全在 RdpView / VncView 里。
 */
const props = withDefaults(
  defineProps<{
    sessionId: string;
    /** 是否是当前激活的标签。非激活时画面保持挂载但不建立连接（避免后台偷偷拉远程通道） */
    active?: boolean;
    isMobile?: boolean;
  }>(),
  { active: false, isMobile: false }
);

const { t } = useI18n();
const sessionStore = useSessionStore();
const connectionsStore = useConnectionsStore();

const session = computed(() => sessionStore.sessions.get(props.sessionId) ?? null);
const protocol = computed<'rdp' | 'vnc'>(() => (session.value?.kind === 'vnc' ? 'vnc' : 'rdp'));
const connection = computed(() => {
  const current = session.value;
  if (!current) return null;
  return connectionsStore.connections.find((c) => String(c.id) === String(current.connectionId)) ?? null;
});
const endpoint = computed(() => {
  const conn = connection.value;
  if (!conn) return '';
  return `${conn.host}:${conn.port}`;
});

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

const status = ref<'connecting' | 'connected' | 'error' | 'disconnected'>('connecting');
const statusMessage = ref(t('remoteDesktop.status.fetchingToken'));

function onStatus(payload: { status: 'connecting' | 'connected' | 'error' | 'disconnected'; message?: string }) {
  status.value = payload.status;
  statusMessage.value = payload.message || t(`remoteDesktop.status.${payload.status}`);
  // 标签栏指示灯读的是会话上的 remoteStatus
  if (session.value?.remoteStatus) {
    session.value.remoteStatus.value = payload.status;
  }
}

const statusToneClass = computed(() => {
  switch (status.value) {
    case 'connected': return 'bg-green-500/15 text-green-500 border-green-500/30';
    case 'connecting': return 'bg-yellow-500/15 text-yellow-500 border-yellow-500/30';
    case 'error': return 'bg-red-500/15 text-red-500 border-red-500/30';
    default: return 'bg-gray-500/15 text-text-secondary border-border';
  }
});

const statusDotClass = computed(() => {
  switch (status.value) {
    case 'connected': return 'bg-green-500';
    case 'connecting': return 'bg-yellow-500 animate-pulse';
    case 'error': return 'bg-red-500';
    default: return 'bg-gray-400';
  }
});

/* ------------------------------------------------------------------ *
 * 画面容器尺寸（RDP 要用它作为远端桌面分辨率）
 * ------------------------------------------------------------------ */

const stageRef = ref<HTMLElement | null>(null);
const rootRef = ref<HTMLElement | null>(null);
const size = ref({ width: 0, height: 0 });
const started = ref(false);
const viewRef = ref<any>(null);
const isFullscreen = ref(false);
let resizeObserver: ResizeObserver | null = null;

function measure() {
  const el = stageRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  size.value = { width: Math.round(rect.width), height: Math.round(rect.height) };
}

/**
 * 第一次被激活时才建连。
 *
 * 会话标签是 v-show 保活的，所有标签的 RemoteSessionPane 都会挂载；
 * 如果挂载即连接，打开 5 个远程标签就是 5 条并发 RDP/VNC 隧道。
 */
function tryStart() {
  if (started.value || !props.active) return;
  measure();
  if (size.value.width < 32 || size.value.height < 32) return; // 还没被显示出来
  started.value = true;
}

/* ------------------------------------------------------------------ *
 * 工具栏弹出面板
 *
 * 剪贴板 / 发送文字 都是「点按钮在工具栏下面展开一块」，同一时刻只允许开一个：
 * 两个面板都右对齐、宽度一样，同时开会直接叠在一起。
 * ------------------------------------------------------------------ */

type PanelName = 'none' | 'clipboard' | 'typing';
const openPanel = ref<PanelName>('none');
const clipboardOpen = computed(() => openPanel.value === 'clipboard');
const typingOpen = computed(() => openPanel.value === 'typing');

function togglePanel(name: PanelName) {
  openPanel.value = openPanel.value === name ? 'none' : name;
}

const clipboardText = ref('');
const clipboardBusy = ref(false);
const toast = ref<{ ok: boolean; text: string } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(ok: boolean, text: string) {
  toast.value = { ok, text };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = null; }, 2800);
}

function onClipboardEvent(payload: { direction: 'up' | 'down'; ok: boolean; message?: string }) {
  if (payload.ok) {
    showToast(true, t(payload.direction === 'up' ? 'remoteDesktop.clipboard.sentOk' : 'remoteDesktop.clipboard.receivedOk'));
  } else {
    showToast(false, payload.message || t('remoteDesktop.clipboard.failed'));
  }
}

async function fillFromLocal() {
  try {
    if (!navigator.clipboard?.readText) throw new Error(t('remoteDesktop.clipboard.unsupported'));
    clipboardText.value = await navigator.clipboard.readText();
  } catch (err: any) {
    showToast(false, t('remoteDesktop.clipboard.readLocalFailed', { error: err?.message || String(err) }));
  }
}

async function sendClipboard() {
  if (clipboardBusy.value) return;
  clipboardBusy.value = true;
  try {
    await viewRef.value?.pushLocalClipboard(clipboardText.value || undefined);
  } finally {
    clipboardBusy.value = false;
  }
}

async function pullClipboard() {
  if (clipboardBusy.value) return;
  clipboardBusy.value = true;
  try {
    await viewRef.value?.pullRemoteClipboard();
  } finally {
    clipboardBusy.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * 发送文字（模拟键盘输入）
 *
 * 和剪贴板是两条不同的通路：剪贴板要远端有剪贴板管理器才生效，
 * 精简桌面（LXDE / 无 xclip）里"发送到远端"成功了却粘贴不出来。
 * 这条按 KeyEvent 一个个敲，服务端只收键盘事件就能用。
 * 目前只有 noVNC 有实现（RDP 的剪贴板在 Windows 上是通的）。
 * ------------------------------------------------------------------ */

const typingText = ref('');
const typingBusy = ref(false);
const typingInputRef = ref<HTMLInputElement | null>(null);

function toggleTyping() {
  togglePanel('typing');
  if (openPanel.value === 'typing') {
    // 移动端不自动聚焦（软键盘会把画面顶没）
    if (!props.isMobile) {
      void nextTick().then(() => typingInputRef.value?.focus());
    }
  }
}

async function sendTypedText() {
  if (typingBusy.value || status.value !== 'connected') return;
  const text = typingText.value;
  if (!text) {
    showToast(false, t('remoteDesktop.typeText.empty'));
    return;
  }
  typingBusy.value = true;
  try {
    const result = await viewRef.value?.sendText?.(text);
    if (!result) {
      showToast(false, t('remoteDesktop.typeText.unsupported'));
      return;
    }
    if (result.ok) {
      showToast(true, t('remoteDesktop.typeText.sentOk', { count: result.count }));
      typingText.value = '';
      // 接着敲下一条命令，别让人再点一次输入框
      if (!props.isMobile) typingInputRef.value?.focus();
    } else {
      showToast(false, result.message || t('remoteDesktop.typeText.failed', { error: '' }));
    }
  } finally {
    typingBusy.value = false;
  }
}

function sendCtrlAltDel() {
  viewRef.value?.sendCtrlAltDel();
}

/* 全屏：把整个面板（工具栏 + 画面）交给浏览器全屏，Esc 退出 */
function onFullscreenChange() {
  isFullscreen.value = !!document.fullscreenElement;
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await rootRef.value?.requestFullscreen();
    }
  } catch (err: any) {
    showToast(false, t('remoteDesktop.fullscreenFailed', { error: err?.message || String(err) }));
  }
}

function reconnect() {
  status.value = 'connecting';
  statusMessage.value = t('remoteDesktop.status.fetchingToken');
  openPanel.value = 'none';
  void viewRef.value?.reconnect();
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

onMounted(async () => {
  await nextTick();
  measure();
  if (typeof ResizeObserver !== 'undefined' && stageRef.value) {
    resizeObserver = new ResizeObserver(() => measure());
    resizeObserver.observe(stageRef.value);
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  tryStart();
});

watch([() => props.active, size], () => tryStart(), { deep: true });

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  if (toastTimer) clearTimeout(toastTimer);
});

// 切换标签时把弹出面板收起来，别在别的标签上留个浮层
watch(() => props.active, (active) => {
  if (!active) openPanel.value = 'none';
});
</script>

<template>
  <div ref="rootRef" class="remote-session-pane flex flex-col w-full h-full min-h-0 bg-background" :data-remote-protocol="protocol">
    <!-- 工具栏 -->
    <div class="flex items-center gap-2 px-2 h-9 flex-shrink-0 bg-header border-b border-border text-xs select-none" :class="{ 'h-8': isMobile }">
      <span class="w-2 h-2 rounded-full flex-shrink-0" :class="statusDotClass"></span>
      <span class="font-medium text-foreground truncate max-w-[40%]" :title="connection?.name || session?.connectionName">
        {{ connection?.name || session?.connectionName || '—' }}
      </span>
      <span class="text-text-secondary truncate hidden sm:inline">{{ endpoint }}</span>
      <span class="px-1.5 py-0.5 rounded border uppercase tracking-wide text-[10px] font-semibold flex-shrink-0" :class="statusToneClass">
        {{ protocol }}
      </span>
      <span class="px-1.5 py-0.5 rounded text-[11px] flex-shrink-0" :class="statusToneClass">
        {{ t('remoteDesktop.status.' + status) }}
      </span>

      <div class="ml-auto flex items-center gap-1 flex-shrink-0">
        <button
          class="px-2 h-7 rounded text-foreground bg-hover hover:bg-button-hover transition-colors disabled:opacity-50"
          :title="t('remoteDesktop.ctrlAltDelTooltip')"
          :disabled="status !== 'connected'"
          @click="sendCtrlAltDel"
        >
          <i class="fas fa-keyboard mr-1"></i>Ctrl+Alt+Del
        </button>

        <div class="relative">
          <button
            class="px-2 h-7 rounded text-foreground bg-hover hover:bg-button-hover transition-colors flex items-center"
            :class="{ 'ring-1 ring-primary': clipboardOpen }"
            :title="t('remoteDesktop.clipboard.buttonTooltip')"
            @click="togglePanel('clipboard')"
          >
            <i class="fas fa-clipboard"></i>
            <span class="ml-1 hidden md:inline">{{ t('remoteDesktop.clipboard.button') }}</span>
          </button>

          <div
            v-if="clipboardOpen"
            class="absolute right-0 top-8 z-30 w-[320px] p-2 rounded-md border border-border bg-background shadow-lg flex flex-col gap-2"
          >
            <textarea
              v-model="clipboardText"
              rows="4"
              class="w-full px-2 py-1 text-xs rounded border border-border bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-y"
              :placeholder="t('remoteDesktop.clipboard.placeholder')"
            ></textarea>
            <div class="flex items-center gap-1 flex-wrap">
              <button
                class="px-2 py-1 rounded text-[11px] bg-hover text-foreground hover:bg-button-hover disabled:opacity-50"
                :disabled="status !== 'connected'"
                @click="fillFromLocal"
              >
                {{ t('remoteDesktop.clipboard.readLocal') }}
              </button>
              <button
                class="px-2 py-1 rounded text-[11px] bg-primary text-white hover:bg-primary-dark disabled:opacity-50"
                :disabled="status !== 'connected' || clipboardBusy"
                @click="sendClipboard"
              >
                {{ t('remoteDesktop.clipboard.send') }}
              </button>
              <button
                class="px-2 py-1 rounded text-[11px] bg-hover text-foreground hover:bg-button-hover disabled:opacity-50"
                :disabled="status !== 'connected' || clipboardBusy"
                @click="pullClipboard"
              >
                {{ t('remoteDesktop.clipboard.receive') }}
              </button>
            </div>
          </div>
        </div>

        <!-- 发送文字（模拟键盘输入）—— VNC 专用 -->
        <div v-if="protocol === 'vnc'" class="relative">
          <button
            class="px-2 h-7 rounded text-foreground bg-hover hover:bg-button-hover transition-colors flex items-center"
            :class="{ 'ring-1 ring-primary': typingOpen }"
            :title="t('remoteDesktop.typeText.buttonTooltip')"
            @click="toggleTyping"
          >
            <i class="fas fa-terminal"></i>
            <span class="ml-1 hidden md:inline">{{ t('remoteDesktop.typeText.button') }}</span>
          </button>

          <div
            v-if="typingOpen"
            class="absolute right-0 top-8 z-30 w-[320px] p-2 rounded-md border border-border bg-background shadow-lg"
          >
            <div class="flex items-center gap-1">
              <input
                ref="typingInputRef"
                v-model="typingText"
                type="text"
                class="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-border bg-input text-foreground select-text focus:outline-none focus:ring-1 focus:ring-primary"
                :placeholder="t('remoteDesktop.typeText.placeholder')"
                :disabled="status !== 'connected'"
                @keydown.enter.prevent="sendTypedText"
              />
              <button
                class="px-2 py-1 rounded text-[11px] bg-primary text-white hover:bg-primary-dark disabled:opacity-50 flex-shrink-0"
                :disabled="status !== 'connected' || typingBusy"
                @click="sendTypedText"
              >
                {{ t('remoteDesktop.typeText.send') }}
              </button>
            </div>
          </div>
        </div>

        <button
          class="px-2 h-7 rounded text-foreground bg-hover hover:bg-button-hover transition-colors"
          :title="isFullscreen ? t('remoteDesktop.exitFullscreen') : t('remoteDesktop.fullscreen')"
          @click="toggleFullscreen"
        >
          <i class="fas" :class="isFullscreen ? 'fa-compress' : 'fa-expand'"></i>
        </button>

        <button
          class="px-2 h-7 rounded text-foreground bg-hover hover:bg-button-hover transition-colors disabled:opacity-50"
          :title="t('remoteDesktop.reconnectTooltip')"
          :disabled="status === 'connecting'"
          @click="reconnect"
        >
          <i class="fas" :class="status === 'connecting' ? 'fa-spinner fa-spin' : 'fa-redo'"></i>
        </button>
      </div>
    </div>

    <!-- 画面 -->
    <div ref="stageRef" class="relative flex-grow min-h-0 w-full bg-black overflow-hidden" @mousedown="openPanel = 'none'">
      <template v-if="started && connection">
        <RdpView
          v-if="protocol === 'rdp'"
          ref="viewRef"
          :connection="connection"
          :width="size.width"
          :height="size.height"
          @status="onStatus"
          @clipboard="onClipboardEvent"
        />
        <VncView
          v-else
          ref="viewRef"
          :connection="connection"
          @status="onStatus"
          @clipboard="onClipboardEvent"
        />
      </template>

      <!-- 连接信息丢了（连接被删掉） -->
      <div v-else-if="!connection" class="absolute inset-0 flex items-center justify-center text-center text-sm text-text-secondary p-6">
        <div>
          <i class="fas fa-unlink text-3xl mb-3"></i>
          <p>{{ t('remoteDesktop.errors.noConnection') }}</p>
        </div>
      </div>

      <!-- 连接中 / 出错 / 已断开遮罩 -->
      <div
        v-if="connection && status !== 'connected'"
        class="absolute inset-0 flex items-center justify-center bg-black/80 text-white p-4 z-10"
      >
        <div class="text-center max-w-md">
          <i v-if="status === 'connecting'" class="fas fa-spinner fa-spin fa-2x mb-3"></i>
          <i v-else-if="status === 'error'" class="fas fa-exclamation-triangle fa-2x mb-3 text-red-400"></i>
          <i v-else class="fas fa-plug-circle-xmark fa-2x mb-3 text-text-secondary"></i>
          <p class="text-sm break-words">{{ statusMessage }}</p>
          <button
            v-if="status !== 'connecting'"
            class="mt-4 px-3 py-1 bg-primary text-white rounded text-xs hover:bg-primary-dark"
            @click="reconnect"
          >
            {{ t('common.retry') }}
          </button>
        </div>
      </div>

      <!-- 剪贴板 / 操作反馈 -->
      <div
        v-if="toast"
        class="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 max-w-[80%] px-3 py-1.5 rounded shadow-lg text-xs flex items-center gap-2"
        :class="toast.ok ? 'bg-green-600/90 text-white' : 'bg-red-600/90 text-white'"
      >
        <i class="fas" :class="toast.ok ? 'fa-check' : 'fa-triangle-exclamation'"></i>
        <span class="truncate" :title="toast.text">{{ toast.text }}</span>
      </div>
    </div>
  </div>
</template>
