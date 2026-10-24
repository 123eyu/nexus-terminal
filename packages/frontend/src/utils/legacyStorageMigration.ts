/**
 * 「标签 → 文件夹」改名的**浏览器本地缓存**迁移（一次性、幂等）。
 *
 * 这几处都只是缓存或纯前端偏好，但键名和数据结构都跟着改了：
 *   - `tagsCache` / `quickCommandTagsCache`：缓存的是文件夹列表，键名换了；
 *   - `connectionsCache`：缓存里的字段从 `tag_ids` 变成 `folder_ids`，旧结构读进来会全是
 *     「未分类」，看起来像连接丢了文件夹；
 *   - `dashboard_connections_filter_tag`：仪表盘筛选的文件夹 id，值仍然有效，但键名换了。
 *
 * 缓存类直接删掉最干净（下一次请求就会补回来），只有筛选 id 值得搬过去。
 * 用一个版本标记保证只在第一次升级时跑，之后每次启动都是空转。
 */
const MIGRATION_FLAG = 'nexus:storage-migration:folders:v1';

/** 结构已变或键名已换的缓存，直接丢弃重拉 */
const STALE_CACHE_KEYS = ['tagsCache', 'quickCommandTagsCache', 'connectionsCache', 'quickCommandsListCache'];

export function migrateLegacyFolderStorage(): void {
  try {
    if (localStorage.getItem(MIGRATION_FLAG) === '1') return;

    for (const key of STALE_CACHE_KEYS) {
      localStorage.removeItem(key);
    }

    const legacyFilter = localStorage.getItem('dashboard_connections_filter_tag');
    if (legacyFilter !== null) {
      // 只在没有新值时才搬，避免覆盖用户升级后已经做过的选择
      if (localStorage.getItem('dashboard_connections_filter_folder') === null) {
        localStorage.setItem('dashboard_connections_filter_folder', legacyFilter);
      }
      localStorage.removeItem('dashboard_connections_filter_tag');
    }

    localStorage.setItem(MIGRATION_FLAG, '1');
    console.log('[main.ts] 本地缓存已迁移到「文件夹」命名。');
  } catch (err) {
    // 隐私模式 / 存储被禁用时 localStorage 会抛异常，不能因此影响启动
    console.warn('[main.ts] 本地缓存迁移跳过:', err);
  }
}
