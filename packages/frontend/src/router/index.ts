import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '../stores/auth.store'; // 导入 Auth Store
import { isDesktopApp } from '../utils/platform';
import apiClient from '../utils/apiClient';

// 路由配置
const routes: Array<RouteRecordRaw> = [
  // 首页/仪表盘 (占位符)
  {
    path: '/',
    name: 'Dashboard',
    component: () => import('../views/DashboardView.vue') // 指向实际的仪表盘组件
    // component: { template: '<div>仪表盘 (建设中)</div>' } // 移除临时占位
  },
  // 登录页面 (占位符)
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/LoginView.vue') // 指向实际的登录组件
  },
  // 代理管理页面
  {
    path: '/proxies',
    name: 'Proxies',
     component: () => import('../views/ProxiesView.vue')
   },
   // 连接管理页面
   {
     path: '/connections',
     name: 'Connections',
     component: () => import('../views/ConnectionsView.vue')
   },
    // 快捷指令管理页面
    {
      path: '/quick-commands',
      name: 'QuickCommands',
      component: () => import('../views/QuickCommandsManagementView.vue')
    },
   // 移除：标签管理页面路由
   // {
   //   path: '/tags',
   //   name: 'Tags',
   //   component: () => import('../views/TagsView.vue')
   // },
   // 工作区页面 (不再需要 connectionId 参数)
   {
    path: '/workspace', // 移除动态路由段
    name: 'Workspace',
    component: () => import('../views/WorkspaceView.vue'),
    // props: true // 不再需要传递 props
  },
  // 设置页面
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('../views/SettingsView.vue')
  },
  // 通知管理页面
  {
    path: '/notifications',
    name: 'Notifications',
    component: () => import('../views/NotificationsView.vue')
  },
  // 审计日志页面
  {
    path: '/audit-logs',
    name: 'AuditLogs',
    component: () => import('../views/AuditLogView.vue')
  },
  // 初始设置页面
  {
    path: '/setup',
    name: 'Setup',
    component: () => import('../views/SetupView.vue')
  },
  // 其他路由...
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL), // 使用 HTML5 History 模式
  routes,
});

const LAST_ROUTE_KEY = 'nexus_last_route';
const REMEMBER_ROUTE_KEY = 'nexus_remember_last_route';

function isRouteMemoryEnabled(): boolean {
  try {
    return localStorage.getItem(REMEMBER_ROUTE_KEY) !== 'false';
  } catch (_) {
    return true;
  }
}

// 添加全局前置守卫
router.beforeEach((to, from, next) => {
  // 在守卫内部获取 store 实例，确保 Pinia 已初始化
  const authStore = useAuthStore();

  const publicRoutes = ['Login', 'Setup'];
  const requiresAuth = !publicRoutes.includes(to.name as string);
  const needsSetup = authStore.needsSetup;

  if (needsSetup && to.name !== 'Setup') {
    // 如果需要设置，但目标不是设置页面，则强制重定向到设置页面
    console.log('路由守卫：需要初始设置，重定向到 /setup');
    next({ name: 'Setup' });
  } else if (!needsSetup && to.name === 'Setup') {
     // 如果不需要设置，但尝试访问设置页面，重定向到登录页或首页
     console.log('路由守卫：不需要设置，从 /setup 重定向');
     next(authStore.isAuthenticated ? { name: 'Dashboard' } : { name: 'Login' });
  } else if (requiresAuth && !authStore.isAuthenticated && !needsSetup) {
    // 如果需要认证、用户未登录且不需要设置，重定向到登录页并记录目标
    console.log('路由守卫：未登录，重定向到 /login');
    next({ name: 'Login', query: { redirect: to.fullPath } });
  } else if (to.name === 'Login' && authStore.isAuthenticated && !needsSetup) {
    // 如果用户已登录、不需要设置且尝试访问登录页，重定向到上次停留页面或仪表盘
    const lastRoute = localStorage.getItem(LAST_ROUTE_KEY);
    const target = (lastRoute && lastRoute !== '/' && !lastRoute.includes('/login') && !lastRoute.includes('/setup'))
      ? lastRoute
      : { name: 'Dashboard' };
    console.log('路由守卫：已登录，从 /login 重定向到', target);
    next(target);
  } else if (authStore.isAuthenticated && !needsSetup && (to.name === 'Dashboard' || to.path === '/') && from.matched.length === 0) {
    // 如果用户关闭了“记住上次停留页面”，直接放行进入默认首页
    if (!isRouteMemoryEnabled()) {
      next();
      return;
    }
    // 核心冷启动直达：如果是首次加载进入根路径且已登录，优先直接进入上次记录的页面！
    let targetRoute = localStorage.getItem(LAST_ROUTE_KEY);
    // 桌面端未记忆时默认直达工作区 /workspace
    if (!targetRoute && isDesktopApp()) {
      targetRoute = '/workspace';
    }
    if (targetRoute && targetRoute !== '/' && !targetRoute.includes('/login') && !targetRoute.includes('/setup')) {
      console.log(`[Router] 冷启动记忆直达目标页面: ${targetRoute}`);
      next(targetRoute);
      return;
    }
    next();
  } else {
    // 其他情况（例如访问公共页面，或已登录访问需认证页面）允许导航
    next();
  }
});

// 全局后置钩子：持久化记忆用户停留的有效业务页面
router.afterEach((to) => {
  const ignoreRoutes = ['Login', 'Setup'];
  if (!isRouteMemoryEnabled()) {
    try {
      localStorage.removeItem(LAST_ROUTE_KEY);
    } catch (_) {}
    return;
  }
  if (to.name && !ignoreRoutes.includes(to.name as string)) {
    try {
      localStorage.setItem(LAST_ROUTE_KEY, to.fullPath);
    } catch (_) {}

    // 桌面端环境：静默上报当前路由至本地桌面配置文件 desktop-settings.json
    try {
      if (isDesktopApp()) {
        apiClient.post('/desktop/route', { route: to.fullPath }).catch(() => {});
      }
    } catch (_) {}
  }
});

export default router;
