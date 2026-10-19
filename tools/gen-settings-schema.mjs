#!/usr/bin/env node
/**
 * 从后端 settings.schema.json 生成前端只读副本。
 *
 *   node tools/gen-settings-schema.mjs          # 生成/更新
 *   node tools/gen-settings-schema.mjs --check  # 只校验，不一致则退出码 1（可挂 CI）
 *
 * 为什么用生成而不是让前端直接 import 后端的文件：
 *   后端 tsconfig 的 rootDir 是 ./src，编译产物布局（dist/index.js）依赖这个结构，
 *   跨包相对导入会打破它；生成一份已入库的副本是最省事且不会引入构建耦合的做法。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(root, 'packages/backend/src/settings/settings.schema.data.json');
const TARGET = resolve(root, 'packages/frontend/src/stores/settings.schema.generated.ts');

const schema = JSON.parse(readFileSync(SOURCE, 'utf8'));
const settings = schema.settings;

if (!settings || typeof settings !== 'object') {
  console.error(`[settings:gen] ${SOURCE} 缺少 settings 字段`);
  process.exit(1);
}

const keys = Object.keys(settings);
const writableKeys = keys.filter((k) => settings[k].writable !== false);
const defaults = keys.filter((k) => typeof settings[k].default === 'string');

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

const lines = [];
lines.push('/* eslint-disable */');
lines.push('// 此文件由 tools/gen-settings-schema.mjs 自动生成，请勿手动编辑。');
lines.push('// 唯一来源：packages/backend/src/settings/settings.schema.data.json');
lines.push('// 重新生成：npm run settings:gen');
lines.push('');
lines.push('export interface SettingSchemaEntry {');
lines.push("  type: 'boolean' | 'string' | 'number' | 'json';");
lines.push('  default?: string;');
lines.push('  writable?: boolean;');
lines.push('  desc?: string;');
lines.push('}');
lines.push('');
lines.push('/** 全部设置项定义（顺序与 schema 一致） */');
lines.push('export const SETTINGS_SCHEMA = {');
for (const key of keys) {
  const def = settings[key];
  const parts = [`type: ${q(def.type)}`];
  if (typeof def.default === 'string') parts.push(`default: ${q(def.default)}`);
  if (def.writable === false) parts.push('writable: false');
  lines.push(`  ${key}: { ${parts.join(', ')} },`);
}
lines.push('} as const satisfies Record<string, SettingSchemaEntry>;');
lines.push('');
lines.push('export type SettingKey = keyof typeof SETTINGS_SCHEMA;');
lines.push('');
lines.push('/** 允许通过 PUT /api/v1/settings 写入的键 */');
lines.push('export const WRITABLE_SETTING_KEYS = [');
for (const key of writableKeys) lines.push(`  ${q(key)},`);
lines.push('] as const;');
lines.push('');
lines.push('export type WritableSettingKey = (typeof WRITABLE_SETTING_KEYS)[number];');
lines.push('');
lines.push('const WRITABLE_KEY_SET: ReadonlySet<string> = new Set(WRITABLE_SETTING_KEYS);');
lines.push('');
lines.push('export function isWritableSettingKey(key: string): boolean {');
lines.push('  return WRITABLE_KEY_SET.has(key);');
lines.push('}');
lines.push('');
lines.push('/** 带默认值的键 -> 默认值（字符串，与数据库存储一致） */');
lines.push('export const SETTING_DEFAULTS: Readonly<Record<string, string>> = {');
const maxKey = Math.max(...defaults.map((k) => k.length + 2));
for (const key of defaults) {
  lines.push(`  ${pad(`${key}:`, maxKey)} ${q(settings[key].default)},`);
}
lines.push('};');
lines.push('');

const output = lines.join('\n');

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(TARGET, 'utf8');
  } catch {
    console.error(`[settings:check] 缺少生成文件 ${TARGET}，请运行 npm run settings:gen`);
    process.exit(1);
  }
  if (current !== output) {
    console.error('[settings:check] 前端设置副本与后端 schema 不一致，请运行 npm run settings:gen');
    process.exit(1);
  }
  console.log(`[settings:check] 一致（${keys.length} 个设置项，${defaults.length} 个默认值）`);
  process.exit(0);
}

writeFileSync(TARGET, output, 'utf8');
console.log(
  `[settings:gen] 已生成 ${TARGET.replace(root + '\\', '').replace(root + '/', '')}`
    + `（${keys.length} 个设置项，${defaults.length} 个默认值）`
);
