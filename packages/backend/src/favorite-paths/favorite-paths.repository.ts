import { getDbInstance, runDb, getDb as getDbRow, allDb } from '../database/connection';

// 定义收藏路径接口
export interface FavoritePath {
    id: number;
    name: string | null; // 名称可选
    path: string;
    /**
     * 收藏的是文件还是目录（0/1）。
     * 前端据此决定点击是「打开文件」还是「跳转目录」；老记录默认 0（目录）。
     */
    is_file: number;
    /**
     * 'global' = 所有主机都能看到；'host' = 只对 connection_uuid 那台主机可见。
     * 老数据迁移后一律是 'global'。
     */
    scope: 'global' | 'host';
    /** scope = 'host' 时的归属主机（连接 uuid，跨端稳定） */
    connection_uuid: string | null;
    last_used_at?: number | null; // 上次使用时间，允许为空
    created_at: number; // Unix 时间戳 (秒)
    updated_at: number; // Unix 时间戳 (秒)
}

/**
 * 添加一条新的收藏路径
 * @param name - 路径名称 (可选)
 * @param path - 路径内容
 * @param isFile - 是否收藏的是文件
 * @returns 返回插入记录的 ID
 */
export const addFavoritePath = async (
    name: string | null,
    path: string,
    isFile = false,
    scope: 'global' | 'host' = 'global',
    connectionUuid: string | null = null
): Promise<number> => {
    const finalScope = scope === 'host' ? 'host' : 'global';
    const sql = `INSERT INTO favorite_paths (name, path, is_file, scope, connection_uuid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))`;
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, [
            name,
            path,
            isFile ? 1 : 0,
            finalScope,
            finalScope === 'host' ? connectionUuid : null,
        ]);
        if (typeof result.lastID !== 'number' || result.lastID <= 0) {
             throw new Error('添加收藏路径后未能获取有效的 lastID');
        }
        return result.lastID;
    } catch (err: any) {
        console.error('添加收藏路径时出错:', err.message);
        throw new Error('无法添加收藏路径');
    }
};

/**
 * 更新指定的收藏路径
 * @param id - 要更新的记录 ID
 * @param name - 新的路径名称 (可选)
 * @param path - 新的路径内容
 * @param isFile - 是否收藏的是文件
 * @returns 返回是否成功更新 (true/false)
 */
export const updateFavoritePath = async (
    id: number,
    name: string | null,
    path: string,
    isFile = false,
    scope: 'global' | 'host' = 'global',
    connectionUuid: string | null = null
): Promise<boolean> => {
    const finalScope = scope === 'host' ? 'host' : 'global';
    const sql = `UPDATE favorite_paths SET name = ?, path = ?, is_file = ?, scope = ?, connection_uuid = ?, updated_at = strftime('%s', 'now') WHERE id = ?`;
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, [
            name,
            path,
            isFile ? 1 : 0,
            finalScope,
            finalScope === 'host' ? connectionUuid : null,
            id,
        ]);
        return result.changes > 0;
    } catch (err: any) {
        console.error('更新收藏路径时出错:', err.message);
        throw new Error('无法更新收藏路径');
    }
};

/**
 * 根据 ID 删除指定的收藏路径
 * @param id - 要删除的记录 ID
 * @returns 返回是否成功删除 (true/false)
 */
export const deleteFavoritePath = async (id: number): Promise<boolean> => {
    const sql = `DELETE FROM favorite_paths WHERE id = ?`;
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, [id]);
        return result.changes > 0;
    } catch (err: any) {
        console.error('删除收藏路径时出错:', err.message);
        throw new Error('无法删除收藏路径');
    }
};

/**
 * 获取所有收藏路径
 * @param sortBy - 排序字段 ('name' 或 'usage_count')
 * @returns 返回包含所有收藏路径条目的数组
 */
export const getAllFavoritePaths = async (sortBy: 'name' | 'last_used_at' = 'name'): Promise<FavoritePath[]> => {
    let orderByClause = 'ORDER BY name ASC'; // 默认按名称升序
    if (sortBy === 'last_used_at') {
        orderByClause = 'ORDER BY last_used_at DESC, name ASC'; // 按上次使用时间降序，同时间的按名称升序
    }
    const sql = `SELECT id, name, path, is_file, scope, connection_uuid, last_used_at, created_at, updated_at FROM favorite_paths ${orderByClause}`;
    try {
        const db = await getDbInstance();
        const rows = await allDb<FavoritePath>(db, sql);
        return rows;
    } catch (err: any) {
        console.error('获取收藏路径时出错:', err.message);
        throw new Error('无法获取收藏路径');
    }
};

/**
 * 更新指定收藏路径的上次使用时间
 * @param id - 要更新的记录 ID
 * @returns 返回是否成功更新 (true/false)
 */
export const updateFavoritePathLastUsedAt = async (id: number): Promise<boolean> => {
    const sql = `UPDATE favorite_paths SET last_used_at = strftime('%s', 'now'), updated_at = strftime('%s', 'now') WHERE id = ?`;
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, [id]);
        return result.changes > 0;
    } catch (err: any) {
        console.error('更新收藏路径上次使用时间时出错:', err.message);
        throw new Error('无法更新收藏路径上次使用时间');
    }
};

/**
 * 根据 ID 查找收藏路径
 * @param id - 要查找的记录 ID
 * @returns 返回找到的收藏路径条目，如果未找到则返回 undefined
 */
export const findFavoritePathById = async (id: number): Promise<FavoritePath | undefined> => {
    const sql = `SELECT id, name, path, is_file, scope, connection_uuid, last_used_at, created_at, updated_at FROM favorite_paths WHERE id = ?`;
    try {
        const db = await getDbInstance();
        const row = await getDbRow<FavoritePath>(db, sql, [id]);
        return row;
    } catch (err: any) {
        console.error('查找收藏路径时出错:', err.message);
        throw new Error('无法查找收藏路径');
    }
};
/** 批量迁移（移动 / 复制）收藏到另一个作用域的统计结果 */
export interface FavoritePathTransferResult {
    /** 成功改归属的条数（move） */
    moved: number;
    /** 成功新建副本的条数（copy） */
    copied: number;
    /** 目标位置已存在同路径、或源记录已不存在而跳过的条数 */
    skipped: number;
}

/**
 * 把一批收藏「移动 / 复制」到另一个作用域。
 *
 * 目标位置用 `(path, scope, connection_uuid)` 判重：两处都有同一个路径时，
 * 移动等于无操作、复制会多出一条谁也分不清的重复书签 —— 两种都直接跳过，
 * 由调用方把 skipped 报给用户。
 *
 * 全程一个事务：中途失败就整体回滚，不留下「移了一半」的状态。
 */
export const transferFavoritePaths = async (
    ids: number[],
    mode: 'move' | 'copy',
    targetScope: 'global' | 'host',
    targetConnectionUuid: string | null
): Promise<FavoritePathTransferResult> => {
    const finalScope: 'global' | 'host' = targetScope === 'host' ? 'host' : 'global';
    const finalUuid = finalScope === 'host' ? targetConnectionUuid : null;
    const result: FavoritePathTransferResult = { moved: 0, copied: 0, skipped: 0 };
    const db = await getDbInstance();

    await runDb(db, 'BEGIN TRANSACTION');
    try {
        for (const id of ids) {
            const row = await getDbRow<FavoritePath>(
                db,
                `SELECT id, name, path, is_file, scope, connection_uuid, last_used_at, created_at, updated_at
                 FROM favorite_paths WHERE id = ?`,
                [id]
            );
            if (!row) {
                result.skipped += 1;
                continue;
            }

            const duplicate = await getDbRow<{ id: number }>(
                db,
                `SELECT id FROM favorite_paths
                 WHERE path = ? AND scope = ? AND IFNULL(connection_uuid, '') = ? AND id <> ?
                 LIMIT 1`,
                [row.path, finalScope, finalUuid ?? '', id]
            );
            if (duplicate) {
                result.skipped += 1;
                continue;
            }

            if (mode === 'move') {
                await runDb(
                    db,
                    `UPDATE favorite_paths
                     SET scope = ?, connection_uuid = ?, updated_at = strftime('%s', 'now')
                     WHERE id = ?`,
                    [finalScope, finalUuid, id]
                );
                result.moved += 1;
            } else {
                await runDb(
                    db,
                    `INSERT INTO favorite_paths (name, path, is_file, scope, connection_uuid, last_used_at, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))`,
                    [row.name, row.path, row.is_file, finalScope, finalUuid, row.last_used_at ?? null]
                );
                result.copied += 1;
            }
        }
        await runDb(db, 'COMMIT');
        return result;
    } catch (err: any) {
        await runDb(db, 'ROLLBACK').catch(() => {});
        console.error('迁移收藏路径时出错:', err.message);
        throw new Error('无法迁移收藏路径');
    }
};
