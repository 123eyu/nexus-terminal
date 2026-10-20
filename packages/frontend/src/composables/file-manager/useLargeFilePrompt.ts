import { ref } from 'vue';

/**
 * 「打开大文件」确认弹窗的全局单例状态。
 *
 * 为什么要弹：内置编辑器是把整个文件读进内存再塞给 Monaco/CodeMirror 的，
 * 几十上百 MB 的文件点一下就要卡很久（还容易把标签页拖死）。超过阈值先问一句，
 * 比"点了没反应"友好。
 *
 * 为什么做成模块级单例：触发点在 openRemoteFile（文件管理器 / 目录树 / 终端右键都走它），
 * 弹窗只需要在 App.vue 挂一次；调用方 `await promptLargeFileOpen(...)` 即可。
 */

/** 超过这个大小就弹窗（用户要的阈值就是 3MB） */
export const LARGE_FILE_CONFIRM_BYTES = 3 * 1024 * 1024;

export interface LargeFilePromptState {
  fileName: string;
  sizeBytes: number;
}

export interface LargeFilePromptResult {
  /** true=仍然打开；false=取消 */
  confirmed: boolean;
  /** 勾了「记住我的选择，以后不再提示」（只在 confirmed 时生效） */
  remember: boolean;
}

export const largeFilePromptState = ref<LargeFilePromptState | null>(null);

let pendingResolver: ((result: LargeFilePromptResult) => void) | null = null;

function settle(result: LargeFilePromptResult) {
  const resolve = pendingResolver;
  pendingResolver = null;
  largeFilePromptState.value = null;
  resolve?.(result);
}

/**
 * 问用户要不要打开这个大文件。
 *
 * @returns `{ confirmed, remember }`；用户取消时 confirmed=false。
 */
export function promptLargeFileOpen(info: LargeFilePromptState): Promise<LargeFilePromptResult> {
  // 已经有一个没关（连点两个大文件）：把上一个当成取消，避免 resolve 泄漏
  if (pendingResolver) settle({ confirmed: false, remember: false });

  return new Promise((resolve) => {
    pendingResolver = resolve;
    largeFilePromptState.value = { ...info };
  });
}

/** 弹窗点「仍然打开」 */
export function confirmLargeFilePrompt(remember: boolean) {
  settle({ confirmed: true, remember });
}

/** 弹窗取消 / 点遮罩 / Esc */
export function cancelLargeFilePrompt() {
  settle({ confirmed: false, remember: false });
}
