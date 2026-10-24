import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { getDataDir } from '../services/storage-path.service';
import { syncService, type SyncModuleKey } from '../sync/sync.service';
import { syncV2Service } from '../sync/sync.v2.service';
import { syncThrottleScheduler } from '../sync/sync.scheduler';
import { syncWsClient } from '../sync/sync.ws-client';
import { resolveSyncItems } from '../sync/sync.items';

import { settingsRepository } from './settings.repository';

const router = Router();



export interface WindowState {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

export interface DesktopSettings {
  closeBehavior?: 'minimize_to_tray' | 'quit';
  rememberCloseChoice?: boolean;
  windowState?: WindowState;
  lastRoute?: string;
  syncMode?: 'bidirectional' | 'cloud_to_local' | 'local_to_cloud';
  [key: string]: any;
}

function getSettingsFilePath(): string {
  return path.join(getDataDir(), 'desktop-settings.json');
}

function readDesktopSettings(): DesktopSettings {
  const filePath = getSettingsFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[DesktopSettings] 读取 desktop-settings.json 失败:', err);
  }
  return {
    closeBehavior: 'minimize_to_tray',
    rememberCloseChoice: false,
  };
}

function writeDesktopSettings(settings: DesktopSettings): void {
  const filePath = getSettingsFilePath();
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * 获取桌面客户端配置
 */
router.get('/settings', (req: Request, res: Response) => {
  const settings = readDesktopSettings();
  if (!settings.closeBehavior) {
    settings.closeBehavior = 'minimize_to_tray';
  }
  if (typeof settings.rememberCloseChoice !== 'boolean') {
    settings.rememberCloseChoice = false;
  }
  res.json(settings);
});

/**
 * 更新桌面客户端配置
 */
router.put('/settings', (req: Request, res: Response): void => {
  const { closeBehavior, rememberCloseChoice, windowState, actionToExecute } = req.body;
  if (closeBehavior && !['minimize_to_tray', 'quit'].includes(closeBehavior)) {
    res.status(400).json({ error: '无效的 closeBehavior 参数，仅支持 minimize_to_tray 或 quit' });
    return;
  }

  const current = readDesktopSettings();
  const updated: DesktopSettings = {
    ...current,
    closeBehavior: closeBehavior !== undefined ? closeBehavior : (current.closeBehavior || 'minimize_to_tray'),
    rememberCloseChoice: typeof rememberCloseChoice === 'boolean' ? rememberCloseChoice : (current.rememberCloseChoice || false),
  };

  if (actionToExecute) {
    updated.actionToExecute = actionToExecute;
  }

  if (windowState && typeof windowState === 'object') {
    updated.windowState = {
      ...current.windowState,
      ...windowState,
    };
  }

  try {
    writeDesktopSettings(updated);
    res.json({ success: true, settings: updated });
  } catch (err: any) {
    console.error('[DesktopSettings] 保存 desktop-settings.json 失败:', err);
    res.status(500).json({ error: '保存配置失败', details: err.message });
  }
});

/**
 * 记录用户当前停留的路由页面 (用于桌面端下次启动直达，传入空字符串或clear可清除)
 */
router.post('/route', (req: Request, res: Response): void => {
  const { route, clear, enabled } = req.body;
  const current = readDesktopSettings();
  if (typeof enabled === 'boolean') {
    current.rememberLastRoute = enabled;
  }
  if (clear || route === '' || route === null || enabled === false) {
    delete current.lastRoute;
    current.rememberLastRoute = false;
    try {
      writeDesktopSettings(current);
      console.log('🧹 [DesktopSettings] 已清空桌面端上次停留路由并标记关闭记忆');
    } catch (err) {
      console.warn('[DesktopSettings] 清空上次停留路由失败:', err);
    }
  } else if (typeof route === 'string' && route.trim().length > 0) {
    const trimmed = route.trim();
    if (!trimmed.includes('/login') && !trimmed.includes('/setup')) {
      current.lastRoute = trimmed;
      current.rememberLastRoute = true;
      try {
        writeDesktopSettings(current);
      } catch (err) {
        console.warn('[DesktopSettings] 记录上次停留路由失败:', err);
      }
    }
  }
  res.json({ success: true });
});

/**
 * 退出应用程序接口 (由前端触发彻底关闭)
 */
router.post('/exit', (req: Request, res: Response): void => {
  res.json({ success: true, message: '正在退出桌面端应用...' });
  setTimeout(() => {
    console.log('🚪 [DesktopSettings] 收到前端退出请求，正在终止后端服务...');
    process.exit(0);
  }, 100);
});

// ==========================================
// 桌面端专属：VPS 云端数据同步本地接口
// ==========================================

/**

 * 获取桌面端云端同步配置
 */
router.get('/sync/config', (req: Request, res: Response): void => {
  const settings = readDesktopSettings();
  res.json({
    success: true,
    config: {
      vpsUrl: settings.syncVpsUrl || '',
      apiKey: settings.syncApiKey || '',
      conflictStrategy: settings.syncConflictStrategy || 'lww',
      syncMode: settings.syncMode || 'bidirectional',
      lastSyncTime: settings.syncLastTime || 0,
      autoSyncOnOpen: settings.syncAutoOnOpen ?? false
    }
  });
});

/**
 * 保存桌面端云端同步配置
 */
router.post('/sync/config', (req: Request, res: Response): void => {
  const { vpsUrl, apiKey, conflictStrategy, autoSyncOnOpen, syncMode } = req.body;
  const current = readDesktopSettings();
  const updated: DesktopSettings = {
    ...current,
    syncVpsUrl: vpsUrl !== undefined ? String(vpsUrl).trim() : current.syncVpsUrl,
    syncApiKey: apiKey !== undefined ? String(apiKey).trim() : current.syncApiKey,
    syncConflictStrategy: conflictStrategy || current.syncConflictStrategy || 'lww',
    syncMode: syncMode || current.syncMode || 'bidirectional',
    syncAutoOnOpen: typeof autoSyncOnOpen === 'boolean' ? autoSyncOnOpen : current.syncAutoOnOpen
  };

  try {
    writeDesktopSettings(updated);
    if (updated.syncVpsUrl && updated.syncApiKey) {
      void settingsRepository.setSetting(
        'desktop_sync_config',
        JSON.stringify({ vpsUrl: updated.syncVpsUrl, apiKey: updated.syncApiKey })
      );
      syncThrottleScheduler.notifyChange();
      void syncWsClient.restart();
    }
    res.json({ success: true, message: '云端同步配置已保存', config: updated });
  } catch (err: any) {

    res.status(500).json({ success: false, error: '保存配置失败', details: err.message });
  }
});

/**
 * 测试与 VPS 云端服务器的连通性
 */
router.post('/sync/test', async (req: Request, res: Response): Promise<void> => {
  try {
    const { vpsUrl, apiKey } = req.body;
    const settings = readDesktopSettings();
    const targetUrl = (vpsUrl || settings.syncVpsUrl || '').trim();
    const targetApiKey = (apiKey || settings.syncApiKey || '').trim();

    if (!targetUrl) {
      res.status(400).json({ success: false, error: '请输入 VPS 服务器地址' });
      return;
    }
    if (!targetApiKey) {
      res.status(400).json({ success: false, error: '请输入同步 API Key' });
      return;
    }

    const testResult = await syncService.testRemoteConnection(targetUrl, targetApiKey);
    res.json({
      success: true,
      latencyMs: testResult.latencyMs,
      serverInfo: testResult.data
    });
  } catch (err: any) {
    console.warn('[DesktopSync] 连通性测试失败:', err.message);
    res.status(502).json({
      success: false,
      error: `无法连接到 VPS 服务器: ${err.message}`
    });
  }
});

/**
 * 触发一次全量双向增量同步或按需模块同步
 */
router.post('/sync/trigger', async (req: Request, res: Response): Promise<void> => {
  try {
    const settings = readDesktopSettings();
    const vpsUrl = (req.body.vpsUrl || settings.syncVpsUrl || '').trim();
    const apiKey = (req.body.apiKey || settings.syncApiKey || '').trim();

    if (!vpsUrl || !apiKey) {
      res.status(400).json({
        success: false,
        error: '未配置 VPS 域名或 API Key，无法执行同步'
      });
      return;
    }

    const lastSyncTime = settings.syncLastTime || 0;
    const mode = req.body.mode || 'bidirectional';
    const modules = Array.isArray(req.body.modules)
      ? (req.body.modules.filter((m: unknown) => typeof m === 'string') as SyncModuleKey[])
      : undefined;

    // 同步范围（细项）发生变化时要退游标，否则「关掉的子项」期间的变更永久错过，
    // 重新勾上也得等下一次全量快照才会有数据。
    // 只比「新增了哪些子项」——收窄范围不需要重对齐，那样只是白跑一轮。
    const nextItems = [...resolveSyncItems(modules)];
    const prevItems = Array.isArray(settings.syncItems) ? (settings.syncItems as string[]) : null;
    if (prevItems && nextItems.some(item => !prevItems.includes(item))) {
      await syncV2Service.resetSyncCursors();
    }
    settings.syncItems = nextItems;

    const result = await syncService.triggerClientSync(vpsUrl, apiKey, lastSyncTime, mode, modules);

    // 同步成功，更新本地最后同步时间戳与当前同步模式偏好
    settings.syncLastTime = result.serverTime;
    if (req.body.mode) {
      settings.syncMode = req.body.mode;
    }
    writeDesktopSettings(settings);

    // 双向合并时协同执行 v2 增量游标同步。
    // 以前这里要求「未指定模块」才跑，而前端每次都会带上所选模块（默认全选 5 个），
    // 结果手动「立即同步」永远只走 v1（秒级 LWW），自动同步却走 v2（HLC），
    // 两套判定互相打架，最容易出现「同步完刷新又变回去」。
    // 现在：双向模式下都跑 v2，并把它收到的同步范围一并带下去，
    // 让 v1 / v2 两条通路对「哪些子项要同步」保持同一套判断。
    if (mode === 'bidirectional') {
      try {
        const v2Stats = await syncV2Service.executeSyncCycle(vpsUrl, apiKey, apiKey, modules);
        result.stats.pushed += v2Stats.pushed;
        result.stats.pulled += v2Stats.pulled;
      } catch (v2Err: any) {
        console.warn('[DesktopSync] 协同 v2 增量同步告警:', v2Err.message);
      }
    }

    res.json({
      success: true,
      message: '数据同步成功',
      lastSyncTime: result.serverTime,
      stats: result.stats
    });

  } catch (err: any) {
    console.error('[DesktopSync] 执行同步失败:', err);
    res.status(500).json({
      success: false,
      error: `数据同步执行失败: ${err.message}`
    });
  }
});

export default router;
