/**
 * 开发期前端日志接收端点（仅非 production 挂载）
 *
 * 用途：前端 console.error / VueError / 未捕获异常 → 落盘到
 *   <数据目录>/.debug/frontend-runtime.log
 * 让 AI 不必打开 DevTools，直接读文件即可复盘。
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getDataDir } from '../services/storage-path.service';
import { getDbInstance, getDb, runDb } from '../database/connection';

const router = Router();

function logFile(): string {
  const dir = path.join(getDataDir(), '.debug');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'frontend-runtime.log');
}

interface Entry {
  t?: number;
  level?: string;
  args?: string;
  stack?: string;
  url?: string;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;

function append(entries: Entry[]) {
  const file = logFile();
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_FILE_BYTES) {
      fs.renameSync(file, file.replace(/\.log$/, `.${Date.now()}.log`));
    }
  } catch {
    /* 轮转失败不影响写入 */
  }
  const lines = entries.map((e) => {
    const ts = e.t ? new Date(e.t).toISOString() : new Date().toISOString();
    const lvl = (e.level || 'log').toUpperCase().padEnd(5);
    const where = e.url ? ` (${e.url})` : '';
    const stack = e.stack ? `\n${e.stack}` : '';
    return `${ts} ${lvl}${where} ${e.args || ''}${stack}`;
  });
  fs.appendFileSync(file, lines.join('\n') + '\n', 'utf8');
}

/** POST /api/v1/debug/log — 批量写入前端日志 */
router.post('/log', (req: Request, res: Response) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
  if (!entries) {
    res.status(400).json({ message: 'entries 必须是数组' });
    return;
  }
  try {
    append(entries.slice(0, 500));
    res.json({ ok: true, written: Math.min(entries.length, 500) });
  } catch (error) {
    console.error('[debug] 写入前端日志失败:', error);
    res.status(500).json({ message: '写入失败' });
  }
});

/** GET /api/v1/debug/log?tail=200 — 读取最近 N 行 */
router.get('/log', (req: Request, res: Response) => {
  const file = logFile();
  if (!fs.existsSync(file)) {
    res.json({ ok: true, lines: [], total: 0, file });
    return;
  }
  const tail = Math.min(parseInt(String(req.query.tail || '200'), 10) || 200, 5000);
  const content = fs.readFileSync(file, 'utf8');
  const all = content.split('\n').filter(Boolean);
  res.json({
    ok: true,
    file,
    total: all.length,
    lines: tail > 0 ? all.slice(-tail) : all,
  });
});

/** DELETE /api/v1/debug/log — 清空 */
router.delete('/log', (_req: Request, res: Response) => {
  const file = logFile();
  if (fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
  res.json({ ok: true });
});

/** GET /api/v1/debug/ping — 探活，前端可据此判断落盘通道是否可用 */
router.get('/ping', (_req: Request, res: Response) => {
  res.json({ ok: true, file: logFile(), mode: process.env.NODE_ENV || 'development' });
});

/**
 * POST /api/v1/debug/reset-sessions — 清空"恢复用"的会话快照
 *
 * 调试时反复开关会话会把 workspace_sync 里的 sessions 越积越多，
 * 下次打开页面时全部恢复，导致环境不干净、每次验证都要先手动清理。
 * 有了它，自动化脚本一条请求就能回到干净状态。
 */
router.post('/reset-sessions', async (_req: Request, res: Response) => {
  try {
    const db = await getDbInstance();
    const row = await getDb<{ state: string }>(db, 'SELECT state FROM workspace_sync LIMIT 1');
    if (!row) {
      res.json({ ok: true, cleared: 0 });
      return;
    }
    const state = JSON.parse(row.state || '{}');
    const cleared = Array.isArray(state.sessions) ? state.sessions.length : 0;
    state.sessions = [];
    state.sessionOrder = [];
    state.activeSessionId = null;
    state.updatedAt = Date.now();
    await runDb(db, "UPDATE workspace_sync SET state = ?, updated_at = strftime('%s','now')", [JSON.stringify(state)]);
    res.json({ ok: true, cleared });
  } catch (error) {
    console.error('[debug] 重置会话失败:', error);
    res.status(500).json({ ok: false, message: (error as Error).message });
  }
});

export default router;
