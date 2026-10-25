import * as FavoritePathsRepository from '../favorite-paths/favorite-paths.repository';
import { FavoritePath } from '../favorite-paths/favorite-paths.repository';

// 定义排序类型
export type FavoritePathSortBy = 'name' | 'last_used_at';

/**
 * 添加收藏路径
 * @param name - 路径名称 (可选)
 * @param path - 路径内容
 * @returns 返回添加记录的 ID
 */
export const addFavoritePath = async (
    name: string | null,
    path: string,
    isFile = false,
    scope: 'global' | 'host' = 'global',
    connectionUuid: string | null = null
): Promise<number> => {
    if (!path || path.trim().length === 0) {
        throw new Error('路径内容不能为空');
    }
    // 如果 name 是空字符串，则视为 null
    const finalName = name && name.trim().length > 0 ? name.trim() : null;
    const favoritePathId = await FavoritePathsRepository.addFavoritePath(
        finalName,
        path.trim(),
        isFile,
        scope,
        connectionUuid
    );
    return favoritePathId;
};

/**
 * 更新收藏路径
 * @param id - 要更新的记录 ID
 * @param name - 新的路径名称 (可选)
 * @param path - 新的路径内容
 * @returns 返回是否成功更新 (更新行数 > 0)
 */
export const updateFavoritePath = async (
    id: number,
    name: string | null,
    path: string,
    isFile = false,
    scope: 'global' | 'host' = 'global',
    connectionUuid: string | null = null
): Promise<boolean> => {
    if (!path || path.trim().length === 0) {
        throw new Error('路径内容不能为空');
    }
    const finalName = name && name.trim().length > 0 ? name.trim() : null;
    const pathUpdated = await FavoritePathsRepository.updateFavoritePath(
        id,
        finalName,
        path.trim(),
        isFile,
        scope,
        connectionUuid
    );
    return pathUpdated;
};

/**
 * 删除收藏路径
 * @param id - 要删除的记录 ID
 * @returns 返回是否成功删除 (删除行数 > 0)
 */
export const deleteFavoritePath = async (id: number): Promise<boolean> => {
    const changes = await FavoritePathsRepository.deleteFavoritePath(id);
    return changes;
};

/**
 * 获取所有收藏路径，并按指定方式排序
 * @param sortBy - 排序字段 ('name' 或 'usage_count')
 * @returns 返回排序后的收藏路径数组
 */
export const getAllFavoritePaths = async (sortBy: FavoritePathSortBy = 'name'): Promise<FavoritePath[]> => {
    return FavoritePathsRepository.getAllFavoritePaths(sortBy);
};

/**
 * 更新收藏路径的上次使用时间
 * @param id - 收藏路径的ID
 * @returns Promise<boolean> - 操作是否成功
 */
export const updateFavoritePathLastUsed = async (id: number): Promise<boolean> => {
    // 未来可能在这里添加额外的业务逻辑或验证
    return FavoritePathsRepository.updateFavoritePathLastUsedAt(id);
};

/**
 * 根据 ID 获取单个收藏路径
 * @param id - 记录 ID
 * @returns 返回找到的收藏路径，或 undefined
 */
export const getFavoritePathById = async (id: number): Promise<FavoritePath | undefined> => {
    return FavoritePathsRepository.findFavoritePathById(id);
};
/**
 * 批量迁移收藏到另一个作用域（移动 / 复制）。
 *
 * 与「逐条 update / create」的差别不只是省几个往返：判重必须在同一把事务里做，
 * 否则两条同路径的收藏并发迁到同一个目标时会各自看到「目标还没有」，双双落库。
 */
export const transferFavoritePaths = async (
    ids: number[],
    mode: 'move' | 'copy',
    targetScope: 'global' | 'host',
    targetConnectionUuid: string | null
): Promise<FavoritePathsRepository.FavoritePathTransferResult> => {
    if (!Array.isArray(ids) || ids.length === 0) {
        throw new Error('请至少选择一条收藏路径');
    }
    const finalScope: 'global' | 'host' = targetScope === 'host' ? 'host' : 'global';
    const finalUuid = finalScope === 'host' ? targetConnectionUuid : null;
    if (finalScope === 'host' && !finalUuid) {
        throw new Error('主机专属收藏缺少归属连接');
    }
    return FavoritePathsRepository.transferFavoritePaths(ids, mode, finalScope, finalUuid);
};
