/**
 * 抓一次「大流量终端输出」的 CPU profile，找出主线程卡顿的真实热点。
 *
 * 用法：
 *   node devtools/profile-output.mjs "clear; seq 1 5000"
 *
 * 前提：浏览器已用 devtools/ai.mjs up 起在 9333，且已登录。
 */
import { chromium } from 'playwright';

const PORT = Number(process.env.AI_PORT || 9333);
const command = process.argv[2] || 'clear; seq 1 5000';

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('localhost:5173'));
if (!page) {
  console.error('没找到 localhost:5173 的页面');
  process.exit(1);
}

const cdp = await ctx.newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
await cdp.send('Profiler.start');

const input = page.locator('input[data-focus-id=commandInput]');
await input.fill(command);
await input.press('Enter');

await page.waitForTimeout(9000);

const { profile } = await cdp.send('Profiler.stop');
await cdp.send('Profiler.disable');

const nodeById = new Map();
const parentOf = new Map();
for (const n of profile.nodes) {
  nodeById.set(n.id, n);
  for (const c of n.children || []) parentOf.set(c, n.id);
}

// --- 聚合 selfTime ---
const selfTime = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  const dt = (profile.timeDeltas[i] || 0) / 1000; // us -> ms
  selfTime.set(id, (selfTime.get(id) || 0) + dt);
}

const label = (n) => {
  const cf = n.callFrame;
  const url = (cf.url || '').split('/').slice(-2).join('/');
  return `${cf.functionName || '(anonymous)'} @ ${url}:${cf.lineNumber + 1}`;
};

const rows = [];
for (const [id, ms] of selfTime) {
  const n = nodeById.get(id);
  if (!n) continue;
  const cf = n.callFrame;
  rows.push({ id, ms, fn: cf.functionName || '(anonymous)', url: (cf.url || '').split('/').slice(-2).join('/'), line: cf.lineNumber + 1 });
}
rows.sort((a, b) => b.ms - a.ms);

console.log(`样本数: ${profile.samples.length}, 总时长约 ${Math.round(rows.reduce((a, b) => a + b.ms, 0))}ms`);
console.log('\n=== Self Time Top 12（含调用栈）===');
for (const r of rows.slice(0, 12)) {
  if (r.ms < 20) break;
  console.log(`\n--- ${r.ms.toFixed(1)}ms  ${r.fn} @ ${r.url}:${r.line}`);
  let cursor = r.id;
  for (let depth = 0; depth < 7; depth++) {
    const pid = parentOf.get(cursor);
    if (!pid) break;
    const p = nodeById.get(pid);
    if (!p) break;
    console.log(`      ↑ ${label(p)}`);
    cursor = pid;
  }
}

// --- 按文件聚合 ---
const byFile = new Map();
for (const r of rows) {
  const key = r.url || '(native)';
  byFile.set(key, (byFile.get(key) || 0) + r.ms);
}
console.log('\n=== 按文件 ===');
for (const [f, ms] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`${String(Math.round(ms)).padStart(8)}ms  ${f}`);
}

await browser.close();
