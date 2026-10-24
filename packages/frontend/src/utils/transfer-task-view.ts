/**
 * 传输任务的「展示模型」：把后端返回的原始任务拍平成模板直接用的一组字段。
 *
 * 为什么要单独抽：卡片上要回答的是「**哪台服务器上的什么** → **哪台服务器上的哪个路径**」，
 * 而原始数据结构是 sourceConnectionId + targetConnectionIds + sourceItems + subTasks 四份拼起来才够。
 * 桌面弹窗和移动弹窗都要这套拼接，写两份必然漂移。
 */

import { resolveTransferTone, type TransferTone } from './transfer-status';

export interface TransferSourceItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export interface TransferTaskLike {
  taskId: string;
  status: string;
  createdAt: string | Date;
  subTasks?: Array<{
    subTaskId: string;
    connectionId: number;
    sourceItemName: string;
    status: string;
    progress?: number;
    message?: string;
    transferMethodUsed?: 'rsync' | 'scp' | 'relay';
  }>;
  overallProgress?: number;
  sourceConnectionId?: number;
  remoteTargetPath?: string;
  /** 后端 serializeTask 提供；老版本后端没有这两个字段 */
  targetConnectionIds?: number[];
  sourceItems?: TransferSourceItem[];
}

type TFn = {
  (key: string, fallback: string): string;
  (key: string, named: Record<string, unknown>, fallback: string): string;
};

export interface TransferTaskViewOptions {
  /** vue-i18n 的 t（三参：key, named, fallback） */
  t: TFn;
  getConnectionName: (connectionId: number) => string;
  /** 目标服务器最多并排显示几个，多的收成 `+N` */
  maxTargetNames?: number;
}

export interface TransferTaskView {
  tone: TransferTone;
  /** 卡片主标题，多条目时是「A 等 3 项」 */
  primaryName: string;
  primaryNameTitle: string;
  icon: string;
  sourceName: string;
  /** 已按 maxTargetNames 截断的目标服务器名 */
  targetNames: string[];
  /** 被 `+N` 收起来的目标数 */
  hiddenTargetCount: number;
  allTargetNames: string[];
  targetPathLabel: string;
  /** 传给浏览器原生 tooltip 的完整描述 */
  routeTitle: string;
  /** 路径行的 tooltip（源路径 → 目标路径） */
  pathTitle: string;
  methods: string[];
  /** 源路径（单条目时可用，多条目时给 null） */
  sourcePath: string | null;
}

/** 去重但保留出现顺序 */
function unique<T>(list: T[]): T[] {
  return [...new Set(list)];
}

export function buildTransferTaskView(
  task: TransferTaskLike,
  options: TransferTaskViewOptions
): TransferTaskView {
  const { t, getConnectionName, maxTargetNames = 2 } = options;

  const subTasks = task.subTasks || [];

  // --- 条目名 ---
  const itemNames = unique(subTasks.map(st => st.sourceItemName).filter(Boolean));
  const declaredItems = task.sourceItems || [];
  const effectiveItemNames = itemNames.length > 0 ? itemNames : declaredItems.map(i => i.name);
  const firstItemName = effectiveItemNames[0] || '';

  let primaryName = firstItemName || t('transferProgressModal.unknownFileName', '[文件名未知]');
  if (effectiveItemNames.length > 1) {
    primaryName = t(
      'transferProgressModal.task.multiItems',
      { name: firstItemName, count: effectiveItemNames.length },
      `${firstItemName} 等 ${effectiveItemNames.length} 项`
    );
  }

  // 源路径只在「单个条目」时才有意义，多条目时不展示
  const sourcePath = declaredItems.length === 1 ? declaredItems[0].path || null : null;

  // --- 源服务器 ---
  const sourceName = task.sourceConnectionId
    ? getConnectionName(task.sourceConnectionId)
    : t('transferProgressModal.localSource', '本机');

  // --- 目标服务器：优先用后端给的去重列表，老数据回落到 subTasks ---
  const targetIds = task.targetConnectionIds && task.targetConnectionIds.length > 0
    ? task.targetConnectionIds
    : unique(subTasks.map(st => st.connectionId).filter(id => typeof id === 'number'));

  const allTargetNames = targetIds.map(id => getConnectionName(id));
  const targetNames = allTargetNames.slice(0, maxTargetNames);
  const hiddenTargetCount = Math.max(0, allTargetNames.length - targetNames.length);

  const targetPathLabel = task.remoteTargetPath
    || t('transferProgressModal.unknownTargetPath', '[目标路径未知]');

  // --- 传输方式 ---
  const methods = unique(
    subTasks.map(st => st.transferMethodUsed).filter((m): m is 'rsync' | 'scp' | 'relay' => !!m)
  );

  const routeTitle = `${sourceName} → ${allTargetNames.join(', ') || '?'}: ${targetPathLabel}`;

  return {
    tone: resolveTransferTone(task.status),
    primaryName,
    primaryNameTitle: effectiveItemNames.join(', ') || primaryName,
    icon: effectiveItemNames.length > 1 ? 'fa-layer-group' : (declaredItems[0]?.type === 'directory' ? 'fa-folder' : 'fa-file-alt'),
    sourceName,
    targetNames,
    hiddenTargetCount,
    allTargetNames,
    targetPathLabel,
    routeTitle,
    pathTitle: sourcePath ? `${sourcePath} → ${targetPathLabel}` : targetPathLabel,
    methods,
    sourcePath,
  };
}
