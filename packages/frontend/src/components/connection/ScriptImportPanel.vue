<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  parseScriptText,
  type ParsedScriptConnection,
  type ParsedScriptRow,
} from '../../utils/scriptConnectionParser';
// 统一的复制封装：局域网 HTTP（非安全上下文）下 navigator.clipboard 不可用，内部有 textarea 降级
import { copyToClipboard } from '../../utils/clipboard';

/**
 * 脚本批量导入面板（桌面 / 移动共用）。
 *
 * 只负责「输入 + 实时预检 + 语法说明」，真正的提交在 useAddConnectionForm 里。
 * 边输边解析：能导多少台、哪一行有错，当场就能看见，不用等点了「确认添加」才知道。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    compact?: boolean;
  }>(),
  { compact: false }
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const { t, te } = useI18n();

const showSyntax = ref(false);

const text = computed({
  get: () => props.modelValue,
  set: (v: string) => emit('update:modelValue', v),
});

const parsed = computed(() => parseScriptText(props.modelValue || ''));

const errorRows = computed(() => parsed.value.rows.filter((r) => !!r.errorCode));

const previewLimit = computed(() => (props.compact ? 3 : 5));

/** 预览用的扁平列表：一条连接一行，带上它来自第几行脚本 */
const previewItems = computed(() => {
  const out: Array<{ key: string; row: ParsedScriptRow; item: ParsedScriptConnection; ordinal: number }> = [];
  for (const row of parsed.value.rows) {
    row.items.forEach((item, idx) => {
      out.push({ key: `${row.lineIndex}-${idx}`, row, item, ordinal: idx });
    });
  }
  return out;
});

const shownPreview = computed(() => previewItems.value.slice(0, previewLimit.value));
const hiddenPreviewCount = computed(() => Math.max(0, previewItems.value.length - previewLimit.value));

function errorText(row: ParsedScriptRow): string {
  const key = `connections.script.err.${row.errorCode}`;
  if (row.errorCode && te(key)) {
    return t(key, row.errorParams ?? {});
  }
  return row.error || '';
}

const methodLabel = (item: ParsedScriptConnection) => {
  if (item.type !== 'SSH') return t('connections.script.authPasswordShort', '密码');
  if (item.keyName) return `${t('connections.script.authKeyShort', '密钥')} · ${item.keyName}`;
  return t('connections.script.authPasswordShort', '密码');
};

const protocolLabel = (p?: string) => (p && p !== 'auto' ? p.toUpperCase() : '');

const sampleText = computed(() => t('connections.script.sample', ''));

const insertSample = () => {
  text.value = sampleText.value || '';
};

const clearText = () => {
  text.value = '';
};

/**
 * 「常见写法」里那几行的纯文本版本。
 *
 * ⚠️ 必须和模板里渲染的逐字一致，但不能带上「（IP 范围会展开成多台）」这类提示 ——
 * 复制出去是要直接粘进脚本框解析的，多一个中文括号整行就废了。
 */
const syntaxSampleText = computed(() =>
  [
    'user@host:port -p 密码',
    'ssh -p 2222 -i 密钥名 user@host',
    'ssh://user:密码@host:22',
    'host:port:user:密码',
    '10.0.0.10~12',
  ].join('\n')
);

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

const copySyntaxSample = async () => {
  const done = await copyToClipboard(syntaxSampleText.value);
  if (!done) return;
  copied.value = true;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = false;
    copiedTimer = null;
  }, 1600);
};

onUnmounted(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});

const syntaxFlags = computed(() => [
  { flag: '-p / -k', desc: t('connections.script.flagCredential', '密码 / SSH 密钥名') },
  { flag: '-name', desc: t('connections.script.flagName', '显示名称') },
  { flag: '-folder', desc: t('connections.script.flagFolder', '所属文件夹（不存在会自动建）') },
  { flag: '-note', desc: t('connections.script.flagNote', '备注，可含空格（加引号）') },
  { flag: '-type', desc: t('connections.script.flagType', 'SSH / RDP / VNC') },
  { flag: '-port', desc: t('connections.script.flagPort', '端口，也可直接写 host:端口') },
  { flag: '-protocol', desc: t('connections.script.flagProtocol', '文件传输协议 auto / sftp / scp') },
  { flag: '-jump', desc: t('connections.script.flagJump', '跳板机链，按主机名，逗号分隔') },
  { flag: '-color', desc: t('connections.script.flagColor', '卡片底色，如 #3b82f6') },
  { flag: '-proxy', desc: t('connections.script.flagProxy', '网络代理，按代理名') },
]);

const inputClass = computed(() =>
  props.compact
    ? 'w-full p-3 border border-border/60 rounded-xl bg-input text-foreground text-xs font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary resize-y'
    : 'w-full px-3 py-2.5 border border-border/60 rounded-xl font-mono text-xs leading-relaxed shadow-2xs text-foreground bg-input focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary resize-y'
);
</script>

<template>
  <!-- select-text：外层模态框整块加了 select-none（防误选），这里要把脚本区域解放出来 -->
  <div class="space-y-2.5 select-text">
    <!-- 工具栏：实时统计 + 示例 / 清空 -->
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <div class="flex items-center gap-1.5 flex-wrap text-[11px]">
        <span
          class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border"
          :class="parsed.validConnections.length > 0
            ? 'text-success border-success/30 bg-success/10'
            : 'text-text-secondary border-border/60 bg-muted/20'"
        >
          <i class="fas fa-plug text-[10px]"></i>
          {{ t('connections.script.statConnections', { count: parsed.validConnections.length }) }}
        </span>
        <span v-if="errorRows.length" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-error/30 bg-error/10 text-error">
          <i class="fas fa-triangle-exclamation text-[10px]"></i>
          {{ t('connections.script.statErrors', { count: errorRows.length }) }}
        </span>
        <span v-if="parsed.skippedLines" class="text-text-secondary/70">
          {{ t('connections.script.statSkipped', { count: parsed.skippedLines }) }}
        </span>
      </div>

      <div class="flex items-center gap-1">
        <button
          type="button"
          class="text-[11px] font-medium text-primary hover:text-primary-hover px-1.5 py-0.5 rounded-md hover:bg-primary/10 transition-colors cursor-pointer"
          @click="insertSample"
        >
          <i class="fas fa-wand-magic-sparkles text-[10px] mr-1"></i>{{ t('connections.script.insertSample', '插入示例') }}
        </button>
        <button
          v-if="modelValue"
          type="button"
          class="text-[11px] text-text-secondary hover:text-foreground px-1.5 py-0.5 rounded-md hover:bg-muted/40 transition-colors cursor-pointer"
          @click="clearText"
        >
          {{ t('connections.script.clear', '清空') }}
        </button>
      </div>
    </div>

    <textarea
      id="conn-script-input"
      v-model="text"
      :rows="compact ? 6 : 9"
      wrap="off"
      spellcheck="false"
      :class="inputClass"
      :placeholder="t('connections.script.placeholder', '一行一个主机，例如：root@10.0.0.5 -p 密码 -folder 生产')"
    ></textarea>

    <!-- 错误行：当场指出第几行、错在哪 -->
    <div v-if="errorRows.length" class="rounded-xl border border-error/25 bg-error/5 p-2 space-y-1">
      <div
        v-for="row in errorRows.slice(0, compact ? 3 : 5)"
        :key="row.lineIndex"
        class="flex items-start gap-1.5 text-[11px] leading-relaxed"
      >
        <span class="shrink-0 font-mono text-error/80">{{ t('connections.script.lineLabel', { line: row.lineIndex }) }}</span>
        <span class="text-error min-w-0 break-words">{{ errorText(row) }}</span>
      </div>
      <div v-if="errorRows.length > (compact ? 3 : 5)" class="text-[11px] text-error/70">
        {{ t('connections.script.moreErrors', { count: errorRows.length - (compact ? 3 : 5) }) }}
      </div>
    </div>

    <!-- 预览：确认无误再提交 -->
    <div v-if="shownPreview.length" class="rounded-xl border border-border/50 overflow-hidden">
      <div
        v-for="row in shownPreview"
        :key="row.key"
        class="flex items-center gap-2 px-2.5 py-1.5 text-[11px] border-b border-border/30 last:border-b-0"
      >
        <i
          :class="[
            'fas shrink-0 text-[10px]',
            row.item.type === 'SSH' ? 'fa-terminal text-emerald-400'
              : row.item.type === 'RDP' ? 'fa-desktop text-blue-400'
              : 'fa-eye text-purple-400',
          ]"
        ></i>
        <span class="font-medium text-foreground truncate min-w-0">{{ row.item.name }}</span>
        <span class="font-mono text-text-secondary shrink-0">{{ row.item.host }}:{{ row.item.port }}</span>
        <span class="ml-auto flex items-center gap-1 shrink-0">
          <span v-if="row.item.folders?.length" class="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500">
            <i class="fas fa-folder text-[9px] mr-0.5"></i>{{ row.item.folders[0] }}
          </span>
          <span v-if="protocolLabel(row.item.fileProtocol)" class="px-1.5 py-0.5 rounded bg-muted/40 text-text-secondary uppercase">
            {{ protocolLabel(row.item.fileProtocol) }}
          </span>
          <span class="px-1.5 py-0.5 rounded bg-primary/10 text-primary">{{ methodLabel(row.item) }}</span>
        </span>
      </div>
      <div v-if="hiddenPreviewCount" class="px-2.5 py-1.5 text-[11px] text-text-secondary bg-muted/20">
        {{ t('connections.script.morePreview', { count: hiddenPreviewCount }) }}
      </div>
    </div>

    <!-- 语法说明：默认收起，不占地方 -->
    <div>
      <button
        type="button"
        class="flex items-center gap-1 text-[11px] text-text-secondary hover:text-foreground transition-colors cursor-pointer"
        @click="showSyntax = !showSyntax"
      >
        <i :class="['fas text-[9px] transition-transform', showSyntax ? 'fa-chevron-down' : 'fa-chevron-right']"></i>
        <span>{{ t('connections.script.syntaxTitle', '支持的写法与参数') }}</span>
      </button>
      <div v-if="showSyntax" class="mt-1.5 rounded-xl border border-border/50 bg-muted/20 p-2.5 space-y-2">
        <div class="space-y-1">
          <div class="flex items-center justify-between gap-2">
            <div class="text-[11px] font-medium text-foreground">{{ t('connections.script.syntaxFormats', '常见写法') }}</div>
            <button
              type="button"
              class="text-[11px] text-primary hover:text-primary-hover px-1.5 py-0.5 rounded-md hover:bg-primary/10 transition-colors cursor-pointer shrink-0"
              @click="copySyntaxSample"
            >
              <i :class="['fas text-[10px] mr-1', copied ? 'fa-check' : 'fa-copy']"></i>
              {{ copied ? t('connections.script.copied', '已复制') : t('connections.script.copySample', '复制') }}
            </button>
          </div>
          <div class="text-[11px] font-mono text-text-secondary leading-relaxed break-all select-text">
            user@host:port -p 密码<br />
            ssh -p 2222 -i 密钥名 user@host<br />
            ssh://user:密码@host:22<br />
            host:port:user:密码<br />
            <span class="text-amber-500">10.0.0.10~12</span> {{ t('connections.script.syntaxRangeHint', '（IP 范围会展开成多台）') }}
          </div>
        </div>
        <div class="space-y-1">
          <div class="text-[11px] font-medium text-foreground">{{ t('connections.script.syntaxFlags', '可用参数') }}</div>
          <div class="grid gap-1" :class="compact ? 'grid-cols-1' : 'grid-cols-2'">
            <div v-for="f in syntaxFlags" :key="f.flag" class="flex items-baseline gap-1.5 text-[11px]">
              <code class="font-mono text-primary shrink-0">{{ f.flag }}</code>
              <span class="text-text-secondary min-w-0">{{ f.desc }}</span>
            </div>
          </div>
        </div>
        <div class="text-[11px] text-text-secondary/70">
          {{ t('connections.script.syntaxCommentHint', '# 或 // 开头的行会被跳过；密码里有空格时用引号包起来') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* style.css 里 `i, .fas, .far, .fab { color: var(--icon-color) }` 是未分层规则，会盖掉继承色 */
i {
  color: inherit;
}
</style>
