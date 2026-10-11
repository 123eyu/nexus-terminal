<script setup lang="ts">
import { computed, watch, type Ref, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import FolderSelect from './FolderSelect.vue';
import type { ProxyInfo } from '../stores/proxies.store';
import type { TagInfo } from '../stores/tags.store';
import type { ConnectionInfo } from '../stores/connections.store';

// Define Props
const props = defineProps({
  formData: {
    type: Object as PropType<{
      id?: number;
      type: 'SSH' | 'RDP' | 'VNC';
      proxy_id: number | null;
      jump_chain: Array<number | null> | null;
      proxy_type?: 'proxy' | 'jump' | null;
      tag_ids: number[];
      notes: string;
    }>,
    required: true
  },
  proxies: { type: Array as PropType<ProxyInfo[]>, required: true },
  connections: { type: Array as PropType<ConnectionInfo[]>, required: true }, 
  tags: { type: Array as PropType<TagInfo[]>, required: true },
  isProxyLoading: { type: Boolean, required: true },
  proxyStoreError: { type: String as PropType<string | null>, required: false, default: null },
  isTagLoading: { type: Boolean, required: true },
  tagStoreError: { type: String as PropType<string | null>, required: false, default: null },
  advancedConnectionMode: { type: String as PropType<'proxy' | 'jump'>, required: true },
  addJumpHost: { type: Function as PropType<() => void>, required: true },
  removeJumpHost: { type: Function as PropType<(index: number) => void>, required: true },
  isEditMode: { type: Boolean, default: false } 
});

// Define Emits
const emit = defineEmits<{
  (e: 'create-tag', tagName: string): void;
  (e: 'delete-tag', tagId: number): void;
  (e: 'update:advancedConnectionMode', mode: 'proxy' | 'jump'): void;
}>();

const { t } = useI18n();

const selectedFolderId = computed({
  get: () => {
    return props.formData.tag_ids && props.formData.tag_ids.length > 0 ? props.formData.tag_ids[0] : null;
  },
  set: (val: number | null) => {
    props.formData.tag_ids = val !== null ? [val] : [];
  }
});


const handleCreateTagEvent = (tagName: string) => {
  emit('create-tag', tagName);
};

const handleDeleteTagEvent = (tagId: number) => {
  emit('delete-tag', tagId);
};

const setConnectionMode = (mode: 'proxy' | 'jump') => {
  if (props.advancedConnectionMode === mode) return; // Access directly
  emit('update:advancedConnectionMode', mode);

};


const getAvailableJumpHostsForIndex = (currentIndex: number): ConnectionInfo[] => {
  return props.connections.filter(conn => {
    if (conn.type !== 'SSH') return false;
    if (props.isEditMode && props.formData.id === conn.id) return false;
    return !props.formData.jump_chain?.some((jumpHostId, index) => {
      return index !== currentIndex && jumpHostId === conn.id;
    });
  });
};
</script>

<template>
  <!-- 高级配置卡片：立体浮凸卡片 -->
  <div
    class="rounded-2xl border border-border/80 p-4 md:p-5 space-y-4 shadow-md"
    style="background-color: var(--card-bg-color, var(--header-bg-color));"
  >
    <div class="flex items-center justify-between pb-2.5 border-b border-border/50">
      <div class="flex items-center gap-2">
        <div class="w-6 h-6 rounded-md bg-purple-500/15 text-purple-400 flex items-center justify-center text-xs">
          <i class="fas fa-sliders-h"></i>
        </div>
        <h4 class="text-xs font-semibold text-foreground tracking-wide uppercase">{{ t('connections.form.sectionAdvanced', '高级选项') }}</h4>
      </div>
    </div>

    <!-- 所属文件夹 -->
    <div>
      <label class="block text-xs font-medium text-text-secondary mb-1.5">
        <i class="fas fa-folder text-amber-400 mr-1"></i>
        {{ t('folders.title', '所属文件夹') }}
      </label>
      <FolderSelect
        v-model="selectedFolderId"
        :folders="props.tags"
        :allow-create="true"
        @create-folder="handleCreateTagEvent"
        :placeholder="t('folders.selectPlaceholder', '选择所属文件夹...')"
      />
      <div v-if="props.isTagLoading" class="mt-1 text-xs text-text-secondary">{{ t('common.loading') }}</div>
      <div v-if="props.tagStoreError" class="mt-1 text-xs text-error">{{ props.tagStoreError }}</div>
    </div>
    
    <!-- 连接方式切换 (仅 SSH 支持) -->
    <div v-if="props.formData.type === 'SSH'">
      <label class="block text-xs font-medium text-text-secondary mb-1.5">{{ t('connections.form.connectionMode', '网络穿透方式') }}</label>
      <div
        class="grid grid-cols-2 gap-1.5 p-1 rounded-xl border border-border/70"
        style="background-color: var(--app-bg-color);"
      >
        <button
          type="button"
          @click="setConnectionMode('proxy')"
          class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer"
          :class="props.advancedConnectionMode === 'proxy' ? 'bg-primary text-white shadow-xs font-semibold' : 'text-text-secondary hover:text-foreground hover:bg-header/50'"
        >
          <i class="fas fa-shield-alt text-[10px]"></i>
          <span>{{ t('connections.form.connectionModeProxy', '网络代理') }}</span>
        </button>
        <button
          type="button"
          @click="setConnectionMode('jump')"
          class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer"
          :class="props.advancedConnectionMode === 'jump' ? 'bg-primary text-white shadow-xs font-semibold' : 'text-text-secondary hover:text-foreground hover:bg-header/50'"
        >
          <i class="fas fa-random text-[10px]"></i>
          <span>{{ t('connections.form.connectionModeJumpHost', '跳板机链') }}</span>
        </button>
      </div>
    </div>

    <!-- 代理选择 -->
    <div v-if="props.formData.type === 'SSH' && props.advancedConnectionMode === 'proxy'">
      <label for="conn-proxy" class="block text-xs font-medium text-text-secondary mb-1.5">{{ t('connections.form.proxy') }}</label>
      <select
        id="conn-proxy"
        v-model="props.formData.proxy_id"
        class="w-full px-3 py-2 text-xs md:text-sm border border-border/70 rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary appearance-none bg-no-repeat bg-right pr-8 transition-all shadow-2xs"
        style="background-color: var(--app-bg-color); background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.75rem center; background-size: 16px 12px;"
      >
        <option :value="null">{{ t('connections.form.noProxy', '不使用代理 (直连)') }}</option>
        <option v-for="proxy in props.proxies" :key="proxy.id" :value="proxy.id">
          {{ proxy.name }} ({{ proxy.type }} - {{ proxy.host }}:{{ proxy.port }})
        </option>
      </select>
      <div v-if="props.isProxyLoading" class="mt-1 text-xs text-text-secondary">{{ t('proxies.loading') }}</div>
      <div v-if="props.proxyStoreError" class="mt-1 text-xs text-error">{{ t('proxies.error', { error: props.proxyStoreError }) }}</div>
    </div>

    <!-- 跳板机链配置 -->
    <div v-if="props.formData.type === 'SSH' && props.advancedConnectionMode === 'jump'" class="space-y-2.5">
      <label class="block text-xs font-medium text-text-secondary mb-1">{{ t('connections.form.jumpHostsTitle', '跳板机链配置') }}</label>
      <template v-if="props.formData.jump_chain">
        <div
          v-for="(jumpHostId, index) in props.formData.jump_chain"
          :key="index"
          class="flex items-center space-x-2 p-2 border border-border/70 rounded-xl"
          style="background-color: var(--app-bg-color);"
        >
          <span class="text-xs font-medium text-text-secondary whitespace-nowrap pl-1">{{ t('connections.form.jumpHostLabel', '跳板机') }} {{ index + 1 }}:</span>
          <select
            v-model="props.formData.jump_chain[index]"
            class="flex-grow px-3 py-1.5 text-xs border border-border/60 rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-primary appearance-none bg-no-repeat bg-right pr-8"
            style="background-color: var(--card-bg-color, var(--header-bg-color)); background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.75rem center; background-size: 16px 12px;"
          >
            <option :value="null">{{ t('connections.form.selectJumpHost', '请选择跳板机') }}</option>
            <option v-for="host in getAvailableJumpHostsForIndex(index)" :key="host.id" :value="host.id">
              {{ host.name }}
            </option>
          </select>
          <button
            type="button"
            @click="props.removeJumpHost(index)"
            class="p-1.5 text-error hover:bg-error/10 focus:outline-none rounded-lg transition-colors cursor-pointer"
            :title="t('connections.form.removeJumpHostTitle', '移除此跳板机')"
          >
            <i class="fas fa-trash-alt text-xs"></i>
          </button>
        </div>
      </template>
      <button
        type="button"
        @click="props.addJumpHost()"
        class="w-full flex items-center justify-center space-x-2 px-3 py-2 border border-dashed border-primary/50 text-primary text-xs font-medium rounded-xl hover:bg-primary/10 focus:outline-none transition-colors cursor-pointer"
      >
        <i class="fas fa-plus text-xs"></i>
        <span>{{ t('connections.form.addJumpHost', '添加跳板机节点') }}</span>
      </button>
      <div
        v-if="props.connections.filter(c => c.type === 'SSH' && (!props.isEditMode || c.id !== props.formData.id)).length === 0"
        class="text-xs text-text-secondary p-2.5 border border-border/70 rounded-xl"
        style="background-color: var(--app-bg-color);"
      >
        {{ t('connections.form.noAvailableSshConnectionsForJump', '暂无可用的 SSH 连接作为跳板机') }}
      </div>
    </div>

    <!-- 备注信息 -->
    <div>
      <label for="conn-notes" class="block text-xs font-medium text-text-secondary mb-1.5">{{ t('connections.form.notes', '备注说明') }}</label>
      <textarea
        id="conn-notes"
        v-model="props.formData.notes"
        rows="2"
        class="w-full px-3 py-2 text-xs md:text-sm border border-border/70 rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs"
        style="background-color: var(--app-bg-color);"
        :placeholder="t('connections.form.notesPlaceholder', '可选，输入连接补充说明...')"
      ></textarea>
    </div>
  </div>
</template>