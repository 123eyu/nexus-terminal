<script setup lang="ts">
import { ref, nextTick, Teleport, computed, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { PRESET_COLORS, generateRandomColor, hexToRgba } from '../utils/colorUtils';
import { isRemoteDesktopSupported } from '../utils/platform';
import FolderSelect from './FolderSelect.vue';
import type { FolderInfo } from '../stores/folders.store';

// Define Props. formData is expected to be a reactive object from the parent composable.
const props = defineProps<{
  formData: {
    name: string;
    type: 'SSH' | 'RDP' | 'VNC';
    host: string;
    port: number;
    custom_background_color?: boolean;
    background_color?: string;
    folder_ids: number[];
  };
  folders: FolderInfo[];
  isFolderLoading?: boolean;
  folderStoreError?: string | null;
}>();

const emit = defineEmits<{
  (e: 'create-folder', folderName: string): void;
}>();

const { t } = useI18n();

/** 所属文件夹单选：表单里是 folder_ids 数组，这里只取第一个 */
const selectedFolderId = computed({
  get: () => (props.formData.folder_ids && props.formData.folder_ids.length > 0 ? props.formData.folder_ids[0] : null),
  set: (val: number | null) => {
    props.formData.folder_ids = val !== null ? [val] : [];
  },
});

const handleCreateFolder = (folderName: string) => {
  emit('create-folder', folderName);
};


// Tooltip state and refs for the host input
const showHostTooltip = ref(false);
const hostTooltipStyle = ref({});
const hostIconRef = ref<HTMLElement | null>(null);
const hostTooltipContentRef = ref<HTMLElement | null>(null);

// 切换背景色开关
const toggleCustomColor = () => {
  props.formData.custom_background_color = !props.formData.custom_background_color;
  if (props.formData.custom_background_color && !props.formData.background_color) {
    props.formData.background_color = generateRandomColor();
  }
};

// 随机生成全新颜色 (全光谱 HSL 算法随机)
const handleRandomColor = () => {
  props.formData.background_color = generateRandomColor();
};

// 选择预设颜色
const selectPresetColor = (color: string) => {
  props.formData.background_color = color;
};

const handleHostIconMouseEnter = async () => {
  showHostTooltip.value = true;
  await nextTick(); // Wait for DOM update so tooltipRect can be calculated

  if (hostIconRef.value && hostTooltipContentRef.value) {
    const iconRect = hostIconRef.value.getBoundingClientRect();
    const tooltipRect = hostTooltipContentRef.value.getBoundingClientRect();

    let top = iconRect.top - tooltipRect.height - 8; // 8px offset above the icon
    let left = iconRect.left + (iconRect.width / 2) - (tooltipRect.width / 2); // Center the tooltip

    // Boundary checks to keep tooltip within viewport
    if (top < 0) { // If not enough space on top, show below
      top = iconRect.bottom + 8;
    }
    if (left < 0) {
      left = 0;
    }
    if (left + tooltipRect.width > window.innerWidth) {
      left = window.innerWidth - tooltipRect.width;
    }

    hostTooltipStyle.value = {
      position: 'fixed', // Ensure positioning is relative to viewport
      top: `${top}px`,
      left: `${left}px`,
    };
  }
};

const handleHostIconMouseLeave = () => {
  showHostTooltip.value = false;
};
</script>

<template>
  <Teleport to="body">
    <div
      v-if="showHostTooltip"
      ref="hostTooltipContentRef"
      :style="hostTooltipStyle"
      class="fixed w-max max-w-xs p-2 text-xs text-white bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-[99999] whitespace-pre-wrap pointer-events-none"
      role="tooltip"
    >
      {{ t('connections.form.hostTooltip', '支持 IP 范围, 例如 192.168.1.10~192.168.1.15 (仅限添加模式)') }}
    </div>
  </Teleport>

  <!-- 基础配置卡片：立体卡片 -->
  <div
    class="rounded-2xl border border-border/70 surface-raised p-4 md:p-5 space-y-4 shadow-sm"
  >
    <div class="flex items-center justify-between pb-2.5 border-b border-border/50">
      <div class="flex items-center gap-2">
        <div class="w-6 h-6 rounded-md bg-primary/15 text-primary flex items-center justify-center text-xs">
          <i class="fas fa-globe"></i>
        </div>
        <h4 class="text-xs font-semibold text-foreground tracking-wide uppercase">{{ t('connections.form.sectionBasic', '基本信息') }}</h4>
      </div>
    </div>

    <!-- 连接名称 -->
    <div>
      <label for="conn-name" class="block text-xs font-medium text-text-secondary mb-1.5">{{ t('connections.form.name') }}</label>
      <input
        type="text"
        id="conn-name"
        v-model="props.formData.name"
        :placeholder="t('connections.form.namePlaceholder', '如: 生产服务器 / 个人 VPS')"
        class="w-full px-3 py-2 text-xs md:text-sm border border-border/70 rounded-xl text-foreground bg-input focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs"
      />
    </div>

    <!-- 连接类型 -->
    <div>
      <label class="block text-xs font-medium text-text-secondary mb-1.5">{{ t('connections.form.connectionType', '连接类型') }}</label>
      <div
        class="grid grid-cols-3 gap-1.5 p-1 rounded-xl border border-border/70 bg-input"
      >
        <button
          type="button"
          @click="props.formData.type = 'SSH'"
          class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer"
          :class="props.formData.type === 'SSH' ? 'bg-primary text-white shadow-xs font-semibold' : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
        >
          <i class="fas fa-terminal text-[10px]"></i>
          <span>SSH</span>
        </button>
        <button
          v-if="isRemoteDesktopSupported()"
          type="button"
          @click="props.formData.type = 'RDP'"
          class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer"
          :class="props.formData.type === 'RDP' ? 'bg-primary text-white shadow-xs font-semibold' : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
        >
          <i class="fas fa-desktop text-[10px]"></i>
          <span>RDP</span>
        </button>
        <button
          v-if="isRemoteDesktopSupported()"
          type="button"
          @click="props.formData.type = 'VNC'"
          class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer"
          :class="props.formData.type === 'VNC' ? 'bg-primary text-white shadow-xs font-semibold' : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
        >
          <i class="fas fa-plug text-[10px]"></i>
          <span>VNC</span>
        </button>
      </div>
    </div>

    <!-- 主机与端口 -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
      <div class="md:col-span-3">
        <label for="conn-host" class="block text-xs font-medium text-text-secondary mb-1.5">
          {{ t('connections.form.host') }}
          <span class="relative ml-1 text-text-secondary/70 hover:text-primary cursor-help" @mouseenter="handleHostIconMouseEnter" @mouseleave="handleHostIconMouseLeave">
            <i ref="hostIconRef" class="fas fa-question-circle text-[11px]"></i>
          </span>
        </label>
        <input
          type="text"
          id="conn-host"
          v-model="props.formData.host"
          required
          placeholder="192.168.1.100 或 example.com"
          class="w-full px-3 py-2 text-xs md:text-sm font-mono border border-border/70 rounded-xl text-foreground bg-input focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs"
        />
      </div>
      <div>
        <label for="conn-port" class="block text-xs font-medium text-text-secondary mb-1.5">{{ t('connections.form.port') }}</label>
        <input
          type="number"
          id="conn-port"
          v-model.number="props.formData.port"
          required
          min="1"
          max="65535"
          class="w-full px-3 py-2 text-xs md:text-sm font-mono border border-border/70 rounded-xl text-foreground bg-input focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all shadow-2xs"
        />
      </div>
    </div>

    <!-- 所属文件夹：跟「卡片背景颜色」同属「归类/外观」，放在同一张卡片里 -->
    <div class="pt-3 border-t border-border/40">
      <label class="block text-xs font-medium text-text-secondary mb-1.5">
        <i class="fas fa-folder text-amber-400 mr-1"></i>
        {{ t('folders.title', '所属文件夹') }}
      </label>
      <FolderSelect
        v-model="selectedFolderId"
        :folders="props.folders"
        :allow-create="true"
        @create-folder="handleCreateFolder"
        :placeholder="t('folders.selectPlaceholder', '选择所属文件夹...')"
      />
      <!-- 只有真的还没有任何文件夹时才提示加载中：后台静默刷新会让 isFolderLoading 瞬间为 true -->
      <div v-if="props.isFolderLoading && props.folders.length === 0" class="mt-1 text-xs text-text-secondary">{{ t('common.loading') }}</div>
      <div v-if="props.folderStoreError" class="mt-1 text-xs text-error">{{ props.folderStoreError }}</div>
    </div>

    <!-- 卡片背景颜色配置 (极简无冗余废话) -->
    <div class="pt-3 border-t border-border/40">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <i class="fas fa-palette text-text-secondary text-xs"></i>
          <span class="text-xs font-medium text-foreground">{{ t('connections.form.customBackgroundColor', '卡片背景颜色') }}</span>
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="props.formData.custom_background_color"
          @click="toggleCustomColor"
          class="relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
          :class="props.formData.custom_background_color ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-700'"
        >
          <span
            class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-xs ring-0 transition duration-200 ease-in-out"
            :class="props.formData.custom_background_color ? 'translate-x-4' : 'translate-x-0'"
          />
        </button>
      </div>

      <!-- 展开的颜色选择 -->
      <div
        v-if="props.formData.custom_background_color"
        class="mt-3 space-y-2.5 p-3 border border-border/70 rounded-xl bg-input"
      >
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-semibold text-text-secondary">{{ t('connections.form.selectColor', '选择颜色') }}</span>
          <button
            type="button"
            @click="handleRandomColor"
            class="px-2 py-0.5 text-[11px] font-medium rounded-lg bg-muted/60 hover:bg-muted/90 text-foreground border border-border/70 flex items-center gap-1 transition-all active:scale-95 cursor-pointer shadow-2xs"
          >
            <i class="fas fa-dice text-primary text-[10px]"></i>
            <span>{{ t('connections.form.randomColor', '随机') }}</span>
          </button>
        </div>

        <!-- 预设色板 -->
        <div class="flex items-center flex-wrap gap-1.5 pt-0.5">
          <button
            v-for="color in PRESET_COLORS"
            :key="color"
            type="button"
            @click="selectPresetColor(color)"
            class="w-6 h-6 rounded-full flex items-center justify-center transition-transform hover:scale-110 focus:outline-none relative shadow-2xs cursor-pointer"
            :style="{ backgroundColor: color }"
            :class="props.formData.background_color?.toLowerCase() === color.toLowerCase() ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105' : ''"
            :title="color"
          >
            <i
              v-if="props.formData.background_color?.toLowerCase() === color.toLowerCase()"
              class="fas fa-check text-[10px] text-white drop-shadow-sm"
            ></i>
          </button>
        </div>

        <!-- 原生颜色拾取与十六进制 -->
        <div class="flex items-center gap-2 pt-1">
          <input
            type="color"
            id="conn-color-native"
            v-model="props.formData.background_color"
            class="w-7 h-7 rounded-lg cursor-pointer border border-border/70 bg-transparent p-0.5"
          />
          <input
            type="text"
            v-model="props.formData.background_color"
            placeholder="#3b82f6"
            class="flex-1 px-2.5 py-1 text-xs font-mono border border-border/60 rounded-xl text-foreground bg-background uppercase focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>
    </div>
  </div>
</template>
