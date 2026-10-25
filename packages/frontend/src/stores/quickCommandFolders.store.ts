import { defineStore } from 'pinia';
import { ref } from 'vue';
import apiClient from '../utils/apiClient';
import i18n from '../i18n';
import { useUiNotificationsStore } from './uiNotifications.store';

/**
 * 成功/失败提示统一在 store 里弹（`quickCommands.store` 也是这套写法）——
 * 调用方不许再弹一次，否则一个动作会冒两条通知。
 * 文案一律走 i18n：之前这里写死了「快捷指令标签已添加」，改名到「文件夹」时被漏掉，
 * 结果添加快捷指令文件夹会同时出现「文件夹已创建」和「…标签已添加」两条。
 */
const t: (key: string, named?: Record<string, unknown>) => string = i18n.global.t as never;

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
            error.value = err.response?.data?.message || t('folders.error', { error: err.message });
            if (error.value) { // Check if error.value is not null
                uiNotificationsStore.showError(error.value); // 显示错误通知
            }
            return false;
        } finally {
            isLoading.value = false;
        }
    }

    // 添加新快捷指令文件夹 (添加后清除缓存)
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
            uiNotificationsStore.showSuccess(t('folders.folderCreated'));
            return newFolder;
        } catch (err: any) {
            console.error('[QuickCmdFolderStore] Failed to add folder:', err);
            error.value = err.response?.data?.message || t('folders.createFailed', { name, error: err.message });
            if (error.value) { // Check if error.value is not null
                uiNotificationsStore.showError(error.value);
            }
            return null;
        } finally {
            isLoading.value = false;
        }
    }

    /**
     * 更新快捷指令文件夹（改名 / 改背景色）。
     * `successKey` 让调用方能挑更具体的文案：改颜色用 `folders.colorUpdated`，
     * 其余情况用默认的 `folders.updateSuccess`。
     */
    async function updateFolder(
        id: number,
        name?: string,
        backgroundColor?: string | null,
        successKey: string = 'folders.updateSuccess'
    ): Promise<boolean> {
        isLoading.value = true;
        error.value = null;
        try {
            const payload: Record<string, any> = {};
            if (typeof name !== 'undefined') payload.name = name;
            if (typeof backgroundColor !== 'undefined') payload.background_color = backgroundColor;

            await apiClient.put(`/quick-command-folders/${id}`, payload);
            localStorage.removeItem('quickCommandFoldersCache');
            await fetchFolders();
            uiNotificationsStore.showSuccess(t(successKey));
            return true;
        } catch (err: any) {
            console.error('[QuickCmdFolderStore] Failed to update folder:', err);
            error.value = err.response?.data?.message || t('folders.updateFailed', { error: err.message });
            if (error.value) { // Check if error.value is not null
                uiNotificationsStore.showError(error.value);
            }
            return false;
        } finally {
            isLoading.value = false;
        }
    }

    // 删除快捷指令文件夹
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
            uiNotificationsStore.showSuccess(
                t(deleteCommands ? 'folders.folderDeletedWithCommands' : 'folders.folderDeleted')
            );
            return true;
        } catch (err: any) {
            console.error('[QuickCmdFolderStore] Failed to delete folder:', err);
            error.value = err.response?.data?.message || t('folders.errorDelete', { error: err.message });
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
        updateFolderColor: (id: number, color: string | null) =>
            updateFolder(id, undefined, color, 'folders.colorUpdated'),
        deleteFolder,
    };
});

