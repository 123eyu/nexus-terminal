import type { QuickCommandFE } from '../stores/quickCommands.store';

/**
 * 快捷指令视图里的展示层纯函数（桌面 / 移动共用）。
 *
 * 以前桌面版和移动版各有一份：文件夹颜色解析、命令归属文件夹、文件夹命令数。
 * 两版实现已经开始漂移（移动版不支持 'all' / 'untagged'），这类漂移不会报错，
 * 只会表现成"桌面显示绿色、手机没颜色"这种难查的问题。
 */

export interface FolderColorSource {
  id: number;
  background_color?: string | null;
}

/** 文件夹自定义底色；没有则回落到 null（由调用方决定默认色） */
export function resolveFolderColor(
  folders: ReadonlyArray<FolderColorSource>,
  tagId?: number | null
): string | null {
  if (!tagId) return null;
  const folder = folders.find((f) => f.id === tagId);
  return folder?.background_color || null;
}

/**
 * 一条命令当前归属的文件夹底色。
 *
 * 优先用分组传入的 tagId（列表按文件夹分组渲染时），
 * 否则按命令自己的第一个 tagIds 取。
 */
export function resolveCommandFolderColor(
  folders: ReadonlyArray<FolderColorSource>,
  cmd: Pick<QuickCommandFE, 'tagIds'>,
  groupTagId?: number | null
): string | null {
  if (typeof groupTagId === 'number') {
    return resolveFolderColor(folders, groupTagId);
  }
  if (cmd.tagIds && cmd.tagIds.length > 0) {
    return resolveFolderColor(folders, cmd.tagIds[0]);
  }
  return null;
}

/**
 * 文件夹里有多少条命令。
 *
 * 'all' = 全部；'untagged' = 没有任何标签的；数字 = 该标签下的。
 */
export function countCommandsInFolder(
  commands: ReadonlyArray<Pick<QuickCommandFE, 'tagIds'>>,
  folderId: number | 'all' | 'untagged'
): number {
  if (folderId === 'all') return commands.length;
  if (folderId === 'untagged') {
    return commands.filter((cmd) => !cmd.tagIds || cmd.tagIds.length === 0).length;
  }
  return commands.filter((cmd) => cmd.tagIds && cmd.tagIds.includes(folderId)).length;
}
