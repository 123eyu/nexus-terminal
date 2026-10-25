<script setup lang="ts">
import { computed, toRef, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FavoritePathScope } from '../stores/favoritePaths.store';
import { useFavoritePathTransfer } from '../composables/useFavoritePathTransfer';
import AppSelect from './common/AppSelect.vue';
import MobileFavoritePathTransferModal from './MobileFavoritePathTransferModal.vue';

const props = defineProps({
  isVisible: {
    type: Boolean,
    required: true,
  },
  /** 迁移源：打开面板时列表页看的是哪一组，就迁哪一组 */
  sourceScope: {
    type: String as PropType<FavoritePathScope>,
    default: 'host',
  },
  /** 当前文件管理器所在主机（连接 uuid） */
  hostUuid: {
    type: String as PropType<string | null>,
    default: null,
  },
  isMobile: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(['close']);

const { t } = useI18n();

const {
  items,
  hostOptions,
  targetKey,
  mode,
  isSubmitting,
  isSelected,
  toggleSelect,
  toggleSelectAll,
  allSelected,
  canSubmit,
  isTargetSameAsSource,
  submit,
} = useFavoritePathTransfer({
  sourceScope: toRef(props, 'sourceScope'),
  hostUuid: toRef(props, 'hostUuid'),
  isVisible: toRef(props, 'isVisible'),
  t,
});

const sourceLabel = computed(() =>
  props.sourceScope === 'host'
    ? t('favoritePaths.scope.host', '本机专属')
    : t('favoritePaths.scope.global', '全局')
);

/** 目标主机里与源完全重合的那一项：选了等于没迁，置灰 */
const isSameHostOption = (uuid: string) =>
  props.sourceScope === 'host' && String(props.hostUuid || '') === String(uuid);

const closeModal = () => emit('close');

const handleSubmit = async () => {
  const ok = await submit();
  if (ok) closeModal();
};
</script>

<template>
  <!-- 移动端：交给底部抽屉版 -->
  <MobileFavoritePathTransferModal
    v-if="props.isMobile"
    :is-visible="props.isVisible"
    :source-scope="props.sourceScope"
    :host-uuid="props.hostUuid"
    @close="closeModal"
  />

  <div v-else-if="props.isVisible" class="fixed inset-0 z-[1200]" data-fav-transfer-panel>
    <div
      class="fixed inset-0 flex items-center justify-center bg-[var(--overlay-bg-color)]"
      @click.self="closeModal"
    >
      <div class="bg-background text-foreground shadow-xl rounded-lg w-full max-w-md flex flex-col overflow-hidden m-4">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 pt-5 pb-3">
          <div>
            <h2 class="m-0 text-lg font-semibold">
              {{ t('favoritePaths.transfer.title', '迁移收藏') }}
            </h2>
            <p class="m-0 mt-1 text-xs text-text-secondary">
              {{ t('favoritePaths.transfer.subtitle', { scope: sourceLabel }) }}
            </p>
          </div>
          <button
            type="button"
            class="w-8 h-8 flex items-center justify-center rounded-lg text-text-secondary hover:bg-border/60 hover:text-foreground transition-colors cursor-pointer"
            @click="closeModal"
          >
            <i class="fas fa-times text-sm"></i>
          </button>
        </div>

        <!-- 选择列表 -->
        <div class="px-6 flex items-center justify-between flex-shrink-0">
          <span class="text-sm font-medium text-text-secondary">
            {{ t('favoritePaths.transfer.selectLabel', '选择收藏路径') }}
          </span>
          <button
            type="button"
            class="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="items.length === 0"
            @click="toggleSelectAll"
          >
            <i class="fas fa-check-double text-[10px]"></i>
            <span>
              {{ allSelected
                ? t('favoritePaths.transfer.clearAll', '取消全选')
                : t('favoritePaths.transfer.selectAll', '全选') }}
            </span>
          </button>
        </div>

        <div class="mx-6 mt-2 mb-1 max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-input/40 p-1">
          <p v-if="items.length === 0" class="p-4 text-center text-xs text-text-secondary">
            {{ t('favoritePaths.transfer.empty', '这一组还没有收藏路径') }}
          </p>
          <button
            v-else
            v-for="item in items"
            :key="item.id"
            type="button"
            class="w-full flex items-start gap-2.5 p-2 rounded-md text-left transition-colors cursor-pointer"
            :class="isSelected(item) ? 'bg-primary/10' : 'hover:bg-primary/5'"
            @click="toggleSelect(item)"
          >
            <span
              class="mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors"
              :class="isSelected(item) ? 'bg-primary border-primary text-white' : 'border-border bg-background'"
            >
              <!-- 全局样式里 `i, .fas { color: var(--icon-color) }` 没进 @layer，会盖过继承色，
                   所以勾号必须内联写死白色，否则紫底上是一颗深色勾（几乎看不见） -->
              <i v-if="isSelected(item)" class="fas fa-check text-[9px]" style="color: #fff"></i>
            </span>
            <span class="min-w-0 flex-grow">
              <span class="block text-sm truncate">
                <i v-if="Number(item.is_file) === 1" class="fas fa-file text-[10px] mr-1 text-text-secondary"></i>
                {{ item.name || item.path }}
              </span>
              <span class="block text-[11px] font-mono text-text-secondary truncate">{{ item.path }}</span>
            </span>
          </button>
        </div>

        <!-- 方式与目标 -->
        <div class="px-6 pt-3 pb-1 space-y-3">
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-medium text-text-secondary flex-shrink-0">
              {{ t('favoritePaths.transfer.modeLabel', '方式') }}
            </span>
            <div class="inline-flex p-0.5 rounded-lg bg-input border border-border">
              <button
                type="button"
                class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer"
                :class="mode === 'move' ? 'bg-primary text-white shadow-sm' : 'text-text-secondary hover:text-foreground'"
                @click="mode = 'move'"
              >
                <i class="fas fa-arrow-right text-[10px]"></i>
                <span>{{ t('favoritePaths.transfer.move', '移动') }}</span>
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer"
                :class="mode === 'copy' ? 'bg-primary text-white shadow-sm' : 'text-text-secondary hover:text-foreground'"
                @click="mode = 'copy'"
              >
                <i class="fas fa-copy text-[10px]"></i>
                <span>{{ t('favoritePaths.transfer.copy', '复制') }}</span>
              </button>
            </div>
          </div>

          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-medium text-text-secondary flex-shrink-0">
              {{ t('favoritePaths.transfer.targetLabel', '迁移到') }}
            </span>
            <AppSelect v-model="targetKey" class="flex-1 min-w-0">
              <option value="global">{{ t('favoritePaths.scope.global', '全局') }}</option>
              <option
                v-for="host in hostOptions"
                :key="host.uuid"
                :value="`host:${host.uuid}`"
                :disabled="isSameHostOption(host.uuid)"
              >
                {{ String(host.uuid) === String(props.hostUuid || '') ? `${host.name}（${t('favoritePaths.scope.host', '本机专属')}）` : host.name }}
              </option>
            </AppSelect>
          </div>

          <p v-if="isTargetSameAsSource" class="m-0 text-xs text-amber-500">
            {{ t('favoritePaths.transfer.sameTarget', '目标就是当前分组，换个位置试试') }}
          </p>

          <p class="m-0 text-xs text-text-secondary">
            {{ mode === 'move'
              ? t('favoritePaths.transfer.moveHint', '移动后原分组里不再保留这些收藏。')
              : t('favoritePaths.transfer.copyHint', '复制后原分组保留，目标位置新增一份。') }}
          </p>
        </div>

        <!-- Footer -->
        <div class="flex justify-end gap-3 px-6 pt-4 pb-5 mt-1 border-t border-border/50">
          <button
            type="button"
            :disabled="isSubmitting"
            class="py-2 px-5 rounded-lg text-sm font-medium transition-colors duration-150 bg-background border border-border/50 text-text-secondary hover:bg-border hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
            @click="closeModal"
          >
            {{ t('common.cancel', '取消') }}
          </button>
          <button
            type="button"
            data-fav-transfer-submit
            :disabled="!canSubmit || isTargetSameAsSource"
            class="py-2 px-5 rounded-lg text-sm font-semibold transition-colors duration-150 bg-primary text-white border-none shadow-md hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
            @click="handleSubmit"
          >
            {{ isSubmitting
              ? t('favoritePaths.transfer.submitting', '迁移中...')
              : (mode === 'move' ? t('favoritePaths.transfer.move', '移动') : t('favoritePaths.transfer.copy', '复制')) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
