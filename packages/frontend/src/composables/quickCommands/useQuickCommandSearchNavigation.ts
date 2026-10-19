import { nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { useQuickCommandsStore, type QuickCommandFE } from '../../stores/quickCommands.store';

/**
 * 快捷指令的「搜索输入 + 键盘导航 + 分组折叠 + 滚动跟随」。
 *
 * 桌面版和移动版这四段是逐字相同的 81 行。抽取时会遇到的两个细节：
 *
 * 1. 搜索是**本地草稿 + 120ms 防抖写回 store** —— 直接 v-model 到 store 会让
 *    每敲一个字符就重新过滤全表，移动端明显卡；
 * 2. 折叠/展开分组后，选中项可能被隐藏。必须 nextTick 之后按"命令 id"重新定位，
 *    只看索引会错位（索引是过滤后列表的位置，折叠会改变它）。
 */
export interface QuickCommandSearchNavigationDeps {
  /** 过滤+分组后的扁平可见命令（来自 store） */
  flatVisibleCommands: Ref<QuickCommandFE[]>;
  /** 当前选中索引（来自 store） */
  selectedIndex: Ref<number>;
  /** 列表滚动容器（用于 scrollIntoView） */
  listContainerRef: Ref<HTMLElement | null>;
  /** 回车时执行选中的命令 */
  onEnter: (cmd: QuickCommandFE) => void;
}

export function useQuickCommandSearchNavigation(deps: QuickCommandSearchNavigationDeps) {
  const quickCommandsStore = useQuickCommandsStore();

  const localSearchTerm = ref(quickCommandsStore.searchTerm);
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // store 里的搜索词被外部改了（清空、切换文件夹）时同步回输入框
  watch(
    () => quickCommandsStore.searchTerm,
    (newVal) => {
      if (newVal !== localSearchTerm.value) {
        localSearchTerm.value = newVal;
      }
    }
  );

  // 组件卸载时把未落盘的搜索词取消掉（定时器归本 composable 管）
  onBeforeUnmount(() => {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
  });

  function flushSearchTerm() {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
      quickCommandsStore.setSearchTerm(localSearchTerm.value);
    }
  }

  function updateSearchTerm(event: Event) {
    const target = event.target as HTMLInputElement;
    localSearchTerm.value = target.value;
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      quickCommandsStore.setSearchTerm(localSearchTerm.value);
      searchDebounceTimer = null;
    }, 120);
  }

  function handleSearchInputKeydown(event: KeyboardEvent) {
    const commands = deps.flatVisibleCommands.value;
    if (!commands.length) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        quickCommandsStore.selectNextCommand();
        break;
      case 'ArrowUp':
        event.preventDefault();
        quickCommandsStore.selectPreviousCommand();
        break;
      case 'Enter': {
        event.preventDefault();
        // 有未落盘的输入时先落盘，否则回车执行的是"上一轮过滤结果"里的命令
        flushSearchTerm();
        const index = deps.selectedIndex.value;
        if (index >= 0 && index < commands.length) {
          deps.onEnter(commands[index]);
        }
        break;
      }
    }
  }

  function toggleGroup(groupName: string) {
    quickCommandsStore.toggleGroup(groupName);
    // 折叠后选中项可能被隐藏：nextTick 后按 id 重新确认，找不到就清空选择
    nextTick(() => {
      const index = deps.selectedIndex.value;
      const selectedCmdId =
        index >= 0 && deps.flatVisibleCommands.value[index]
          ? deps.flatVisibleCommands.value[index].id
          : null;
      if (selectedCmdId !== null) {
        const newIndex = deps.flatVisibleCommands.value.findIndex((cmd) => cmd.id === selectedCmdId);
        if (newIndex === -1) {
          quickCommandsStore.resetSelection();
        }
      }
    });
  }

  async function scrollToSelected(index: number) {
    await nextTick();
    if (index < 0 || !deps.listContainerRef.value || !deps.flatVisibleCommands.value[index]) return;

    const selectedCommandId = deps.flatVisibleCommands.value[index].id;
    const selectedElement = deps.listContainerRef.value.querySelector(
      `[data-command-id="${selectedCommandId}"]`
    ) as HTMLElement | null;

    if (selectedElement) {
      selectedElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      console.warn(
        `[QuickCmdView] scrollToSelected: Could not find element for command ID ${selectedCommandId}`
      );
    }
  }

  return {
    localSearchTerm,
    updateSearchTerm,
    handleSearchInputKeydown,
    toggleGroup,
    scrollToSelected,
  };
}
