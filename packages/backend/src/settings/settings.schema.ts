import schemaJson from './settings.schema.data.json';

/**
 * 系统设置项的唯一定义处（见 settings.schema.data.json）。
 *
 * 之前这份信息散落在三个地方：前端 updateSetting 的白名单、前端 updateMultipleSettings 的
 * 白名单（与前者逐字重复），以及后端 controller 的白名单。三份之间没有任何校验，
 * 漏一处就是"PUT 返回 200 但值没写进去"的静默失败（新增设置项时真踩过）。
 *
 * 现在：
 *  - 后端直接读这里做写入校验与默认值补齐；
 *  - 前端通过 `npm run settings:gen` 生成一份只读副本（tools/gen-settings-schema.mjs），
 *    `npm run settings:check` 可在 CI 上发现漂移。
 */
export type SettingValueType = 'boolean' | 'string' | 'number' | 'json';

export interface SettingDefinition {
  type: SettingValueType;
  /** 缺省值（字符串形式，与数据库里存的一致）。不填表示"没有默认值" */
  default?: string;
  /** 是否允许通过 PUT /api/v1/settings 写入 */
  writable?: boolean;
  desc?: string;
}

const rawSchema = schemaJson as { settings: Record<string, SettingDefinition> };

export const SETTINGS_SCHEMA: Record<string, SettingDefinition> = rawSchema.settings;

/** 允许通过通用设置接口写入的键 */
export const WRITABLE_SETTING_KEYS: string[] = Object.entries(SETTINGS_SCHEMA)
  .filter(([, def]) => def.writable !== false)
  .map(([key]) => key);

const WRITABLE_KEY_SET = new Set(WRITABLE_SETTING_KEYS);

/** 带默认值的键 -> 默认值 */
export const SETTING_DEFAULTS: Record<string, string> = Object.fromEntries(
  Object.entries(SETTINGS_SCHEMA)
    .filter(([, def]) => typeof def.default === 'string')
    .map(([key, def]) => [key, def.default as string])
);

export function isWritableSettingKey(key: string): boolean {
  return WRITABLE_KEY_SET.has(key);
}

/**
 * 用 schema 里的默认值补齐缺失项。
 * 让 GET /settings 返回一份完整的设置对象，前端不必再维护一份 30 个 if 的默认值表。
 */
export function withSettingDefaults(record: Record<string, string>): Record<string, string> {
  return { ...SETTING_DEFAULTS, ...record };
}
