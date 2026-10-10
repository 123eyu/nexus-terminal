// packages/backend/src/sync/tombstone.service.ts
import { getDbInstance, runDb, allDb } from '../database/connection';

export interface TombstoneRecord {
  id?: number;
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
      `INSERT INTO sync_tombstones (entity_type, uuid, deleted_at) VALUES (?, ?, ?)`,
      [entityType, uuid, timeToRecord]
    );
  } catch (err: any) {
    console.warn(`[Tombstone] 记录实体 ${entityType}:${uuid} 删除墓碑失败:`, err.message);
  }
}

export async function getTombstonesSince(sinceTimestamp: number = 0): Promise<TombstoneRecord[]> {
  try {
    const db = await getDbInstance();
    return await allDb<TombstoneRecord>(
      db,
      `SELECT id, entity_type, uuid, deleted_at FROM sync_tombstones WHERE deleted_at > ? ORDER BY deleted_at ASC`,
      [sinceTimestamp]
    );
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
