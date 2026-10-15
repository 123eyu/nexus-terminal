<script setup lang="ts">
import { ref, computed, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import draggable from 'vuedraggable';
import { useLayoutStore, type LayoutNode, type PaneName, type TerminalAutoExecConfig } from '../stores/layout.store';
import TerminalAutoExecModal from './TerminalAutoExecModal.vue';

// --- Props ---
const props = defineProps({
  node: {
    type: Object as PropType<LayoutNode>,
    required: true,
  },
  parentNode: {
    type: Object as PropType<LayoutNode | null>,
    default: null,
  },
  nodeIndex: {
    type: Number,
    default: -1,
  },
  paneLabels: {
    type: Object as PropType<Record<PaneName, string>>,
    required: true,
  },
});

// --- Emits ---
const emit = defineEmits(['update:node', 'removeNode']);

// --- Setup ---
const { t } = useI18n();
const layoutStore = useLayoutStore();
const showAutoExecModal = ref(false);

const hasAutoExecConfig = computed(() => {
  if (props.node.component !== 'terminal' || !props.node.terminalAutoExec) return false;
  const cfg = props.node.terminalAutoExec;
  return Boolean((cfg.defaultCommand && cfg.defaultCommand.trim()) || (cfg.connectionCommands && Object.keys(cfg.connectionCommands).length > 0));
});

const handleSaveAutoExec = (config: TerminalAutoExecConfig) => {
  emit('update:node', { ...props.node, terminalAutoExec: config });
};

// 各面板专属图标与主题色映射
const paneMetaMap: Record<string, { icon: string; iconColor: string; bgSoft: string; borderSoft: string }> = {
  terminal: {
    icon: 'fas fa-terminal',
    iconColor: 'text-emerald-400',
    bgSoft: 'bg-emerald-500/15',
    borderSoft: 'border-emerald-500/30',
  },
  fileManager: {
    icon: 'fas fa-folder-tree',
    iconColor: 'text-amber-400',
    bgSoft: 'bg-amber-500/15',
    borderSoft: 'border-amber-500/30',
  },
  editor: {
    icon: 'fas fa-code',
    iconColor: 'text-sky-400',
    bgSoft: 'bg-sky-500/15',
    borderSoft: 'border-sky-500/30',
  },
  statusMonitor: {
    icon: 'fas fa-gauge-high',
    iconColor: 'text-indigo-400',
    bgSoft: 'bg-indigo-500/15',
    borderSoft: 'border-indigo-500/30',
  },
  commandHistory: {
    icon: 'fas fa-clock-rotate-left',
    iconColor: 'text-purple-400',
    bgSoft: 'bg-purple-500/15',
    borderSoft: 'border-purple-500/30',
  },
  quickCommands: {
    icon: 'fas fa-bolt',
    iconColor: 'text-yellow-400',
    bgSoft: 'bg-yellow-500/15',
    borderSoft: 'border-yellow-500/30',
  },
  dockerManager: {
    icon: 'fab fa-docker',
    iconColor: 'text-cyan-400',
    bgSoft: 'bg-cyan-500/15',
    borderSoft: 'border-cyan-500/30',
  },
  connections: {
    icon: 'fas fa-network-wired',
    iconColor: 'text-blue-400',
    bgSoft: 'bg-blue-500/15',
    borderSoft: 'border-blue-500/30',
  },
  commandBar: {
    icon: 'fas fa-chevron-right',
    iconColor: 'text-teal-400',
    bgSoft: 'bg-teal-500/15',
    borderSoft: 'border-teal-500/30',
  },
  suspendedSshSessions: {
    icon: 'fas fa-circle-pause',
    iconColor: 'text-rose-400',
    bgSoft: 'bg-rose-500/15',
    borderSoft: 'border-rose-500/30',
  },
  multiLineCommandInput: {
    icon: 'fas fa-bars-staggered',
    iconColor: 'text-violet-400',
    bgSoft: 'bg-violet-500/15',
    borderSoft: 'border-violet-500/30',
  },
};

const getPaneMeta = (componentName?: string) => {
  if (!componentName || !paneMetaMap[componentName]) {
    return {
      icon: 'fas fa-table-cells-large',
      iconColor: 'text-slate-400',
      bgSoft: 'bg-slate-500/15',
      borderSoft: 'border-slate-500/30',
    };
  }
  return paneMetaMap[componentName];
};

const childrenList = computed({
  get: () => props.node.children || [],
  set: (_newChildren) => {
    console.log('[LayoutNodeEditor] childrenList setter called');
  }
});

const addHorizontalContainer = () => {
  const newNode: LayoutNode = {
    id: layoutStore.generateId(),
    type: 'container',
    direction: 'horizontal',
    children: [],
    size: 50,
  };
  const updatedChildren = [...(props.node.children || []), newNode];
  emit('update:node', { ...props.node, children: updatedChildren });
};

const addVerticalContainer = () => {
  const newNode: LayoutNode = {
    id: layoutStore.generateId(),
    type: 'container',
    direction: 'vertical',
    children: [],
    size: 50,
  };
  const updatedChildren = [...(props.node.children || []), newNode];
  emit('update:node', { ...props.node, children: updatedChildren });
};

const removeSelf = () => {
  emit('removeNode', { parentNodeId: props.parentNode?.id, nodeIndex: props.nodeIndex });
};

const toggleDirection = () => {
  if (props.node.type === 'container') {
    const newDirection = props.node.direction === 'horizontal' ? 'vertical' : 'horizontal';
    emit('update:node', { ...props.node, direction: newDirection });
  }
};

const handleChildUpdate = (updatedChildNode: LayoutNode, index: number) => {
  if (props.node.children) {
    const newChildren = [...props.node.children];
    newChildren[index] = updatedChildNode;
    emit('update:node', { ...props.node, children: newChildren });
  }
};

const handleChildRemove = (payload: { parentNodeId: string | undefined; nodeIndex: number }) => {
  emit('removeNode', payload);
};

// 计算子节点在 flex 容器中占用的 style 比例
const getChildFlexStyle = (child: LayoutNode) => {
  const sizeVal = typeof child.size === 'number' && child.size > 0 ? child.size : 50;
  return {
    flex: `${sizeVal} ${sizeVal} 0%`,
  };
};
</script>

<template>
  <div
    class="layout-node-editor-root flex flex-col flex-grow min-w-0 min-h-0 w-full h-full select-none"
    :data-node-id="node.id"
  >
    <!-- 1. 容器节点类型 (Container Node) -->
    <div
      v-if="node.type === 'container'"
      class="flex flex-col flex-grow w-full h-full min-h-0 rounded-lg border border-border/80 bg-[#12141a] transition-all overflow-hidden shadow-xs hover:border-primary/40"
    >
      <!-- 容器微型控制条 (保留“水平”与“垂直”完整文本) -->
      <div class="flex items-center justify-between px-2 py-0.5 bg-header/90 border-b border-border/50 text-[10px] gap-1 flex-shrink-0">
        <div class="flex items-center gap-1 min-w-0">
          <span
            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono font-medium text-[9px] whitespace-nowrap flex-shrink-0"
            :class="node.direction === 'horizontal' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/25' : 'bg-indigo-500/15 text-indigo-400 border border-indigo-500/25'"
          >
            <i :class="node.direction === 'horizontal' ? 'fas fa-arrows-left-right text-[8px]' : 'fas fa-arrows-up-down text-[8px]'"></i>
            <span>{{ node.direction === 'horizontal' ? '水平' : '垂直' }}</span>
          </span>
          <span v-if="node.size && Math.round(node.size) !== 100" class="text-[9px] text-text-secondary/50 font-mono">
            {{ Math.round(node.size) }}%
          </span>
        </div>

        <!-- 极简图标按钮组 -->
        <div class="flex items-center gap-0.5 flex-shrink-0">
          <button
            type="button"
            @click.stop="toggleDirection"
            :title="t('layoutNodeEditor.toggleDirection', '切换方向')"
            class="w-4 h-4 flex items-center justify-center rounded hover:bg-hover text-text-secondary hover:text-foreground transition-colors"
          >
            <i class="fas fa-arrows-rotate text-[8px]"></i>
          </button>
          <button
            type="button"
            @click.stop="addHorizontalContainer"
            :title="t('layoutNodeEditor.addHorizontalContainer', '新增水平分栏')"
            class="w-4 h-4 flex items-center justify-center rounded hover:bg-hover text-text-secondary hover:text-foreground transition-colors"
          >
            <i class="fas fa-table-columns text-[8px]"></i>
          </button>
          <button
            type="button"
            @click.stop="addVerticalContainer"
            :title="t('layoutNodeEditor.addVerticalContainer', '新增垂直分栏')"
            class="w-4 h-4 flex items-center justify-center rounded hover:bg-hover text-text-secondary hover:text-foreground transition-colors"
          >
            <i class="fas fa-bars text-[8px]"></i>
          </button>
          <button
            v-if="parentNode"
            type="button"
            @click.stop="removeSelf"
            :title="t('layoutNodeEditor.removeNode', '删除分栏')"
            class="w-4 h-4 flex items-center justify-center rounded hover:bg-red-500/15 text-text-secondary hover:text-red-400 transition-colors"
          >
            <i class="fas fa-trash-can text-[8px]"></i>
          </button>
        </div>
      </div>

      <!-- 子节点区域：精准 direction、draggable 过滤器、fallbackOnBody，确保内层容器优先判定 -->
      <draggable
        :list="childrenList"
        @update:list="childrenList = $event"
        tag="div"
        class="flex-grow p-1.5 overflow-hidden flex gap-1.5 min-h-[44px] w-full h-full relative"
        :class="node.direction === 'horizontal' ? 'flex-row' : 'flex-col'"
        item-key="id"
        :group="{ name: 'layout-items', pull: true, put: true }"
        :direction="node.direction"
        :sort="true"
        draggable=".child-node-card-wrapper"
        :empty-insert-threshold="25"
        :invert-swap="true"
        :swap-threshold="0.65"
        :fallback-on-body="true"
        :animation="150"
      >
        <template #item="{ element: childNode, index }">
          <div
            class="child-node-card-wrapper relative flex min-w-0 min-h-0 overflow-hidden cursor-grab active:cursor-grabbing"
            :class="node.direction === 'horizontal' ? 'h-full' : 'w-full'"
            :style="getChildFlexStyle(childNode)"
            :key="childNode.id"
          >
            <LayoutNodeEditor
              :node="childNode"
              :parent-node="node"
              :node-index="index"
              :paneLabels="props.paneLabels"
              @update:node="handleChildUpdate($event, index)"
              @removeNode="handleChildRemove"
              class="w-full h-full pointer-events-auto"
            />
          </div>
        </template>

        <!-- 容器为空时的明确感应落入区域 -->
        <template #footer>
          <div
            v-if="!childrenList || childrenList.length === 0"
            class="flex-grow min-h-[40px] rounded-md border border-dashed border-primary/40 bg-primary/5 hover:bg-primary/10 transition-colors flex items-center justify-center p-2 text-center text-primary/70 gap-1.5 text-[11px] font-medium"
          >
            <i class="fas fa-arrow-down text-[10px]"></i>
            <span>放入此容器</span>
          </div>
        </template>
      </draggable>
    </div>

    <!-- 2. 面板叶子节点类型 (整卡片可直接拖拽抓取) -->
    <div
      v-else
      class="solid-pane-tile flex flex-col flex-grow w-full h-full min-h-0 rounded-md border border-border/75 bg-[#171a22] hover:border-primary/60 transition-all shadow-xs overflow-hidden group/pane cursor-grab active:cursor-grabbing"
      :title="'按住可拖拽调整至其他容器或侧栏'"
    >
      <!-- 极简窗口小标题栏 (高 22px) -->
      <div class="flex items-center justify-between px-2 py-0.5 bg-header/80 border-b border-border/50 text-[10px] flex-shrink-0">
        <div class="flex items-center gap-1.5 min-w-0">
          <!-- 专属图标徽章 -->
          <div
            class="w-4 h-4 rounded flex items-center justify-center text-[9px] flex-shrink-0 border"
            :class="[getPaneMeta(node.component).bgSoft, getPaneMeta(node.component).borderSoft, getPaneMeta(node.component).iconColor]"
          >
            <i :class="getPaneMeta(node.component).icon"></i>
          </div>

          <!-- 面板名称 -->
          <span class="font-medium text-foreground truncate text-[10px] leading-none">
            {{ props.paneLabels[node.component!] || node.component }}
          </span>
        </div>

        <div class="flex items-center gap-1 flex-shrink-0">
          <!-- 终端连接自启指令配置按钮 (闪电图标) -->
          <button
            v-if="node.component === 'terminal'"
            type="button"
            @click.stop="showAutoExecModal = true"
            :title="t('layoutNodeEditor.configAutoExec', '配置 SSH 连接自启指令')"
            class="w-4 h-4 flex items-center justify-center rounded transition-colors cursor-pointer pointer-events-auto"
            :class="hasAutoExecConfig ? 'text-purple-400 bg-purple-500/20' : 'text-text-secondary/60 hover:text-purple-400 hover:bg-purple-500/15'"
          >
            <i class="fas fa-bolt text-[9px]"></i>
          </button>

          <!-- 尺寸占比 -->
          <span v-if="node.size && Math.round(node.size) !== 100" class="text-[8px] text-text-secondary/50 font-mono">
            {{ Math.round(node.size) }}%
          </span>

          <!-- 移除按钮 (点击停止冒泡) -->
          <button
            type="button"
            @click.stop="removeSelf"
            :title="t('layoutNodeEditor.removeNode', '从布局中移除')"
            class="w-4 h-4 flex items-center justify-center rounded text-text-secondary/40 hover:text-red-400 hover:bg-red-500/15 transition-colors opacity-0 group-hover/pane:opacity-100 cursor-pointer pointer-events-auto"
          >
            <i class="fas fa-xmark text-[9px]"></i>
          </button>
        </div>
      </div>

      <!-- 拟真微缩内容区 (鼠标事件穿透，确保点击卡片任意区域均可直接拖拽) -->
      <div class="flex-grow p-1.5 flex flex-col justify-center items-center overflow-hidden min-h-0 bg-[#13151b]/80 relative select-none pointer-events-none">
        
        <!-- 终端 (Terminal)：微缩控制台 -->
        <div v-if="node.component === 'terminal'" class="w-full h-full flex flex-col justify-start p-1.5 font-mono text-[9px] text-emerald-400/80 gap-1 overflow-hidden">
          <div class="flex items-center gap-1 opacity-60 pb-1 border-b border-white/5">
            <span class="w-1.5 h-1.5 rounded-full bg-red-500/80"></span>
            <span class="w-1.5 h-1.5 rounded-full bg-yellow-500/80"></span>
            <span class="w-1.5 h-1.5 rounded-full bg-green-500/80"></span>
            <span class="text-[8px] text-text-secondary/60 ml-1">bash</span>
          </div>
          <div class="flex items-center gap-1 leading-tight text-text-secondary/70">
            <span class="text-emerald-400">root@nexus:</span><span>~#</span>
            <span class="w-1.5 h-3 bg-emerald-400/80 animate-pulse inline-block"></span>
          </div>
        </div>

        <!-- 命令栏 (CommandBar)：超细单行输入框 -->
        <div v-else-if="node.component === 'commandBar'" class="w-full h-full flex items-center px-1.5 py-0.5 font-mono text-[9px] text-text-secondary/70 gap-1 bg-black/20 rounded">
          <i class="fas fa-terminal text-[8px] text-teal-400"></i>
          <span class="truncate">命令输入...</span>
        </div>

        <!-- 文件管理 (FileManager)：微型目录列表 -->
        <div v-else-if="node.component === 'fileManager'" class="w-full h-full flex flex-col justify-start p-1 gap-1 overflow-hidden text-[9px] text-text-secondary/70">
          <div class="flex items-center gap-1.5 opacity-80">
            <i class="fas fa-folder text-amber-400 text-[8px]"></i>
            <span class="truncate">/workspace</span>
          </div>
          <div class="flex items-center gap-1.5 opacity-60 pl-2">
            <i class="fas fa-file-lines text-sky-400 text-[8px]"></i>
            <span class="truncate">config.json</span>
          </div>
        </div>

        <!-- 状态监视器 (StatusMonitor)：微型系统仪表 -->
        <div v-else-if="node.component === 'statusMonitor'" class="w-full h-full flex flex-col justify-center p-1.5 gap-1.5 overflow-hidden">
          <div class="flex items-center justify-between text-[9px] text-text-secondary/80">
            <span class="flex items-center gap-1"><i class="fas fa-microchip text-indigo-400 text-[8px]"></i>CPU</span>
            <span class="font-mono text-indigo-300">28%</span>
          </div>
          <div class="w-full bg-white/5 h-1 rounded-full overflow-hidden">
            <div class="bg-indigo-500 h-full w-[28%] rounded-full"></div>
          </div>
          <div class="flex items-center justify-between text-[9px] text-text-secondary/80 mt-0.5">
            <span class="flex items-center gap-1"><i class="fas fa-memory text-purple-400 text-[8px]"></i>MEM</span>
            <span class="font-mono text-purple-300">45%</span>
          </div>
          <div class="w-full bg-white/5 h-1 rounded-full overflow-hidden">
            <div class="bg-purple-500 h-full w-[45%] rounded-full"></div>
          </div>
        </div>

        <!-- 默认其它组件：饱满卡片徽章与标题 -->
        <div v-else class="flex flex-col items-center justify-center gap-1 text-center p-1">
          <i :class="[getPaneMeta(node.component).icon, getPaneMeta(node.component).iconColor]" class="text-sm opacity-80"></i>
          <span class="text-[10px] text-text-secondary/70 truncate max-w-[80px]">
            {{ props.paneLabels[node.component!] || node.component }}
          </span>
        </div>

      </div>
    </div>
      <!-- 终端自启指令配置弹窗 -->
    <TerminalAutoExecModal
      v-if="node.component === 'terminal'"
      :visible="showAutoExecModal"
      :node="node"
      @close="showAutoExecModal = false"
      @save="handleSaveAutoExec"
    />
  </div>
</template>

<style scoped>
:deep(.sortable-ghost) {
  opacity: 0.75 !important;
  background-color: rgba(59, 130, 246, 0.2) !important;
  border: 1px dashed rgba(59, 130, 246, 0.9) !important;
  border-radius: 0.375rem !important;
}

:deep(.sortable-chosen) {
  opacity: 0.95;
}

:deep(.sortable-drag) {
  opacity: 0.98;
  box-shadow: 0 12px 28px -5px rgba(0, 0, 0, 0.6);
}
</style>
