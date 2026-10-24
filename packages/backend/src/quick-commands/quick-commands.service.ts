import * as QuickCommandsRepository from '../quick-commands/quick-commands.repository';
import { QuickCommandWithFolders } from '../quick-commands/quick-commands.repository'; 
import * as QuickCommandFolderRepository from '../quick-command-folders/quick-command-folder.repository'; 

// 定义排序类型
export type QuickCommandSortBy = 'name' | 'usage_count';

/**
 * 添加快捷指令
 * @param name - 指令名称 (可选)
 * @param command - 指令内容
 * @param folderIds - 关联的快捷指令文件夹 ID 数组 (可选)
 * @param variables - 变量对象 (可选)
 * @param backgroundColor - 背景颜色 (可选)
 * @returns 返回添加记录的 ID
 */
export const addQuickCommand = async (name: string | null, command: string, folderIds?: number[], variables?: Record<string, string>, backgroundColor?: string | null): Promise<number> => {
    if (!command || command.trim().length === 0) {
        throw new Error('指令内容不能为空');
    }
    // 如果 name 是空字符串，则视为 null
    const finalName = name && name.trim().length > 0 ? name.trim() : null;
    const commandId = await QuickCommandsRepository.addQuickCommand(finalName, command.trim(), variables, backgroundColor);

    // 添加成功后，设置文件夹关联
    if (commandId > 0 && folderIds && Array.isArray(folderIds)) {
        try {
            await QuickCommandFolderRepository.setCommandFolderAssociations(commandId, folderIds);
        } catch (tagError: any) {
            // 如果文件夹关联失败，可以选择记录警告或回滚（但通常不回滚主记录）
            console.warn(`[Service] 添加快捷指令 ${commandId} 成功，但设置文件夹关联失败:`, tagError.message);
            // 可以考虑是否需要通知用户部分操作失败
        }
    }
    return commandId;
};

/**
 * 更新快捷指令
 * @param id - 要更新的记录 ID
 * @param name - 新的指令名称 (可选)
 * @param command - 新的指令内容
 * @param folderIds - 新的关联文件夹 ID 数组 (可选, undefined 表示不更新文件夹)
 * @param variables - 新的变量对象 (可选)
 * @param backgroundColor - 新的背景颜色 (可选)
 * @returns 返回是否成功更新 (更新行数 > 0)
 */
export const updateQuickCommand = async (id: number, name: string | null, command: string, folderIds?: number[], variables?: Record<string, string>, backgroundColor?: string | null): Promise<boolean> => {
    if (!command || command.trim().length === 0) {
        throw new Error('指令内容不能为空');
    }
    const finalName = name && name.trim().length > 0 ? name.trim() : null;
    const commandUpdated = await QuickCommandsRepository.updateQuickCommand(id, finalName, command.trim(), variables, backgroundColor);

    // 如果指令更新成功，并且提供了 folderIds (即使是空数组也表示要更新)，则更新文件夹关联
    if (commandUpdated && typeof folderIds !== 'undefined') {
         try {
            await QuickCommandFolderRepository.setCommandFolderAssociations(id, folderIds);
         } catch (tagError: any) {
             console.warn(`[Service] 更新快捷指令 ${id} 成功，但更新文件夹关联失败:`, tagError.message);
             // 即使文件夹更新失败，主记录已更新，通常返回 true
         }
    }
    // 返回主记录是否更新成功
    return commandUpdated;
};

/**
 * 删除快捷指令
 * @param id - 要删除的记录 ID
 * @returns 返回是否成功删除 (删除行数 > 0)
 */
export const deleteQuickCommand = async (id: number): Promise<boolean> => {
    const changes = await QuickCommandsRepository.deleteQuickCommand(id);
    return changes;
};

/**
 * 获取所有快捷指令，并按指定方式排序
 * @param sortBy - 排序字段 ('name' 或 'usage_count')
 * @returns 返回排序后的快捷指令数组 (包含 folderIds)
 */
export const getAllQuickCommands = async (sortBy: QuickCommandSortBy = 'name'): Promise<QuickCommandWithFolders[]> => {
    // Repository 已返回带 folderIds 的数据
    return QuickCommandsRepository.getAllQuickCommands(sortBy);
};

/**
 * 增加快捷指令的使用次数
 * @param id - 记录 ID
 * @returns 返回是否成功更新 (更新行数 > 0)
 */
export const incrementUsageCount = async (id: number): Promise<boolean> => {
    const changes = await QuickCommandsRepository.incrementUsageCount(id);
    return changes;
};

/**
 * 根据 ID 获取单个快捷指令 (可能用于编辑)
 * @param id - 记录 ID
 * @returns 返回找到的快捷指令 (包含 folderIds)，或 undefined
 */
export const getQuickCommandById = async (id: number): Promise<QuickCommandWithFolders | undefined> => {
    // Repository 已返回带 folderIds 的数据
    return QuickCommandsRepository.findQuickCommandById(id);
};

/**
 * 将单个文件夹批量关联到多个快捷指令
 * @param commandIds - 需要添加文件夹的快捷指令 ID 数组
 * @param folderId - 要添加的文件夹 ID
 * @returns Promise<void>
 */
export const assignFolderToCommands = async (commandIds: number[], folderId: number): Promise<void> => {
    try {
        // 基本验证
        if (!Array.isArray(commandIds) || commandIds.some(id => typeof id !== 'number' || isNaN(id))) {
            throw new Error('无效的指令 ID 列表');
        }
        if (typeof folderId !== 'number' || isNaN(folderId)) {
            throw new Error('无效的文件夹 ID');
        }

        // 调用 Repository 函数执行批量关联
        // 注意：这里需要导入 QuickCommandFolderRepository
        console.log(`[Service] assignFolderToCommands: Calling repo with commandIds: ${JSON.stringify(commandIds)}, folderId: ${folderId}`); 
        await QuickCommandFolderRepository.addFolderToCommands(commandIds, folderId);
        console.log(`[Service] assignFolderToCommands: Repo call finished for folder ${folderId}.`); // +++ 修改日志 +++
        // 可以在这里添加额外的业务逻辑，例如发送事件通知等
    } catch (error: any) {
        console.error(`[Service] assignFolderToCommands: 批量关联文件夹 ${folderId} 到指令时出错:`, error.message);
        // 向上抛出错误，让 Controller 处理 HTTP 响应
        throw error;
    }
};
