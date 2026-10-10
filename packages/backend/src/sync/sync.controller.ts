// packages/backend/src/sync/sync.controller.ts
import { Request, Response } from 'express';
import { syncService } from './sync.service';

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
