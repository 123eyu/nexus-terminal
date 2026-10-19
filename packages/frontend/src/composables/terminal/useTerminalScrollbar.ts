import { ref } from 'vue';
import type { Terminal } from 'xterm';

/**
 * 终端右侧悬浮滚动条的状态（从 Terminal.vue 拆出）。
 *
 * 关键点：**xterm 的 `onScroll` 不会为滚轮滚动触发** —— 滚轮走的是 `.xterm-viewport`
 * 的原生 scrollTop。只监听 onScroll 就会出现"滚轮滚了、右侧滚动条不动"。
 * 所以这里额外挂了原生 scroll 监听，并用 rAF 节流（scroll 每帧可能触发多次）。
 *
 * 另一个坑：`canScroll=false` 时**只能淡出、不能 v-if 移除**，
 * 否则列宽变化会让终端反复 resize（见 MobileTerminalScrollbar 的注释）。
 */
export function useTerminalScrollbar(deps: { getTerminal: () => Terminal | null }) {
  const canScroll = ref(false);
  const scrollProgress = ref(1); // 0 (顶部历史) 到 1 (底部最新输出)
  const thumbHeightRatio = ref(0.2);

  let viewportEl: HTMLElement | null = null;
  let viewportScrollRaf: number | null = null;

  /** 计算文本是否超出视口并刷新进度 */
  const updateScrollState = () => {
    const term = deps.getTerminal();
    if (!term) {
      canScroll.value = false;
      return;
    }
    const buffer = term.buffer.active;
    const baseY = buffer.baseY;
    const rows = term.rows;

    // baseY > 0 说明存在历史回滚行，即文本超出了当前视口
    if (baseY > 0) {
      canScroll.value = true;
      const viewportY = buffer.viewportY;
      scrollProgress.value = Math.min(1, Math.max(0, viewportY / baseY));
      const totalLines = baseY + rows;
      thumbHeightRatio.value = Math.min(1, Math.max(0.08, rows / totalLines));
    } else {
      canScroll.value = false;
      scrollProgress.value = 1;
      thumbHeightRatio.value = 1;
    }
  };

  /** 拖拽悬浮滚动条 → 滚到对应行 */
  const handleScrollProgressChange = (progress: number) => {
    const term = deps.getTerminal();
    if (!term) return;
    const baseY = term.buffer.active.baseY;
    const targetLine = Math.round(progress * baseY);
    term.scrollToLine(targetLine);
    updateScrollState();
  };

  /** 滚轮/触控板滚动（原生 scroll）→ rAF 节流后同步滚动条 */
  const handleXtermViewportScroll = () => {
    if (viewportScrollRaf !== null) return;
    viewportScrollRaf = requestAnimationFrame(() => {
      viewportScrollRaf = null;
      updateScrollState();
    });
  };

  /** 终端初始化完成、DOM 就绪后调用 */
  function attachViewport(el: HTMLElement) {
    detachViewport();
    viewportEl = el;
    viewportEl.addEventListener('scroll', handleXtermViewportScroll, { passive: true });
  }

  function detachViewport() {
    if (viewportScrollRaf !== null) {
      cancelAnimationFrame(viewportScrollRaf);
      viewportScrollRaf = null;
    }
    if (viewportEl) {
      viewportEl.removeEventListener('scroll', handleXtermViewportScroll);
      viewportEl = null;
    }
  }

  return {
    canScroll,
    scrollProgress,
    thumbHeightRatio,
    updateScrollState,
    handleScrollProgressChange,
    handleXtermViewportScroll,
    attachViewport,
    detachViewport,
  };
}
