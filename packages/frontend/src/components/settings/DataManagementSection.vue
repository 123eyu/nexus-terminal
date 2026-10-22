<template>
  <div v-if="settings" class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
    <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">
      {{ t('settings.category.dataManagement', '数据管理') }}
    </h2>

    <div class="p-6 space-y-8">
      <!-- ===== 导出 ===== -->
      <section class="space-y-4">
        <div>
          <h3 class="text-base font-semibold text-foreground">{{ t('settings.dataTransfer.exportTitle') }}</h3>
          <p class="text-sm text-text-secondary mt-1">{{ t('settings.dataTransfer.exportHint') }}</p>
        </div>

        <div class="rounded-lg border border-border bg-background-secondary/30 p-4 space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-sm font-medium text-foreground">
              {{ t('settings.dataTransfer.selectDatasets') }}
              <span class="text-text-secondary font-normal">({{ selectedCount }})</span>
            </span>
            <div class="flex items-center gap-2 text-xs">
              <button type="button" class="text-primary hover:underline" @click="selectAll(true)">
                {{ t('settings.dataTransfer.selectAll') }}
              </button>
              <span class="text-text-secondary/40">/</span>
              <button type="button" class="text-primary hover:underline" @click="selectAll(false)">
                {{ t('settings.dataTransfer.selectNone') }}
              </button>
            </div>
          </div>

          <div v-for="group in visibleGroups" :key="group.id" class="space-y-1.5">
            <div class="text-xs font-medium text-text-secondary tracking-wide">
              {{ t(`settings.dataTransfer.groups.${group.id}`) }}
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
              <label
                v-for="key in group.keys"
                :key="key"
                class="flex items-center gap-2 text-sm cursor-pointer select-none py-0.5"
              >
                <input type="checkbox" :checked="isSelected(key)" @change="toggleDataset(key)" />
                <span class="text-foreground">{{ t(`settings.dataTransfer.datasets.${key}`, key) }}</span>
                <span
                  v-if="isSensitive(key)"
                  class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-warning/15 text-warning shrink-0"
                >
                  {{ t('settings.dataTransfer.sensitiveBadge') }}
                </span>
              </label>
            </div>
          </div>
        </div>

        <div class="space-y-2">
          <div class="text-sm font-medium text-foreground">{{ t('settings.dataTransfer.secretMode') }}</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label
              class="flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors"
              :class="secretMode === 'encrypted' ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-header/30'"
            >
              <input v-model="secretMode" type="radio" value="encrypted" class="mt-0.5 accent-[var(--color-primary)]" />
              <span class="min-w-0">
                <span class="block text-sm text-foreground">{{ t('settings.dataTransfer.secretModeEncrypted') }}</span>
                <span class="block text-xs text-text-secondary mt-0.5">{{ t('settings.dataTransfer.secretModeEncryptedHint') }}</span>
              </span>
            </label>
            <label
              class="flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors"
              :class="secretMode === 'stripped' ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-header/30'"
            >
              <input v-model="secretMode" type="radio" value="stripped" class="mt-0.5 accent-[var(--color-primary)]" />
              <span class="min-w-0">
                <span class="block text-sm text-foreground">{{ t('settings.dataTransfer.secretModeStripped') }}</span>
                <span class="block text-xs text-text-secondary mt-0.5">{{ t('settings.dataTransfer.secretModeStrippedHint') }}</span>
              </span>
            </label>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <label class="block text-sm text-foreground">{{ t('settings.dataTransfer.password') }}</label>
            <input
              v-model="password"
              type="password"
              autocomplete="new-password"
              :placeholder="t('settings.dataTransfer.passwordPlaceholder')"
              class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm text-foreground">{{ t('settings.dataTransfer.passwordConfirm') }}</label>
            <input
              v-model="passwordConfirm"
              type="password"
              autocomplete="new-password"
              :placeholder="t('settings.dataTransfer.passwordPlaceholder')"
              class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
            />
          </div>
        </div>
        <p class="text-xs text-text-secondary">{{ t('settings.dataTransfer.passwordHint') }}</p>

        <div class="flex flex-wrap items-center gap-3">
          <button
            type="button"
            :disabled="exporting"
            class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover text-sm font-medium inline-flex items-center disabled:opacity-50 disabled:cursor-not-allowed transition"
            @click="handleExport"
          >
            <i v-if="exporting" class="fas fa-circle-notch fa-spin mr-2 text-xs"></i>
            {{ exporting ? t('settings.dataTransfer.exporting') : t('settings.dataTransfer.exportButton') }}
          </button>
          <p v-if="exportError" class="text-sm text-error">{{ exportError }}</p>
          <p v-else-if="exportNotice" class="text-sm text-success">{{ exportNotice }}</p>
        </div>
      </section>

      <div class="border-t border-border"></div>

      <!-- ===== 导入 ===== -->
      <section class="space-y-4">
        <div>
          <h3 class="text-base font-semibold text-foreground">{{ t('settings.dataTransfer.importTitle') }}</h3>
          <p class="text-sm text-text-secondary mt-1">{{ t('settings.dataTransfer.importHint') }}</p>
        </div>

        <div class="space-y-3">
          <div class="space-y-1.5">
            <label class="block text-sm text-foreground">{{ t('settings.dataTransfer.importFile') }}</label>
            <input
              type="file"
              accept=".zip,application/zip"
              class="block w-full text-sm text-text-secondary file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-button file:text-button-text hover:file:bg-button-hover file:cursor-pointer cursor-pointer"
              @change="onFileChange"
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-sm text-foreground">{{ t('settings.dataTransfer.importPassword') }}</label>
            <input
              v-model="importPassword"
              type="password"
              autocomplete="off"
              :placeholder="t('settings.dataTransfer.passwordPlaceholder')"
              class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
            />
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <button
              type="button"
              :disabled="analyzing || importing"
              class="px-4 py-2 rounded-md shadow-sm text-sm font-medium inline-flex items-center border border-border bg-background text-foreground hover:bg-header/40 disabled:opacity-50 disabled:cursor-not-allowed transition"
              @click="handleAnalyze"
            >
              <i v-if="analyzing" class="fas fa-circle-notch fa-spin mr-2 text-xs"></i>
              {{ analyzing ? t('settings.dataTransfer.analyzing') : t('settings.dataTransfer.analyzeButton') }}
            </button>
            <p v-if="importError" class="text-sm text-error">{{ importError }}</p>
          </div>
        </div>

        <!-- 预览 -->
        <div v-if="analysis" class="rounded-lg border border-border overflow-hidden">
          <div class="px-4 py-3 bg-header/40 border-b border-border space-y-1">
            <div class="text-sm font-medium text-foreground">{{ t('settings.dataTransfer.previewTitle') }}</div>
            <div class="text-xs text-text-secondary">
              {{ t('settings.dataTransfer.packageFrom', {
                version: analysis.manifest.appVersion,
                date: formatDate(analysis.manifest.exportedAt),
                schema: analysis.manifest.schemaVersion,
              }) }}
            </div>
            <div class="text-xs text-text-secondary">
              {{ t('settings.dataTransfer.previewTotals', analysis.totals) }}
            </div>
            <div v-if="analysis.unknownDatasets.length" class="text-xs text-warning">
              {{ t('settings.dataTransfer.unknownDatasets', { items: analysis.unknownDatasets.join(', ') }) }}
            </div>
          </div>

          <div class="divide-y divide-border">
            <div
              v-for="plan in visiblePlans"
              :key="plan.key"
              class="px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2"
            >
              <div class="flex-1 min-w-[7rem] text-sm text-foreground truncate">
                {{ t(`settings.dataTransfer.datasets.${plan.key}`, plan.key) }}
              </div>
              <div class="flex items-center gap-3 text-xs tabular-nums">
                <span class="text-text-secondary">{{ plan.incoming }}</span>
                <span class="text-success" :title="t('settings.dataTransfer.colCreate')">+{{ plan.create }}</span>
                <span class="text-warning" :title="t('settings.dataTransfer.colConflict')">~{{ plan.conflict }}</span>
                <span v-if="plan.invalid > 0" class="text-error" :title="t('settings.dataTransfer.colInvalid')">
                  !{{ plan.invalid }}
                </span>
              </div>
              <select
                v-if="plan.conflict > 0"
                v-model="strategies[plan.key]"
                class="text-xs px-2 py-1.5 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="skip">{{ t('settings.dataTransfer.strategySkip') }}</option>
                <option value="overwrite">{{ t('settings.dataTransfer.strategyOverwrite') }}</option>
                <option value="duplicate">{{ t('settings.dataTransfer.strategyDuplicate') }}</option>
              </select>
              <span v-else class="text-xs text-text-secondary/40 px-2">—</span>
            </div>
          </div>

          <div class="px-4 py-3 border-t border-border flex flex-wrap items-center justify-between gap-3 bg-background-secondary/20">
            <p class="text-xs text-text-secondary">{{ t('settings.dataTransfer.strategyHint') }}</p>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="px-3 py-2 rounded-md text-sm border border-border bg-background text-foreground hover:bg-header/40 transition"
                @click="resetImport"
              >
                {{ t('settings.dataTransfer.cancel') }}
              </button>
              <button
                type="button"
                :disabled="importing"
                class="px-4 py-2 bg-primary text-primary-text rounded-md shadow-sm text-sm font-medium inline-flex items-center disabled:opacity-50 disabled:cursor-not-allowed transition"
                @click="handleImport"
              >
                <i v-if="importing" class="fas fa-circle-notch fa-spin mr-2 text-xs"></i>
                {{ importing ? t('settings.dataTransfer.importing') : t('settings.dataTransfer.confirmImport') }}
              </button>
            </div>
          </div>
        </div>

        <!-- 报告 -->
        <div v-if="report" class="rounded-lg border border-border overflow-hidden">
          <div class="px-4 py-3 bg-header/40 border-b border-border">
            <div class="text-sm font-medium text-foreground">{{ t('settings.dataTransfer.reportTitle') }}</div>
          </div>
          <div class="divide-y divide-border">
            <div
              v-for="item in report.datasets"
              :key="item.key"
              class="px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
            >
              <span class="flex-1 min-w-[7rem] text-foreground truncate">
                {{ t(`settings.dataTransfer.datasets.${item.key}`, item.key) }}
              </span>
              <span class="text-xs tabular-nums flex items-center gap-2.5" :title="reportLine(item)">
                <span class="text-success">+{{ item.created }}</span>
                <span class="text-primary">~{{ item.updated }}</span>
                <span class="text-text-secondary">={{ item.skipped }}</span>
                <span v-if="item.invalid > 0" class="text-error">!{{ item.invalid }}</span>
              </span>
            </div>
          </div>
          <div class="px-4 py-3 border-t border-border bg-background-secondary/20 flex items-center justify-between gap-3">
            <span class="text-xs text-text-secondary tabular-nums">
              {{ t('settings.dataTransfer.reportTotals', report.totals) }}
            </span>
            <button
              type="button"
              class="px-3 py-1.5 rounded-md text-sm border border-border bg-background text-foreground hover:bg-header/40 transition"
              @click="resetImport"
            >
              {{ t('settings.dataTransfer.done') }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSettingsStore } from '../../stores/settings.store';
import { useDataTransfer, type DatasetReport } from '../../composables/settings/useDataTransfer';

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { settings } = storeToRefs(settingsStore);

const {
  datasets,
  selectedCount,
  secretMode,
  password,
  passwordConfirm,
  exporting,
  exportError,
  exportNotice,
  importPassword,
  analyzing,
  importing,
  analysis,
  strategies,
  report,
  importError,
  loadDatasets,
  toggleDataset,
  selectAll,
  isSelected,
  handleExport,
  onFileChange,
  handleAnalyze,
  handleImport,
  resetImport,
} = useDataTransfer();

/**
 * 分组只是为了不在设置页里铺 17 个复选框。
 * 真正的"哪些默认勾选"由后端 defaultSelected 决定，这里不重复维护。
 */
const GROUPS: Array<{ id: string; keys: string[] }> = [
  {
    id: 'core',
    keys: [
      'connections',
      'tags',
      'connectionTags',
      'proxies',
      'sshKeys',
      'quickCommands',
      'quickCommandTags',
      'quickCommandTagAssociations',
      'terminalThemes',
      'favoritePaths',
      'fileColorHighlights',
    ],
  },
  { id: 'preferences', keys: ['settings', 'appearance', 'workspace'] },
  { id: 'optional', keys: ['notificationSettings', 'commandHistory', 'pathHistory'] },
];

const sensitiveKeys = computed(
  () => new Set(datasets.value.filter((item) => item.sensitive).map((item) => item.key))
);

const isSensitive = (key: string) => sensitiveKeys.value.has(key);

const visibleGroups = computed(() => {
    const known = new Set(datasets.value.map((item) => item.key));
    const grouped = new Set<string>();
    const groups = GROUPS.map((group) => {
        const keys = group.keys.filter((key) => known.has(key));
        keys.forEach((key) => grouped.add(key));
        return { id: group.id, keys };
    }).filter((group) => group.keys.length > 0);

    const leftovers = [...known].filter((key) => !grouped.has(key));
    if (leftovers.length > 0) groups.push({ id: 'other', keys: leftovers });
    return groups;
});

/** 条数为 0 的数据集（比如用户一个代理都没配）不占预览的版面 */
const visiblePlans = computed(() =>
  (analysis.value?.plans || []).filter((plan) => plan.incoming > 0)
);

function formatDate(value: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function reportLine(item: DatasetReport): string {
  return t('settings.dataTransfer.reportLine', {
    created: item.created,
    updated: item.updated,
    skipped: item.skipped,
    invalid: item.invalid,
  });
}

onMounted(() => {
  void loadDatasets();
});
</script>
