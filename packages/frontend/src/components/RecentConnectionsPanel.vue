<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useConnectionsStore } from '../stores/connections.store';
import type { ConnectionInfo } from '../stores/connections.store';
import { useSessionStore } from '../stores/session.store';
import { formatRelativeFromSeconds } from '../utils/relativeTime';

/**
 * 工作区空着（一个标签都没有）时给的「最近连接」列表。
 *
 * 以前这里是一块什么都不显示的空布局，想连机器得先去仪表盘/连接管理再回来，
 * 每次都多两步。这里直接把最近连过的几条列出来，点一下就开会话。
 *
 * 排序：先按 last_connected_at 倒序，从没连过的按 created_at 倒序垫在后面 ——
 * 新库（一次都没连过）也不至于是一片空白。
 */
const props = defineProps<{
  isMobile?: boolean;
}>();

const { t, locale } = useI18n();
const connectionsStore = useConnectionsStore();
const sessionStore = useSessionStore();
const { connections, isLoading } = storeToRefs(connectionsStore);

const MAX_ITEMS = props.isMobile ? 8 : 6;

const recentConnections = computed<ConnectionInfo[]>(() => {
  const sorted = [...connections.value].sort(
    (a, b) => (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0)
      || (b.created_at ?? 0) - (a.created_at ?? 0)
  );
  return sorted.slice(0, MAX_ITEMS);
});

const typeIcon = (type: ConnectionInfo['type']): string => {
  if (type === 'RDP') return 'fa-desktop';
  if (type === 'VNC') return 'fa-plug';
  return 'fa-server';
};

const lastUsedText = (conn: ConnectionInfo): string => formatRelativeFromSeconds(
  conn.last_connected_at,
  locale.value,
  t('workspace.recentConnections.neverConnected')
);

const connect = (conn: ConnectionInfo) => {
  sessionStore.handleConnectRequest(conn);
};

onMounted(() => {
  // 每次回到「空工作区」都刷一次：刚连过的那条 last_connected_at 变了，
  // 只靠 store 里的缓存会把顺序显示成旧的（而且直接从 /workspace 刷新进来时可能还没拉过）。
  void connectionsStore.fetchConnections();
});
</script>

<template>
  <!-- m-auto 居中：终端面板被拖得很矮时内容也不会被裁掉顶部（overflow-y-auto 仍可用）
       铺一层不透明底色：面板可能落在开了「终端背景图」的面板上，透明的话文字会糊在图里 -->
  <div class="recent-connections h-full w-full overflow-y-auto flex bg-background px-4 py-5">
    <div class="m-auto w-full" :class="props.isMobile ? 'max-w-full' : 'max-w-[560px]'">
      <div class="mb-4 text-center">
        <div class="rc-icon mb-2.5 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <i class="fas fa-bolt"></i>
        </div>
        <h2 class="text-sm font-semibold text-foreground">{{ t('workspace.recentConnections.title') }}</h2>
      </div>

      <div v-if="isLoading && recentConnections.length === 0" class="py-6 text-center text-xs text-text-secondary">
        <i class="fas fa-spinner fa-spin text-primary mr-1.5"></i>{{ t('common.loading') }}
      </div>

      <div
        v-else-if="recentConnections.length === 0"
        class="rounded-xl border border-border/60 bg-card px-4 py-8 text-center"
      >
        <p class="text-xs text-text-secondary">{{ t('workspace.recentConnections.empty') }}</p>
        <router-link
          to="/connections"
          class="mt-3 inline-block text-xs text-primary hover:underline"
        >
          {{ t('workspace.recentConnections.emptyAction') }}
        </router-link>
      </div>

      <ul v-else class="m-0 list-none space-y-1.5 p-0">
        <li v-for="conn in recentConnections" :key="conn.id">
          <button
            type="button"
            class="group flex w-full items-center gap-3 rounded-xl border border-border/60 bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5 cursor-pointer"
            :title="`${conn.name || conn.host} — ${conn.username ? conn.username + '@' : ''}${conn.host}:${conn.port}`"
            @click="connect(conn)"
          >
            <span class="rc-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <i :class="['fas', typeIcon(conn.type), 'text-xs']"></i>
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-foreground">
                {{ conn.name || conn.host || t('connections.unnamedFallback') }}
              </span>
              <span class="mt-0.5 block truncate font-mono text-[11px] text-text-secondary">
                {{ conn.username ? conn.username + '@' : '' }}{{ conn.host }}:{{ conn.port }}
              </span>
            </span>
            <span class="shrink-0 text-[11px] text-text-secondary/80">{{ lastUsedText(conn) }}</span>
            <i class="rc-chevron fas fa-chevron-right text-[10px] text-text-secondary opacity-0 transition-opacity group-hover:opacity-100"></i>
          </button>
        </li>
      </ul>

      <div class="mt-4 text-center">
        <router-link to="/connections" class="text-[11px] text-text-secondary hover:text-primary">
          {{ t('workspace.recentConnections.viewAll') }}
        </router-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 全局 `i, .fas { color: var(--icon-color) }` 没有进 @layer，会盖掉继承来的 text-primary */
.rc-icon i {
  color: inherit;
}
</style>
