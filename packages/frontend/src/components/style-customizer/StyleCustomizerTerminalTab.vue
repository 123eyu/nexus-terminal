<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppearanceStore } from '../../stores/appearance.store';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';
import { storeToRefs } from 'pinia';
import type { ITheme } from 'xterm';
import type { TerminalTheme } from '../../types/terminal-theme.types';
import { defaultXtermTheme } from '../../features/appearance/config/default-themes';
import AppSelect from '../common/AppSelect.vue';
import {
  TERMINAL_FONT_PRESETS,
  TERMINAL_FONT_CATEGORIES,
  QUICK_FONT_PILLS,
  findMatchingPreset,
  cleanFontName,
} from '../../constants/terminalFonts';

const { t } = useI18n();
const appearanceStore = useAppearanceStore();
const notificationsStore = useUiNotificationsStore();

const props = defineProps<{
  isEditingTheme: boolean;
  editingTheme: TerminalTheme | null;
  modalRootRef: HTMLDivElement | null;
}>();

const emit = defineEmits<{
  (e: 'update:isEditingTheme', value: boolean): void;
  (e: 'update:editingTheme', value: TerminalTheme | null): void;
}>();

const {
  allTerminalThemes,
  activeTerminalThemeId,
  currentTerminalFontFamily,
  currentTerminalFontSize,
  terminalTextStrokeEnabled,
  terminalTextStrokeWidth,
  terminalTextStrokeColor,
  terminalTextShadowEnabled,
  terminalTextShadowOffsetX,
  terminalTextShadowOffsetY,
  terminalTextShadowBlur,
  terminalTextShadowColor,
} = storeToRefs(appearanceStore);

const editableTerminalFontFamily = ref('');
const editableTerminalFontSize = ref(14);
const selectedFontPresetId = ref<string>('generic-monospace');
const isCustomFontMode = ref(false);

const currentFontPreset = computed(() => {
  return TERMINAL_FONT_PRESETS.find(p => p.id === selectedFontPresetId.value);
});

const syncPresetFromFontValue = (fontVal: string) => {
  const matched = findMatchingPreset(fontVal);
  if (matched) {
    selectedFontPresetId.value = matched.id;
    isCustomFontMode.value = false;
  } else if (!fontVal || fontVal.trim() === 'monospace') {
    selectedFontPresetId.value = 'generic-monospace';
    isCustomFontMode.value = false;
  } else {
    selectedFontPresetId.value = 'custom';
    isCustomFontMode.value = true;
  }
};

const editableTerminalTextStrokeEnabled = ref(false);
const editableTerminalTextStrokeWidth = ref(1);
const editableTerminalTextStrokeColor = ref('#000000');

const editableTerminalTextShadowEnabled = ref(false);
const editableTerminalTextShadowOffsetX = ref(0);
const editableTerminalTextShadowOffsetY = ref(0);
const editableTerminalTextShadowBlur = ref(0);
const editableTerminalTextShadowColor = ref('rgba(0,0,0,0.5)');

const themeSearchTerm = ref('');
const saveThemeError = ref<string | null>(null);
const editableTerminalThemeString = ref('');
const terminalThemeParseError = ref<string | null>(null);
const showThemeJsonEditor = ref(false);

const terminalThemePlaceholder = `background: #000000
foreground: #ffffff
cursor: #ffffff
selectionBackground: #555555
black: #000000
red: #ff0000
green: #00ff00
yellow: #ffff00
blue: #0000ff
magenta: #ff00ff
cyan: #00ffff
white: #ffffff
brightBlack: #555555
brightRed: #ff5555
brightGreen: #55ff55
brightYellow: #ffff55
brightBlue: #5555ff
brightMagenta: #ff55ff
brightCyan: #55ffff
brightWhite: #ffffff`;

const initializeEditableState = () => {
  editableTerminalFontFamily.value = currentTerminalFontFamily.value;
  syncPresetFromFontValue(editableTerminalFontFamily.value);
  editableTerminalFontSize.value = currentTerminalFontSize.value;

  editableTerminalTextStrokeEnabled.value = terminalTextStrokeEnabled.value;
  editableTerminalTextStrokeWidth.value = terminalTextStrokeWidth.value;
  editableTerminalTextStrokeColor.value = terminalTextStrokeColor.value;

  editableTerminalTextShadowEnabled.value = terminalTextShadowEnabled.value;
  editableTerminalTextShadowOffsetX.value = terminalTextShadowOffsetX.value;
  editableTerminalTextShadowOffsetY.value = terminalTextShadowOffsetY.value;
  editableTerminalTextShadowBlur.value = terminalTextShadowBlur.value;
  editableTerminalTextShadowColor.value = terminalTextShadowColor.value;

  saveThemeError.value = null;
  terminalThemeParseError.value = null;
};

watch(
  () => [
    currentTerminalFontFamily.value,
    currentTerminalFontSize.value,
    terminalTextStrokeEnabled.value,
    terminalTextStrokeWidth.value,
    terminalTextStrokeColor.value,
    terminalTextShadowEnabled.value,
    terminalTextShadowOffsetX.value,
    terminalTextShadowOffsetY.value,
    terminalTextShadowBlur.value,
    terminalTextShadowColor.value,
  ],
  () => {
    if (!props.isEditingTheme) {
      initializeEditableState();
    }
  },
  { immediate: true, deep: true }
);

const handleSelectFontPreset = async (presetId: string) => {
  selectedFontPresetId.value = presetId;
  if (presetId === 'custom') {
    isCustomFontMode.value = true;
    return;
  }
  const preset = TERMINAL_FONT_PRESETS.find(p => p.id === presetId);
  if (preset) {
    editableTerminalFontFamily.value = preset.value;
    isCustomFontMode.value = false;
    await handleSaveTerminalFont();
  }
};

const handleSelectQuickFontPill = async (fontValue: string) => {
  editableTerminalFontFamily.value = fontValue;
  syncPresetFromFontValue(fontValue);
  await handleSaveTerminalFont();
};

const handleSaveTerminalFont = async () => {
  try {
    await appearanceStore.setTerminalFontFamily(editableTerminalFontFamily.value);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.terminalFontSaved', '终端字体已更新') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.terminalFontSaveFailed', { message: error.message }) });
  }
};

const handleSaveTerminalFontSize = async () => {
  try {
    const size = Number(editableTerminalFontSize.value);
    if (isNaN(size) || size <= 0) {
      notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.errorInvalidFontSize', '请输入有效的字体大小') });
      return;
    }
    await appearanceStore.setTerminalFontSize(size);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.terminalFontSizeSaved', '终端字号已保存') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.terminalFontSizeSaveFailed', { message: error.message }) });
  }
};

const handleSaveTerminalTextStroke = async () => {
  try {
    await appearanceStore.setTerminalTextStrokeEnabled(editableTerminalTextStrokeEnabled.value);
    await appearanceStore.setTerminalTextStrokeWidth(Number(editableTerminalTextStrokeWidth.value));
    await appearanceStore.setTerminalTextStrokeColor(editableTerminalTextStrokeColor.value);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.textStrokeSettingsSaved', '描边设置已保存') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.textStrokeSettingsSaveFailed', { message: error.message }) });
  }
};

const handleSaveTerminalTextShadow = async () => {
  try {
    await appearanceStore.setTerminalTextShadowEnabled(editableTerminalTextShadowEnabled.value);
    await appearanceStore.setTerminalTextShadowOffsetX(Number(editableTerminalTextShadowOffsetX.value));
    await appearanceStore.setTerminalTextShadowOffsetY(Number(editableTerminalTextShadowOffsetY.value));
    await appearanceStore.setTerminalTextShadowBlur(Number(editableTerminalTextShadowBlur.value));
    await appearanceStore.setTerminalTextShadowColor(editableTerminalTextShadowColor.value);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.textShadowSettingsSaved', '阴影设置已保存') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.textShadowSettingsSaveFailed', { message: error.message }) });
  }
};

const toggleTextStrokeAndSave = async () => {
  editableTerminalTextStrokeEnabled.value = !editableTerminalTextStrokeEnabled.value;
  await handleSaveTerminalTextStroke();
};

const toggleTextShadowAndSave = async () => {
  editableTerminalTextShadowEnabled.value = !editableTerminalTextShadowEnabled.value;
  await handleSaveTerminalTextShadow();
};

const handleApplyTheme = async (theme: TerminalTheme) => {
  if (!theme._id) return;
  try {
    await appearanceStore.setActiveTerminalTheme(theme._id);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.themeAppliedSuccess', { name: theme.name }) });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.themeApplyFailed', { message: error.message }) });
  }
};

const handleAddNewTheme = () => {
  const newTheme: TerminalTheme = {
    name: '新建终端主题',
    themeData: { ...defaultXtermTheme },
    isPreset: false,
  };
  emit('update:editingTheme', newTheme);
  emit('update:isEditingTheme', true);
};

const handleEditTheme = (theme: TerminalTheme) => {
  let themeToEdit: TerminalTheme;
  if (theme.isPreset) {
    themeToEdit = {
      name: `${theme.name} (副本)`,
      themeData: JSON.parse(JSON.stringify(theme.themeData)),
      isPreset: false,
    };
  } else {
    themeToEdit = JSON.parse(JSON.stringify(theme));
  }
  emit('update:editingTheme', themeToEdit);
  emit('update:isEditingTheme', true);
};

const handleCancelEditingTheme = () => {
  emit('update:isEditingTheme', false);
  emit('update:editingTheme', null);
  saveThemeError.value = null;
  terminalThemeParseError.value = null;
};

const handleSaveEditingTheme = async () => {
  if (!props.editingTheme) return;
  saveThemeError.value = null;

  if (!props.editingTheme.name || props.editingTheme.name.trim() === '') {
    saveThemeError.value = t('styleCustomizer.errorThemeNameRequired', '请输入主题名称');
    return;
  }

  if (terminalThemeParseError.value) {
    saveThemeError.value = t('styleCustomizer.errorFixJsonBeforeSaving', '请先修复配置格式错误');
    return;
  }

  try {
    if (props.editingTheme._id) {
      await appearanceStore.updateTerminalTheme(
        props.editingTheme._id,
        props.editingTheme.name,
        props.editingTheme.themeData as any
      );
      notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.themeUpdatedSuccess', { name: props.editingTheme.name }) });
    } else {
      await appearanceStore.createTerminalTheme(
        props.editingTheme.name,
        props.editingTheme.themeData as any
      );
      notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.themeCreatedSuccess', { name: props.editingTheme.name }) });
    }
    emit('update:isEditingTheme', false);
    emit('update:editingTheme', null);
  } catch (error: any) {
    saveThemeError.value = error.message || t('styleCustomizer.themeSaveFailedGeneral', '保存失败');
  }
};

const handleTerminalThemeStringChange = () => {
  terminalThemeParseError.value = null;
  const inputText = editableTerminalThemeString.value.trim();

  if (!inputText) {
    if (props.editingTheme) {
      emit('update:editingTheme', { ...props.editingTheme, themeData: {} });
    }
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
    const parsedThemeData = JSON.parse(fullJsonString);
    if (typeof parsedThemeData !== 'object' || parsedThemeData === null || Array.isArray(parsedThemeData)) {
      throw new Error(t('styleCustomizer.errorInvalidJsonObject', '无效的主题格式'));
    }
    if (props.editingTheme) {
      emit('update:editingTheme', { ...props.editingTheme, themeData: parsedThemeData });
    }
  } catch (error: any) {
    terminalThemeParseError.value = error.message;
  }
};

const handleDeleteTheme = async (theme: TerminalTheme) => {
  if (theme.isPreset || !theme._id) return;
  try {
    await appearanceStore.deleteTerminalTheme(theme._id);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.themeDeletedSuccess', '已删除主题') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.themeDeleteFailed', { message: error.message }) });
  }
};

const formatXtermLabel = (key: keyof ITheme): string => {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
};

const handleFocusAndSelect = (event: FocusEvent) => {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    target.select();
  }
};

const activeThemeName = computed(() => {
  const currentIdNum = activeTerminalThemeId.value;
  if (currentIdNum === null || currentIdNum === undefined) {
    return t('styleCustomizer.noThemeSelected', '未选定主题');
  }
  const theme = allTerminalThemes.value.find((t: TerminalTheme) => t._id === currentIdNum.toString());
  return theme ? theme.name : t('styleCustomizer.unknownTheme', '自定义主题');
});

const filteredAndSortedThemes = computed(() => {
  const searchTerm = themeSearchTerm.value.toLowerCase().trim();
  let themes = [...allTerminalThemes.value];
  if (searchTerm) {
    themes = themes.filter((theme: TerminalTheme) => theme.name.toLowerCase().includes(searchTerm));
  }
  themes.sort((a: TerminalTheme, b: TerminalTheme) => a.name.localeCompare(b.name));
  return themes;
});

watch(() => props.editingTheme?.themeData, (newThemeData) => {
  if (newThemeData && (document.activeElement?.id !== 'terminalThemeTextarea' || terminalThemeParseError.value)) {
    try {
      let newStringValue = '';
      if (typeof newThemeData === 'object' && Object.keys(newThemeData).length > 0) {
        const lines = Object.entries(newThemeData).map(([key, value]) => `${key}: ${value}`);
        newStringValue = lines.join('\n');
      }
      if (newStringValue !== editableTerminalThemeString.value) {
        editableTerminalThemeString.value = newStringValue;
      }
      if (terminalThemeParseError.value && document.activeElement?.id !== 'terminalThemeTextarea') {
        terminalThemeParseError.value = null;
      }
    } catch (e) {
      // ignore
    }
  }
}, { deep: true });

watch(() => props.isEditingTheme, (isEditing) => {
  if (isEditing && props.editingTheme) {
    try {
      const themeObject = props.editingTheme.themeData;
      if (themeObject && typeof themeObject === 'object' && Object.keys(themeObject).length > 0) {
        const lines = Object.entries(themeObject).map(([key, value]) => `${key}: ${value}`);
        editableTerminalThemeString.value = lines.join('\n');
      } else {
        editableTerminalThemeString.value = terminalThemePlaceholder;
      }
    } catch (e) {
      editableTerminalThemeString.value = terminalThemePlaceholder;
    }
    terminalThemeParseError.value = null;
  } else if (!isEditing) {
    editableTerminalThemeString.value = '';
    terminalThemeParseError.value = null;
    saveThemeError.value = null;
    initializeEditableState();
  }
}, { immediate: true });
</script>

<template>
  <div v-if="!isEditingTheme" class="space-y-6">
    <!-- 字体与字号卡片 -->
    <div class="bg-card/40 border border-border/70 rounded-xl p-4 shadow-sm space-y-4">
      <div class="flex items-center justify-between">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <i class="fas fa-font text-primary text-xs"></i>
          字体与排版
        </h4>
        <div class="flex items-center gap-3">
          <!-- 字号调节器 -->
          <div class="flex items-center gap-1.5 bg-background/60 border border-border/60 px-2 py-0.5 rounded-lg text-xs">
            <span class="text-muted-foreground text-[11px]">字号:</span>
            <input
              type="number"
              v-model.number="editableTerminalFontSize"
              @change="handleSaveTerminalFontSize"
              @keydown.enter.prevent="handleSaveTerminalFontSize"
              min="8"
              max="48"
              class="w-11 bg-transparent text-foreground text-center font-mono font-medium focus:outline-none"
            />
            <span class="text-muted-foreground text-[10px]">px</span>
          </div>

          <!-- 自定义字体模式切换 -->
          <button
            type="button"
            @click="isCustomFontMode = !isCustomFontMode"
            class="text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
          >
            <i :class="isCustomFontMode ? 'fas fa-list-ul' : 'fas fa-pen-to-square'"></i>
            <span>{{ isCustomFontMode ? '预设列表' : '自定义输入' }}</span>
          </button>
        </div>
      </div>

      <!-- 下拉选择或输入 -->
      <div v-if="!isCustomFontMode">
        <AppSelect
          id="terminalFontSelect"
          v-model="selectedFontPresetId"
          @change="handleSelectFontPreset(selectedFontPresetId)"
          class="w-full px-3 py-2 text-xs border border-border/70 rounded-lg bg-background text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors cursor-pointer"
        >
          <optgroup
            v-for="cat in TERMINAL_FONT_CATEGORIES"
            :key="cat.key"
            :label="cat.label"
          >
            <option
              v-for="font in TERMINAL_FONT_PRESETS.filter(p => p.category === cat.key)"
              :key="font.id"
              :value="font.id"
            >
              {{ font.name }} - {{ font.description }}
            </option>
          </optgroup>
          <optgroup label="其他">
            <option value="custom">✏️ 自定义输入字体...</option>
          </optgroup>
        </AppSelect>
      </div>
      <div v-else class="flex items-center gap-2">
        <input
          type="text"
          v-model="editableTerminalFontFamily"
          @keydown.enter.prevent="handleSaveTerminalFont"
          @blur="handleSaveTerminalFont"
          class="flex-1 px-3 py-2 text-xs border border-border/70 rounded-lg bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary font-mono"
          placeholder="例如：'Cascadia Code', Consolas, monospace"
        />
        <button
          type="button"
          @click="handleSaveTerminalFont"
          class="px-3 py-2 text-xs font-medium text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors shrink-0 shadow-sm"
        >
          保存
        </button>
      </div>

      <!-- 快速切换标签 -->
      <div class="flex items-center gap-1.5 flex-wrap pt-1">
        <button
          v-for="pill in QUICK_FONT_PILLS"
          :key="pill.name"
          type="button"
          @click="handleSelectQuickFontPill(pill.value)"
          class="px-2.5 py-1 text-xs rounded-md border transition-all font-mono"
          :class="cleanFontName(editableTerminalFontFamily).toLowerCase() === cleanFontName(pill.value).toLowerCase()
            ? 'bg-primary text-primary-foreground border-primary font-semibold shadow-sm'
            : 'bg-background/60 text-muted-foreground border-border/60 hover:text-foreground hover:bg-background'"
        >
          {{ pill.name }}
        </button>
      </div>

      <!-- 实时预览条 -->
      <div
        class="p-3 rounded-lg border border-border/60 bg-background/80 space-y-1"
        :style="{ fontFamily: editableTerminalFontFamily || 'monospace' }"
      >
        <div class="flex items-center justify-between text-[11px] text-muted-foreground border-b border-border/40 pb-1">
          <span class="font-medium text-foreground">
            {{ currentFontPreset?.name || cleanFontName(editableTerminalFontFamily) || '系统默认' }}
          </span>
          <span class="font-mono text-[10px] text-muted-foreground truncate max-w-[280px]">
            {{ editableTerminalFontFamily || 'monospace' }} ({{ editableTerminalFontSize }}px)
          </span>
        </div>
        <div class="text-xs leading-relaxed overflow-x-auto text-foreground select-all py-1">
          <div>0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz</div>
          <div class="text-muted-foreground text-[11px] mt-0.5">const ok = (a != b) &amp;&amp; (x &lt;= y) &amp;&amp; (tag === "nexus"); // 0xDEADBEEF -&gt; =&gt;</div>
        </div>
      </div>
    </div>

    <!-- 文字特效卡片组 (描边与阴影) -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <!-- 描边卡片 -->
      <div class="bg-card/40 border border-border/70 rounded-xl p-4 shadow-sm space-y-3">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <i class="fas fa-pen text-primary text-xs"></i>
            文字描边
          </h4>
          <button
            type="button"
            @click="toggleTextStrokeAndSave"
            class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
            :class="editableTerminalTextStrokeEnabled ? 'bg-primary' : 'bg-muted-foreground/30'"
          >
            <span
              class="pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition duration-200 ease-in-out"
              :class="editableTerminalTextStrokeEnabled ? 'translate-x-4' : 'translate-x-0'"
            ></span>
          </button>
        </div>

        <div v-if="editableTerminalTextStrokeEnabled" class="space-y-2.5 pt-1">
          <div class="flex items-center justify-between gap-2 p-2 rounded-lg bg-background/50 border border-border/40">
            <span class="text-xs text-foreground">描边宽度</span>
            <div class="flex items-center gap-1">
              <input
                type="number"
                v-model.number="editableTerminalTextStrokeWidth"
                @change="handleSaveTerminalTextStroke"
                min="0"
                step="0.1"
                class="w-16 px-2 py-1 text-xs font-mono bg-card border border-border rounded-md text-foreground text-center"
              />
              <span class="text-[10px] text-muted-foreground">px</span>
            </div>
          </div>
          <div class="flex items-center justify-between gap-2 p-2 rounded-lg bg-background/50 border border-border/40">
            <span class="text-xs text-foreground">描边颜色</span>
            <div class="flex items-center gap-1.5">
              <input
                type="color"
                v-model="editableTerminalTextStrokeColor"
                @change="handleSaveTerminalTextStroke"
                class="w-7 h-7 rounded-md border border-border cursor-pointer bg-transparent p-0 overflow-hidden"
              />
              <input
                type="text"
                v-model="editableTerminalTextStrokeColor"
                @change="handleSaveTerminalTextStroke"
                class="w-20 px-2 py-1 text-xs font-mono bg-card border border-border rounded-md text-foreground text-center"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- 阴影卡片 -->
      <div class="bg-card/40 border border-border/70 rounded-xl p-4 shadow-sm space-y-3">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <i class="fas fa-cloud-moon text-primary text-xs"></i>
            文字阴影
          </h4>
          <button
            type="button"
            @click="toggleTextShadowAndSave"
            class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
            :class="editableTerminalTextShadowEnabled ? 'bg-primary' : 'bg-muted-foreground/30'"
          >
            <span
              class="pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition duration-200 ease-in-out"
              :class="editableTerminalTextShadowEnabled ? 'translate-x-4' : 'translate-x-0'"
            ></span>
          </button>
        </div>

        <div v-if="editableTerminalTextShadowEnabled" class="space-y-2 pt-1">
          <div class="grid grid-cols-2 gap-2">
            <div class="flex items-center justify-between p-2 rounded-lg bg-background/50 border border-border/40">
              <span class="text-[11px] text-foreground">X 偏移</span>
              <input
                type="number"
                v-model.number="editableTerminalTextShadowOffsetX"
                @change="handleSaveTerminalTextShadow"
                step="0.5"
                class="w-12 px-1.5 py-0.5 text-xs font-mono bg-card border border-border rounded text-center"
              />
            </div>
            <div class="flex items-center justify-between p-2 rounded-lg bg-background/50 border border-border/40">
              <span class="text-[11px] text-foreground">Y 偏移</span>
              <input
                type="number"
                v-model.number="editableTerminalTextShadowOffsetY"
                @change="handleSaveTerminalTextShadow"
                step="0.5"
                class="w-12 px-1.5 py-0.5 text-xs font-mono bg-card border border-border rounded text-center"
              />
            </div>
          </div>
          <div class="flex items-center justify-between p-2 rounded-lg bg-background/50 border border-border/40">
            <span class="text-xs text-foreground">模糊半径</span>
            <div class="flex items-center gap-1">
              <input
                type="number"
                v-model.number="editableTerminalTextShadowBlur"
                @change="handleSaveTerminalTextShadow"
                min="0"
                step="0.5"
                class="w-16 px-2 py-1 text-xs font-mono bg-card border border-border rounded-md text-foreground text-center"
              />
              <span class="text-[10px] text-muted-foreground">px</span>
            </div>
          </div>
          <div class="flex items-center justify-between p-2 rounded-lg bg-background/50 border border-border/40">
            <span class="text-xs text-foreground">阴影颜色</span>
            <div class="flex items-center gap-1.5">
              <input
                type="color"
                v-model="editableTerminalTextShadowColor"
                @change="handleSaveTerminalTextShadow"
                class="w-7 h-7 rounded-md border border-border cursor-pointer bg-transparent p-0 overflow-hidden"
              />
              <input
                type="text"
                v-model="editableTerminalTextShadowColor"
                @change="handleSaveTerminalTextShadow"
                class="w-24 px-2 py-1 text-xs font-mono bg-card border border-border rounded-md text-foreground text-center"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 终端主题卡片管理列表 -->
    <div class="bg-card/40 border border-border/70 rounded-xl p-4 shadow-sm space-y-3">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <i class="fas fa-paint-brush text-primary text-xs"></i>
            终端配色主题
          </h4>
          <div class="text-xs text-foreground mt-0.5">
            当前使用：<span class="font-semibold text-primary">{{ activeThemeName }}</span>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <div class="relative w-44">
            <i class="fas fa-search absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs"></i>
            <input
              type="text"
              v-model="themeSearchTerm"
              placeholder="搜索主题..."
              class="w-full pl-7 pr-2.5 py-1 text-xs border border-border/70 rounded-lg bg-background/70 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <button
            type="button"
            @click="handleAddNewTheme"
            class="px-2.5 py-1 text-xs font-medium text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-1 shrink-0 shadow-sm"
          >
            <i class="fas fa-plus text-[10px]"></i>
            新建主题
          </button>
        </div>
      </div>

      <!-- 主题列表卡片 -->
      <div class="max-h-[260px] overflow-y-auto space-y-1.5 pr-1 border border-border/50 rounded-lg p-1.5 bg-background/50">
        <div v-if="filteredAndSortedThemes.length === 0" class="text-center text-xs text-muted-foreground py-6 italic">
          未找到匹配的主题
        </div>
        <div
          v-else
          v-for="theme in filteredAndSortedThemes"
          :key="theme._id"
          class="flex items-center justify-between px-3 py-2 rounded-lg border transition-all text-xs"
          :class="theme._id === activeTerminalThemeId?.toString()
            ? 'bg-primary/10 border-primary/40 font-medium'
            : 'bg-card/50 border-border/50 hover:border-border hover:bg-card/80'"
        >
          <div class="flex items-center gap-2 min-w-0 pr-2">
            <span
              class="w-2 h-2 rounded-full shrink-0"
              :class="theme._id === activeTerminalThemeId?.toString() ? 'bg-primary ring-2 ring-primary/30' : 'bg-muted-foreground/40'"
            ></span>
            <span class="truncate text-foreground font-medium" :title="theme.name">{{ theme.name }}</span>
            <span v-if="theme.isPreset" class="text-[10px] px-1.5 py-0.2 rounded bg-muted/60 text-muted-foreground border border-border/40 shrink-0">内置</span>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              @click="handleApplyTheme(theme)"
              :disabled="theme._id === activeTerminalThemeId?.toString()"
              class="px-2.5 py-1 rounded text-xs transition-colors"
              :class="theme._id === activeTerminalThemeId?.toString()
                ? 'bg-primary text-primary-foreground font-semibold cursor-default'
                : 'bg-accent/60 hover:bg-accent text-foreground border border-border/60'"
            >
              {{ theme._id === activeTerminalThemeId?.toString() ? '当前使用' : '应用' }}
            </button>
            <button
              type="button"
              @click="handleEditTheme(theme)"
              class="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
              :title="theme.isPreset ? '作为副本编辑' : '编辑'"
            >
              <i class="fas fa-edit"></i>
            </button>
            <button
              v-if="!theme.isPreset"
              type="button"
              @click="handleDeleteTheme(theme)"
              class="px-2 py-1 rounded text-xs text-destructive/70 hover:text-destructive hover:bg-destructive/10 transition-colors"
              title="删除"
            >
              <i class="fas fa-trash-alt"></i>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 编辑终端主题模式 -->
  <div v-else-if="editingTheme" class="space-y-5">
    <div class="flex items-center justify-between border-b border-border/60 pb-3">
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-primary animate-pulse"></span>
        <h4 class="text-sm font-semibold text-foreground">
          {{ editingTheme._id ? '编辑终端主题' : '新建终端主题' }}
        </h4>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          @click="handleCancelEditingTheme"
          class="px-3 py-1.5 text-xs border border-border/70 rounded-lg bg-card hover:bg-accent/30 text-foreground transition-colors"
        >
          取消
        </button>
        <button
          type="button"
          @click="handleSaveEditingTheme"
          class="px-3.5 py-1.5 text-xs font-medium text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors shadow-sm"
        >
          保存主题
        </button>
      </div>
    </div>

    <div v-if="saveThemeError" class="text-xs text-destructive bg-destructive/10 border border-destructive/30 px-3 py-2 rounded-lg flex items-center gap-2">
      <i class="fas fa-exclamation-circle"></i>
      {{ saveThemeError }}
    </div>

    <!-- 主题名称 -->
    <div class="bg-card/40 border border-border/70 rounded-xl p-3.5 shadow-sm">
      <label for="editingThemeName" class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 block">
        主题名称
      </label>
      <input
        type="text"
        id="editingThemeName"
        v-model="editingTheme.name"
        required
        class="w-full px-3 py-2 text-xs border border-border/70 rounded-lg bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </div>

    <!-- 调色板颜色网格 -->
    <div class="bg-card/40 border border-border/70 rounded-xl p-4 shadow-sm space-y-3">
      <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
        <i class="fas fa-palette text-primary text-xs"></i>
        ANSI 终端颜色定义
      </h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[300px] overflow-y-auto pr-1">
        <div
          v-for="(value, key) in editingTheme.themeData"
          :key="key"
          class="flex items-center justify-between gap-2 p-2 rounded-lg bg-background/50 border border-border/40 hover:border-border transition-colors"
        >
          <div class="text-xs font-mono text-foreground truncate min-w-0 pr-1">
            {{ formatXtermLabel(key as keyof ITheme) }}
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <input
              v-if="typeof value === 'string' && value.startsWith('#')"
              type="color"
              :id="`xterm-${key}`"
              v-model.lazy="(editingTheme.themeData as any)[key]"
              class="w-7 h-7 rounded-md border border-border cursor-pointer bg-transparent p-0 overflow-hidden"
            />
            <input
              v-if="typeof value === 'string' && value.startsWith('#')"
              type="text"
              :value="(editingTheme.themeData as any)[key]"
              readonly
              @focus="handleFocusAndSelect"
              class="w-20 px-1.5 py-1 text-xs font-mono bg-card border border-border rounded-md text-foreground text-center"
            />
            <input
              v-else
              type="text"
              v-model="(editingTheme.themeData as any)[key]"
              class="w-28 px-1.5 py-1 text-xs font-mono bg-card border border-border rounded-md text-foreground"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 高级配置抽屉 -->
    <div class="border border-border/70 rounded-xl bg-card/30 overflow-hidden">
      <button
        type="button"
        @click="showThemeJsonEditor = !showThemeJsonEditor"
        class="w-full flex items-center justify-between px-4 py-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/20 transition-colors"
      >
        <span class="flex items-center gap-2">
          <i class="fas fa-code text-xs text-primary"></i>
          高级主题代码 (Theme Key-Value)
        </span>
        <i class="fas text-xs transition-transform duration-200" :class="showThemeJsonEditor ? 'fa-chevron-up' : 'fa-chevron-down'"></i>
      </button>

      <div v-if="showThemeJsonEditor" class="p-4 pt-1 border-t border-border/50">
        <textarea
          id="terminalThemeTextarea"
          v-model="editableTerminalThemeString"
          @blur="handleTerminalThemeStringChange"
          rows="10"
          :placeholder="terminalThemePlaceholder"
          spellcheck="false"
          class="w-full font-mono text-xs leading-relaxed border border-border/70 rounded-lg p-3 bg-background/80 text-foreground resize-y focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        ></textarea>
        <p v-if="terminalThemeParseError" class="text-xs text-destructive bg-destructive/10 border border-destructive/30 px-3 py-1.5 rounded-md mt-2 flex items-center gap-1.5">
          <i class="fas fa-exclamation-circle"></i>
          {{ terminalThemeParseError }}
        </p>
      </div>
    </div>
  </div>
</template>