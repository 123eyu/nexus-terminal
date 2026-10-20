import { ref, watch, effectScope } from 'vue';
import { useSettingsStore } from '../../stores/settings.store';

/**
 * 搜索栏「固定」状态的单例。
 *
 * 为什么放在模块级而不是每个 FileManager 实例各存一份：
 * 布局里可能同时挂多份 FileManager（侧栏 + 主区 + 弹窗），各实例各自 `ref` 的话，
 * 在一处点了固定，其它实例的按钮和搜索栏状态还是旧的 —— 表现为"点了没反应/两处不一致"。
 * 状态本来就只是一条全局偏好，所以统一收在这里。
 *
 * 为什么落在设置表而不是 localStorage：
 * 这是"用起来顺手"的偏好，用户换了浏览器/设备也会期望它跟着走。
 * 设置表本来就会跨端同步（挂在「工作区布局」模块下），所以直接当成普通设置项。
 * localStorage 只在两处保留：① 迁移老版本留下的值；② 设置表还没加载好时的兜底。
 */

const STORAGE_KEY = 'nexus:file_manager_search_fixed';
/** 迁移只做一次，否则"取消固定"后老值会被反复补写回设置表 */
const MIGRATED_KEY = 'nexus:file_manager_search_fixed_migrated';
const SETTING_KEY = 'fileManagerSearchFixed';

/** 老版本（0.9.9 及以前）只存这里，用来做一次性迁移 */
function readLegacy(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // 隐私模式下 localStorage 可能不可用，当作未固定
    return false;
  }
}

function hasMigrated(): boolean {
  try {
    return localStorage.getItem(MIGRATED_KEY) === '1';
  } catch {
    return true; // 读不到就当已迁移，宁可不动服务端的值
  }
}

function markMigrated() {
  try {
    localStorage.setItem(MIGRATED_KEY, '1');
  } catch { /* 无所谓 */ }
}

function writeLegacy(next: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch { /* 写不进去也不影响本次会话 */ }
}

export const isSearchFixed = ref<boolean>(readLegacy());

let wired = false;

/**
 * 在组件 setup 里调一次即可（模块级只真正执行一次），把 ref 接到设置表上：
 *   - 设置表加载完成后以服务端的值为准（这样桌面端/浏览器端能同步）
 *   - 监听后续变更（另一端点开关、跨端同步拉取）实时反映到界面
 *   - 老用户的 localStorage 值做一次性迁移
 */
export function initSearchFixedSync() {
  if (wired) return;
  wired = true;

  const store = useSettingsStore();
  const apply = (value?: string) => {
    if (value === 'true' || value === 'false') isSearchFixed.value = value === 'true';
  };

  // 首轮渲染先用本地值顶着，避免加载期间闪一下
  apply(store.settings?.[SETTING_KEY]);

  // 独立 effectScope：这个函数是在 FileManager 的 setup 里调的，
  // 直接 watch 会被绑到那一个实例上，实例卸载（关会话/切布局）后监听就没了，
  // 而 wired 已经是 true、不会再注册 —— 那样"取消固定后再也同步不过来"。
  const scope = effectScope(true);

  scope.run(() => {
    watch(
      () => store.isLoading,
      (loading) => {
        if (loading) return;
        const remote = store.settings?.[SETTING_KEY];

        // 迁移：老版本把状态存在 localStorage 里，且是"已固定"时补写进设置表。
        // 只做一次；反过来不写 —— 'false' 本来就是默认值，不该拿去覆盖别的设备。
        if (!hasMigrated()) {
          markMigrated();
          if (readLegacy() && remote !== 'true') {
            isSearchFixed.value = true;
            void store.updateSetting(SETTING_KEY, 'true').catch(() => { /* 网络问题就下次再说 */ });
            return;
          }
        }

        apply(remote);
      },
      { immediate: true }
    );

    // 跨端同步 / 另一处修改
    watch(() => store.settings?.[SETTING_KEY], apply);
  });
}

export function setSearchFixed(next: boolean) {
  isSearchFixed.value = next;
  writeLegacy(next); // 兜底：设置表写失败时，本机刷新后仍能记住
  try {
    const store = useSettingsStore();
    // 失败不打断交互：界面已经切过去了，下次改动会重试
    void store.updateSetting(SETTING_KEY, next ? 'true' : 'false').catch(() => { });
  } catch { /* pinia 还没就绪（极早期）就只留本地 */ }
}
