/**
 * POSIX 路径的小工具（纯函数，可单测）。
 *
 * `extractFolderNameFromPath` 只服务于 UI 展示（取最后一段当文件夹名）；
 * 需要真实路径语义（`..`、`.`、多斜杠、相对转绝对）时用 `resolveRemotePath`。
 */

/**
 * 从绝对路径里取最后一段作为默认名称。
 *
 * 边界都覆盖了：根目录 `/` 返回 'root'（否则会得到一个空名字），
 * 尾斜杠先剥掉再取，`/a` 这种单段路径直接返回 `a`。
 */
export function extractFolderNameFromPath(fullPath: string): string {
  if (!fullPath || fullPath === '/') return 'root';
  const clean = fullPath.endsWith('/') ? fullPath.slice(0, -1) : fullPath;
  const lastSlash = clean.lastIndexOf('/');
  return lastSlash >= 0 ? clean.substring(lastSlash + 1) : clean;
}

/**
 * 把用户输入解析成远端绝对路径。
 *
 * 新建文件 / 文件夹的输入框允许直接写路径：
 *   `1.txt`             → `<base>/1.txt`
 *   `./asd/222/1.txt`   → `<base>/asd/222/1.txt`
 *   `../x`              → `<base 的上一级>/x`
 *   `/etc/nginx/a.conf` → 原样（绝对路径）
 *
 * 规则与 POSIX 一致：`.` 与空段丢弃，`..` 回退一级（已在根就停在根，不会跑出 `/`），
 * 连续斜杠折叠。返回值一定以 `/` 开头且不含结尾斜杠（根目录就是 `/`）。
 */
export function resolveRemotePath(basePath: string, input: string): string {
  const raw = (input || '').trim();
  const combined = raw.startsWith('/')
    ? raw
    : `${(basePath || '/').trim() || '/'}/${raw}`;
  const segments: string[] = [];
  for (const seg of combined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      segments.pop(); // 空栈时 pop 是 no-op：`/..` 仍然是 `/`
      continue;
    }
    segments.push(seg);
  }
  return `/${segments.join('/')}`;
}

/**
 * 取父目录（`/` 的父目录还是 `/`）。
 * 新建时用它判断「这次是不是建到了当前目录外面」。
 */
export function parentOfRemotePath(fullPath: string): string {
  const clean = (fullPath || '/').replace(/\/+$/, '');
  if (!clean) return '/';
  const lastSlash = clean.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : clean.substring(0, lastSlash);
}
