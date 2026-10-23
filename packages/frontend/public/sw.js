/**
 * Nexus Terminal 的 Service Worker。
 *
 * 历史教训（v1 的坑）：v1 对**所有**请求一律 `caches.match(req) || fetch(req)`（cache-first），
 * 且 `CACHE_NAME` 永远停在 `v1`、没有 skipWaiting。结果只要某个资源进过一次缓存，
 * 之后无论怎么刷新页面（甚至 F5）都永远拿旧的 —— 表现为「代码明明更新了，界面还是老样子」。
 * 排查这种问题极耗时，所以这里改成按请求类型分策略：
 *
 *   - **导航请求**（地址栏回车 / F5 / 打开页面）：network-first。
 *     保证每次导航都拿到最新的 index.html —— 它里面引用的 hash 资源名一变，整套前端就换了。
 *     只有断网时才回落到缓存，保留 PWA 离线能力。
 *   - 构建产物（`/assets/` 下、文件名带内容 hash）：stale-while-revalidate。
 *     命中缓存先给（秒开），同时后台拉新版本写回缓存；内容变了 hash 就变了，不会张冠李戴。
 *   - **其它同源静态（图标、manifest）**：cache-first + 后台更新。
 *   - 接口与 WebSocket：完全绕过 SW，避免干扰接口请求与 WebSocket 升级。
 *
 * 另外：install 时 `skipWaiting()`、activate 时 `clients.claim()` 并清掉所有旧版本缓存，
 * 让新版本立即生效，而不是"等这个标签页全关掉再说"。
 */
const CACHE_NAME = 'nexus-terminal-cache-v2';

// 只预缓存不随构建变化的东西；index.html 绝不预缓存（否则又要靠版本号手动兜底）
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
    caches
      .open(CACHE_NAME)
      // 单个图标缺失不该让整个 SW 安装失败
      .then((cache) => Promise.all(PRECACHE_URLS.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

const putInCache = (request, response) => {
  if (!response || !response.ok) return;
  const copy = response.clone();
  caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => null);
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  // 接口与 WebSocket 升级请求不经过缓存
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // 1. 导航：network-first，断网才用缓存兜底
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          putInCache('/index.html', response);
          return response;
        })
        .catch(() =>
          caches.match('/index.html').then((cached) => cached || caches.match('/'))
        )
    );
    return;
  }

  // 2. 构建产物（带 hash）：stale-while-revalidate
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            putInCache(request, response);
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // 3. 其它同源静态：cache-first + 后台更新
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          putInCache(request, response);
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
