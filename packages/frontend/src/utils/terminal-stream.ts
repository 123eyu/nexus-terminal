/**
 * 终端输出写入过滤器：把「后端发来的原始字节流」变成「可以直接 term.write 的字符串」，
 * 并保证分块边界落在任何位置时都不会破坏转义序列或多字节字符。
 *
 * 为什么需要：
 *   WebSocket / PTY 的分块边界是随机的。一条 OSC 8 超链接、一段 24bit SGR、甚至一个
 *   中文字符都可能被切成两半。以前的做法是「每块单独 highlight()」，于是半截的
 *   `\x1b]8;;https://…` 会被当成纯文本，高亮器往中间插一段 SGR，终端把 OSC 提前终止
 *   —— 链接地址变成可见文本打在画面上，光标位置也随之错位。AI CLI（agy 之类）都是
 *   按「上一帧占了几行」来重绘的，一旦多出这类杂质行，后续每帧都会留下旧内容，
 *   表现就是**偶尔多出/重复几行**，而且完全取决于网络分块，极难复现。
 *
 * 现在的做法：
 *   1. 字节统一走 TextDecoder({ stream: true }) 解码，多字节字符跨块不会变成 U+FFFD；
 *   2. 每块末尾如果停在转义序列中间，就把这段尾巴留到下一块（carry），只处理
 *      「已经完整」的部分；
 *   3. 因此高亮注入的 SGR 永远只会落在纯文本位置，不可能插进控制序列里。
 */

export interface TerminalStreamFilterOptions {
  /** 语法高亮（可能往纯文本里注入 SGR） */
  highlight: (text: string) => string;
  /** 其它改写（例如退出备用屏后补 SGR/清屏），默认原样返回 */
  sanitize?: (text: string) => string;
}

export interface TerminalStreamFilter {
  /** 喂一块数据，返回可以直接写进 xterm 的字符串（可能为空串） */
  write(chunk: string | Uint8Array): string;
  /** 收尾：把还压在 carry 里的尾巴吐出来 */
  flush(): string;
}

/** carry 上限：防止一段永远不闭合的序列把内存拖大 */
const MAX_CARRY = 16 * 1024;

/**
 * 找出一段文本里**第一个没写完的转义序列**的起始下标（没有就返回 -1）。
 *
 * 必须从头顺序扫描而不是只看最后一个 ESC：像 `\x1b]0;title\x1b` 这种
 * 「OSC 还没收尾，后面又来了一个 ESC」的情况，只看最后一个 ESC 会误判成
 * 「从 ESC 开始的新序列」，于是前面那段不完整的 OSC 会被当成纯文本参与高亮，
 * SGR 就插进去了。
 */
export function findIncompleteEscapeStart(text: string): number {
  let i = text.indexOf('\x1b');
  while (i >= 0) {
    const next = text[i + 1];
    if (next === undefined) return i; // 只有 ESC，等下一块

    // CSI：ESC [ 参数 0x30-0x3F → 中间字节 0x20-0x2F → 终止字节 0x40-0x7E
    if (next === '[') {
      let p = i + 2;
      while (p < text.length) {
        const c = text.charCodeAt(p);
        if (c >= 0x30 && c <= 0x3f) p += 1;
        else break;
      }
      while (p < text.length) {
        const c = text.charCodeAt(p);
        if (c >= 0x20 && c <= 0x2f) p += 1;
        else break;
      }
      if (p >= text.length) return i; // 还没走到终止字节
      const c = text.charCodeAt(p);
      if (c < 0x40 || c > 0x7e) return i; // 参数不合法，当没写完处理
      i = text.indexOf('\x1b', p + 1);
      continue;
    }

    // OSC / DCS / SOS / PM / APC：字符串型序列，直到 BEL 或 ST（ESC \）
    if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
      let p = i + 2;
      let end = -1;
      while (p < text.length) {
        const ch = text[p];
        if (ch === '\x07') { end = p + 1; break; }
        if (ch === '\x1b') {
          if (text[p + 1] === '\\') { end = p + 2; break; }
          // 字符串里出现裸 ESC：视为没闭合，整段留给下一块
          return i;
        }
        p += 1;
      }
      if (end < 0) return i;
      i = text.indexOf('\x1b', end);
      continue;
    }

    // 字符集指定：ESC ( ) * + - . / # % 后面还要跟一个字节
    if ('()*+-./#%'.includes(next)) {
      if (i + 2 >= text.length) return i;
      i = text.indexOf('\x1b', i + 3);
      continue;
    }

    // 其余单字符 ESC 序列（ESC 7 / ESC = / ESC M / ESC \ 等）本身就完整
    i = text.indexOf('\x1b', i + 2);
  }
  return -1;
}

export function createTerminalStreamFilter(options: TerminalStreamFilterOptions): TerminalStreamFilter {
  const sanitize = options.sanitize ?? ((text: string) => text);
  const decoder = new TextDecoder('utf-8');
  let carry = '';

  const render = (text: string): string => {
    if (!text) return '';
    // 没开高亮时 highlight 一般返回原串，这里不额外判断，保持行为一致
    return sanitize(options.highlight(text));
  };

  const write = (chunk: string | Uint8Array): string => {
    let text: string;
    if (typeof chunk === 'string') {
      text = chunk;
    } else {
      try {
        // stream: true —— 多字节字符被切开时先攒在 decoder 里，下一块再补齐
        text = decoder.decode(chunk, { stream: true });
      } catch {
        return '';
      }
    }
    if (!text) return '';

    const combined = carry ? carry + text : text;
    const cut = findIncompleteEscapeStart(combined);
    if (cut < 0) {
      carry = '';
      return render(combined);
    }

    carry = combined.slice(cut);
    if (carry.length > MAX_CARRY) {
      // 病态输入（比如一段永远不闭合的 OSC）：直接原样吐出去，别把内存拖爆
      const raw = carry;
      carry = '';
      return render(combined.slice(0, cut)) + raw;
    }
    return render(combined.slice(0, cut));
  };

  const flush = (): string => {
    let pending = carry + decoder.decode();
    carry = '';
    if (!pending) return '';
    // flush 时不再做 carry 判断：这段就是最后的内容了
    const out = render(pending);
    pending = '';
    return out;
  };

  return { write, flush };
}
