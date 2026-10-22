<script setup lang="ts">
/**
 * AppSelect —— 统一的自绘下拉。
 *
 * 为什么不用原生 <select>：
 *   原生 select **收起态**可以靠 CSS 变成我们要的样子，但**点开后的选项列表是浏览器/系统绘制的独立
 *   浮层**，`background-color`、`select option {}`、`!important` 全都管不到（实测只有 color-scheme 有
 *   一点点影响，Windows 上照样跟着**系统**深浅走）。于是深色主题里点开下拉会弹出一整片浅色列表，
 *   看上去就是「没做过样式的原生控件」。要 100% 跟主题一致，只能自绘。
 *
 * 用法与原生几乎一致 —— 直接把 <select> 换成 <AppSelect>，`<option>` 子节点原样留着：
 *   <AppSelect id="conn-proxy" v-model="form.proxy_id">
 *     <option :value="null">无代理</option>
 *     <option v-for="p in proxies" :key="p.id" :value="p.id">{{ p.name }}</option>
 *   </AppSelect>
 * 子节点不会被渲染，只在 setup 里被读成 { label, value, disabled }，所以 v-for / v-if / {{ t() }} 都照常生效。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useSlots, Comment, Fragment, type VNode } from 'vue';

type SelectValue = string | number | boolean | null | undefined;

interface OptionItem {
  label: string;
  value: SelectValue;
  disabled: boolean;
  /** 来自 <optgroup label="...">，渲染成分组小标题 */
  group?: string;
}

const props = withDefaults(
  defineProps<{
    modelValue?: SelectValue;
    disabled?: boolean;
    /** 没有匹配项时显示的文案 */
    placeholder?: string;
    /** 浮层最小宽度（默认跟随触发按钮宽度） */
    minPopupWidth?: number;
  }>(),
  { modelValue: undefined, disabled: false, placeholder: '', minPopupWidth: 0 }
);

/**
 * 模板有两个根节点（触发按钮 + 传送到 body 的浮层），Vue 无法自动继承 attrs
 * （会警告 "cannot be automatically inherited because component renders fragment"），
 * 所以显式关掉自动继承，把 $attrs 手动绑到按钮上 —— 调用方的 id / class / aria-* / title 都靠这个。
 */
defineOptions({ inheritAttrs: false });

const emit = defineEmits<{
  (e: 'update:modelValue', value: SelectValue): void;
  (e: 'change', value: SelectValue): void;
}>();

const slots = useSlots();

/* ---------------- 把 <option> 子节点读成数据 ---------------- */

/** 抽 vnode 的纯文本（{{ t(...) }} / 字符串 / 嵌套数组都能处理） */
function vnodeText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(vnodeText).join('');
  if (typeof node === 'object') {
    const children = (node as { children?: unknown }).children;
    if (children !== undefined) return vnodeText(children);
  }
  return '';
}

/** v-for 会包一层 Fragment，v-if 会产出 Comment，都要摊平/跳过；optgroup 里的选项带分组名 */
function collect(nodes: unknown, out: OptionItem[], group?: string): void {
  if (!nodes) return;
  const list = Array.isArray(nodes) ? nodes : [nodes];
  for (const raw of list) {
    const node = raw as VNode;
    if (!node || typeof node !== 'object') continue;
    if (node.type === Comment) continue;
    if (node.type === Fragment) {
      collect(node.children, out, group);
      continue;
    }
    if (node.type === 'optgroup') {
      const gp = (node.props || {}) as Record<string, unknown>;
      collect(node.children, out, gp.label === undefined ? group : String(gp.label));
      continue;
    }
    if (node.type === 'option') {
      const p = (node.props || {}) as Record<string, unknown>;
      out.push({
        label: vnodeText(node.children).replace(/\s+/g, ' ').trim(),
        // 用 hasOwnProperty 而不是 `?? ''`：`:value="null"` 和 `:value="undefined"` 是两种不同的选项
        value: Object.prototype.hasOwnProperty.call(p, 'value') ? (p.value as SelectValue) : '',
        disabled: p.disabled !== undefined && p.disabled !== false,
        group,
      });
    }
  }
}

const options = computed<OptionItem[]>(() => {
  const out: OptionItem[] = [];
  // 调用 slot 函数 = 在 computed 里求值，option 里用到的 props/store 都会被正常追踪
  collect((slots.default ? slots.default() : []) as unknown, out);
  return out;
});

/** null 与 undefined 视为不同选项（批量编辑里两者语义不同），但数字/字符串允许宽松相等 */
function sameValue(a: SelectValue, b: SelectValue): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

const selectedOption = computed(() => options.value.find((o) => sameValue(o.value, props.modelValue)));
const displayLabel = computed(() => selectedOption.value?.label ?? props.placeholder ?? '');

/**
 * 原生 select 的宽度 = **最长的那一项**，所以换选项时控件宽度不会跳。
 * button 默认是按当前文案撑开的，这里塞一个隐藏的「最长选项」用来撑宽度，行为跟原生对齐。
 * （w-full 的场景不受影响）
 */
const widestLabel = computed(() =>
  options.value.reduce((longest, o) => (o.label.length > longest.length ? o.label : longest), '')
);

/* ---------------- 浮层开合 / 定位 ---------------- */

const isOpen = ref(false);
const activeIndex = ref(-1);
const triggerRef = ref<HTMLButtonElement | null>(null);
const popupRef = ref<HTMLElement | null>(null);
const popupStyle = ref<Record<string, string>>({});

const POPUP_MAX_HEIGHT = 288;
const EDGE_PADDING = 8;
const GAP = 4;

function updatePosition(): void {
  const trigger = triggerRef.value;
  if (!isOpen.value || !trigger) return;
  const rect = trigger.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const width = Math.max(rect.width, props.minPopupWidth);
  let left = rect.left;
  if (left + width > viewportW - EDGE_PADDING) left = viewportW - width - EDGE_PADDING;
  if (left < EDGE_PADDING) left = EDGE_PADDING;

  const popupHeight = popupRef.value ? popupRef.value.offsetHeight : POPUP_MAX_HEIGHT;
  const spaceBelow = viewportH - rect.bottom - GAP - EDGE_PADDING;
  const spaceAbove = rect.top - GAP - EDGE_PADDING;
  // 下方放不下且上方更宽裕 → 向上翻
  const flipUp = popupHeight > spaceBelow && spaceAbove > spaceBelow;

  popupStyle.value = {
    left: `${Math.round(left)}px`,
    width: `${Math.round(width)}px`,
    maxHeight: `${Math.min(POPUP_MAX_HEIGHT, Math.max(120, flipUp ? spaceAbove : spaceBelow))}px`,
    ...(flipUp
      ? { bottom: `${Math.round(viewportH - rect.top + GAP)}px`, top: 'auto' }
      : { top: `${Math.round(rect.bottom + GAP)}px`, bottom: 'auto' }),
  };
}

async function open(): Promise<void> {
  if (props.disabled || isOpen.value) return;
  const idx = options.value.findIndex((o) => sameValue(o.value, props.modelValue) && !o.disabled);
  activeIndex.value = idx >= 0 ? idx : options.value.findIndex((o) => !o.disabled);
  isOpen.value = true;
  updatePosition();
  await nextTick();
  updatePosition();
  // 选中项滚进可视区
  const el = popupRef.value?.querySelector<HTMLElement>(`[data-idx="${activeIndex.value}"]`);
  el?.scrollIntoView({ block: 'nearest' });
}

function close(): void {
  isOpen.value = false;
  activeIndex.value = -1;
}

function toggle(): void {
  if (isOpen.value) close();
  else void open();
}

function pick(opt: OptionItem): void {
  if (opt.disabled) return;
  close();
  triggerRef.value?.focus({ preventScroll: true });
  if (sameValue(opt.value, props.modelValue)) return;
  emit('update:modelValue', opt.value);
  emit('change', opt.value);
}

function moveActive(step: number): void {
  const list = options.value;
  if (list.length === 0) return;
  let i = activeIndex.value;
  for (let n = 0; n < list.length; n += 1) {
    i = (i + step + list.length) % list.length;
    if (!list[i].disabled) {
      activeIndex.value = i;
      break;
    }
  }
  const el = popupRef.value?.querySelector<HTMLElement>(`[data-idx="${activeIndex.value}"]`);
  el?.scrollIntoView({ block: 'nearest' });
}

function onKeydown(e: KeyboardEvent): void {
  if (props.disabled) return;
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      if (!isOpen.value) void open();
      else moveActive(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (!isOpen.value) void open();
      else moveActive(-1);
      break;
    case 'Home':
      if (!isOpen.value) return;
      e.preventDefault();
      activeIndex.value = options.value.findIndex((o) => !o.disabled);
      break;
    case 'End':
      if (!isOpen.value) return;
      e.preventDefault();
      activeIndex.value = options.value.map((o) => !o.disabled).lastIndexOf(true);
      break;
    case 'Enter':
    case ' ':
      e.preventDefault();
      if (!isOpen.value) void open();
      else if (options.value[activeIndex.value]) pick(options.value[activeIndex.value]);
      break;
    case 'Escape':
      if (isOpen.value) {
        e.preventDefault();
        e.stopPropagation(); // 别让 Esc 顺手把外层弹窗也关了
        close();
      }
      break;
    case 'Tab':
      if (isOpen.value) close();
      break;
    default:
      break;
  }
}

function onDocMousedown(e: MouseEvent): void {
  if (!isOpen.value) return;
  const target = e.target as Node | null;
  if (!target) return;
  if (triggerRef.value?.contains(target)) return;
  if (popupRef.value?.contains(target)) return;
  close();
}

function onViewportChange(): void {
  if (!isOpen.value) return;
  const trigger = triggerRef.value;
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  // 触发按钮被滚出视口就收起来，否则浮层会飘在别处
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    close();
    return;
  }
  updatePosition();
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMousedown, true);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMousedown, true);
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onViewportChange, true);
});

defineExpose({ open, close, focus: () => triggerRef.value?.focus() });
</script>

<template>
  <button
    ref="triggerRef"
    v-bind="$attrs"
    type="button"
    class="app-select-trigger"
    :class="{ 'is-open': isOpen }"
    :disabled="disabled"
    role="combobox"
    aria-haspopup="listbox"
    :aria-expanded="isOpen"
    @click="toggle"
    @keydown="onKeydown"
  >
    <span class="app-select-label" :class="{ 'is-placeholder': !selectedOption }">{{ displayLabel }}</span>
    <span class="app-select-measure" aria-hidden="true">{{ widestLabel }}</span>
    <svg class="app-select-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 5l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  <Teleport to="body">
    <div v-if="isOpen" ref="popupRef" class="app-select-popup" :style="popupStyle" role="listbox" @mousedown.prevent>
      <div v-if="options.length === 0" class="app-select-empty">—</div>
      <template v-for="(opt, idx) in options" :key="idx">
        <!-- 分组小标题（来自 <optgroup>），不可选中 -->
        <div v-if="opt.group && opt.group !== (options[idx - 1]?.group ?? '')" class="app-select-group">{{ opt.group }}</div>
        <div
          :data-idx="idx"
          class="app-select-option"
          :class="{
            'is-active': idx === activeIndex,
            'is-selected': sameValue(opt.value, modelValue),
            'is-disabled': opt.disabled,
          }"
          role="option"
          :aria-selected="sameValue(opt.value, modelValue)"
          :aria-disabled="opt.disabled"
          @click="pick(opt)"
          @mouseenter="!opt.disabled && (activeIndex = idx)"
        >
          <span class="app-select-option-label">{{ opt.label }}</span>
          <svg v-if="sameValue(opt.value, modelValue)" class="app-select-check" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8.5l3.5 3.5L13 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
      </template>
    </div>
  </Teleport>
</template>
