import { onBeforeUnmount, onMounted, type Ref } from 'vue';
import { useWorkspaceEventOff, useWorkspaceEventSubscriber } from '../workspaceEvents';
import type { TerminalSyncMode } from '../../types/sftp.types';
import type { SftpManagerInstance } from '../useSftpActions';

/**
 * 文件管理器与工作区/终端之间的事件桥（从 FileManager.vue 抽出）。
 *
 * 这里全是"订阅 + 清理"逻辑，最容易出错的两类问题都在这个文件里：
 *
 * 1. **漏清理 = 重复刷新**。组件是 v-if 渲染的，切面板就卸载；
 *    每个订阅都必须成对注册/注销，否则重新打开一次侧栏就多挂一层监听，
 *    表现为目录刷新频率翻倍、终端 cd 事件被响应多次。
 * 2. **回环死锁**。文件管理器 loadDirectory 会写终端，终端 OSC 7 又会把 cwd 推回来。
 *    `pathSync.internal` + 600ms 锁就是防这个用的 —— 锁状态由调用方持有，
 *    因为 syncPathToTerminal 也要改它。
 *
 * 另外注意：**这里不销毁 SFTP manager**。manager 的生命周期跟会话走，
 * 组件卸载后 WS 处理器仍然挂着，缓存里的目录还能保持最新。
 * 以前的实现在卸载时 removeSftpManager，导致重开侧栏必然先转一圈"正在加载"。
 */
export interface FileManagerBridgeDeps {
  sessionId: string;
  instanceId: string;
  /** 实际实例 id（props.instanceId 为空时回落 'default'） */
  effectiveInstanceId: Ref<string>;
  isConnected: Ref<boolean>;
  isSftpReady: Ref<boolean>;
  currentSftpManager: Ref<SftpManagerInstance | null>;
  /** 当前激活会话（后台会话不轮询） */
  activeSessionId: () => string | null;
  /** 当前聚焦终端 pane（分屏时只跟从聚焦的那个） */
  activeTerminalPaneId: () => string | null;
  terminalSyncMode: Ref<TerminalSyncMode>;
  /** 回环锁状态，由调用方持有（syncPathToTerminal 也会改） */
  pathSync: {
    internal: boolean;
    lastSyncedPath: string;
    lockTimer: ReturnType<typeof setTimeout> | null;
  };
  normalizePath: (p?: string | null) => string;
  /** 用户正在交互（加载中/拖拽/调整列宽/外部上传蒙层）时不轮询 */
  isBusy: () => boolean;
  showDirectoryTree: Ref<boolean>;
  directoryTreeWidth: Ref<number>;
  viewMode: Ref<'list' | 'tile'>;
  focusSearchInput: () => boolean;
  startPathEdit: () => void;
  registerFocusAction: (
    name: string,
    handler: () => Promise<boolean | undefined>
  ) => () => void;
}

export function useFileManagerWorkspaceBridge(deps: FileManagerBridgeDeps) {
  const logFolder = `[FileManager ${deps.sessionId}-${deps.instanceId}]`;
  const subscribeToWorkspaceEvent = useWorkspaceEventSubscriber();
  const unsubscribeFromWorkspaceEvent = useWorkspaceEventOff();

  let directoryPollTimer: ReturnType<typeof setInterval> | null = null;
  let terminalDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  const unregisters: Array<() => void> = [];

  // --- 目录实时变更感知：自适应静默增量探查 ---
  const checkAndPollCurrentDirectory = () => {
    // 1. 窗口处于后台休眠时跳过探查，节约带宽与性能
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    // 2. 仅对当前激活的会话执行前台轮询，后台会话不空转
    const activeSessionId = deps.activeSessionId();
    if (activeSessionId && activeSessionId !== deps.sessionId) {
      return;
    }
    // 3. SFTP 实例必须存在且连接就绪
    if (
      !deps.currentSftpManager.value ||
      !deps.isConnected.value ||
      !deps.isSftpReady.value
    ) {
      return;
    }
    // 4. 用户正在交互时跳过该周期
    if (deps.currentSftpManager.value.isLoading.value || deps.isBusy()) {
      return;
    }
    // 5. 发起静默增量比对刷新
    deps.currentSftpManager.value.silentRefreshCurrentDirectory();
  };

  const handleVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      // 用户从其他标签页切回来时，立即执行一次增量探查
      checkAndPollCurrentDirectory();
    }
  };

  onMounted(() => {
    // 启动自适应静默增量探查（每 2.8 秒一次）
    directoryPollTimer = setInterval(checkAndPollCurrentDirectory, 2800);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    // 终端敲回车后防抖 600ms 静默刷新目录
    const handleTerminalInputNotification = (payload: { sessionId: string; data: string }) => {
      if (
        payload.sessionId === deps.sessionId &&
        (payload.data.includes('\r') || payload.data.includes('\n'))
      ) {
        if (terminalDebounceTimer) clearTimeout(terminalDebounceTimer);
        terminalDebounceTimer = setTimeout(() => {
          checkAndPollCurrentDirectory();
        }, 600);
      }
    };
    subscribeToWorkspaceEvent('terminal:input', handleTerminalInputNotification);
    unregisters.push(() =>
      unsubscribeFromWorkspaceEvent('terminal:input', handleTerminalInputNotification)
    );

    // 终端 -> 文件管理器：监听终端当前工作目录变更
    const handleTerminalCwdChangedNotification = (payload: {
      sessionId: string;
      cwd: string;
      paneId?: string;
    }) => {
      // 1. 必须属于当前文件管理器绑定的会话
      if (payload.sessionId !== deps.sessionId) {
        return;
      }

      // 1.1 分屏聚焦匹配：事件带 paneId 时只跟从当前聚焦的终端
      const focusedPaneId = deps.activeTerminalPaneId();
      if (payload.paneId && focusedPaneId && payload.paneId !== focusedPaneId) {
        return;
      }

      // 2. 同步模式必须是双向或"终端 -> 文件管理器"
      if (
        deps.terminalSyncMode.value !== 'bidirectional' &&
        deps.terminalSyncMode.value !== 'from_terminal'
      ) {
        return;
      }

      // 3. 内部回环锁：当前 cd 是本组件引发的，忽略终端回显的 OSC 7
      if (deps.pathSync.internal) {
        return;
      }

      const newCwd = payload.cwd;
      if (!newCwd || !newCwd.startsWith('/')) {
        return;
      }

      const normNew = deps.normalizePath(newCwd);
      const normCur = deps.normalizePath(deps.currentSftpManager.value?.currentPath.value);

      if (normNew === normCur) {
        return;
      }

      // 启用防回环锁，防止 loadDirectory 后再次反向触发向终端 cd
      deps.pathSync.internal = true;
      deps.pathSync.lastSyncedPath = normNew;
      if (deps.pathSync.lockTimer) clearTimeout(deps.pathSync.lockTimer);
      deps.pathSync.lockTimer = setTimeout(() => {
        deps.pathSync.internal = false;
      }, 600);

      console.log(`${logFolder} 响应终端目录变更，自动切换文件管理器路径: ${normNew}`);
      deps.currentSftpManager.value?.loadDirectory(normNew);
    };
    subscribeToWorkspaceEvent('terminal:cwdChanged', handleTerminalCwdChangedNotification);
    unregisters.push(() =>
      unsubscribeFromWorkspaceEvent('terminal:cwdChanged', handleTerminalCwdChangedNotification)
    );

    // 同组件实例跨会话：目录树显隐联动
    const handleSetDirectoryTreeVisibleNotification = (payload: {
      instanceId: string;
      show: boolean;
    }) => {
      if (
        payload.instanceId === deps.effectiveInstanceId.value &&
        deps.showDirectoryTree.value !== payload.show
      ) {
        deps.showDirectoryTree.value = payload.show;
      }
    };
    subscribeToWorkspaceEvent(
      'fileManager:setDirectoryTreeVisible',
      handleSetDirectoryTreeVisibleNotification
    );
    unregisters.push(() =>
      unsubscribeFromWorkspaceEvent(
        'fileManager:setDirectoryTreeVisible',
        handleSetDirectoryTreeVisibleNotification
      )
    );

    // 同组件实例跨会话：目录树宽度联动
    const handleSetDirectoryTreeWidthNotification = (payload: {
      instanceId: string;
      width: number;
    }) => {
      if (
        payload.instanceId === deps.effectiveInstanceId.value &&
        deps.directoryTreeWidth.value !== payload.width
      ) {
        deps.directoryTreeWidth.value = payload.width;
      }
    };
    subscribeToWorkspaceEvent(
      'fileManager:setDirectoryTreeWidth',
      handleSetDirectoryTreeWidthNotification
    );
    unregisters.push(() =>
      unsubscribeFromWorkspaceEvent(
        'fileManager:setDirectoryTreeWidth',
        handleSetDirectoryTreeWidthNotification
      )
    );

    // 同组件实例跨会话：视图模式联动
    const handleSetViewModeNotification = (payload: {
      instanceId: string;
      viewMode: 'list' | 'tile';
    }) => {
      if (
        payload.instanceId === deps.effectiveInstanceId.value &&
        deps.viewMode.value !== payload.viewMode
      ) {
        deps.viewMode.value = payload.viewMode;
      }
    };
    subscribeToWorkspaceEvent('fileManager:setViewMode', handleSetViewModeNotification);
    unregisters.push(() =>
      unsubscribeFromWorkspaceEvent('fileManager:setViewMode', handleSetViewModeNotification)
    );

    // 移动完成广播：当前目录是源或目标时静默刷新
    const handleItemsMovedNotification = (payload: {
      sessionId: string;
      sourceDir: string;
      targetDir: string;
    }) => {
      if (payload.sessionId === deps.sessionId) {
        const current = deps.currentSftpManager.value?.currentPath.value;
        if (current && (current === payload.sourceDir || current === payload.targetDir)) {
          console.log(`${logFolder} 收到移动文件广播，自动静默刷新当前目录: ${current}`);
          deps.currentSftpManager.value?.loadDirectory(current, true);
        }
      }
    };
    subscribeToWorkspaceEvent('fileManager:itemsMoved', handleItemsMovedNotification);
    unregisters.push(() =>
      unsubscribeFromWorkspaceEvent('fileManager:itemsMoved', handleItemsMovedNotification)
    );

    // 跳转到指定路径（带 sessionId / instanceId 双重过滤，避免多分屏互串）
    const handleNavigateToPathNotification = (payload: {
      path: string;
      sessionId?: string;
      instanceId?: string;
    }) => {
      if (payload.sessionId && payload.sessionId !== deps.sessionId) {
        return;
      }
      if (payload.instanceId && payload.instanceId !== deps.instanceId) {
        return;
      }
      if (payload.path && deps.currentSftpManager.value) {
        console.log(`${logFolder} 收到路径跳转通知: ${payload.path}`);
        deps.currentSftpManager.value.loadDirectory(payload.path);
        deps.currentSftpManager.value.setInitialLoadDone(true);
      }
    };
    subscribeToWorkspaceEvent('fileManager:navigateToPath', handleNavigateToPathNotification);
    unregisters.push(() =>
      unsubscribeFromWorkspaceEvent('fileManager:navigateToPath', handleNavigateToPathNotification)
    );

    // 焦点切换器：搜索框 / 路径输入框
    unregisters.push(
      deps.registerFocusAction('fileManagerSearch', async () => {
        if (deps.sessionId === deps.activeSessionId()) {
          return deps.focusSearchInput();
        }
        return undefined;
      })
    );
    unregisters.push(
      deps.registerFocusAction('fileManagerPathInput', async () => {
        if (deps.sessionId === deps.activeSessionId()) {
          deps.startPathEdit();
          return true;
        }
        return undefined;
      })
    );
  });

  onBeforeUnmount(() => {
    if (directoryPollTimer) {
      clearInterval(directoryPollTimer);
      directoryPollTimer = null;
    }
    if (terminalDebounceTimer) {
      clearTimeout(terminalDebounceTimer);
      terminalDebounceTimer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
    if (deps.pathSync.lockTimer) {
      clearTimeout(deps.pathSync.lockTimer);
      deps.pathSync.lockTimer = null;
    }
    // 成对注销：漏一个就会在"切面板再打开"后叠一层监听
    while (unregisters.length > 0) {
      const off = unregisters.pop();
      try {
        off?.();
      } catch (err) {
        console.warn(`${logFolder} 注销工作区事件失败:`, err);
      }
    }
  });

  return { checkAndPollCurrentDirectory };
}
