import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { isAuthenticated } from '../auth/auth.middleware';
import { dataTransferController } from './data-transfer.controller';

const router = express.Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
});

router.use(isAuthenticated);

router.get('/datasets', dataTransferController.listAvailableDatasets);
router.post('/export', dataTransferController.exportData);

router.post(
    '/analyze',
    (req: Request, res: Response, next: NextFunction) => {
        upload.single('file')(req, res, (err: any) => {
            if (err instanceof multer.MulterError) {
                const message =
                    err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : `UPLOAD_FAILED: ${err.code}`;
                return res.status(400).json({ message });
            }
            if (err) {
                console.error('[数据导入] 上传失败:', err);
                return res.status(500).json({ message: 'UPLOAD_FAILED' });
            }
            next();
        });
    },
    dataTransferController.analyzeImport
);

router.post('/import', dataTransferController.runImport);

export default router;
