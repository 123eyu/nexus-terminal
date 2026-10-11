<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppearanceStore, safeJsonParse } from '../../stores/appearance.store';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';
import { storeToRefs } from 'pinia';
import { defaultUiTheme } from '../../features/appearance/config/default-themes';

const { t } = useI18n();
const appearanceStore = useAppearanceStore();
const notificationsStore = useUiNotificationsStore();
const { appearanceSettings } = storeToRefs(appearanceStore);

const editableUiTheme = ref<Record<string, string>>({});
const editableUiThemeString = ref('');
const themeParseError = ref<string | null>(null);
const showAdvancedEditor = ref(false);

// 预设主题定义
interface ThemePreset {
  id: string;
  name: string;
  accent: string;
  bg: string;
  border: string;
  theme: Record<string, string>;
}

const themePresets: ThemePreset[] = [
  {
    id: 'default',
    name: '默认主题',
    accent: '#8E44AD',
    bg: '#ffffff',
    border: '#cccccc',
    theme: { ...defaultUiTheme }
  },
  {
    id: 'dark',
    name: '暗黑模式',
    accent: '#A06CD5',
    bg: '#212529',
    border: '#495057',
    theme: {
      ...defaultUiTheme,
      '--app-bg-color': '#212529',
      '--header-bg-color': '#343a40',
      '--footer-bg-color': '#343a40',
      '--card-bg-color': '#282c34',
      '--surface-bg-color': '#282c34',
      '--border-color': '#495057',
      '--split-line-color': '#495057',
      '--split-line-hover-color': '#5a6268',
      '--text-color': '#e9ecef',
      '--text-color-secondary': '#adb5bd',
      '--link-color': '#BB86FC',
      '--link-hover-color': '#D1A9FF',
      '--link-active-color': '#A06CD5',
      '--link-active-bg-color': 'rgba(160, 108, 213, 0.2)',
      '--button-bg-color': '#A06CD5',
      '--button-text-color': '#ffffff',
      '--button-hover-bg-color': '#8E44AD',
      '--icon-color': '#adb5bd',
      '--icon-hover-color': '#D1A9FF',
      '--input-focus-border-color': '#A06CD5',
      '--input-focus-glow': '#A06CD5',
      '--overlay-bg-color': 'rgba(0, 0, 0, 0.8)',
      '--color-success': '#5cb85c',
      '--color-error': '#d9534f',
      '--color-warning': '#f0ad4e'
    }
  },
  {
    id: 'nord-slate',
    name: '极地深蓝',
    accent: '#38bdf8',
    bg: '#0f172a',
    border: '#334155',
    theme: {
      ...defaultUiTheme,
      '--app-bg-color': '#0f172a',
      '--header-bg-color': '#1e293b',
      '--footer-bg-color': '#1e293b',
      '--card-bg-color': '#1e293b',
      '--surface-bg-color': '#1e293b',
      '--border-color': '#334155',
      '--split-line-color': '#334155',
      '--split-line-hover-color': '#475569',
      '--text-color': '#f8fafc',
      '--text-color-secondary': '#94a3b8',
      '--link-color': '#38bdf8',
      '--link-hover-color': '#7dd3fc',
      '--link-active-color': '#0284c7',
      '--link-active-bg-color': 'rgba(56, 189, 248, 0.16)',
      '--button-bg-color': '#0284c7',
      '--button-text-color': '#ffffff',
      '--button-hover-bg-color': '#0369a1',
      '--icon-color': '#94a3b8',
      '--icon-hover-color': '#7dd3fc',
      '--input-focus-border-color': '#38bdf8',
      '--input-focus-glow': '#38bdf8',
      '--overlay-bg-color': 'rgba(15, 23, 42, 0.8)'
    }
  }
];

// 语义分类映射
interface VariableMeta {
  key: string;
  label: string;
  group: 'accent' | 'surface' | 'typography' | 'other';
}

const variableMetadataList: VariableMeta[] = [
  // 强调与交互
  { key: '--link-color', label: '主要强调色', group: 'accent' },
  { key: '--link-hover-color', label: '悬停强调色', group: 'accent' },
  { key: '--link-active-color', label: '激活强调色', group: 'accent' },
  { key: '--link-active-bg-color', label: '激活浅底色', group: 'accent' },
  { key: '--button-bg-color', label: '主按钮底色', group: 'accent' },
  { key: '--button-text-color', label: '按钮文字色', group: 'accent' },
  { key: '--button-hover-bg-color', label: '按钮悬停色', group: 'accent' },
  { key: '--input-focus-border-color', label: '聚焦高亮色', group: 'accent' },

  // 界面与边框
  { key: '--app-bg-color', label: '应用背景', group: 'surface' },
  { key: '--header-bg-color', label: '顶栏背景', group: 'surface' },
  { key: '--footer-bg-color', label: '底栏背景', group: 'surface' },
  { key: '--border-color', label: '基础边框色', group: 'surface' },
  { key: '--split-line-color', label: '分割线颜色', group: 'surface' },
  { key: '--overlay-bg-color', label: '遮罩蒙版色', group: 'surface' },

  // 文字与反馈
  { key: '--text-color', label: '主要文本', group: 'typography' },
  { key: '--text-color-secondary', label: '次要文本', group: 'typography' },
  { key: '--icon-color', label: '通用图标', group: 'typography' },
  { key: '--icon-hover-color', label: '图标悬停', group: 'typography' },
  { key: '--color-success', label: '成功指示', group: 'typography' },
  { key: '--color-error', label: '错误提示', group: 'typography' },
  { key: '--color-warning', label: '警告提示', group: 'typography' }
];

const accentVars = computed(() => variableMetadataList.filter(v => v.group === 'accent' && v.key in editableUiTheme.value));
const surfaceVars = computed(() => variableMetadataList.filter(v => v.group === 'surface' && v.key in editableUiTheme.value));
const typographyVars = computed(() => variableMetadataList.filter(v => v.group === 'typography' && v.key in editableUiTheme.value));

const otherVars = computed(() => {
  const knownKeys = new Set(variableMetadataList.map(v => v.key));
  return Object.keys(editableUiTheme.value).filter(k => !knownKeys.has(k));
});

const isColorValue = (value: string | undefined): boolean => {
  if (!value) return false;
  const v = value.trim();
  return v.startsWith('#') || v.startsWith('rgb') || v.startsWith('hsl');
};

const initializeEditableState = () => {
  const userThemeJson = appearanceSettings.value.customUiTheme;
  const userTheme = safeJsonParse(userThemeJson, {});
  const mergedTheme = { ...defaultUiTheme, ...userTheme };
  editableUiTheme.value = JSON.parse(JSON.stringify(mergedTheme));
  themeParseError.value = null;
  syncStringToEditor();
};

const syncStringToEditor = () => {
  try {
    const themeObject = editableUiTheme.value;
    if (themeObject && typeof themeObject === 'object' && Object.keys(themeObject).length > 0) {
      const lines = Object.entries(themeObject).map(([key, value]) => `${key}: ${value}`);
      editableUiThemeString.value = lines.join('\n');
    } else {
      editableUiThemeString.value = '';
    }
  } catch (e) {
    editableUiThemeString.value = '';
  }
};

onMounted(initializeEditableState);

watch(() => appearanceSettings.value.customUiTheme, () => {
  initializeEditableState();
}, { deep: true });

const applyPreset = async (preset: ThemePreset) => {
  editableUiTheme.value = JSON.parse(JSON.stringify(preset.theme));
  syncStringToEditor();
  await handleSaveUiTheme();
};

const handleSaveUiTheme = async () => {
  try {
    await appearanceStore.saveCustomUiTheme(editableUiTheme.value);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.uiThemeSaved', '已保存界面主题配置') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.uiThemeSaveFailed', { message: error.message }) });
  }
};

const handleResetUiTheme = async () => {
  try {
    await appearanceStore.resetCustomUiTheme();
    initializeEditableState();
    notificationsStore.addNotification({ type: 'info', message: t('styleCustomizer.uiThemeReset', '已恢复默认主题') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.uiThemeResetFailed', { message: error.message }) });
  }
};

const handleUiThemeStringChange = () => {
  themeParseError.value = null;
  const inputText = editableUiThemeString.value.trim();

  if (!inputText) {
    editableUiTheme.value = {};
    return;
  }

  const jsonStringToParse = inputText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && line.includes(':'))
    .map(line => {
      const parts = line.split(/:(.*)/s);
      if (parts.length < 2) return null;

      let key = parts[0].trim();
      let value = parts[1].trim();

      if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1);
      if (key.startsWith("'") && key.endsWith("'")) key = key.slice(1, -1);
      key = JSON.stringify(key);

      if (value.endsWith(',')) value = value.slice(0, -1).trim();
      let originalValue = value;
      if (value.startsWith('"') && value.endsWith('"')) originalValue = value.slice(1, -1);
      else if (value.startsWith("'") && value.endsWith("'")) originalValue = value.slice(1, -1);

      if (isNaN(Number(originalValue)) && originalValue !== 'true' && originalValue !== 'false' && originalValue !== 'null') {
        value = JSON.stringify(originalValue);
      } else {
        value = originalValue;
      }
      return `  ${key}: ${value}`;
    })
    .filter(line => line !== null)
    .join(',\n');

  const fullJsonString = `{\n${jsonStringToParse}\n}`;

  try {
    const parsedTheme = JSON.parse(fullJsonString);
    if (typeof parsedTheme !== 'object' || parsedTheme === null || Array.isArray(parsedTheme)) {
      throw new Error(t('styleCustomizer.errorInvalidJsonObject', '无效的主题配置格式'));
    }
    editableUiTheme.value = parsedTheme;
  } catch (error: any) {
    let errorMessage = error.message || t('styleCustomizer.errorInvalidJsonConfig', '配置格式解析失败');
    if (error instanceof SyntaxError) {
      errorMessage = `${t('styleCustomizer.errorJsonSyntax', '语法错误')}: ${error.message}`;
    }
    themeParseError.value = errorMessage;
  }
};

const handleFocusAndSelect = (event: FocusEvent) => {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    target.select();
  }
};

defineExpose({
  handleSaveUiTheme,
  handleResetUiTheme
});
</script>

<template>
  <div class="space-y-6">
    <!-- 主题预设快捷卡片 -->
    <div>
      <div class="flex items-center justify-between mb-3">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <i class="fas fa-swatchbook text-primary text-xs"></i>
          主题预设
        </h4>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <button
          v-for="preset in themePresets"
          :key="preset.id"
          type="button"
          @click="applyPreset(preset)"
          class="group flex flex-col p-2.5 rounded-xl border border-border/70 hover:border-primary/50 bg-card/60 hover:bg-accent/30 transition-all text-left shadow-sm hover:shadow"
        >
          <div class="flex items-center gap-2 mb-2">
            <span
              class="w-4 h-4 rounded-full border border-black/10 shrink-0 shadow-sm"
              :style="{ backgroundColor: preset.accent }"
            ></span>
            <span class="text-xs font-medium text-foreground group-hover:text-primary transition-colors truncate">
              {{ preset.name }}
            </span>
          </div>
          <div class="h-6 w-full rounded-md border border-border/50 flex items-center px-1.5 gap-1 overflow-hidden" :style="{ backgroundColor: preset.bg }">
            <div class="w-2.5 h-2.5 rounded-sm" :style="{ backgroundColor: preset.accent }"></div>
            <div class="h-1.5 w-8 rounded-full bg-border/80"></div>
          </div>
        </button>
      </div>
    </div>

    <!-- 核心强调色卡片组 -->
    <div class="bg-card/40 border border-border/70 rounded-xl p-4 shadow-sm">
      <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
        <i class="fas fa-magic text-primary text-xs"></i>
        强调与交互颜色
      </h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div
          v-for="item in accentVars"
          :key="item.key"
          class="flex items-center justify-between gap-2 p-2 rounded-lg bg-background/50 border border-border/40 hover:border-border transition-colors"
        >
          <div class="min-w-0 pr-1">
            <div class="text-xs font-medium text-foreground truncate">{{ item.label }}</div>
            <div class="text-[10px] text-muted-foreground font-mono truncate">{{ item.key }}</div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <input
              v-if="isColorValue(editableUiTheme[item.key])"
              type="color"
              v-model="editableUiTheme[item.key]"
              class="w-7 h-7 rounded-md border border-border cursor-pointer bg-transparent p-0 overflow-hidden shrink-0"
            />
            <input
              type="text"
              v-model="editableUiTheme[item.key]"
              @focus="handleFocusAndSelect"
              class="w-24 px-2 py-1 text-xs font-mono bg-card border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-center"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 界面与背景底色卡片组 -->
    <div class="bg-card/40 border border-border/70 rounded-xl p-4 shadow-sm">
      <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
        <i class="fas fa-layer-group text-primary text-xs"></i>
        界面与结构底色
      </h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div
          v-for="item in surfaceVars"
          :key="item.key"
          class="flex items-center justify-between gap-2 p-2 rounded-lg bg-background/50 border border-border/40 hover:border-border transition-colors"
        >
          <div class="min-w-0 pr-1">
            <div class="text-xs font-medium text-foreground truncate">{{ item.label }}</div>
            <div class="text-[10px] text-muted-foreground font-mono truncate">{{ item.key }}</div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <input
              v-if="isColorValue(editableUiTheme[item.key])"
              type="color"
              v-model="editableUiTheme[item.key]"
              class="w-7 h-7 rounded-md border border-border cursor-pointer bg-transparent p-0 overflow-hidden shrink-0"
            />
            <input
              type="text"
              v-model="editableUiTheme[item.key]"
              @focus="handleFocusAndSelect"
              class="w-24 px-2 py-1 text-xs font-mono bg-card border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-center"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 文本与状态提示卡片组 -->
    <div class="bg-card/40 border border-border/70 rounded-xl p-4 shadow-sm">
      <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
        <i class="fas fa-font text-primary text-xs"></i>
        文字与状态反馈
      </h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div
          v-for="item in typographyVars"
          :key="item.key"
          class="flex items-center justify-between gap-2 p-2 rounded-lg bg-background/50 border border-border/40 hover:border-border transition-colors"
        >
          <div class="min-w-0 pr-1">
            <div class="text-xs font-medium text-foreground truncate">{{ item.label }}</div>
            <div class="text-[10px] text-muted-foreground font-mono truncate">{{ item.key }}</div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <input
              v-if="isColorValue(editableUiTheme[item.key])"
              type="color"
              v-model="editableUiTheme[item.key]"
              class="w-7 h-7 rounded-md border border-border cursor-pointer bg-transparent p-0 overflow-hidden shrink-0"
            />
            <input
              type="text"
              v-model="editableUiTheme[item.key]"
              @focus="handleFocusAndSelect"
              class="w-24 px-2 py-1 text-xs font-mono bg-card border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-center"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 其他属性 (如有) -->
    <div v-if="otherVars.length > 0" class="bg-card/40 border border-border/70 rounded-xl p-4 shadow-sm">
      <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
        <i class="fas fa-sliders-h text-primary text-xs"></i>
        其他样式属性
      </h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div
          v-for="key in otherVars"
          :key="key"
          class="flex items-center justify-between gap-2 p-2 rounded-lg bg-background/50 border border-border/40"
        >
          <div class="text-xs font-mono text-muted-foreground truncate">{{ key }}</div>
          <input
            type="text"
            v-model="editableUiTheme[key]"
            @focus="handleFocusAndSelect"
            class="w-36 px-2 py-1 text-xs font-mono bg-card border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
          />
        </div>
      </div>
    </div>

    <!-- 高级配置抽屉 (代码视图) -->
    <div class="border border-border/70 rounded-xl bg-card/30 overflow-hidden">
      <button
        type="button"
        @click="showAdvancedEditor = !showAdvancedEditor"
        class="w-full flex items-center justify-between px-4 py-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors"
      >
        <span class="flex items-center gap-2">
          <i class="fas fa-code text-xs text-primary"></i>
          高级变量配置 (CSS Variables)
        </span>
        <i class="fas text-xs transition-transform duration-200" :class="showAdvancedEditor ? 'fa-chevron-up' : 'fa-chevron-down'"></i>
      </button>

      <div v-if="showAdvancedEditor" class="p-4 pt-1 border-t border-border/50">
        <textarea
          id="uiThemeTextarea"
          v-model="editableUiThemeString"
          @blur="handleUiThemeStringChange"
          rows="10"
          spellcheck="false"
          placeholder="--app-bg-color: #ffffff&#10;--text-color: #333333"
          class="w-full font-mono text-xs leading-relaxed border border-border/70 rounded-lg p-3 bg-background/80 text-foreground resize-y focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        ></textarea>
        <p v-if="themeParseError" class="text-xs text-destructive bg-destructive/10 border border-destructive/30 px-3 py-1.5 rounded-md mt-2 flex items-center gap-1.5">
          <i class="fas fa-exclamation-circle"></i>
          {{ themeParseError }}
        </p>
      </div>
    </div>
  </div>
</template>