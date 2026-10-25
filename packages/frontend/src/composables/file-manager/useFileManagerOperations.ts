import { ref, type Ref, type ShallowRef } from 'vue';
import type { FileListItem } from '../../types/sftp.types';
import type { ClipboardState, CompressFormat } from './useFileManagerContextMenu';
import type { FileManagerActionConfirmPayload } from './useFileManagerActionModal';
import type { createSftpActionsManager } from '../useSftpActions';
import { copyToClipboard } from '../../utils/clipboard';
import { resolveRemotePath, parentOfRemotePath } from '../../utils/pathUtils';

type SftpManagerInstance = ReturnType<typeof createSftpActionsManager>;

export interface FileManagerOperationsOptions {
  currentSftpManager: ShallowRef<SftpManagerInstance | null>;
  selectedItems: Ref<Set<string>>;
  isConnected: Ref<boolean>;
  showDeleteConfirmation: Ref<boolean>;
  sessionId: string;
  instanceId: string;
  t: (key: string, defaultMsg?: string) => string;
  notifySuccess?: (msg: string) => void;
  notifyError?: (msg: string) => void;
}

export function useFileManagerOperations(options: FileManagerOperationsOptions) {
  const {
    currentSftpManager,
    selectedItems,
    isConnected,
    showDeleteConfirmation,
    sessionId,
    instanceId,
    t,
    notifySuccess,
    notifyError,
  } = options;

  // 模态框状态
  const isActionModalVisible = ref(false);
  const currentActionType = ref<'delete' | 'rename' | 'chmod' | 'newFile' | 'newFolder' | null>(null);
  const actionItem = ref<FileListItem | null>(null);
  const actionItems = ref<FileListItem[]>([]);
  const actionInitialValue = ref('');

  // 剪贴板状态
  const clipboardState = ref<ClipboardState>({ hasContent: false });
  const clipboardSourcePaths = ref<string[]>([]);
  const clipboardSourceBaseDir = ref<string>('');

  const openActionModal = (
    type: 'delete' | 'rename' | 'chmod' | 'newFile' | 'newFolder',
    item?: FileListItem | null,
    items?: FileListItem[],
    initialValue?: string
  ) => {
    currentActionType.value = type;
    actionItem.value = item || null;
    actionItems.value = items || (item ? [item] : []);
    actionInitialValue.value = initialValue || '';
    isActionModalVisible.value = true;
  };

  const handleModalClose = () => {
    isActionModalVisible.value = false;
    currentActionType.value = null;
    actionItem.value = null;
    actionItems.value = [];
    actionInitialValue.value = '';
  };

  const handleModalConfirm = (payload?: FileManagerActionConfirmPayload | string) => {
    if (!currentSftpManager.value || !currentActionType.value) {
      handleModalClose();
      return;
    }
    const manager = currentSftpManager.value;
    // 兼容旧调用（理论上只剩字符串）：新代码一律传 { value, owner?, group? }
    const value = typeof payload === 'string' ? payload : payload?.value;
    const owner = typeof payload === 'string' ? undefined : payload?.owner;
    const group = typeof payload === 'string' ? undefined : payload?.group;

    switch (currentActionType.value) {
      case 'delete':
        if (actionItems.value.length > 0) {
          manager.deleteItems(actionItems.value);
          selectedItems.value.clear();
        }
        break;
      case 'rename':
        if (actionItem.value && value && value !== actionItem.value.filename) {
          manager.renameItem(actionItem.value, value);
        }
        break;
      case 'chmod':
        if (actionItem.value && value && /^[0-7]{3,4}$/.test(value)) {
          const newMode = parseInt(value, 8);
          // 所有者/所属组留空表示「不修改」，由 changePermissions 决定要不要跟一次 chown
          manager.changePermissions(actionItem.value, newMode, { owner, group });
        } else if (value) {
          console.error(`[FileManager ${sessionId}-${instanceId}] Invalid chmod value: ${value}`);
        }
        break;
      case 'newFile':
        if (value) {
          if (!canCreateAt(value, manager)) break;
          manager.createFile(value);
        }
        break;
      case 'newFolder':
        if (value) {
          if (!canCreateAt(value, manager)) break;
          manager.createDirectory(value);
        }
        break;
    }
    handleModalClose();
  };

  /**
   * 新建前的同名拦截。
   *
   * 输入框允许写路径（`./a/b/1.txt`、`../x`、`/etc/y`），只有「就建在当前目录」时
   * 本地列表才足以判断重名；建到别处（或建在需要新建的中间目录里）交给后端。
   * 放行时返回 true。
   */
  const canCreateAt = (rawValue: string, manager: SftpManagerInstance): boolean => {
    const resolved = resolveRemotePath(manager.currentPath.value, rawValue);
    if (resolved === '/') {
      console.warn(`[FileManager ${sessionId}-${instanceId}] 不能把根目录当作新建目标`);
      return false;
    }
    if (parentOfRemotePath(resolved) !== manager.currentPath.value) return true;
    const name = resolved.substring(resolved.lastIndexOf('/') + 1);
    if (manager.fileList.value.some((item: FileListItem) => item.filename === name)) {
      console.warn(`[FileManager ${sessionId}-${instanceId}] ${name} 已存在，跳过创建`);
      return false;
    }
    return true;
  };

  const handleDeleteSelectedClick = () => {
    if (!currentSftpManager.value || !isConnected.value || selectedItems.value.size === 0) return;
    const itemsToDelete = Array.from(selectedItems.value)
      .map(filename => currentSftpManager.value?.fileList.value.find((f: FileListItem) => f.filename === filename))
      .filter((item): item is FileListItem => item !== undefined);

    if (itemsToDelete.length === 0) return;

    if (showDeleteConfirmation.value) {
      openActionModal('delete', null, itemsToDelete);
    } else {
      currentSftpManager.value.deleteItems(itemsToDelete);
      selectedItems.value.clear();
    }
  };

  const handleRenameContextMenuClick = (item: FileListItem) => {
    if (!isConnected.value || !item || !currentSftpManager.value) return;
    openActionModal('rename', item, undefined, item.filename);
  };

  const handleChangePermissionsContextMenuClick = (item: FileListItem) => {
    if (!isConnected.value || !item || !currentSftpManager.value) return;
    const currentModeOctal = (item.attrs.mode & 0o777).toString(8).padStart(3, '0');
    openActionModal('chmod', item, undefined, currentModeOctal);
  };

  const handleNewFolderContextMenuClick = () => {
    if (!isConnected.value || !currentSftpManager.value) return;
    openActionModal('newFolder');
  };

  const handleNewFileContextMenuClick = () => {
    if (!isConnected.value || !currentSftpManager.value) return;
    openActionModal('newFile');
  };

  const handleCopy = () => {
    if (!currentSftpManager.value || selectedItems.value.size === 0) return;
    const manager = currentSftpManager.value;
    clipboardSourcePaths.value = Array.from(selectedItems.value)
      .map(filename => manager.joinPath(manager.currentPath.value, filename));
    clipboardState.value = { hasContent: true, operation: 'copy' };
    clipboardSourceBaseDir.value = manager.currentPath.value;
  };

  const handleCut = () => {
    if (!currentSftpManager.value || selectedItems.value.size === 0) return;
    const manager = currentSftpManager.value;
    clipboardSourcePaths.value = Array.from(selectedItems.value)
      .map(filename => manager.joinPath(manager.currentPath.value, filename));
    clipboardState.value = { hasContent: true, operation: 'cut' };
    clipboardSourceBaseDir.value = manager.currentPath.value;
  };

  const handlePaste = () => {
    if (!currentSftpManager.value || !clipboardState.value.hasContent || clipboardSourcePaths.value.length === 0) return;
    const manager = currentSftpManager.value;
    const destinationDir = manager.currentPath.value;
    const operation = clipboardState.value.operation;
    const sources = clipboardSourcePaths.value;
    const sourceBaseDir = clipboardSourceBaseDir.value;

    if (operation === 'copy') {
      manager.copyItems(sources, destinationDir);
    } else if (operation === 'cut') {
      if (sourceBaseDir === destinationDir) {
        console.warn(`[FileManager ${sessionId}-${instanceId}] Cannot cut and paste in the same directory.`);
        return;
      }
      manager.moveItems(sources, destinationDir);
      clipboardState.value = { hasContent: false };
      clipboardSourcePaths.value = [];
      clipboardSourceBaseDir.value = '';
    }
  };

  const clearClipboard = () => {
    clipboardState.value = { hasContent: false };
    clipboardSourcePaths.value = [];
    clipboardSourceBaseDir.value = '';
  };

  const handleCompress = (items: FileListItem[], format: CompressFormat) => {
    if (!currentSftpManager.value) return;
    currentSftpManager.value.compressItems(items, format);
  };

  const handleDecompress = (item: FileListItem) => {
    if (!currentSftpManager.value) return;
    currentSftpManager.value.decompressItem(item);
  };

  const handleCopyPath = async (item: FileListItem) => {
    if (!currentSftpManager.value) return;
    const fullPath = currentSftpManager.value.joinPath(currentSftpManager.value.currentPath.value, item.filename);
    const success = await copyToClipboard(fullPath);
    if (success) {
      notifySuccess?.(t('fileManager.notifications.pathCopied', 'Path copied to clipboard'));
    } else {
      console.warn(`[FileManager ${sessionId}-${instanceId}] Failed to copy path`);
      notifyError?.(t('fileManager.errors.copyPathFailed', 'Failed to copy path'));
    }
  };

  const triggerDownload = (items: FileListItem[], dbConnectionId?: string) => {
    if (!isConnected.value || !currentSftpManager.value) return;
    const connId = dbConnectionId;
    if (!connId) {
      console.error(`[FileManager ${sessionId}-${instanceId}] Cannot download: Missing connection ID.`);
      return;
    }

    items.forEach(item => {
      if (!item.attrs.isFile) return;

      const downloadPath = currentSftpManager.value!.joinPath(currentSftpManager.value!.currentPath.value, item.filename);
      const downloadUrl = `/api/v1/sftp/download?connectionId=${connId}&remotePath=${encodeURIComponent(downloadPath)}`;

      const link = document.createElement('a');
      link.href = downloadUrl;
      const safeFilename = item.filename.replace(/"/g, '');
      link.setAttribute('download', safeFilename);
      document.body.appendChild(link);
      link.click();

      setTimeout(() => {
        document.body.removeChild(link);
      }, 100);
    });
  };

  const triggerDownloadDirectory = (item: FileListItem, dbConnectionId?: string) => {
    if (!isConnected.value || !currentSftpManager.value || !item.attrs.isDirectory) return;
    const connId = dbConnectionId;
    if (!connId) {
      console.error(`[FileManager ${sessionId}-${instanceId}] Cannot download directory: Missing connection ID.`);
      return;
    }

    const directoryPath = currentSftpManager.value.joinPath(currentSftpManager.value.currentPath.value, item.filename);
    const downloadUrl = `/api/v1/sftp/download-directory?connectionId=${connId}&remotePath=${encodeURIComponent(directoryPath)}`;

    fetch(downloadUrl)
      .then(async response => {
        if (response.ok) {
          const blob = await response.blob();
          const contentDisposition = response.headers.get('content-disposition');
          let filename = `${item.filename}.zip`;
          if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename="?(.+)"?/i);
            if (filenameMatch && filenameMatch.length > 1) {
              filename = filenameMatch[1];
            }
          }

          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          const safeZipFilename = filename.replace(/"/g, '');
          link.setAttribute('download', safeZipFilename);
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(link.href);
        } else {
          console.error(`[FileManager ${sessionId}-${instanceId}] Directory download failed: ${response.status}`);
        }
      })
      .catch(error => {
        console.error(`[FileManager ${sessionId}-${instanceId}] Network error during directory download:`, error);
      });
  };

  return {
    isActionModalVisible,
    currentActionType,
    actionItem,
    actionItems,
    actionInitialValue,
    clipboardState,
    clipboardSourcePaths,
    clipboardSourceBaseDir,
    openActionModal,
    handleModalClose,
    handleModalConfirm,
    handleDeleteSelectedClick,
    handleRenameContextMenuClick,
    handleChangePermissionsContextMenuClick,
    handleNewFolderContextMenuClick,
    handleNewFileContextMenuClick,
    handleCopy,
    handleCut,
    handlePaste,
    clearClipboard,
    handleCompress,
    handleDecompress,
    handleCopyPath,
    triggerDownload,
    triggerDownloadDirectory,
  };
}
