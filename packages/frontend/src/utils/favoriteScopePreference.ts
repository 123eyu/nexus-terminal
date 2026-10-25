import type { FavoritePathScope } from '../stores/favoritePaths.store';

/**
 * 收藏夹列表上次看的是「本机专属」还是「全局」。
 *
 * 这是纯界面偏好（看哪一组），按设备记在 localStorage 里就够了 ——
 * 不必进 settings 表，也不必参与跨端同步。
 * 键名沿用 `nexus:` 前缀（见 `nexus:mobile_file_manager_compact`）。
 */
const STORAGE_KEY = 'nexus:file_manager_favorite_scope';

/** 记不住就按「本机专属」——从某个文件管理器里打开收藏夹，想找的几乎都是这台机器上的路径 */
export const readFavoriteScopePreference = (): FavoritePathScope => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'global' ? 'global' : 'host';
  } catch {
    // 隐私模式 / 存储被禁：读不到就当没记住
    return 'host';
  }
};

export const writeFavoriteScopePreference = (scope: FavoritePathScope): void => {
  try {
    localStorage.setItem(STORAGE_KEY, scope);
  } catch {
    // 写不进去不影响本次会话的使用
  }
};

/**
 * 打开弹窗时的初始作用域。
 *
 * 没有主机上下文时「本机专属」必然是空的，只能给全局；
 * 但这只是**展示上的退让**，不能回写偏好 —— 否则从没有主机的场景开一次，
 * 用户之前选的「本机专属」就被悄悄改掉了。
 */
export const resolveInitialFavoriteScope = (hostUuid?: string | null): FavoritePathScope => {
  if (!hostUuid) return 'global';
  return readFavoriteScopePreference();
};
