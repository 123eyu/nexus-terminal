<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TerminalTheme } from '../types/terminal-theme.types';
import StyleCustomizerUiTab from './style-customizer/StyleCustomizerUiTab.vue';
import StyleCustomizerTerminalTab from './style-customizer/StyleCustomizerTerminalTab.vue';
import StyleCustomizerHighlightTab from './style-customizer/StyleCustomizerHighlightTab.vue';
import StyleCustomizerBackgroundTab from './style-customizer/StyleCustomizerBackgroundTab.vue';
import StyleCustomizerOtherTab from './style-customizer/StyleCustomizerOtherTab.vue'; 

const { t } = useI18n();
const uiTabRef = ref<InstanceType<typeof StyleCustomizerUiTab> | null>(null);



const isEditingTheme = ref(false);
const editingTheme = ref<TerminalTheme | null>(null);

const emit = defineEmits(['close']);

const closeCustomizer = () => {
  isEditingTheme.value = false;
  editingTheme.value = null;
  emit('close');
};

const currentTab = ref<'ui' | 'terminal' | 'highlight' | 'background' | 'other'>('ui');

// --- Processing Functions ---

const handleSaveUiTheme = async () => {
  if (uiTabRef.value) {
    await uiTabRef.value.handleSaveUiTheme();
  }
};

const handleResetUiTheme = async () => {
  if (uiTabRef.value) {
    await uiTabRef.value.handleResetUiTheme();
  }
};



const modalRootRef = ref<HTMLDivElement | null>(null);
const headerRef = ref<HTMLElement | null>(null);
const dialogContentRef = ref<HTMLDivElement | null>(null);

const draggableState = reactive({
  isDragging: false,
  startX: 0,
  startY: 0,
  initialLeft: 0,
  initialTop: 0,
});

onMounted(() => {
  const headerElement = headerRef.value;
  const dialogEl = dialogContentRef.value;
  const rootEl = modalRootRef.value;

  if (!headerElement || !dialogEl || !rootEl) {
    // console.warn("Draggable elements not found for StyleCustomizer modal."); // 用于调试的可选日志
    return;
  }
  
  nextTick(() => {
    //确保对话框已渲染且其尺寸可用
    if (dialogEl && rootEl) {
        dialogEl.style.position = 'absolute'; // 使对话框在rootEl内绝对定位
        const rootWidth = rootEl.clientWidth;
        const rootHeight = rootEl.clientHeight;
        const dialogWidth = dialogEl.offsetWidth;
        const dialogHeight = dialogEl.offsetHeight;

        // 使对话框居中
        dialogEl.style.left = `${Math.max(0, (rootWidth - dialogWidth) / 2)}px`;
        dialogEl.style.top = `${Math.max(0, (rootHeight - dialogHeight) / 2)}px`;
    }
  });

  const onMouseDown = (event: MouseEvent) => {
    if (!dialogEl) return;
    event.preventDefault(); // 防止文本选择等默认行为

    draggableState.isDragging = true;
    draggableState.startX = event.clientX;
    draggableState.startY = event.clientY;
    draggableState.initialLeft = dialogEl.offsetLeft;
    draggableState.initialTop = dialogEl.offsetTop;
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!draggableState.isDragging || !dialogEl || !rootEl) return;

    const dx = event.clientX - draggableState.startX;
    const dy = event.clientY - draggableState.startY;

    let newLeft = draggableState.initialLeft + dx;
    let newTop = draggableState.initialTop + dy;

    // 边界检查，使对话框保持在 modalRootRef (视口) 内
    newLeft = Math.max(0, Math.min(newLeft, rootEl.clientWidth - dialogEl.offsetWidth));
    newTop = Math.max(0, Math.min(newTop, rootEl.clientHeight - dialogEl.offsetHeight));
    
    dialogEl.style.left = `${newLeft}px`;
    dialogEl.style.top = `${newTop}px`;
  };

  const onMouseUp = () => {
    if (!draggableState.isDragging) return;
    draggableState.isDragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };

  // 监听 Escape 快捷键退出
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      closeCustomizer();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  headerElement.addEventListener('mousedown', onMouseDown);
  headerElement.style.cursor = 'move';

  onUnmounted(() => {
    window.removeEventListener('keydown', onKeyDown);
    if (headerElement) {
      headerElement.removeEventListener('mousedown', onMouseDown);
      headerElement.style.cursor = '';
    }
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  });
});
</script>

<template>
  <div ref="modalRootRef" class="fixed inset-0 z-[1000] flex items-center justify-center p-3 md:p-6 select-none" @click.self="closeCustomizer">
    <div
      ref="dialogContentRef"
      class="bg-background text-foreground border border-border/80 rounded-2xl shadow-2xl w-full md:w-[94%] md:max-w-[920px] h-[92vh] md:h-[84vh] md:max-h-[720px] flex flex-col overflow-hidden"
      style="background-color: var(--app-bg-color);"
    >
      <!-- 顶部 Header 拖拽栏 -->
      <header
        ref="headerRef"
        class="flex justify-between items-center px-5 py-3.5 border-b border-border/70 flex-shrink-0 select-none cursor-move"
      >
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-lg bg-primary/15 border border-primary/25 flex items-center justify-center text-primary">
            <i class="fas fa-palette text-sm"></i>
          </div>
          <div>
            <h2 class="text-sm md:text-base font-bold text-foreground tracking-tight leading-none">
              {{ t('styleCustomizer.title', '外观自定义') }}
            </h2>
          </div>
        </div>

        <!-- 居中抓手标记 -->
        <div class="hidden md:flex items-center gap-1 opacity-30">
          <span class="w-1.5 h-1.5 rounded-full bg-foreground"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-foreground"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-foreground"></span>
        </div>

        <button
          type="button"
          @click="closeCustomizer"
          class="w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground hover:bg-muted/80 transition-colors cursor-pointer"
          title="Esc"
        >
          <i class="fas fa-times text-xs"></i>
        </button>
      </header>

      <!-- 中间主体双栏区 -->
      <div class="flex flex-grow overflow-hidden flex-col md:flex-row min-h-0">
        <!-- 左侧精致垂直导航 -->
        <nav class="w-full md:w-[200px] border-b md:border-b-0 md:border-r border-border/70 p-2.5 md:p-3 bg-muted/20 flex-shrink-0 overflow-y-auto flex flex-row md:flex-col gap-1 md:gap-1.5 justify-start">
          <button
            type="button"
            @click="currentTab = 'ui'"
            class="flex items-center gap-2.5 px-3 py-2 md:py-2.5 rounded-xl text-xs md:text-sm font-medium transition-all text-left cursor-pointer flex-shrink-0"
            :class="currentTab === 'ui'
              ? 'bg-primary text-white font-semibold shadow-xs'
              : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
          >
            <i class="fas fa-palette w-4 text-center text-xs"></i>
            <span>{{ t('styleCustomizer.uiStyles', '界面配色') }}</span>
          </button>

          <button
            type="button"
            @click="currentTab = 'terminal'"
            class="flex items-center gap-2.5 px-3 py-2 md:py-2.5 rounded-xl text-xs md:text-sm font-medium transition-all text-left cursor-pointer flex-shrink-0"
            :class="currentTab === 'terminal' && !isEditingTheme
              ? 'bg-primary text-white font-semibold shadow-xs'
              : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
            :disabled="isEditingTheme"
          >
            <i class="fas fa-terminal w-4 text-center text-xs"></i>
            <span>{{ t('styleCustomizer.terminalStyles', '终端风格') }}</span>
          </button>

          <button
            type="button"
            @click="currentTab = 'highlight'"
            class="flex items-center gap-2.5 px-3 py-2 md:py-2.5 rounded-xl text-xs md:text-sm font-medium transition-all text-left cursor-pointer flex-shrink-0"
            :class="currentTab === 'highlight'
              ? 'bg-primary text-white font-semibold shadow-xs'
              : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
            :disabled="isEditingTheme"
          >
            <i class="fas fa-highlighter w-4 text-center text-xs"></i>
            <span>{{ t('styleCustomizer.terminalHighlight', '代码高亮') }}</span>
          </button>

          <button
            type="button"
            @click="currentTab = 'background'"
            class="flex items-center gap-2.5 px-3 py-2 md:py-2.5 rounded-xl text-xs md:text-sm font-medium transition-all text-left cursor-pointer flex-shrink-0"
            :class="currentTab === 'background'
              ? 'bg-primary text-white font-semibold shadow-xs'
              : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
            :disabled="isEditingTheme"
          >
            <i class="fas fa-image w-4 text-center text-xs"></i>
            <span>{{ t('styleCustomizer.backgroundSettings', '背景效果') }}</span>
          </button>

          <button
            type="button"
            @click="currentTab = 'other'"
            class="flex items-center gap-2.5 px-3 py-2 md:py-2.5 rounded-xl text-xs md:text-sm font-medium transition-all text-left cursor-pointer flex-shrink-0"
            :class="currentTab === 'other'
              ? 'bg-primary text-white font-semibold shadow-xs'
              : 'text-text-secondary hover:text-foreground hover:bg-muted/60'"
            :disabled="isEditingTheme"
          >
            <i class="fas fa-sliders-h w-4 text-center text-xs"></i>
            <span>{{ t('styleCustomizer.otherSettings', '编辑器与其他') }}</span>
          </button>
        </nav>

        <!-- 右侧子页面内容容器 -->
        <main class="flex-grow p-4 md:p-6 overflow-y-auto min-h-0 bg-background/40">
          <StyleCustomizerUiTab v-if="currentTab === 'ui'" ref="uiTabRef" />
          <StyleCustomizerTerminalTab
            v-if="currentTab === 'terminal'"
            :modal-root-ref="modalRootRef"
            :is-editing-theme="isEditingTheme"
            :editing-theme="editingTheme"
            @update:is-editing-theme="val => isEditingTheme = val"
            @update:editing-theme="val => editingTheme = val"
          />
          <StyleCustomizerHighlightTab v-if="currentTab === 'highlight'" />
          <StyleCustomizerBackgroundTab v-if="currentTab === 'background'" />
          <StyleCustomizerOtherTab v-if="currentTab === 'other'" />
        </main>
      </div>

      <!-- 底部清爽操作栏 -->
      <footer class="flex items-center justify-between px-5 py-3 border-t border-border/70 bg-header/30 flex-shrink-0">
        <div class="flex items-center gap-2">
          <button
            v-if="currentTab === 'ui'"
            @click="handleResetUiTheme"
            class="px-3.5 py-1.5 rounded-lg border border-border/80 bg-muted/40 text-text-secondary hover:text-foreground hover:bg-muted transition-colors text-xs font-medium cursor-pointer"
          >
            {{ t('styleCustomizer.resetUiTheme', '重置默认配色') }}
          </button>
        </div>

        <div class="flex items-center gap-2">
          <button
            v-if="currentTab === 'ui'"
            @click="handleSaveUiTheme"
            class="px-4 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-white font-medium text-xs transition-colors shadow-xs cursor-pointer"
          >
            {{ t('styleCustomizer.saveUiTheme', '保存界面配色') }}
          </button>
          <button
            @click="closeCustomizer"
            class="px-4 py-1.5 rounded-lg border border-border/80 bg-muted/40 text-text-secondary hover:text-foreground hover:bg-muted transition-colors text-xs font-medium cursor-pointer"
          >
            {{ t('common.close', '关闭') }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

