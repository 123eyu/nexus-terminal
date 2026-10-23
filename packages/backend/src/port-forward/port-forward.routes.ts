import { Router } from 'express';
import * as Controller from './port-forward.controller';
import { isAuthenticated } from '../auth/auth.middleware';

const router = Router();

router.use(isAuthenticated);

// 规则按连接绑定：列表 / 新增都要带 connectionId
router.get('/', Controller.list);
router.post('/', Controller.create);
// 改动规则后会自动重启，避免监听留在旧端口上
router.put('/:id', Controller.update);
router.delete('/:id', Controller.remove);
// 启停：start 会把 auto_start 置 1（下次启动自动恢复），stop 置 0
router.post('/:id/start', Controller.start);
router.post('/:id/stop', Controller.stop);
router.get('/status', Controller.status);

export default router;
