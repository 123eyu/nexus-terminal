import express from 'express';
import * as QuickCommandFolderController from './quick-command-folder.controller';
import { isAuthenticated } from '../auth/auth.middleware'; // 假设需要认证

const router = express.Router();

// 获取所有快捷指令文件夹
router.get('/', isAuthenticated, QuickCommandFolderController.getAllQuickCommandFolders);

// 添加新的快捷指令文件夹
router.post('/', isAuthenticated, QuickCommandFolderController.addQuickCommandFolder);

// 更新快捷指令文件夹
router.put('/:id', isAuthenticated, QuickCommandFolderController.updateQuickCommandFolder);

// 删除快捷指令文件夹
router.delete('/:id', isAuthenticated, QuickCommandFolderController.deleteQuickCommandFolder);

export default router;