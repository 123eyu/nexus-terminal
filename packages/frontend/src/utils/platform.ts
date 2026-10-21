// packages/frontend/src/utils/platform.ts
/**
 * 平台环境与功能开关工具模块
 * 用于在保留底层功能完整性的前提下，对桌面端/移动端/Web 端提供轻量级显示与能力控制。
 */

/**
 * 判断当前是否运行在桌面客户端 (Tauri WebView) 环境
 */
export function isDesktopApp(): boolean {
  if (typeof window === 'undefined') return false;

  // 1. 原生 Tauri 运行时探测 (桌面独立客户端最严格、绝对可靠的判定基准)
  const isTauri = Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
  if (isTauri) {
    return true;
  }

  // 2. 显式 URL 调试参数 (仅供本地开发调试时单次模拟桌面视图，不污染全局持久状态)
  try {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('platform') === 'desktop') {
      return true;
    }
  } catch {}

  // 3. 普通浏览器 / Web 部署环境下，主动清理历史测试可能残留的 localStorage 污染
  try {
    if (localStorage.getItem('is_desktop_client')) {
      localStorage.removeItem('is_desktop_client');
    }
    if (sessionStorage.getItem('is_desktop_client')) {
      sessionStorage.removeItem('is_desktop_client');
    }
    if (document.documentElement.dataset.platform === 'desktop') {
      delete document.documentElement.dataset.platform;
    }
  } catch {}

  return false;
}

/**
 * 检查当前运行环境是否支持 RDP / VNC 图形远程桌面功能
 * 说明：
 * 改造后 RDP 由浏览器内的 IronRDP(WASM) 说协议、VNC 由 noVNC 说协议，
 * 后端只做 RDCleanPath 代理 / TCP 字节桥，不再依赖 guacd、websockify 等外部容器。
 * 因此 Web、Docker 单容器、桌面端（自带后端 sidecar）三处能力完全一致，全部开启。
 */
export function isRemoteDesktopSupported(): boolean {
  return true;
}
