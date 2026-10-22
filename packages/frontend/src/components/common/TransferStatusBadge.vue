<script setup lang="ts">
import { computed } from 'vue';
import { resolveTransferTone, isBusyTransferStatus } from '../../utils/transfer-status';

interface Props {
  /** 后端返回的原始状态字符串 */
  status: string;
  /** 已翻译好的展示文案（i18n 在调用方处理，本组件只负责长相） */
  label: string;
  size?: 'xs' | 'sm' | 'md';
  /** 排队/传输中/取消中的那个小圆点会呼吸，静止状态则常亮 */
  animated?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  size: 'sm',
  animated: true,
});

const tone = computed(() => resolveTransferTone(props.status));
const busy = computed(() => props.animated && isBusyTransferStatus(props.status));
</script>

<template>
  <span
    class="tsb"
    :class="[`tsb--${props.size}`, `tsb--${tone}`, { 'tsb--pulse': busy }]"
  >
    <span class="tsb__dot" aria-hidden="true"></span>
    <span class="tsb__label">{{ props.label }}</span>
  </span>
</template>

<style scoped>
.tsb {
  --tsb-base: var(--text-color-secondary, #6b7280);

  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  flex: none;
  max-width: 100%;
  border: 1px solid;
  border-radius: 999px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: 0.01em;
  white-space: nowrap;

  /* 底色/描边用状态色 + 透明度；文字把状态色往正文色混，
     浅色主题 → 更深、深色主题 → 更亮，两端对比度都够 */
  color: color-mix(in oklab, var(--tsb-base) 72%, var(--text-color, #111827));
  background-color: color-mix(in oklab, var(--tsb-base) 12%, transparent);
  border-color: color-mix(in oklab, var(--tsb-base) 30%, transparent);
}

.tsb--xs {
  padding: 0.12rem 0.4rem;
  font-size: 10px;
}
.tsb--sm {
  padding: 0.2rem 0.5rem;
  font-size: 11px;
}
.tsb--md {
  padding: 0.25rem 0.6rem;
  font-size: 12px;
}

.tsb__dot {
  width: 5px;
  height: 5px;
  flex: none;
  border-radius: 999px;
  background-color: var(--tsb-base);
}

.tsb__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tsb--pulse .tsb__dot {
  animation: tsb-breathe 1.6s ease-in-out infinite;
}

/* 只用 transform/opacity，避免每帧重排 */
@keyframes tsb-breathe {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.3;
    transform: scale(0.72);
  }
}

.tsb--success {
  --tsb-base: var(--color-success, #28a745);
}
.tsb--danger {
  --tsb-base: var(--color-error, #dc3545);
}
.tsb--warning {
  --tsb-base: var(--color-warning, #d99406);
}
.tsb--info {
  --tsb-base: var(--link-active-color, #3b82f6);
}
.tsb--neutral {
  --tsb-base: var(--text-color-secondary, #6b7280);
}

@media (prefers-reduced-motion: reduce) {
  .tsb--pulse .tsb__dot {
    animation: none;
  }
}
</style>
