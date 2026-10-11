<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppearanceStore } from '../../stores/appearance.store';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';
import { storeToRefs } from 'pinia';

const { t } = useI18n();
const appearanceStore = useAppearanceStore();
const notificationsStore = useUiNotificationsStore();
const {
  appearanceSettings,
  currentEditorFontSize,
  currentEditorFontFamily,
} = storeToRefs(appearanceStore);

const editableEditorFontSize = ref(14);
const editableEditorFontFamily = ref('');

const EDITOR_QUICK_FONTS = [
  'Consolas',
  'Fira Code',
  'JetBrains Mono',
  'Cascadia Code',
  'Source Code Pro',
  'monospace'
];

const initializeEditableState = () => {
  editableEditorFontSize.value = currentEditorFontSize.value || 14;
  editableEditorFontFamily.value = currentEditorFontFamily.value || 'Consolas, monospace';
};

onMounted(initializeEditableState);

watch(
  () => appearanceSettings.value,
  (newSettings, oldSettings) => {
    const fontSizeChanged = newSettings?.editorFontSize !== oldSettings?.editorFontSize;
    const fontFamilyChanged = newSettings?.editorFontFamily !== oldSettings?.editorFontFamily;

    if (fontSizeChanged) {
      editableEditorFontSize.value = newSettings?.editorFontSize || 14;
    }
    if (fontFamilyChanged) {
      editableEditorFontFamily.value = newSettings?.editorFontFamily || 'Consolas, monospace';
    }
  },
  { deep: true }
);

const handleSaveEditorFontSize = async () => {
  try {
    const size = Number(editableEditorFontSize.value);
    if (isNaN(size) || size <= 0) {
      notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.errorInvalidEditorFontSize', '字号数值无效') });
      return;
    }
    await appearanceStore.setEditorFontSize(size);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.editorFontSizeSaved', '编辑器字号已保存') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: error.message });
  }
};

const handleSaveEditorFontFamily = async () => {
  try {
    await appearanceStore.setEditorFontFamily(editableEditorFontFamily.value);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.editorFontFamilySaved', '编辑器字体已保存') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: error.message });
  }
};

const handleSelectFontPill = async (font: string) => {
  editableEditorFontFamily.value = font;
  await handleSaveEditorFontFamily();
};
</script>

<template>
  <div class="space-y-6">
    <!-- 代码编辑器字体与字号卡片 -->
    <div class="bg-card/40 border border-border/70 rounded-xl p-4 shadow-sm space-y-4">
      <div class="flex items-center justify-between">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <i class="fas fa-file-code text-primary text-xs"></i>
          内置代码编辑器
        </h4>
        <div class="flex items-center gap-1.5 bg-background/60 border border-border/60 px-2 py-0.5 rounded-lg text-xs">
          <span class="text-muted-foreground text-[11px]">字号:</span>
          <input
            type="number"
            v-model.number="editableEditorFontSize"
            @change="handleSaveEditorFontSize"
            @keydown.enter.prevent="handleSaveEditorFontSize"
            min="10"
            max="36"
            class="w-11 bg-transparent text-foreground text-center font-mono font-medium focus:outline-none"
          />
          <span class="text-muted-foreground text-[10px]">px</span>
        </div>
      </div>

      <!-- 字体家族输入与保存 -->
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <input
            type="text"
            v-model="editableEditorFontFamily"
            @keydown.enter.prevent="handleSaveEditorFontFamily"
            @blur="handleSaveEditorFontFamily"
            placeholder="例如：'Fira Code', Consolas, monospace"
            class="flex-1 px-3 py-2 text-xs border border-border/70 rounded-lg bg-background text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            @click="handleSaveEditorFontFamily"
            class="px-3.5 py-2 text-xs font-medium text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors shadow-sm shrink-0"
          >
            保存
          </button>
        </div>

        <!-- 常用程序员字体快捷标签 -->
        <div class="flex items-center gap-1.5 flex-wrap pt-1">
          <button
            v-for="font in EDITOR_QUICK_FONTS"
            :key="font"
            type="button"
            @click="handleSelectFontPill(font)"
            class="px-2.5 py-1 text-xs rounded-md border transition-all font-mono"
            :class="editableEditorFontFamily.toLowerCase().includes(font.toLowerCase())
              ? 'bg-primary text-primary-foreground border-primary font-semibold shadow-sm'
              : 'bg-background/60 text-muted-foreground border-border/60 hover:text-foreground hover:bg-background'"
          >
            {{ font }}
          </button>
        </div>
      </div>

      <!-- 实时预览条 -->
      <div
        class="p-3.5 rounded-lg border border-border/60 bg-background/80 space-y-1.5"
        :style="{ fontFamily: editableEditorFontFamily || 'monospace', fontSize: `${editableEditorFontSize}px` }"
      >
        <div class="flex items-center justify-between text-[11px] text-muted-foreground border-b border-border/40 pb-1 font-sans">
          <span class="font-medium text-foreground">预览效果</span>
          <span class="font-mono text-[10px] text-muted-foreground">
            {{ editableEditorFontFamily || 'monospace' }} ({{ editableEditorFontSize }}px)
          </span>
        </div>
        <div class="font-mono leading-relaxed overflow-x-auto text-foreground select-all py-1">
          <span class="text-primary font-semibold">async function</span> <span class="text-blue-400">connectServer</span>(host: <span class="text-emerald-400">string</span>) {<br />
          &nbsp;&nbsp;<span class="text-purple-400">const</span> status = <span class="text-primary">await</span> client.ping({ timeout: <span class="text-amber-400">3000</span> });<br />
          &nbsp;&nbsp;<span class="text-purple-400">return</span> status.ok;<br />
          }
        </div>
      </div>
    </div>
  </div>
</template>