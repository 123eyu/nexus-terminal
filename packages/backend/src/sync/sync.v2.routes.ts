// packages/backend/src/sync/sync.v2.routes.ts
import { Router } from 'express';
import { requireSyncApiKey } from './sync.middleware';
import { syncV2Controller } from './sync.v2.controller';

const router = Router();

// /api/sync/v2 所有接口均要求有效的 API Key / Device Token
router.use(requireSyncApiKey);

router.post('/push', syncV2Controller.push);
router.get('/pull', syncV2Controller.pull);
router.get('/snapshot', syncV2Controller.snapshot);
router.get('/events', syncV2Controller.events);

export default router;
