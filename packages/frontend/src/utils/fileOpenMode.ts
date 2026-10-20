// packages/frontend/src/utils/fileOpenMode.ts
import type { DesktopFileOpenMode } from '../stores/settings.store';

/**
 * 「这次点击该用内置编辑器还是系统默认程序」的纯判定。
 *
 * 抽成独立无依赖模块的原因：
 *   1. 能直接单测（tests/fileOpenMode.test.ts），不用把 pinia / axios / Tauri 拉进测试进程；
 *   2. 分流规则只有这一处，FileManager、终端右键菜单、以后新增的入口都复用同一份判断。
 *
 * 规则：Web / 移动端没有"外部程序"这个概念，一律内置编辑器；
 * 桌面端才看用户设置（值非法时回落到 builtin）。
 */
export function resolveOpenMode(params: {
  isDesktop: boolean;
  preference: DesktopFileOpenMode | string | undefined | null;
}): DesktopFileOpenMode {
  if (!params.isDesktop) return 'builtin';
  return params.preference === 'external' ? 'external' : 'builtin';
}
