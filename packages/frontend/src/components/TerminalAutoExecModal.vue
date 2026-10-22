<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LayoutNode, TerminalAutoExecConfig } from '../stores/layout.store';
import { useConnectionsStore, type ConnectionInfo } from '../stores/connections.store';
import AppSelect from './common/AppSelect.vue';

const props = defineProps<{
  visible: boolean;
  node: LayoutNode | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save', config: TerminalAutoExecConfig): void;
}>();

const { t } = useI18n();
const connectionsStore = useConnectionsStore();

const defaultCommand = ref('');
const connectionCommandsMap = ref<Record<string, string>>({});

// 当前待添加的连接专属规则表单
const selectedConnId = ref<string>('');
const newConnCommand = ref<string>('');

// 同步初始数据
watch(
  () => props.visible,
  (val) => {
    if (val && props.node) {
      const autoExec = props.node.terminalAutoExec;
      defaultCommand.value = autoExec?.defaultCommand || '';
      connectionCommandsMap.value = { ...(autoExec?.connectionCommands || {}) };
      selectedConnId.value = '';
      newConnCommand.value = '';
    }
  },
  { immediate: true }
);

// 获取尚未配置特定规则的连接列表
const availableConnections = computed(() => {
  return connectionsStore.connections.filter(c => {
    return !connectionCommandsMap.value[String(c.id)];
  });
});

// 添加特定连接规则
const handleAddConnectionRule = () => {
  if (!selectedConnId.value || !newConnCommand.value.trim()) return;
  connectionCommandsMap.value[selectedConnId.value] = newConnCommand.value.trim();
  selectedConnId.value = '';
  newConnCommand.value = '';
};

// 移除特定连接规则
const handleRemoveConnectionRule = (connIdStr: string) => {
  const updated = { ...connectionCommandsMap.value };
  delete updated[connIdStr];
  connectionCommandsMap.value = updated;
};

// 获取连接名称辅助函数
const getConnectionLabel = (connIdStr: string): string => {
  const conn = connectionsStore.connections.find(c => String(c.id) === connIdStr);
  if (!conn) return `ID: ${connIdStr}`;
  return `${conn.name || conn.host}${conn.port ? `:${conn.port}` : ''}`;
};

// 保存
const handleSave = () => {
  const config: TerminalAutoExecConfig = {};
  if (defaultCommand.value.trim()) {
    config.defaultCommand = defaultCommand.value.trim();
  }
  const cleanConnCmds: Record<string, string> = {};
  for (const [k, v] of Object.entries(connectionCommandsMap.value)) {
    if (v && v.trim()) {
      cleanConnCmds[k] = v.trim();
    }
  }
  if (Object.keys(cleanConnCmds).length > 0) {
    config.connectionCommands = cleanConnCmds;
  }
  emit('save', config);
  emit('close');
};
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs select-none"
      @click.self="emit('close')"
      @mousedown.stop
      @mouseup.stop
      @pointerdown.stop
    >
      <div
        class="w-full max-w-lg bg-[#14161f] border border-border/80 rounded-xl shadow-2xl flex flex-col overflow-hidden text-foreground animate-in fade-in zoom-in-95 duration-150"
        @click.stop
        @mousedown.stop
        @mouseup.stop
        @pointerdown.stop
      >
        <!-- 弹窗标题 -->
        <div class="flex items-center justify-between px-5 py-3.5 border-b border-border/60 bg-header/70">
        <div class="flex items-center gap-2.5">
          <div class="w-6 h-6 rounded-md bg-purple-500/20 text-purple-400 border border-purple-500/30 flex items-center justify-center text-xs">
            <i class="fas fa-bolt"></i>
          </div>
          <div>
            <h3 class="text-sm font-semibold text-foreground">
              {{ t('layoutNodeEditor.autoExecTitle', '终端组件连接自启指令配置') }}
            </h3>
            <p class="text-[11px] text-text-secondary/70">
              {{ t('layoutNodeEditor.autoExecSubtitle', 'SSH 连接就绪后自动执行指令，可针对特定连接单独定制') }}
            </p>
          </div>
        </div>
        <button
          type="button"
          @click="emit('close')"
          class="text-text-secondary hover:text-foreground text-lg transition-colors p-1"
        >
          &times;
        </button>
      </div>

      <!-- 弹窗内容区 -->
      <div class="p-5 flex flex-col gap-4 overflow-y-auto max-h-[70vh]">
        <!-- 1. 全局默认指令 -->
        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-medium text-foreground flex items-center justify-between">
            <span>{{ t('layoutNodeEditor.defaultCommandLabel', '全局默认自启指令') }}</span>
            <span class="text-[10px] text-text-secondary/60">未单独指定的连接将自动回退执行此命令</span>
          </label>
          <input
            v-model="defaultCommand"
            type="text"
            placeholder="例如：htop 或 cd /var/log && tail -f access.log (可留空)"
            class="w-full px-3 py-2 text-xs rounded-lg border border-border bg-[#0d0f15] text-foreground font-mono focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-colors"
          />
        </div>

        <!-- 分割线 -->
        <div class="border-t border-border/40 my-0.5"></div>

        <!-- 2. 分连接特定定制指令 -->
        <div class="flex flex-col gap-2.5">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-foreground">
              {{ t('layoutNodeEditor.customRulesLabel', '特定连接专属指令 (高优先级)') }}
            </span>
            <span class="text-[10px] text-text-secondary/60">
              已定制 {{ Object.keys(connectionCommandsMap).length }} 个连接
            </span>
          </div>

          <!-- 添加新规则表单 -->
          <div class="flex flex-col gap-2 p-2.5 rounded-lg border border-border/60 bg-[#10121a]">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <AppSelect
                v-model="selectedConnId"
                class="h-8 px-2.5 text-xs rounded-md border border-border bg-[#0d0f15] text-foreground focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:border-purple-500 transition-all cursor-pointer"
              >
                <option value="" disabled selected>选择目标连接...</option>
                <option v-for="conn in availableConnections" :key="conn.id" :value="String(conn.id)">
                  {{ conn.name || conn.host }} ({{ conn.host }}{{ conn.port ? `:${conn.port}` : '' }})
                </option>
              </AppSelect>

              <input
                v-model="newConnCommand"
                type="text"
                placeholder="该连接专属执行指令..."
                class="px-2.5 py-1.5 text-xs rounded-md border border-border bg-[#0d0f15] text-foreground font-mono focus:border-purple-500"
                @keyup.enter="handleAddConnectionRule"
              />
            </div>

            <div class="flex justify-end">
              <button
                type="button"
                @click="handleAddConnectionRule"
                :disabled="!selectedConnId || !newConnCommand.trim()"
                class="px-3 py-1 text-xs rounded-md bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:pointer-events-none text-white font-medium transition-colors flex items-center gap-1.5"
              >
                <i class="fas fa-plus text-[10px]"></i>
                <span>{{ t('common.add', '添加专属规则') }}</span>
              </button>
            </div>
          </div>

          <!-- 已有专属规则列表 -->
          <div v-if="Object.keys(connectionCommandsMap).length > 0" class="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
            <div
              v-for="(cmd, connIdStr) in connectionCommandsMap"
              :key="connIdStr"
              class="flex items-center justify-between px-3 py-2 rounded-lg border border-purple-500/20 bg-purple-500/5 text-xs"
            >
              <div class="flex items-center gap-2 min-w-0 flex-grow pr-2">
                <span class="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 font-medium text-[11px] whitespace-nowrap">
                  {{ getConnectionLabel(connIdStr) }}
                </span>
                <span class="text-text-secondary/40 text-[10px]">➜</span>
                <span class="font-mono text-purple-200 truncate text-[11px]" :title="cmd">
                  {{ cmd }}
                </span>
              </div>
              <button
                type="button"
                @click="handleRemoveConnectionRule(connIdStr)"
                class="w-5 h-5 flex items-center justify-center rounded text-text-secondary/60 hover:text-red-400 hover:bg-red-500/15 transition-colors cursor-pointer"
                title="删除专属规则"
              >
                <i class="fas fa-xmark text-[11px]"></i>
              </button>
            </div>
          </div>
          <div v-else class="text-center py-2 text-[11px] text-text-secondary/50 border border-dashed border-border/40 rounded-lg">
            暂无特定连接定制，当前将应用默认指令（若有配置）或直接进入 Shell
          </div>
        </div>
      </div>

      <!-- 底部操作按钮 -->
      <div class="flex items-center justify-end gap-2.5 px-5 py-3 border-t border-border/60 bg-header/40">
        <button
          type="button"
          @click="emit('close')"
          class="px-3.5 py-1.5 text-xs rounded-lg border border-border hover:bg-hover text-text-secondary hover:text-foreground transition-colors"
        >
          {{ t('common.cancel', '取消') }}
        </button>
        <button
          type="button"
          @click="handleSave"
          class="px-4 py-1.5 text-xs rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-medium transition-colors shadow-sm"
        >
          {{ t('common.save', '保存配置') }}
        </button>
      </div>
    </div>
  </div>
  </Teleport>
</template>
