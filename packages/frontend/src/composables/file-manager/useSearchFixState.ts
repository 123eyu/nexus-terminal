import { ref } from 'vue';

/**
 * 搜索栏「固定」状态的单例。
 *
 * 为什么放在模块级而不是每个 FileManager 实例各存一份：
 * 布局里可能同时挂多份 FileManager（侧栏 + 主区 + 弹窗），各实例各自 `ref` 的话，
 * 在一处点了固定，其它实例的按钮和搜索栏状态还是旧的 —— 表现为"点了没反应/两处不一致"。
 * 状态本来就只是一条全局偏好，所以统一收在这里。
 */

const STORAGE_KEY = 'nexus:file_manager_search_fixed';

function readInitial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // 隐私模式下 localStorage 可能不可用，当作未固定
    return false;
  }
}

export const isSearchFixed = ref<boolean>(readInitial());

export function setSearchFixed(next: boolean) {
  isSearchFixed.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch { /* 写不进去也不影响本次会话 */ }
}
