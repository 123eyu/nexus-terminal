import type { LayoutNode, LayoutPreset, PaneName } from '../types/layout';

// 本文件必须保持"零运行时依赖"（只有 import type），单测才能用
// node --experimental-strip-types 直接跑它。深拷贝因此内联实现。
const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/**
 * 布局预设的纯逻辑：命名清洗、默认预设构造、存储预设与出厂预设的对齐。
 *
 * 这些判断直接决定"升级后用户的布局会不会被盖掉"，是最需要测试、
 * 却一直埋在 1700 行 store 里的部分。
 */

export const DEFAULT_PRESET_ID = 'preset-default';
export const DEFAULT_PRESET_NAME = '默认布局';

/** 早期版本内置、现已废弃的模板预设 */
export const LEGACY_TEMPLATE_IDS: ReadonlySet<string> = new Set([
  'preset-single-terminal',
  'preset-dual-terminals',
  'preset-terminal-files',
]);

export interface SidebarPanes {
  left: PaneName[];
  right: PaneName[];
}

/** 默认预设名称清洗：去掉历史数据里可能残留的星标 */
export function sanitizeDefaultPresetName(name: string | undefined): string {
  const cleaned = (name || '').replace(/^[\s★☆⭐]+/, '').trim();
  return cleaned || DEFAULT_PRESET_NAME;
}

/**
 * 用"用户当前正在使用的布局"生成全局默认预设。
 *
 * 升级兼容的核心：旧版本没有预设概念，用户攒下来的布局只存在
 * settings.layout / localStorage 里。如果直接塞一个硬编码的内置默认，
 * 用户升级后看到的布局就被预设的默认布局覆盖掉了。
 */
export function buildDefaultPresetFrom(
  tree: LayoutNode | null | undefined,
  sidebars: SidebarPanes | null | undefined,
  fallback: { tree: LayoutNode; sidebars: SidebarPanes }
): LayoutPreset {
  return {
    id: DEFAULT_PRESET_ID,
    name: DEFAULT_PRESET_NAME,
    isDefault: true,
    isSystem: true,
    layoutTree: deepClone(tree ?? fallback.tree),
    sidebarPanes: deepClone(sidebars ?? fallback.sidebars),
    connectionIds: [],
  };
}

/**
 * 预设同步用的稳定签名（判断"内容是否真的变了"）。
 *
 * 排除 `isDefault` 这类派生字段与数组顺序，否则：
 * - 切换默认预设会把整份数据重推一遍，后端的 updated_at 被顶到最新，
 *   另一端的推送在 LWW 里永远比不过 —— 跨端同步变成单向的。
 */
export function buildPresetsSignature(
  presets: LayoutPreset[],
  defaultId: string,
  map: Record<string, string>
): string {
  const normalized = [...presets]
    .map((p) => ({
      id: p.id,
      name: p.name,
      layoutTree: p.layoutTree,
      sidebarPanes: p.sidebarPanes,
      connectionIds: p.connectionIds || [],
      connectionUuids: p.connectionUuids || [],
      updatedAt: p.updatedAt || 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const normalizedMap: Record<string, string> = {};
  Object.keys(map || {})
    .sort()
    .forEach((key) => {
      normalizedMap[key] = map[key];
    });
  return JSON.stringify({ presets: normalized, defaultId, map: normalizedMap });
}

/**
 * 把"存储里的预设列表"与系统默认预设对齐：
 * 1. 过滤掉已废弃的内置模板；
 * 2. 缺 preset-default 时用 seedPreset（用户当前布局）补齐，而不是内置默认；
 * 3. 已存在但仍是"未编辑过的出厂种子"时，同样换成 seedPreset ——
 *    修复早前升级时默认布局已经盖掉用户布局的用户。
 *
 * @param builtinLayout 出厂默认布局，用于判断"预设是否还是未编辑过的种子"
 * @param signatureOf 布局结构签名函数（注入 utils/layoutTree.layoutShapeSignature）。
 *   本文件不能运行时 import 它 —— 否则单测无法用 node --experimental-strip-types
 *   直接加载（该 runner 不做无扩展名解析）。
 */
export function reconcilePresets(
  stored: LayoutPreset[],
  seedPreset: LayoutPreset,
  builtinLayout: LayoutNode,
  signatureOf: (node: LayoutNode | null | undefined) => string
): LayoutPreset[] {
  const list = (Array.isArray(stored) ? stored : [])
    .filter((p) => p && typeof p.id === 'string' && !LEGACY_TEMPLATE_IDS.has(p.id));

  const idx = list.findIndex((p) => p.id === DEFAULT_PRESET_ID);
  if (idx === -1) {
    list.unshift(seedPreset);
    return list;
  }

  const existing = list[idx];
  if (existing.id === DEFAULT_PRESET_ID) {
    existing.name = sanitizeDefaultPresetName(existing.name);
    existing.isSystem = true;
  }

  const builtinSignature = signatureOf(builtinLayout);
  const isPristineSeed =
    existing.name === DEFAULT_PRESET_NAME &&
    !!existing.layoutTree &&
    signatureOf(existing.layoutTree) === builtinSignature;
  const userHasOwnLayout = signatureOf(seedPreset.layoutTree) !== builtinSignature;

  // 只有"预设还是出厂种子 + 用户现有布局确实是自己攒的"才接管，
  // 避免覆盖用户手动恢复成出厂默认之后的状态。
  if (isPristineSeed && userHasOwnLayout) {
    list[idx] = {
      ...existing,
      layoutTree: deepClone(seedPreset.layoutTree),
      sidebarPanes: deepClone(seedPreset.sidebarPanes),
      updatedAt: Date.now(),
    };
  }

  return list;
}
