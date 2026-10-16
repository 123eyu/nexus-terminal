<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LayoutNode, TerminalPaneBackgroundConfig } from '../stores/layout.store';

const props = defineProps<{
  visible: boolean;
  node: LayoutNode | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save', config: TerminalPaneBackgroundConfig): void;
}>();

const { t } = useI18n();

const mode = ref<'inherit' | 'none' | 'transparent' | 'custom'>('inherit');
const customImage = ref('');
const overlayOpacity = ref(0.5);

watch(
  () => props.visible,
  (val) => {
    if (val && props.node) {
      const cfg = props.node.terminalBackground;
      mode.value = cfg?.mode || 'inherit';
      customImage.value = cfg?.customImage || '';
      overlayOpacity.value = typeof cfg?.overlayOpacity === 'number' ? cfg.overlayOpacity : 0.5;
    }
  },
  { immediate: true }
);

const handleSave = () => {
  emit('save', {
    mode: mode.value,
    customImage: customImage.value.trim() || undefined,
    overlayOpacity: Number(overlayOpacity.value),
  });
  emit('close');
};
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      @click.stop="emit('close')"
      @mousedown.stop
      @mouseup.stop
      @pointerdown.stop
    >
      <div
        class="bg-[#181a20] border border-border/80 rounded-xl shadow-2xl max-w-md w-full overflow-hidden flex flex-col pointer-events-auto"
        @click.stop
        @mousedown.stop
        @mouseup.stop
        @pointerdown.stop
      >
        <!-- 弹窗标题 -->
        <div class="px-5 py-3.5 bg-header/80 border-b border-border/60 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-md bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-purple-400 text-xs">
              <i class="fas fa-image"></i>
            </div>
            <h3 class="text-sm font-semibold text-foreground">
              {{ t('layoutNodeEditor.terminalBackgroundTitle', '终端窗格背景样式定制') }}
            </h3>
          </div>
          <button
            type="button"
            @click.stop="emit('close')"
            class="text-text-secondary hover:text-foreground p-1 rounded-md hover:bg-hover transition-colors cursor-pointer text-xs"
          >
            <i class="fas fa-times"></i>
          </button>
        </div>

        <!-- 弹窗主体 -->
        <div class="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
          <!-- 背景模式选择 -->
          <div class="space-y-1.5">
            <label class="block text-xs font-medium text-text-secondary">
              {{ t('layoutNodeEditor.bgModeLabel', '背景显示模式') }}
            </label>
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                @click="mode = 'inherit'"
                class="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs text-left transition-all cursor-pointer"
                :class="mode === 'inherit' ? 'border-purple-500 bg-purple-500/15 text-purple-300 font-medium' : 'border-border/60 bg-header/40 text-text-secondary hover:border-border'"
              >
                <i class="fas fa-layer-group text-[11px]"></i>
                <div class="truncate">
                  <div class="font-medium text-foreground">跟随全局</div>
                  <div class="text-[10px] text-text-secondary truncate">统一展示全局壁纸/动效</div>
                </div>
              </button>

              <button
                type="button"
                @click="mode = 'none'"
                class="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs text-left transition-all cursor-pointer"
                :class="mode === 'none' ? 'border-purple-500 bg-purple-500/15 text-purple-300 font-medium' : 'border-border/60 bg-header/40 text-text-secondary hover:border-border'"
              >
                <i class="fas fa-square text-[11px]"></i>
                <div class="truncate">
                  <div class="font-medium text-foreground">纯黑经典底</div>
                  <div class="text-[10px] text-text-secondary truncate">不透视任何背景壁纸</div>
                </div>
              </button>

              <button
                type="button"
                @click="mode = 'transparent'"
                class="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs text-left transition-all cursor-pointer"
                :class="mode === 'transparent' ? 'border-purple-500 bg-purple-500/15 text-purple-300 font-medium' : 'border-border/60 bg-header/40 text-text-secondary hover:border-border'"
              >
                <i class="fas fa-eye text-[11px]"></i>
                <div class="truncate">
                  <div class="font-medium text-foreground">纯透明穿透</div>
                  <div class="text-[10px] text-text-secondary truncate">直接透出底层背景</div>
                </div>
              </button>

              <button
                type="button"
                @click="mode = 'custom'"
                class="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs text-left transition-all cursor-pointer"
                :class="mode === 'custom' ? 'border-purple-500 bg-purple-500/15 text-purple-300 font-medium' : 'border-border/60 bg-header/40 text-text-secondary hover:border-border'"
              >
                <i class="fas fa-paintbrush text-[11px]"></i>
                <div class="truncate">
                  <div class="font-medium text-foreground">专属自定义</div>
                  <div class="text-[10px] text-text-secondary truncate">配置本窗格独立壁纸</div>
                </div>
              </button>
            </div>
          </div>

          <!-- 自定义壁纸路径/URL (仅在 mode === 'custom' 时展开) -->
          <div v-if="mode === 'custom'" class="space-y-3 pt-2 border-t border-border/50">
            <div>
              <label class="block text-xs font-medium text-text-secondary mb-1">
                {{ t('layoutNodeEditor.customImageLabel', '专属壁纸图片 URL 或文件路径') }}
              </label>
              <input
                type="text"
                v-model="customImage"
                placeholder="例如: https://... 或 /uploads/..."
                class="w-full h-8 px-2.5 text-xs bg-input border border-border/70 rounded-md text-foreground focus:outline-none focus:border-purple-500"
              />
            </div>

            <div>
              <div class="flex items-center justify-between text-xs mb-1">
                <span class="text-text-secondary">专属暗色蒙版透明度</span>
                <span class="font-mono text-purple-400 font-semibold">{{ Math.round(overlayOpacity * 100) }}%</span>
              </div>
              <input
                type="range"
                v-model.number="overlayOpacity"
                min="0"
                max="1"
                step="0.05"
                class="w-full accent-purple-500 cursor-pointer"
              />
            </div>
          </div>
        </div>

        <!-- 弹窗底部操作栏 -->
        <div class="px-5 py-3 bg-header/60 border-t border-border/60 flex items-center justify-end gap-2">
          <button
            type="button"
            @click.stop="emit('close')"
            class="px-3.5 py-1.5 rounded-lg border border-border/60 bg-background text-text-secondary hover:text-foreground text-xs font-medium transition-colors cursor-pointer"
          >
            {{ t('common.cancel', '取消') }}
          </button>
          <button
            type="button"
            @click.stop="handleSave"
            class="px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer"
          >
            {{ t('common.save', '保存配置') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
