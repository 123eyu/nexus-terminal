<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import TerminalTabBar from '../components/TerminalTabBar.vue';
import LayoutRenderer from '../components/LayoutRenderer.vue';
// 远程桌面（RDP/VNC）客户端体积很大（noVNC + iron-remote-desktop），而且只在真有
// rdp/vnc 会话时才用得上。静态 import 会把它塞进工作区的 chunk 里：手机上光是进终端
// 就要多下几百 KB，更糟的是这块代码一旦在新 WebView 上解析/求值失败，整个工作区
// 连渲染都进不去（0.9.11 起「点终端没反应/黑屏」就是这么来的）。改成按需加载。
const RemoteSessionPane = defineAsyncComponent(() => import('../components/remote/RemoteSessionPane.vue'));
import { useSessionStore } from '../stores/session.store';
import { useLayoutStore } from '../stores/layout.store';
import { storeToRefs } from 'pinia';
import type { LayoutNode } from '../stores/layout.store';
import type { FileTab } from '../stores/fileEditor.store';
import type { SessionTabInfoWithStatus } from '../stores/session/types';
import type { ConnectionInfo } from '../stores/connections.store';

const props = defineProps<{
  sessions: SessionTabInfoWithStatus[];
  activeSessionId: string | null;
  layoutTree: LayoutNode | null;
  layoutLocked: boolean;
  editorTabs: FileTab[];
  activeEditorTabId: string | null;
}>();

const emit = defineEmits<{
  (e: 'open-layout-configurator'): void;
  (e: 'request-add-connection'): void;
  (e: 'request-edit-connection', connection: ConnectionInfo): void;
}>();

const { t } = useI18n();
const sessionStore = useSessionStore();
const layoutStore = useLayoutStore();
const { isHeaderVisible } = storeToRefs(layoutStore);

const handleCloseOtherSessions = (targetSessionId: string) => {
  const sessionsToClose = props.sessions
    .filter(tab => tab.sessionId !== targetSessionId)
    .map(tab => tab.sessionId);
  sessionsToClose.forEach(id => sessionStore.closeSession(id));
};

const handleCloseSessionsToRight = (targetSessionId: string) => {
  const targetIndex = props.sessions.findIndex(tab => tab.sessionId === targetSessionId);
  if (targetIndex === -1) return;
  const sessionsToClose = props.sessions
    .slice(targetIndex + 1)
    .map(tab => tab.sessionId);
  sessionsToClose.forEach(id => sessionStore.closeSession(id));
};

const handleCloseSessionsToLeft = (targetSessionId: string) => {
  const targetIndex = props.sessions.findIndex(tab => tab.sessionId === targetSessionId);
  if (targetIndex === -1) return;
  const sessionsToClose = props.sessions
    .slice(0, targetIndex)
    .map(tab => tab.sessionId);
  sessionsToClose.forEach(id => sessionStore.closeSession(id));
};

const handleRequestEditConnectionFromPopup = (conn: ConnectionInfo) => {
  emit('request-edit-connection', conn);
};

/**
 * 会话沙箱的分批挂载。
 *
 * 每个会话的沙箱（LayoutRenderer + xterm + 文件管理器 + 分屏）都是常驻的，为的是
 * 切会话 0ms —— 但**首次**把它们全部挂出来会变成一整段主线程长任务：实测 9 个会话
 * 恢复时首帧要 500ms+（dev 下被切成几十个 50ms 小任务、累计 5s），表现为"刷新后卡住，
 * 然后所有内容一起冒出来"。
 *
 * 所以：首帧只挂「当前活动会话」，其余会话在第一帧画完之后分批补挂（每个间隔 30ms，
 * 不堆成新的长任务）。补完之后依旧全部常驻，切会话照旧 0ms。
 */
const renderedSessionIds = ref<Set<string>>(new Set());
const mountedSessions = computed(() => props.sessions.filter(s => renderedSessionIds.value.has(s.sessionId)));

const markSessionRendered = (sessionId: string) => {
  if (renderedSessionIds.value.has(sessionId)) return;
  const next = new Set(renderedSessionIds.value);
  next.add(sessionId);
  renderedSessionIds.value = next;
};

/** 待补挂队列 + 唯一一个定时器：重复排程不会堆出多条链 */
const pendingMountQueue: string[] = [];
let mountTimer: number | null = null;

const pumpMountQueue = () => {
  mountTimer = null;
  const id = pendingMountQueue.shift();
  if (!id) return;
  markSessionRendered(id);
  if (pendingMountQueue.length > 0) mountTimer = window.setTimeout(pumpMountQueue, 30);
};

const scheduleSessionMounts = () => {
  // 被切到的会话必须立刻有，否则切换后是空白
  if (props.activeSessionId) markSessionRendered(props.activeSessionId);
  for (const s of props.sessions) {
    if (!renderedSessionIds.value.has(s.sessionId) && !pendingMountQueue.includes(s.sessionId)) {
      pendingMountQueue.push(s.sessionId);
    }
  }
  // 等第一帧真正绘制出去再开始补挂
  if (pendingMountQueue.length > 0 && mountTimer === null) {
    mountTimer = window.setTimeout(pumpMountQueue, 80);
  }
};

onMounted(() => scheduleSessionMounts());
onBeforeUnmount(() => {
  if (mountTimer !== null) window.clearTimeout(mountTimer);
  mountTimer = null;
  pendingMountQueue.length = 0;
});

watch(() => props.sessions.map(s => s.sessionId).join(','), () => scheduleSessionMounts());
watch(() => props.activeSessionId, (id) => { if (id) markSessionRendered(id); });

// 监听会话列表变化，关闭的会话及时从 layoutStore 缓存中释放
watch(() => props.sessions, (newSessions, oldSessions) => {
  if (!oldSessions) return;
  const currentIds = new Set(newSessions.map(s => s.sessionId));
  for (const old of oldSessions) {
    if (!currentIds.has(old.sessionId)) {
      layoutStore.clearSessionLayoutTree(old.sessionId);
    }
  }
}, { deep: false });

// 根据会话 ID 获取其绑定的专属稳定布局树 (实现零卡顿毫秒级秒切)
const getSessionLayoutTree = (sessionId: string): LayoutNode => {
  const session = sessionStore.sessions.get(sessionId);
  return layoutStore.getLayoutTreeForSession(sessionId, session?.connectionId);
};

/** RDP / VNC 会话不参与分屏布局：整块工作区就是它的画面 */
const isRemoteSession = (sessionId: string | null): boolean => {
  if (!sessionId) return false;
  const kind = sessionStore.sessions.get(sessionId)?.kind;
  return kind === 'rdp' || kind === 'vnc';
};

/**
 * 聚焦校正跟着"当前可见的会话树"走。
 *
 * 会话树的 pane ID 与主布局树不是同一套（getLayoutTreeForSession 会克隆并重编 ID），
 * 若 activeTerminalPaneId 仍停在旧会话的 paneId 上，命令输入栏 / 快捷指令
 * 会走 ssh:pane_input 发到不存在的分屏通道，后端静默丢弃 —— 表现为"新会话里命令发不出去，
 * 手动点一下终端才恢复"。这里在会话切换（以及会话树被刷新）时重新校准。
 */
watch(
  () => (props.activeSessionId && !isRemoteSession(props.activeSessionId)
    ? getSessionLayoutTree(props.activeSessionId)
    : null),
  (tree) => {
    const sid = props.activeSessionId;
    if (!sid || isRemoteSession(sid)) return;
    const connId = sessionStore.sessions.get(sid)?.connectionId;
    layoutStore.syncActiveTerminalPaneFromTree(tree, sid, connId ?? null);
  },
  { immediate: true }
);
</script>

<template>
  <div class="desktop-workspace-view flex flex-col flex-grow overflow-hidden" :class="{ 'header-hidden': !isHeaderVisible }">
    <TerminalTabBar
      :sessions="props.sessions"
      :active-session-id="props.activeSessionId"
      :is-mobile="false"
      @activate-session="sessionStore.activateSession"
      @close-session="sessionStore.closeSession"
      @open-layout-configurator="emit('open-layout-configurator')"
      @request-add-connection-from-popup="emit('request-add-connection')"
      @request-edit-connection-from-popup="handleRequestEditConnectionFromPopup"
      @close-other-sessions="handleCloseOtherSessions"
      @close-sessions-to-right="handleCloseSessionsToRight"
      @close-sessions-to-left="handleCloseSessionsToLeft"
    />
    <div class="main-content-area" :class="{ 'full-bleed': !isHeaderVisible }">
      <!-- 多会话独立布局沙箱：每个会话根据其绑定的预设独立常驻，切换会话使用纯 CSS v-show 实现 0 毫秒秒切！ -->
      <template v-if="props.sessions.length > 0">
        <div
          v-for="sessionTab in mountedSessions"
          :key="`session-layout-box-${sessionTab.sessionId}`"
          v-show="sessionTab.sessionId === props.activeSessionId"
          class="layout-renderer-wrapper w-full h-full flex flex-col overflow-hidden"
        >
          <!-- 远程桌面：专用布局（占满工作区，不可编辑、不可分屏） -->
          <RemoteSessionPane
            v-if="sessionTab.kind === 'rdp' || sessionTab.kind === 'vnc'"
            :session-id="sessionTab.sessionId"
            :active="sessionTab.sessionId === props.activeSessionId"
            class="w-full h-full"
          />
          <LayoutRenderer
            v-else
            :is-root-renderer="true"
            :layout-node="getSessionLayoutTree(sessionTab.sessionId)"
            :active-session-id="sessionTab.sessionId"
            :layout-locked="props.layoutLocked"
            class="flex-grow w-full h-full"
            :editor-tabs="props.editorTabs"
            :active-editor-tab-id="props.activeEditorTabId"
          />
        </div>
      </template>
      <!-- 无打开会话时的默认空闲布局：终端面板里会显示「最近连接」（见 LayoutRenderer） -->
      <div v-else class="layout-renderer-wrapper w-full h-full flex flex-col overflow-hidden">
        <LayoutRenderer
          v-if="props.layoutTree"
          :is-root-renderer="true"
          :layout-node="props.layoutTree"
          :active-session-id="null"
          :layout-locked="props.layoutLocked"
          class="flex-grow w-full h-full"
          :editor-tabs="props.editorTabs"
          :active-editor-tab-id="props.activeEditorTabId"
        />
        <div v-else class="pane-placeholder">
          {{ t('layout.loading', '加载布局中...') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.desktop-workspace-view {
  width: 100%;
  height: 100%;
}

.main-content-area {
  display: flex;
  flex: 1;
  overflow: hidden;
  border: 1px solid var(--border-color, #ccc);
  border-top: none;
  border-radius: 0 0 5px 5px;
  margin: var(--base-margin, 0.5rem);
  margin-top: 0;
  transition: margin 0.15s ease, border-radius 0.15s ease;
}

.main-content-area.full-bleed {
  margin: 0;
  border: none;
  border-radius: 0;
}

.layout-renderer-wrapper {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.pane-placeholder {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  width: 100%;
  font-size: 1.2rem;
  color: var(--text-color-secondary, #888);
}
</style>
