<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
// 包只导出 "." → ./core/rfb.js，所以不能写 '@novnc/novnc/core/rfb.js'
import RFB from '@novnc/novnc';
import { requestRemoteSession, type RemoteSessionInfo } from './useRemoteSession';
import type { ConnectionInfo } from '../../stores/connections.store';

/**
 * VNC 画面（noVNC）。
 *
 * 后端只做 WebSocket → TCP 的字节桥（/ws/remote/vnc），VNC 协议完全由浏览器里的
 * noVNC 说，所以和 RDP 一样不需要 guacd / Docker，桌面端与 Web 端共用同一份代码。
 *
 * 剪贴板：noVNC 只会「发」不会「收」——
 *   - 远端 → 本机：服务端发 ServerCutText / 扩展剪贴板消息时 noVNC 派发 `clipboard` 事件，
 *     我们把它写进系统剪贴板（页面不在前台时排队，聚焦后补写）。
 *   - 本机 → 远端：clipboardPasteFrom(text) 是唯一入口，必须由用户手势触发
 *     （Ctrl+V 粘贴事件，或界面上的"发送到远端"按钮），否则浏览器不给读剪贴板。
 *   剪贴板这条路依赖远端的剪贴板管理器，精简桌面常常没有 —— 所以另有一条
 *   sendText()：把文本逐字符当 KeyEvent 敲进去（见下方"模拟键盘输入"）。
 */
const props = defineProps<{
  connection: ConnectionInfo;
}>();

const emit = defineEmits<{
  (e: 'status', payload: { status: 'connecting' | 'connected' | 'error' | 'disconnected'; message?: string }): void;
  (e: 'clipboard', payload: { direction: 'up' | 'down'; ok: boolean; message?: string }): void;
}>();

const { t } = useI18n();

/**
 * noVNC 抛出的不一定都是 Error（securityfailure 里是普通对象），
 * 统一降级成可读文案，别在界面上显示 [object Object]。
 */
function describeError(err: any): string {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
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
let rfb: any = null;
let sessionInfo: RemoteSessionInfo | null = null;
let disposed = false;
/** 用户主动断开：noVNC 自己也会抛 disconnect 事件，据它决定提示文案 */
let manualClose = false;

/* ------------------------------------------------------------------ *
 * 剪贴板
 * ------------------------------------------------------------------ */

/** 远端最近一次给出的文本，用于去重（服务端经常重复发同一条） */
let lastRemoteClipboard = '';
/** 页面不在前台时收到的远端剪贴板，聚焦后补写 */
let pendingRemoteClipboard: string | null = null;

async function writeLocalClipboard(text: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error(t('remoteDesktop.clipboard.unsupported'));
    await navigator.clipboard.writeText(text);
    emit('clipboard', { direction: 'down', ok: true });
  } catch (err: any) {
    emit('clipboard', {
      direction: 'down',
      ok: false,
      message: t('remoteDesktop.clipboard.receiveFailed', { error: describeError(err) }),
    });
  }
}

function onRemoteClipboard(ev: any) {
  if (disposed) return;
  const text = ev?.detail?.text;
  if (typeof text !== 'string' || text.length === 0 || text === lastRemoteClipboard) return;
  lastRemoteClipboard = text;
  if (document.hasFocus()) {
    void writeLocalClipboard(text);
  } else {
    pendingRemoteClipboard = text;
  }
}

function flushPendingRemoteClipboard() {
  if (pendingRemoteClipboard === null || !document.hasFocus()) return;
  const text = pendingRemoteClipboard;
  pendingRemoteClipboard = null;
  void writeLocalClipboard(text);
}

/**
 * 把一段文本（不给就用系统剪贴板）推到远端。
 * clipboardPasteFrom 内部会在服务端支持扩展剪贴板时走 Notify，否则退回 ClientCutText。
 */
async function pushLocalClipboard(text?: string): Promise<boolean> {
  if (!rfb) return false;
  try {
    let payload = typeof text === 'string' ? text : '';
    if (!payload) {
      if (!navigator.clipboard?.readText) throw new Error(t('remoteDesktop.clipboard.unsupported'));
      payload = await navigator.clipboard.readText();
    }
    if (!payload) throw new Error(t('remoteDesktop.clipboard.empty'));
    rfb.clipboardPasteFrom(payload);
    // 自己刚发出去的内容，服务端回传时不要再写一次本机剪贴板
    lastRemoteClipboard = payload;
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

/** VNC 没有"主动向服务端索取剪贴板"的协议动作，只能报告最近一次收到的是什么 */
async function pullRemoteClipboard(): Promise<boolean> {
  if (pendingRemoteClipboard !== null) {
    flushPendingRemoteClipboard();
    return true;
  }
  if (!lastRemoteClipboard) {
    emit('clipboard', { direction: 'down', ok: false, message: t('remoteDesktop.clipboard.nothingReceived') });
    return false;
  }
  await writeLocalClipboard(lastRemoteClipboard);
  return true;
}

/**
 * Ctrl+V：浏览器把剪贴板内容放在 paste 事件里，这属于用户手势，
 * 既不触发剪贴板权限也不需要额外确认。不 preventDefault 的话文本会被插进页面。
 */
function onPaste(ev: ClipboardEvent) {
  const text = ev.clipboardData?.getData('text/plain');
  if (!text) return;
  ev.preventDefault();
  void pushLocalClipboard(text);
}

/* ------------------------------------------------------------------ *
 * 模拟键盘输入（"发送文字"）
 * ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 单个字符 → X11 keysym。
 *
 * RFB 的 KeyEvent 只认 keysym：服务端拿到 keysym 后自己去查键盘映射，
 * 该不该按 Shift 由服务端决定，所以我们不用（也没法）模拟修饰键状态。
 *   - Latin-1（< 0x100）的 keysym 数值就等于码点，'a'=0x61、'!'=0x21；
 *   - 其余字符按 X11 约定用 0x01000000 + 码点（Unicode keysym），
 *     现代服务端（x11vnc / TigerVNC / Xvfb 系）都支持，CJK 也能打进去。
 * 换行/制表等控制字符没有对应码点，单独映射。
 */
function charToKeysym(ch: string): number {
  switch (ch) {
    case '\n': return 0xff0d; // Return
    case '\r': return 0xff0d;
    case '\t': return 0xff09; // Tab
    case '\b': return 0xff08; // BackSpace
    case '\x1b': return 0xff1b; // Escape
    default: break;
  }
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x100) return cp;
  return 0x01000000 + cp;
}

/**
 * 把一段文本当成「一个个按键」敲进远端。
 *
 * 和剪贴板那条路（clipboardPasteFrom）是互补的：剪贴板依赖远端的剪贴板管理器，
 * 精简桌面 / 没有 xclip 的机器、密码框、以及"必须真的敲进去"的场景都不灵；
 * 这条路径只看键盘事件，任何 VNC 服务端都吃。
 *
 * 每个字符发「按下 + 抬起」，中间隔 ~6ms：一把梭全发出去时 x11vnc 一类服务端
 * 会丢键（尤其是紧跟 PointerEvent 的时候）。
 */
async function sendText(text: string): Promise<{ ok: boolean; count: number; message?: string }> {
  const input = String(text ?? '').replace(/\r\n?/g, '\n');
  // 按 code point 切，别把 emoji / 代理对拆成两半
  const chars = Array.from(input);
  if (chars.length === 0) return { ok: false, count: 0, message: t('remoteDesktop.typeText.empty') };
  if (!rfb) return { ok: false, count: 0, message: t('remoteDesktop.typeText.notConnected') };

  let sent = 0;
  try {
    for (const ch of chars) {
      const keysym = charToKeysym(ch);
      rfb.sendKey(keysym, null, true);
      rfb.sendKey(keysym, null, false);
      sent += 1;
      await sleep(6);
    }
    return { ok: true, count: sent };
  } catch (err: any) {
    return {
      ok: false,
      count: sent,
      message: t('remoteDesktop.typeText.failed', { error: describeError(err) }),
    };
  }
}

async function connect() {
  if (!hostRef.value || disposed) return;
  emit('status', { status: 'connecting', message: t('remoteDesktop.status.fetchingToken') });

  try {
    sessionInfo = await requestRemoteSession(Number(props.connection.id), 'vnc');
  } catch (err: any) {
    const detail = err?.response?.data?.message || describeError(err);
    emit('status', { status: 'error', message: `${t('remoteDesktop.errors.sessionRequest')}: ${detail}` });
    return;
  }

  if (disposed || !hostRef.value) return;
  teardown();

  try {
    rfb = new RFB(hostRef.value, sessionInfo.wsUrl, {
      shared: true,
      credentials: { password: sessionInfo.password || '' },
      wsProtocols: ['binary'],
    });

    // 画面等比适配容器（不裁剪、不强制远端正分辨率，避免老服务端不支持 SetDesktopSize 时黑屏）
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.clipViewport = false;
    rfb.viewOnly = false;
    rfb.focusOnClick = true;
    rfb.background = '#000';

    rfb.addEventListener('connect', () => {
      if (disposed) return;
      emit('status', { status: 'connected' });
      try { rfb.focus(); } catch { /* noop */ }
    });

    // 远端剪贴板 → 本机
    rfb.addEventListener('clipboard', onRemoteClipboard);

    rfb.addEventListener('disconnect', (ev: any) => {
      if (disposed) return;
      if (manualClose) {
        manualClose = false;
        emit('status', { status: 'disconnected' });
        return;
      }
      const clean = ev?.detail?.clean;
      emit('status', {
        status: clean ? 'disconnected' : 'error',
        message: clean ? t('remoteDesktop.errors.sessionEnded') : t('remoteDesktop.errors.sessionDropped'),
      });
    });

    rfb.addEventListener('credentialsrequired', () => {
      // 密码已在 credentials 里给过还要求，说明密码错了
      if (disposed) return;
      emit('status', { status: 'error', message: t('remoteDesktop.errors.vncAuth') });
      teardown();
    });

    rfb.addEventListener('securityfailure', (ev: any) => {
      if (disposed) return;
      const reason = ev?.detail?.reason || 'unknown';
      emit('status', { status: 'error', message: t('remoteDesktop.errors.vncSecurity', { reason }) });
    });

    hostRef.value.addEventListener('paste', onPaste);
    window.addEventListener('focus', flushPendingRemoteClipboard);
  } catch (err: any) {
    if (disposed) return;
    emit('status', { status: 'error', message: describeError(err) });
  }
}

function teardown() {
  window.removeEventListener('focus', flushPendingRemoteClipboard);
  if (hostRef.value) {
    hostRef.value.removeEventListener('paste', onPaste);
  }
  if (rfb) {
    try { rfb.disconnect(); } catch { /* noop */ }
    rfb = null;
  }
  if (hostRef.value) {
    while (hostRef.value.firstChild) hostRef.value.removeChild(hostRef.value.firstChild);
  }
  lastRemoteClipboard = '';
  pendingRemoteClipboard = null;
}

function sendCtrlAltDel() {
  try {
    rfb?.sendCtrlAltDel();
  } catch (err) {
    console.warn('[VncView] 发送 Ctrl+Alt+Del 失败:', err);
  }
}

/**
 * 尺寸变化：noVNC 内部挂了 ResizeObserver，会自己按 scaleViewport 重算，
 * 这里留个空实现只是为了两个 View 的对外接口一致（面板调用处不用分支）。
 */
function resizeTo() { /* noVNC 自行处理 */ }

/** 主动断开：关掉 RFB 通道并清空容器，reconnect() 会重新建连 */
function disconnect() {
  manualClose = true;
  teardown();
  emit('status', { status: 'disconnected' });
}

defineExpose({ reconnect: connect, disconnect, sendCtrlAltDel, resizeTo, pushLocalClipboard, pullRemoteClipboard, sendText });

onMounted(() => {
  void nextTick().then(() => connect());
});

onBeforeUnmount(() => {
  disposed = true;
  teardown();
});
</script>

<template>
  <div ref="hostRef" class="w-full h-full bg-black overflow-hidden" tabindex="0"></div>
</template>
