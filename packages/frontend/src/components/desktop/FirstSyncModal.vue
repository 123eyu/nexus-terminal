<!-- packages/frontend/src/components/desktop/FirstSyncModal.vue -->
<template>
  <Teleport to="body">
    <div
      v-if="desktopSyncStore.showFirstSyncModal"
      class="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
      @keydown.esc="handleClose"
    >
      <div
        class="bg-background text-foreground border border-border/80 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden transform transition-all animate-scale-up"
        style="background-color: var(--app-bg-color);"
      >
        <!-- 弹窗头部：一体化无色差 -->
        <div class="px-6 py-4 border-b border-border/50 flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-sm">
              <i class="fas fa-sync-alt"></i>
            </div>
            <div>
              <h3 class="text-base font-semibold text-foreground">
                {{ $t('desktop.firstSync.title', '初次同步数据对齐向导') }}
              </h3>
              <p class="text-xs text-text-secondary mt-0.5">
                {{ $t('desktop.firstSync.subtitle', '检测到首次与 VPS 建立同步，请选择初次数据对齐策略') }}
              </p>
            </div>
          </div>
          <button
            @click="handleClose"
            class="text-text-secondary hover:text-foreground text-sm p-1.5 rounded-md hover:bg-muted/50 transition-colors"
          >
            <i class="fas fa-times"></i>
          </button>
        </div>

        <!-- 当前同步范围提示 -->
        <div class="px-6 py-2.5 bg-muted/15 border-b border-border/40 flex items-center justify-between text-xs">
          <span class="text-text-secondary font-medium">同步范围:</span>
          <div class="flex items-center gap-1.5 flex-wrap justify-end">
            <span
              v-for="item in activeModuleLabels"
              :key="item"
              class="px-2 py-0.5 rounded bg-primary/10 text-primary font-medium text-[11px]"
            >
              {{ item }}
            </span>          </div>
        </div>

        <!-- 账号安全隔离提示 -->
        <div class="mx-6 mt-4 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-start gap-2.5 text-xs text-text-secondary leading-relaxed">
          <i class="fas fa-shield-alt text-blue-500 mt-0.5 text-sm"></i>
          <div>
            <span class="font-medium text-foreground">凭证安全隔离说明：</span>
            数据同步仅涵盖主机资产、SSH 密钥、代理及外观配置，<span class="text-blue-500 font-medium">不包含系统登录账号与密码</span>。桌面端与云端 VPS 保持各自独立的本地管理员凭证。
          </div>
        </div>

        <!-- 弹窗内容：3个策略卡片 -->
        <div class="p-6 space-y-3.5">
          <!-- 选项 1: 智能双向合并 (推荐) -->
          <label
            class="block p-3.5 rounded-xl border transition-all cursor-pointer select-none"
            :class="selectedMode === 'bidirectional'
              ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
              : 'border-border/70 hover:border-border hover:bg-muted/30'"
          >
            <div class="flex items-start gap-3">
              <input
                type="radio"
                name="firstSyncMode"
                value="bidirectional"
                v-model="selectedMode"
                class="mt-1 text-primary focus:ring-primary h-4 w-4 cursor-pointer"
              />
              <div class="flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-semibold text-foreground">
                    {{ $t('desktop.firstSync.bidirectionalTitle', '智能双向合并 (推荐)') }}
                  </span>
                  <span class="px-1.5 py-0.5 text-[10px] font-medium rounded bg-emerald-500/10 text-emerald-500">
                    {{ $t('common.recommended', '推荐') }}
                  </span>
                </div>
                <p class="text-xs text-text-secondary mt-1 leading-relaxed">
                  {{ $t('desktop.firstSync.bidirectionalDesc', '同时保留本地与云端资产。两端缺失项自动互补，相同项按最新修改时间裁决 (LWW)，互不丢失。') }}
                </p>
              </div>
            </div>
          </label>

          <!-- 选项 2: 以云端为准覆盖本地 -->
          <label
            class="block p-3.5 rounded-xl border transition-all cursor-pointer select-none"
            :class="selectedMode === 'cloud_to_local'
              ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
              : 'border-border/70 hover:border-border hover:bg-muted/30'"
          >
            <div class="flex items-start gap-3">
              <input
                type="radio"
                name="firstSyncMode"
                value="cloud_to_local"
                v-model="selectedMode"
                class="mt-1 text-primary focus:ring-primary h-4 w-4 cursor-pointer"
              />
              <div class="flex-1">
                <span class="text-sm font-semibold text-foreground">
                  {{ $t('desktop.firstSync.cloudToLocalTitle', '以云端 VPS 为准 (覆盖本地)') }}
                </span>
                <p class="text-xs text-text-secondary mt-1 leading-relaxed">
                  {{ $t('desktop.firstSync.cloudToLocalDesc', '适合在新设备上首次安装使用。直接从 VPS 拉取全部主机与密钥，替换本地业务数据（本地桌面端的登录账号密码保持不变）。') }}
                </p>
              </div>
            </div>
          </label>

          <!-- 选项 3: 以本地为准覆盖云端 -->
          <label
            class="block p-3.5 rounded-xl border transition-all cursor-pointer select-none"
            :class="selectedMode === 'local_to_cloud'
              ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
              : 'border-border/70 hover:border-border hover:bg-muted/30'"
          >
            <div class="flex items-start gap-3">
              <input
                type="radio"
                name="firstSyncMode"
                value="local_to_cloud"
                v-model="selectedMode"
                class="mt-1 text-primary focus:ring-primary h-4 w-4 cursor-pointer"
              />
              <div class="flex-1">
                <span class="text-sm font-semibold text-foreground">
                  {{ $t('desktop.firstSync.localToCloudTitle', '以当前本地为准 (覆盖云端)') }}
                </span>
                <p class="text-xs text-text-secondary mt-1 leading-relaxed">
                  {{ $t('desktop.firstSync.localToCloudDesc', '适合 VPS 刚全新部署的场景。将当前客户端所有本地连接与密钥完整推送到 VPS，覆盖云端。') }}
                </p>
              </div>
            </div>
          </label>
        </div>

        <!-- 弹窗底部操作按钮：一体化无色差 -->
        <div class="px-6 py-4 border-t border-border/50 flex items-center justify-end gap-3">
          <button
            type="button"
            @click="handleClose"
            class="px-4 py-2 border border-border rounded-lg text-sm font-medium text-text-secondary hover:text-foreground hover:bg-border/40 transition"
          >
            {{ $t('common.cancel', '取消') }}
          </button>
          <button
            type="button"
            @click="handleConfirm"
            :disabled="desktopSyncStore.isSyncing"
            class="px-5 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition shadow-sm flex items-center gap-2"
          >
            <i class="fas fa-check text-xs"></i>
            {{ $t('desktop.firstSync.startSync', '确认并开始同步') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useDesktopSyncStore, SYNC_CATEGORIES, type SyncMode } from '../../stores/desktopSync.store';

const desktopSyncStore = useDesktopSyncStore();
const selectedMode = ref<SyncMode>(desktopSyncStore.syncMode || 'bidirectional');

watch(() => desktopSyncStore.showFirstSyncModal, (isOpen) => {
  if (isOpen) {
    selectedMode.value = desktopSyncStore.syncMode || 'bidirectional';
  }
});

const activeModuleLabels = computed(() => {
  // 按大类汇总，只勾了部分子项时显示「3/5」，避免弹一屏 19 个小标签
  return SYNC_CATEGORIES
    .map(cat => {
      const enabled = cat.items.filter(i => desktopSyncStore.selectedModules.includes(i.key));
      if (enabled.length === 0) return '';
      if (enabled.length === cat.items.length) return cat.label;
      return `${cat.label} ${enabled.length}/${cat.items.length}`;
    })
    .filter(Boolean);
});

const handleClose = () => {
  desktopSyncStore.showFirstSyncModal = false;
};

const handleConfirm = async () => {
  await desktopSyncStore.triggerSync(selectedMode.value);
};
</script>
