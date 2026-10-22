/**
 * 传输任务状态的视觉映射
 *
 * 桌面端（TransferProgressModal）与移动端（MobileTransferProgressModal）必须共用这一份，
 * 否则两端会各写一套颜色，改一处忘一处。
 *
 * ⚠️ 不要在这里返回 Tailwind 的 `bg-green-100 text-green-700` 这类写死的浅色调：
 *    本项目没有 `.dark` 类（深色主题靠 `:root` CSS 变量整体切换），`dark:` 前缀的类永远不会生效。
 *    颜色一律走 `--color-success` / `--color-error` 这类语义变量 + `color-mix` 混向正文色，
 *    这样浅色主题下得到深色字，深色主题下得到浅色字，两端都自动成立。
 */

export type TransferTone = 'success' | 'danger' | 'warning' | 'info' | 'neutral';

/** 任务/子任务状态 → 视觉色调 */
export function resolveTransferTone(status?: string | null): TransferTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'partially-completed':
      return 'warning';
    case 'queued':
    case 'cancelling':
      return 'warning';
    case 'in-progress':
    case 'transferring':
    case 'connecting':
      return 'info';
    case 'cancelled':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** 还在跑（含排队/取消中）—— 用于决定要不要显示呼吸点、旋转图标 */
export function isBusyTransferStatus(status?: string | null): boolean {
  return ['queued', 'in-progress', 'connecting', 'transferring', 'cancelling'].includes(status || '');
}

/** 已进入终态（不会再变） */
export function isFinalTransferStatus(status?: string | null): boolean {
  return ['completed', 'failed', 'cancelled', 'partially-completed'].includes(status || '');
}
