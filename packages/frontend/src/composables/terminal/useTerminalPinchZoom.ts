import type { Terminal } from 'xterm';

/**
 * 移动端双指缩放字号（从 Terminal.vue 拆出）。
 *
 * 缩放只改 `terminal.options.fontSize` 并触发一次 fit，
 * 真正的持久化走防抖（连续捏合会产生几十次尺寸变化）。
 *
 * 上限 8 / 下限 72：与设置页的字号范围保持一致，
 * 否则捏出来一个设置页选不到的值，用户下次打开设置会看到"空选"。
 */
export interface TerminalPinchZoomDeps {
  getTerminal: () => Terminal | null;
  /** 当前生效字号（设置里的值，terminal.options.fontSize 未初始化时用它兜底） */
  getCurrentFontSize: () => number;
  /** 应用新字号：重新 fit + 防抖持久化 */
  applyFontSize: (size: number) => void;
}

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 72;

export function useTerminalPinchZoom(deps: TerminalPinchZoomDeps) {
  let initialPinchDistance = 0;
  let currentFontSizeOnPinchStart = 0;

  const getDistanceBetweenTouches = (touches: TouchList): number => {
    const touch1 = touches[0];
    const touch2 = touches[1];
    return Math.sqrt(
      Math.pow(touch2.clientX - touch1.clientX, 2) + Math.pow(touch2.clientY - touch1.clientY, 2)
    );
  };

  const handleTouchStart = (event: TouchEvent) => {
    const term = deps.getTerminal();
    if (event.touches.length === 2 && term) {
      // 双指捏合：准备缩放字号
      event.preventDefault();
      initialPinchDistance = getDistanceBetweenTouches(event.touches);
      currentFontSizeOnPinchStart = term.options.fontSize || deps.getCurrentFontSize();
    }
  };

  const handleTouchMove = (event: TouchEvent) => {
    const term = deps.getTerminal();
    if (event.touches.length === 2 && term && initialPinchDistance > 0) {
      event.preventDefault();
      const currentDistance = getDistanceBetweenTouches(event.touches);
      if (currentDistance > 0) {
        const scale = currentDistance / initialPinchDistance;
        let newSize = Math.round(currentFontSizeOnPinchStart * scale);
        newSize = Math.max(MIN_FONT_SIZE, Math.min(newSize, MAX_FONT_SIZE));

        const currentTerminalOptFontSize = term.options.fontSize ?? deps.getCurrentFontSize();
        if (newSize !== currentTerminalOptFontSize) {
          term.options.fontSize = newSize;
          deps.applyFontSize(newSize);
        }
      }
    }
  };

  const handleTouchEnd = (event: TouchEvent) => {
    if (event.touches.length < 2) {
      initialPinchDistance = 0;
    }
  };

  return { handleTouchStart, handleTouchMove, handleTouchEnd };
}
