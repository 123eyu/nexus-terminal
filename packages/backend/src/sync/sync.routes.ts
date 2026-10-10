// packages/backend/src/sync/sync.routes.ts
import { Router } from 'express';
import { requireSyncApiKey } from './sync.middleware';
import { syncController } from './sync.controller';

const router = Router();

// 所有 /api/v1/sync 接口均要求有效的 API Key
router.use(requireSyncApiKey);

// 连通性测试握手
router.get('/ping', syncController.ping);

// 双向增量数据交换
router.post('/exchange', syncController.exchange);

export default router;
