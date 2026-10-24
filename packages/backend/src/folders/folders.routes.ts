import { Router } from 'express';
import { isAuthenticated } from '../auth/auth.middleware'; 
import {
    createFolder,
    getFolders,
    getFolderById,
    updateFolder,
    deleteFolder,
    updateFolderConnections // +++ 导入新的控制器方法 +++
} from './folders.controller';

const router = Router();

// 应用认证中间件到所有文件夹路由
router.use(isAuthenticated);

// 定义文件夹相关的路由
router.post('/', createFolder);       // POST /api/v1/folders - 创建新文件夹
router.get('/', getFolders);         // GET /api/v1/folders - 获取文件夹列表
router.get('/:id', getFolderById);   // GET /api/v1/folders/:id - 获取单个文件夹
router.put('/:id', updateFolder);     // PUT /api/v1/folders/:id - 更新文件夹
router.delete('/:id', deleteFolder); // DELETE /api/v1/folders/:id - 删除文件夹
router.put('/:id/connections', updateFolderConnections); // PUT /api/v1/folders/:id/connections - 更新文件夹的连接关联

export default router;
