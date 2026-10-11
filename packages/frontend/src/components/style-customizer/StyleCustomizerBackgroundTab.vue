<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppearanceStore } from '../../stores/appearance.store';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';
import { storeToRefs } from 'pinia';
import { useConfirmDialog } from '../../composables/useConfirmDialog';

const { t } = useI18n();
const { showConfirmDialog } = useConfirmDialog();
const appearanceStore = useAppearanceStore();
const notificationsStore = useUiNotificationsStore();

const {
  terminalBackgroundImage,
  isTerminalBackgroundEnabled,
  currentTerminalBackgroundOverlayOpacity,
  localHtmlPresets,
  remoteHtmlPresets,
  remoteHtmlPresetsRepositoryUrl,
  activeHtmlPresetTab,
  htmlPresetError,
} = storeToRefs(appearanceStore);

const {
  fetchLocalHtmlPresets,
  getLocalHtmlPresetContent,
  createLocalHtmlPreset,
  updateLocalHtmlPreset,
  deleteLocalHtmlPreset,
  fetchRemoteHtmlPresetsRepositoryUrl,
  updateRemoteHtmlPresetsRepositoryUrl,
  fetchRemoteHtmlPresets,
  getRemoteHtmlPresetContent,
  applyHtmlPreset,
} = appearanceStore;

const localTerminalBackgroundEnabled = ref(true);
const editableTerminalBackgroundOverlayOpacity = ref(0.5);

const terminalBgFileInput = ref<HTMLInputElement | null>(null);
const uploadError = ref<string | null>(null);

const currentActiveTab = ref<'local' | 'remote'>('local');

// 预设编辑表单状态
const showPresetEditor = ref(false);
const editingPreset = ref<{ name: string, content: string } | null>(null);
const newPresetName = ref('');
const newPresetContent = ref('');

const localRemoteHtmlPresetsRepositoryUrl = ref('');
const localHtmlSearchTerm = ref('');
const remoteHtmlSearchTerm = ref('');

const localSpecificLoading = ref(false);
const remoteSpecificLoading = ref(false);

const initializeEditableState = () => {
  localTerminalBackgroundEnabled.value = isTerminalBackgroundEnabled.value;
  editableTerminalBackgroundOverlayOpacity.value = currentTerminalBackgroundOverlayOpacity.value;
  uploadError.value = null;
  currentActiveTab.value = activeHtmlPresetTab.value;
  localRemoteHtmlPresetsRepositoryUrl.value = remoteHtmlPresetsRepositoryUrl.value || 'https://github.com/Heavrnl/nexus-terminal/tree/main/doc/custom_html_theme';
};

onMounted(async () => {
  initializeEditableState();
  localSpecificLoading.value = true;
  try {
    await fetchLocalHtmlPresets();
  } finally {
    localSpecificLoading.value = false;
  }

  if (!remoteHtmlPresetsRepositoryUrl.value) {
    await fetchRemoteHtmlPresetsRepositoryUrl();
  }
  if (remoteHtmlPresetsRepositoryUrl.value) {
    remoteSpecificLoading.value = true;
    try {
      await fetchRemoteHtmlPresets();
    } finally {
      remoteSpecificLoading.value = false;
    }
  }
});

watch(isTerminalBackgroundEnabled, (newValue) => {
  if (localTerminalBackgroundEnabled.value !== newValue) {
    localTerminalBackgroundEnabled.value = newValue;
  }
});

watch(currentTerminalBackgroundOverlayOpacity, (newValue) => {
  if (editableTerminalBackgroundOverlayOpacity.value !== newValue) {
    editableTerminalBackgroundOverlayOpacity.value = newValue;
  }
});

watch(activeHtmlPresetTab, (newTab) => {
  currentActiveTab.value = newTab;
});

watch(remoteHtmlPresetsRepositoryUrl, (newUrl) => {
  localRemoteHtmlPresetsRepositoryUrl.value = newUrl || '';
});

const handleTriggerTerminalBgUpload = () => {
  uploadError.value = null;
  terminalBgFileInput.value?.click();
};

const handleTerminalBgUpload = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  if (input.files && input.files[0]) {
    const file = input.files[0];
    try {
      await appearanceStore.uploadTerminalBackground(file);
      notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.terminalBgUploadSuccess', '背景图片上传成功') });
      input.value = '';
    } catch (error: any) {
      const msg = error.message || t('styleCustomizer.uploadFailed', '上传失败');
      uploadError.value = msg;
      notificationsStore.addNotification({ type: 'error', message: msg });
      input.value = '';
    }
  }
};

const handleRemoveTerminalBg = async () => {
  try {
    await appearanceStore.removeTerminalBackground();
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.terminalBgRemoved', '已移除背景图片') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.removeBgFailed', { message: error.message }) });
  }
};

const handleToggleTerminalBackground = async () => {
  const newValue = !localTerminalBackgroundEnabled.value;
  localTerminalBackgroundEnabled.value = newValue;
  try {
    await appearanceStore.setTerminalBackgroundEnabled(newValue);
  } catch (error: any) {
    localTerminalBackgroundEnabled.value = !newValue;
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.errorToggleTerminalBg', { message: error.message }) });
  }
};

const handleSaveTerminalBackgroundOverlayOpacity = async () => {
  try {
    const opacity = Number(editableTerminalBackgroundOverlayOpacity.value);
    if (isNaN(opacity) || opacity < 0 || opacity > 1) {
      notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.errorInvalidOpacityValue', '透明度数值无效') });
      return;
    }
    await appearanceStore.setTerminalBackgroundOverlayOpacity(opacity);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.terminalBgOverlayOpacitySaved', '蒙版透明度已保存') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.terminalBgOverlayOpacitySaveFailed', { message: error.message }) });
  }
};

const switchTab = (tab: 'local' | 'remote') => {
  appearanceStore.activeHtmlPresetTab = tab;
};

const handleApplyPreset = async (htmlContent: string) => {
  try {
    await applyHtmlPreset(htmlContent);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.htmlPresetApplied', '已应用主题') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.htmlPresetApplyFailed', { message: error.message }) });
  }
};

const handleResetCustomHtml = async () => {
  try {
    await applyHtmlPreset('');
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.customHtmlResetSuccess', '自定义 HTML 主题已清除') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.customHtmlResetFailed', { message: error.message }) });
  }
};

const openNewPresetEditor = () => {
  editingPreset.value = null;
  newPresetName.value = '';
  newPresetContent.value = '';
  showPresetEditor.value = true;
};

const openEditPresetEditor = (preset: { name: string, content: string }) => {
  editingPreset.value = { ...preset };
  newPresetName.value = preset.name.replace(/\.html$/, '');
  newPresetContent.value = preset.content;
  showPresetEditor.value = true;
};

const handleEditPresetAsNew = async (preset: { name: string, type: 'preset' | 'custom' }) => {
  try {
    const content = await getLocalHtmlPresetContent(preset.name);
    editingPreset.value = null;
    newPresetName.value = `${preset.name.replace(/\.html$/, '')}_副本`;
    newPresetContent.value = content;
    showPresetEditor.value = true;
  } catch (e: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.errorFetchingPresetContentForCopy', { message: e.message, name: preset.name }) });
  }
};

const handleSaveLocalPreset = async () => {
  const desiredBaseName = newPresetName.value.trim();
  const content = newPresetContent.value.trim();

  if (!desiredBaseName) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.errorPresetNameRequired', '预设名称不能为空') });
    return;
  }
  const fileName = desiredBaseName.endsWith('.html') ? desiredBaseName : `${desiredBaseName}.html`;

  try {
    if (editingPreset.value) {
      await updateLocalHtmlPreset(editingPreset.value.name, content);
      notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.presetUpdatedSuccess', '预设已更新') });
    } else {
      await createLocalHtmlPreset(fileName, content);
      notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.presetCreatedSuccess', '预设创建成功') });
    }
    showPresetEditor.value = false;
    await fetchLocalHtmlPresets();
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: error.message || t('styleCustomizer.presetSaveFailed', '保存失败') });
  }
};

const handleDeleteLocalPreset = async (presetName: string) => {
  const confirmed = await showConfirmDialog({
    title: t('styleCustomizer.confirmDeletePresetTitle', '确认删除预设'),
    message: t('styleCustomizer.confirmDeletePresetMessage', { name: presetName.replace(/\.html$/, '') }),
    confirmText: t('common.delete', '删除')
  });

  if (confirmed) {
    try {
      await deleteLocalHtmlPreset(presetName);
      notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.presetDeletedSuccess', '预设已删除') });
      await fetchLocalHtmlPresets();
    } catch (error: any) {
      notificationsStore.addNotification({ type: 'error', message: error.message });
    }
  }
};

const handleSaveRemoteRepositoryUrl = async () => {
  const trimmedUrl = localRemoteHtmlPresetsRepositoryUrl.value.trim();
  try {
    await updateRemoteHtmlPresetsRepositoryUrl(trimmedUrl);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.remoteUrlSaved', '远程仓库地址已保存') });
    if (trimmedUrl) {
      await handleLoadRemotePresets();
    }
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: error.message });
  }
};

const handleLoadRemotePresets = async () => {
  remoteSpecificLoading.value = true;
  try {
    await fetchRemoteHtmlPresets();
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.remotePresetsLoaded', '远程主题列表已刷新') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.remotePresetsLoadFailed', { message: error.message }) });
  } finally {
    remoteSpecificLoading.value = false;
  }
};

const applyLocalPreset = async (presetName: string) => {
  try {
    const content = await getLocalHtmlPresetContent(presetName);
    await handleApplyPreset(content);
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.localPresetApplyFailed', { message: error.message }) });
  }
};

const applyRemotePreset = async (downloadUrl?: string) => {
  if (!downloadUrl) return;
  try {
    const content = await getRemoteHtmlPresetContent(downloadUrl);
    await handleApplyPreset(content);
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.remotePresetApplyFailed', { message: error.message }) });
  }
};

const filteredLocalHtmlPresets = computed(() => {
  const searchTerm = localHtmlSearchTerm.value.toLowerCase().trim();
  let presets = [...localHtmlPresets.value];
  if (searchTerm) {
    presets = presets.filter(preset => preset.name.replace(/\.html$/, '').toLowerCase().includes(searchTerm));
  }
  presets.sort((a, b) => a.name.replace(/\.html$/, '').localeCompare(b.name.replace(/\.html$/, '')));
  return presets;
});

const filteredRemoteHtmlPresets = computed(() => {
  const searchTerm = remoteHtmlSearchTerm.value.toLowerCase().trim();
  let presets = [...remoteHtmlPresets.value];
  if (searchTerm) {
    presets = presets.filter(preset => preset.name.replace(/\.html$/, '').toLowerCase().includes(searchTerm));
  }
  presets.sort((a, b) => a.name.replace(/\.html$/, '').localeCompare(b.name.replace(/\.html$/, '')));
  return presets;
});
</script>

<template>
  <div class="space-y-6">
    <!-- 背景图片与蒙版卡片 -->
    <div class="bg-card/40 border border-border/70 rounded-xl p-4 shadow-sm space-y-4">
      <div class="flex items-center justify-between">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <i class="fas fa-image text-primary text-xs"></i>
          终端背景图片
        </h4>
        <button
          type="button"
          @click="handleToggleTerminalBackground"
          class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
          :class="localTerminalBackgroundEnabled ? 'bg-primary' : 'bg-muted-foreground/30'"
        >
          <span
            class="pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition duration-200 ease-in-out"
            :class="localTerminalBackgroundEnabled ? 'translate-x-4' : 'translate-x-0'"
          ></span>
        </button>
      </div>

      <div v-if="localTerminalBackgroundEnabled" class="space-y-4">
        <!-- 预览视窗 -->
        <div
          class="w-full h-36 rounded-xl border border-border/70 relative overflow-hidden bg-cover bg-center flex items-center justify-center transition-all group"
          :style="{ backgroundImage: terminalBackgroundImage ? `url(${terminalBackgroundImage})` : 'none', backgroundColor: 'var(--app-bg-color)' }"
        >
          <!-- 蒙版 -->
          <div
            v-if="terminalBackgroundImage"
            class="absolute inset-0 transition-opacity"
            :style="{ backgroundColor: `rgba(0, 0, 0, ${editableTerminalBackgroundOverlayOpacity})` }"
          ></div>

          <!-- 操作按钮悬浮或居中 -->
          <div class="relative z-10 flex items-center gap-2">
            <button
              type="button"
              @click="handleTriggerTerminalBgUpload"
              class="px-3 py-1.5 text-xs font-medium bg-background/80 hover:bg-background text-foreground backdrop-blur-md border border-border/80 rounded-lg shadow-sm transition-all flex items-center gap-1.5"
            >
              <i class="fas fa-cloud-upload-alt text-primary"></i>
              {{ terminalBackgroundImage ? '更换图片' : '上传背景图' }}
            </button>
            <button
              v-if="terminalBackgroundImage"
              type="button"
              @click="handleRemoveTerminalBg"
              class="px-3 py-1.5 text-xs font-medium bg-destructive/80 hover:bg-destructive text-destructive-foreground backdrop-blur-md rounded-lg shadow-sm transition-all flex items-center gap-1.5"
            >
              <i class="fas fa-trash-alt"></i>
              清除
            </button>
          </div>
          <input type="file" ref="terminalBgFileInput" @change="handleTerminalBgUpload" accept="image/*" class="hidden" />
        </div>

        <!-- 蒙版透明度平滑调节 -->
        <div class="p-3 rounded-lg bg-background/50 border border-border/40 space-y-2">
          <div class="flex items-center justify-between text-xs">
            <span class="text-foreground font-medium">暗色蒙版遮罩</span>
            <span class="font-mono text-primary font-semibold">
              {{ Math.round(editableTerminalBackgroundOverlayOpacity * 100) }}%
            </span>
          </div>
          <input
            type="range"
            v-model.number="editableTerminalBackgroundOverlayOpacity"
            @change="handleSaveTerminalBackgroundOverlayOpacity"
            min="0"
            max="1"
            step="0.01"
            class="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
          />
        </div>
      </div>
    </div>

    <!-- HTML 背景动态主题 (仅在开启背景功能时展示) -->
    <div v-if="localTerminalBackgroundEnabled" class="bg-card/40 border border-border/70 rounded-xl p-4 shadow-sm space-y-4">
      <div class="flex items-center justify-between">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <i class="fas fa-code text-primary text-xs"></i>
          HTML 动态背景主题
        </h4>
        <button
          type="button"
          @click="handleResetCustomHtml"
          class="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 px-2 py-0.5 rounded hover:bg-accent/40"
          title="清除应用的自定义 HTML"
        >
          <i class="fas fa-rotate-left text-[10px]"></i>
          清除主题
        </button>
      </div>

      <!-- 药丸 Tab 切换 -->
      <div class="flex p-0.5 rounded-lg bg-muted/60 border border-border/50 max-w-xs">
        <button
          type="button"
          @click="switchTab('local')"
          class="flex-1 py-1 text-xs font-medium rounded-md transition-all text-center"
          :class="currentActiveTab === 'local' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'"
        >
          本地主题
        </button>
        <button
          type="button"
          @click="switchTab('remote')"
          class="flex-1 py-1 text-xs font-medium rounded-md transition-all text-center"
          :class="currentActiveTab === 'remote' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'"
        >
          远程生态库
        </button>
      </div>

      <!-- 本地主题内容 -->
      <div v-if="currentActiveTab === 'local'" class="space-y-3">
        <div class="flex items-center justify-between gap-2">
          <div class="relative flex-1">
            <i class="fas fa-search absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs"></i>
            <input
              type="text"
              v-model="localHtmlSearchTerm"
              placeholder="搜索本地主题..."
              class="w-full pl-7 pr-2.5 py-1 text-xs border border-border/70 rounded-lg bg-background/70 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <button
            type="button"
            @click="openNewPresetEditor"
            class="px-2.5 py-1 text-xs font-medium text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-1 shrink-0 shadow-sm"
          >
            <i class="fas fa-plus text-[10px]"></i>
            新建主题
          </button>
        </div>

        <div v-if="localSpecificLoading" class="text-center py-6 text-xs text-muted-foreground">
          加载中...
        </div>
        <div v-else-if="filteredLocalHtmlPresets.length > 0" class="max-h-[220px] overflow-y-auto space-y-1.5 pr-1 border border-border/50 rounded-lg p-1.5 bg-background/50">
          <div
            v-for="preset in filteredLocalHtmlPresets"
            :key="preset.name"
            class="flex items-center justify-between px-3 py-2 rounded-lg bg-card/50 border border-border/50 hover:border-border transition-all text-xs"
          >
            <div class="flex items-center gap-2 min-w-0 pr-2">
              <span class="truncate text-foreground font-medium" :title="preset.name.replace(/\.html$/, '')">
                {{ preset.name.replace(/\.html$/, '') }}
              </span>
              <span
                class="text-[10px] px-1.5 py-0.2 rounded shrink-0 font-medium"
                :class="preset.type === 'preset' ? 'bg-blue-500/10 text-blue-500 border border-blue-500/30' : 'bg-green-500/10 text-green-500 border border-green-500/30'"
              >
                {{ preset.type === 'preset' ? '预设' : '自定义' }}
              </span>
            </div>

            <div class="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                @click="applyLocalPreset(preset.name)"
                class="px-2.5 py-1 rounded text-xs bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 transition-colors"
              >
                应用
              </button>
              <button
                v-if="preset.type === 'custom'"
                type="button"
                @click="async () => {
                  try {
                    const content = await getLocalHtmlPresetContent(preset.name);
                    openEditPresetEditor({ name: preset.name, content });
                  } catch (e: any) {
                    notificationsStore.addNotification({ type: 'error', message: e.message });
                  }
                }"
                class="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
                title="编辑"
              >
                <i class="fas fa-edit"></i>
              </button>
              <button
                v-if="preset.type === 'preset'"
                type="button"
                @click="handleEditPresetAsNew(preset)"
                class="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
                title="作为副本编辑"
              >
                <i class="fas fa-copy"></i>
              </button>
              <button
                v-if="preset.type === 'custom'"
                type="button"
                @click="handleDeleteLocalPreset(preset.name)"
                class="px-2 py-1 rounded text-xs text-destructive/70 hover:text-destructive hover:bg-destructive/10 transition-colors"
                title="删除"
              >
                <i class="fas fa-trash-alt"></i>
              </button>
            </div>
          </div>
        </div>
        <div v-else class="text-center py-6 text-xs text-muted-foreground italic border border-dashed border-border/50 rounded-lg">
          暂无可用本地主题
        </div>
      </div>

      <!-- 远程主题内容 -->
      <div v-if="currentActiveTab === 'remote'" class="space-y-3">
        <div class="flex items-center gap-2">
          <input
            type="text"
            v-model="localRemoteHtmlPresetsRepositoryUrl"
            class="flex-1 px-3 py-1.5 text-xs border border-border/70 rounded-lg bg-background text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="GitHub 仓库主题目录地址..."
          />
          <button
            type="button"
            @click="handleSaveRemoteRepositoryUrl"
            class="px-2.5 py-1.5 text-xs font-medium border border-border/70 rounded-lg bg-card hover:bg-accent/30 text-foreground transition-colors shrink-0"
          >
            保存地址
          </button>
          <button
            type="button"
            @click="handleLoadRemotePresets"
            :disabled="!remoteHtmlPresetsRepositoryUrl || remoteSpecificLoading"
            class="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors shrink-0 disabled:opacity-50"
          >
            {{ remoteSpecificLoading ? '刷新中...' : '刷新生态库' }}
          </button>
        </div>

        <div v-if="filteredRemoteHtmlPresets.length > 0" class="max-h-[220px] overflow-y-auto space-y-1.5 pr-1 border border-border/50 rounded-lg p-1.5 bg-background/50">
          <div
            v-for="preset in filteredRemoteHtmlPresets"
            :key="preset.name"
            class="flex items-center justify-between px-3 py-2 rounded-lg bg-card/50 border border-border/50 hover:border-border transition-all text-xs"
          >
            <span class="truncate text-foreground font-medium pr-2" :title="preset.name.replace(/\.html$/, '')">
              {{ preset.name.replace(/\.html$/, '') }}
            </span>
            <button
              type="button"
              @click="applyRemotePreset(preset.downloadUrl)"
              :disabled="!preset.downloadUrl"
              class="px-2.5 py-1 rounded text-xs bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 transition-colors shrink-0"
            >
              在线应用
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 弹窗：编辑/新建本地主题 -->
    <div v-if="showPresetEditor" class="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50" @click.self="showPresetEditor = false">
      <div class="bg-card border border-border/80 p-5 rounded-2xl shadow-2xl w-full max-w-lg space-y-4">
        <div class="flex items-center justify-between border-b border-border/60 pb-3">
          <h4 class="text-sm font-semibold text-foreground">
            {{ editingPreset ? '编辑主题' : '新建 HTML 动态主题' }}
          </h4>
          <button type="button" @click="showPresetEditor = false" class="text-muted-foreground hover:text-foreground">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="space-y-3">
          <div>
            <label for="presetName" class="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">主题标识名</label>
            <input
              type="text"
              id="presetName"
              v-model="newPresetName"
              placeholder="例如：cyber-matrix"
              class="w-full px-3 py-2 text-xs border border-border/70 rounded-lg bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label for="presetContent" class="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">HTML / CSS 源码</label>
            <textarea
              id="presetContent"
              v-model="newPresetContent"
              rows="12"
              placeholder="<div>...</div>&#10;<style>...</style>"
              spellcheck="false"
              class="w-full font-mono text-xs leading-relaxed border border-border/70 rounded-lg p-3 bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-primary"
            ></textarea>
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-2 border-t border-border/60">
          <button
            type="button"
            @click="showPresetEditor = false"
            class="px-4 py-1.5 text-xs border border-border/70 rounded-lg bg-card hover:bg-accent/30 text-foreground transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            @click="handleSaveLocalPreset"
            class="px-4 py-1.5 text-xs font-medium text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors shadow-sm"
          >
            保存主题
          </button>
        </div>
      </div>
    </div>
  </div>
</template>