<script setup lang="ts">
import { ref, computed, watch, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import draggable from 'vuedraggable';
import { useFocusSwitcherStore, type FocusableInput, type FocusItemConfig, type FocusSwitcherFullConfig } from '../stores/focusSwitcher.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';

interface SequenceDisplayItem extends FocusableInput {}

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
const focusSwitcherStore = useFocusSwitcherStore();
const { showConfirmDialog } = useConfirmDialog();

// --- State ---
const dialogRef = ref<HTMLElement | null>(null);
const hasChanges = ref(false);
const localSequence = ref<SequenceDisplayItem[]>([]);
const localItemConfigs = ref<Record<string, FocusItemConfig>>({});
const originalConfig = ref<FocusSwitcherFullConfig | null>(null);

// 输入源专属图标与色彩主题映射
const getInputMeta = (id: string) => {
  if (id.includes('terminal')) {
    return { icon: 'fas fa-terminal', iconColor: 'text-emerald-400', bgSoft: 'bg-emerald-500/15', borderSoft: 'border-emerald-500/30' };
  }
  if (id.includes('file-editor') || id.includes('editor')) {
    return { icon: 'fas fa-code', iconColor: 'text-sky-400', bgSoft: 'bg-sky-500/15', borderSoft: 'border-sky-500/30' };
  }
  if (id.includes('file')) {
    return { icon: 'fas fa-folder-tree', iconColor: 'text-amber-400', bgSoft: 'bg-amber-500/15', borderSoft: 'border-amber-500/30' };
  }
  if (id.includes('quick')) {
    return { icon: 'fas fa-bolt', iconColor: 'text-yellow-400', bgSoft: 'bg-yellow-500/15', borderSoft: 'border-yellow-500/30' };
  }
  if (id.includes('history')) {
    return { icon: 'fas fa-clock-rotate-left', iconColor: 'text-purple-400', bgSoft: 'bg-purple-500/15', borderSoft: 'border-purple-500/30' };
  }
  if (id.includes('connect')) {
    return { icon: 'fas fa-network-wired', iconColor: 'text-blue-400', bgSoft: 'bg-blue-500/15', borderSoft: 'border-blue-500/30' };
  }
  if (id.includes('command') || id.includes('input')) {
    return { icon: 'fas fa-chevron-right', iconColor: 'text-teal-400', bgSoft: 'bg-teal-500/15', borderSoft: 'border-teal-500/30' };
  }
  return { icon: 'fas fa-keyboard', iconColor: 'text-slate-400', bgSoft: 'bg-slate-500/15', borderSoft: 'border-slate-500/30' };
};

// --- Watchers ---
watch(() => props.isVisible, (newValue) => {
  if (newValue) {
    const currentSequenceOrder = focusSwitcherStore.sequenceOrder;
    const currentItemConfigs = focusSwitcherStore.itemConfigs;
    const allAvailableInputs = focusSwitcherStore.availableInputs;
    const inputsMap = new Map(allAvailableInputs.map(input => [input.id, input]));

    localSequence.value = currentSequenceOrder
      .map(id => inputsMap.get(id))
      .filter((input): input is SequenceDisplayItem => input !== undefined);

    const initialConfigs: Record<string, FocusItemConfig> = {};
    allAvailableInputs.forEach(input => {
      initialConfigs[input.id] = { ...(currentItemConfigs[input.id] || {}) };
    });
    localItemConfigs.value = JSON.parse(JSON.stringify(initialConfigs));

    originalConfig.value = JSON.parse(JSON.stringify({
      sequence: currentSequenceOrder,
      shortcuts: currentItemConfigs
    }));

    hasChanges.value = false;
  }
});

// 监听修改检测
watch([localSequence, localItemConfigs], () => {
  if (!originalConfig.value) return;

  const currentFullConfig: FocusSwitcherFullConfig = {
    sequence: localSequence.value.map(item => item.id),
    shortcuts: {},
  };
  focusSwitcherStore.availableInputs.forEach(input => {
    const localConfig = localItemConfigs.value[input.id];
    if (localConfig?.shortcut && typeof localConfig.shortcut === 'string' && localConfig.shortcut.trim() !== '') {
      currentFullConfig.shortcuts[input.id] = { shortcut: localConfig.shortcut };
    }
  });

  const comparableOriginalConfig: FocusSwitcherFullConfig = {
    sequence: originalConfig.value.sequence,
    shortcuts: {},
  };
  for (const id in originalConfig.value.shortcuts) {
    const originalShortcut = originalConfig.value.shortcuts[id]?.shortcut;
    if (originalShortcut && typeof originalShortcut === 'string' && originalShortcut.trim() !== '') {
      comparableOriginalConfig.shortcuts[id] = { shortcut: originalShortcut };
    }
  }

  hasChanges.value = JSON.stringify(currentFullConfig) !== JSON.stringify(comparableOriginalConfig);
}, { deep: true });

// --- Methods ---
const closeDialog = async () => {
  if (hasChanges.value) {
    const confirmed = await showConfirmDialog({
      message: t('focusSwitcher.confirmClose', '有未保存的更改，确定要关闭吗？')
    });
    if (confirmed) {
      emit('close');
    }
  } else {
    emit('close');
  }
};

const saveConfiguration = () => {
  const newSequence = localSequence.value.map(item => item.id);
  const newShortcuts: Record<string, FocusItemConfig> = {};
  for (const id in localItemConfigs.value) {
    if (localItemConfigs.value[id]?.shortcut) {
      newShortcuts[id] = { shortcut: localItemConfigs.value[id].shortcut };
    }
  }

  const fullConfigToSave: FocusSwitcherFullConfig = {
    sequence: newSequence,
    shortcuts: newShortcuts,
  };

  focusSwitcherStore.updateConfiguration(fullConfigToSave);
  hasChanges.value = false;
  emit('close');
};

const removeFromSequence = (index: number) => {
  if (index >= 0 && index < localSequence.value.length) {
    localSequence.value.splice(index, 1);
  }
};

const addToSequence = (item: FocusableInput) => {
  localSequence.value.push(item);
};

const clearShortcut = (inputId: string) => {
  if (localItemConfigs.value[inputId]) {
    localItemConfigs.value[inputId].shortcut = undefined;
  }
};

// 快捷键捕获录制
const captureShortcut = (event: KeyboardEvent, itemConfig: FocusItemConfig) => {
  if (event.key === 'Alt' || event.key === 'Control' || event.key === 'Shift' || event.key === 'Meta') {
    return;
  }

  if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
    let key = event.key;
    if (key.length === 1) {
      key = key.toUpperCase();
    }
    if (/^[a-zA-Z0-9]$/.test(key)) {
      itemConfig.shortcut = `Alt+${key}`;
    } else if (key === 'Backspace' || key === 'Delete') {
      itemConfig.shortcut = undefined;
    }
  } else if (event.key === 'Backspace' || event.key === 'Delete') {
    itemConfig.shortcut = undefined;
  }
};

// --- Computed ---
const localAvailableInputs = computed(() => {
  const sequenceIds = new Set(localSequence.value.map(item => item.id));
  return focusSwitcherStore.availableInputs.filter(input => !sequenceIds.has(input.id));
});
</script>

<template>
  <div
    v-if="isVisible"
    class="fixed inset-0 bg-black/70 backdrop-blur-md flex justify-center items-center z-[1000] p-4 sm:p-6 select-none animate-fadeIn"
    @click.self="closeDialog"
  >
    <div
      ref="dialogRef"
      class="bg-background text-foreground rounded-2xl shadow-2xl shadow-black/70 border border-border/80 w-full max-w-4xl h-[620px] max-h-[88vh] flex flex-col overflow-hidden relative pointer-events-auto cursor-default ring-1 ring-white/5"
    >
      <!-- 极简精致头部 (Header) -->
      <header class="flex justify-between items-center px-6 py-3.5 border-b border-border/80 bg-header/95 backdrop-blur-md flex-shrink-0">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-primary/10 border border-primary/25 text-primary flex items-center justify-center text-sm shadow-xs">
            <i class="fas fa-keyboard"></i>
          </div>
          <h2 class="text-base font-semibold leading-none text-foreground flex items-center gap-2 m-0">
            {{ t('focusSwitcher.configTitle', '配置焦点切换') }}
            <span v-if="hasChanges" class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30">
              未保存
            </span>
          </h2>
        </div>

        <button
          class="w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground hover:bg-hover transition-colors"
          @click="closeDialog"
          :title="t('common.close', '关闭')"
        >
          <i class="fas fa-xmark text-sm"></i>
        </button>
      </header>

      <!-- 核心工作区 (上部双栏拖拽序列，下部快捷键录制) -->
      <div class="flex-grow p-4 sm:p-5 flex flex-col gap-3.5 overflow-hidden min-h-0 bg-background/50">

        <!-- 上栏：可用输入源 与 循环切换顺序 (flex: 1 自适应充满) -->
        <div class="grid grid-cols-2 gap-3.5 flex-1 min-h-0 overflow-hidden">

          <!-- 1. 可用输入源 -->
          <section class="flex flex-col min-h-0 bg-background-alt/50 rounded-xl border border-border/80 p-3 overflow-hidden shadow-xs">
            <div class="flex items-center justify-between pb-2 mb-2 border-b border-border/60 flex-shrink-0">
              <div class="flex items-center gap-1.5">
                <i class="fas fa-layer-group text-xs text-primary"></i>
                <h3 class="text-xs font-semibold text-foreground m-0">
                  {{ t('focusSwitcher.availableInputs', '可用输入源') }}
                </h3>
              </div>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-header/80 text-text-secondary border border-border/50">
                {{ localAvailableInputs.length }}
              </span>
            </div>

            <draggable
              :list="localAvailableInputs"
              tag="ul"
              class="list-none p-0 m-0 flex-grow overflow-y-auto space-y-1.5 pr-1 custom-scroll"
              item-key="id"
              :group="{ name: 'focus-inputs', pull: true, put: false }"
              :sort="false"
              :fallback-on-body="true"
              :animation="150"
            >
              <template #item="{ element }">
                <li class="group/src flex items-center justify-between px-2.5 py-1.5 bg-background border border-border/70 hover:border-primary/50 rounded-lg cursor-grab active:cursor-grabbing transition-all duration-150 hover:bg-hover hover:shadow-xs">
                  <div class="flex items-center gap-2 min-w-0">
                    <div
                      class="w-5 h-5 rounded flex items-center justify-center text-[10px] flex-shrink-0 border shadow-xs"
                      :class="[getInputMeta(element.id).bgSoft, getInputMeta(element.id).borderSoft, getInputMeta(element.id).iconColor]"
                    >
                      <i :class="getInputMeta(element.id).icon"></i>
                    </div>
                    <span class="text-xs font-medium text-foreground truncate">
                      {{ element.label }}
                    </span>
                  </div>

                  <div class="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      type="button"
                      @click.stop="addToSequence(element)"
                      class="w-5 h-5 flex items-center justify-center rounded text-text-secondary/50 hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover/src:opacity-100"
                      title="添加到切换顺序"
                    >
                      <i class="fas fa-plus text-xs"></i>
                    </button>
                    <i class="fas fa-grip-vertical text-text-secondary/30 group-hover/src:text-text-secondary/70 text-[10px]"></i>
                  </div>
                </li>
              </template>
              <template #footer>
                <li v-if="localAvailableInputs.length === 0" class="h-full min-h-[100px] border border-dashed border-border/60 rounded-lg flex flex-col items-center justify-center p-3 text-center text-text-secondary/60 text-xs gap-1 bg-header/20">
                  <i class="fas fa-circle-check text-emerald-400 text-sm mb-0.5"></i>
                  <span>已全部加入</span>
                </li>
              </template>
            </draggable>
          </section>

          <!-- 2. 已配置切换顺序 (已剔除括号废话小字) -->
          <section class="flex flex-col min-h-0 bg-background-alt/50 rounded-xl border border-border/80 p-3 overflow-hidden shadow-xs">
            <div class="flex items-center justify-between pb-2 mb-2 border-b border-border/60 flex-shrink-0">
              <div class="flex items-center gap-1.5">
                <i class="fas fa-arrow-progress text-xs text-primary"></i>
                <h3 class="text-xs font-semibold text-foreground m-0">
                  {{ t('focusSwitcher.configuredSequence', '切换顺序') }}
                </h3>
              </div>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-header/80 text-text-secondary border border-border/50">
                {{ localSequence.length }}
              </span>
            </div>

            <draggable
              :list="localSequence"
              tag="ul"
              class="list-none p-0 m-0 flex-grow overflow-y-auto space-y-1.5 pr-1 custom-scroll"
              item-key="id"
              :group="{ name: 'focus-inputs', put: true }"
              :sort="true"
              :fallback-on-body="true"
              :animation="150"
            >
              <template #item="{ element, index }">
                <li class="group/seq flex items-center justify-between px-2.5 py-1.5 bg-background border border-border/70 hover:border-primary/50 rounded-lg cursor-grab active:cursor-grabbing transition-all duration-150 hover:bg-hover hover:shadow-xs">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="w-4 h-4 rounded-full bg-header border border-border/60 flex items-center justify-center text-[9px] font-mono font-bold text-text-secondary flex-shrink-0">
                      {{ index + 1 }}
                    </span>
                    <div
                      class="w-5 h-5 rounded flex items-center justify-center text-[10px] flex-shrink-0 border shadow-xs"
                      :class="[getInputMeta(element.id).bgSoft, getInputMeta(element.id).borderSoft, getInputMeta(element.id).iconColor]"
                    >
                      <i :class="getInputMeta(element.id).icon"></i>
                    </div>
                    <span class="text-xs font-medium text-foreground truncate">
                      {{ element.label }}
                    </span>
                  </div>

                  <div class="flex items-center gap-1 flex-shrink-0">
                    <button
                      type="button"
                      @click.stop="removeFromSequence(index)"
                      class="w-5 h-5 flex items-center justify-center rounded text-text-secondary/50 hover:text-red-400 hover:bg-red-500/15 transition-colors opacity-0 group-hover/seq:opacity-100"
                      :title="t('common.remove', '移除')"
                    >
                      <i class="fas fa-xmark text-xs"></i>
                    </button>
                    <i class="fas fa-grip-vertical text-text-secondary/30 group-hover/seq:text-text-secondary/70 text-[10px]"></i>
                  </div>
                </li>
              </template>
              <template #footer>
                <li v-if="localSequence.length === 0" class="h-full min-h-[100px] border border-dashed border-border/60 rounded-lg flex flex-col items-center justify-center p-3 text-center text-text-secondary/50 text-xs gap-1 bg-header/20">
                  <i class="fas fa-arrow-down-to-bracket text-xs opacity-60"></i>
                  <span>拖拽或点击左侧 + 加入切换队列</span>
                </li>
              </template>
            </draggable>
          </section>

        </div>

        <!-- 下栏：快捷键直接直达设置 (Kbd 录制网格，固定高度) -->
        <section class="flex flex-col bg-background-alt/50 rounded-xl border border-border/80 p-3 overflow-hidden shadow-xs flex-shrink-0">
          <div class="flex items-center justify-between pb-1.5 mb-2 border-b border-border/60 flex-shrink-0">
            <div class="flex items-center gap-1.5">
              <i class="fas fa-bolt text-xs text-amber-400"></i>
              <h3 class="text-xs font-semibold text-foreground m-0">
                {{ t('focusSwitcher.shortcutSettings', '快捷键直达') }}
              </h3>
            </div>
            <span class="text-[10px] text-text-secondary/60 font-mono">
              支持 Alt+字母/数字
            </span>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 overflow-y-auto max-h-[150px] pr-1 custom-scroll">
            <div
              v-for="input in focusSwitcherStore.availableInputs"
              :key="input.id"
              class="flex items-center justify-between p-1.5 rounded-lg bg-background border border-border/70 hover:border-border transition-colors gap-2"
            >
              <div class="flex items-center gap-1.5 min-w-0">
                <i :class="[getInputMeta(input.id).icon, getInputMeta(input.id).iconColor]" class="text-[10px] flex-shrink-0"></i>
                <span class="text-xs font-medium text-foreground truncate">{{ input.label }}</span>
              </div>

              <!-- 快捷键录制槽 -->
              <div class="flex items-center gap-1 flex-shrink-0">
                <div class="relative group/key">
                  <input
                    type="text"
                    readonly
                    :value="localItemConfigs[input.id]?.shortcut || ''"
                    class="w-18 px-1.5 py-0.5 text-center font-mono text-[10px] font-semibold rounded border border-border bg-header text-primary focus:border-primary focus:ring-1 focus:ring-primary/40 focus:outline-none placeholder:text-text-secondary/40 placeholder:font-normal placeholder:text-[9px] cursor-pointer transition-all"
                    placeholder="按 Alt+键"
                    @keydown.prevent="captureShortcut($event, localItemConfigs[input.id])"
                  />
                  <button
                    v-if="localItemConfigs[input.id]?.shortcut"
                    type="button"
                    @click="clearShortcut(input.id)"
                    class="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-red-500 text-white flex items-center justify-center text-[8px] opacity-0 group-hover/key:opacity-100 transition-opacity shadow-xs"
                    title="清空快捷键"
                  >
                    &times;
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

      </div>

      <!-- 弹窗底部操作条 (纯净利落) -->
      <footer class="px-6 py-3 border-t border-border/80 flex items-center justify-end gap-2.5 bg-header/95 backdrop-blur-md flex-shrink-0">
        <button
          type="button"
          @click="closeDialog"
          class="py-1.5 px-3.5 rounded-lg text-xs font-medium text-text-secondary hover:text-foreground hover:bg-hover border border-border/70 transition-colors"
        >
          {{ t('common.cancel', '取消') }}
        </button>
        <button
          type="button"
          @click="saveConfiguration"
          class="inline-flex items-center gap-1.5 py-1.5 px-4.5 rounded-lg text-xs font-medium transition-all shadow-xs"
          :class="[
            hasChanges
              ? 'bg-primary text-white hover:bg-primary-hover shadow-primary/25 cursor-pointer'
              : 'bg-primary/40 text-white/60 cursor-not-allowed'
          ]"
          :disabled="!hasChanges"
        >
          <i class="fas fa-check text-[10px]"></i>
          <span>{{ t('common.save', '保存') }}</span>
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.custom-scroll::-webkit-scrollbar {
  width: 4px;
  height: 4px;
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
