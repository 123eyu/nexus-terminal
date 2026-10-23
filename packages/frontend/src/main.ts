import { createApp } from 'vue';
import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'; 
import App from './App.vue';
import router from './router'; 
import i18n from './i18n';
import { useAuthStore } from './stores/auth.store'; 
import { useSettingsStore } from './stores/settings.store'; 
import { useAppearanceStore } from './stores/appearance.store'; 
import './style.css';
import '@fortawesome/fontawesome-free/css/all.min.css';
import 'splitpanes/dist/splitpanes.css';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import { installDebugBridge } from './debug';
import { showBootFailure, isChunkLoadError } from './utils/bootFallback';


const pinia = createPinia(); // 创建 Pinia 实例
pinia.use(piniaPluginPersistedstate); // 使用持久化插件

const app = createApp(App);

app.use(pinia); // 使用配置好的 Pinia 实例
// 开发期调试桥：捕获组件异常 / console 落盘 / 暴露 window.__NEXUS__（生产构建自动剔除）
installDebugBridge(app);

// 注意：在状态初始化完成前，暂时不 use(router)
app.use(i18n); // 使用 i18n



// --- 应用初始化逻辑 ---
// 使用 async IIFE 来允许顶层 await
(async () => {
  const authStore = useAuthStore(pinia); // 实例化 Auth Store
  // **提前实例化 AppearanceStore 以确保 immediate watcher 运行**
  const appearanceStore = useAppearanceStore(pinia);

  try {
    console.log("[main.ts] 开始检查设置和认证状态...");
    // 1. 同时检查设置和认证状态，并等待它们完成
    // 确保 checkAuthStatus 可以在 needsSetup=true 时也能安全运行并返回正确状态
    await Promise.all([
      authStore.checkSetupStatus(),
      authStore.checkAuthStatus()
    ]);
    console.log(`[main.ts] 状态检查完成: needsSetup=${authStore.needsSetup}, isAuthenticated=${authStore.isAuthenticated}`);

    // 2. 如果不需要设置且用户已认证，则加载用户特定数据
    if (!authStore.needsSetup && authStore.isAuthenticated) {
      console.log("[main.ts] 用户已认证且无需设置，加载设置和外观数据...");
      const settingsStore = useSettingsStore(pinia);
      try {
        await Promise.all([
          settingsStore.loadInitialSettings(),
          appearanceStore.loadInitialAppearanceData() // 调用已实例化的 store 的 action
        ]);
        console.log("[main.ts] 用户设置和外观数据加载完成。");
      } catch (error) {
         console.error("[main.ts] 加载用户设置或外观数据失败:", error);
         // 加载失败也继续，可能使用默认值或显示错误
      }
    } else if (authStore.needsSetup) {
        console.log("[main.ts] 需要初始设置，将由路由守卫处理重定向。");
        // 不再手动 router.push('/setup')
    } else {
        console.log("[main.ts] 用户未认证或无需设置。");
        // appearanceStore 已实例化，其 immediate watcher 会应用默认主题
    }

    // 3. 状态和数据准备就绪后，再启用路由并挂载应用
    console.log("[main.ts] 状态准备就绪，启用路由并挂载应用...");
    // 路由懒加载的 chunk 挂掉时，导航永远不会 settle：以前的表现是整页空白、控制台无输出，
    // 手机上根本看不出发生了什么。这里先接住错误，给个能重试的提示。
    router.onError((error) => {
      console.error('[main.ts] 路由加载失败:', error);
      showBootFailure(
        isChunkLoadError(error) ? '页面资源加载失败' : '页面打开失败',
        isChunkLoadError(error)
          ? '前端代码没有下载完整（弱网或缓存里的旧文件）。请检查网络后重新加载。'
          : error
      );
    });
    app.use(router); // 在这里启用路由，确保守卫能获取到最新状态
    await router.isReady(); // 等待路由初始化完成 (特别是异步路由加载)
    app.mount('#app');
    console.log("[main.ts] 应用已挂载。");

  } catch (error) {
    // 捕获初始化过程中的意外错误
    console.error("[main.ts] 应用初始化过程中发生严重错误:", error);
    // 即使发生严重错误，也尝试启用路由并挂载应用，可能显示错误页面或回退状态
    try {
      app.use(router); // 确保路由被添加
    } catch (_) {}
    try {
      await router.isReady();
    } catch (routerError) {
      console.error("[main.ts] 路由初始化失败:", routerError);
    }
    try {
      app.mount('#app');
    } catch (mountError) {
      console.error("[main.ts] 挂载失败:", mountError);
    }
    showBootFailure('应用启动失败', error);
  }
// --- PWA Service Worker Registration ---
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then(registration => {
        console.log('SW registered: ', registration);
      }).catch(registrationError => {
        console.log('SW registration failed: ', registrationError);
      });
    });
  }
})();
