#!/usr/bin/env node
/**
 * i18n 体检：
 *   1. 重复键 —— 同一个对象里写了两次同名键，JSON.parse 会静默保留最后一个，
 *      前一份内容直接消失（ja-JP.json 就踩过：整段 folders 被覆盖）。
 *   2. 代码里用到、但**所有**语言包都没有的键 —— 界面会直接显示原始 key
 *      （layout.configureButtonTooltip 曾经就是这样把 tooltip 显示成英文字符串）。
 *      只在 zh-CN 缺失但 en-US 有的，属于翻译滞后：中文界面会回退成英文（提示，不阻塞）。
 *   3. 各语言覆盖率 —— 只做提示，不阻塞（翻译通常滞后于中文文案）。
 *
 *   node tools/check-i18n.mjs           # 检查（有 1/2 类问题则退出码 1）
 *   node tools/check-i18n.mjs --strict  # 覆盖率差异也算失败
 *
 * 零依赖：自带一个极简 JSON 解析器，专门用来捕获重复键。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = join(root, 'packages/frontend/src/locales');
const SRC_DIR = join(root, 'packages/frontend/src');
const REFERENCE_LOCALE = 'zh-CN';
const strict = process.argv.includes('--strict');

/** 极简 JSON 解析器：返回 { value, duplicates: string[] } */
function parseJsonWithDuplicates(text) {
  let i = 0;
  const duplicates = [];

  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };

  const parseString = () => {
    // 调用前 text[i] === '"'
    i++;
    let out = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') {
        const esc = text[i + 1];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (esc === 'u') {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        out += map[esc] ?? esc;
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return out;
      }
      out += c;
      i++;
    }
    throw new Error('未闭合的字符串');
  };

  const parseValue = (path) => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj = {};
      const seen = new Set();
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const key = parseString();
        ws();
        if (text[i] !== ':') throw new Error(`期望 ':'，实际是 '${text[i]}'`);
        i++;
        const childPath = path ? `${path}.${key}` : key;
        if (seen.has(key)) duplicates.push(childPath);
        seen.add(key);
        // 重复键：后者覆盖前者，与 JSON.parse 行为一致
        obj[key] = parseValue(childPath);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        throw new Error(`期望 ',' 或 '}'，实际是 '${text[i]}'`);
      }
    }
    if (c === '[') {
      i++;
      const arr = [];
      ws();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue(`${path}[]`));
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        throw new Error(`期望 ',' 或 ']'，实际是 '${text[i]}'`);
      }
    }
    if (c === '"') return parseString();
    const start = i;
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
    const raw = text.slice(start, i);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    const num = Number(raw);
    if (Number.isNaN(num)) throw new Error(`非法字面量: ${raw}`);
    return num;
  };

  const value = parseValue('');
  return { value, duplicates };
}

function flatten(obj, prefix = '', out = {}) {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
    else out[full] = value;
  }
  return out;
}

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'locales' || name === 'debug' || name === '__tests__') continue;
      walkFiles(full, out);
    } else if (/\.(ts|vue)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 收集代码里静态使用到的 i18n 键。
 *
 * 记录是否带了"内联兜底"（`t('common.add', '添加')`）：带了兜底的键即使语言包里没有，
 * 界面也会显示兜底文案，不算缺陷；不带的才会把原始 key 直接显示出来。
 */
function collectUsedKeys() {
  const used = new Map(); // key -> { locs: string[], hasFallback: boolean }
  // t('a.b') / $t("a.b", '兜底')；忽略带插值的动态键
  const pattern = /(?<![\w.$])\$?t\(\s*(['"])([A-Za-z0-9_.-]+)\1(\s*,\s*(['"])[^'"`]*\4)?/g;

  for (const file of walkFiles(SRC_DIR)) {
    const text = readFileSync(file, 'utf8');
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text))) {
      const key = m[2];
      if (!key.includes('.') || key.endsWith('.')) continue; // t('ok') 这类多半不是 i18n
      const line = text.slice(0, m.index).split('\n').length;
      const entry = used.get(key) || { locs: [], hasFallback: false };
      entry.locs.push(`${relative(root, file)}:${line}`);
      if (m[3]) entry.hasFallback = true;
      used.set(key, entry);
    }
  }
  return used;
}

const localeFiles = readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json')).sort();
const locales = {};
const duplicateProblems = [];

for (const file of localeFiles) {
  const name = file.replace(/\.json$/, '');
  const { value, duplicates } = parseJsonWithDuplicates(readFileSync(join(LOCALES_DIR, file), 'utf8'));
  locales[name] = { flat: flatten(value), duplicates, file };
  for (const dup of duplicates) duplicateProblems.push(`${file}: ${dup}`);
}

const reference = locales[REFERENCE_LOCALE];
if (!reference) {
  console.error(`[i18n] 缺少基准语言包 ${REFERENCE_LOCALE}.json`);
  process.exit(1);
}

const refKeys = new Set(Object.keys(reference.flat));
const usedKeys = collectUsedKeys();
const allLocaleKeySets = Object.values(locales).map((l) => new Set(Object.keys(l.flat)));

const formatUsed = (entries) => entries.map(([key, info]) =>
  `${key}  ← ${info.locs.slice(0, 3).join(', ')}${info.locs.length > 3 ? ` 等 ${info.locs.length} 处` : ''}`);

const inAnyLocale = (key) => allLocaleKeySets.some((set) => set.has(key));

// 所有语言包都没有、且调用处也没给内联兜底 = 界面会直接显示原始 key
const missingEverywhere = formatUsed(
  [...usedKeys.entries()].filter(([key, info]) => !info.hasFallback && !inAnyLocale(key))
);

// 只有内联兜底在撑着的键（语言包全缺），文案改动时容易漏改，单独提示
const onlyFallback = [...usedKeys.entries()].filter(([key, info]) => info.hasFallback && !inAnyLocale(key)).length;

// 只是基准语言（zh-CN）缺、别的语言有 = 翻译滞后，中文界面回退成英文
const missingInReference = formatUsed(
  [...usedKeys.entries()].filter(([key]) => !refKeys.has(key) && inAnyLocale(key))
);

const coverage = [];
for (const name of Object.keys(locales)) {
  if (name === REFERENCE_LOCALE) continue;
  const keys = new Set(Object.keys(locales[name].flat));
  const missing = [...refKeys].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !refKeys.has(k));
  coverage.push({ name, missing, extra });
}

let failed = false;

if (duplicateProblems.length) {
  failed = true;
  console.error(`\n✗ 重复键（JSON.parse 会静默丢弃前一份）共 ${duplicateProblems.length} 处：`);
  for (const p of duplicateProblems) console.error(`  - ${p}`);
}

if (missingEverywhere.length) {
  failed = true;
  console.error(`\n✗ 代码里使用、但所有语言包都没有定义的键共 ${missingEverywhere.length} 个：`);
  for (const p of missingEverywhere) console.error(`  - ${p}`);
}

if (onlyFallback > 0) {
  console.log(`\nℹ 有 ${onlyFallback} 个键只靠调用处的内联兜底文案（语言包里没有，属正常用法）`);
}

if (missingInReference.length) {
  console.warn(`\n⚠ 代码里使用、但 ${REFERENCE_LOCALE} 未定义（会回退成 ${'en-US'}）共 ${missingInReference.length} 个：`);
  for (const p of missingInReference.slice(0, 20)) console.warn(`  - ${p}`);
  if (missingInReference.length > 20) console.warn(`  … 还有 ${missingInReference.length - 20} 个`);
  if (strict) failed = true;
}

for (const { name, missing, extra } of coverage) {
  const detail = `${name}: 缺 ${missing.length} 个${extra.length ? `，多 ${extra.length} 个` : ''}`;
  if (missing.length || extra.length) {
    console.warn(`\n⚠ ${detail}`);
    if (missing.length) console.warn(`   缺失示例: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}`);
    if (extra.length) console.warn(`   多余示例: ${extra.slice(0, 10).join(', ')}${extra.length > 10 ? ' …' : ''}`);
    if (strict) failed = true;
  }
}

if (failed) {
  console.error('\n[i18n] 检查未通过');
  process.exit(1);
}

console.log(`[i18n] 通过：${localeFiles.length} 个语言包，基准 ${refKeys.size} 个键，代码引用 ${usedKeys.size} 个键`);
