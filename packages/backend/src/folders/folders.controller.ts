import { Request, Response } from 'express';
import * as FolderService from './folder.service';
import { AuditLogService } from '../audit/audit.service';

const auditLogService = new AuditLogService();

/**
 * 创建新文件夹 (POST /api/v1/folders)
 */
export const createFolder = async (req: Request, res: Response): Promise<void> => {
    const { name, background_color } = req.body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
        res.status(400).json({ message: '文件夹名称不能为空。' });
        return;
    }

    try {
        const newFolder = await FolderService.createFolder(name, background_color);
        // 记录审计日志
        auditLogService.logAction('FOLDER_CREATED', { folderId: newFolder.id, name: newFolder.name, background_color: newFolder.background_color });
        res.status(201).json({ message: '文件夹创建成功。', folder: newFolder });
    } catch (error: any) {
        console.error('Controller: 创建文件夹时发生错误:', error);
        if (error.message.includes('已存在')) {
            res.status(409).json({ message: error.message }); 
        } else {
            res.status(500).json({ message: error.message || '创建文件夹时发生内部服务器错误。' });
        }
    }
};

/**
 * 获取文件夹列表 (GET /api/v1/folders)
 */
export const getFolders = async (req: Request, res: Response): Promise<void> => {
    try {
        const folders = await FolderService.getAllFolders();
        res.status(200).json(folders);
    } catch (error: any) {
        console.error('Controller: 获取文件夹列表时发生错误:', error);
        res.status(500).json({ message: error.message || '获取文件夹列表时发生内部服务器错误。' });
    }
};

/**
 * 获取单个文件夹信息 (GET /api/v1/folders/:id)
 */
export const getFolderById = async (req: Request, res: Response): Promise<void> => {
    const folderId = parseInt(req.params.id, 10);

    if (isNaN(folderId)) {
        res.status(400).json({ message: '无效的文件夹 ID。' });
        return;
    }

    try {
        const folder = await FolderService.getFolderById(folderId);
        if (!folder) {
            res.status(404).json({ message: '文件夹未找到。' });
        } else {
            res.status(200).json(folder);
        }
    } catch (error: any) {
        console.error(`Controller: 获取文件夹 ${folderId} 时发生错误:`, error);
        res.status(500).json({ message: error.message || '获取文件夹信息时发生内部服务器错误。' });
    }
};

/**
 * 更新文件夹信息 (PUT /api/v1/folders/:id)
 */
export const updateFolder = async (req: Request, res: Response): Promise<void> => {
    const folderId = parseInt(req.params.id, 10);
    const { name, background_color } = req.body;

    if (isNaN(folderId)) {
        res.status(400).json({ message: '无效的文件夹 ID。' });
        return;
    }
    if (typeof name !== 'undefined' && (typeof name !== 'string' || name.trim() === '')) {
        res.status(400).json({ message: '文件夹名称不能为空。' });
        return;
    }

    try {
        const updatedFolder = await FolderService.updateFolder(folderId, name, background_color);
        if (!updatedFolder) {
            res.status(404).json({ message: '文件夹未找到。' });
        } else {
            // 记录审计日志
            auditLogService.logAction('FOLDER_UPDATED', { folderId, newName: name, background_color: updatedFolder.background_color });
            res.status(200).json({ message: '文件夹更新成功。', folder: updatedFolder });
        }
    } catch (error: any) {
        console.error(`Controller: 更新文件夹 ${folderId} 时发生错误:`, error);
         if (error.message.includes('已存在')) {
            res.status(409).json({ message: error.message });
        } else if (error.message.includes('不能为空')) {
             res.status(400).json({ message: error.message });
        }
        else {
            res.status(500).json({ message: error.message || '更新文件夹时发生内部服务器错误。' });
        }
    }
};

/**
 * 删除文件夹 (DELETE /api/v1/folders/:id)
 */
export const deleteFolder = async (req: Request, res: Response): Promise<void> => {
    const folderId = parseInt(req.params.id, 10);

    if (isNaN(folderId)) {
        res.status(400).json({ message: '无效的文件夹 ID。' });
        return;
    }

    try {
        const deleted = await FolderService.deleteFolder(folderId);
        if (!deleted) {
            res.status(404).json({ message: '文件夹未找到。' });
        } else {
            // 记录审计日志
            auditLogService.logAction('FOLDER_DELETED', { folderId });
            res.status(200).json({ message: '文件夹删除成功。' });
        }
    } catch (error: any) {
        console.error(`Controller: 删除文件夹 ${folderId} 时发生错误:`, error);
        res.status(500).json({ message: error.message || '删除文件夹时发生内部服务器错误。' });
    }
};

/**
 * 更新文件夹与连接的关联关系 (PUT /api/v1/folders/:id/connections)
 */
export const updateFolderConnections = async (req: Request, res: Response): Promise<void> => {
    const folderId = parseInt(req.params.id, 10);
    const { connection_ids } = req.body; // 前端发送的是 connection_ids

    if (isNaN(folderId)) {
        res.status(400).json({ message: '无效的文件夹 ID。' });
        return;
    }

    if (!Array.isArray(connection_ids)) {
        res.status(400).json({ message: 'connection_ids 必须是一个数组。' });
        return;
    }

    // 可选：验证 connection_ids 中的每个 ID 是否为数字
    if (!connection_ids.every(id => typeof id === 'number')) {
        res.status(400).json({ message: 'connection_ids 数组中的所有元素必须是数字。' });
        return;
    }

    try {
        await FolderService.updateFolderConnections(folderId, connection_ids);
        res.status(200).json({ message: '文件夹的连接关联更新成功。' });
    } catch (error: any) {
        console.error(`Controller: 更新文件夹 ${folderId} 的连接关联时发生错误:`, error);
        // 可以根据 FolderService 抛出的错误类型来返回更具体的错误码和消息
        if (error.message.includes('文件夹未找到')) { // 假设服务层或仓库层会检查文件夹是否存在
            res.status(404).json({ message: '文件夹未找到。' });
        } else {
            res.status(500).json({ message: error.message || '更新文件夹连接关联时发生内部服务器错误。' });
        }
    }
};
