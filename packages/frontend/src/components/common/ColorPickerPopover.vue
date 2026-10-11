<template>
  <span ref="anchorRef" class="hidden"></span>
  <Teleport to="body">
    <div v-if="visible" class="color-picker-portal-root">
      <!-- 全屏透明遮罩，点击外部自动关闭浮层 -->
      <div
        class="fixed inset-0 z-[99998] bg-transparent"
        @click.stop="handleClose"
      ></div>

      <!-- 调色板浮层本体 -->
      <div
        ref="popoverRef"
        class="color-picker-popover w-[268px] bg-card/95 backdrop-blur-md border border-border/80 shadow-2xl rounded-2xl p-3.5 text-xs space-y-3 select-none z-[99999]"
        :style="popoverStyle"
        @click.stop
      >
        <!-- 头部栏 -->
        <div class="flex items-center justify-between pb-2 border-b border-border/50">
          <div class="flex items-center gap-1.5 text-foreground font-semibold">
            <i class="fas fa-palette text-primary text-xs"></i>
            <span>{{ title || t('common.selectColor', '设置背景颜色') }}</span>
          </div>
          <div class="flex items-center gap-1">
            <button
              type="button"
              @click="handleRandomColor"
              class="px-1.5 py-0.5 text-[11px] font-medium rounded bg-muted/60 hover:bg-muted text-text-secondary hover:text-foreground flex items-center gap-1 transition-colors cursor-pointer"
              :title="t('common.randomColor', '随机颜色')"
            >
              <i class="fas fa-dice text-primary"></i>
              <span>{{ t('common.random', '随机') }}</span>
            </button>
            <button
              v-if="showClear && modelValue"
              type="button"
              @click="handleClearColor"
              class="px-1.5 py-0.5 text-[11px] font-medium rounded text-text-secondary hover:text-error hover:bg-error/10 transition-colors cursor-pointer"
              :title="t('common.clearColor', '清除/恢复继承')"
            >
              <i class="fas fa-times"></i>
            </button>
          </div>
        </div>

        <!-- 预设色板网格 -->
        <div class="grid grid-cols-7 gap-1.5 pt-0.5">
          <!-- 清空/默认颜色选项 -->
          <button
            v-if="showClear"
            type="button"
            @click="handleClearColor"
            class="w-6 h-6 rounded-full border border-dashed border-border/90 flex items-center justify-center hover:border-primary transition-all text-text-secondary hover:text-foreground cursor-pointer"
            :class="!modelValue ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : ''"
            :title="clearLabel || t('common.defaultColor', '默认/清除')"
          >
            <i class="fas fa-ban text-[10px] opacity-60"></i>
          </button>

          <!-- 预设颜色 -->
          <button
            v-for="color in PRESET_COLORS"
            :key="color"
            type="button"
            @click="selectColor(color)"
            class="w-6 h-6 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-95 shadow-xs cursor-pointer"
            :style="{ backgroundColor: color }"
            :class="modelValue?.toLowerCase() === color.toLowerCase() ? 'ring-2 ring-primary ring-offset-1 ring-offset-background scale-105' : ''"
            :title="color"
          >
            <i
              v-if="modelValue?.toLowerCase() === color.toLowerCase()"
              class="fas fa-check text-[10px] text-white drop-shadow"
            ></i>
          </button>
        </div>

        <!-- 自定义原生拾色器与 HEX 文本框 -->
        <div class="flex items-center gap-2 pt-1 border-t border-border/40">
          <div class="relative flex items-center flex-shrink-0">
            <input
              type="color"
              :value="modelValue || '#3b82f6'"
              @input="onNativeColorChange"
              class="w-7 h-7 rounded-md cursor-pointer border border-border/80 bg-transparent p-0.5"
            />
          </div>
          <input
            type="text"
            :value="modelValue || ''"
            @input="onHexInputChange"
            placeholder="#HEX (如 #3b82f6)"
            class="flex-1 px-2 py-1 text-xs font-mono uppercase bg-input/60 border border-border/70 rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
          />
        </div>

        <!-- 底部视觉预览药丸 -->
        <div class="pt-1">
          <div
            class="px-2.5 py-1.5 rounded-lg border text-xs flex items-center justify-between transition-colors duration-200"
            :style="previewStyle"
          >
            <div class="flex items-center gap-1.5 truncate">
              <span
                class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                :style="{ backgroundColor: modelValue || 'var(--color-primary, #3b82f6)' }"
              ></span>
              <span class="font-medium text-foreground truncate">
                {{ modelValue ? modelValue.toUpperCase() : t('common.defaultAppearance', '继承或默认外观') }}
              </span>
            </div>
            <span class="text-[10px] text-text-secondary/70">
              {{ modelValue ? t('common.customActive', '已设色') : t('common.inheritColor', '继承') }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { PRESET_COLORS, generateRandomColor, hexToRgba } from '../../utils/colorUtils';

const props = withDefaults(
  defineProps<{
    visible?: boolean;
    triggerEl?: HTMLElement | null;
    modelValue?: string | null;
    title?: string;
    showClear?: boolean;
    clearLabel?: string;
  }>(),
  {
    visible: false,
    triggerEl: null,
    modelValue: null,
    title: '',
    showClear: true,
    clearLabel: '',
  }
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | null): void;
  (e: 'change', value: string | null): void;
  (e: 'close'): void;
}>();

const { t } = useI18n();

const anchorRef = ref<HTMLElement | null>(null);
const popoverRef = ref<HTMLElement | null>(null);
const popoverStyle = ref<Record<string, string>>({});

const updatePosition = () => {
  if (typeof window === 'undefined') return;

  let target: HTMLElement | null = props.triggerEl || null;

  if (!target && anchorRef.value) {
    // 遍历祖先节点寻找具有可见坐标的元素
    let curr: HTMLElement | null = anchorRef.value.parentElement;
    while (curr && curr !== document.body) {
      const r = curr.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        target = curr;
        break;
      }
      curr = curr.parentElement;
    }
  }

  if (!target) return;

  const rect = target.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  const popoverWidth = 270;
  const popoverHeight = 310;

  // 优先定位在目标元素右侧
  let left = rect.right + 8;
  if (left + popoverWidth > window.innerWidth - 12) {
    left = rect.left - popoverWidth - 8;
  }
  if (left < 12) {
    left = Math.max(12, rect.left);
  }

  // 垂直方向对齐
  let top = rect.top - 6;
  if (top + popoverHeight > window.innerHeight - 12) {
    top = Math.max(12, window.innerHeight - popoverHeight - 12);
  }
  if (top < 12) {
    top = 12;
  }

  popoverStyle.value = {
    position: 'fixed',
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  };
};

watch(
  () => props.visible,
  (newVal) => {
    if (newVal) {
      nextTick(updatePosition);
    }
  },
  { immediate: true }
);

const handleClose = () => {
  emit('close');
};

const handleWindowScrollOrResize = () => {
  if (props.visible) {
    updatePosition();
  }
};

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('scroll', handleWindowScrollOrResize, true);
    window.addEventListener('resize', handleWindowScrollOrResize);
  }
});

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('scroll', handleWindowScrollOrResize, true);
    window.removeEventListener('resize', handleWindowScrollOrResize);
  }
});

const selectColor = (color: string) => {
  emit('update:modelValue', color);
  emit('change', color);
};

const handleClearColor = () => {
  emit('update:modelValue', null);
  emit('change', null);
};

const handleRandomColor = () => {
  const newColor = generateRandomColor();
  emit('update:modelValue', newColor);
  emit('change', newColor);
};

const onNativeColorChange = (e: Event) => {
  const val = (e.target as HTMLInputElement).value;
  emit('update:modelValue', val);
  emit('change', val);
};

const onHexInputChange = (e: Event) => {
  const val = (e.target as HTMLInputElement).value.trim();
  if (!val) {
    emit('update:modelValue', null);
    emit('change', null);
  } else if (/^#[0-9A-Fa-f]{3,8}$/.test(val)) {
    emit('update:modelValue', val);
    emit('change', val);
  }
};

const previewStyle = computed(() => {
  if (!props.modelValue) {
    return {
      backgroundColor: 'rgba(128, 128, 128, 0.08)',
      borderColor: 'rgba(128, 128, 128, 0.2)',
    };
  }
  return {
    backgroundColor: hexToRgba(props.modelValue, 0.16),
    borderColor: hexToRgba(props.modelValue, 0.35),
  };
});
</script>

<style scoped>
.color-picker-popover {
  animation: popoverFadeIn 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes popoverFadeIn {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(-4px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
</style>
