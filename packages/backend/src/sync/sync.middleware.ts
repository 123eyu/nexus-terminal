// packages/backend/src/sync/sync.middleware.ts
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { settingsRepository } from '../settings/settings.repository';

/**
 * 恒定时间字符串比较，防止时序侧信道攻击
 */
function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 获取服务端配置的有效 API Key
 * 优先级：环境变量 SYNC_API_KEY > 数据库 settings.syncApiKey
 */
export async function getServerSyncApiKey(): Promise<string | null> {
  const envKey = process.env.SYNC_API_KEY?.trim();
  if (envKey) return envKey;

  try {
    const settingValue = await settingsRepository.getSetting('syncApiKey');
    if (settingValue && settingValue.trim() !== '') {
      return settingValue.trim();
    }
  } catch (err) {
    console.warn('[SyncMiddleware] 读取 syncApiKey 设置失败:', err);
  }

  return null;
}

/**
 * 验证云端同步请求的 API Key 中间件
 */
export async function requireSyncApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const clientKey = (req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '')) as string | undefined;

  if (!clientKey || typeof clientKey !== 'string' || clientKey.trim() === '') {
    res.status(401).json({
      success: false,
      error: '缺少 API Key 认证凭据，请在请求头提供 X-API-Key'
    });
    return;
  }

  const serverKey = await getServerSyncApiKey();

  if (!serverKey) {
    res.status(403).json({
      success: false,
      error: '服务端尚未开启或配置同步 API 密钥 (未设置 SYNC_API_KEY)'
    });
    return;
  }

  if (!safeCompare(clientKey.trim(), serverKey)) {
    res.status(401).json({
      success: false,
      error: 'API Key 无效或不匹配，认证失败'
    });
    return;
  }

  next();
}
