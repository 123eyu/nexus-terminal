<template>
  <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
    <div class="flex-1 pr-2">
      <div class="flex items-center gap-1.5">
        <span class="text-[15px] sm:text-base font-medium text-foreground">
          {{ $t(effectiveTitleKey, titleFallback ?? settingKey) }}
        </span>
        <HelpTooltip v-if="descKey || descFallback" :text="$t(descKey ?? '', descFallback ?? '')" />
      </div>
    </div>
    <div class="flex items-center gap-3 shrink-0">
      <span v-if="!success && message" class="text-sm font-medium text-red-500 flex items-center gap-1">
        <i class="fas fa-exclamation-circle text-xs"></i>
        {{ message }}
      </span>
      <ToggleSwitch
        v-model="local"
        :loading="loading"
        @change="save"
        :aria-label="$t(ariaKey ?? effectiveTitleKey, titleFallback ?? settingKey)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import HelpTooltip from '../common/HelpTooltip.vue';
import ToggleSwitch from '../common/ToggleSwitch.vue';
import { useBooleanSettingControl } from '../../composables/settings/useSettingControl';
import { SETTING_DEFAULTS } from '../../stores/settings.schema.generated';

/**
 * 单个布尔设置项。
 *
 * 以前每个开关是一整块 20 多行模板 + useWorkspaceSettings 里 5 个字段的解构，
 * 加一个开关要动 8~11 个地方。现在只要：
 *
 *   <SettingToggle setting-key="fileManagerHighlightChanges" />
 *
 * 默认文案 key 约定为 settings.workspace.<key>{Title,Description,Success,Error}，
 * 老文案不符合约定的显式传 title-key / desc-key / success-key / error-key 即可。
 */
interface Props {
  /** 必须是 settings schema 里的布尔键 */
  settingKey: string;
  /** 标题 i18n key（默认 settings.workspace.<key>Title） */
  titleKey?: string;
  /** 标题兜底文案（i18n 缺失时显示） */
  titleFallback?: string;
  /** 说明 tooltip 的 i18n key；不传则不显示 tooltip */
  descKey?: string;
  descFallback?: string;
  successKey?: string;
  errorKey?: string;
  ariaKey?: string;
  /** 走专用接口、需要真正的 boolean 而不是 'true'/'false' */
  nativeBoolean?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  titleKey: undefined,
  titleFallback: undefined,
  descKey: undefined,
  descFallback: undefined,
  successKey: undefined,
  errorKey: undefined,
  ariaKey: undefined,
  nativeBoolean: false,
});

const { t } = useI18n();

const effectiveTitleKey = computed(() => props.titleKey ?? `settings.workspace.${props.settingKey}Title`);

/** 默认值始终来自 schema —— 前端不再各自维护一份 */
const schemaDefault = computed(() => SETTING_DEFAULTS[props.settingKey] === 'true');

const { local, loading, message, success, save } = useBooleanSettingControl({
  key: props.settingKey,
  defaultValue: schemaDefault.value,
  nativeBoolean: props.nativeBoolean,
  successMessage: () =>
    t(props.successKey ?? `settings.workspace.${props.settingKey}Success`, props.titleFallback ?? '已保存'),
  errorMessage: () =>
    t(props.errorKey ?? `settings.workspace.${props.settingKey}Error`, '保存失败'),
});
</script>
