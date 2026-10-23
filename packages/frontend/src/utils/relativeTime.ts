import { formatDistanceToNow } from 'date-fns';
import { zhCN, enUS, ja } from 'date-fns/locale';
import type { Locale as DateFnsLocale } from 'date-fns';

/**
 * 后端所有时间戳都是**秒**（`last_connected_at` / `created_at` …），date-fns 要毫秒，
 * 这里统一换算，顺便把 i18n 的 locale（zh-CN / en-US / ja-JP，也可能是 zh / en / ja）
 * 映射到 date-fns 的 locale。
 */
const BY_FULL_TAG: Record<string, DateFnsLocale> = {
  'zh-CN': zhCN,
  'zh-TW': zhCN,
  'en-US': enUS,
  'en-GB': enUS,
  'ja-JP': ja,
};

const BY_LANG: Record<string, DateFnsLocale> = {
  zh: zhCN,
  en: enUS,
  ja,
};

/**
 * 把秒级时间戳格式化成「3 分钟前 / 2 days ago」。
 * 拿不到有效时间戳时返回 fallback（比如「从未连接」）。
 */
export function formatRelativeFromSeconds(
  seconds: number | null | undefined,
  i18nLocale: string | undefined,
  fallback = ''
): string {
  if (!seconds || !Number.isFinite(seconds)) return fallback;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return fallback;

  const tag = i18nLocale || 'zh-CN';
  const locale = BY_FULL_TAG[tag] ?? BY_LANG[tag.split('-')[0]] ?? enUS;
  return formatDistanceToNow(date, { addSuffix: true, locale });
}
