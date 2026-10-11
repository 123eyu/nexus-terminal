<script setup lang="ts">
import { ref, computed, watch, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useLayoutStore, type LayoutNode, type PaneName } from '../stores/layout.store';
import { useSettingsStore } from '../stores/settings.store';
import { storeToRefs } from 'pinia';
import draggable from 'vuedraggable';
import LayoutNodeEditor from './LayoutNodeEditor.vue';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { useAlertDialog } from '../composables/useAlertDialog';

// --- Props ---
const props = defineProps({
  isVisible: {
    type: Boolean,
    required: true,
  },
});

// --- Emits ---
const emit = defineEmits(['close']);

// --- Setup ---
const { t } = useI18n();
const layoutStore = useLayoutStore();
const settingsStore = useSettingsStore();
const { layoutLockedBoolean } = storeToRefs(settingsStore);
const { showConfirmDialog } = useConfirmDialog();
const { showAlertDialog } = useAlertDialog();

// --- State ---
const localLayoutTree: Ref<LayoutNode | null> = ref(null);
const localSidebarPanes: Ref<{ left: PaneName[], right: PaneName[] }> = ref({ left: [], right: [] });
const localAvailablePanes: Ref<PaneName[]> = ref([]);

// State for original values to compare against
const originalLayoutTree: Ref<LayoutNode | null> = ref(null);
const originalSidebarPanes: Ref<{ left: PaneName[], right: PaneName[] }> = ref({ left: [], right: [] });

// --- Dialog State ---
const dialogRef = ref<HTMLElement | null>(null);

// 面板元信息：专属图标与主题色
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

// --- Watchers ---
watch(() => props.isVisible, (newValue) => {
  if (newValue) {
    const initialLayout = layoutStore.layoutTree ? JSON.parse(JSON.stringify(layoutStore.layoutTree)) : null;
    localLayoutTree.value = initialLayout;
    originalLayoutTree.value = JSON.parse(JSON.stringify(initialLayout));

    const initialSidebars = layoutStore.sidebarPanes ? JSON.parse(JSON.stringify(layoutStore.sidebarPanes)) : { left: [], right: [] };
    localSidebarPanes.value = initialSidebars;
    originalSidebarPanes.value = JSON.parse(JSON.stringify(initialSidebars));

    const initialUsed = getAllLocalUsedPaneNames(localLayoutTree.value, localSidebarPanes.value);
    if (initialUsed.has('terminal')) {
        localAvailablePanes.value = layoutStore.allPossiblePanes.filter(p => p !== 'terminal');
    } else {
        localAvailablePanes.value = [...layoutStore.allPossiblePanes];
    }
    localAvailablePanes.value.sort((a, b) =>
        layoutStore.allPossiblePanes.indexOf(a) - layoutStore.allPossiblePanes.indexOf(b)
    );
  } else {
    localLayoutTree.value = null;
    originalLayoutTree.value = null;
    localSidebarPanes.value = { left: [], right: [] };
    originalSidebarPanes.value = { left: [], right: [] };
    localAvailablePanes.value = [];
  }
});

// --- Helper Functions ---
function getMainLayoutUsedPaneNames(node: LayoutNode | null): Set<PaneName> {
  const usedNames = new Set<PaneName>();
  if (!node) return usedNames;
  function traverse(currentNode: LayoutNode) {
    if (currentNode.type === 'pane' && currentNode.component) {
      usedNames.add(currentNode.component);
    } else if (currentNode.type === 'container' && currentNode.children) {
      currentNode.children.forEach(traverse);
    }
  }
  traverse(node);
  return usedNames;
}

function getAllLocalUsedPaneNames(mainNode: LayoutNode | null, sidebars: { left: PaneName[], right: PaneName[] }): Set<PaneName> {
  const usedNames = getMainLayoutUsedPaneNames(mainNode);
  sidebars.left.forEach(pane => usedNames.add(pane));
  sidebars.right.forEach(pane => usedNames.add(pane));
  return usedNames;
}

function addPaneToAvailableList(paneName: PaneName) {
   if (paneName === 'terminal' && !localAvailablePanes.value.includes('terminal')) {
       const originalIndex = layoutStore.allPossiblePanes.indexOf('terminal');
       let inserted = false;
       for (let i = 0; i < localAvailablePanes.value.length; i++) {
           const currentAvailablePane = localAvailablePanes.value[i];
           const currentOriginalIndex = layoutStore.allPossiblePanes.indexOf(currentAvailablePane);
           if (originalIndex < currentOriginalIndex) {
               localAvailablePanes.value.splice(i, 0, 'terminal');
               inserted = true;
               break;
           }
       }
       if (!inserted) {
            localAvailablePanes.value.push('terminal');
       }
   }
}

function removePaneFromAvailableList(paneName: PaneName) {
    if (paneName === 'terminal') {
        const index = localAvailablePanes.value.indexOf('terminal');
        if (index > -1) {
            localAvailablePanes.value.splice(index, 1);
        }
    }
}

// --- Computed ---
const isModified = computed(() => {
  const currentLayoutJson = JSON.stringify(localLayoutTree.value);
  const originalLayoutJson = JSON.stringify(originalLayoutTree.value);
  const currentSidebarJson = JSON.stringify(localSidebarPanes.value);
  const originalSidebarJson = JSON.stringify(originalSidebarPanes.value);
  return currentLayoutJson !== originalLayoutJson || currentSidebarJson !== originalSidebarJson;
});

const paneLabels = computed(() => ({
  connections: t('layout.pane.connections', '连接列表'),
  terminal: t('layout.pane.terminal', '终端'),
  commandBar: t('layout.pane.commandBar', '命令栏'),
  fileManager: t('layout.pane.fileManager', '文件管理器'),
  editor: t('layout.pane.editor', '编辑器'),
  statusMonitor: t('layout.pane.statusMonitor', '状态监视器'),
  commandHistory: t('layout.pane.commandHistory', '命令历史'),
  quickCommands: t('layout.pane.quickCommands', '快捷指令'),
  dockerManager: t('layout.pane.dockerManager', 'Docker 管理器'),
  suspendedSshSessions: t('layout.pane.suspendedSshSessions', '挂起会话管理'),
  multiLineCommandInput: t('layout.pane.multiLineCommandInput', '多行命令输入'),
}));

// --- Methods ---
const handleLayoutLockChange = async () => {
  const isLocked = !layoutLockedBoolean.value;
  try {
    await settingsStore.updateSetting('layoutLocked', String(isLocked));
  } catch (error) {
    console.error('[LayoutConfigurator] Failed to update layout lock setting:', error);
  }
};

const closeDialog = async () => {
  if (isModified.value) {
    const confirmed = await showConfirmDialog({
      message: t('layoutConfigurator.confirmClose', '有未保存的更改，确定要关闭吗？')
    });
    if (confirmed) {
      emit('close');
    }
  } else {
    emit('close');
  }
};

const saveLayout = async () => {
  try {
    await layoutStore.updateLayoutTree(localLayoutTree.value);
    const sidebarConfigToSave = JSON.parse(JSON.stringify(localSidebarPanes.value));
    await layoutStore.updateSidebarPanes(sidebarConfigToSave);
    emit('close');
  } catch (error) {
    console.error('[LayoutConfigurator] Error saving layout:', error);
  }
};

const resetToDefault = async () => {
  const confirmed = await showConfirmDialog({
    message: t('layoutConfigurator.confirmReset', '确定要恢复默认布局和侧栏配置吗？当前更改将丢失。')
  });
  if (confirmed) {
    const defaultLayout = layoutStore.getSystemDefaultLayout();
    localLayoutTree.value = JSON.parse(JSON.stringify(defaultLayout));

    const defaultSidebarPanes = layoutStore.getSystemDefaultSidebarPanes();
    localSidebarPanes.value = JSON.parse(JSON.stringify(defaultSidebarPanes));

    const defaultUsed = getAllLocalUsedPaneNames(localLayoutTree.value, localSidebarPanes.value);
    if (defaultUsed.has('terminal')) {
        localAvailablePanes.value = layoutStore.allPossiblePanes.filter(p => p !== 'terminal');
    } else {
        localAvailablePanes.value = [...layoutStore.allPossiblePanes];
    }
    localAvailablePanes.value.sort((a, b) =>
        layoutStore.allPossiblePanes.indexOf(a) - layoutStore.allPossiblePanes.indexOf(b)
    );
  }
};

const clonePane = (paneName: PaneName): LayoutNode => {
  return {
    id: layoutStore.generateId(),
    type: 'pane',
    component: paneName,
    size: 50,
  };
};

const handleNodeUpdate = (updatedNode: LayoutNode) => {
  localLayoutTree.value = updatedNode;
};

function findAndRemoveNode(node: LayoutNode | null, parentNodeId: string | undefined, nodeIndex: number): LayoutNode | null {
    if (!node) return null;

    if (node.id === parentNodeId && node.type === 'container' && node.children && node.children[nodeIndex]) {
        const updatedChildren = [...node.children];
        const removedNode = updatedChildren.splice(nodeIndex, 1)[0];
        if (removedNode.type === 'pane' && removedNode.component === 'terminal') {
            addPaneToAvailableList('terminal');
        }
        return { ...node, children: updatedChildren };
    }

    if (node.type === 'container' && node.children) {
        const updatedChildren = node.children.map(child => findAndRemoveNode(child, parentNodeId, nodeIndex));
        if (updatedChildren.some((child, index) => child !== node.children![index])) {
            return { ...node, children: updatedChildren.filter(Boolean) as LayoutNode[] };
        }
    }

    return node;
}

const handleNodeRemove = async (payload: { parentNodeId: string | undefined; nodeIndex: number }) => {
  if (payload.parentNodeId === undefined && payload.nodeIndex === 0) {
    const confirmed = await showConfirmDialog({
      message: t('layoutConfigurator.confirmClearLayout', '确定要清空整个布局吗？所有面板将返回可用列表。')
    });
    if (confirmed) {
      localLayoutTree.value = null;
    }
  } else if (payload.parentNodeId) {
     localLayoutTree.value = findAndRemoveNode(localLayoutTree.value, payload.parentNodeId, payload.nodeIndex);
  }
};

const removeSidebarPane = (side: 'left' | 'right', index: number) => {
   const removedPane = localSidebarPanes.value[side].splice(index, 1)[0];
   if (removedPane && removedPane === 'terminal') {
       addPaneToAvailableList('terminal');
   }
};

const onDraggableChange = (event: any, side: 'left' | 'right') => {
    if (event.added) {
        const addedElement = event.added.element;
        const targetList = localSidebarPanes.value[side];
        const addedIndex = event.added.newIndex;

        if (targetList && typeof addedElement === 'object' && addedElement !== null && addedElement.type === 'pane' && typeof addedElement.component === 'string') {
            targetList.splice(addedIndex, 1, addedElement.component);
        }
    }
};

const handleAvailablePaneDragEnd = (event: any) => {
    if (event.to !== event.from) {
        const paneName = event.oldIndex !== undefined ? localAvailablePanes.value[event.oldIndex] : null;
        if (paneName === 'terminal') {
            removePaneFromAvailableList('terminal');
        }
    }
};
</script>

<template>
  <div
    v-if="isVisible"
    class="fixed inset-0 bg-black/70 backdrop-blur-md flex justify-center items-center z-[1000] p-4 sm:p-6 select-none animate-fadeIn"
    @click.self="closeDialog"
  >
    <div
      ref="dialogRef"
      class="bg-background text-foreground rounded-2xl shadow-2xl shadow-black/70 border border-border/80 w-full max-w-6xl h-[88vh] max-h-[860px] flex flex-col overflow-hidden relative pointer-events-auto cursor-default ring-1 ring-white/5"
    >
      <!-- 弹窗极简头部 (纯净利落，无任何冗余说明) -->
      <header class="flex justify-between items-center px-6 py-3.5 border-b border-border/80 bg-header/95 backdrop-blur-md flex-shrink-0">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-primary/10 border border-primary/25 text-primary flex items-center justify-center text-sm shadow-xs">
            <i class="fas fa-layer-group"></i>
          </div>
          <h2 class="text-base font-semibold leading-none text-foreground flex items-center gap-2 m-0">
            {{ t('layoutConfigurator.title', '布局管理器') }}
            <span v-if="isModified" class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30">
              未保存
            </span>
          </h2>
        </div>

        <div class="flex items-center gap-3">
          <!-- 锁定布局开关 -->
          <div class="flex items-center gap-2 bg-background-alt/80 px-2.5 py-1 rounded-full border border-border/60 shadow-xs">
            <i :class="layoutLockedBoolean ? 'fas fa-lock text-amber-400' : 'fas fa-lock-open text-text-secondary/60'" class="text-xs"></i>
            <span class="text-xs text-text-secondary cursor-pointer select-none font-medium" @click="handleLayoutLockChange">
              {{ t('layoutConfigurator.lockLayout', '锁定布局') }}
            </span>
            <button
              type="button"
              @click="handleLayoutLockChange"
              :class="[
                'relative inline-flex flex-shrink-0 h-4.5 w-8.5 border-2 border-transparent rounded-full cursor-pointer transition-colors ease-in-out duration-200 focus:outline-none',
                layoutLockedBoolean ? 'bg-primary' : 'bg-gray-400/40 dark:bg-gray-600'
              ]"
              role="switch"
              :aria-checked="layoutLockedBoolean"
            >
              <span
                aria-hidden="true"
                :class="[
                  'pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transform ring-0 transition ease-in-out duration-200',
                  layoutLockedBoolean ? 'translate-x-4' : 'translate-x-0'
                ]"
              ></span>
            </button>
          </div>

          <!-- 关闭按钮 -->
          <button
            class="w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground hover:bg-hover transition-colors"
            @click="closeDialog"
            :title="t('common.close', '关闭')"
          >
            <i class="fas fa-xmark text-sm"></i>
          </button>
        </div>
      </header>

      <!-- 核心工作区网格 (紧凑双栏，剔除所有冗余提示文字) -->
      <main class="flex-grow p-4 overflow-hidden grid grid-cols-[230px_1fr] gap-4 min-h-0 bg-background/50">

        <!-- 左侧：可用组件 (紧凑单行卡片，剔除冗余副标题) -->
        <section class="flex flex-col min-h-0 bg-background-alt/50 rounded-xl border border-border/80 p-3 overflow-hidden shadow-xs">
          <div class="flex items-center justify-between pb-2 mb-2 border-b border-border/60 flex-shrink-0">
            <div class="flex items-center gap-1.5">
              <i class="fas fa-cubes-stacked text-xs text-primary"></i>
              <h3 class="text-xs font-semibold text-foreground m-0">
                {{ t('layoutConfigurator.availablePanes', '可用组件') }}
              </h3>
            </div>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-header/80 text-text-secondary border border-border/50">
              {{ localAvailablePanes.length }}
            </span>
          </div>

          <draggable
            :list="localAvailablePanes"
            tag="ul"
            class="list-none p-0 m-0 flex-grow overflow-y-auto space-y-1.5 pr-1 custom-scroll"
            @end="handleAvailablePaneDragEnd"
            :item-key="(element: PaneName) => element"
            :group="{ name: 'layout-items', pull: 'clone', put: false }"
            :sort="false"
            :clone="clonePane"
          >
            <template #item="{ element }: { element: PaneName }">
              <li class="group/item flex items-center justify-between px-2.5 py-1.5 bg-background border border-border/70 hover:border-primary/50 rounded-lg cursor-grab transition-all duration-150 hover:bg-hover hover:shadow-xs active:cursor-grabbing">
                <div class="flex items-center gap-2 min-w-0">
                  <div
                    class="w-5 h-5 rounded flex items-center justify-center text-[10px] flex-shrink-0 border shadow-xs"
                    :class="[getPaneMeta(element).bgSoft, getPaneMeta(element).borderSoft, getPaneMeta(element).iconColor]"
                  >
                    <i :class="getPaneMeta(element).icon"></i>
                  </div>
                  <span class="text-xs font-medium text-foreground truncate">
                    {{ paneLabels[element] || element }}
                  </span>
                </div>
                <i class="fas fa-grip-vertical text-text-secondary/30 group-hover/item:text-text-secondary/70 text-[10px] ml-1 flex-shrink-0"></i>
              </li>
            </template>
            <template #footer>
              <li v-if="localAvailablePanes.length === 0" class="text-text-secondary/60 text-center py-6 px-2 text-xs border border-dashed border-border/60 rounded-lg bg-header/20">
                <i class="fas fa-circle-check text-emerald-400 text-sm mb-1 block"></i>
                <span>已全部加入</span>
              </li>
            </template>
          </draggable>
        </section>

        <!-- 右侧：主布局预览与侧栏配置 (饱满充实，消除大块空白) -->
        <div class="flex flex-col min-h-0 gap-3 overflow-hidden">

          <!-- 1. 主布局预览 (Blueprint Viewport) -->
          <section class="flex flex-col flex-1 min-h-0 bg-background-alt/40 rounded-xl border border-border/80 p-3 overflow-hidden shadow-xs relative">
            <!-- 极简标题栏 -->
            <div class="flex items-center justify-between mb-2 flex-shrink-0">
              <div class="flex items-center gap-2">
                <span class="w-1.5 h-1.5 rounded-full bg-primary"></span>
                <h3 class="text-xs font-semibold text-foreground m-0 flex items-center gap-1.5">
                  <i class="fas fa-desktop text-primary text-xs"></i>
                  <span>主布局预览</span>
                </h3>
              </div>
            </div>

            <!-- 画布视口 -->
            <div class="blueprint-canvas-viewport flex-grow rounded-lg border border-primary/20 p-1.5 bg-[#0e1014] flex flex-col overflow-auto min-h-0 shadow-inner relative custom-scroll">
              <LayoutNodeEditor
                v-if="localLayoutTree"
                :node="localLayoutTree"
                :parent-node="null"
                :node-index="0"
                :pane-labels="paneLabels"
                @update:node="handleNodeUpdate"
                @removeNode="handleNodeRemove"
                :group="'layout-items'"
                class="flex-grow w-full h-full"
              />
              <div v-else class="flex-grow flex flex-col items-center justify-center p-6 text-center gap-2 text-text-secondary/60 text-xs">
                <i class="fas fa-plus text-base text-primary/60"></i>
                <span>暂无布局，请从左侧拖拽面板加入</span>
              </div>
            </div>
          </section>

          <!-- 2. 侧边栏停靠槽位 (紧凑两栏) -->
          <div class="grid grid-cols-2 gap-3 h-[145px] flex-shrink-0">
            <!-- 左侧栏停靠位 -->
            <section class="flex flex-col min-h-0 bg-background-alt/50 rounded-xl border border-border/80 p-2.5 overflow-hidden shadow-xs">
              <div class="flex items-center justify-between pb-1.5 mb-1.5 border-b border-border/50 flex-shrink-0">
                <div class="flex items-center gap-1.5">
                  <i class="fas fa-arrow-left-to-line text-xs text-primary"></i>
                  <h4 class="text-xs font-semibold text-foreground m-0">左侧栏</h4>
                </div>
                <span class="text-[10px] text-text-secondary font-mono">{{ localSidebarPanes.left.length }}</span>
              </div>

              <draggable
                :list="localSidebarPanes.left"
                tag="ul"
                class="list-none p-0 m-0 flex-grow overflow-y-auto space-y-1 pr-1 custom-scroll"
                :item-key="(element: PaneName) => `left-${element}`"
                group="layout-items"
                :sort="true"
                @change="(event) => onDraggableChange(event, 'left')"
              >
                <template #item="{ element, index }: { element: PaneName, index: number }">
                  <li class="group/dock flex items-center justify-between px-2 py-1 bg-background border border-border/60 hover:border-primary/40 rounded-md cursor-grab active:cursor-grabbing transition-colors text-xs">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <div
                        class="w-4.5 h-4.5 rounded flex items-center justify-center text-[9px] flex-shrink-0 border"
                        :class="[getPaneMeta(element).bgSoft, getPaneMeta(element).borderSoft, getPaneMeta(element).iconColor]"
                      >
                        <i :class="getPaneMeta(element).icon"></i>
                      </div>
                      <span class="truncate text-xs font-medium text-foreground">{{ paneLabels[element] || element }}</span>
                    </div>
                    <button
                      type="button"
                      @click="removeSidebarPane('left', index)"
                      class="text-text-secondary/50 hover:text-red-400 p-0.5 rounded transition-colors opacity-0 group-hover/dock:opacity-100"
                      :title="t('common.remove', '移除')"
                    >
                      <i class="fas fa-xmark text-xs"></i>
                    </button>
                  </li>
                </template>
                <template #footer>
                  <li v-if="localSidebarPanes.left.length === 0" class="h-full min-h-[50px] border border-dashed border-border/50 rounded-md flex items-center justify-center p-2 text-center text-text-secondary/40 text-[11px] gap-1 bg-header/10">
                    <span>未配置面板</span>
                  </li>
                </template>
              </draggable>
            </section>

            <!-- 右侧栏停靠位 -->
            <section class="flex flex-col min-h-0 bg-background-alt/50 rounded-xl border border-border/80 p-2.5 overflow-hidden shadow-xs">
              <div class="flex items-center justify-between pb-1.5 mb-1.5 border-b border-border/50 flex-shrink-0">
                <div class="flex items-center gap-1.5">
                  <i class="fas fa-arrow-right-to-line text-xs text-primary"></i>
                  <h4 class="text-xs font-semibold text-foreground m-0">右侧栏</h4>
                </div>
                <span class="text-[10px] text-text-secondary font-mono">{{ localSidebarPanes.right.length }}</span>
              </div>

              <draggable
                :list="localSidebarPanes.right"
                tag="ul"
                class="list-none p-0 m-0 flex-grow overflow-y-auto space-y-1 pr-1 custom-scroll"
                :item-key="(element: PaneName) => `right-${element}`"
                group="layout-items"
                :sort="true"
                @change="(event) => onDraggableChange(event, 'right')"
              >
                <template #item="{ element, index }: { element: PaneName, index: number }">
                  <li class="group/dock flex items-center justify-between px-2 py-1 bg-background border border-border/60 hover:border-primary/40 rounded-md cursor-grab active:cursor-grabbing transition-colors text-xs">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <div
                        class="w-4.5 h-4.5 rounded flex items-center justify-center text-[9px] flex-shrink-0 border"
                        :class="[getPaneMeta(element).bgSoft, getPaneMeta(element).borderSoft, getPaneMeta(element).iconColor]"
                      >
                        <i :class="getPaneMeta(element).icon"></i>
                      </div>
                      <span class="truncate text-xs font-medium text-foreground">{{ paneLabels[element] || element }}</span>
                    </div>
                    <button
                      type="button"
                      @click="removeSidebarPane('right', index)"
                      class="text-text-secondary/50 hover:text-red-400 p-0.5 rounded transition-colors opacity-0 group-hover/dock:opacity-100"
                      :title="t('common.remove', '移除')"
                    >
                      <i class="fas fa-xmark text-xs"></i>
                    </button>
                  </li>
                </template>
                <template #footer>
                  <li v-if="localSidebarPanes.right.length === 0" class="h-full min-h-[50px] border border-dashed border-border/50 rounded-md flex items-center justify-center p-2 text-center text-text-secondary/40 text-[11px] gap-1 bg-header/10">
                    <span>未配置面板</span>
                  </li>
                </template>
              </draggable>
            </section>
          </div>

        </div>

      </main>

      <!-- 弹窗底部操作条 (纯净利落) -->
      <footer class="px-6 py-3 border-t border-border/80 flex items-center justify-between bg-header/95 backdrop-blur-md flex-shrink-0">
        <!-- 恢复系统默认布局 -->
        <button
          type="button"
          @click="resetToDefault"
          class="inline-flex items-center gap-1.5 py-1.5 px-3 rounded-lg text-xs font-medium text-text-secondary hover:text-foreground hover:bg-hover border border-border/70 transition-colors"
        >
          <i class="fas fa-rotate-left text-[10px]"></i>
          <span>{{ t('layoutConfigurator.resetDefault', '恢复默认') }}</span>
        </button>

        <div class="flex items-center gap-2.5">
          <!-- 取消按钮 -->
          <button
            type="button"
            @click="closeDialog"
            class="py-1.5 px-3.5 rounded-lg text-xs font-medium text-text-secondary hover:text-foreground hover:bg-hover border border-border/70 transition-colors"
          >
            {{ t('common.cancel', '取消') }}
          </button>
          <!-- 保存按钮 -->
          <button
            type="button"
            @click="saveLayout"
            class="inline-flex items-center gap-1.5 py-1.5 px-4.5 rounded-lg text-xs font-medium transition-all shadow-xs"
            :class="[
              isModified
                ? 'bg-primary text-white hover:bg-primary-hover shadow-primary/25 cursor-pointer'
                : 'bg-primary/40 text-white/60 cursor-not-allowed'
            ]"
            :disabled="!isModified"
          >
            <i class="fas fa-check text-[10px]"></i>
            <span>{{ t('common.save', '保存') }}</span>
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 蓝图背景微点阵网格 */
.blueprint-canvas-viewport {
  background-image: radial-gradient(rgba(255, 255, 255, 0.06) 1px, transparent 1px);
  background-size: 14px 14px;
}

/* 优化精细滚动条 */
.custom-scroll::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}
.custom-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scroll::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.2);
  border-radius: 9999px;
}
.custom-scroll::-webkit-scrollbar-thumb:hover {
  background: rgba(148, 163, 184, 0.4);
}

@keyframes fadeIn {
  from { opacity: 0; transform: scale(0.98); }
  to { opacity: 1; transform: scale(1); }
}

.animate-fadeIn {
  animation: fadeIn 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}
</style>
