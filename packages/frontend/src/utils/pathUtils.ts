/**
 * POSIX 路径的小工具（纯函数，可单测）。
 *
 * 只服务于 UI 展示（取最后一段当文件夹名），不做规范化/解析，
 * 所以不要拿它去处理 `..`、`~`、多斜杠这类需要真实路径语义的场景。
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
