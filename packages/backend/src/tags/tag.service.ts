import * as TagRepository from '../tags/tag.repository';

// Re-export or define types
export interface TagData extends TagRepository.TagData {}

/**
 * 获取所有文件夹
 */
export const getAllTags = async (): Promise<TagData[]> => {
    return TagRepository.findAllTags();
};

/**
 * 根据 ID 获取单个文件夹
 */
export const getTagById = async (id: number): Promise<TagData | null> => {
    return TagRepository.findTagById(id);
};

/**
 * 创建新文件夹
 */
export const createTag = async (name: string, backgroundColor?: string | null): Promise<TagData> => {

    if (!name || name.trim().length === 0) {
        throw new Error('文件夹名称不能为空。');
    }
    const trimmedName = name.trim();


    try {
        const newTagId = await TagRepository.createTag(trimmedName, backgroundColor);
        const newTag = await getTagById(newTagId);
        if (!newTag) {
            throw new Error('创建文件夹后无法检索到该文件夹。');
        }
        return newTag;
    } catch (error: any) {
        if (error.message.includes('UNIQUE constraint failed')) {
            throw new Error(`创建文件夹失败：文件夹名称 "${trimmedName}" 已存在。`);
        }
        throw error;
    }
};

/**
 * 更新文件夹名称或背景色
 */
export const updateTag = async (id: number, name?: string, backgroundColor?: string | null): Promise<TagData | null> => {
    let trimmedName: string | undefined = undefined;
    if (typeof name !== 'undefined') {
        if (!name || name.trim().length === 0) {
            throw new Error('文件夹名称不能为空。');
        }
        trimmedName = name.trim();
    }

    try {
        const updated = await TagRepository.updateTag(id, trimmedName, backgroundColor);
        if (!updated) {
            return null; 
        }

        return getTagById(id);
    } catch (error: any) {
         if (error.message.includes('UNIQUE constraint failed')) {
            throw new Error(`更新文件夹失败：文件夹名称 "${trimmedName}" 已存在。`);
        }
        throw error;
    }
};

/**
 * 删除文件夹
 */
export const deleteTag = async (id: number): Promise<boolean> => {
    return TagRepository.deleteTag(id);
};

/**
 * 更新文件夹与连接的关联关系
 */
export const updateTagConnections = async (tagId: number, connectionIds: number[]): Promise<void> => {
    // 在服务层可以添加额外的业务逻辑，例如验证 tagId 和 connectionIds 的有效性
    // 例如，检查文件夹是否存在，连接 ID 是否都存在于数据库中等。
    // 此处为简化，直接调用 repository 方法。

    // 确保 connectionIds 是一个数组，即使是空数组
    const idsToUpdate = Array.isArray(connectionIds) ? connectionIds : [];

    try {
        await TagRepository.updateTagConnections(tagId, idsToUpdate);
    } catch (error: any) {
        // 服务层可以进一步处理或包装错误
        console.error(`Service: 更新文件夹 ${tagId} 的连接关联时发生错误:`, error.message);
        throw new Error(`服务层更新文件夹连接关联失败: ${error.message}`);
    }
};
