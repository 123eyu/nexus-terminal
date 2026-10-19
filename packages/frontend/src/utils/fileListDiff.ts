import type { FileAttributes, FileListItem } from '../types/sftp.types';

/**
 * 目录列表的增量比对（纯函数）。
 *
 * 这段判断以前直接写在 useSftpActions 的 readdir 回调里，既没法测试，
 * 又和 reactive()/定时器缠在一起。实际踩过的坑：
 *   - "返回到没加载过的父目录"被当成全部新增 → 整页闪绿
 *     （调用方的 childrenLoaded 判断负责区分，这里只保证"加载过才 diff"的语义不被破坏）；
 *   - 只有 size/mtime/mode/类型 变化才算"更新"，漏一项就会漏高亮。
 *
 * 这里只负责算出"哪些删了 / 改了 / 加了"，而对象原地修改与高亮定时器留在调用方，
 * 因为它们必须保持节点对象引用稳定（否则表格行/xterm 会被重建）。
 */

export interface DiffableFileNode {
  filename: string;
  longname: string;
  attrs: FileAttributes;
  /** 高亮标记：新增/修改的时间戳，由调用方写入并定时清除 */
  _justAdded?: number;
  _justUpdated?: number;
}

export interface DirectoryDiff {
  /** 服务端已删除的文件名 */
  removed: string[];
  /** 属性发生变化、需要在原地更新的节点（附上服务端的最新条目） */
  updated: { node: DiffableFileNode; item: FileListItem }[];
  /** 新增的文件（调用方负责创建节点） */
  added: FileListItem[];
}

/**
 * 判断两个同名条目的属性是否变化到需要高亮提示。
 * 只比较会影响展示的字段：大小、修改时间、权限、类型。
 */
export function fileAttributesChanged(
  existing: FileAttributes,
  incoming: FileAttributes
): boolean {
  return existing.size !== incoming.size
    || existing.mtime !== incoming.mtime
    || existing.mode !== incoming.mode
    || existing.isDirectory !== incoming.isDirectory
    || existing.isFile !== incoming.isFile
    || existing.isSymbolicLink !== incoming.isSymbolicLink;
}

/** 计算目录内条目相对上一份列表的变化 */
export function diffDirectoryChildren(
  existingChildren: readonly DiffableFileNode[],
  incoming: readonly FileListItem[]
): DirectoryDiff {
  const incomingByName = new Map(incoming.map((item) => [item.filename, item]));
  const existingByName = new Map(existingChildren.map((node) => [node.filename, node]));

  const removed = existingChildren
    .filter((node) => !incomingByName.has(node.filename))
    .map((node) => node.filename);

  const updated: { node: DiffableFileNode; item: FileListItem }[] = [];
  const added: FileListItem[] = [];

  for (const item of incoming) {
    const node = existingByName.get(item.filename);
    if (!node) {
      added.push(item);
      continue;
    }
    if (fileAttributesChanged(node.attrs, item.attrs)) {
      updated.push({ node, item });
    }
  }

  return { removed, updated, added };
}
