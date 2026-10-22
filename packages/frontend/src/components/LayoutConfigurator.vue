<script setup lang="ts">
import { ref, computed, watch, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useLayoutStore, type LayoutNode, type PaneName } from '../stores/layout.store';
import { useSettingsStore } from '../stores/settings.store';
import { useConnectionsStore } from '../stores/connections.store';
import { useSessionStore } from '../stores/session.store';
import type { LayoutPreset } from '../stores/layout.store';
import { storeToRefs } from 'pinia';
import draggable from 'vuedraggable';
import LayoutNodeEditor from './LayoutNodeEditor.vue';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { useAlertDialog } from '../composables/useAlertDialog';
import AppSelect from './common/AppSelect.vue';

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

// --- 预设与连接管理状态 ---
const connectionsStore = useConnectionsStore();
const sessionStore = useSessionStore();
const selectedPresetId = ref<string>(layoutStore.activeEditingPresetId || layoutStore.defaultPresetId || 'preset-default');

// 另存为预设弹窗状态
const showSaveAsModal = ref(false);
const newPresetName = ref('');

// 指定连接弹窗状态
const showBindConnectionsModal = ref(false);
const selectedConnectionIds = ref<number[]>([]);
const connectionSearchKeyword = ref('');

// 重命名预设弹窗状态
const showRenameModal = ref(false);
const editingPresetName = ref('');

// 当前选中的预设
const currentPreset = computed<LayoutPreset | undefined>(() => {
  return layoutStore.layoutPresets.find(p => p.id === selectedPresetId.value);
});

// 当前选中的预设是否为全局默认
const isCurrentPresetDefault = computed<boolean>(() => {
  return selectedPresetId.value === layoutStore.defaultPresetId;
});

/**
 * 当前预设绑定的连接数量（按 uuid 实际匹配本机连接）。
 *
 * 预设是跨端同步的，里面的 connectionIds 是"创建它的那台设备"的自增 id，
 * 直接用它数个数会出现"显示已指定 1 个，但列表里一个都没勾上"的错位。
 */
const currentPresetBoundCount = computed<number>(() => {
  const preset = currentPreset.value;
  if (!preset) return 0;
  const uuids = preset.connectionUuids || [];
  if (uuids.length > 0) {
    const localUuids = new Set(
      (connectionsStore.connections || [])
        .map(c => c.uuid)
        .filter((uuid): uuid is string => !!uuid)
    );
    if (localUuids.size === 0) return uuids.length; // 连接列表还没加载
    const matched = uuids.filter(uuid => localUuids.has(uuid)).length;
    return matched > 0 ? matched : uuids.length;
  }
  return preset.connectionIds?.length || 0;
});

// 过滤后的连接列表 (用于指定连接弹窗)
const filteredConnections = computed(() => {
  const kw = connectionSearchKeyword.value.trim().toLowerCase();
  if (!kw) return connectionsStore.connections;
  return connectionsStore.connections.filter(c => 
    c.name.toLowerCase().includes(kw) || 
    (c.host && c.host.toLowerCase().includes(kw)) ||
    (c.username && c.username.toLowerCase().includes(kw))
  );
});

// 加载指定预设到编辑画布
function loadPresetIntoEditor(presetId: string) {
  const target = layoutStore.layoutPresets.find(p => p.id === presetId)
    || layoutStore.layoutPresets[0]
    || layoutStore.getSystemDefaultPresets()[0];
  selectedPresetId.value = target.id;
  layoutStore.activeEditingPresetId = target.id;

  const initialLayout = target.layoutTree ? JSON.parse(JSON.stringify(target.layoutTree)) : layoutStore.getSystemDefaultLayout();
  localLayoutTree.value = initialLayout;
  originalLayoutTree.value = JSON.parse(JSON.stringify(initialLayout));

  const initialSidebars = target.sidebarPanes ? JSON.parse(JSON.stringify(target.sidebarPanes)) : layoutStore.getSystemDefaultSidebarPanes();
  localSidebarPanes.value = initialSidebars;
  originalSidebarPanes.value = JSON.parse(JSON.stringify(initialSidebars));

  localAvailablePanes.value = [...layoutStore.allPossiblePanes];
  localAvailablePanes.value.sort((a, b) =>
    layoutStore.allPossiblePanes.indexOf(a) - layoutStore.allPossiblePanes.indexOf(b)
  );
}

// 切换预设
async function handlePresetSelectChange(newPresetId: string) {
  if (newPresetId === selectedPresetId.value) return;
  if (isModified.value) {
    const confirmed = await showConfirmDialog({
      message: '当前预设有未保存的修改，切换预设将放弃修改，确定继续吗？'
    });
    if (!confirmed) return;
  }
  loadPresetIntoEditor(newPresetId);
}

// 设为默认预设
async function handleSetAsDefault() {
  if (isCurrentPresetDefault.value) return;
  layoutStore.setDefaultPreset(selectedPresetId.value);
  await showAlertDialog({
    title: '设置成功',
    message: `已将【${currentPreset.value?.name || '当前预设'}】设为全局默认布局。`
  });
}

// 打开另存为弹窗
function openSaveAsModal() {
  newPresetName.value = `${currentPreset.value?.name || '自定义布局'} (副本)`;
  showSaveAsModal.value = true;
}

// 确认另存为
async function confirmSaveAs() {
  const name = newPresetName.value.trim();
  if (!name) return;
  const created = layoutStore.createPreset(
    name,
    localLayoutTree.value || layoutStore.getSystemDefaultLayout(),
    localSidebarPanes.value || layoutStore.getSystemDefaultSidebarPanes()
  );
  showSaveAsModal.value = false;
  loadPresetIntoEditor(created.id);
  await showAlertDialog({
    title: '创建成功',
    message: `已成功另存为新预设【${created.name}】并激活编辑。`
  });
}

// 打开重命名弹窗
function openRenameModal() {
  if (!currentPreset.value) return;
  editingPresetName.value = currentPreset.value?.name || '';
  showRenameModal.value = true;
}

// 确认重命名
function confirmRename() {
  const name = editingPresetName.value.trim();
  if (!name || !currentPreset.value) return;
  layoutStore.updatePreset(selectedPresetId.value, { name });
  showRenameModal.value = false;
}

// 删除当前预设
async function handleDeleteCurrentPreset() {
  if (!currentPreset.value) return;
  if (layoutStore.layoutPresets.length <= 1) {
    await showAlertDialog({
      title: '无法删除',
      message: '系统至少需要保留一个布局预设。'
    });
    return;
  }
  if (isCurrentPresetDefault.value) {
    await showAlertDialog({
      title: '无法删除',
      message: '当前预设为全局默认布局。若需删除，请先将其他预设设为默认。'
    });
    return;
  }
  const confirmed = await showConfirmDialog({
    message: `确定要删除预设【${currentPreset.value.name}】吗？绑定的连接将自动恢复为默认布局。`
  });
  if (confirmed) {
    const deletedName = currentPreset.value.name;
    layoutStore.deletePreset(selectedPresetId.value);
    loadPresetIntoEditor(layoutStore.defaultPresetId);
    await showAlertDialog({
      title: '删除成功',
      message: `预设【${deletedName}】已删除。`
    });
  }
}

// 打开指定连接弹窗
function openBindConnectionsModal() {
  // 老缓存里的连接可能没有 uuid，重新拉一次，保证回填/保存都走跨端稳定的 uuid
  void connectionsStore.fetchConnections().catch(() => {});

  const preset = currentPreset.value;
  const list = connectionsStore.connections || [];
  const uuids = (preset?.connectionUuids || []).filter(Boolean);

  if (uuids.length > 0) {
    // 以 uuid 为准回填勾选：本地 id 是另一台设备的编号，不能直接用
    const uuidSet = new Set(uuids);
    selectedConnectionIds.value = list
      .filter(conn => !!conn.uuid && uuidSet.has(conn.uuid))
      .map(conn => conn.id);
  } else {
    // 老数据（只存了本地 id，且就是本机写的）才按 id 回填
    const localIds = new Set(list.map(conn => conn.id));
    const legacyIds = (preset?.connectionIds || []);
    selectedConnectionIds.value = localIds.size > 0
      ? legacyIds.filter(id => localIds.has(id))
      : [...legacyIds];
  }

  connectionSearchKeyword.value = '';
  showBindConnectionsModal.value = true;
}

// 切换连接勾选状态
function toggleConnectionSelection(connId: number) {
  const idx = selectedConnectionIds.value.indexOf(connId);
  if (idx > -1) {
    selectedConnectionIds.value.splice(idx, 1);
  } else {
    selectedConnectionIds.value.push(connId);
  }
}

// 全选或清空连接
function toggleSelectAllConnections() {
  if (selectedConnectionIds.value.length === connectionsStore.connections.length) {
    selectedConnectionIds.value = [];
  } else {
    selectedConnectionIds.value = connectionsStore.connections.map(c => c.id);
  }
}

// 确认指定连接
async function confirmBindConnections() {
  layoutStore.bindConnectionsToPreset(selectedPresetId.value, selectedConnectionIds.value);
  showBindConnectionsModal.value = false;
  await showAlertDialog({
    title: '绑定成功',
    message: `已成功将 ${selectedConnectionIds.value.length} 个连接绑定至【${currentPreset.value?.name || '当前预设'}】。`
  });
}

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
watch(() => props.isVisible, async (newValue) => {
  if (newValue) {
    // 先把后端的预设/绑定拉一遍：桌面端刚新建的布局、刚指定的连接，
    // 不能要求用户刷新整页才看得见（WS 断线时这一步就是兜底）。
    try {
      await layoutStore.reloadPresetsFromServer();
    } catch (reloadErr) {
      console.warn('[LayoutConfigurator] 重载布局预设失败:', reloadErr);
    }

    // 打开时把选中预设对齐到"当前活动会话实际使用的预设"，
    // 避免画布显示 A 预装的树、却把改动保存进 B 预设。
    const activeSession = sessionStore.activeSessionId
      ? sessionStore.sessions.get(sessionStore.activeSessionId)
      : null;
    if (activeSession) {
      const effectivePreset = layoutStore.getPresetForConnection(activeSession.connectionId);
      if (effectivePreset?.id) {
        selectedPresetId.value = effectivePreset.id;
        layoutStore.activeEditingPresetId = effectivePreset.id;
      }
    }
    // 预设可能在别处被删掉了，回退到默认预设，避免下拉框空选
    if (!layoutStore.layoutPresets.some(p => p.id === selectedPresetId.value)) {
      selectedPresetId.value = layoutStore.defaultPresetId || layoutStore.layoutPresets[0]?.id || 'preset-default';
    }
    // 初始化编辑器内容：
    // - 有活动会话 → 用该会话实际渲染的树（和用户眼前看到的一致）；
    // - 没有会话 → 用**当前选中预设**的树。空闲工作区渲染的是默认预设，
    //   若这里仍取主树，编辑非默认预设时会"画布显示默认布局、保存写进别的预设"。
    const activeTree = layoutStore.getActiveLayoutTree();
    const selectedPreset = layoutStore.layoutPresets.find(p => p.id === selectedPresetId.value);
    const treeSource = activeSession
      ? activeTree
      : (selectedPreset?.layoutTree ?? activeTree);
    const initialLayout = treeSource ? JSON.parse(JSON.stringify(treeSource)) : null;
    localLayoutTree.value = initialLayout;
    originalLayoutTree.value = JSON.parse(JSON.stringify(initialLayout));

    const sidebarSource = activeSession
      ? layoutStore.sidebarPanes
      : (selectedPreset?.sidebarPanes ?? layoutStore.sidebarPanes);
    const initialSidebars = sidebarSource ? JSON.parse(JSON.stringify(sidebarSource)) : { left: [], right: [] };
    localSidebarPanes.value = initialSidebars;
    originalSidebarPanes.value = JSON.parse(JSON.stringify(initialSidebars));

    // 组件物料库全量展示所有可用组件，支持无限次拖拽克隆至布局画布
    localAvailablePanes.value = [...layoutStore.allPossiblePanes];
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
   if (!localAvailablePanes.value.includes(paneName)) {
       const originalIndex = layoutStore.allPossiblePanes.indexOf(paneName);
       let inserted = false;
       for (let i = 0; i < localAvailablePanes.value.length; i++) {
           const currentAvailablePane = localAvailablePanes.value[i];
           const currentOriginalIndex = layoutStore.allPossiblePanes.indexOf(currentAvailablePane);
           if (originalIndex < currentOriginalIndex) {
               localAvailablePanes.value.splice(i, 0, paneName);
               inserted = true;
               break;
           }
       }
       if (!inserted) {
            localAvailablePanes.value.push(paneName);
       }
   }
}

function removePaneFromAvailableList(paneName: PaneName) {
    // 终端支持多次拉取分屏，永不从可用面板移除
    if (paneName === 'terminal') return;
    const index = localAvailablePanes.value.indexOf(paneName);
    if (index > -1) {
        localAvailablePanes.value.splice(index, 1);
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
    const layoutTreeToSave = localLayoutTree.value ? JSON.parse(JSON.stringify(localLayoutTree.value)) : layoutStore.getSystemDefaultLayout();
    const sidebarConfigToSave = JSON.parse(JSON.stringify(localSidebarPanes.value));

    // 同步更新当前正在编辑的预设数据
    layoutStore.updatePreset(selectedPresetId.value, {
      layoutTree: layoutTreeToSave,
      sidebarPanes: sidebarConfigToSave,
    });

    /**
     * 决定这次保存要不要落到"空闲工作区"（settings.layout）。
     *
     * 只有**全局默认预设**才代表空闲布局。旧逻辑把"当前会话正在用的预设"也算进去，
     * 于是保存一个按连接绑定的预设会把 settings.layout 覆盖成它 ——
     * 关掉会话后空闲工作区就变成了那个预设的布局，刷新也回不来。
     * 活动会话的更新由下面 refreshSessionLayoutTree 负责，不需要动主布局。
     */
    const isDefaultPreset = selectedPresetId.value === layoutStore.defaultPresetId;

    if (isDefaultPreset || !layoutStore.layoutTree) {
      await layoutStore.updateLayoutTree(layoutTreeToSave);
      await layoutStore.updateSidebarPanes(sidebarConfigToSave);
    }

    // 刷新已打开会话的专属布局树（桌面端渲染的是这些树，不刷新就"保存了没反应"）
    for (const [sid, s] of sessionStore.sessions) {
      if (layoutStore.isConnectionUsingPreset(s.connectionId, selectedPresetId.value)) {
        layoutStore.refreshSessionLayoutTree(sid, s.connectionId);
      }
    }

    originalLayoutTree.value = JSON.parse(JSON.stringify(layoutTreeToSave));
    originalSidebarPanes.value = JSON.parse(JSON.stringify(sidebarConfigToSave));

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

    localAvailablePanes.value = [...layoutStore.allPossiblePanes];
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
        if (removedNode.type === 'pane' && removedNode.component) {
            addPaneToAvailableList(removedNode.component);
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
   if (removedPane) {
       addPaneToAvailableList(removedPane);
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
    // 拖拽克隆完成，物料库始终保持全量组件就绪，供随时再次拖拽
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
      <!-- 预设与连接配置工具条 -->
      <div class="px-6 py-2.5 bg-background-alt/60 border-b border-border/80 flex flex-wrap items-center justify-between gap-3 flex-shrink-0">
        <!-- 左侧：预设下拉选择器与切换 -->
        <div class="flex items-center gap-2.5">
          <span class="text-xs text-text-secondary font-medium flex items-center gap-1.5">
            <i class="fas fa-shapes text-primary text-xs"></i>
            <span>布局预设:</span>
          </span>
          
          <div class="relative min-w-[200px]">
            <AppSelect
              :model-value="selectedPresetId"
              @update:model-value="(v) => handlePresetSelectChange(String(v ?? ''))"
              class="w-full bg-background border border-border/80 text-foreground text-xs rounded-lg px-2.5 py-1.5 appearance-none pr-8 font-medium focus:outline-none focus:border-primary cursor-pointer hover:border-primary/50 transition-colors shadow-xs"
            >
              <option
                v-for="preset in layoutStore.layoutPresets"
                :key="preset.id"
                :value="preset.id"
              >
                {{ preset.name }}
              </option>
            </AppSelect>
          </div>

          <!-- 设为默认按钮/徽章 -->
          <button
            type="button"
            @click="handleSetAsDefault"
            :class="[
              'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors border shadow-xs',
              isCurrentPresetDefault
                ? 'bg-amber-500/15 border-amber-500/40 text-amber-400 cursor-default'
                : 'bg-background hover:bg-hover border-border/80 text-text-secondary hover:text-foreground cursor-pointer'
            ]"
            :title="isCurrentPresetDefault ? '当前已是全局默认布局' : '将当前预设设为全局默认布局'"
          >
            <i :class="isCurrentPresetDefault ? 'fas fa-star text-amber-400' : 'far fa-star text-text-secondary'"></i>
            <span>{{ isCurrentPresetDefault ? '全局默认' : '设为默认' }}</span>
          </button>
        </div>

        <!-- 右侧：指定连接、另存为、重命名、删除 -->
        <div class="flex items-center gap-2">
          <!-- 指定连接按钮 (显示当前已绑定的连接数量) -->
          <button
            type="button"
            @click="openBindConnectionsModal"
            class="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 transition-colors shadow-xs cursor-pointer"
            title="指定哪些 SSH 连接使用该布局"
          >
            <i class="fas fa-link text-[11px]"></i>
            <span>指定连接</span>
            <span class="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-primary/20 text-primary">
              {{ currentPresetBoundCount }}
            </span>
          </button>

          <!-- 另存为新预设按钮 -->
          <button
            type="button"
            @click="openSaveAsModal"
            class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-background hover:bg-hover text-text-secondary hover:text-foreground border border-border/80 transition-colors shadow-xs cursor-pointer"
            title="将当前布局另存为一个新的自定义预设"
          >
            <i class="fas fa-copy text-[11px]"></i>
            <span>另存为...</span>
          </button>

          <!-- 重命名预设 -->
          <button
            type="button"
            @click="openRenameModal"
            class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-background hover:bg-hover text-text-secondary hover:text-foreground border border-border/80 transition-colors shadow-xs cursor-pointer"
            title="重命名此预设"
          >
            <i class="fas fa-pen text-[10px]"></i>
            <span>重命名</span>
          </button>

          <!-- 删除预设 (仅非默认且多于1个预设) -->
          <button
            v-if="layoutStore.layoutPresets.length > 1 && !isCurrentPresetDefault"
            type="button"
            @click="handleDeleteCurrentPreset"
            class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 transition-colors shadow-xs cursor-pointer"
            title="删除此预设"
          >
            <i class="fas fa-trash-can text-[10px]"></i>
            <span>删除</span>
          </button>
        </div>
      </div>


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

    <!-- 另存为新预设弹窗 -->
    <Teleport to="body">
      <div v-if="showSaveAsModal" class="fixed inset-0 bg-black/70 backdrop-blur-sm flex justify-center items-center z-[1100] p-4 select-none animate-fadeIn">
        <div class="bg-background border border-border/80 rounded-2xl shadow-2xl p-5 w-full max-w-sm flex flex-col gap-4">
          <div class="flex items-center justify-between pb-2 border-b border-border/50">
            <h3 class="text-sm font-semibold text-foreground flex items-center gap-2 m-0">
              <i class="fas fa-copy text-primary text-xs"></i>
              <span>另存为新预设</span>
            </h3>
            <button @click="showSaveAsModal = false" class="text-text-secondary hover:text-foreground">
              <i class="fas fa-xmark text-xs"></i>
            </button>
          </div>
          <div>
            <label class="block text-xs font-medium text-text-secondary mb-1.5">预设名称</label>
            <input
              v-model="newPresetName"
              @keydown.enter="confirmSaveAs"
              type="text"
              class="w-full bg-background-alt border border-border/80 rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary"
              placeholder="请输入新预设名称"
              autofocus
            />
          </div>
          <div class="flex justify-end gap-2 pt-2 border-t border-border/50">
            <button
              type="button"
              @click="showSaveAsModal = false"
              class="px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:bg-hover border border-border/70 cursor-pointer"
            >
              取消
            </button>
            <button
              type="button"
              @click="confirmSaveAs"
              class="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-primary text-white hover:bg-primary-hover shadow-xs cursor-pointer"
            >
              确定另存为
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 重命名预设弹窗 -->
    <Teleport to="body">
      <div v-if="showRenameModal" class="fixed inset-0 bg-black/70 backdrop-blur-sm flex justify-center items-center z-[1100] p-4 select-none animate-fadeIn">
        <div class="bg-background border border-border/80 rounded-2xl shadow-2xl p-5 w-full max-w-sm flex flex-col gap-4">
          <div class="flex items-center justify-between pb-2 border-b border-border/50">
            <h3 class="text-sm font-semibold text-foreground flex items-center gap-2 m-0">
              <i class="fas fa-pen text-primary text-xs"></i>
              <span>重命名预设</span>
            </h3>
            <button @click="showRenameModal = false" class="text-text-secondary hover:text-foreground">
              <i class="fas fa-xmark text-xs"></i>
            </button>
          </div>
          <div>
            <label class="block text-xs font-medium text-text-secondary mb-1.5">预设名称</label>
            <input
              v-model="editingPresetName"
              @keydown.enter="confirmRename"
              type="text"
              class="w-full bg-background-alt border border-border/80 rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary"
              placeholder="请输入预设名称"
              autofocus
            />
          </div>
          <div class="flex justify-end gap-2 pt-2 border-t border-border/50">
            <button
              type="button"
              @click="showRenameModal = false"
              class="px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:bg-hover border border-border/70 cursor-pointer"
            >
              取消
            </button>
            <button
              type="button"
              @click="confirmRename"
              class="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-primary text-white hover:bg-primary-hover shadow-xs cursor-pointer"
            >
              确定修改
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 指定连接弹窗 -->
    <Teleport to="body">
      <div v-if="showBindConnectionsModal" class="fixed inset-0 bg-black/70 backdrop-blur-sm flex justify-center items-center z-[1100] p-4 select-none animate-fadeIn">
        <div class="bg-background border border-border/80 rounded-2xl shadow-2xl p-5 w-full max-w-md max-h-[80vh] flex flex-col gap-3">
          <div class="flex items-center justify-between pb-2 border-b border-border/50 flex-shrink-0">
            <h3 class="text-sm font-semibold text-foreground flex items-center gap-2 m-0">
              <i class="fas fa-link text-primary text-xs"></i>
              <span>指定绑定连接</span>
              <span class="text-xs text-text-secondary font-normal truncate max-w-[180px]">
                ({{ currentPreset?.name }})
              </span>
            </h3>
            <button @click="showBindConnectionsModal = false" class="text-text-secondary hover:text-foreground">
              <i class="fas fa-xmark text-xs"></i>
            </button>
          </div>

          <!-- 搜索与全选工具栏 -->
          <div class="flex items-center gap-2 flex-shrink-0">
            <div class="relative flex-grow">
              <i class="fas fa-search absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary text-[10px]"></i>
              <input
                v-model="connectionSearchKeyword"
                type="text"
                placeholder="搜索连接名 / 主机..."
                class="w-full bg-background-alt border border-border/70 rounded-lg pl-7 pr-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary"
              />
            </div>
            <button
              type="button"
              @click="toggleSelectAllConnections"
              class="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-hover text-text-secondary hover:text-foreground border border-border/70 whitespace-nowrap cursor-pointer"
            >
              {{ selectedConnectionIds.length === connectionsStore.connections.length ? '全部取消' : '全选' }}
            </button>
          </div>

          <!-- 连接列表区域 -->
          <div class="flex-grow overflow-y-auto max-h-[380px] custom-scroll flex flex-col gap-1.5 pr-1">
            <div
              v-for="conn in filteredConnections"
              :key="conn.id"
              @click="toggleConnectionSelection(conn.id)"
              :class="[
                'flex items-center justify-between p-2.5 rounded-xl border text-xs cursor-pointer transition-colors',
                selectedConnectionIds.includes(conn.id)
                  ? 'bg-primary/10 border-primary/40 text-primary'
                  : 'bg-background-alt/50 border-border/60 hover:bg-hover text-foreground'
              ]"
            >
              <div class="flex items-center gap-2.5 truncate">
                <i :class="selectedConnectionIds.includes(conn.id) ? 'fas fa-check-square text-primary' : 'far fa-square text-text-secondary/70'" class="text-sm"></i>
                <div class="truncate">
                  <div class="font-medium truncate">{{ conn.name }}</div>
                  <div class="text-[10px] text-text-secondary truncate font-mono">
                    {{ (conn.username ? conn.username + '@' : '') + conn.host + ':' + (conn.port || 22) }}
                  </div>
                </div>
              </div>
              <span v-if="selectedConnectionIds.includes(conn.id)" class="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded font-mono">
                已指定
              </span>
            </div>

            <div v-if="filteredConnections.length === 0" class="py-8 text-center text-text-secondary text-xs">
              暂无匹配的连接
            </div>
          </div>

          <!-- 底部保存按钮 -->
          <div class="flex items-center justify-between pt-3 border-t border-border/50 flex-shrink-0">
            <span class="text-xs text-text-secondary">
              已选 <strong class="text-primary font-mono">{{ selectedConnectionIds.length }}</strong> 个连接
            </span>
            <div class="flex items-center gap-2">
              <button
                type="button"
                @click="showBindConnectionsModal = false"
                class="px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:bg-hover border border-border/70 cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                @click="confirmBindConnections"
                class="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-primary text-white hover:bg-primary-hover shadow-xs cursor-pointer"
              >
                确定绑定
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
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
