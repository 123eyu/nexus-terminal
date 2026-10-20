import { Router } from 'express';
import { isAuthenticated } from '../auth/auth.middleware';
import { downloadFile, downloadDirectory, prepareExternalOpen, resolveExternalOpen } from './sftp.controller'; // +++ 导入 downloadDirectory +++

const router = Router();

// 应用认证中间件
router.use(isAuthenticated);

// GET /api/v1/sftp/download?connectionId=...&remotePath=...
router.get('/download', downloadFile);

// +++ GET /api/v1/sftp/download-directory?connectionId=...&remotePath=... +++
router.get('/download-directory', downloadDirectory);

// POST /api/v1/sftp/open-external —— 桌面端"用外部程序打开"：把远程文件落到本地临时目录，返回本地路径
router.post('/open-external', prepareExternalOpen);

// POST /api/v1/sftp/open-external/resolve —— 回传冲突的用户决议（覆盖远程 / 放弃本地改动）
router.post('/open-external/resolve', resolveExternalOpen);


export default router;
