<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { requestRemoteSession, type RemoteSessionInfo } from './useRemoteSession';
import type { ConnectionInfo } from '../../stores/connections.store';

/**
 * RDP 画面。
 *
 * 渲染完全在浏览器里做：IronRDP 的 WASM 客户端负责 RDP 协议与解码，
 * 后端只当一个 RDCleanPath 代理（转发 X.224、回传服务器证书链，之后纯字节隧道），
 * 所以既没有 guacd 也不需要 Docker，桌面端和 Web 端跑的是同一套代码。
 *
 * 剪贴板（双向，见下方 setupClipboard / applyRemoteClipboard / pushLocalClipboard）：
 * 内核自己做两条路——浏览器支持 `navigator.clipboard.read/write` 时开「自动模式」
 * （100ms 轮询本机剪贴板、远端变更直接写系统剪贴板）；一旦浏览器因为缺少用户手势
 * 拒绝读取，内核会自己降级成「手动模式」并回调 onClipboardRemoteUpdateCallback，
 * 这时必须由我们调 saveRemoteClipboardData() 才能真正落到系统剪贴板。
 */
const props = defineProps<{
  connection: ConnectionInfo;
  width: number;
  height: number;
}>();

const emit = defineEmits<{
  (e: 'status', payload: { status: 'connecting' | 'connected' | 'error' | 'disconnected'; message?: string }): void;
  (e: 'clipboard', payload: { direction: 'up' | 'down'; ok: boolean; message?: string }): void;
}>();

const { t } = useI18n();

/**
 * IronRDP 的 WASM 层抛出的是 wasm-bindgen 包装的 IronError（不是 Error），
 * 直接 String(err) 只会得到 "[object Object]" 或 `{"__wbg_ptr":…}`。
 * 它有 kind() / rdcleanpathDetails() 两个方法，可以翻成人话；
 * 剪贴板这类 `throw { kind, backtrace }` 的轻量错误连 kind 都是 General，
 * 真正有用的信息在 backtrace() 里，所以优先拿它。
 */
const IRON_ERROR_KINDS: Record<number, string> = {
  0: 'general',
  1: 'wrongPassword',
  2: 'logonFailure',
  3: 'accessDenied',
  4: 'rdcLeanPath',
  5: 'proxyConnect',
  6: 'negotiationFailure',
};

function ironBacktrace(err: any): string | null {
  try {
    if (typeof err?.backtrace !== 'function') return null;
    const text = err.backtrace();
    return typeof text === 'string' && text ? text : null;
  } catch {
    return null;
  }
}

function describeIronError(err: any): string | null {
  if (typeof err?.kind !== 'function') return null;
  let kindValue: any;
  try {
    kindValue = err.kind();
  } catch {
    return null;
  }
  const known = IRON_ERROR_KINDS[Number(kindValue)];

  // General 是内核的兜底类型（剪贴板 IO 错误都走这里），backtrace 才是真实原因
  if (!known || known === 'general') {
    const detail = ironBacktrace(err);
    if (detail) return detail;
  }

  const base = known
    ? t(`remoteDesktop.errors.rdp.${known}`)
    : t('remoteDesktop.errors.rdp.unknown', { kind: String(kindValue) });

  let extra = '';
  try {
    const details = err.rdcleanpathDetails?.();
    if (details) {
      const parts: string[] = [];
      if (details.httpStatusCode) parts.push(`HTTP ${details.httpStatusCode}`);
      if (details.wsaErrorCode) parts.push(`WSA ${details.wsaErrorCode}`);
      if (details.tlsAlertCode) parts.push(`TLS ${details.tlsAlertCode}`);
      if (parts.length) extra = ` (${parts.join(', ')})`;
    }
  } catch { /* 细节拿不到就算了 */ }

  return `${base}${extra}`;
}
function describeError(err: any): string {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  const iron = describeIronError(err);
  if (iron) return iron;
  if (typeof err.message === 'string' && err.message) return err.message;
  if (typeof err.reason === 'string' && err.reason) return err.reason;
  try {
    const json = JSON.stringify(err);
    return json && json !== '{}' ? json : String(err);
  } catch {
    return String(err);
  }
}

const hostRef = ref<HTMLDivElement | null>(null);
let element: any = null;
let interaction: any = null;
let sessionInfo: RemoteSessionInfo | null = null;
let disposed = false;
let backendModule: any = null;
/** WASM 初始化只跑一次，多开会话共享 */
let ironRdpReady: Promise<any> | null = null;

/**
 * 3.6MB 的 WASM 打包产物 + Web Component，
 * 必须懒加载：不然首页就要白白多下载几兆。打开远程会话才会走到这里。
 */
async function loadBackend(): Promise<any> {
  if (!ironRdpReady) {
    ironRdpReady = (async () => {
      const [, rdp] = await Promise.all([
        import('@devolutions/iron-remote-desktop'),
        import('@devolutions/iron-remote-desktop-rdp'),
      ]);
      const mod: any = rdp;
      // init(logLevel) 必须在使用 Backend 之前调用，否则 WASM 没起来
      await (mod.init?.('warn') ?? Promise.resolve());
      backendModule = mod.Backend;
      return mod.Backend;
    })().catch((err) => {
      ironRdpReady = null;
      throw err;
    });
  }
  return ironRdpReady;
}

function teardownElement() {
  detachFocusHooks();
  try {
    interaction?.shutdown?.();
  } catch { /* noop */ }
  interaction = null;
  pendingRemoteClipboard = false;
  if (element) {
    try { element.remove(); } catch { /* noop */ }
    element = null;
  }
}

/* ------------------------------------------------------------------ *
 * 剪贴板
 * ------------------------------------------------------------------ */

/**
 * 远端剪贴板已经拿到了，但页面不在前台 —— 浏览器不允许后台页面写剪贴板。
 * 先记下来，窗口重新获得焦点时补写（内核在写成功前不会清空待写入数据，重试是安全的）。
 */
let pendingRemoteClipboard = false;

async function applyRemoteClipboard(): Promise<void> {
  if (!interaction) return;
  try {
    await interaction.saveRemoteClipboardData();
    pendingRemoteClipboard = false;
    emit('clipboard', { direction: 'down', ok: true });
  } catch (err: any) {
    pendingRemoteClipboard = true;
    emit('clipboard', {
      direction: 'down',
      ok: false,
      message: t('remoteDesktop.clipboard.receiveFailed', { error: describeError(err) }),
    });
  }
}

/** 内核通知：远端剪贴板变了（只有手动模式会回调，自动模式下内核自己写） */
function onClipboardRemoteUpdate() {
  if (document.hasFocus()) {
    void applyRemoteClipboard();
  } else {
    pendingRemoteClipboard = true;
  }
}

function flushPendingRemoteClipboard() {
  if (!pendingRemoteClipboard || !interaction || !document.hasFocus()) return;
  void applyRemoteClipboard();
}

function attachFocusHooks() {
  window.addEventListener('focus', flushPendingRemoteClipboard);
}
function detachFocusHooks() {
  window.removeEventListener('focus', flushPendingRemoteClipboard);
}

/**
 * 把本机剪贴板（或指定文本）推到远端。
 *
 * IronRDP 的 sendClipboardData() 只会读**系统剪贴板**，没有「直接塞一段文本」的入口，
 * 所以带 text 时先写进系统剪贴板（会覆盖用户原来的内容，界面上已提示）。
 */
async function pushLocalClipboard(text?: string): Promise<boolean> {
  if (!interaction) return false;
  try {
    if (typeof text === 'string' && text.length > 0) {
      if (!navigator.clipboard?.writeText) {
        throw new Error(t('remoteDesktop.clipboard.unsupported'));
      }
      await navigator.clipboard.writeText(text);
    }
    await interaction.sendClipboardData();
    emit('clipboard', { direction: 'up', ok: true });
    return true;
  } catch (err: any) {
    emit('clipboard', {
      direction: 'up',
      ok: false,
      message: t('remoteDesktop.clipboard.sendFailed', { error: describeError(err) }),
    });
    return false;
  }
}

/** 主动把远端剪贴板同步到本机（手动按钮；自动模式下也允许点，属于兜底） */
async function pullRemoteClipboard(): Promise<boolean> {
  if (!interaction) return false;
  if (!document.hasFocus()) {
    emit('clipboard', { direction: 'down', ok: false, message: t('remoteDesktop.clipboard.needFocus') });
    return false;
  }
  await applyRemoteClipboard();
  return !pendingRemoteClipboard;
}

async function connect() {
  if (!hostRef.value || disposed) return;
  emit('status', { status: 'connecting', message: t('remoteDesktop.status.fetchingToken') });

  try {
    sessionInfo = await requestRemoteSession(Number(props.connection.id), 'rdp');
  } catch (err: any) {
    const detail = err?.response?.data?.message || describeError(err);
    emit('status', { status: 'error', message: `${t('remoteDesktop.errors.sessionRequest')}: ${detail}` });
    return;
  }

  let Backend: any;
  try {
    emit('status', { status: 'connecting', message: t('remoteDesktop.status.loadingCore') });
    Backend = await loadBackend();
  } catch (err: any) {
    emit('status', { status: 'error', message: t('remoteDesktop.errors.coreLoad', { error: describeError(err) }) });
    return;
  }

  if (disposed || !hostRef.value) return;
  teardownElement();

  const el = document.createElement('iron-remote-desktop') as any;
  el.module = Backend;
  el.style.width = '100%';
  el.style.height = '100%';
  el.style.display = 'flex';
  // 内核在 flexcenter 打开时会给自检的根 div 设 flexGrow:1，
  // 那只有在「宿主是 flex 容器、且主轴是纵向」时才会真的撑满高度；
  // 否则根 div 只有内容高度，垂直方向就居中不了（画面贴顶）。
  el.style.flexDirection = 'column';
  /* *
   * 居中的开关是 Web Component 的 `flexcenter` 属性，不是 setScale。
   * 内核里（iron-remote-desktop.js）：
   *   function m() { flexcenter === "true" && (root.style.display="flex",
   *                   root.style.justifyContent="center", root.style.alignItems="center") }
   * 只有 Fit / Real 两种缩放的收尾（Te / Re）会调 m()；Full 不调。
   * 而它比的是**属性字符串** "true"，所以必须写属性，不能传布尔值。
   */
  el.setAttribute('flexcenter', 'true');
  hostRef.value.appendChild(el);
  element = el;

  el.addEventListener('ready', async (event: any) => {
    if (disposed) return;
    // 0.11.0 起 detail 是 { irgUserInteraction: {...} }，旧版本直接把交互对象放在 detail 上
    interaction = event?.detail?.irgUserInteraction ?? event?.detail;
    try {
      // 剪贴板必须在 connect() 之前打开：connect() 里才会根据这两个开关
      // 向 Rust 侧注册 remoteClipboardChanged / forceClipboardUpdate 回调。
      // setEnableAutoClipboard(true) = 内核自己轮询本机剪贴板做双向同步；
      // 浏览器不支持读剪贴板时内核会自动降级成手动模式并回调我们。
      interaction.setEnableClipboard?.(true);
      interaction.setEnableAutoClipboard?.(true);
      interaction.onClipboardRemoteUpdateCallback?.(onClipboardRemoteUpdate);
      attachFocusHooks();

      const config = interaction
        .configBuilder()
        .withUsername(sessionInfo!.username || '')
        .withPassword(sessionInfo!.password || '')
        .withServerDomain(sessionInfo!.domain || '')
        // destination 只是告诉代理"要连哪"，真正连哪以服务端票据为准
        .withDestination(`${sessionInfo!.host}:${sessionInfo!.port}`)
        .withProxyAddress(sessionInfo!.wsUrl)
        .withAuthToken(sessionInfo!.ticket)
        /* *
         * 故意**不**传 withDesktopSize。
         *
         * 传了的话画布会被设成我们要求的尺寸（比如 1600×924），可服务端不一定
         * 真能把桌面改成这个尺寸：
         *   - Windows 会照做，画面正好铺满；
         *   - 「共享一块已有 X 桌面」的服务端（实测 FreeRDP shadow）只会把帧缓冲
         *     调到 1600×924，屏幕内容仍旧是原来的 1280×800，并且画在左上角，
         *     右边和下边永远是黑的。
         * 而 IronRDP 的画布缓冲尺寸在 connect 之后就不再变（内核只在连接建立时
         * publish 一次 resizeObservable），所以画布一旦比真实桌面大就纠不回来。
         *
         * 不传 = 直接用服务端的真实桌面尺寸建会话，画布和帧缓冲天然一致，
         * 再靠 Fit 等比缩放到容器 + flexcenter 居中，任何服务端都不会出现
         * 「画面贴着左上角、右下大片黑」的观感。
         * 代价：桌面不会跟随窗口改分辨率，画面是等比缩放显示（可能轻微虚化），
         * 不再是像素 1:1。
         */
        .build();

      const info = await interaction.connect(config);
      if (disposed) return;
      // Web Component 内部的 .screen-wrapper 默认带 hidden（visibility:hidden + 移出屏幕），
      // 不调 setVisibility(true) 就永远是黑的 —— canvas 尺寸正常、数据也在流，只是不显示。
      try { interaction.setVisibility(true); } catch { /* 老版本没有该方法 */ }
      // Fit：画面按容器等比缩放，窗口拖动时不会出现滚动条。
      // 顺便触发一次居中重排（Fit 收尾里会读 flexcenter 并把根 div 设成 flex-center）。
      try { interaction.setScale(1); } catch { /* 老版本没有 setScale */ }
      emit('status', { status: 'connected' });

      // run() 一直挂到会话结束
      void info
        .run()
        .then((result: any) => {
          if (disposed) return;
          const reason = String(result?.reason?.() ?? '');
          emit('status', {
            status: 'disconnected',
            message: reason ? `${t('remoteDesktop.errors.sessionEnded')}: ${reason}` : t('remoteDesktop.errors.sessionEnded'),
          });
        })
        .catch((err: any) => {
          if (disposed) return;
          emit('status', { status: 'error', message: `${t('remoteDesktop.errors.sessionDropped')}: ${describeError(err)}` });
        });
    } catch (err: any) {
      if (disposed) return;
      emit('status', { status: 'error', message: describeError(err) });
    }
  });
}

let resizeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 容器尺寸变了：只重新算一次「等比适配」，**不**通知服务端改分辨率。
 *
 * interaction.resize() 干的是两件事：把画布 CSS 盒子强行改成指定像素（会拉伸画面）、
 * 再请求服务端把桌面改成这个尺寸。服务端不认账时前者就成了纯粹的变形，
 * 后者还会让画布和真实帧缓冲对不上（见 connect() 里不传 withDesktopSize 的说明）。
 * 我们要的语义只是「把服务端那张固定尺寸的画面塞进新容器」，所以走 setScale(Fit)。
 */
function resizeTo() {
  if (!interaction) return;
  try {
    interaction.setScale(1);
  } catch (err) {
    console.warn('[RdpView] 重新适配画面失败:', err);
  }
}

/** Ctrl+Alt+Del（RDP 会话里本地组合键会被系统截走，只能走通道） */
function sendCtrlAltDel() {
  try {
    interaction?.ctrlAltDel?.();
  } catch (err) {
    console.warn('[RdpView] 发送 Ctrl+Alt+Del 失败:', err);
  }
}

defineExpose({ reconnect: connect, sendCtrlAltDel, resizeTo, pushLocalClipboard, pullRemoteClipboard });

onMounted(() => {
  void nextTick().then(() => connect());
});

onBeforeUnmount(() => {
  disposed = true;
  if (resizeTimer) clearTimeout(resizeTimer);
  teardownElement();
});

// 工作区尺寸变了就重新适配一次画面（拖拽时每帧算一次没有意义，攒 150ms）。
watch(
  () => [props.width, props.height],
  () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => resizeTo(), 150);
  }
);
</script>

<template>
  <div ref="hostRef" class="w-full h-full bg-black overflow-hidden" @contextmenu.prevent></div>
</template>
