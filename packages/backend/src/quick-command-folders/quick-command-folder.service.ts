import * as QuickCommandFolderRepository from '../quick-command-folders/quick-command-folder.repository';
import { QuickCommandFolder } from '../quick-command-folders/quick-command-folder.repository';

/**
 * 获取所有快捷指令文件夹
 */
export const getAllQuickCommandFolders = async (): Promise<QuickCommandFolder[]> => {
    return QuickCommandFolderRepository.findAllQuickCommandFolders();
};

/**
 * 根据 ID 获取单个快捷指令文件夹
 */
export const getQuickCommandFolderById = async (id: number): Promise<QuickCommandFolder | null> => {
    return QuickCommandFolderRepository.findQuickCommandFolderById(id);
};

/**
 * 添加新的快捷指令文件夹
 * @param name 文件夹名称
 * @param backgroundColor 背景颜色 (可选)
 * @returns 返回新文件夹的 ID
 */
export const addQuickCommandFolder = async (name: string, backgroundColor?: string | null): Promise<number> => {
    if (!name || name.trim().length === 0) {
        throw new Error('文件夹名称不能为空');
    }
    const trimmedName = name.trim();
    // 可以在这里添加更多验证逻辑，例如检查名称格式等
    try {
        const newId = await QuickCommandFolderRepository.createQuickCommandFolder(trimmedName, backgroundColor);
        return newId;
    } catch (error: any) {
        // Service 层可以重新抛出或处理 Repository 抛出的错误
        console.error(`[Service] 添加快捷指令文件夹 "${trimmedName}" 失败:`, error.message);
        throw error; // 重新抛出，让 Controller 处理 HTTP 响应
    }
};

/**
 * 更新快捷指令文件夹
 * @param id 文件夹 ID
 * @param name 新的文件夹名称 (可选)
 * @param backgroundColor 新的背景颜色 (可选)
 * @returns 返回是否成功更新
 */
export const updateQuickCommandFolder = async (id: number, name?: string, backgroundColor?: string | null): Promise<boolean> => {
    let trimmedName: string | undefined = undefined;
    if (typeof name !== 'undefined') {
        if (!name || name.trim().length === 0) {
            throw new Error('文件夹名称不能为空');
        }
        trimmedName = name.trim();
    }
    // 可以在这里添加更多验证逻辑
    try {
        const success = await QuickCommandFolderRepository.updateQuickCommandFolder(id, trimmedName, backgroundColor);
        if (!success) {
             // 可能需要检查文件夹是否存在，或者让 Repository 处理
             console.warn(`[Service] 尝试更新不存在的快捷指令文件夹 ID: ${id}`);
        }
        return success;
    } catch (error: any) {
        console.error(`[Service] 更新快捷指令文件夹 ${id} 失败:`, error.message);
        throw error;
    }
};

/**
 * 删除快捷指令文件夹
 * @param id 文件夹 ID
 * @param deleteCommands 是否连带删除该文件夹下的快捷指令
 * @returns 返回是否成功删除
 */
export const deleteQuickCommandFolder = async (id: number, deleteCommands: boolean = false): Promise<boolean> => {
    try {
        const success = await QuickCommandFolderRepository.deleteQuickCommandFolder(id, deleteCommands);
         if (!success) {
             console.warn(`[Service] 尝试删除不存在的快捷指令文件夹 ID: ${id}`);
         }
        return success;
    } catch (error: any) {
        console.error(`[Service] 删除快捷指令文件夹 ${id} 失败:`, error.message);
        throw error;
    }
};

/**
 * 设置指定快捷指令的文件夹关联
 * @param commandId 快捷指令 ID
 * @param folderIds 新的快捷指令文件夹 ID 数组
 * @returns Promise<void>
 */
export const setCommandFolders = async (commandId: number, folderIds: number[]): Promise<void> => {
    // 验证 folderIds 是否为数字数组 (基本验证)
    if (!Array.isArray(folderIds) || !folderIds.every(id => typeof id === 'number')) {
        throw new Error('文件夹 ID 列表必须是一个数字数组');
    }
    // 可以在这里添加更复杂的验证，例如检查 folderIds 是否都存在于 quick_command_folders 表中
    // 但 Repository 中的 setCommandFolderAssociations 已包含基本的检查和错误处理

    try {
        // 直接调用 Repository 处理关联更新 (Repository 函数现在返回 void)
        await QuickCommandFolderRepository.setCommandFolderAssociations(commandId, folderIds);
        // Service 函数也返回 void，所以不需要 return
    } catch (error: any) {
        console.error(`[Service] 设置快捷指令 ${commandId} 的文件夹失败:`, error.message);
        throw error;
    }
};

/**
 * 获取指定快捷指令的所有文件夹
 * @param commandId 快捷指令 ID
 * @returns 文件夹对象数组
 */
export const getFoldersForCommand = async (commandId: number): Promise<QuickCommandFolder[]> => {
    try {
        return await QuickCommandFolderRepository.findFoldersByCommandId(commandId);
    } catch (error: any) {
        console.error(`[Service] 获取快捷指令 ${commandId} 的文件夹失败:`, error.message);
        throw error;
    }
};