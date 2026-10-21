import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTerminalStreamFilter,
  findIncompleteEscapeStart,
} from '../src/utils/terminal-stream.ts';
import {
  compileHighlightGroups,
  highlightTerminalString,
} from '../src/utils/terminal-highlighter.ts';
import type { TerminalHighlightGroup } from '../src/types/terminal-highlight.types.ts';

/** 一个只匹配 http(s) 链接的高亮组，用来复现"半截控制序列被高亮插 SGR"的问题 */
const urlGroup: TerminalHighlightGroup = {
  id: 'g_url',
  name: 'URL',
  isBuiltin: true,
  enabled: true,
  color: '#38bdf8',
  underline: true,
  priority: 2,
} as TerminalHighlightGroup;

const matchers = compileHighlightGroups([urlGroup]);
const highlight = (text: string) => highlightTerminalString(text, matchers);

/** 记住每个 chunk 的切分位置，方便断言"分块不影响结果" */
const feed = (chunks: (string | Uint8Array)[], hl = highlight) => {
  const filter = createTerminalStreamFilter({ highlight: hl });
  let out = '';
  for (const chunk of chunks) out += filter.write(chunk);
  out += filter.flush();
  return out;
};

test('多字节字符被切成两半时不会变成替换字符', () => {
  const text = '正在思考…\r\n你好，世界 🚀\r\n';
  const bytes = new TextEncoder().encode(text);
  // 按 1 字节切，最恶劣的情况
  const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
  const out = feed(chunks, (s) => s);
  assert.equal(out, text);
  assert.ok(!out.includes('\uFFFD'), '不应出现 U+FFFD');
});

test('OSC 8 超链接跨块时保持完整，高亮不会插进序列里', () => {
  const head = '\x1b]8;;https://antigravity.goog';
  const tail = 'le.com\x1b\\打开链接\x1b]8;;\x1b\\\r\n';
  const out = feed([head, tail]);

  // 控制序列必须原封不动
  assert.ok(
    out.includes('\x1b]8;;https://antigravity.google.com\x1b\\'),
    `OSC 8 序列被破坏：${JSON.stringify(out)}`
  );
  // 且 URL 只以纯文本形式出现一次（链接文字里没有再插一段 SGR 的高亮副本）
  assert.equal(out.split('https://antigravity.google.com').length - 1, 1);
  // 注入的 SGR 只能出现在纯文本之前，不能夹在 OSC 的 ESC 与 ST 之间
  const oscStart = out.indexOf('\x1b]8;;https');
  const oscEnd = out.indexOf('\x1b\\', oscStart);
  assert.equal(out.slice(oscStart, oscEnd).includes('\x1b[38'), false);
});

test('CSI 参数被切开也不会漏到画面上', () => {
  const a = '\x1b[38;2;1;2;';
  const b = '3m红色文字\x1b[0m';
  const single = feed([a + b]);
  const chunked = feed([a, b]);
  assert.equal(chunked, single);
  assert.ok(chunked.includes('\x1b[38;2;1;2;3m'));
});

test('不完整的尾序列会留在 carry 里，flush 时吐出', () => {
  const filter = createTerminalStreamFilter({ highlight: (s) => s });
  assert.equal(filter.write('abc\x1b['), 'abc');
  assert.equal(filter.write('31m'), '\x1b[31m'); // 补齐后才输出
  assert.equal(filter.flush(), '');
});

test('findIncompleteEscapeStart 能区分完整与未完成的序列', () => {
  assert.equal(findIncompleteEscapeStart('plain'), -1);
  assert.equal(findIncompleteEscapeStart('a\x1b[1;2H'), -1);
  assert.equal(findIncompleteEscapeStart('a\x1b[1;2'), 1);
  assert.equal(findIncompleteEscapeStart('a\x1b]0;title\x07'), -1);
  assert.equal(findIncompleteEscapeStart('a\x1b]0;title'), 1);
  assert.equal(findIncompleteEscapeStart('a\x1b]0;title\x1b\\'), -1);
  assert.equal(findIncompleteEscapeStart('a\x1b]0;title\x1b'), 1);
  assert.equal(findIncompleteEscapeStart('a\x1b[>4;2m'), -1);
  assert.equal(findIncompleteEscapeStart('a\x1b'), 1);
});

test('TUI 帧按真实分块顺序喂入后与整体喂入结果一致', () => {
  // 典型的一帧：光标归位 + 逐行 \r\n + 行尾 \x1b[K + 一行带链接
  const frame =
    '\x1b[H' +
    'assistant:\r\n' +
    '\x1b[K详见 \x1b]8;;https://antigravity.google\x1b\\文档\x1b]8;;\x1b\\\r\n' +
    '\x1b[K> 请输入\r\n';
  const whole = feed([frame], (s) => s);
  const splitEvery = Array.from({ length: frame.length }, (_, i) => frame.slice(i, i + 1));
  assert.equal(feed(splitEvery, (s) => s), whole);
});
