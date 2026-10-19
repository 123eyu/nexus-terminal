/**
 * 终端 buffer 的文本处理（从 workspaceSync.store 抽出，纯函数可单测）。
 */

/** 去掉 ANSI 转义序列（CSI 序列，够用即可） */
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

/**
 * 清理快照终端文本末尾悬空的 Shell 提示符行。
 *
 * 场景：新建 SSH 连接时把旧快照的屏幕内容回放进新终端。
 * 旧内容的最后一行往往是 `root@host:~# `（用户还没来得及敲命令就刷新了），
 * 回放后再叠加新 shell 的登录提示符，就会出现两行提示符。
 *
 * 只裁剪**最后一行**且必须形如 `... #` / `$` / `%` / `>`：
 * 中间行的提示符是真实历史，不能动。
 */
export function cleanTrailingPromptForReconnect(text: string): string {
  if (!text) return '';
  const normalized = text.replace(/\r?\n/g, '\r\n');
  const lines = normalized.split('\r\n');
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    // 剥离 ANSI 后判断是否为悬空的 shell 提示符（例如 root@localhost:~# 或 user@host:~$）
    const plainLastLine = stripAnsi(lastLine).trimEnd();
    if (plainLastLine && /[#$%>]\s*$/.test(plainLastLine)) {
      lines.pop(); // 裁掉末尾未执行命令的旧提示符，留给新连接的远程 Shell 真实输出
      return lines.join('\r\n') + (lines.length > 0 ? '\r\n' : '');
    }
  }
  return normalized;
}

/** 判断一行是否是提示符（给需要逐行判断的调用方用） */
export function looksLikePromptLine(line: string): boolean {
  const plain = stripAnsi(line).trimEnd();
  return !!plain && /[#$%>]\s*$/.test(plain);
}
