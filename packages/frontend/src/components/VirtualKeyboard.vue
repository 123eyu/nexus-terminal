<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 移动端虚拟键盘（QWERTY 布局）。
 *
 * 改造前是一堆等宽按钮 flex-wrap 平铺，字母还是 A→Z 顺序、且一律发大写 ——
 * 手机上敲 `ls -la` 得先切一遍大小写，完全没法用。
 * 现在按真实键盘分行：功能键条（可横向滚动）+ 数字行 + q w e r t y / a s d f / z x c v b n m，
 * 字母默认小写，⇧ 只影响下一个字符（和手机输入法一致）。
 */

const emit = defineEmits<{
  (e: 'send-key', keySequence: string): void;
}>();

const { t } = useI18n();

type KeyType = 'modifier' | 'control' | 'char' | 'navigation' | 'special' | 'action';

interface KeyDefinition {
  label: string;
  /** 实际发给终端的字节序列，缺省用 label */
  sequence?: string;
  /** 按住 ⇧ 时改用的序列（字母用） */
  shiftSequence?: string;
  type: KeyType;
  /** flex 权重，用来做 Tab / ⇧ / Space 这类宽键 */
  flex?: number;
  /** 悬停/无障碍标题 */
  title?: string;
}

/* ------------------------------ 状态 ------------------------------ */

const isCtrlActive = ref(false);
const isAltActive = ref(false);
const isShiftActive = ref(false);

const toggleModifier = (modifier: 'ctrl' | 'alt') => {
  if (modifier === 'ctrl') {
    isCtrlActive.value = !isCtrlActive.value;
    isAltActive.value = false; // Ctrl / Alt 互斥，避免拼出没人期望的组合
  } else {
    isAltActive.value = !isAltActive.value;
    isCtrlActive.value = false;
  }
};

const toggleShift = () => {
  isShiftActive.value = !isShiftActive.value;
};

const resetModifiers = () => {
  isCtrlActive.value = false;
  isAltActive.value = false;
  isShiftActive.value = false;
};

/* ------------------------------ 发送 ------------------------------ */

const sendKey = (keyDef: KeyDefinition) => {
  if (keyDef.type === 'modifier') {
    if (keyDef.label === 'Ctrl' || keyDef.label === 'Alt') {
      toggleModifier(keyDef.label.toLowerCase() as 'ctrl' | 'alt');
    } else {
      toggleShift();
    }
    return;
  }

  const shifted = isShiftActive.value && keyDef.shiftSequence;
  let sequence = shifted ? (keyDef.shiftSequence as string) : keyDef.sequence ?? keyDef.label;

  if (isCtrlActive.value) {
    if (keyDef.type === 'char' && keyDef.label.length === 1) {
      // Ctrl + A~Z → 0x01~0x1A
      sequence = String.fromCharCode(keyDef.label.toUpperCase().charCodeAt(0) - 64);
    }
  } else if (isAltActive.value) {
    // Alt 组合在终端里就是 ESC 前缀
    sequence = '\x1b' + sequence;
  }

  emit('send-key', sequence);

  // 组合键用完即失效；⇧ 也只影响下一个字符（手机上更符合直觉）
  if (isCtrlActive.value || isAltActive.value || isShiftActive.value) resetModifiers();
};

/* ------------------------------ 布局 ------------------------------ */

const arrowKeys: KeyDefinition[] = [
  { label: '↑', sequence: '\x1b[A', type: 'navigation' },
  { label: '↓', sequence: '\x1b[B', type: 'navigation' },
  { label: '←', sequence: '\x1b[D', type: 'navigation' },
  { label: '→', sequence: '\x1b[C', type: 'navigation' },
];

const navKeys: KeyDefinition[] = [
  { label: 'Home', sequence: '\x1b[1~', type: 'navigation' },
  { label: 'End', sequence: '\x1b[4~', type: 'navigation' },
  { label: 'PgUp', sequence: '\x1b[5~', type: 'navigation' },
  { label: 'PgDn', sequence: '\x1b[6~', type: 'navigation' },
];

const functionKeys: KeyDefinition[] = [
  { label: 'F1', sequence: '\x1b[11~', type: 'special' },
  { label: 'F2', sequence: '\x1b[12~', type: 'special' },
  { label: 'F3', sequence: '\x1b[13~', type: 'special' },
  { label: 'F4', sequence: '\x1b[14~', type: 'special' },
  { label: 'F5', sequence: '\x1b[15~', type: 'special' },
  { label: 'F6', sequence: '\x1b[17~', type: 'special' },
  { label: 'F7', sequence: '\x1b[18~', type: 'special' },
  { label: 'F8', sequence: '\x1b[19~', type: 'special' },
  { label: 'F9', sequence: '\x1b[20~', type: 'special' },
  { label: 'F10', sequence: '\x1b[21~', type: 'special' },
  { label: 'F11', sequence: '\x1b[23~', type: 'special' },
  { label: 'F12', sequence: '\x1b[24~', type: 'special' },
];

/** 顶部功能条：窄屏放不下一屏，做成可横向滚动 */
const controlStrip: KeyDefinition[] = [
  { label: 'Esc', sequence: '\x1b', type: 'control' },
  { label: 'Tab', sequence: '\t', type: 'control' },
  { label: 'Ctrl', type: 'modifier', title: t('virtualKeyboard.ctrl', 'Ctrl（与字母组合）') },
  { label: 'Alt', type: 'modifier', title: t('virtualKeyboard.alt', 'Alt（发送 ESC 前缀）') },
  ...arrowKeys,
  ...navKeys,
  ...functionKeys,
];

const digitRow: KeyDefinition[] = [
  { label: '1', type: 'char' },
  { label: '2', type: 'char' },
  { label: '3', type: 'char' },
  { label: '4', type: 'char' },
  { label: '5', type: 'char' },
  { label: '6', type: 'char' },
  { label: '7', type: 'char' },
  { label: '8', type: 'char' },
  { label: '9', type: 'char' },
  { label: '0', type: 'char' },
  { label: '-', type: 'char' },
  { label: '/', type: 'char' },
];

const letter = (label: string): KeyDefinition => ({
  label,
  type: 'char',
  shiftSequence: label.toUpperCase(),
});

const qwertyRow: KeyDefinition[] = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'].map(letter);

const homeRow: KeyDefinition[] = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'].map(letter);

const bottomLetterRow: KeyDefinition[] = [
  { label: '⇧', type: 'modifier', flex: 1.6, title: t('virtualKeyboard.shift', 'Shift（下一个字符大写）') },
  ...['z', 'x', 'c', 'v', 'b', 'n', 'm'].map(letter),
  { label: '⌫', sequence: '\x7f', type: 'action', flex: 1.4, title: t('virtualKeyboard.backspace', '退格') },
];

const symbolRow: KeyDefinition[] = [
  { label: '.', type: 'char' },
  { label: '_', type: 'char' },
  { label: '|', type: 'char' },
  { label: '~', type: 'char' },
  { label: ':', type: 'char' },
  { label: '=', type: 'char' },
  { label: '*', type: 'char' },
  { label: '$', type: 'char' },
];

const actionRow: KeyDefinition[] = [
  {
    label: t('virtualKeyboard.space', '空格'),
    sequence: ' ',
    type: 'char',
    flex: 4,
    title: t('virtualKeyboard.space', '空格'),
  },
  {
    label: t('virtualKeyboard.enter', '回车'),
    sequence: '\r',
    type: 'action',
    flex: 2,
    title: t('virtualKeyboard.enter', '回车'),
  },
];

/** 需要按 flex 等宽铺满的行 */
const keyRows: KeyDefinition[][] = [digitRow, qwertyRow, homeRow, bottomLetterRow, symbolRow, actionRow];

const isModifierActive = (keyDef: KeyDefinition) => {
  if (keyDef.label === 'Ctrl') return isCtrlActive.value;
  if (keyDef.label === 'Alt') return isAltActive.value;
  if (keyDef.label === '⇧') return isShiftActive.value;
  return false;
};
</script>

<template>
  <div class="virtual-keyboard-bar flex flex-col gap-1 px-1 pt-1 pb-1 bg-background border-t border-border">
    <!-- 功能键条：Esc/Tab/Ctrl/Alt、方向键、翻页、F1-F12，窄屏横向滚动 -->
    <div class="flex flex-nowrap gap-1 overflow-x-auto kb-strip">
      <button
        v-for="keyDef in controlStrip"
        :key="keyDef.label"
        type="button"
        class="kb-key kb-key--strip"
        :class="{ 'kb-key--active': isModifierActive(keyDef) }"
        :title="keyDef.title ?? keyDef.label"
        @click="sendKey(keyDef)"
      >
        {{ keyDef.label }}
      </button>
    </div>

    <!-- 数字 + qwerty 主键区 -->
    <div v-for="(row, rowIndex) in keyRows" :key="rowIndex" class="flex gap-1 w-full">
      <button
        v-for="keyDef in row"
        :key="keyDef.label"
        type="button"
        class="kb-key"
        :style="{ flexGrow: keyDef.flex ?? 1, flexBasis: 0 }"
        :class="{ 'kb-key--active': isModifierActive(keyDef) }"
        :title="keyDef.title ?? keyDef.label"
        @click="sendKey(keyDef)"
      >
        {{ keyDef.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.virtual-keyboard-bar {
  /* 键盘本身很矮，别让它在小屏上被压扁 */
  flex-shrink: 0;
}

.kb-strip {
  scrollbar-width: none; /* Firefox */
  -ms-overflow-style: none;
}
.kb-strip::-webkit-scrollbar {
  display: none;
}

.kb-key {
  /* 手指点得中的最小高度；宽度交给 flex 均分（12 个数字键在 390px 上必须能挤下，
     所以不能给 min-width，否则整行会被顶出屏幕右边） */
  min-height: 38px;
  min-width: 0;
  padding: 0 2px;
  border-radius: 8px;
  border: 1px solid var(--color-border, #3f3f46);
  background-color: var(--color-input, rgba(255, 255, 255, 0.06));
  color: var(--color-foreground, #e5e7eb);
  font-size: 13px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  white-space: nowrap;
  transition: background-color 0.12s ease, transform 0.08s ease;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.kb-key:active {
  transform: scale(0.96);
}

.kb-key--strip {
  flex: 0 0 auto;
  min-width: 38px;
  min-height: 32px;
  padding: 0 8px;
  font-size: 12px;
  white-space: nowrap;
}

.kb-key--active {
  background-color: var(--color-primary, #8b5cf6);
  border-color: var(--color-primary, #8b5cf6);
  color: #fff;
}
</style>
