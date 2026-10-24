import { defineStore } from 'pinia';
import { ref } from 'vue';
import apiClient from '../utils/apiClient'; // 使用统一的 apiClient

// 文件夹信息接口
export interface FolderInfo {
    id: number;
    name: string;
    background_color?: string | null;
    created_at: number;
    updated_at: number;
}

export const useFoldersStore = defineStore('folders', () => {
    const folders = ref<FolderInfo[]>([]);
    const isLoading = ref(false);
    const error = ref<string | null>(null);
    /** 是否已经成功拉过一次（区分「首次加载」和「后台静默刷新」） */
    const hasLoaded = ref(false);

    // 获取文件夹列表 (带缓存)
    async function fetchFolders() {
        const cacheKey = 'foldersCache';
        error.value = null; // 重置错误

        // 1. 尝试从 localStorage 加载缓存（有缓存就先显示，不闪 loading）
        try {
            const cachedData = localStorage.getItem(cacheKey);
            if (cachedData) {
                folders.value = JSON.parse(cachedData);
            }
        } catch (e) {
            console.error('[FoldersStore] Failed to load or parse folders cache:', e);
            localStorage.removeItem(cacheKey); // 解析失败则移除缓存
        }

        // 2. 后台获取最新数据
        // ⚠️ 判「首次加载」用 hasLoaded，**不能用 `folders.length === 0`**：
        // 一个标签都没有的用户列表恒为空，那样「切屏回来」「云端同步完成」触发的
        // 后台静默重拉每次都会翻一次 isLoading，「所属文件夹」下面的「加载中...」就闪一下。
        if (!hasLoaded.value) isLoading.value = true;
        try {
            const response = await apiClient.get<FolderInfo[]>('/folders');
            const freshData = response.data;
            const freshDataString = JSON.stringify(freshData);

            // 3. 对比并更新
            const currentDataString = JSON.stringify(folders.value);
            if (currentDataString !== freshDataString) {
                folders.value = freshData;
                localStorage.setItem(cacheKey, freshDataString); // 更新缓存
            } else {
                console.log('[FoldersStore] Folders data is up-to-date.');
            }
            error.value = null; // 清除错误
            hasLoaded.value = true;
            return true; // 表示获取成功（即使数据未变）
        } catch (err: any) {
            console.error('[FoldersStore] Failed to fetch folders:', err);
            error.value = err.response?.data?.message || err.message || '获取文件夹列表失败';
            // 保留缓存数据，仅设置错误状态
            return false; // 表示获取失败
        } finally {
            isLoading.value = false; // 加载完成
        }
    }

    // 新建文件夹（成功后清缓存重拉）
    async function addFolder(name: string, backgroundColor?: string | null): Promise<FolderInfo | null> {
        isLoading.value = true;
        error.value = null;
        try {
            const response = await apiClient.post<{ message: string, folder: FolderInfo }>('/folders', {
                name,
                background_color: backgroundColor || null
            });
            const newFolder = response.data.folder;
            // 添加成功后，清除缓存并重新获取 (fetchFolders 会更新本地列表)
            localStorage.removeItem('foldersCache');
            await fetchFolders(); // fetchFolders 会处理获取和缓存更新
            return newFolder; // 返回新建的文件夹
        } catch (err: any) {
            console.error('Failed to add folder:', err);
            error.value = err.response?.data?.message || err.message || '添加文件夹失败';
            return null; // 返回 null 表示失败
        } finally {
            isLoading.value = false;
        }
    }

    // 更新文件夹
    async function updateFolder(id: number, name?: string, backgroundColor?: string | null): Promise<boolean> {
        isLoading.value = true;
        error.value = null;
        try {
            const payload: Record<string, any> = {};
            if (typeof name !== 'undefined') payload.name = name;
            if (typeof backgroundColor !== 'undefined') payload.background_color = backgroundColor;

            await apiClient.put(`/folders/${id}`, payload);
            // 更新成功后，清除缓存并重新获取
            localStorage.removeItem('foldersCache');
            await fetchFolders();
            return true;
        } catch (err: any) {
            console.error('Failed to update folder:', err);
            error.value = err.response?.data?.message || err.message || '更新文件夹失败';
            return false;
        } finally {
            isLoading.value = false;
        }
    }

    // 删除文件夹
    async function deleteFolder(id: number): Promise<boolean> {
        isLoading.value = true;
        error.value = null;
        try {
            await apiClient.delete(`/folders/${id}`); // 使用 apiClient 并移除 base URL
            // 删除成功后，清除缓存并重新获取
            localStorage.removeItem('foldersCache');
            await fetchFolders();
            return true;
        } catch (err: any) {
            console.error('Failed to delete folder:', err);
            error.value = err.response?.data?.message || err.message || '删除文件夹失败';
            return false;
        } finally {
            isLoading.value = false;
        }
    }

    // 更新文件夹关联的连接
    async function updateFolderConnections(folderId: number, connectionIds: number[]): Promise<boolean> {
        isLoading.value = true;
        error.value = null;
        try {
            // 假设后端 API 端点是 PUT /api/folders/:folderId/connections
            await apiClient.put(`/folders/${folderId}/connections`, { connection_ids: connectionIds });
            // 更新成功后，清除相关缓存并重新获取数据以确保一致性
            localStorage.removeItem('foldersCache'); // 清除文件夹缓存
            localStorage.removeItem('connectionsCache'); // 清除连接缓存，因为连接的 folder_ids 可能已更改

            await fetchFolders(); // 重新获取文件夹
            // 可能还需要通知 connectionsStore 重新获取连接，或者在这里直接调用
            // (这取决于您希望如何管理 store 间的依赖和数据同步)
            // 例如: const connectionsStore = useConnectionsStore(); await connectionsStore.fetchConnections();
            // 为简单起见，这里假设调用者会处理连接列表的刷新，或者依赖于后续的自动刷新机制。
            // 或者，更健壮的做法是在此 action 成功后，让 connectionsStore 也刷新。
            // 但为了减少此处的直接依赖，暂时只刷新 foldersStore。
            // WorkspaceConnectionList 在模态框保存成功后会重新 fetchConnections。

            return true;
        } catch (err: any) {
            console.error(`Failed to update connections for folder ${folderId}:`, err);
            error.value = err.response?.data?.message || err.message || '更新文件夹归类失败';
            return false;
        } finally {
            isLoading.value = false;
        }
    }

    return {
        folders,
        isLoading,
        error,
        hasLoaded,
        fetchFolders,
        addFolder,
        createFolder: addFolder,
        updateFolder,
        renameFolder: updateFolder,
        updateFolderColor: (id: number, color: string | null) => updateFolder(id, undefined, color),
        deleteFolder,
        updateFolderConnections, // 暴露新的 action
    };
});

