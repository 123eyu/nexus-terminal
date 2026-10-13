import { Router } from 'express';
import { isAuthenticated } from '../auth/auth.middleware';
import * as controller from './file-color-highlights.controller';

const router = Router({ mergeParams: true });

router.use(isAuthenticated);

router.get('/', controller.getHighlights);
router.post('/', controller.setHighlight);
router.delete('/', controller.removeHighlight);

export default router;
