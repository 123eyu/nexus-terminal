import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SETTINGS_SCHEMA,
  SETTING_DEFAULTS,
  WRITABLE_SETTING_KEYS,
  isWritableSettingKey,
} from '../src/stores/settings.schema.generated.ts';

/**
 * 这份副本由 `npm run settings:gen` 从后端 schema 生成，
 * 测试只验证"生成结果自洽"，漂移检测由 `npm run settings:check` 负责。
 */
test('每个默认值都属于已声明的设置项', () => {
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    assert.ok(key in SETTINGS_SCHEMA, `默认值对应的键不存在于 schema: ${key}`);
  }
});

test('默认值只在 schema 声明 default 时出现', () => {
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    assert.equal(typeof value, 'string', `${key} 的默认值必须是字符串（与数据库存储一致）`);
    assert.equal(SETTINGS_SCHEMA[key as keyof typeof SETTINGS_SCHEMA].default, value);
  }
});

test('白名单与 schema 的 writable 标记一致', () => {
  const declaredWritable = Object.entries(SETTINGS_SCHEMA)
    .filter(([, def]) => def.writable !== false)
    .map(([key]) => key);

  assert.deepEqual([...WRITABLE_SETTING_KEYS].sort(), declaredWritable.sort());
});

test('isWritableSettingKey：已知键通过、未知键拒绝', () => {
  assert.equal(isWritableSettingKey('fileManagerHighlightChanges'), true);
  assert.equal(isWritableSettingKey('terminalSwitchPaneShortcut'), true);
  // 未在 schema 声明的键必须被拒（后端据此过滤，前端据此提前报错）
  assert.equal(isWritableSettingKey('totallyUnknownKey'), false);
  assert.equal(isWritableSettingKey(''), false);
});

test('保护性键不进入通用写入白名单', () => {
  for (const key of ['syncApiKey', 'desktop_sync_config']) {
    assert.equal(isWritableSettingKey(key), false, `${key} 不应允许通用写入`);
  }
});
