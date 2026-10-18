#!/usr/bin/env node
/**
 * eye.mjs — Nexus Terminal 前端"一次往返"诊断器
 *
 * 为什么不用浏览器 MCP 的逐步 snapshot：
 *   大页面的一次无障碍快照动辄数千 token，定位一个"按钮被遮住"要 5~10 轮。
 *   这里把判定逻辑放进页面内执行，一次 evaluate 返回「异常清单 + 源文件定位」，
 *   典型耗时 < 2s、输出 < 2k token。
 *
 * 用法：
 *   node devtools/eye.mjs                              # 只扫当前页（默认 http://localhost:5173）
 *   node devtools/eye.mjs --login                      # 登录（默认 admin/admin，可用 EYE_USER/EYE_PASS）
 *   node devtools/eye.mjs --reset --login --open 26    # 清残留会话 → 登录 → 打开连接，就绪即返回
 *   node devtools/eye.mjs --login --open IN-Host --exec "window.__NEXUS__.dumpTerminal()"
 *   node devtools/eye.mjs --report                     # 写 .debug/eye/<ts>/report.md
 *   node devtools/eye.mjs --steps steps.json --headed
 *   node devtools/eye.mjs --mobile --json
 *
 * 提速要点：
 *   - 探针挂 addInitScript，整页跳转（登录）后依然可用
 *   - --open 轮询"终端有输出"即返回，不再固定 sleep 10~15 秒
 *   - --reset 一条请求清掉 workspace_sync 里的残留会话，不用手动改库
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const PROBE = path.join(__dirname, 'dom-probe.js');

/* ------------------------------- 参数 ------------------------------- */

function parseArgs(argv) {
  const out = {
    url: 'http://localhost:5173',
    out: null,
    steps: null,
    exec: [],
    headed: false,
    keepOpen: false,
    full: false,
    json: false,
    report: false,
    allLogs: false,
    wait: 800,
    timeout: 30000,
    viewport: { width: 1440, height: 900 },
    mobile: false,
    quiet: false,
    login: null,
    open: null,
    reset: false,
    ready: 20000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    // 可选值：下一个是 --xxx 或不存在时视为无值
    const optional = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return undefined;
      i++;
      return v;
    };
    switch (a) {
      case '--url': out.url = next(); break;
      case '--out': out.out = next(); break;
      case '--steps': out.steps = next(); break;
      case '--exec': out.exec.push(next()); break;
      case '--shot': out.shot = next(); break;
      case '--wait': out.wait = parseInt(next(), 10); break;
      case '--timeout': out.timeout = parseInt(next(), 10); break;
      case '--ready': out.ready = parseInt(next(), 10); break;
      case '--login': out.login = optional() ?? true; break;
      case '--open': out.open = next(); break;
      case '--reset': out.reset = true; break;
      case '--viewport': {
        const [w, h] = next().split('x').map(Number);
        out.viewport = { width: w || 1440, height: h || 900 };
        break;
      }
      case '--headed': out.headed = true; break;
      case '--keep-open': out.keepOpen = true; out.headed = true; break;
      case '--full': out.full = true; break;
      case '--json': out.json = true; break;
      case '--report': out.report = true; break;
      case '--all-logs': out.allLogs = true; break;
      case '--mobile': out.mobile = true; out.viewport = { width: 390, height: 844 }; break;
      case '--quiet': out.quiet = true; break;
      case '-h':
      case '--help':
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default:
        if (a.startsWith('http')) out.url = a;
        else if (a.endsWith('.json')) out.steps = a;
        else console.warn(`[eye] 未知参数: ${a}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = args.out ? path.resolve(args.out) : path.join(ROOT, '.debug', 'eye', stamp);
const shotDir = path.join(outDir, 'shots');

/* ------------------------------ 采集器 ------------------------------ */

const consoleLogs = [];
const pageErrors = [];
const failedRequests = [];
const httpErrors = [];
const steps = [];

const MAX_CONSOLE = 400;

function brief(text, n = 300) {
  const s = String(text ?? '').replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function attachCollectors(page) {
  page.on('console', (msg) => {
    const type = msg.type();
    if (!args.allLogs && type !== 'error' && type !== 'warning') return;
    if (consoleLogs.length >= MAX_CONSOLE) return;
    consoleLogs.push({ type, text: brief(msg.text()), location: msg.location()?.url?.replace(args.url, '') });
  });
  page.on('pageerror', (err) => {
    pageErrors.push({ message: brief(err.message), stack: brief(err.stack, 900) });
  });
  page.on('requestfailed', (req) => {
    failedRequests.push({
      url: brief(req.url().replace(args.url, ''), 160),
      method: req.method(),
      error: req.failure()?.errorText,
    });
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && httpErrors.length < 80) {
      httpErrors.push({ status: res.status(), url: brief(res.url().replace(args.url, ''), 160), method: res.request().method() });
    }
  });
}

/* ------------------------------ 主流程 ------------------------------ */

async function injectProbe(page) {
  const src = fs.readFileSync(PROBE, 'utf8');
  await page.evaluate(src);
  return page.evaluate(() => window.__NEXUS_DOM__?.version ?? null);
}

async function snap(page, label) {
  const data = await page.evaluate(
    ({ maxOutline }) => {
      const p = window.__NEXUS_DOM__;
      if (!p) return { error: 'probe 未注入' };
      return p.snapshot({ maxOutline });
    },
    { maxOutline: 60 }
  );
  if (label) data.label = label;
  return data;
}

/* --------------------------- 快捷动作 --------------------------- *
 * 以前每做一次验证都要手写 "登录 → 找连接 → 开会话 → 干等 12 秒" 的 exec，
 * 一轮 30 秒起步。这里把三件事做成内置动作，并且用轮询替代固定 sleep：
 * 终端一就绪立刻往下走，通常 3~6 秒。
 * ---------------------------------------------------------------- */

function credentials(spec) {
  if (spec === true || spec === 'true') {
    return { user: process.env.EYE_USER || 'admin', pass: process.env.EYE_PASS || 'admin' };
  }
  const idx = String(spec).indexOf(':');
  if (idx === -1) return { user: String(spec), pass: process.env.EYE_PASS || 'admin' };
  return { user: String(spec).slice(0, idx), pass: String(spec).slice(idx + 1) };
}

async function doLogin(page, spec) {
  const { user, pass } = credentials(spec);
  const t0 = Date.now();
  if (!(await page.locator('#password').count())) {
    await page.goto(new URL('/login', args.url).toString(), { waitUntil: 'domcontentloaded', timeout: args.timeout });
  }
  await page.waitForSelector('#username', { timeout: 15000 });
  await page.fill('#username', user);
  await page.fill('#password', pass);
  await page.click('button[type=submit]');
  // 登录成功是整页跳转，等离开 /login 即可（比 sleep 稳）
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });
  return { user, ms: Date.now() - t0, url: new URL(page.url()).pathname };
}

/** 轮询到"终端有输出"就返回；超时才放弃，不会白等满 */
async function waitTerminalReady(page, timeout) {
  const t0 = Date.now();
  try {
    await page.waitForFunction(
      () => {
        const n = window.__NEXUS__;
        if (n && typeof n.dumpTerminal === 'function') {
          const d = n.dumpTerminal();
          // 有内容且不是全空白才算就绪（刚建实例时 buffer 里是 26 行空格）
          if (d && (d.bufferLines ?? 0) > 0 && !d.blank) return true;
        }
        const rows = document.querySelector('.xterm-rows');
        return !!rows && (rows.textContent || '').trim().length > 0;
      },
      null,
      { timeout, polling: 200 }
    );
    return { ready: true, ms: Date.now() - t0 };
  } catch {
    return { ready: false, ms: Date.now() - t0, note: `终端未在 ${timeout}ms 内就绪` };
  }
}

async function doOpen(page, target) {
  const t0 = Date.now();
  // 登录是整页跳转，等 Vue 挂载 + 连接列表拉取完成后再取 pinia
  await page
    .waitForFunction(() => {
      const el = document.querySelector('#app');
      const pinia = el && el.__vue_app__ && el.__vue_app__.config.globalProperties.$pinia;
      if (!pinia) return false;
      const c = pinia._s.get('connections');
      return !!(c && Array.isArray(c.connections) && c.connections.length > 0);
    }, null, { timeout: 20000 })
    .catch(() => {});
  const result = await page.evaluate((t) => {
    const appEl = document.querySelector('#app');
    const pinia = appEl && appEl.__vue_app__ && appEl.__vue_app__.config.globalProperties.$pinia;
    if (!pinia) return { ok: false, error: '#app / pinia 尚未就绪' };
    const connectionsStore = pinia._s.get('connections');
    const sessionStore = pinia._s.get('session');
    if (!connectionsStore || !sessionStore) return { ok: false, error: 'store 未注册' };
    const list = connectionsStore.connections || [];
    const key = String(t).toLowerCase();
    const conn =
      list.find((c) => String(c.id) === String(t)) ||
      list.find((c) => String(c.name).toLowerCase() === key) ||
      list.find((c) => String(c.name).toLowerCase().includes(key));
    if (!conn) {
      return { ok: false, error: `未找到连接 "${t}"`, available: list.map((c) => `${c.id}:${c.name}`) };
    }
    sessionStore.handleConnectRequest(conn);
    return { ok: true, id: conn.id, name: conn.name };
  }, target);

  if (!result.ok) {
    throw new Error(`${result.error}${result.available ? ' | 可用: ' + result.available.join(' , ') : ''}`);
  }
  await page.waitForURL((url) => url.pathname.includes('/workspace') || url.pathname === '/', { timeout: 15000 }).catch(() => {});
  const ready = await waitTerminalReady(page, args.ready);
  return { ...result, ...ready, totalMs: Date.now() - t0 };
}

async function doReset(page) {
  const res = await page.request.post(new URL('/api/v1/debug/reset-sessions', args.url).toString(), { timeout: 10000 });
  if (!res.ok()) throw new Error(`reset 失败 HTTP ${res.status()}（后端是否已启动？）`);
  return await res.json();
}

/* ------------------------------ 步骤 ------------------------------ */

async function runStep(page, step, index) {
  const name = Object.keys(step)[0];
  const value = step[name];
  const t0 = Date.now();
  const result = { index, action: name, target: typeof value === 'string' ? value : value?.selector ?? value?.value };

  try {
    switch (name) {
      case 'login':
        result.data = await doLogin(page, value === true || value === undefined ? true : value);
        break;
      case 'open':
        result.data = await doOpen(page, value);
        break;
      case 'reset':
        result.data = await doReset(page);
        break;
      case 'waitReady':
        result.data = await waitTerminalReady(page, Number(value) || args.ready);
        break;
      case 'goto':
        await page.goto(new URL(value, args.url).toString(), { waitUntil: 'domcontentloaded', timeout: args.timeout });
        break;
      case 'wait':
        await page.waitForTimeout(value);
        break;
      case 'waitFor':
        await page.waitForSelector(value, { timeout: args.timeout, state: 'visible' });
        break;
      case 'waitForText':
        await page.getByText(value, { exact: false }).first().waitFor({ timeout: args.timeout });
        break;
      case 'click':
        await page.locator(value).first().click({ timeout: args.timeout });
        break;
      case 'clickText':
        await page.getByText(value, { exact: false }).first().click({ timeout: args.timeout });
        break;
      case 'fill':
        await page.locator(value.selector).first().fill(String(value.value));
        break;
      case 'type':
        await page.locator(value.selector).first().type(String(value.value), { delay: value.delay ?? 20 });
        break;
      case 'press':
        await page.keyboard.press(value);
        break;
      case 'hover':
        await page.locator(value).first().hover({ timeout: args.timeout });
        break;
      case 'shot': {
        const file = path.join(shotDir, `${String(value || `step-${index}`).replace(/[^\w.-]/g, '_')}.png`);
        fs.mkdirSync(shotDir, { recursive: true });
        await page.screenshot({ path: file, fullPage: args.full });
        result.file = path.relative(outDir, file).replace(/\\/g, '/');
        break;
      }
      case 'scan': {
        result.data = await snap(page, `step-${index}`);
        break;
      }
      case 'exec':
        result.data = await page.evaluate(value);
        break;
      case 'settle': {
        result.data = await page.evaluate(
          ({ timeout }) => window.__NEXUS_DOM__.waitStable({ timeout, quietMs: 200 }),
          { timeout: value || 4000 }
        );
        break;
      }
      case 'expect': {
        const loc = page.locator(value.selector).first();
        const visible = await loc.isVisible().catch(() => false);
        const count = await page.locator(value.selector).count();
        const ok = value.visible === undefined ? count > 0 : visible === value.visible;
        result.ok = ok;
        result.detail = `count=${count} visible=${visible}`;
        if (value.text) {
          const txt = (await loc.textContent().catch(() => '')) || '';
          result.textMatched = txt.includes(value.text);
          if (!result.textMatched) result.ok = false;
          result.detail += ` textMatches=${result.textMatched}`;
        }
        break;
      }
      default:
        result.skipped = `未知动作: ${name}`;
    }
  } catch (error) {
    result.error = brief(error.message);
  }
  result.ms = Date.now() - t0;
  return result;
}

function renderMarkdown(report) {
  const L = [];
  L.push(`# 前端诊断报告 ${report.meta.time}`);
  L.push('');
  L.push(`- 地址：\`${report.meta.url}\``);
  L.push(`- 视口：${report.meta.viewport.width}x${report.meta.viewport.height}${report.meta.mobile ? '（移动端模拟）' : ''}`);
  L.push(`- 可见元素：${report.snapshot?.visibleElementCount ?? '-'}　终端数：${report.snapshot?.terminals ?? '-'}`);
  L.push(`- 探针耗时：${report.snapshot?.elapsedMs ?? '-'} ms　总耗时：${report.meta.elapsedMs} ms`);
  L.push('');

  const issues = report.snapshot?.issues || [];
  L.push(`## 异常清单（${issues.length}）`);
  if (!issues.length) {
    L.push('');
    L.push('未命中任何布局/可见性/对比度不变量。');
  } else {
    const order = { high: 0, medium: 1, low: 2 };
    issues
      .slice()
      .sort((a, b) => (order[a.sev] ?? 9) - (order[b.sev] ?? 9))
      .forEach((i, n) => {
        L.push('');
        L.push(`### ${n + 1}. [${i.sev}] ${i.kind}`);
        if (i.detail) L.push(`- 现象：${i.detail}`);
        if (i.comp || i.file) L.push(`- 来源：${i.comp || '?'}${i.file ? `　\`${i.file}\`` : ''}`);
        if (i.sel) L.push(`- 选择器：\`${i.sel}\``);
        if (i.rect) L.push(`- 区域：x=${i.rect.x} y=${i.rect.y} ${i.rect.w}x${i.rect.h}`);
        if (i.text) L.push(`- 文本：${i.text}`);
      });
  }
  L.push('');

  if (report.consoleLogs?.length) {
    L.push(`## 控制台 error/warn（${report.consoleLogs.length}）`);
    L.push('```');
    report.consoleLogs.slice(-40).forEach((c) => L.push(`[${c.type}] ${c.text}`));
    L.push('```');
    L.push('');
  }
  if (report.pageErrors?.length) {
    L.push(`## 未捕获异常（${report.pageErrors.length}）`);
    L.push('```');
    report.pageErrors.forEach((e) => L.push(`${e.message}\n${e.stack || ''}`));
    L.push('```');
    L.push('');
  }
  if (report.httpErrors?.length || report.failedRequests?.length) {
    L.push('## 网络异常');
    L.push('```');
    report.httpErrors.forEach((e) => L.push(`HTTP ${e.status} ${e.method} ${e.url}`));
    report.failedRequests.forEach((e) => L.push(`FAILED ${e.method} ${e.url} ${e.error}`));
    L.push('```');
    L.push('');
  }
  if (report.steps?.length) {
    L.push('## 执行步骤');
    L.push('| # | 动作 | 目标 | 耗时 | 结果 |');
    L.push('|---|---|---|---|---|');
    report.steps.forEach((s) => {
      const flag = s.error ? `❌ ${s.error}` : s.ok === false ? `❌ ${s.detail || ''}` : '✅';
      L.push(`| ${s.index} | ${s.action} | \`${brief(String(s.target ?? ''), 40)}\` | ${s.ms}ms | ${flag} |`);
    });
    L.push('');
  }
  const shots = fs.existsSync(shotDir) ? fs.readdirSync(shotDir).filter((f) => f.endsWith('.png')) : [];
  if (shots.length) {
    L.push('## 截图');
    shots.forEach((f) => L.push(`![${f}](shots/${f})`));
    L.push('');
  }
  return L.join('\n');
}

async function main() {
  if (!fs.existsSync(PROBE)) throw new Error(`探针文件缺失: ${PROBE}`);

  const browser = await chromium.launch({
    channel: process.env.EYE_BROWSER_CHANNEL || 'chrome',
    headless: !args.headed,
    args: ['--force-device-scale-factor=1'],
  }).catch(async (err) => {
    console.warn(`[eye] 系统 Chrome 启动失败（${err.message.split('\n')[0]}），尝试内置 chromium…`);
    return chromium.launch({ headless: !args.headed });
  });

  const context = await browser.newContext({
    viewport: args.viewport,
    deviceScaleFactor: 1,
    isMobile: args.mobile,
    hasTouch: args.mobile,
    locale: 'zh-CN',
    ignoreHTTPSErrors: true,
  });
  // 关键：把探针挂成 initScript，页面每次导航/整页刷新都会自动带上。
  // 否则"登录成功 → 整页跳转"之后 window.__NEXUS_DOM__ 就没了，
  // 后续的 settle / scan 全部报 undefined（之前排查时就踩过这个坑）。
  await context.addInitScript({ path: PROBE });

  const page = await context.newPage();
  attachCollectors(page);

  const t0 = Date.now();
  const result = { meta: {}, snapshot: null, steps, consoleLogs, pageErrors, failedRequests, httpErrors };

  try {
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: args.timeout });
    await page.waitForTimeout(args.wait);

    const probeVersion = await injectProbe(page);
    if (!probeVersion) throw new Error('探针注入失败');

    // 默认先稳定一下（SPA 首次渲染 + 路由守卫跳转）
    await page.evaluate(() => window.__NEXUS_DOM__.waitStable({ timeout: 3500, quietMs: 250 })).catch(() => {});

    // --- 内置快捷流程：reset → login → open（任一项都可用 CLI 单独触发） ---
    if (args.reset) {
      const t = Date.now();
      const data = await doReset(page);
      steps.push({ index: steps.length, action: 'reset', ok: true, data, ms: Date.now() - t });
    }
    if (args.login) {
      const t = Date.now();
      const data = await doLogin(page, args.login);
      await injectProbe(page); // 整页跳转后兜底（initScript 已注入，这里只保证版本号）
      steps.push({ index: steps.length, action: 'login', ok: true, data, ms: Date.now() - t });
    }
    if (args.open) {
      const t = Date.now();
      const data = await doOpen(page, args.open);
      steps.push({ index: steps.length, action: 'open', ok: true, data, ms: Date.now() - t });
    }
    if (args.reset || args.login || args.open) {
      await page.evaluate(() => window.__NEXUS_DOM__?.waitStable({ timeout: 3000, quietMs: 200 })).catch(() => {});
    }

    if (args.steps) {
      const raw = fs.readFileSync(path.resolve(args.steps), 'utf8');
      const list = JSON.parse(raw);
      for (let i = 0; i < list.length; i++) {
        steps.push(await runStep(page, list[i], i));
        await page.waitForTimeout(120);
      }
    }

    for (const code of args.exec) {
      try {
        const data = await page.evaluate(code);
        steps.push({ index: steps.length, action: 'exec', target: brief(code, 50), ok: true, data, ms: 0 });
      } catch (error) {
        steps.push({ index: steps.length, action: 'exec', target: brief(code, 50), ok: false, error: brief(error.message), ms: 0 });
      }
    }

    result.snapshot = await snap(page);

    fs.mkdirSync(shotDir, { recursive: true });
    const shotName = (args.shot || 'screen').replace(/[^\w.-]/g, '_');
    const shotPath = path.join(shotDir, `${shotName}.png`);
    await page.screenshot({ path: shotPath, fullPage: args.full });

    result.meta = {
      time: new Date().toISOString(),
      url: args.url,
      finalUrl: page.url(),
      viewport: args.viewport,
      mobile: args.mobile,
      probeVersion,
      elapsedMs: Date.now() - t0,
      shot: path.relative(outDir, shotPath).replace(/\\/g, '/'),
    };

    if (args.report || !args.json) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(result, null, 2), 'utf8');
      fs.writeFileSync(path.join(outDir, 'report.md'), renderMarkdown(result), 'utf8');
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2));
    } else {
      const issues = result.snapshot.issues || [];
      const high = issues.filter((i) => i.sev === 'high').length;
      console.log(`\n[eye] ${result.meta.finalUrl}  ${args.viewport.width}x${args.viewport.height}  ${result.meta.elapsedMs}ms`);
      console.log(`[eye] 可见元素 ${result.snapshot.visibleElementCount} | 异常 ${issues.length}（high ${high}）| 控制台 ${consoleLogs.length} | 页面异常 ${pageErrors.length} | 网络错误 ${httpErrors.length + failedRequests.length}`);
      if (issues.length) {
        console.log('');
        issues.slice(0, 20).forEach((i) => {
          const src = i.file ? ` @ ${i.file.replace(/^.*?\/src\//, 'src/')}` : i.comp ? ` @ <${i.comp}>` : '';
          console.log(`  [${i.sev}] ${i.kind}${src}`);
          console.log(`        ${i.detail}`);
          if (i.sel) console.log(`        ${i.sel}  ${i.rect ? `${i.rect.w}x${i.rect.h} @${i.rect.x},${i.rect.y}` : ''}`);
        });
        if (issues.length > 20) console.log(`  … 其余 ${issues.length - 20} 条见 report.md`);
      }
      console.log(`\n[eye] 输出目录: ${outDir}`);
      console.log(`[eye] 报告: ${path.join(outDir, 'report.md')}`);
    }

    if (args.keepOpen) {
      console.log('[eye] --keep-open：浏览器保持打开，按 Ctrl+C 结束');
      await page.waitForTimeout(10 * 60 * 1000);
    }
  } finally {
    if (!args.keepOpen) {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error('[eye] 失败:', error.message);
  if (/Executable doesn't exist|browserType.launch/.test(error.message)) {
    console.error('[eye] 提示：需要本机 Chrome，或执行 npx playwright install chromium');
  }
  process.exit(1);
});
