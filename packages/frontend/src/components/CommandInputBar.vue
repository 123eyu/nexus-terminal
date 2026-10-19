<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount, defineExpose, computed, defineOptions } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '../stores/session.store'; 
import { useFocusSwitcherStore } from '../stores/focusSwitcher.store';
import { useSettingsStore } from '../stores/settings.store';
import { useQuickCommandsStore } from '../stores/quickCommands.store';
import { useCommandHistoryStore } from '../stores/commandHistory.store';
import { useFileEditorStore } from '../stores/fileEditor.store'; 
import { useWorkspaceEventEmitter, useWorkspaceEventSubscriber, useWorkspaceEventOff } from '../composables/workspaceEvents';
import MobileCommandInputBar from './MobileCommandInputBar.vue';

defineOptions({ inheritAttrs: false });

const emitWorkspaceEvent = useWorkspaceEventEmitter();
const emit = defineEmits(['toggle-virtual-keyboard']);

const { t } = useI18n();
const focusSwitcherStore = useFocusSwitcherStore();
const settingsStore = useSettingsStore();
const quickCommandsStore = useQuickCommandsStore();
const commandHistoryStore = useCommandHistoryStore();
const sessionStore = useSessionStore();
const fileEditorStore = useFileEditorStore();

// 从 Store 获取响应式设置
const { commandInputSyncTarget, showPopupFileManagerBoolean, showPopupFileEditorBoolean } = storeToRefs(settingsStore);
const { selectedIndex: quickCommandsSelectedIndex, flatVisibleCommands: quickCommandsFiltered } = storeToRefs(quickCommandsStore);
const { resetSelection: resetQuickCommandsSelection } = quickCommandsStore;
const { selectedIndex: historySelectedIndex, filteredHistory: historyFiltered } = storeToRefs(commandHistoryStore);
const { resetSelection: resetHistorySelection } = commandHistoryStore;
const { activeSessionId } = storeToRefs(sessionStore);
const { updateSessionCommandInput } = sessionStore;

const props = defineProps<{
  isMobile?: boolean;
  isVirtualKeyboardVisible?: boolean;
}>();

const mobileBarRef = ref<InstanceType<typeof MobileCommandInputBar> | null>(null);

// --- 桌面端搜索与输入状态 ---
const isSearching = ref(false);
const searchTerm = ref('');
const searchInputRef = ref<HTMLInputElement | null>(null);
const commandInputRef = ref<HTMLInputElement | null>(null);

// --- 终端搜索选项与结果计数 ---
// 选项必须显式带上：addon 用它匹配，终端扫描滚动条标记时用同一套规则，
// 否则会出现"计数 3 个但轨道上 7 条标记"的不一致。
const searchCaseSensitive = ref(false);
const searchWholeWord = ref(false);
const searchRegex = ref(false);
const searchCurrentIndex = ref(-1);
const searchTotalCount = ref(0);

const searchOptions = computed(() => ({
  caseSensitive: searchCaseSensitive.value,
  wholeWord: searchWholeWord.value,
  regex: searchRegex.value,
}));

/** 显示成 "3/57"；没有匹配时显示 "0/0"，而不是空白让人以为功能没生效 */
const searchCountLabel = computed(() =>
  searchTotalCount.value > 0 ? `${searchCurrentIndex.value + 1}/${searchTotalCount.value}` : '0/0'
);

// 计算属性：当前活动会话的命令输入
const currentSessionCommandInput = computed({
  get: () => {
    if (!activeSessionId.value) return '';
    const session = sessionStore.sessions.get(activeSessionId.value);
    return session ? session.commandInputContent.value : '';
  },
  set: (newValue) => {
    if (activeSessionId.value) {
      updateSessionCommandInput(activeSessionId.value, newValue);
    }
  }
});

const sendCommand = () => {
  const command = currentSessionCommandInput.value;
  emitWorkspaceEvent('terminal:sendCommand', { command });

  if (command.trim() === '' && activeSessionId.value) {
    emitWorkspaceEvent('terminal:scrollToBottomRequest', { sessionId: activeSessionId.value });
  }

  if (activeSessionId.value) {
    updateSessionCommandInput(activeSessionId.value, '');
  }
};

const toggleSearch = () => {
  isSearching.value = !isSearching.value;
  if (!isSearching.value) {
    searchTerm.value = '';
    searchCurrentIndex.value = -1;
    searchTotalCount.value = 0;
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    emitWorkspaceEvent('search:close');
  }
};

const performSearch = () => {
  emitWorkspaceEvent('search:start', {
    term: searchTerm.value,
    options: searchOptions.value,
  });
};

// 140ms 防抖：连续键入时只对最后一段词做全量搜索 + 标记扫描，
// 长 scrollback（十万行级）下这是"输入不卡"的关键。
const SEARCH_DEBOUNCE_MS = 140;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

const findNext = () => {
  emitWorkspaceEvent('search:findNext');
};

const findPrevious = () => {
  emitWorkspaceEvent('search:findPrevious');
};

watch(searchTerm, () => {
  if (!isSearching.value) return;
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    performSearch();
  }, SEARCH_DEBOUNCE_MS);
});

// 切换大小写/整词/正则要立即重搜（不是键入，无需防抖）
watch([searchCaseSensitive, searchWholeWord, searchRegex], () => {
  if (isSearching.value && searchTerm.value) {
    performSearch();
  }
});

watch(currentSessionCommandInput, (newValue) => {
  const target = commandInputSyncTarget.value;
  if (target === 'quickCommands') {
    quickCommandsStore.setSearchTerm(newValue);
  } else if (target === 'commandHistory') {
    commandHistoryStore.setSearchTerm(newValue);
  }
});

const handleCommandInputKeydown = (event: KeyboardEvent) => {
  if (!event.altKey && event.key === 'Enter') {
    const target = commandInputSyncTarget.value;
    let selectedCommand: string | undefined;
    let resetSelection: (() => void) | undefined;

    if (target === 'quickCommands' && quickCommandsSelectedIndex.value >= 0) {
      const commands = quickCommandsFiltered.value;
      if (quickCommandsSelectedIndex.value < commands.length) {
        selectedCommand = commands[quickCommandsSelectedIndex.value].command;
        resetSelection = resetQuickCommandsSelection;
      }
    } else if (target === 'commandHistory' && historySelectedIndex.value >= 0) {
      const history = historyFiltered.value;
      if (historySelectedIndex.value < history.length) {
        selectedCommand = history[historySelectedIndex.value].command;
        resetSelection = resetHistorySelection;
      }
    }

    if (selectedCommand !== undefined) {
      event.preventDefault();
      emitWorkspaceEvent('terminal:sendCommand', { command: selectedCommand });
      if (activeSessionId.value) {
        updateSessionCommandInput(activeSessionId.value, '');
      }
      resetSelection?.();
      return;
    }
  }

  if (event.ctrlKey && event.key === 'f') {
    event.preventDefault();
    isSearching.value = true;
    nextTick(() => {
      searchInputRef.value?.focus();
    });
  } else if (event.key === 'ArrowUp') {
    const target = commandInputSyncTarget.value;
    if (target === 'quickCommands') {
      event.preventDefault();
      quickCommandsStore.selectPreviousCommand();
    } else if (target === 'commandHistory') {
      event.preventDefault();
      commandHistoryStore.selectPreviousCommand();
    }
  } else if (event.key === 'ArrowDown') {
    const target = commandInputSyncTarget.value;
    if (target === 'quickCommands') {
      event.preventDefault();
      quickCommandsStore.selectNextCommand();
    } else if (target === 'commandHistory') {
      event.preventDefault();
      commandHistoryStore.selectNextCommand();
    }
  } else if (event.ctrlKey && event.key === 'c' && currentSessionCommandInput.value === '') {
    event.preventDefault();
    emitWorkspaceEvent('terminal:sendCommand', { command: '\x03' });
  } else if (!event.altKey && event.key === 'Enter') {
    event.preventDefault();
    sendCommand();
  } else {
    if (!['ArrowUp', 'ArrowDown', 'Enter', 'Shift', 'Control', 'Alt', 'Meta', 'Tab', 'Escape'].includes(event.key)) {
      const target = commandInputSyncTarget.value;
      if (target === 'quickCommands' && quickCommandsSelectedIndex.value >= 0) {
        resetQuickCommandsSelection();
      } else if (target === 'commandHistory' && historySelectedIndex.value >= 0) {
        resetHistorySelection();
      }
    }
  }
};

const handleCommandInputBlur = () => {
  const target = commandInputSyncTarget.value;
  if (target === 'quickCommands') {
    resetQuickCommandsSelection();
  } else if (target === 'commandHistory') {
    resetHistorySelection();
  }
};

watch(() => focusSwitcherStore.activateTerminalSearchTrigger, () => {
  if (focusSwitcherStore.activateTerminalSearchTrigger > 0 && !isSearching.value) {
    toggleSearch();
  }
});

// --- Focus Actions ---
const focusCommandInput = (): boolean => {
  if (props.isMobile) {
    return mobileBarRef.value?.focusCommandInput() ?? false;
  }
  if (commandInputRef.value) {
    commandInputRef.value.focus();
    return true;
  }
  return false;
};

const focusSearchInput = (): boolean => {
  if (!isSearching.value) {
    toggleSearch();
    nextTick(() => {
      if (searchInputRef.value) {
        searchInputRef.value.focus();
      }
    });
    return true;
  } else if (searchInputRef.value) {
    searchInputRef.value.focus();
    return true;
  }
  return false;
};

defineExpose({ focusCommandInput, focusSearchInput });

const onWorkspaceEvent = useWorkspaceEventSubscriber();
const offWorkspaceEvent = useWorkspaceEventOff();

const handleCommandFill = (payload: { command: string }) => {
  if (!props.isMobile && activeSessionId.value) {
    updateSessionCommandInput(activeSessionId.value, payload.command);
  }
};

let unregisterCommandInputFocus: (() => void) | null = null;
let unregisterTerminalSearchFocus: (() => void) | null = null;

const handleSearchResults = (payload: { sessionId?: string; index: number; count: number }) => {
  // 分屏/多会话时只认当前会话；否则别的会话的搜索会把计数改掉
  if (payload.sessionId && activeSessionId.value && payload.sessionId !== activeSessionId.value) return;
  searchCurrentIndex.value = payload.index;
  searchTotalCount.value = payload.count;
};

onMounted(() => {
  onWorkspaceEvent('search:results', handleSearchResults);
  if (!props.isMobile) {
    unregisterCommandInputFocus = focusSwitcherStore.registerFocusAction('commandInput', focusCommandInput);
    unregisterTerminalSearchFocus = focusSwitcherStore.registerFocusAction('terminalSearch', focusSearchInput);
    onWorkspaceEvent('commandInput:fill', handleCommandFill);
  }
});

onBeforeUnmount(() => {
  if (unregisterCommandInputFocus) unregisterCommandInputFocus();
  if (unregisterTerminalSearchFocus) unregisterTerminalSearchFocus();
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
  offWorkspaceEvent('commandInput:fill', handleCommandFill);
  offWorkspaceEvent('search:results', handleSearchResults);
});

const openFileManagerModal = () => {
  if (activeSessionId.value) {
    emitWorkspaceEvent('fileManager:openModalRequest', { sessionId: activeSessionId.value });
  }
};

const openFileEditorModal = () => {
  if (activeSessionId.value) {
    fileEditorStore.triggerPopup('', activeSessionId.value);
  }
};

const getBarButtonClass = (isActive: boolean = false) => [
  'flex-shrink-0 flex items-center justify-center w-8 h-8 border rounded-lg transition-colors duration-200',
  isActive
    ? 'border-primary bg-primary/10 text-primary'
    : 'border-border/50 text-text-secondary hover:bg-border hover:text-foreground'
];
</script>

<template>
  <!-- 移动端：完全委托给独立的 MobileCommandInputBar 组件 -->
  <MobileCommandInputBar
    v-if="props.isMobile"
    ref="mobileBarRef"
    :is-virtual-keyboard-visible="props.isVirtualKeyboardVisible"
    @toggle-virtual-keyboard="emit('toggle-virtual-keyboard')"
  />

  <!-- 桌面端：纯净的命令输入与终端搜索工具栏 -->
  <div v-else :class="[$attrs.class, 'flex flex-col bg-background border-t border-border/30']">
    <div class="flex items-center py-1.5 px-2 bg-transparent relative gap-1 w-full overflow-x-auto no-scrollbar">
      <!-- Clear Terminal Button -->
      <button
        @click="emitWorkspaceEvent('terminal:clear')"
        :class="getBarButtonClass()"
        :title="t('commandInputBar.clearTerminal', '清空终端')"
      >
        <i class="fas fa-eraser text-base"></i>
      </button>

      <!-- Focus Switcher Config Button -->
      <button
        @click="focusSwitcherStore.toggleConfigurator(true)"
        :class="getBarButtonClass()"
        :title="t('commandInputBar.configureFocusSwitch', '配置焦点切换')"
      >
        <i class="fas fa-keyboard text-base"></i>
      </button>

      <!-- Desktop: Command Input -->
      <input
        type="text"
        v-model="currentSessionCommandInput"
        :placeholder="t('commandInputBar.placeholder')"
        class="flex-grow min-w-[120px] px-4 py-1.5 border border-border/50 rounded-lg bg-input text-foreground text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all duration-300 ease-in-out"
        :class="{
          'basis-3/4': isSearching,
          'basis-full': !isSearching,
        }"
        ref="commandInputRef"
        data-focus-id="commandInput"
        @keydown="handleCommandInputKeydown"
        @blur="handleCommandInputBlur"
      />

      <!-- Desktop: Search Input -->
      <input
        v-if="isSearching"
        type="text"
        v-model="searchTerm"
        :placeholder="t('commandInputBar.searchPlaceholder')"
        class="flex-grow min-w-0 px-4 py-1.5 border border-border/50 rounded-lg bg-input text-foreground text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all duration-300 ease-in-out basis-1/4"
        data-focus-id="terminalSearch"
        @keydown.enter.prevent="findNext"
        @keydown.shift.enter.prevent="findPrevious"
        @keydown.up.prevent="findPrevious"
        @keydown.down.prevent="findNext"
        ref="searchInputRef"
      />

      <!-- 命中计数："3/57"；没有匹配显示 0/0，避免空白让人以为没生效 -->
      <span
        v-if="isSearching"
        class="shrink-0 min-w-[40px] text-center text-xs tabular-nums font-medium select-none"
        :class="searchTotalCount > 0 ? 'text-text-secondary' : 'text-text-secondary/45'"
      >{{ searchCountLabel }}</span>

      <!-- Search Controls -->
      <div class="flex items-center gap-1 flex-shrink-0">
        <!-- Search Toggle Button -->
        <button
          @click="toggleSearch"
          :class="getBarButtonClass(isSearching)"
          :title="isSearching ? t('commandInputBar.closeSearch') : t('commandInputBar.openSearch')"
        >
          <i v-if="!isSearching" class="fas fa-search text-base"></i>
          <i v-else class="fas fa-times text-base"></i>
        </button>

        <!-- Search navigation buttons -->
        <template v-if="isSearching">
          <!-- 大小写 / 整词 / 正则：改完立即重搜 -->
          <button
            @click="searchCaseSensitive = !searchCaseSensitive"
            style="width: 1.75rem;"
            :class="getBarButtonClass(searchCaseSensitive)"
            :title="t('commandInputBar.matchCase', '区分大小写')"
          >
            <span class="text-[11px] font-bold leading-none">Aa</span>
          </button>
          <button
            @click="searchWholeWord = !searchWholeWord"
            style="width: 1.75rem;"
            :class="getBarButtonClass(searchWholeWord)"
            :title="t('commandInputBar.matchWholeWord', '全词匹配')"
          >
            <span class="text-[11px] font-bold leading-none">ab<span class="opacity-50">|</span>c</span>
          </button>
          <button
            @click="searchRegex = !searchRegex"
            style="width: 1.75rem;"
            :class="getBarButtonClass(searchRegex)"
            :title="t('commandInputBar.useRegex', '使用正则表达式')"
          >
            <span class="text-[11px] font-bold leading-none">.*</span>
          </button>

          <button
            @click="findPrevious"
            class="flex items-center justify-center w-8 h-8 border border-border/50 rounded-lg text-text-secondary transition-colors duration-200 hover:bg-border hover:text-foreground"
            :title="t('commandInputBar.findPrevious')"
          >
            <i class="fas fa-arrow-up text-base"></i>
          </button>
          <button
            @click="findNext"
            class="flex items-center justify-center w-8 h-8 border border-border/50 rounded-lg text-text-secondary transition-colors duration-200 hover:bg-border hover:text-foreground"
            :title="t('commandInputBar.findNext')"
          >
            <i class="fas fa-arrow-down text-base"></i>
          </button>
        </template>

        <!-- File Manager Button -->
        <button
          v-if="showPopupFileManagerBoolean"
          @click="openFileManagerModal"
          :class="getBarButtonClass()"
        >
          <i class="fas fa-folder text-base"></i>
        </button>

        <!-- File Editor Button -->
        <button
          v-if="showPopupFileEditorBoolean"
          @click="openFileEditorModal"
          :class="getBarButtonClass()"
          :title="t('fileEditor.title', '文件编辑')"
        >
          <i class="fas fa-edit text-base"></i>
        </button>
      </div>
    </div>
  </div>
</template>
