import { getDbInstance, runDb, getDb as getDbRow, allDb } from '../database/connection';

// 定义路径历史记录的接口
export interface PathHistoryEntry {
    id: number;
    path: string;
    /** 归属主机（连接 uuid）。老记录为 NULL，不再出现在任何主机的列表里。 */
    connection_uuid: string | null;
    timestamp: number; // Unix 时间戳 (秒)
}

type DbPathHistoryRow = PathHistoryEntry;

/**
 * 插入或更新一条路径历史记录。
 *
 * **按 (path, connection_uuid) 唯一**：同一路径在不同主机上是两条独立记录 ——
 * 以前只按 path 去重，A 机跑过的 /var/log 会出现在 B 机的历史里。
 *
 * @param path - 要添加或更新的路径字符串
 * @param connectionUuid - 归属主机；为空时退化成无归属记录（不会显示给任何主机）
 */
export const upsertPath = async (path: string, connectionUuid: string | null = null): Promise<number> => {
    const now = Math.floor(Date.now() / 1000); // 获取当前时间戳
    const db = await getDbInstance();

    try {
        // 1. 尝试更新现有记录的时间戳（`IS` 才能正确比较 NULL）
        const updateSql = `UPDATE path_history SET timestamp = ? WHERE path = ? AND connection_uuid IS ?`;
        const updateResult = await runDb(db, updateSql, [now, path, connectionUuid]);

        if (updateResult.changes > 0) {
            // 更新成功，需要获取被更新记录的 ID
            const selectSql = `SELECT id FROM path_history WHERE path = ? AND connection_uuid IS ? ORDER BY timestamp DESC LIMIT 1`;
            const row = await getDbRow<{ id: number }>(db, selectSql, [path, connectionUuid]);
            if (row) {
                return row.id;
            }
            throw new Error('更新成功但无法找到记录 ID');
        }

        // 2. 没有记录被更新，说明该主机下还没有这个路径，执行插入
        const insertSql = `INSERT INTO path_history (path, connection_uuid, timestamp) VALUES (?, ?, ?)`;
        const insertResult = await runDb(db, insertSql, [path, connectionUuid, now]);
        if (typeof insertResult.lastID !== 'number' || insertResult.lastID <= 0) {
            throw new Error('插入新路径历史记录后未能获取有效的 lastID');
        }
        return insertResult.lastID;
    } catch (err: any) {
        console.error('Upsert 路径历史记录时出错:', err.message);
        throw new Error('无法更新或插入路径历史记录');
    }
};

/**
 * 获取**某一台主机**的路径历史记录，按时间戳升序排列（最旧的在前）。
 *
 * 不传 connectionUuid 时返回空数组：历史已按主机隔离，
 * 回落到「全量」等于把 A 机的路径泄漏到 B 机，正是这次要修的问题。
 */
export const getAllPaths = async (connectionUuid: string | null = null): Promise<PathHistoryEntry[]> => {
    if (!connectionUuid) return [];
    const sql = `SELECT id, path, connection_uuid, timestamp FROM path_history WHERE connection_uuid = ? ORDER BY timestamp ASC`;
    try {
        const db = await getDbInstance();
        return await allDb<DbPathHistoryRow>(db, sql, [connectionUuid]);
    } catch (err: any) {
        console.error('获取路径历史记录时出错:', err.message);
        throw new Error('无法获取路径历史记录');
    }
};

/**
 * 根据 ID 删除指定的路径历史记录
 */
export const deletePathById = async (id: number): Promise<boolean> => {
    const sql = `DELETE FROM path_history WHERE id = ?`;
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, [id]);
        return result.changes > 0;
    } catch (err: any) {
        console.error('删除路径历史记录时出错:', err.message);
        throw new Error('无法删除路径历史记录');
    }
};

/**
 * 清空历史记录。传 connectionUuid 只清那台主机的，不传则全清。
 */
export const clearAllPaths = async (connectionUuid: string | null = null): Promise<number> => {
    const sql = connectionUuid
        ? `DELETE FROM path_history WHERE connection_uuid = ?`
        : `DELETE FROM path_history`;
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, connectionUuid ? [connectionUuid] : []);
        return result.changes;
    } catch (err: any) {
        console.error('清空路径历史记录时出错:', err.message);
        throw new Error('无法清空路径历史记录');
    }
};
