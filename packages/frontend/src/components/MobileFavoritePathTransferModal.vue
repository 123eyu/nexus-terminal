<script setup lang="ts">
import { computed, toRef, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FavoritePathScope } from '../stores/favoritePaths.store';
import { useFavoritePathTransfer } from '../composables/useFavoritePathTransfer';
import AppSelect from './common/AppSelect.vue';
import MobileBottomSheet from './common/MobileBottomSheet.vue';

const props = defineProps<{
  isVisible: boolean;
  sourceScope?: FavoritePathScope;
  hostUuid?: string | null;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const { t } = useI18n();

const {
  items,
  hostOptions,
  sourceKey,
  targetKey,
  mode,
  isSelected,
  toggleSelect,
  toggleSelectAll,
  allSelected,
  selectedItems,
  canSubmit,
  isTargetSameAsSource,
  submit,
} = useFavoritePathTransfer({
  sourceScope: toRef(props, 'sourceScope'),
  hostUuid: toRef(props, 'hostUuid'),
  // 移动端由父级用 v-if 控制挂载，挂载即视为打开（composable 会在初始化时 reset 一次）
  isVisible: computed(() => true),
  t,
});

/** 主机下拉项：当前文件管理器所在的主机标一下，避免和目标里的同名项混起来 */
const hostLabel = (host: { uuid: string; name: string }) =>
  String(host.uuid) === String(props.hostUuid || '')
    ? `${host.name}（${t('favoritePaths.scope.host', '本机专属')}）`
    : host.name;

const closeModal = () => emit('close');

const handleSubmit = async () => {
  const ok = await submit();
  if (ok) closeModal();
};
</script>

<template>
  <MobileBottomSheet
    :visible="props.isVisible"
    :title="t('favoritePaths.transfer.title', '迁移收藏')"
    icon="fas fa-people-arrows"
    height="h-[72vh]"
    max-height="max-h-[80vh]"
    @close="closeModal"
  >
    <template #sub-header>
      <div class="px-4 pb-1 flex items-center justify-between">
        <span class="text-[11px] text-text-secondary">
          {{ t('favoritePaths.transfer.subtitle', '把收藏移动或复制到别的分组') }}
        </span>
        <button
          type="button"
          class="inline-flex items-center gap-1 h-7 px-2 rounded-lg text-[11px] font-medium text-primary transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
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
    </template>

    <div class="flex flex-col h-full" data-fav-transfer-panel-body>
      <!-- 源分组 -->
      <div class="flex-shrink-0 px-4 pb-2 flex items-center gap-2">
        <span class="text-[11px] font-medium text-text-secondary flex-shrink-0 w-12">
          {{ t('favoritePaths.transfer.sourceLabel', '迁移自') }}
        </span>
        <AppSelect v-model="sourceKey" class="flex-1 min-w-0" data-fav-transfer-source>
          <option value="global">{{ t('favoritePaths.scope.global', '全局') }}</option>
          <option
            v-for="host in hostOptions"
            :key="host.uuid"
            :value="`host:${host.uuid}`"
          >
            {{ hostLabel(host) }}
          </option>
        </AppSelect>
      </div>

      <!-- 收藏列表 -->
      <div class="flex-1 overflow-y-auto px-3 py-1 space-y-1">
        <p v-if="items.length === 0" class="py-10 text-center text-xs text-text-secondary">
          {{ t('favoritePaths.transfer.empty', '这一组还没有收藏路径') }}
        </p>
        <button
          v-else
          v-for="item in items"
          :key="item.id"
          type="button"
          data-fav-transfer-item
          class="w-full flex items-start gap-2.5 p-2.5 rounded-xl text-left transition-colors cursor-pointer"
          :class="isSelected(item) ? 'bg-primary/10 border border-primary/30' : 'bg-header/30 border border-border/40'"
          @click="toggleSelect(item)"
        >
          <span
            class="mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors"
            :class="isSelected(item) ? 'bg-primary border-primary text-white' : 'border-border bg-background'"
          >
            <!-- 全局样式里 `i, .fas { color: var(--icon-color) }` 没进 @layer，会盖过继承色，
                 所以勾号必须内联写死白色 -->
            <i v-if="isSelected(item)" class="fas fa-check text-[9px]" style="color: #fff"></i>
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-[13px] font-medium truncate">
              <i v-if="Number(item.is_file) === 1" class="fas fa-file text-[10px] mr-1 text-text-secondary"></i>
              {{ item.name || item.path }}
            </span>
            <span class="block text-[11px] font-mono text-text-secondary truncate mt-0.5">{{ item.path }}</span>
          </span>
        </button>
      </div>

      <!-- 方式 / 目标 / 提交 -->
      <div class="flex-shrink-0 px-4 pt-3 pb-4 space-y-3 border-t border-border/40 bg-background">
        <div class="flex items-center gap-2">
          <span class="text-[11px] font-medium text-text-secondary flex-shrink-0 w-12">
            {{ t('favoritePaths.transfer.modeLabel', '方式') }}
          </span>
          <div class="inline-flex p-0.5 rounded-xl bg-input border border-border flex-1">
            <button
              type="button"
              class="flex-1 inline-flex items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-medium transition-colors cursor-pointer"
              :class="mode === 'move' ? 'bg-primary text-white shadow-sm' : 'text-text-secondary'"
              @click="mode = 'move'"
            >
              <i class="fas fa-arrow-right text-[10px]"></i>
              <span>{{ t('favoritePaths.transfer.move', '移动') }}</span>
            </button>
            <button
              type="button"
              class="flex-1 inline-flex items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-medium transition-colors cursor-pointer"
              :class="mode === 'copy' ? 'bg-primary text-white shadow-sm' : 'text-text-secondary'"
              @click="mode = 'copy'"
            >
              <i class="fas fa-copy text-[10px]"></i>
              <span>{{ t('favoritePaths.transfer.copy', '复制') }}</span>
            </button>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <span class="text-[11px] font-medium text-text-secondary flex-shrink-0 w-12">
            {{ t('favoritePaths.transfer.targetLabel', '迁移到') }}
          </span>
          <AppSelect v-model="targetKey" class="flex-1 min-w-0" data-fav-transfer-target>
            <option value="global" :disabled="sourceKey === 'global'">
              {{ t('favoritePaths.scope.global', '全局') }}
            </option>
            <option
              v-for="host in hostOptions"
              :key="host.uuid"
              :value="`host:${host.uuid}`"
              :disabled="sourceKey === `host:${host.uuid}`"
            >
              {{ hostLabel(host) }}
            </option>
          </AppSelect>
        </div>

        <p v-if="isTargetSameAsSource" class="m-0 text-[11px] text-amber-500">
          {{ t('favoritePaths.transfer.sameTarget', '目标就是当前分组，换个位置试试') }}
        </p>

        <p class="m-0 text-[11px] text-text-secondary leading-relaxed">
          {{ mode === 'move'
            ? t('favoritePaths.transfer.moveHint', '移动后原分组里不再保留这些收藏。')
            : t('favoritePaths.transfer.copyHint', '复制后原分组保留，目标位置新增一份。') }}
          <span v-if="selectedItems.length" class="text-primary font-medium ml-1">
            {{ t('favoritePaths.transfer.selectedCount', { count: selectedItems.length }) }}
          </span>
        </p>

        <button
          type="button"
          data-fav-transfer-submit
          :disabled="!canSubmit || isTargetSameAsSource"
          class="w-full h-10 rounded-xl bg-primary text-white text-sm font-semibold shadow-sm active:scale-[0.99] transition-transform disabled:opacity-50 disabled:active:scale-100 disabled:cursor-not-allowed cursor-pointer"
          @click="handleSubmit"
        >
          {{ mode === 'move'
            ? t('favoritePaths.transfer.move', '移动')
            : t('favoritePaths.transfer.copy', '复制') }}
        </button>
      </div>
    </div>
  </MobileBottomSheet>
</template>
