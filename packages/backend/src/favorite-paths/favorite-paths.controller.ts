import { Request, Response } from 'express';
import * as FavoritePathsService from '../favorite-paths/favorite-paths.service';
import { FavoritePathSortBy } from '../favorite-paths/favorite-paths.service';

/**
 * 处理添加新收藏路径的请求
 */
/** 作用域解析：只认 'host'，其余一律回落 'global'；host 必须有归属连接 */
const parseScope = (value: unknown): 'global' | 'host' => (value === 'host' ? 'host' : 'global');
const parseConnectionUuid = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

export const createFavoritePath = async (req: Request, res: Response): Promise<void> => {
    const { name, path, is_file, scope, connection_uuid } = req.body;

    if (!path || typeof path !== 'string' || path.trim().length === 0) {
        res.status(400).json({ message: '路径内容不能为空' });
        return;
    }

    let finalName: string | null = null;
    if (name !== undefined && name !== null) {
        if (typeof name !== 'string') {
            res.status(400).json({ message: '名称必须是字符串或 null' });
            return;
        }
        finalName = name.trim().length > 0 ? name.trim() : null;
    }

    // 若未提供名称，自动提取路径最后一级目录名作为名称
    if (!finalName) {
        const cleanPath = path.trim().replace(/\/+$/, '');
        const segments = cleanPath.split('/').filter(Boolean);
        finalName = segments.length > 0 ? segments[segments.length - 1] : 'root';
    }

    const isFile = is_file === true || is_file === 1 || is_file === '1';

    try {
        const finalScope = parseScope(scope);
        const finalConnectionUuid = parseConnectionUuid(connection_uuid);
        if (finalScope === 'host' && !finalConnectionUuid) {
            res.status(400).json({ message: '主机专属收藏缺少归属连接' });
            return;
        }
        const newId = await FavoritePathsService.addFavoritePath(
            finalName,
            path,
            isFile,
            finalScope,
            finalConnectionUuid
        );
        const newFavoritePath = await FavoritePathsService.getFavoritePathById(newId);
        if (newFavoritePath) {
            res.status(201).json({ message: '收藏路径已添加', favoritePath: newFavoritePath });
        } else {
             console.error(`[Controller] 添加收藏路径后未能找到 ID: ${newId}`);
             res.status(201).json({ message: '收藏路径已添加，但无法检索新记录', id: newId });
        }
    } catch (error: any) {
        console.error('[Controller] 添加收藏路径失败:', error.message);
        res.status(500).json({ message: error.message || '无法添加收藏路径' });
    }
};

/**
 * 处理获取所有收藏路径的请求 (支持排序)
 */
export const getAllFavoritePaths = async (req: Request, res: Response): Promise<void> => {
    const sortBy = req.query.sortBy as FavoritePathSortBy | undefined;
    const validSortByOptions: FavoritePathSortBy[] = ['name', 'last_used_at'];
    const validSortBy: FavoritePathSortBy = sortBy && validSortByOptions.includes(sortBy) ? sortBy : 'name';

    try {
        const favoritePaths = await FavoritePathsService.getAllFavoritePaths(validSortBy);
        res.status(200).json(favoritePaths);
    } catch (error: any) {
        console.error('获取收藏路径控制器出错:', error);
        res.status(500).json({ message: error.message || '无法获取收藏路径' });
    }
};

/**
 * 处理根据 ID 获取单个收藏路径的请求
 */
export const getFavoritePathById = async (req: Request, res: Response): Promise<void> => {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
        res.status(400).json({ message: '无效的 ID' });
        return;
    }

    try {
        const favoritePath = await FavoritePathsService.getFavoritePathById(id);
        if (favoritePath) {
            res.status(200).json(favoritePath);
        } else {
            res.status(404).json({ message: '未找到指定的收藏路径' });
        }
    } catch (error: any) {
        console.error('获取单个收藏路径控制器出错:', error);
        res.status(500).json({ message: error.message || '无法获取收藏路径' });
    }
};


/**
 * 处理更新收藏路径的请求
 */
export const updateFavoritePath = async (req: Request, res: Response): Promise<void> => {
    const id = parseInt(req.params.id, 10);
    const { name, path, is_file, scope, connection_uuid } = req.body;

    if (isNaN(id)) {
        res.status(400).json({ message: '无效的 ID' });
        return;
    }
    if (!path || typeof path !== 'string' || path.trim().length === 0) {
        res.status(400).json({ message: '路径内容不能为空' });
        return;
    }

    let finalName: string | null = null;
    if (name !== undefined && name !== null) {
        if (typeof name !== 'string') {
            res.status(400).json({ message: '名称必须是字符串或 null' });
            return;
        }
        finalName = name.trim().length > 0 ? name.trim() : null;
    }

    // 若未提供名称，自动提取路径最后一级目录名作为名称
    if (!finalName) {
        const cleanPath = path.trim().replace(/\/+$/, '');
        const segments = cleanPath.split('/').filter(Boolean);
        finalName = segments.length > 0 ? segments[segments.length - 1] : 'root';
    }

    // 未显式传 is_file 时保留原值（老版本前端 / 云同步来的请求不带这个字段，
    // 一律当成目录会把文件收藏悄悄改坏）
    try {
        const existing = await FavoritePathsService.getFavoritePathById(id);
        let isFile: boolean;
        if (is_file === undefined) {
            isFile = Number(existing?.is_file) === 1;
        } else {
            isFile = is_file === true || is_file === 1 || is_file === '1';
        }

        // scope / connection_uuid 未显式传时保留原值（老前端、云同步都不带这两个字段）
        const finalScope = scope === undefined
            ? (((existing?.scope as string) === 'host') ? 'host' : 'global')
            : parseScope(scope);
        const finalConnectionUuid = scope === undefined
            ? (existing?.connection_uuid ?? null)
            : parseConnectionUuid(connection_uuid);
        if (finalScope === 'host' && !finalConnectionUuid) {
            res.status(400).json({ message: '主机专属收藏缺少归属连接' });
            return;
        }

        const success = await FavoritePathsService.updateFavoritePath(
            id,
            finalName,
            path,
            isFile,
            finalScope,
            finalConnectionUuid
        );
        if (success) {
            const updatedFavoritePath = await FavoritePathsService.getFavoritePathById(id);
            if (updatedFavoritePath) {
                 res.status(200).json({ message: '收藏路径已更新', favoritePath: updatedFavoritePath });
            } else {
                 console.error(`[Controller] 更新收藏路径后未能找到 ID: ${id}`);
                 res.status(200).json({ message: '收藏路径已更新，但无法检索更新后的记录' });
            }
        } else {
            const pathExists = await FavoritePathsService.getFavoritePathById(id);
            if (!pathExists) {
                 res.status(404).json({ message: '未找到要更新的收藏路径' });
            } else {
                 console.error(`[Controller] 更新收藏路径 ${id} 失败，但路径存在。`);
                 res.status(500).json({ message: '更新收藏路径时发生未知错误' });
            }
        }
    } catch (error: any) {
        console.error('更新收藏路径控制器出错:', error);
        res.status(500).json({ message: error.message || '无法更新收藏路径' });
    }
};

/**
 * 处理删除收藏路径的请求
 */
export const deleteFavoritePath = async (req: Request, res: Response): Promise<void> => {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
        res.status(400).json({ message: '无效的 ID' });
        return;
    }

    try {
        const success = await FavoritePathsService.deleteFavoritePath(id);
        if (success) {
            res.status(200).json({ message: '收藏路径已删除' });
        } else {
            res.status(404).json({ message: '未找到要删除的收藏路径' });
        }
    } catch (error: any) {
        console.error('删除收藏路径控制器出错:', error);
        res.status(500).json({ message: error.message || '无法删除收藏路径' });
    }
};

/**
 * 处理更新收藏路径上次使用时间的请求
 */
export const incrementUsage = async (req: Request, res: Response): Promise<void> => {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
        res.status(400).json({ message: '无效的 ID' });
        return;
    }

    try {
        // 更新上次使用时间
        const lastUsedSuccess = await FavoritePathsService.updateFavoritePathLastUsed(id);

        if (lastUsedSuccess) {
            const updatedPath = await FavoritePathsService.getFavoritePathById(id);
            if (updatedPath) {
                res.status(200).json({ message: '上次使用时间已更新', favoritePath: updatedPath });
            } else {
                 // 这种情况理论上不应该发生，因为 updateFavoritePathLastUsed 内部应该处理了路径不存在的情况
                 // 收藏路径 (ID: ${id}) 上次使用时间已更新，但无法检索该路径。
                 console.error(`[Controller] 收藏路径 (ID: ${id}) 上次使用时间已更新，但无法检索该路径。`);
                 res.status(404).json({ message: '上次使用时间已更新，但无法检索更新后的收藏路径' });
            }
        } else {
            // 更新失败，检查路径是否存在以提供更具体的错误信息
            const pathExists = await FavoritePathsService.getFavoritePathById(id);
            if (!pathExists) {
                res.status(404).json({ message: '未找到要更新上次使用时间的收藏路径' });
            } else {
                // 路径存在，但更新操作失败
                console.warn(`[Controller] 尝试更新收藏路径 (ID: ${id}) 的上次使用时间失败，但路径存在。`);
                res.status(500).json({ message: '更新上次使用时间失败' });
            }
        }
    } catch (error: any) {
        console.error('更新收藏路径上次使用时间控制器出错:', error);
        res.status(500).json({ message: error.message || '无法更新上次使用时间' });
    }
};

/**
 * 处理更新收藏路径上次使用时间戳的请求 (PUT)
 */
export const updateLastUsedTimestamp = async (req: Request, res: Response): Promise<void> => {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
        res.status(400).json({ message: '无效的 ID' });
        return;
    }

    try {
        // 更新上次使用时间
        const success = await FavoritePathsService.updateFavoritePathLastUsed(id);

        if (success) {
            const updatedPath = await FavoritePathsService.getFavoritePathById(id);
            if (updatedPath) {
                res.status(200).json({ message: '上次使用时间戳已更新', favoritePath: updatedPath });
            } else {
                 // 这种情况理论上不应该发生，因为 updateFavoritePathLastUsed 内部应该处理了路径不存在的情况
                 console.error(`[Controller] 收藏路径 (ID: ${id}) 上次使用时间戳已更新，但无法检索该路径。`);
                 res.status(404).json({ message: '上次使用时间戳已更新，但无法检索更新后的收藏路径' });
            }
        } else {
            // 更新失败，检查路径是否存在以提供更具体的错误信息
            const pathExists = await FavoritePathsService.getFavoritePathById(id);
            if (!pathExists) {
                res.status(404).json({ message: '未找到要更新上次使用时间戳的收藏路径' });
            } else {
                // 路径存在，但更新操作失败
                console.warn(`[Controller] 尝试更新收藏路径 (ID: ${id}) 的上次使用时间戳失败，但路径存在。`);
                res.status(500).json({ message: '更新上次使用时间戳失败' });
            }
        }
    } catch (error: any) {
        console.error('更新收藏路径上次使用时间戳控制器出错:', error);
        res.status(500).json({ message: error.message || '无法更新上次使用时间戳' });
    }
};
/**
 * 批量迁移收藏：把选中的收藏「移动」或「复制」到全局 / 某台主机专属。
 *
 * 请求体：`{ ids: number[], mode: 'move' | 'copy', targetScope: 'global' | 'host', targetConnectionUuid?: string }`
 * 响应里带上迁移后的完整列表，前端直接整份替换即可，不必再拉一次。
 */
export const transferFavoritePaths = async (req: Request, res: Response): Promise<void> => {
    const { ids, mode, targetScope, targetConnectionUuid } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({ message: '请至少选择一条收藏路径' });
        return;
    }
    // id 是各端自增的整数，顺手挡掉 NaN / 字符串 / 负数
    const normalizedIds = ids
        .map((v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN))
        .filter((v: number) => Number.isInteger(v) && v > 0);
    if (normalizedIds.length === 0) {
        res.status(400).json({ message: '收藏路径 ID 无效' });
        return;
    }

    if (mode !== 'move' && mode !== 'copy') {
        res.status(400).json({ message: '迁移方式只能是移动或复制' });
        return;
    }

    const finalScope = parseScope(targetScope);
    const finalConnectionUuid = parseConnectionUuid(targetConnectionUuid);
    if (finalScope === 'host' && !finalConnectionUuid) {
        res.status(400).json({ message: '主机专属收藏缺少归属连接' });
        return;
    }

    try {
        const result = await FavoritePathsService.transferFavoritePaths(
            normalizedIds,
            mode,
            finalScope,
            finalConnectionUuid
        );
        const favoritePaths = await FavoritePathsService.getAllFavoritePaths('name');
        res.status(200).json({
            message: mode === 'move' ? '收藏路径已移动' : '收藏路径已复制',
            mode,
            targetScope: finalScope,
            targetConnectionUuid: finalScope === 'host' ? finalConnectionUuid : null,
            moved: result.moved,
            copied: result.copied,
            skipped: result.skipped,
            total: normalizedIds.length,
            favoritePaths,
        });
    } catch (error: any) {
        console.error('[Controller] 迁移收藏路径失败:', error.message);
        res.status(500).json({ message: error.message || '无法迁移收藏路径' });
    }
};
