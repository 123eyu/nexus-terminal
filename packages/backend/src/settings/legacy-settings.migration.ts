/**
 * 「标签 → 文件夹」改名的**配置文件**迁移（一次性、幂等）。
 *
 * 数据库里的旧表名、旧设置键、旧审计动作名由 `database/migrations.ts` 的第 27 号迁移处理；
 * 这里处理的是**落盘的 JSON 配置**：`data/desktop-settings.json`。
 *
 * 为什么必须迁移而不是直接改 key：
 *   - `syncItems` 是用户「同步内容范围」的勾选结果，写进文件后不会再从设置页重新生成。
 *     直接把后端清单里的 `connections.tags` 改成 `connections.folders` 而不动这个文件，
 *     老用户的范围里就只剩一个「谁也不认识」的 key → `resolveSyncItems` 会按「一个都识别不了
 *     = 全开」兜底，看起来没事，其实用户关掉的项被重新打开了。
 *   - 反过来，留着旧 key 不清掉，每次启动都会带着历史包袱。
 *
 * 因此：就地改写 + 去重，写完即删旧值；重复执行无副作用。
 */
import fs from 'fs';
import path from 'path';
import { getDataDir } from '../services/storage-path.service';

/** 旧同步子项 key → 新 key。新增改名时只往这里加，别散落在业务代码里。 */
const SYNC_ITEM_KEYS: Record<string, string> = {
  'connections.tags': 'connections.folders',
  'quickCommands.tags': 'quickCommands.folders',
};

interface LegacyDesktopSettings {
  syncItems?: unknown;
  [key: string]: unknown;
}

function migrateSyncItems(items: unknown): { next: string[]; changed: boolean } | null {
  if (!Array.isArray(items)) return null;
  const next: string[] = [];
  let changed = false;
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const mapped = SYNC_ITEM_KEYS[raw] ?? raw;
    if (mapped !== raw) changed = true;
    if (!next.includes(mapped)) next.push(mapped);
  }
  // 去重也算改动（旧文件里可能出现映射后重复的项）
  if (next.length !== items.length) changed = true;
  return { next, changed };
}

/**
 * 把 desktop-settings.json 里的旧同步范围 key 换成新 key。
 * 文件不存在 / 解析失败都只是跳过 —— 配置坏了不该阻止后端启动。
 */
export function migrateLegacyDesktopSettings(): void {
  const filePath = path.join(getDataDir(), 'desktop-settings.json');
  if (!fs.existsSync(filePath)) return;

  let parsed: LegacyDesktopSettings;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err: any) {
    console.warn('[DesktopSettings] 读取失败，跳过「标签 → 文件夹」配置迁移:', err?.message);
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;

  const result = migrateSyncItems(parsed.syncItems);
  if (!result || !result.changed) return;

  parsed.syncItems = result.next;
  try {
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
    console.log(`[DesktopSettings] 同步范围已迁移到「文件夹」命名：${result.next.join(', ') || '(空)'}`);
  } catch (err: any) {
    console.warn('[DesktopSettings] 写入迁移后的配置失败:', err?.message);
  }
}
