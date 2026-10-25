import { computed, ref, watch, type Ref } from 'vue';
import {
  useFavoritePathsStore,
  type FavoritePathItem,
  type FavoritePathScope,
} from '../stores/favoritePaths.store';
import { useConnectionsStore } from '../stores/connections.store';

export interface FavoritePathTransferOptions {
  /** 迁移源作用域：面板里列出来的就是这一组收藏 */
  sourceScope: Ref<FavoritePathScope | undefined>;
  /** 当前文件管理器所在主机（连接 uuid） */
  hostUuid: Ref<string | null | undefined>;
  /** 面板是否可见：每次打开都重置一遍选择态 */
  isVisible: Ref<boolean>;
  /** 让 i18n 的 t 透传进来（store action 里要弹提示） */
  t: (key: string, params?: Record<string, unknown>) => string;
}

/**
 * 「迁移收藏」面板的表单逻辑（桌面 / 移动两端共用）。
 *
 * 只负责：列出源收藏、多选、移动还是复制、目标作用域。
 * 目标主机的候选项由组件自己拼（它才知道 connectionsStore 里有哪些 SSH 主机）。
 */
export function useFavoritePathTransfer(options: FavoritePathTransferOptions) {
  const store = useFavoritePathsStore();
  const connectionsStore = useConnectionsStore();

  /**
   * 可以作为「主机专属」目标的主机。
   *
   * 只列 SSH：RDP / VNC 根本没有文件管理器，把收藏挂过去永远看不见，
   * 属于「能选但没用」的坑。uuid 缺失的连接也跳过 —— 归属靠 uuid 对齐。
   */
  const hostOptions = computed(() =>
    connectionsStore.connections
      .filter((c) => c.type === 'SSH' && !!c.uuid)
      .map((c) => ({ uuid: String(c.uuid), name: c.name || c.host }))
  );

  /** 源：当前作用域下可见的全部收藏（不受搜索框影响 —— 搜索是列表页的临时筛选，
   *  迁移面板里只显示一半条目会让人以为其余的丢了） */
  const items = computed<FavoritePathItem[]>(() =>
    store.favoritePathsFor(options.sourceScope.value ?? 'host', options.hostUuid.value || null)
  );

  const selectedIds = ref<string[]>([]);
  const mode = ref<'move' | 'copy'>('move');
  const targetScope = ref<FavoritePathScope>('global');
  const targetConnectionUuid = ref<string | null>(null);
  const isSubmitting = ref(false);

  const isSelected = (item: FavoritePathItem) => selectedIds.value.includes(String(item.id));

  const toggleSelect = (item: FavoritePathItem) => {
    const id = String(item.id);
    if (selectedIds.value.includes(id)) {
      selectedIds.value = selectedIds.value.filter((x) => x !== id);
    } else {
      selectedIds.value = [...selectedIds.value, id];
    }
  };

  const allSelected = computed(
    () => items.value.length > 0 && selectedIds.value.length === items.value.length
  );

  const toggleSelectAll = () => {
    selectedIds.value = allSelected.value ? [] : items.value.map((it) => String(it.id));
  };

  /** 选中的条数（列表刷新后可能有过期的 id，按当前列表过滤一遍） */
  const selectedItems = computed(() =>
    items.value.filter((it) => selectedIds.value.includes(String(it.id)))
  );

  const canSubmit = computed(() => selectedItems.value.length > 0 && !isSubmitting.value);

  /** 目标是否就是源本身（全局 → 全局，或本机专属 → 同一台主机） */
  const isTargetSameAsSource = computed(() => {
    const source = options.sourceScope.value ?? 'host';
    if (targetScope.value !== source) return false;
    if (targetScope.value === 'global') return true;
    return String(targetConnectionUuid.value || '') === String(options.hostUuid.value || '');
  });

  /**
   * 目标选择器用的键：`global` 或 `host:<uuid>`。
   * AppSelect 的 value 只吃原始类型，拼成一个字符串比塞对象省事。
   */
  const targetKey = computed<string>({
    get: () =>
      targetScope.value === 'global' ? 'global' : `host:${targetConnectionUuid.value || ''}`,
    set: (value: string) => {
      if (value === 'global') {
        targetScope.value = 'global';
        targetConnectionUuid.value = null;
        return;
      }
      if (value.startsWith('host:')) {
        targetScope.value = 'host';
        targetConnectionUuid.value = value.slice('host:'.length) || null;
      }
    },
  });

  /** 打开面板时的默认目标：不能等于源，否则一进来就是「无操作」 */
  const resolveDefaultTargetKey = (): string => {
    if ((options.sourceScope.value ?? 'host') === 'host') return 'global';
    if (options.hostUuid.value) return `host:${options.hostUuid.value}`;
    const first = hostOptions.value[0];
    return first ? `host:${first.uuid}` : 'global';
  };

  /** 打开面板 / 数据变化时重置：清空选择，默认「移动」 */
  const reset = () => {
    selectedIds.value = [];
    mode.value = 'move';
    targetKey.value = resolveDefaultTargetKey();
  };

  // 父级用 v-if 控制挂载时，组件「一出生就是打开状态」，watch 不会触发 —— 主动初始化一次
  if (options.isVisible.value) reset();

  watch(
    () => options.isVisible.value,
    (visible) => {
      if (visible) reset();
    }
  );

  // 列表被同步/删除改动后，把已经不在列表里的 id 剔掉，避免提交时带着幽灵 id
  watch(items, (list) => {
    const alive = new Set(list.map((it) => String(it.id)));
    const next = selectedIds.value.filter((id) => alive.has(id));
    if (next.length !== selectedIds.value.length) selectedIds.value = next;
  });

  /**
   * 提交迁移。
   * @returns 是否成功（取消/失败返回 false，调用方据此决定要不要关面板）
   */
  const submit = async (): Promise<boolean> => {
    if (!canSubmit.value) return false;
    if (isTargetSameAsSource.value) return false;
    isSubmitting.value = true;
    try {
      await store.transferFavoritePaths(
        selectedItems.value.map((it) => it.id),
        mode.value,
        targetScope.value,
        targetScope.value === 'host' ? targetConnectionUuid.value : null,
        options.t
      );
      return true;
    } catch {
      return false;
    } finally {
      isSubmitting.value = false;
    }
  };

  return {
    items,
    hostOptions,
    targetKey,
    selectedIds,
    selectedItems,
    mode,
    targetScope,
    targetConnectionUuid,
    isSubmitting,
    isSelected,
    toggleSelect,
    toggleSelectAll,
    allSelected,
    canSubmit,
    isTargetSameAsSource,
    reset,
    submit,
  };
}
