/**
 * 终端搜索的纯函数层：正则构建、行内匹配、滚动条标记计算。
 *
 * 为什么搜索核心不自己写：
 * xterm 的 `@xterm/addon-search` 已经处理了 buffer 遍历、宽字符、软换行、
 * 增量搜索与 decoration（含当前匹配单独样式）。自己重写要复刻它的内部实现，
 * 还会踩 buffer 私有 API 的版本兼容问题。这里只补 addon 不提供的两件事：
 *   1. 结果计数（addon 的 onDidChangeResults 已给，但它不带行号）
 *   2. 滚动条上的命中位置标记（需要行号 → 必须自己扫一遍 buffer）
 *
 * 本文件必须保持零运行时依赖（只能 import type），否则 node --experimental-strip-types
 * 跑不了单测。
 */

export interface TerminalSearchOptions {
  /** 按正则解释搜索词 */
  regex?: boolean;
  /** 整词匹配（前后不能是 [A-Za-z0-9_]） */
  wholeWord?: boolean;
  /** 区分大小写 */
  caseSensitive?: boolean;
}

export interface TerminalSearchMarker {
  /** 距轨道顶部比例 0~1 */
  top: number;
  /** 高度比例 0~1（调用方需兜底最小像素高度） */
  height: number;
  /** 当前聚焦的匹配是否落在本段 */
  active: boolean;
}

const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * 默认高亮配色。
 *
 * 语义：黄色 = 全部命中，橙红 = 当前聚焦命中（与滚动条标记保持同一套颜色）。
 * 背景用半透明，避免盖住终端自身的 ANSI 前景色；边框用来在密集行里划清边界。
 * xterm 的 decoration 背景会走 `css.toColor`，支持 rgba() 与 #RRGGBBAA。
 */
export const DEFAULT_SEARCH_DECORATIONS = {
  matchBackground: 'rgba(250, 204, 21, 0.26)',
  matchOverviewRuler: '#facc15',
  activeMatchBackground: 'rgba(239, 68, 68, 0.65)',
  activeMatchBorder: 'rgba(248, 113, 113, 0.95)',
  activeMatchColorOverviewRuler: '#f87171',
};

/** 转义正则元字符（变量/搜索词里含 . ( ) [ ] 时不会抛异常） */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构建全局匹配用的正则。非法正则返回 null（调用方按"无结果"处理），
 * 绝不把异常抛到渲染层。
 */
export function buildSearchRegExp(
  term: string,
  options: TerminalSearchOptions = {}
): RegExp | null {
  if (!term) return null;
  const flags = options.caseSensitive ? 'g' : 'gi';
  const body = options.regex ? term : escapeRegExp(term);

  // 整词边界优先编进正则（lookaround 不消费字符，match.index 仍是词首）。
  // 老 Safari 不支持 lookbehind 时降级为裸正则 + findMatchRangesInLine 的手工边界判断。
  if (options.wholeWord) {
    try {
      return new RegExp(`(?<![\\w])(?:${body})(?![\\w])`, flags);
    } catch {
      /* 降级到下面的裸正则 */
    }
  }

  try {
    return new RegExp(body, flags);
  } catch {
    // 非法正则：交给调用方按"无结果"处理，别让异常冒到渲染层
    return null;
  }
}

/**
 * 在一行里找出所有命中区间 [start, end)。
 *
 * 用 exec + lastIndex 而不是 indexOf：正则模式下要靠 lastIndex 推进；
 * 零宽匹配（如 `^`）必须手动 +1，否则死循环。
 */
export function findMatchRangesInLine(
  line: string,
  pattern: RegExp,
  wholeWord = false
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  if (!line || !pattern) return ranges;

  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    if (match[0].length === 0) {
      pattern.lastIndex = start + 1;
      continue;
    }

    if (wholeWord) {
      const before = start > 0 ? line[start - 1] : '';
      const after = end < line.length ? line[end] : '';
      if ((before && WORD_CHAR.test(before)) || (after && WORD_CHAR.test(after))) {
        // 不满足整词边界：从 start+1 继续找，避免漏掉行内后面的合法命中
        pattern.lastIndex = start + 1;
        continue;
      }
    }

    ranges.push([start, end]);
  }

  pattern.lastIndex = 0;
  return ranges;
}

/**
 * 扫描整段行文本，返回"每个匹配所在的行号"（按匹配出现顺序，一行多次命中会重复出现）。
 *
 * 顺序必须与 addon 的 resultIndex 一致：addon 也是从 buffer 顶部往下逐行扫，
 * 一行内从左到右。这样滚动条标记的 active 段才能对上"3/57"里的 3。
 */
export function collectMatchLines(
  lines: string[],
  term: string,
  options: TerminalSearchOptions = {}
): number[] {
  const pattern = buildSearchRegExp(term, options);
  if (!pattern) return [];

  const result: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ranges = findMatchRangesInLine(lines[i], pattern, options.wholeWord);
    for (let r = 0; r < ranges.length; r++) {
      result.push(i);
    }
  }
  return result;
}

/** 最小 buffer 接口：只依赖扫描需要的两个成员，便于单测用假对象 */
export interface SearchBufferLike {
  length: number;
  baseY: number;
  getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
}

/**
 * 分片扫描整个 buffer，返回命中行号。
 *
 * 分片是为了"高性能"：10 万行 × 每行 100 字符如果一口气扫，主线程会卡住输入。
 * 每扫 chunkSize 行让出一帧，用户键入时感觉不到。isCancelled 用来在搜索词变化时
 * 立刻放弃上一轮扫描，避免旧结果覆盖新结果。
 */
export async function scanSearchBuffer(
  buffer: SearchBufferLike,
  term: string,
  options: TerminalSearchOptions = {},
  isCancelled: () => boolean = () => false,
  chunkSize = 4000
): Promise<{ matchLines: number[]; totalLines: number }> {
  if (!term || !buffer || buffer.length <= 0) {
    return { matchLines: [], totalLines: Math.max(1, buffer?.baseY ?? 1) };
  }

  const total = buffer.length;
  const matchLines: number[] = [];

  for (let offset = 0; offset < total; offset += chunkSize) {
    if (isCancelled()) return { matchLines: [], totalLines: Math.max(1, buffer.baseY) };

    const end = Math.min(total, offset + chunkSize);
    const lines: string[] = new Array(end - offset);
    for (let i = offset; i < end; i++) {
      lines[i - offset] = buffer.getLine(i)?.translateToString(true) ?? '';
    }

    const hits = collectMatchLines(lines, term, options);
    for (let h = 0; h < hits.length; h++) {
      matchLines.push(offset + hits[h]);
    }

    if (end < total) {
      // 让出主线程，下一片继续（setTimeout 0 在浏览器里是下一个宏任务）
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  if (isCancelled()) return { matchLines: [], totalLines: Math.max(1, buffer.baseY) };
  return { matchLines, totalLines: Math.max(1, buffer.baseY) };
}

/**
 * 把匹配行号压缩成滚动条标记。
 *
 * - 相邻/同一行合并成一段，避免 1000 个匹配生成 1000 个 DOM 节点
 * - 段数超过 maxSegments 时均匀抽稀，但**当前聚焦段一定保留**（否则跳转后看不见自己）
 */
export function buildSearchMarkers(
  matchLines: number[],
  totalLines: number,
  activeIndex: number = -1,
  maxSegments: number = 160
): TerminalSearchMarker[] {
  if (!matchLines.length || totalLines <= 0) return [];

  const total = Math.max(1, totalLines);
  const segments: Array<{ from: number; to: number; first: number; last: number }> = [];

  for (let i = 0; i < matchLines.length; i++) {
    const line = Math.max(0, Math.min(total - 1, matchLines[i]));
    const last = segments[segments.length - 1];
    if (last && line <= last.last + 1) {
      last.last = Math.max(last.last, line);
      last.to = i;
    } else {
      segments.push({ from: i, to: i, first: line, last: line });
    }
  }

  let kept = segments;
  if (segments.length > maxSegments) {
    const activeSegIndex = segments.findIndex(
      (s) => activeIndex >= s.from && activeIndex <= s.to
    );
    const step = segments.length / maxSegments;
    const picked: typeof segments = [];
    for (let k = 0; k < maxSegments; k++) {
      picked.push(segments[Math.min(segments.length - 1, Math.floor(k * step))]);
    }
    if (activeSegIndex >= 0 && !picked.includes(segments[activeSegIndex])) {
      picked.push(segments[activeSegIndex]);
    }
    kept = picked;
  }

  return kept.map((seg) => ({
    top: seg.first / total,
    height: Math.max((seg.last - seg.first + 1) / total, 1 / total),
    active: activeIndex >= seg.from && activeIndex <= seg.to,
  }));
}
