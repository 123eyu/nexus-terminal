import { Database } from 'sqlite3';
import { getDbInstance, runDb, getDb as getDbRow, allDb } from '../database/connection';

// 定义 Quick Command Tag 类型
export interface QuickCommandTag {
    id: number;
    name: string;
    background_color?: string | null;
    created_at: number;
    updated_at: number;
}

/**
 * 获取所有快捷指令标签
 */
export const findAllQuickCommandTags = async (): Promise<QuickCommandTag[]> => {
    try {
        const db = await getDbInstance();
        const rows = await allDb<QuickCommandTag>(db, `SELECT * FROM quick_command_tags ORDER BY name ASC`);
        return rows;
    } catch (err: any) {
        console.error('[仓库] 查询快捷指令标签列表时出错:', err.message);
        throw new Error('获取快捷指令标签列表失败');
    }
};

/**
 * 根据 ID 获取单个快捷指令标签
 */
export const findQuickCommandTagById = async (id: number): Promise<QuickCommandTag | null> => {
     try {
        const db = await getDbInstance();
        const row = await getDbRow<QuickCommandTag>(db, `SELECT * FROM quick_command_tags WHERE id = ?`, [id]);
        return row || null;
     } catch (err: any) {
        console.error(`[仓库] 查询快捷指令标签 ${id} 时出错:`, err.message);
        throw new Error('获取快捷指令标签信息失败');
     }
 };

/**
 * 创建新快捷指令标签
 */
export const createQuickCommandTag = async (name: string, backgroundColor?: string | null): Promise<number> => {
    const now = Math.floor(Date.now() / 1000);
    const sql = `INSERT INTO quick_command_tags (name, background_color, created_at, updated_at) VALUES (?, ?, ?, ?)`;
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, [name, backgroundColor || null, now, now]);
        if (typeof result.lastID !== 'number' || result.lastID <= 0) {
             throw new Error('创建快捷指令标签后未能获取有效的 lastID');
        }
        return result.lastID;
    } catch (err: any) {
        console.error('[仓库] 创建快捷指令标签时出错:', err.message);
        if (err.message.includes('UNIQUE constraint failed')) {
             throw new Error(`快捷指令标签名称 "${name}" 已存在。`);
        }
        throw new Error(`创建快捷指令标签失败: ${err.message}`);
    }
};

/**
 * 更新快捷指令标签名称与背景颜色
 */
export const updateQuickCommandTag = async (id: number, name?: string, backgroundColor?: string | null): Promise<boolean> => {
    const now = Math.floor(Date.now() / 1000);
    const updates: string[] = ['updated_at = ?'];
    const params: any[] = [now];

    if (typeof name === 'string') {
        updates.push('name = ?');
        params.push(name);
    }
    if (typeof backgroundColor !== 'undefined') {
        updates.push('background_color = ?');
        params.push(backgroundColor || null);
    }
    params.push(id);

    const sql = `UPDATE quick_command_tags SET ${updates.join(', ')} WHERE id = ?`;
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, params);
        return result.changes > 0;
    } catch (err: any) {
         console.error(`[仓库] 更新快捷指令标签 ${id} 时出错:`, err.message);
         if (err.message.includes('UNIQUE constraint failed')) {
             throw new Error(`快捷指令标签名称 "${name}" 已存在。`);
         }
         throw new Error(`更新快捷指令标签失败: ${err.message}`);
    }
};

/**
 * 删除快捷指令标签 (可选择是否连带删除其中的快捷指令)
 * @param id 标签 ID
 * @param deleteCommands 是否连同该标签内的快捷指令一起删除
 */
export const deleteQuickCommandTag = async (id: number, deleteCommands: boolean = false): Promise<boolean> => {
    const db = await getDbInstance();
    try {
        await runDb(db, 'BEGIN TRANSACTION');

        if (deleteCommands) {
            // 找出属于该标签的所有快捷指令 ID
            const rows = await allDb<{ quick_command_id: number }>(
                db,
                'SELECT DISTINCT quick_command_id FROM quick_command_tag_associations WHERE tag_id = ?',
                [id]
            );
            const cmdIds = rows.map(r => r.quick_command_id);
            if (cmdIds.length > 0) {
                const placeholders = cmdIds.map(() => '?').join(',');
                // 1. 删除这些指令相关的全部标签关联
                await runDb(db, `DELETE FROM quick_command_tag_associations WHERE quick_command_id IN (${placeholders})`, cmdIds);
                // 2. 删除快捷指令本体
                await runDb(db, `DELETE FROM quick_commands WHERE id IN (${placeholders})`, cmdIds);
            }
        }

        // 无论是否删除指令，均显式清理该标签在关联表中的记录，确保零孤儿记录残留
        await runDb(db, 'DELETE FROM quick_command_tag_associations WHERE tag_id = ?', [id]);

        // 删除快捷指令标签本身
        const result = await runDb(db, 'DELETE FROM quick_command_tags WHERE id = ?', [id]);

        await runDb(db, 'COMMIT');
        return result.changes > 0;
    } catch (err: any) {
        await runDb(db, 'ROLLBACK');
        console.error(`[仓库] 删除快捷指令标签 ${id} 时出错:`, err.message);
        throw new Error('删除快捷指令标签失败');
    }
};

/**
 * 设置单个快捷指令的标签关联 (先删除旧关联，再插入新关联)
 * @param commandId - 快捷指令 ID
 * @param tagIds - 新的标签 ID 数组 (空数组表示清除所有关联)
 * @returns Promise<void>
 */
export const setCommandTagAssociations = async (commandId: number, tagIds: number[]): Promise<void> => {
    const db = await getDbInstance();
    const deleteSql = `DELETE FROM quick_command_tag_associations WHERE quick_command_id = ?`;
    const insertSql = `INSERT INTO quick_command_tag_associations (quick_command_id, tag_id) VALUES (?, ?)`;

    try {
        await runDb(db, 'BEGIN TRANSACTION');
        // 1. 删除该指令的所有旧关联
        await runDb(db, deleteSql, [commandId]);

        // 2. 插入新关联 (如果 tagIds 不为空)
        if (tagIds && tagIds.length > 0) {
            const stmt = await db.prepare(insertSql);
            for (const tagId of tagIds) {
                 // 验证 tagId 是否为有效数字
                 if (typeof tagId !== 'number' || isNaN(tagId)) {
                     console.warn(`[Repo] setCommandTagAssociations: 无效的 tagId (${tagId})，跳过关联到指令 ${commandId}。`);
                     continue;
                 }
                await stmt.run(commandId, tagId);
            }
            await stmt.finalize();
        }
        await runDb(db, 'COMMIT');
    } catch (err: any) {
        console.error('设置快捷指令标签关联时出错:', err.message);
        await runDb(db, 'ROLLBACK'); // 出错时回滚
        throw new Error('无法设置快捷指令标签关联');
    }
};

/**
 * 将单个标签批量添加到多个快捷指令
 * @param commandIds - 需要添加标签的快捷指令 ID 数组
 * @param tagId - 要添加的标签 ID
 * @returns Promise<void>
 */
export const addTagToCommands = async (commandIds: number[], tagId: number): Promise<void> => {
    if (!commandIds || commandIds.length === 0) {
        return; // 没有指令需要关联
    }
    const db = await getDbInstance();
    const insertSql = `INSERT OR IGNORE INTO quick_command_tag_associations (quick_command_id, tag_id) VALUES (?, ?)`;

    try {
        await runDb(db, 'BEGIN TRANSACTION');
        // 准备批量插入语句
        const stmt = await db.prepare(insertSql);
        for (const commandId of commandIds) {
            // 验证 commandId 和 tagId 是否为有效数字（可选，但推荐）
            if (typeof commandId !== 'number' || isNaN(commandId) || typeof tagId !== 'number' || isNaN(tagId)) {
                 console.warn(`[Repo] addTagToCommands: 无效的 commandId (${commandId}) 或 tagId (${tagId})，跳过关联。`);
                 continue;
            }
            await stmt.run(commandId, tagId);
        }
        await stmt.finalize(); // 完成批量插入
        await runDb(db, 'COMMIT');
        console.log(`[Repo] addTagToCommands: 成功将标签 ${tagId} 关联到 ${commandIds.length} 个指令。`);
    } catch (err: any) {
        console.error(`[Repo] addTagToCommands: 批量关联标签 ${tagId} 到指令时出错:`, err.message);
        await runDb(db, 'ROLLBACK');
        throw new Error('无法批量关联标签到快捷指令');
    }
};

/**
 * 更新指定快捷指令的标签关联 (使用事务)
 * @param commandId 快捷指令 ID
 * @param tagIds 新的快捷指令标签 ID 数组 (空数组表示清除所有标签)
 */
// Removed the duplicate function declaration that returned Promise<boolean>

/**
 * 查找指定快捷指令的所有标签
 * @param commandId 快捷指令 ID
 * @returns 标签对象数组 { id: number, name: string }[]
 */
export const findTagsByCommandId = async (commandId: number): Promise<QuickCommandTag[]> => {
    const sql = `
        SELECT t.id, t.name, t.created_at, t.updated_at
        FROM quick_command_tags t
        JOIN quick_command_tag_associations ta ON t.id = ta.tag_id
        WHERE ta.quick_command_id = ?
        ORDER BY t.name ASC`;
    try {
        const db = await getDbInstance();
        const rows = await allDb<QuickCommandTag>(db, sql, [commandId]);
        return rows;
    } catch (err: any) {
        console.error(`Repository: 查询快捷指令 ${commandId} 的标签时出错:`, err.message);
        throw new Error('获取快捷指令标签失败');
    }
};