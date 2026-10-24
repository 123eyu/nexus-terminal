import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * 跨主机拖拽传输的右下角小窗（`TransferMiniPanel.vue`）。
 *
 * 为什么不复用「传输进度」大弹窗：每次往另一个 VPS 拖一个文件都要盖住半个屏幕，
 * 而这类操作通常只是顺手一拖，用户随后还要继续在文件管理器里干活。
 *
 * 三种状态由本 store 与面板共同维护：
 *  - `visible`   —— 面板是否挂载（false 即销毁，轮询也随之停掉）
 *  - `collapsed` —— 只留一行标题，不占屏幕
 *  - `batchStartedAt` —— 本批任务的起点。同一批里连续拖多个文件只累加，不重开时间窗；
 *    上一批已经全部静止时再拖，则视为新的一批，旧任务不再显示。
 */
export const useTransferMiniPanelStore = defineStore('transferMiniPanel', () => {
  const visible = ref(false);
  const collapsed = ref(false);

  /** 本批任务的时间窗起点（毫秒）。比真实时刻略早一点，兼容服务端时钟略慢。 */
  const batchStartedAt = ref(0);

  /** 由面板回报：本批已无进行中、也无失败 —— 用来决定下一次拖拽是否另起一批 */
  const batchIdle = ref(true);

  const open = () => {
    if (!visible.value || batchIdle.value) {
      batchStartedAt.value = Date.now() - 2000;
      batchIdle.value = false;
    }
    visible.value = true;
    collapsed.value = false;
  };

  const close = () => {
    visible.value = false;
    collapsed.value = false;
    batchIdle.value = true;
  };

  const toggleCollapsed = () => {
    collapsed.value = !collapsed.value;
  };

  const reportIdle = (idle: boolean) => {
    batchIdle.value = idle;
  };

  return { visible, collapsed, batchStartedAt, batchIdle, open, close, toggleCollapsed, reportIdle };
});
