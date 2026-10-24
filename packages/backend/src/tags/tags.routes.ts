import { Router } from 'express';
import { isAuthenticated } from '../auth/auth.middleware'; 
import {
    createTag,
    getTags,
    getTagById,
    updateTag,
    deleteTag,
    updateTagConnections // +++ 导入新的控制器方法 +++
} from './tags.controller';

const router = Router();

// 应用认证中间件到所有文件夹路由
router.use(isAuthenticated);

// 定义文件夹相关的路由
router.post('/', createTag);       // POST /api/v1/tags - 创建新文件夹
router.get('/', getTags);         // GET /api/v1/tags - 获取文件夹列表
router.get('/:id', getTagById);   // GET /api/v1/tags/:id - 获取单个文件夹
router.put('/:id', updateTag);     // PUT /api/v1/tags/:id - 更新文件夹
router.delete('/:id', deleteTag); // DELETE /api/v1/tags/:id - 删除文件夹
router.put('/:id/connections', updateTagConnections); // PUT /api/v1/tags/:id/connections - 更新文件夹的连接关联

export default router;
