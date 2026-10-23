/**
 * Nexus Terminal Service Worker
 *
 * 这里只有一条铁律：**index.html 永远不许从缓存里读**。
 *
 * 它是整份前端的「版本指针」——里面写着这一版 js/css 的哈希文件名。以前这个文件是
 * 全量 cache-first 预缓存的，`CACHE_NAME` 又一直停在 v1，于是老用户第一次打开时缓存的
 * 那份 index.html 会一直生效：无论服务端升到 0.9.12 还是 0.9.13，浏览器加载的还是
 * 第一次那份 HTML、第一版 JS。表现就是「升级了但功能没变」「修好的 bug 还在」，
 * 而且怎么刷新都没用（普通刷新走 SW 缓存，只有强制刷新才绕过）。
 *
 * 所以现在的分工是：
 *   - 导航（HTML）→ 网络优先，成功就顺手留一份做离线兜底
 *   - /assets/*   → 缓存优先（文件名带内容哈希，同 URL 必同内容，缓存是安全的）
 *   - /api/、/ws  → 完全不碰
 *   - 图标/manifest → 缓存优先 + 后台更新
 */

const CACHE_NAME = 'nexus-terminal-v2';
/** 离线兜底用的导航结果，固定存在这个 key 上 */
const NAV_FALLBACK_KEY = '/index.html';

/** 只预缓存真正的静态文件；index.html 绝不进来 */
const PRECACHE_URLS = [
  '/manifest.json',
  '/icons/icon-72x72.png',
  '/icons/icon-96x96.png',
  '/icons/icon-128x128.png',
  '/icons/icon-144x144.png',
  '/icons/icon-152x152.png',
  '/icons/icon-192x192.png',
  '/icons/icon-384x384.png',
  '/icons/icon-512x512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 逐个 add：某个图标缺失不该让整个 SW 装不上（addAll 是全有或全无）
      await Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url)));
      // 新版本立刻接班，不要等所有标签页关掉
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

/**
 * 每个版本的 /assets/ 文件名都不一样，旧版本不会有人再请求，留着只是白占空间。
 * 上限之外按插入顺序（最老的先删）淘汰——离线时要用的是当前这一版，正好是最新的。
 */
const MAX_ASSET_ENTRIES = 160;
async function trimAssetCache(cache) {
  const keys = await cache.keys();
  // 只淘汰 /assets/ 里的，预缓存的图标/manifest 不能动
  const assetKeys = keys.filter((key) => {
    try {
      return new URL(key.url).pathname.startsWith('/assets/');
    } catch (_) {
      return false;
    }
  });
  const overflow = assetKeys.length - MAX_ASSET_ENTRIES;
  if (overflow <= 0) return;
  await Promise.all(assetKeys.slice(0, overflow).map((key) => cache.delete(key)));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  // 接口和长连接走缓存只会拿到过期数据
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // --- 导航：网络优先 ---
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE_NAME);
            // 任何路由都存成同一份兜底页，离线时也能把外壳拉起来
            cache.put(NAV_FALLBACK_KEY, fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch (error) {
          const cached = await caches.match(NAV_FALLBACK_KEY);
          if (cached) return cached;
          throw error;
        }
      })()
    );
    return;
  }

  // --- 带哈希的构建产物：缓存优先 ---
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        if (fresh && fresh.ok && fresh.type === 'basic') {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, fresh.clone()).catch(() => {});
          trimAssetCache(cache).catch(() => {});
        }
        return fresh;
      })()
    );
    return;
  }

  // --- 其它同源静态资源：缓存优先 + 后台更新 ---
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      const network = fetch(request)
        .then((fresh) => {
          if (fresh && fresh.ok) {
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(request, fresh.clone()))
              .catch(() => {});
          }
          return fresh;
        })
        .catch(() => null);
      return cached || (await network) || Response.error();
    })()
  );
});
