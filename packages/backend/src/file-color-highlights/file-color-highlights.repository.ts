import { getDbInstance, runDb, allDb, getDb } from '../database/connection';

export interface FileColorHighlightRecord {
  id: number;
  connection_id: number;
  path: string;
  color: string;
  created_at: number;
  updated_at: number;
  uuid?: string | null;
  updated_hlc?: string | null;
}

/**
 * 获取指定连接下的所有文件与文件夹颜色高亮记录
 */
export const getFileColorHighlightsByConnectionId = async (
  connectionId: number
): Promise<FileColorHighlightRecord[]> => {
  const db = await getDbInstance();
  const sql = `SELECT * FROM file_color_highlights WHERE connection_id = ? ORDER BY path ASC`;
  return allDb<FileColorHighlightRecord>(db, sql, [connectionId]);
};

/**
 * 获取指定连接下特定路径的颜色高亮记录
 */
export const getFileColorHighlight = async (
  connectionId: number,
  path: string
): Promise<FileColorHighlightRecord | undefined> => {
  const db = await getDbInstance();
  const sql = `SELECT * FROM file_color_highlights WHERE connection_id = ? AND path = ? LIMIT 1`;
  return getDb<FileColorHighlightRecord>(db, sql, [connectionId, path]);
};

/**
 * 插入或更新文件/文件夹的颜色高亮
 */
export const upsertFileColorHighlight = async (
  connectionId: number,
  path: string,
  color: string
): Promise<FileColorHighlightRecord> => {
  const db = await getDbInstance();
  const now = Math.floor(Date.now() / 1000);

  const upsertSql = `
    INSERT INTO file_color_highlights (connection_id, path, color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(connection_id, path) DO UPDATE SET
      color = excluded.color,
      updated_at = excluded.updated_at
  `;

  await runDb(db, upsertSql, [connectionId, path, color, now, now]);

  const record = await getFileColorHighlight(connectionId, path);
  if (!record) {
    throw new Error('保存颜色高亮后无法读取记录');
  }
  return record;
};

/**
 * 删除指定路径的颜色高亮
 */
export const deleteFileColorHighlight = async (
  connectionId: number,
  path: string
): Promise<boolean> => {
  const db = await getDbInstance();
  const sql = `DELETE FROM file_color_highlights WHERE connection_id = ? AND path = ?`;
  const result = await runDb(db, sql, [connectionId, path]);
  return result.changes > 0;
};

/**
 * 清空指定连接的所有颜色高亮
 */
export const clearFileColorHighlightsByConnectionId = async (
  connectionId: number
): Promise<number> => {
  const db = await getDbInstance();
  const sql = `DELETE FROM file_color_highlights WHERE connection_id = ?`;
  const result = await runDb(db, sql, [connectionId]);
  return result.changes;
};
