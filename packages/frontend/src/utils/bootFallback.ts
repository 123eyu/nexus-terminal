/**
 * 启动/懒加载失败的兜底提示。
 *
 * 背景：路由是懒加载的（`() => import('../views/Xxx.vue')`），首次进入某个页面时
 * 才去下载对应的 chunk。手机弱网、或 WebView 太旧解析不了 chunk 时，这次下载会
 * 一直挂着或者直接失败 —— 而 Vue 还没走到 `app.mount`，页面上什么都没渲染，
 * 控制台也往往没有输出。用户看到的就是「点终端没反应」「手动输 /workspace 一片黑」。
 *
 * 这里刻意只用原生 DOM：出错的时候 Vue / 路由 / i18n 都可能正是坏掉的那一环。
 * 提示做成覆盖层而不是替换 `#app`，避免把已经挂载成功的界面也一起冲掉。
 */

const OVERLAY_ID = 'nexus-boot-fallback';

export function showBootFailure(title: string, detail?: unknown): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(OVERLAY_ID)) return; // 只提示一次

  const text = typeof detail === 'string' ? detail : detail instanceof Error ? detail.message : '';
  console.error(`[boot] ${title}${text ? `: ${text}` : ''}`);

  const box = document.createElement('div');
  box.id = OVERLAY_ID;
  box.setAttribute(
    'style',
    [
      'position:fixed',
      'inset:0',
      'z-index:2147483000',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'gap:14px',
      'padding:24px',
      'text-align:center',
      "font-family:system-ui,-apple-system,'Segoe UI',sans-serif",
      'background:rgba(17,19,24,0.92)',
      'color:#e6e8ec',
    ].join(';')
  );

  const h = document.createElement('p');
  h.textContent = title;
  h.setAttribute('style', 'margin:0;font-size:16px;font-weight:600');

  const p = document.createElement('p');
  p.textContent = text || '前端资源没有加载完成，请检查网络后重试。';
  p.setAttribute('style', 'margin:0;max-width:26em;font-size:12px;line-height:1.7;color:#9aa3b2;word-break:break-all');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '重新加载';
  btn.setAttribute(
    'style',
    'margin-top:6px;padding:8px 20px;font-size:13px;color:#fff;background:#9370db;border:0;border-radius:6px'
  );
  btn.addEventListener('click', () => window.location.reload());

  box.append(h, p, btn);
  document.body.appendChild(box);
}

/**
 * 判断是不是「chunk 没加载下来」这一类错误。
 * 浏览器各自的文案不一样，统一匹配几个关键字。
 */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  return /dynamically imported module|Importing a module script failed|Failed to fetch|error loading dynamically|ChunkLoadError|Loading chunk/i.test(
    msg
  );
}
