<template>
  <div v-if="settings" class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
    <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">{{ $t('settings.category.system') }}</h2>
    <div class="p-6 space-y-6">
      <!-- Language -->
      <div class="settings-section-content">
         <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.language.title') }}</h3>
         <form @submit.prevent="handleUpdateLanguage" class="space-y-4">
           <div>
             <label for="languageSelect" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.language.selectLabel') }}</label>
             <select id="languageSelect" v-model="selectedLanguage"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8"
                     style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.75rem center; background-size: 16px 12px;">
               <option v-for="locale in availableLocales" :key="locale" :value="locale">
                 {{ languageNames[locale] || locale }} <!-- Display mapped name or locale code -->
               </option>
             </select>
           </div>
           <div class="flex items-center justify-between">
              <button type="submit"
                      class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                {{ $t('settings.language.saveButton') }}
              </button>
              <p v-if="languageMessage" :class="['text-sm', languageSuccess ? 'text-success' : 'text-error']">{{ languageMessage }}</p>
           </div>
         </form>
      </div>
      <hr class="border-border/50"> <!-- Separator -->
      <!-- Timezone Setting -->
      <div class="settings-section-content">
         <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.timezone.title') }}</h3>
         <form @submit.prevent="handleUpdateTimezone" class="space-y-4">
           <div>
             <label for="timezoneSelect" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.timezone.selectLabel') }}</label>
             <select id="timezoneSelect" v-model="selectedTimezone"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8"
                     style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.75rem center; background-size: 16px 12px;">
               <option v-for="tz in commonTimezones" :key="tz" :value="tz">
                 {{ tz }}
               </option>
             </select>
              <small class="block mt-1 text-xs text-text-secondary">{{ $t('settings.timezone.description') }}</small>
           </div>
           <div class="flex items-center justify-between">
              <button type="submit"
                      class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                {{ $t('common.save') }}
              </button>
              <p v-if="timezoneMessage" :class="['text-sm', timezoneSuccess ? 'text-success' : 'text-error']">{{ timezoneMessage }}</p>
           </div>
         </form>
      </div>

      <!-- Desktop Specific Setting: Window Close Behavior (仅在桌面客户端下展示) -->
      <div v-if="isDesktop" class="settings-section-content">
        <hr class="border-border/50 mb-6">
        <h3 class="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
          <i class="fas fa-desktop text-primary"></i>
          {{ $t('settings.desktop.title', '桌面客户端设置') }}
        </h3>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-text-secondary mb-2">
              {{ $t('settings.desktop.closeBehaviorLabel', '关闭主窗口时') }}
            </label>
            <div class="space-y-2">
              <label class="flex items-center space-x-3 cursor-pointer select-none">
                <input
                  type="radio"
                  name="closeBehavior"
                  value="minimize_to_tray"
                  v-model="closeBehavior"
                  @change="handleUpdateCloseBehavior"
                  class="text-primary focus:ring-primary h-4 w-4 cursor-pointer"
                />
                <span class="text-sm text-foreground">
                  {{ $t('settings.desktop.minimizeToTray', '最小化到系统托盘') }}
                </span>
              </label>
              <label class="flex items-center space-x-3 cursor-pointer select-none">
                <input
                  type="radio"
                  name="closeBehavior"
                  value="quit"
                  v-model="closeBehavior"
                  @change="handleUpdateCloseBehavior"
                  class="text-primary focus:ring-primary h-4 w-4 cursor-pointer"
                />
                <span class="text-sm text-foreground">
                  {{ $t('settings.desktop.quitApp', '退出 Nexus Terminal') }}
                </span>
              </label>
            </div>
            
            <!-- 记住选择开关 (极简纯净) -->
            <div class="mt-3 pt-3 border-t border-border/50">
              <label class="flex items-center space-x-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  v-model="rememberCloseChoice"
                  @change="handleUpdateCloseBehavior"
                  class="rounded border-border text-primary focus:ring-primary h-4 w-4 cursor-pointer"
                />
                <span class="text-sm text-foreground">
                  {{ $t('settings.desktop.rememberChoice', '记住我的选择') }}
                </span>
              </label>
            </div>
          </div>
          <p v-if="desktopMessage" :class="['text-sm', desktopSuccess ? 'text-success' : 'text-error']">
            {{ desktopMessage }}
          </p>
        </div>

        <!-- Desktop Specific Setting: VPS Cloud Data Sync (云端数据双向同步) -->
        <hr class="border-border/50 my-6">
        <h3 class="text-base font-semibold text-foreground mb-2 flex items-center justify-between">
          <span class="flex items-center gap-2">
            <i class="fas fa-cloud text-primary"></i>
            {{ $t('settings.desktop.cloudSyncTitle', '云端数据同步 (VPS 同步)') }}
          </span>
          <span v-if="desktopSyncStore.lastSyncTime > 0" class="text-xs font-normal text-text-secondary">
            {{ $t('settings.desktop.lastSynced', '上次同步') }}: {{ formatSyncTime(desktopSyncStore.lastSyncTime) }}
          </span>
        </h3>
        <p class="text-xs text-text-secondary mb-4">
          {{ $t('settings.desktop.cloudSyncDesc', '将桌面端的主机资产、跳板机、密钥库、快捷指令以及当前工作区与远程 VPS 服务端进行双向同步。') }}
        </p>

        <form @submit.prevent="handleSaveSyncConfig" class="space-y-4">
          <!-- VPS 地址输入 -->
          <div>
            <label class="block text-sm font-medium text-text-secondary mb-1">
              {{ $t('settings.desktop.vpsUrlLabel', 'VPS 服务器地址 (域名或 IP+端口)') }}
              <span class="text-error">*</span>
            </label>
            <input
              type="text"
              v-model="syncVpsUrl"
              placeholder="例如 https://nexus.example.com 或 http://192.168.1.100:3000"
              class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm"
            />
          </div>

          <!-- API Key 输入 -->
          <div>
            <label class="block text-sm font-medium text-text-secondary mb-1">
              {{ $t('settings.desktop.syncApiKeyLabel', '同步 API Key (双方必须一致)') }}
              <span class="text-error">*</span>
            </label>
            <div class="relative">
              <input
                :type="showApiKey ? 'text' : 'password'"
                v-model="syncApiKey"
                placeholder="输入在 VPS 服务端环境变量 SYNC_API_KEY 中设置的密钥"
                class="w-full px-3 py-2 pr-10 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm font-mono"
              />
              <button
                type="button"
                @click="showApiKey = !showApiKey"
                class="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary hover:text-foreground text-sm"
              >
                <i :class="showApiKey ? 'fas fa-eye-slash' : 'fas fa-eye'"></i>
              </button>
            </div>
            <small class="block mt-1 text-xs text-text-secondary">
              {{ $t('settings.desktop.syncCryptoTip', '数据传输采用基于 API Key 派生密钥的 AES-256-GCM 独立信封加解密，两端数据安全无损转换。') }}
            </small>
          </div>

          <!-- 冲突解决机制说明 -->
          <div class="p-3 bg-header/40 border border-border/60 rounded-md text-xs text-text-secondary flex items-start gap-2">
            <i class="fas fa-info-circle text-primary mt-0.5"></i>
            <div>
              <span class="font-medium text-foreground">{{ $t('settings.desktop.conflictPolicyTitle', '冲突解决策略: 最新修改时间优先 (LWW)') }}</span>
              <p class="mt-0.5">{{ $t('settings.desktop.conflictPolicyDesc', '双端基于实体 UUID 增量对齐，时间戳最新者自动生效；被删除的主机将通过墓碑记录同步清理，防止逆向复活。') }}</p>
            </div>
          </div>

          <!-- 状态提示 -->
          <div v-if="desktopSyncStore.testLatency !== null" class="text-xs text-success flex items-center gap-1.5">
            <i class="fas fa-check-circle"></i>
            {{ $t('settings.desktop.testSuccess', '连通正常，网络往返延迟') }}: {{ desktopSyncStore.testLatency }}ms
          </div>
          <div v-if="desktopSyncStore.testError" class="text-xs text-error flex items-center gap-1.5">
            <i class="fas fa-exclamation-triangle"></i>
            {{ desktopSyncStore.testError }}
          </div>
          <div v-if="desktopSyncStore.syncSuccessMessage" class="text-xs text-success flex items-center gap-1.5">
            <i class="fas fa-check-circle"></i>
            {{ desktopSyncStore.syncSuccessMessage }}
          </div>
          <div v-if="desktopSyncStore.syncError" class="text-xs text-error flex items-center gap-1.5">
            <i class="fas fa-exclamation-triangle"></i>
            {{ desktopSyncStore.syncError }}
          </div>

          <!-- 操作按钮组 -->
          <div class="flex items-center gap-3 pt-1">
            <!-- 测试连接 -->
            <button
              type="button"
              @click="handleTestSyncConnection"
              :disabled="!syncVpsUrl.trim() || !syncApiKey.trim() || desktopSyncStore.isTesting"
              class="px-3 py-1.5 border border-border bg-header text-foreground rounded-md shadow-sm hover:bg-border disabled:opacity-50 disabled:cursor-not-allowed transition text-xs font-medium flex items-center gap-1.5"
            >
              <i v-if="desktopSyncStore.isTesting" class="fas fa-spinner fa-spin"></i>
              <i v-else class="fas fa-plug"></i>
              {{ desktopSyncStore.isTesting ? $t('settings.desktop.testing', '测试中...') : $t('settings.desktop.testConnection', '测试连接') }}
            </button>

            <!-- 保存配置 -->
            <button
              type="submit"
              :disabled="isSavingSync"
              class="px-3 py-1.5 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover disabled:opacity-50 transition text-xs font-medium flex items-center gap-1.5"
            >
              <i v-if="isSavingSync" class="fas fa-spinner fa-spin"></i>
              <i v-else class="fas fa-save"></i>
              {{ $t('common.save', '保存设置') }}
            </button>

            <!-- 立即同步 (仅在配置有效时可点击，否则禁用置灰) -->
            <button
              type="button"
              @click="handleTriggerSyncNow"
              :disabled="!isSyncButtonEnabled || desktopSyncStore.isSyncing"
              :title="isSyncButtonEnabled ? $t('settings.desktop.syncNowTooltip', '立即与 VPS 进行双向增量同步') : $t('settings.desktop.syncDisabledTooltip', '请先配置 VPS 域名和 API Key 并保存')"
              class="px-3 py-1.5 rounded-md shadow-sm transition text-xs font-medium flex items-center gap-1.5 ml-auto"
              :class="isSyncButtonEnabled ? 'bg-primary text-white hover:bg-primary/90 cursor-pointer' : 'bg-border/60 text-text-secondary cursor-not-allowed opacity-60'"
            >
              <i :class="desktopSyncStore.isSyncing ? 'fas fa-sync fa-spin' : 'fas fa-sync-alt'"></i>
              {{ desktopSyncStore.isSyncing ? $t('settings.desktop.syncing', '正在同步...') : $t('settings.desktop.syncNow', '立即同步') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useSettingsStore } from '../../stores/settings.store';
import { useDesktopSyncStore } from '../../stores/desktopSync.store';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSystemSettings } from '../../composables/settings/useSystemSettings';
import { isDesktopApp } from '../../utils/platform';
import axios from 'axios';

const settingsStore = useSettingsStore();
const desktopSyncStore = useDesktopSyncStore();
const { settings } = storeToRefs(settingsStore); 
const { t } = useI18n();

const {
  selectedLanguage,
  languageMessage,
  languageSuccess,
  languageNames,
  availableLocales,
  handleUpdateLanguage,
  selectedTimezone,
  timezoneMessage,
  timezoneSuccess,
  commonTimezones,
  handleUpdateTimezone,
} = useSystemSettings();

// --- 桌面客户端专属设置逻辑 ---
const isDesktop = ref(isDesktopApp());
const closeBehavior = ref<'minimize_to_tray' | 'quit'>('minimize_to_tray');
const rememberCloseChoice = ref(false);
const desktopMessage = ref('');
const desktopSuccess = ref(true);

// --- 云端同步表单状态 ---
const syncVpsUrl = ref('');
const syncApiKey = ref('');
const showApiKey = ref(false);
const isSavingSync = ref(false);

/**
 * 云端同步按钮是否允许点击 (只有配置了域名和 apikey 才可以点击，否则禁用置灰)
 */
const isSyncButtonEnabled = computed(() => {
  return syncVpsUrl.value.trim().length > 0 && syncApiKey.value.trim().length > 0;
});

const formatSyncTime = (timestamp: number) => {
  if (!timestamp) return '从未';
  // 如果是秒级时间戳转换为毫秒级
  const date = new Date(timestamp > 1e11 ? timestamp : timestamp * 1000);
  return date.toLocaleString();
};

onMounted(async () => {
  if (isDesktop.value) {
    // 优先从本地缓存快速回显关闭行为
    const cached = localStorage.getItem('nexus_close_behavior');
    if (cached === 'quit' || cached === 'minimize_to_tray') {
      closeBehavior.value = cached;
    }
    const cachedRemember = localStorage.getItem('nexus_remember_close_choice');
    if (cachedRemember !== null) {
      rememberCloseChoice.value = cachedRemember === 'true';
    }

    // 读取桌面端设置与同步配置
    try {
      const res = await axios.get('/api/v1/desktop/settings');
      if (res.data) {
        if (res.data.closeBehavior) {
          closeBehavior.value = res.data.closeBehavior;
          localStorage.setItem('nexus_close_behavior', res.data.closeBehavior);
        }
        if (typeof res.data.rememberCloseChoice === 'boolean') {
          rememberCloseChoice.value = res.data.rememberCloseChoice;
          localStorage.setItem('nexus_remember_close_choice', String(res.data.rememberCloseChoice));
        }
      }
    } catch (err) {
      console.warn('[DesktopSettings] 获取桌面端配置失败:', err);
    }

    // 加载同步配置
    try {
      await desktopSyncStore.fetchConfig();
      syncVpsUrl.value = desktopSyncStore.vpsUrl;
      syncApiKey.value = desktopSyncStore.apiKey;
    } catch (err) {
      console.warn('[DesktopSettings] 获取云端同步配置失败:', err);
    }
  }
});

const handleSaveSyncConfig = async () => {
  isSavingSync.value = true;
  desktopSyncStore.syncError = null;
  desktopSyncStore.syncSuccessMessage = null;
  try {
    await desktopSyncStore.saveConfig({
      vpsUrl: syncVpsUrl.value,
      apiKey: syncApiKey.value,
    });
    desktopSyncStore.syncSuccessMessage = t('common.saved', '配置已保存');
    setTimeout(() => {
      if (desktopSyncStore.syncSuccessMessage === t('common.saved', '配置已保存')) {
        desktopSyncStore.syncSuccessMessage = null;
      }
    }, 2500);
  } catch (err: any) {
    desktopSyncStore.syncError = err.message || t('common.saveFailed', '保存失败');
  } finally {
    isSavingSync.value = false;
  }
};

const handleTestSyncConnection = async () => {
  desktopSyncStore.syncError = null;
  desktopSyncStore.syncSuccessMessage = null;
  await desktopSyncStore.testConnection(syncVpsUrl.value, syncApiKey.value);
};

const handleTriggerSyncNow = async () => {
  if (!isSyncButtonEnabled.value) return;
  // 先自动保存一次最新配置
  await handleSaveSyncConfig();
  await desktopSyncStore.triggerSync();
};

const handleUpdateCloseBehavior = async () => {
  desktopMessage.value = '';
  try {
    localStorage.setItem('nexus_close_behavior', closeBehavior.value);
    localStorage.setItem('nexus_remember_close_choice', String(rememberCloseChoice.value));

    // 双通道同步 1: 请求后端接口更新便携配置文件 data/desktop-settings.json
    await axios.put('/api/v1/desktop/settings', {
      closeBehavior: closeBehavior.value,
      rememberCloseChoice: rememberCloseChoice.value,
    });

    // 双通道同步 2: 如果存在 Tauri IPC，同步调用 Tauri 命令
    try {
      const tauri = (window as any).__TAURI__;
      if (tauri?.core?.invoke) {
        await tauri.core.invoke('set_desktop_settings', {
          closeBehavior: closeBehavior.value,
          rememberCloseChoice: rememberCloseChoice.value,
        });
      }
    } catch {}

    desktopSuccess.value = true;
    desktopMessage.value = t('common.saved', '已保存');
    setTimeout(() => {
      desktopMessage.value = '';
    }, 2500);
  } catch (err: any) {
    desktopSuccess.value = false;
    desktopMessage.value = err.response?.data?.error || t('common.saveFailed', '保存失败');
  }
};
</script>

