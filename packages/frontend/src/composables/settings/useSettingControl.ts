import { ref, watch, type Ref } from 'vue';
import { useSettingsStore } from '../../stores/settings.store';

/**
 * 通用「设置项控件」：把「本地草稿 + loading + 提示 + 保存」这套样板收敛到一处。
 *
 * 背景：以前每加一个开关，都要在 useWorkspaceSettings 里手写 5 个 ref、1 个 handler、
 * 1 个 watch、4 个 return，一共 20 行。20 个开关就是 400 行纯复制粘贴，
 * 而且每次都很容易漏掉 watch（表现为"另一个窗口改了值，这边不刷新"）。
 *
 * 现在只需描述「这个设置是什么」：
 *   const popupEditor = useBooleanSettingControl({ key: 'showPopupFileEditor', defaultValue: true, ... })
 */
export interface SettingControl<T> {
  /** 本地草稿值（v-model 绑这个） */
  local: Ref<T>;
  loading: Ref<boolean>;
  message: Ref<string>;
  success: Ref<boolean>;
  save: () => Promise<void>;
}

export interface SettingControlOptions<T> {
  /** settings.schema.json 里的键 */
  key: string;
  /** store 里没有值时使用的初值 */
  defaultValue: T;
  /** 把数据库里的字符串还原成值（默认原样返回） */
  parse?: (raw: string) => T;
  /** 把值转成要写入的形式（默认 String；布尔值见 useBooleanSettingControl） */
  serialize?: (value: T) => string | boolean;
  /** 自定义保存路径（默认 settingsStore.updateSetting） */
  persist?: (value: T) => Promise<void>;
  /** 保存前校验，抛错即中止 */
  validate?: (value: T) => void;
  /** 成功提示自动清空的毫秒数（默认不清空） */
  clearMessageAfterMs?: number;
  /** 失败日志前缀，默认使用 key */
  errorLog?: string;
}

export function useSettingControl<T>(
  options: SettingControlOptions<T> & { successMessage: () => string; errorMessage: () => string }
): SettingControl<T> {
  const settingsStore = useSettingsStore();
  const local = ref(options.defaultValue) as Ref<T>;
  const loading = ref(false);
  const message = ref('');
  const success = ref(false);

  const parse = options.parse ?? ((raw: string) => raw as unknown as T);

  // 跟随 store（其它端同步过来、或页面重新加载）刷新草稿值
  watch(
    () => (settingsStore.settings as Record<string, string | undefined>)[options.key],
    (raw) => {
      if (raw !== undefined && raw !== null) {
        local.value = parse(raw);
      }
    },
    { immediate: true }
  );

  const save = async () => {
    loading.value = true;
    message.value = '';
    success.value = false;
    try {
      options.validate?.(local.value);
      if (options.persist) {
        await options.persist(local.value);
      } else {
        const payload = options.serialize ? options.serialize(local.value) : String(local.value);
        await settingsStore.updateSetting(options.key as any, payload as any);
      }
      message.value = options.successMessage();
      success.value = true;
      if (options.clearMessageAfterMs) {
        setTimeout(() => {
          message.value = '';
        }, options.clearMessageAfterMs);
      }
    } catch (error: any) {
      console.error(`[SettingControl] 更新 ${options.errorLog ?? options.key} 失败:`, error);
      message.value = error?.message || options.errorMessage();
      success.value = false;
    } finally {
      loading.value = false;
    }
  };

  return { local, loading, message, success, save };
}

/** 布尔开关（库里存 'true' / 'false'） */
export function useBooleanSettingControl(
  options: Omit<SettingControlOptions<boolean>, 'parse' | 'defaultValue'> & {
    defaultValue: boolean;
    /** 部分布尔设置走专用接口，需要传真正的 boolean 而不是字符串 */
    nativeBoolean?: boolean;
    successMessage: () => string;
    errorMessage: () => string;
  }
): SettingControl<boolean> {
  return useSettingControl<boolean>({
    ...options,
    parse: (raw) => raw === 'true',
    serialize: (value) => (options.nativeBoolean ? value : value ? 'true' : 'false'),
  });
}

/** 字符串 / 枚举下拉 */
export function useStringSettingControl(
  options: Omit<SettingControlOptions<string>, 'parse' | 'serialize'> & {
    defaultValue: string;
    successMessage: () => string;
    errorMessage: () => string;
  }
): SettingControl<string> {
  return useSettingControl<string>({ ...options, parse: (raw) => raw, serialize: (value) => value });
}

/** 数值型（空值回落默认） */
export function useNumberSettingControl(
  options: Omit<SettingControlOptions<number | null>, 'parse'> & {
    defaultValue: number | null;
    successMessage: () => string;
    errorMessage: () => string;
  }
): SettingControl<number | null> {
  return useSettingControl<number | null>({
    ...options,
    parse: (raw) => {
      const parsed = Number(raw);
      return Number.isNaN(parsed) ? options.defaultValue : parsed;
    },
    serialize: (value) => (value === null || value === undefined ? '' : String(value)),
  });
}
