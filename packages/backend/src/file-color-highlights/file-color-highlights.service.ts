import * as repository from './file-color-highlights.repository';
import { getDbInstance, runDb } from '../database/connection';

/**
 * 标准化路径，确保前后端与不同格式路径能够精准匹配
 */
export const normalizePath = (p: string): string => {
  if (!p) return '';
  let normalized = p.trim().replace(/\\/g, '/');
  // 压缩多重斜杠
  normalized = normalized.replace(/\/+/g, '/');
  // 若非根目录且末尾带斜杠，则移除末尾斜杠
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
};

/**
 * 触动对应连接的 updated_at 时间戳，触发增量同步
 */
const touchConnectionUpdatedTime = async (connectionId: number): Promise<void> => {
  try {
    const db = await getDbInstance();
    const now = Math.floor(Date.now() / 1000);
    await runDb(db, `UPDATE connections SET updated_at = ? WHERE id = ?`, [now, connectionId]);
  } catch (err: any) {
    console.warn(`[FileColorHighlights] 触动连接 ${connectionId} updated_at 失败:`, err.message);
  }
};

/**
 * 获取指定连接下的所有颜色高亮配置映射表 (path -> color)
 */
export const getHighlightsMap = async (connectionId: number): Promise<Record<string, string>> => {
  const records = await repository.getFileColorHighlightsByConnectionId(connectionId);
  const result: Record<string, string> = {};
  for (const rec of records) {
    result[rec.path] = rec.color;
  }
  return result;
};

/**
 * 获取指定连接下的所有高亮记录列表
 */
export const getHighlights = async (
  connectionId: number
): Promise<repository.FileColorHighlightRecord[]> => {
  return repository.getFileColorHighlightsByConnectionId(connectionId);
};

/**
 * 设置或更新指定文件/文件夹的高亮颜色
 */
export const setHighlight = async (
  connectionId: number,
  rawPath: string,
  color: string
): Promise<repository.FileColorHighlightRecord> => {
  const path = normalizePath(rawPath);
  if (!path) {
    throw new Error('路径不能为空');
  }
  if (!color || typeof color !== 'string' || color.trim().length === 0) {
    throw new Error('颜色值不能为空');
  }

  const trimmedColor = color.trim();
  const record = await repository.upsertFileColorHighlight(connectionId, path, trimmedColor);
  await touchConnectionUpdatedTime(connectionId);
  return record;
};

/**
 * 删除指定路径的高亮颜色
 */
export const removeHighlight = async (connectionId: number, rawPath: string): Promise<boolean> => {
  const path = normalizePath(rawPath);
  if (!path) {
    throw new Error('路径不能为空');
  }

  const success = await repository.deleteFileColorHighlight(connectionId, path);
  if (success) {
    await touchConnectionUpdatedTime(connectionId);
  }
  return success;
};

/**
 * 清除指定连接下的全部高亮颜色
 */
export const clearAllHighlights = async (connectionId: number): Promise<number> => {
  const count = await repository.clearFileColorHighlightsByConnectionId(connectionId);
  if (count > 0) {
    await touchConnectionUpdatedTime(connectionId);
  }
  return count;
};
