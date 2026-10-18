#!/usr/bin/env node
/**
 * ai.mjs — 给 AI 用的常驻浏览器调试会话
 *
 * 和 eye.mjs 的区别：
 *   eye.mjs 是"一次性快照"：拉起浏览器 → 登录 → 开会话 → 扫描 → 退出（7~9s）
 *   ai.mjs  是"常驻会话"：浏览器一直在后台跑着（登录态、SSH 连接、终端 buffer 都留着），
 *                         每次查询只是 attach 上去读一次状态（0.5~1s）
 *
 * 为什么这才是 AI 该用的形态：
 *   AI 调试是"探索"，不是"回归"。它需要的是
 *     1) 秒级反馈（能连续问 20 个问题）
 *     2) 结构化、字段稳定的 JSON（不是给人看的 HTML report）
 *     3) 语义化动作（open 26 / send "ls"），而不是每次现写一长串 evaluate
 *
 * 用法：
 *   node devtools/ai.mjs up                  # 启动常驻浏览器（headless），已存在则复用
 *   node devtools/ai.mjs up --headed         # 有头模式，人也想看时用
 *   node devtools/ai.mjs down                # 关掉
 *
 *   node devtools/ai.mjs state               # 应用状态摘要（路由/会话/终端/错误/布局异常）
 *   node devtools/ai.mjs state --full        # 附带页面骨架 + 完整 store 摘要
 *   node devtools/ai.mjs probe               # 只跑布局不变量扫描
 *   node devtools/ai.mjs inspect "保存"       # 按文本/角色找元素，返回 rect + Vue 源文件
 *   node devtools/ai.mjs shot                # 截图（只在需要肉眼/视觉核对时用）
 *
 *   node devtools/ai.mjs act goto /dashboard
 *   node devtools/ai.mjs act login --user admin --pass admin
 *   node devtools/ai.mjs act open 26
 *   node devtools/ai.mjs act send "echo hello"
 *   node devtools/ai.mjs act click "text=保存"
 *   node devtools/ai.mjs act fill "#username=admin"
 *   node devtools/ai.mjs act reload
 *
 * 所有命令都输出 JSON，失败时输出 { ok:false, error } 并以 1 退出。
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const PROBE = path.join(__dirname, 'dom-probe.js');
const SESSION_FILE = path.join(ROOT, '.debug', 'ai-session.json');
const DEFAULT_PORT = 9333;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const out = (obj) => {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
};
const die = (msg, extra) => {
  process.stdout.write(JSON.stringify({ ok: false, error: msg, ...(extra || {}) }, null, 2) + '\n');
  process.exit(1);
};

/* ------------------------------ 会话管理 ------------------------------ */

function readSession() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (!s.port) return null;
    return s;
  } catch {
    return null;
  }
}

function writeSession(s) {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), 'utf8');
}

async function cdpReady(port, timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
      if (res.ok) {
        const info = await res.json();
        return info;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function cmdUp(argv) {
  const port = Number(argv.port || DEFAULT_PORT);
  const headed = argv.headed === true;

  const existing = await cdpReady(port, 600);
  if (existing) {
    const s = readSession();
    out({ ok: true, reused: true, port, browser: existing.Browser, endpoint: `http://127.0.0.1:${port}`, profile: s?.profile || null });
    return;
  }

  const chrome = findChrome();
  if (!chrome) die('没找到 Chrome/Edge 可执行文件，请装一个或用 eye.mjs（一次性模式）');

  const profile = path.join(ROOT, '.debug', 'ai-profile');
  fs.mkdirSync(profile, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=1440,900',
    ...(headed ? [] : ['--headless=new']),
    'about:blank',
  ];

  // 注意：不能用 detached + unref —— 外层命令结束时子进程会被一起回收，
  // 下次 attach 就连不上了。必须让本进程保持前台，由它托管浏览器。
  const child = spawn(chrome, args, { stdio: 'ignore' });
  const cleanup = () => {
    try {
      child.kill();
    } catch {
      /* noop */
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  const info = await cdpReady(port, 20000);
  if (!info) {
    cleanup();
    die('浏览器已启动但 CDP 端口没起来', { port, pid: child.pid });
  }

  writeSession({ port, pid: child.pid, profile, startedAt: new Date().toISOString() });
  out({
    ok: true,
    reused: false,
    port,
    pid: child.pid,
    browser: info.Browser,
    profile,
    note: '浏览器已就绪。本进程需保持前台/后台常驻，关掉它就等于关浏览器。',
  });
  // 保持常驻，直到被显式结束
  await new Promise(() => {});
}

async function cmdDown() {
  const s = readSession();
  if (s?.pid) {
    try {
      process.kill(s.pid);
    } catch {
      /* 已退出 */
    }
  }
  if (s?.port) {
    // 兜底：有些平台 spawn 的 pid 是壳进程，按端口再找一次
    try {
      await fetch(`http://127.0.0.1:${s.port}/json/close`, { method: 'PUT', signal: AbortSignal.timeout(500) });
    } catch {
      /* noop */
    }
  }
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  out({ ok: true, stopped: !!s });
}

/* ------------------------------ 连接与探针 ------------------------------ */

async function attach(baseUrl, spec) {
  const s = readSession();
  const port = Number(spec.port || s?.port || DEFAULT_PORT);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() =>
    die('连不上常驻浏览器，先执行 `node devtools/ai.mjs up`', { port })
  );
  const contexts = browser.contexts();
  if (!contexts.length) die('浏览器没有上下文');
  const context = contexts[0];
  const pages = context.pages().filter((p) => !p.url().startsWith('about:'));
  const page = pages[pages.length - 1] || context.pages()[0];
  if (!page) die('没有打开的页面');
  await ensureProbe(page);

  if (baseUrl && !page.url().startsWith(baseUrl)) {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await ensureProbe(page);
  }
  return { browser, page, port };
}

async function ensureProbe(page) {
  // 每次都强制重注入：探针代码常改，缓存旧版本会让排查结果对不上
  const src = fs.readFileSync(PROBE, 'utf8');
  await page
    .evaluate(() => {
      try {
        delete window.__NEXUS_DOM__;
      } catch {
        /* noop */
      }
    })
    .catch(() => {});
  await page.evaluate(src).catch(() => {});
}

async function settle(page, ms = 300) {
  await page.evaluate((t) => window.__NEXUS_DOM__?.waitStable({ timeout: t, quietMs: 120 }), ms).catch(() => {});
}

/* ------------------------------ 状态读取 ------------------------------ */

async function readState(page, full) {
  return page.evaluate((wantFull) => {
    const probe = window.__NEXUS_DOM__;
    const app = window.__NEXUS__;
    const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;

    const sessions = [];
    let activeSessionId = null;
    if (pinia) {
      const S = pinia._s.get('session');
      activeSessionId = S?.activeSessionId ?? null;
      if (S?.sessions) {
        for (const [sid, s] of S.sessions) {
          const tm = s.terminalManager;
          sessions.push({
            id: sid,
            conn: s.connectionName ?? s.connectionId,
            panes: tm?.terminalPanes ? [...tm.terminalPanes.value.keys()] : [],
            primary: tm?.primaryPaneId?.value ?? null,
            connected: tm?.isSshConnected?.value ?? null,
          });
        }
      }
    }

    const terminals = [];
    document.querySelectorAll('.xterm').forEach((el) => {
      const scr = el.querySelector('.xterm-screen');
      const rows = el.querySelector('.xterm-rows');
      const txt = rows ? (rows.textContent || '').replace(/\s+/g, ' ').trim() : '';
      terminals.push({
        w: scr ? Math.round(scr.getBoundingClientRect().width) : 0,
        h: scr ? Math.round(scr.getBoundingClientRect().height) : 0,
        chars: txt.length,
        tail: txt.slice(-160),
      });
    });

    const scan = probe ? probe.scan({}) : null;

    const base = {
      url: location.pathname + location.search,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight },
      activeSessionId,
      sessions,
      terminals,
      counts: {
        xterm: document.querySelectorAll('.xterm').length,
        modals: [...document.querySelectorAll('.el-overlay, [class*="modal"], [class*="dialog"]')]
          .filter((e) => e.checkVisibility?.({ checkVisibilityCSS: true }) ?? true).length,
      },
      issues: scan
        ? scan.issues.map((i) => ({
            kind: i.kind,
            sev: i.severity,
            file: i.file ? i.file.replace(/^.*?\/src\//, 'src/') : null,
            comp: i.component,
            sel: (i.selector || '').slice(0, 80),
            detail: i.detail,
          }))
        : 'probe-missing',
      issueCounts: scan?.byKind ?? {},
    };

    if (app?.snapshot) {
      const s = app.snapshot();
      base.errors = (s.recentErrors || []).slice(-5).map((e) => ({
        at: e.url,
        msg: String(e.args).slice(0, 200),
      }));
      base.termState = s.terminals;
    }
    if (wantFull) {
      base.outline = probe?.outline({ max: 100 });
      base.stores = app?.snapshot?.().stores ?? null;
    }
    return base;
  }, !!full);
}

/* ------------------------------ 动作 ------------------------------ */

async function act(page, kind, value, flags) {
  switch (kind) {
    case 'goto': {
      await page.goto(new URL(value, flags.base || 'http://localhost:5173').toString(), { waitUntil: 'domcontentloaded' });
      await ensureProbe(page);
      await settle(page);
      return { url: new URL(page.url()).pathname };
    }
    case 'reload': {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ensureProbe(page);
      await settle(page);
      return { url: new URL(page.url()).pathname };
    }
    case 'login': {
      const user = flags.user || process.env.EYE_USER || 'admin';
      const pass = flags.pass || process.env.EYE_PASS || 'admin';
      if (!(await page.locator('#password').count())) {
        await page.goto(new URL('/login', flags.base || 'http://localhost:5173').toString(), { waitUntil: 'domcontentloaded' });
      }
      await page.waitForSelector('#username', { timeout: 15000 });
      await page.fill('#username', user);
      await page.fill('#password', pass);
      await page.click('button[type=submit]');
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });
      await ensureProbe(page);
      await page
        .waitForFunction(() => {
          const p = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
          const c = p?._s.get('connections');
          return !!(c && Array.isArray(c.connections) && c.connections.length > 0);
        }, null, { timeout: 15000 })
        .catch(() => {});
      return { user, url: new URL(page.url()).pathname };
    }
    case 'open': {
      const r = await page.evaluate((t) => {
        const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
        if (!pinia) return { ok: false, error: 'pinia 未就绪' };
        const conns = pinia._s.get('connections');
        const sess = pinia._s.get('session');
        const list = conns?.connections || [];
        const key = String(t).toLowerCase();
        const conn =
          list.find((c) => String(c.id) === String(t)) ||
          list.find((c) => String(c.name).toLowerCase() === key) ||
          list.find((c) => String(c.name).toLowerCase().includes(key));
        if (!conn) return { ok: false, error: `没有连接 "${t}"`, available: list.map((c) => `${c.id}:${c.name}`) };
        sess.handleConnectRequest(conn);
        return { ok: true, id: conn.id, name: conn.name };
      }, value);
      if (!r.ok) throw new Error(r.error + (r.available ? ' | 可用: ' + r.available.join(' , ') : ''));
      await page.waitForURL((u) => u.pathname.includes('/workspace') || u.pathname === '/', { timeout: 15000 }).catch(() => {});
      const t0 = Date.now();
      await page
        .waitForFunction(() => {
          const n = window.__NEXUS__;
          const d = n?.dumpTerminal?.();
          if (d && (d.bufferLines ?? 0) > 0 && !d.blank) return true;
          const rows = document.querySelector('.xterm-rows');
          return !!rows && (rows.textContent || '').trim().length > 0;
        }, null, { timeout: 25000, polling: 200 })
        .catch(() => {});
      return { ...r, readyMs: Date.now() - t0 };
    }
    case 'send': {
      const input = page.locator('input[data-focus-id=commandInput]');
      if (!(await input.count())) throw new Error('当前页面没有命令输入框');
      await input.fill(value);
      await input.press('Enter');
      return { sent: value };
    }
    case 'click': {
      await page.locator(value).first().click({ timeout: 10000 });
      await settle(page);
      return { clicked: value };
    }
    case 'fill': {
      const i = value.indexOf('=');
      if (i === -1) throw new Error('fill 需要 "选择器=值" 格式');
      await page.locator(value.slice(0, i)).first().fill(value.slice(i + 1));
      return { filled: value.slice(0, i) };
    }
    case 'press': {
      await page.keyboard.press(value);
      return { pressed: value };
    }
    case 'eval': {
      return await page.evaluate(value);
    }
    default:
      throw new Error(`未知动作: ${kind}（可用: goto/reload/login/open/send/click/fill/press/eval）`);
  }
}

/* ------------------------------ 主入口 ------------------------------ */

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const nextV = argv[i + 1];
      if (nextV === undefined || nextV.startsWith('--')) flags[key] = true;
      else {
        flags[key] = nextV;
        i++;
      }
    } else flags._.push(a);
  }
  return flags;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  const positional = flags._;

  if (!cmd || cmd === 'help' || flags.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }

  if (cmd === 'up') return cmdUp(flags);
  if (cmd === 'down') return cmdDown();

  const base = flags.base || process.env.EYE_BASE || 'http://localhost:5173';
  const { page } = await attach(null, flags);

  try {
    if (cmd === 'state') {
      const state = await readState(page, flags.full === true);
      out({ ok: true, ...state });
    } else if (cmd === 'probe') {
      const r = await page.evaluate(() => window.__NEXUS_DOM__.scan({}));
      out({
        ok: true,
        url: r.url,
        scanned: r.scanned,
        issueCount: r.issueCount,
        byKind: r.byKind,
        issues: r.issues.map((i) => ({
          kind: i.kind,
          sev: i.severity,
          file: i.file ? i.file.replace(/^.*?\/src\//, 'src/') : null,
          comp: i.component,
          sel: (i.selector || '').slice(0, 80),
          detail: i.detail,
        })),
      });
    } else if (cmd === 'inspect') {
      const target = positional.join(' ');
      if (!target) die('用法: ai.mjs inspect "按钮文字或选择器"');
      const r = await page.evaluate((t) => {
        const probe = window.__NEXUS_DOM__;
        const hits = [];
        // 1) 先当选择器试
        try {
          document.querySelectorAll(t).forEach((el) => hits.push(el));
        } catch {
          /* 不是合法选择器，走文本匹配 */
        }
        // 2) 文本 / aria-label / title 匹配
        if (!hits.length) {
          const all = document.querySelectorAll('button,a,input,[role=button],li,span,div');
          for (const el of all) {
            if (hits.length >= 8) break;
            const txt = (el.textContent || '').trim();
            const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '';
            if ((txt && txt.length < 60 && txt.includes(t)) || (label && label.includes(t))) {
              if (!el.querySelector('button,a')) hits.push(el);
            }
          }
        }
        return hits.slice(0, 6).map((el) => {
          const r = el.getBoundingClientRect();
          const vi = probe.vueInfo(el);
          const cs = getComputedStyle(el);
          return {
            sel: probe.cssPath(el),
            text: (el.textContent || '').trim().slice(0, 60),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            visible: !!(el.checkVisibility?.({ checkVisibilityCSS: true }) ?? true),
            display: cs.display,
            component: vi.component,
            file: vi.file ? vi.file.replace(/^.*?\/src\//, 'src/') : null,
          };
        });
      }, target);
      out({ ok: true, target, count: r.length, hits: r });
    } else if (cmd === 'shot') {
      const file = path.join(ROOT, '.debug', 'shots', `${flags.out || 'screen-' + Date.now()}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file, fullPage: flags.full === true });
      out({ ok: true, file, url: new URL(page.url()).pathname });
    } else if (cmd === 'act') {
      const kind = positional[0];
      const value = positional.slice(1).join(' ');
      if (!kind) die('用法: ai.mjs act <goto|reload|login|open|send|click|fill|press|eval> [参数]');
      const r = await act(page, kind, value, flags);
      out({ ok: true, action: kind, result: r });
    } else {
      die(`未知命令: ${cmd}（up/down/state/probe/inspect/shot/act）`);
    }
  } finally {
    // 只断开 CDP，不关闭浏览器（playwright 的 close 会杀掉整个浏览器）
    process.exit(0);
  }
}

main().catch((e) => die(e.message));
