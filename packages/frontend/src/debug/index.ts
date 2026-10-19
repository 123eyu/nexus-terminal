/**
 * Nexus Terminal — 应用内调试桥（仅开发期启用）
 *
 * 解决的问题：1241 处 console.* 只写进 DevTools，AI 侧完全看不到；
 * 组件内部抛错被 Vue 吞掉，页面上只是"少了一块"，没人知道为什么。
 *
 * 启用条件：import.meta.env.DEV 或 VITE_NEXUS_DEBUG=1（生产构建自动摇树剔除）。
 *
 * 暴露：window.__NEXUS__
 *   .snapshot()            当前应用状态摘要（store + 终端 + 错误 + 日志）
 *   .terminals()           全部 xterm 实例的 cols/rows/buffer/末行文本
 *   .dumpTerminal(idOrIdx) 单个终端完整可视区文本
 *   .errors / .logs        环形缓冲
 *   .clear()               清空缓冲
 *   .download()            把完整日志存成本地文件
 */
import type { App } from 'vue';
import type { Terminal } from 'xterm';

type Level = 'log' | 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  t: number;
  level: Level;
  args: string;
  stack?: string;
  url?: string;
}

interface TerminalEntry {
  id: string;
  sessionId: string;
  label?: string;
  term: Terminal;
  createdAt: number;
  meta?: Record<string, unknown>;
}

const MAX_LOGS = 800;
const MAX_ERRORS = 200;
const FLUSH_INTERVAL = 1200;
const LOG_ENDPOINT = '/api/v1/debug/log';

const logs: LogEntry[] = [];
const errors: LogEntry[] = [];
const terminals = new Map<string, TerminalEntry>();
const pending: LogEntry[] = [];

let installed = false;
let appRef: App | null = null;
let flushTimer: number | null = null;
let paused = false;

export const isDebugEnabled = (): boolean =>
  import.meta.env.DEV || import.meta.env.VITE_NEXUS_DEBUG === '1';

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function stringify(v: unknown, depth = 0): string {
  if (v == null) return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (v instanceof Element) return `<${v.tagName.toLowerCase()} ${(v as Element).className || ''}>`;
  if (depth > 2) return '…';
  if (Array.isArray(v)) {
    return `[${v.slice(0, 10).map((x) => stringify(x, depth + 1)).join(', ')}${v.length > 10 ? `, …${v.length}` : ''}]`;
  }
  if (typeof v === 'object') {
    const seen = new WeakSet<object>();
    try {
      const keys = Object.keys(v as object).slice(0, 14);
      return `{${keys
        .map((k) => {
          const val = (v as Record<string, unknown>)[k];
          if (val && typeof val === 'object') {
            if (seen.has(val as object)) return `${k}: <circular>`;
            seen.add(val as object);
          }
          return `${k}: ${stringify(val, depth + 1)}`;
        })
        .join(', ')}}`;
    } catch {
      return Object.prototype.toString.call(v);
    }
  }
  return String(v);
}

function push(arr: LogEntry[], entry: LogEntry) {
  arr.push(entry);
  if (arr.length > (arr === logs ? MAX_LOGS : MAX_ERRORS)) arr.shift();
}

let lastKey = '';
let lastAt = 0;

function record(level: Level, args: unknown[], stack?: string, site?: string) {
  if (paused) return;
  const text = args.map((a) => stringify(a)).join(' ');
  // Vue errorHandler 里会同时走 console.error，避免同一条错误记两遍
  const key = level + '|' + text.slice(0, 200);
  const now = Date.now();
  if (key === lastKey && now - lastAt < 200) return;
  lastKey = key;
  lastAt = now;

  const entry: LogEntry = {
    t: now,
    level,
    args: text.slice(0, 2000),
    stack,
    url: site || (typeof location !== 'undefined' ? location.pathname : undefined),
  };
  push(logs, entry);
  if (level === 'error') push(errors, entry);
  if (level === 'error' || level === 'warn') pending.push(entry);
}


/**
 * 劫持 console 后，浏览器记录的调用位置会全部变成 debug/index.ts，
 * 反而丢掉了最有价值的"哪一行打的日志"。这里从 stack 里找回真实调用点。
 */
function callerSite(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  for (const line of stack.split('\n')) {
    if (line.includes('debug/index.ts')) continue;
    if (line.includes('Error')) continue;
    const m = line.match(/(https?:\/\/[^\s)]+?|\/[^\s)]+?):(\d+):(\d+)/);
    if (m) return `${m[1].replace(/^https?:\/\/[^/]+/, '')}:${m[2]}`;
  }
  return undefined;
}


/* ------------------------------------------------------------------ *
 * 日志上报（开发期落盘，让 AI 能直接读文件）
 * ------------------------------------------------------------------ */

function flush() {
  if (!pending.length) return;
  const batch = pending.splice(0, pending.length);
  try {
    const body = JSON.stringify({ entries: batch });
    // keepalive 保证页面卸载时也能发出去
    void fetch(LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      /* 后端没起时静默失败，不影响页面 */
    });
  } catch {
    /* noop */
  }
}

/* ------------------------------------------------------------------ *
 * 终端注册表
 * ------------------------------------------------------------------ */

export function registerTerminal(entry: Omit<TerminalEntry, 'createdAt'> & { createdAt?: number }): () => void {
  if (!isDebugEnabled() || !entry.term) return () => {};
  const record: TerminalEntry = { ...entry, createdAt: entry.createdAt ?? Date.now() };
  // paneId 是"每个会话内部"稳定的（terminal-0 / terminal-1），多会话同时挂载时会重复。
  // 只用 paneId 当 key 会互相覆盖，dumpTerminal() 读到的是"最后注册的那个会话"的屏幕 ——
  // 排查"命令发到别的会话"时反而会被它误导，所以必须带上 sessionId。
  const key = `${entry.sessionId ?? ''}::${entry.id}`;
  terminals.set(key, record);
  return () => {
    terminals.delete(key);
  };
}

function bufferLines(term: Terminal, maxLines = 120): string[] {
  try {
    const buf = term.buffer?.active;
    if (!buf) return [];
    const end = buf.baseY + buf.cursorY;
    const start = Math.max(0, end - maxLines + 1);
    const out: string[] = [];
    for (let i = start; i <= end; i++) {
      const line = buf.getLine(i);
      if (line) out.push(line.translateToString(true));
    }
    return out;
  } catch {
    return [];
  }
}

function isTermVisible(t: TerminalEntry): boolean {
  const el = t.term.element as HTMLElement | undefined;
  return Boolean(el && el.offsetWidth > 0 && el.offsetHeight > 0);
}

function dumpTerminal(target?: string): unknown {
  if (!terminals.size) return { count: 0, note: '当前没有任何终端挂载（Terminal.vue 未注册或页面不在会话视图）' };
  const list = Array.from(terminals.values());
  // 多会话时默认取"当前真正显示在屏幕上的那个"，而不是先注册的那个（可能是隐藏会话）
  const picked = target
    ? list.find((t) => t.id === target || t.sessionId === target) ??
      list[Number(target) as number]
    : list.find(isTermVisible) ?? list[0];
  if (!picked) return { count: list.length, ids: list.map((t) => `${t.sessionId}:${t.id}`), note: '未匹配到目标终端' };

  const buf = picked.term.buffer?.active;
  const lines = bufferLines(picked.term, 200);
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim().length > 0) ?? '';
  return {
    id: picked.id,
    sessionId: picked.sessionId,
    label: picked.label,
    cols: picked.term.cols,
    rows: picked.term.rows,
    bufferLines: buf ? buf.length : null,
    cursor: buf ? { x: buf.cursorX, y: buf.cursorY, baseY: buf.baseY } : null,
    visibleTail: lines.slice(-40),
    lastNonEmptyLine: lastNonEmpty,
    blank: lines.every((l) => !l.trim()),
    meta: picked.meta,
  };
}

/* ------------------------------------------------------------------ *
 * Store 摘要
 * ------------------------------------------------------------------ */

function summarizeValue(v: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'function') return '[fn]';
  if (depth <= 0) return Array.isArray(v) ? `[${v.length}]` : typeof v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (seen.has(v as object)) return '<circular>';
    seen.add(v as object);
    if (Array.isArray(v)) {
      return v.length > 6
        ? `[${v.length} items]`
        : v.map((item) => summarizeValue(item, depth - 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).slice(0, 24)) {
      out[k] = summarizeValue((v as Record<string, unknown>)[k], depth - 1, seen);
    }
    return out;
  }
  return String(v);
}

function storeSummary(): Record<string, unknown> | null {
  const app = appRef as unknown as { config: { globalProperties: Record<string, unknown> } } | null;
  // pinia 实例挂在 app.config.globalProperties.$pinia
  const pinia = app?.config?.globalProperties?.$pinia as
    | { _s?: Map<string, { $state: Record<string, unknown> }> }
    | undefined;
  if (!pinia?._s) return null;
  const out: Record<string, unknown> = {};
  for (const [id, store] of pinia._s) {
    try {
      out[id.replace(/\.store$/, '')] = summarizeValue(store.$state, 2, new WeakSet());
    } catch (e) {
      out[id] = `<读取失败: ${String(e)}>`;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 快照
 * ------------------------------------------------------------------ */

export function snapshot() {
  const termList = Array.from(terminals.values()).map((t) => {
    const buf = t.term.buffer?.active;
    const lines = bufferLines(t.term, 20);
    return {
      id: t.id,
      sessionId: t.sessionId,
      label: t.label,
      cols: t.term.cols,
      rows: t.term.rows,
      bufferLines: buf?.length ?? null,
      lastLine: [...lines].reverse().find((l) => l.trim()) ?? '',
      blank: lines.every((l) => !l.trim()),
      meta: t.meta,
    };
  });

  return {
    logCount: logs.length,
    errorCount: errors.length,
    recentErrors: errors.slice(-10),
    terminals: termList,
    stores: storeSummary(),
  };
}

/* ------------------------------------------------------------------ *
 * 安装
 * ------------------------------------------------------------------ */

export function installDebugBridge(app: App) {
  if (installed || !isDebugEnabled()) return;
  installed = true;
  appRef = app;

  /* 1. Vue 组件内部异常 —— 没有它，组件报错只会静默少一块 UI */
  app.config.errorHandler = (err, instance, info) => {
    const name =
      (instance as { $options?: { name?: string; __file?: string } } | null)?.$options?.__file ||
      (instance as { $options?: { name?: string } } | null)?.$options?.name ||
      'unknown';
    // eslint-disable-next-line no-console
    console.error(`[VueError] ${name} | ${info} |`, err);
    record('error', [`[VueError] ${name} | ${info} |`, err], (err as Error)?.stack);
  };

  app.config.warnHandler = (msg, instance, trace) => {
    record('warn', [`[VueWarn] ${msg}`, trace.slice(0, 400)]);
  };

  /* 2. 未捕获异常 / Promise 拒绝 */
  window.addEventListener('error', (e) => {
    record('error', [`[window.onerror] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`, e.error ?? ''], e.error?.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    record('error', ['[unhandledrejection]', e.reason], (e.reason as Error)?.stack);
  });

  /* 3. 劫持 console.error / warn（保留原行为，只旁路记录） */
  (['error', 'warn'] as const).forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      record(level, args, undefined, callerSite());
      original(...args);
    };
  });

  /* 4. 定期把 error/warn 落盘到后端 */
  flushTimer = window.setInterval(flush, FLUSH_INTERVAL);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('beforeunload', () => {
    flush();
    if (flushTimer) window.clearInterval(flushTimer);
  });

  /* 5. 暴露调试入口 */
  const api = {
    version: '1.0.0',
    snapshot,
    terminals: () =>
      Array.from(terminals.values()).map((t) => ({
        id: t.id,
        sessionId: t.sessionId,
        cols: t.term.cols,
        rows: t.term.rows,
        bufferLines: t.term.buffer?.active?.length ?? null,
      })),
    dumpTerminal,
    /** 在 buffer 里找包含指定文本的行号（供自动化脚本定位；limit 限制返回条数） */
    findRows: (id: string, needle: string, limit = 5) => {
      const entry = Array.from(terminals.values()).find((t) => t.id === id);
      const buffer = entry?.term.buffer.active;
      if (!buffer) return [];
      const rows: number[] = [];
      for (let i = 0; i < buffer.length; i++) {
        const text = buffer.getLine(i)?.translateToString(true) ?? '';
        if (text.includes(needle)) {
          rows.push(i);
          if (rows.length >= limit) break;
        }
      }
      return rows;
    },
    /**
     * 读取某行的每个 cell（字符 + 列宽）。
     *
     * 用来验证「字符串下标 → 终端列」的换算：宽字符（CJK/emoji）占 2 列且后面跟一个
     * width=0 的续格，组合文字（泰文/天城文）的宽度只有从 cell 才能读准。
     */
    lineCells: (id: string, row: number) => {
      const entry = Array.from(terminals.values()).find((t) => t.id === id);
      const line = entry?.term.buffer.active.getLine(row);
      if (!line) return null;
      const cells: Array<{ chars: string; width: number }> = [];
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        cells.push({ chars: cell?.getChars() ?? '', width: cell?.getWidth() ?? -1 });
      }
      return { text: line.translateToString(true), cells };
    },
    get errors() {
      return errors.slice();
    },
    get logs() {
      return logs.slice();
    },
    /** 暂停记录，避免自己的调试输出刷屏 */
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    clear: () => {
      logs.length = 0;
      errors.length = 0;
      pending.length = 0;
      return true;
    },
    /** 导出完整日志为可下载文本 */
    download: () => {
      const text = logs
        .map((l) => `${new Date(l.t).toISOString()} [${l.level}] ${l.url ?? ''} ${l.args}`)
        .join('\n');
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `nexus-frontend-${Date.now()}.log`;
      a.click();
      return `${logs.length} 条`;
    },
    /** 直接向后端落盘（供自动化脚本调用） */
    flush,
  };

  (window as unknown as Record<string, unknown>).__NEXUS__ = api;
  // eslint-disable-next-line no-console
  console.info(
    '%c[Nexus Debug] window.__NEXUS__ 已就绪：__NEXUS__.snapshot() / .dumpTerminal() / .errors',
    'color:#22d3ee;font-weight:bold'
  );
}
