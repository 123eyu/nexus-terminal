import { defineStore } from 'pinia';
import { ref } from 'vue';
import apiClient from '../utils/apiClient';
import { useUiNotificationsStore } from './uiNotifications.store';

// 快捷指令文件夹（与后端 quick_command_folders 对应）
export interface QuickCommandFolder {
    id: number;
    name: string;
    background_color?: string | null;
    created_at: number;
    updated_at: number;
}

export const useQuickCommandFoldersStore = defineStore('quickCommandFolders', () => {
    const folders = ref<QuickCommandFolder[]>([]);
    const isLoading = ref(false);
    const error = ref<string | null>(null);
    const uiNotificationsStore = useUiNotificationsStore();

    // 获取快捷指令文件夹列表 (带缓存)
    async function fetchFolders() {
        const cacheKey = 'quickCommandFoldersCache';
        error.value = null;

        // 1. 尝试从 localStorage 加载缓存
        try {
            const cachedData = localStorage.getItem(cacheKey);
            if (cachedData) {
                folders.value = JSON.parse(cachedData);
                isLoading.value = false;
            } else {
                isLoading.value = true;
            }
        } catch (e) {
            console.error('[QuickCmdFolderStore] Failed to load or parse cache:', e);
            localStorage.removeItem(cacheKey);
            isLoading.value = true;
        }

        // 2. 后台获取最新数据
        // ⚠️ 已有数据时不要翻 isLoading：切屏回来 / 云端同步会反复调这个 fetch，
        // 翻一下就让「快捷指令标签」闪一次 loading（与 folders.store 保持同一套写法）
        if (folders.value.length === 0) isLoading.value = true;
        try {
            // 使用新的 API 端点
            const response = await apiClient.get<QuickCommandFolder[]>('/quick-command-folders');
            const freshData = response.data;
            const freshDataString = JSON.stringify(freshData);

            // 3. 对比并更新
            const currentDataString = JSON.stringify(folders.value);
            if (currentDataString !== freshDataString) {
                folders.value = freshData;
                localStorage.setItem(cacheKey, freshDataString);
            } else {
            }
            error.value = null;
            return true;
        } catch (err: any) {
            console.error('[QuickCmdFolderStore] Failed to fetch folders:', err);
            error.value = err.response?.data?.message || err.message || '获取快捷指令文件夹列表失败';
            if (error.value) { // Check if error.value is not null
                uiNotificationsStore.showError(error.value); // 显示错误通知
            }
            return false;
        } finally {
            isLoading.value = false;
        }
    }

    // 添加新快捷指令标签 (添加后清除缓存)
    async function addFolder(name: string, backgroundColor?: string | null): Promise<QuickCommandFolder | null> {
        isLoading.value = true;
        error.value = null;
        try {
            // 使用新的 API 端点
            const response = await apiClient.post<{ message: string, folder: QuickCommandFolder }>('/quick-command-folders', {
                name,
                background_color: backgroundColor || null
            });
            const newFolder = response.data.folder;
            localStorage.removeItem('quickCommandFoldersCache'); // 清除缓存
            await fetchFolders(); // 重新获取以更新列表
            uiNotificationsStore.showSuccess('快捷指令标签已添加');
            return newFolder;
        } catch (err: any) {
            console.error('[QuickCmdFolderStore] Failed to add folder:', err);
            error.value = err.response?.data?.message || err.message || '添加快捷指令标签失败';
            if (error.value) { // Check if error.value is not null
                uiNotificationsStore.showError(error.value);
            }
            return null;
        } finally {
            isLoading.value = false;
        }
    }

    // 更新快捷指令标签
    async function updateFolder(id: number, name?: string, backgroundColor?: string | null): Promise<boolean> {
        isLoading.value = true;
        error.value = null;
        try {
            const payload: Record<string, any> = {};
            if (typeof name !== 'undefined') payload.name = name;
            if (typeof backgroundColor !== 'undefined') payload.background_color = backgroundColor;

            await apiClient.put(`/quick-command-folders/${id}`, payload);
            localStorage.removeItem('quickCommandFoldersCache');
            await fetchFolders();
            uiNotificationsStore.showSuccess('快捷指令标签已更新');
            return true;
        } catch (err: any) {
            console.error('[QuickCmdFolderStore] Failed to update folder:', err);
            error.value = err.response?.data?.message || err.message || '更新快捷指令标签失败';
            if (error.value) { // Check if error.value is not null
                uiNotificationsStore.showError(error.value);
            }
            return false;
        } finally {
            isLoading.value = false;
        }
    }

    // 删除快捷指令标签
    async function deleteFolder(id: number, deleteCommands: boolean = false): Promise<boolean> {
        isLoading.value = true;
        error.value = null;
        try {
            // 使用新的 API 端点，支持带参删除指令
            await apiClient.delete(`/quick-command-folders/${id}`, {
                params: { deleteCommands }
            });
            localStorage.removeItem('quickCommandFoldersCache');
            await fetchFolders();
            uiNotificationsStore.showSuccess(deleteCommands ? '快捷指令分组及其中指令已删除' : '快捷指令标签已删除');
            return true;
        } catch (err: any) {
            console.error('[QuickCmdFolderStore] Failed to delete folder:', err);
            error.value = err.response?.data?.message || err.message || '删除快捷指令文件夹失败';
            if (error.value) { // Check if error.value is not null
                uiNotificationsStore.showError(error.value);
            }
            return false;
        } finally {
            isLoading.value = false;
        }
    }

    return {
        folders,
        isLoading,
        error,
        fetchFolders,
        addFolder,
        createFolder: addFolder,
        updateFolder,
        renameFolder: updateFolder,
        updateFolderColor: (id: number, color: string | null) => updateFolder(id, undefined, color),
        deleteFolder,
    };
});

