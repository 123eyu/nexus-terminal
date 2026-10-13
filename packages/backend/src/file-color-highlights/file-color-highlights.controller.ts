import { Request, Response } from 'express';
import * as service from './file-color-highlights.service';

const parseConnectionId = (req: Request): number => {
  const raw = req.params.connectionId || (req.query.connectionId as string) || req.body?.connectionId;
  return parseInt(String(raw), 10);
};

/**
 * 获取连接的所有文件高亮配置
 */
export const getHighlights = async (req: Request, res: Response): Promise<void> => {
  const connectionId = parseConnectionId(req);
  if (isNaN(connectionId)) {
    res.status(400).json({ success: false, message: '无效的 connectionId' });
    return;
  }

  try {
    const highlights = await service.getHighlightsMap(connectionId);
    res.json({ success: true, data: highlights });
  } catch (error: any) {
    console.error(`[Controller] 获取连接 ${connectionId} 的文件高亮失败:`, error.message);
    res.status(500).json({ success: false, message: '获取文件高亮失败' });
  }
};

/**
 * 设置或更新文件高亮配置
 */
export const setHighlight = async (req: Request, res: Response): Promise<void> => {
  const connectionId = parseConnectionId(req);
  if (isNaN(connectionId)) {
    res.status(400).json({ success: false, message: '无效的 connectionId' });
    return;
  }

  const { path, color } = req.body;
  if (!path || typeof path !== 'string') {
    res.status(400).json({ success: false, message: '缺少有效的 path 参数' });
    return;
  }
  if (!color || typeof color !== 'string') {
    res.status(400).json({ success: false, message: '缺少有效的 color 参数' });
    return;
  }

  try {
    const record = await service.setHighlight(connectionId, path, color);
    res.json({ success: true, data: record });
  } catch (error: any) {
    console.error(`[Controller] 设置连接 ${connectionId} 路径 ${path} 高亮失败:`, error.message);
    res.status(500).json({ success: false, message: error.message || '设置文件高亮失败' });
  }
};

/**
 * 删除文件高亮配置
 */
export const removeHighlight = async (req: Request, res: Response): Promise<void> => {
  const connectionId = parseConnectionId(req);
  if (isNaN(connectionId)) {
    res.status(400).json({ success: false, message: '无效的 connectionId' });
    return;
  }

  const targetPath = (req.query.path as string) || req.body?.path;
  if (!targetPath || typeof targetPath !== 'string') {
    res.status(400).json({ success: false, message: '缺少有效的 path 参数' });
    return;
  }

  try {
    const deleted = await service.removeHighlight(connectionId, targetPath);
    res.json({ success: true, data: { deleted } });
  } catch (error: any) {
    console.error(`[Controller] 删除连接 ${connectionId} 路径 ${targetPath} 高亮失败:`, error.message);
    res.status(500).json({ success: false, message: error.message || '删除文件高亮失败' });
  }
};
