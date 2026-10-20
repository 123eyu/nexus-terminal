// packages/frontend/src/composables/file-manager/useFileOpenMode.ts
import i18n from '../../i18n';
import apiClient from '../../utils/apiClient';
import { isDesktopApp } from '../../utils/platform';
import { resolveOpenMode } from '../../utils/fileOpenMode';
import { useSettingsStore } from '../../stores/settings.store';
import { useSessionStore } from '../../stores/session.store';
import { useFileEditorStore, type FileInfo } from '../../stores/fileEditor.store';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';

/**
 * 「点开一个远程文件」这一件事的**唯一入口**。
 *
 * 以前 FileManager.vue 里同一段三分支逻辑复制了 5 份（目录树 / 符号链接指向文件 / 符号链接目标未知 /
 * 普通文件 / 面包屑），useTerminalContextMenu 里还有第 6 份。加"桌面端用外部程序打开"时如果继续复制，
 * 就会变成 6 份各自漂移的实现 —— 所以先收敛到这里。
 *
 * 分流规则：
 *   - Web / 移动端：永远内置编辑器（外部程序在浏览器里不存在）
 *   - 桌面端 + desktopFileOpenMode='builtin'：内置编辑器（弹窗 / 共享标签页 / 会话内标签页）
 *   - 桌面端 + desktopFileOpenMode='external'：远程文件由后端落成本地临时副本，
 *     再交给 Tauri 用系统默认程序打开；后端会监听本地改动自动回传（冲突时弹窗询问）。
 *     失败则提示并**降级回内置编辑器**，不让人卡住
 */

export interface OpenRemoteFileOptions {
  /** 会话 id（内置编辑器与后端都靠它/连接 id 定位） */
  sessionId: string;
  /** 远程绝对路径 */
  path: string;
  /** 布局实例 id：共享标签页模式下用来定位同一个编辑器实例 */
  instanceId?: string;
  /** 文件名（不传则从 path 推断） */
  fileName?: string;
  /** 数据库连接 id：外部打开需要它定位后端会话；不传则从 sessions store 反查 */
  connectionId?: number | string | null;
}

/** 纯函数：这次点击最终走哪条路（实现在 utils/fileOpenMode.ts，便于单测） */
export { resolveOpenMode };

/** 取 Tauri 的 invoke；浏览器里返回 null（`?platform=desktop` 调试时就是这种情况） */
function getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const tauri = (window as any).__TAURI__;
  if (tauri?.core?.invoke) return tauri.core.invoke.bind(tauri.core);
  if (typeof tauri?.invoke === 'function') return tauri.invoke.bind(tauri);
  return null;
}

/** 原来的内置编辑器分流逻辑，原样搬过来（三个开关的行为不能变） */
function openInBuiltinEditor(opts: OpenRemoteFileOptions): void {
  const settingsStore = useSettingsStore();
  const fileEditorStore = useFileEditorStore();
  const sessionStore = useSessionStore();

  const fileName = opts.fileName || opts.path.substring(opts.path.lastIndexOf('/') + 1) || opts.path;
  const fileInfo: FileInfo = { name: fileName, fullPath: opts.path };

  if (settingsStore.showPopupFileEditorBoolean) {
    fileEditorStore.triggerPopup(opts.path, opts.sessionId);
  }

  if (settingsStore.shareFileEditorTabsBoolean) {
    fileEditorStore.openFile(opts.path, opts.sessionId, opts.instanceId);
  } else {
    sessionStore.openFileInSession(opts.sessionId, fileInfo);
  }
}

/** 从参数或会话状态里找数据库连接 id */
function resolveConnectionId(opts: OpenRemoteFileOptions): string | null {
  if (opts.connectionId !== undefined && opts.connectionId !== null && String(opts.connectionId).trim() !== '') {
    return String(opts.connectionId);
  }
  const sessionStore = useSessionStore();
  const session = sessionStore.sessions.get(opts.sessionId);
  const fromSession = (session as any)?.connectionId;
  return fromSession ? String(fromSession) : null;
}

/**
 * 外部程序打开：后端把远程文件落成本地临时副本 → Tauri 用系统默认程序打开。
 * 返回 true 表示已经成功交给系统；false 表示这一路走不通（调用方降级）。
 */
async function openWithExternalProgram(opts: OpenRemoteFileOptions): Promise<boolean> {
  const t = i18n.global.t as (key: string, fallback?: string) => string;
  const notifications = useUiNotificationsStore();

  const invoke = getTauriInvoke();
  if (!invoke) {
    // 浏览器 / 调试态：静默降级，不打扰用户（设置页本来就只在桌面端显示这个选项）
    return false;
  }

  const connectionId = resolveConnectionId(opts);
  if (!connectionId) {
    notifications.showError(t('fileManager.openExternal.missingConnection', '无法确定连接信息，已改用内置编辑器打开'));
    return false;
  }

  try {
    // 大文件下载 + 落地可能要几秒：超过 800ms 才提示，小文件秒开时不闪一下
    const slowHint = setTimeout(() => {
      notifications.showInfo(t('fileManager.openExternal.preparing', '正在准备本地副本…'));
    }, 800);

    // 远程文件可能不小，默认 10s 超时不够用
    const res = await apiClient
      .post(
        '/sftp/open-external',
        { connectionId, remotePath: opts.path },
        { timeout: 120000 }
      )
      .finally(() => clearTimeout(slowHint));
    const localPath: string | undefined = res.data?.localPath;
    if (!localPath) {
      notifications.showError(t('fileManager.openExternal.noLocalPath', '服务器没有返回本地副本路径，已改用内置编辑器打开'));
      return false;
    }

    await invoke('open_local_path', { path: localPath });
    notifications.showSuccess(t('fileManager.openExternal.success', '已用系统默认程序打开（保存后自动同步回远程）'));
    return true;
  } catch (error: any) {
    console.error('[FileOpenMode] 外部程序打开失败:', error);
    // Tauri 的 invoke 失败时抛的是**字符串**（Rust 返回的 Err(String)），不是 Error 对象，
    // 只读 error.message 会把具体原因吞掉，只剩一句"打开失败"没法排查。
    const detail =
      error?.response?.data?.message ||
      (typeof error === 'string' ? error : error?.message) ||
      (error ? String(error) : '');
    notifications.showError(
      detail
        ? `${t('fileManager.openExternal.failed', '外部程序打开失败')}: ${detail}`
        : t('fileManager.openExternal.failed', '外部程序打开失败')
    );
    return false;
  }
}

/**
 * 打开远程文件的统一入口。FileManager 与终端右键菜单都调它。
 * 外部打开失败会自动降级到内置编辑器，保证"点了总能看到文件"。
 */
export async function openRemoteFile(opts: OpenRemoteFileOptions): Promise<void> {
  const settingsStore = useSettingsStore();
  const mode = resolveOpenMode({
    isDesktop: isDesktopApp(),
    preference: settingsStore.desktopFileOpenModeString,
  });

  if (mode === 'external') {
    const opened = await openWithExternalProgram(opts);
    if (opened) return;
  }

  openInBuiltinEditor(opts);
}
