// packages/backend/src/sync/sync.controller.ts
import { Request, Response } from 'express';
import { syncService } from './sync.service';
import { notifyLocalFrontendSyncDone } from './sync.ws-broadcaster';

export const syncController = {
  /**
   * 客户端握手测试连通性
   */
  async ping(req: Request, res: Response): Promise<void> {
    try {
      res.json({
        success: true,
        message: 'Pong',
        serverTime: Date.now(),
        version: '0.9.4',
        instanceName: process.env.INSTANCE_NAME || 'Nexus VPS Cloud'
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  },

  /**
   * 双向增量数据交换接口
   */
  async exchange(req: Request, res: Response): Promise<void> {
    try {
      const payload = req.body;
      const apiKey = (req.headers['x-api-key'] as string) || (req.query.apiKey as string) || '';
      const result = await syncService.processExchange(payload, apiKey);
      res.json({
        success: true,
        data: result
      });

      // 关键：另一端（如桌面端）推送过来的数据已经落库，
      // 但本机打开的浏览器页面不会自己知道 —— 必须主动通知它们重载 Store。
      // 否则"桌面端新建的布局 / 绑定关系"要等用户手动刷新网页才看得见。
      try {
        notifyLocalFrontendSyncDone({
          pushed: result?.stats?.pushed || 0,
          pulled: result?.stats?.pulled || 0
        });
      } catch (notifyErr: any) {
        console.warn('[SyncController] 通知前端刷新失败:', notifyErr?.message);
      }
    } catch (err: any) {
      console.error('[SyncController] 交换数据失败:', err);
      res.status(500).json({
        success: false,
        error: '云端同步数据合并失败',
        details: err.message
      });
    }
  }
};
