// packages/backend/src/sync/tombstone.service.ts
import { getDbInstance, runDb, allDb } from '../database/connection';

export interface TombstoneRecord {
  entity_type: string;
  uuid: string;
  deleted_at: number;
}

export async function recordTombstone(entityType: string, uuid: string, deletedAt?: number): Promise<void> {
  if (!uuid) return;
  try {
    const db = await getDbInstance();
    const timeToRecord = deletedAt !== undefined ? deletedAt : Math.floor(Date.now() / 1000);
    await runDb(
      db,
      `INSERT OR REPLACE INTO sync_tombstones (tbl, row_id, deleted_hlc, deleted_at) VALUES (?, ?, ?, ?)`,
      [entityType, uuid, `${Date.now()}-00000-del`, timeToRecord]
    );
  } catch (err: any) {
    console.warn(`[Tombstone] 记录实体 ${entityType}:${uuid} 删除墓碑失败:`, err.message);
  }
}

export async function getTombstonesSince(sinceTimestamp: number = 0): Promise<TombstoneRecord[]> {
  try {
    const db = await getDbInstance();
    const rows = await allDb<{ tbl: string; row_id: string; deleted_at: number }>(
      db,
      `SELECT tbl, row_id, deleted_at FROM sync_tombstones WHERE deleted_at > ? ORDER BY deleted_at ASC`,
      [sinceTimestamp]
    );
    return rows.map(r => ({
      entity_type: r.tbl,
      uuid: r.row_id,
      deleted_at: r.deleted_at
    }));
  } catch (err: any) {
    console.warn('[Tombstone] 获取墓碑列表失败:', err.message);
    return [];
  }
}

export async function cleanOldTombstones(daysToKeep: number = 30): Promise<void> {
  try {
    const db = await getDbInstance();
    const cutoff = Math.floor(Date.now() / 1000) - daysToKeep * 86400;
    await runDb(db, `DELETE FROM sync_tombstones WHERE deleted_at < ?`, [cutoff]);
  } catch (err: any) {}
}
