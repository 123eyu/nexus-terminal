import { defineStore } from 'pinia';
import apiClient from '../utils/apiClient';
import { ref, computed } from 'vue';
import { useUiNotificationsStore } from './uiNotifications.store';

// 后端返回的原始路径历史记录条目接口
interface PathHistoryEntryBE {
    id: number;
    path: string;
    /** 归属主机（连接 uuid）。历史按主机隔离，不能跨机器复用 */
    connection_uuid?: string | null;
    timestamp: number; // Unix 时间戳 (秒)
}

// 前端使用的路径历史记录条目接口
export interface PathHistoryEntryFE extends PathHistoryEntryBE {
    // 可以根据需要添加前端特定的字段
}

export const usePathHistoryStore = defineStore('pathHistory', () => {
    const historyList = ref<PathHistoryEntryFE[]>([]);
    const searchTerm = ref('');
    const isLoading = ref(false);
    const error = ref<string | null>(null);
    const uiNotificationsStore = useUiNotificationsStore();
    const selectedIndex = ref<number>(-1); // 过滤列表中选中路径的索引
    /**
     * 当前列表属于哪台主机。路径历史按主机隔离：`/home/a` 在 A 机和 B 机是完全不同的目录，
     * 混在一起会让用户跳到根本不存在的地方。
     */
    const currentConnectionUuid = ref<string | null>(null);

    // --- Getters ---

    // 计算属性：根据搜索词过滤历史记录
    const filteredHistory = computed(() => {
        const term = searchTerm.value.toLowerCase().trim();
        if (!term) {
            return historyList.value; // 没有搜索词则返回全部
        }
        return historyList.value.filter(entry =>
            entry.path.toLowerCase().includes(term)
        );
    });

    // --- Actions ---

    // Action: 选中过滤列表中的下一个路径
    const selectNextPath = () => {
        const history = filteredHistory.value;
        if (history.length === 0) {
            selectedIndex.value = -1;
            return;
        }
        selectedIndex.value = (selectedIndex.value + 1) % history.length;
    };

    // Action: 选中过滤列表中的上一个路径
    const selectPreviousPath = () => {
        const history = filteredHistory.value;
        if (history.length === 0) {
            selectedIndex.value = -1;
            return;
        }
        selectedIndex.value = (selectedIndex.value - 1 + history.length) % history.length;
    };

    // Action: 重置选中状态
    const resetSelection = () => {
        selectedIndex.value = -1;
    };

    // 从后端获取历史记录（必须指定主机；换主机时列表整体换掉）
    const fetchHistory = async (connectionUuid?: string | null) => {
        // 注意：路径历史可能不需要像命令历史那样频繁地使用 localStorage 缓存，
        // 因为它通常在用户与 UI 交互时（如聚焦输入框）才加载。
        // 如果需要缓存，可以参考 commandHistory.store.ts 中的实现。
        if (connectionUuid !== undefined) {
            if (connectionUuid !== currentConnectionUuid.value) {
                // 换主机：先把旧列表清掉，否则会看到另一台机器的路径
                historyList.value = [];
                resetSelection();
            }
            currentConnectionUuid.value = connectionUuid;
        }
        const targetUuid = currentConnectionUuid.value;
        if (!targetUuid) {
            // 没有归属主机就不查：后端回落到全量等于把 A 机路径泄漏到 B 机
            historyList.value = [];
            return;
        }
        error.value = null;
        isLoading.value = true;
        try {
            const response = await apiClient.get<PathHistoryEntryBE[]>('/path-history', {
                params: { connectionUuid: targetUuid },
            });
            // 请求期间用户可能已经切到别的主机：丢弃这次结果
            if (currentConnectionUuid.value !== targetUuid) return;
            // 后端返回的可能是升序，前端通常希望降序显示（最新的在前面）
            historyList.value = response.data.sort((a, b) => b.timestamp - a.timestamp);
            error.value = null;
        } catch (err: any) {
            console.error('[PathHistoryStore] 获取路径历史记录失败:', err);
            error.value = err.response?.data?.message || '获取路径历史记录时发生错误';
            uiNotificationsStore.showError(error.value ?? '未知错误');
        } finally {
            isLoading.value = false;
        }
    };

    // 添加路径到历史记录（必须带归属主机）
    const addPath = async (path: string, connectionUuid?: string | null) => {
        if (!path || path.trim().length === 0) {
            return; // 不添加空路径
        }
        const targetUuid = connectionUuid ?? currentConnectionUuid.value;
        if (!targetUuid) return; // 没有归属主机就别写脏数据
        try {
            await apiClient.post('/path-history', { path: path.trim(), connectionUuid: targetUuid });
            // 只有列表当前就是这台主机时才刷新，避免把 A 机的添加刷进 B 机的列表
            if (currentConnectionUuid.value === targetUuid) {
                await fetchHistory(targetUuid);
            }
        } catch (err: any) {
            console.error('[PathHistoryStore] 添加路径历史记录失败:', err);
            const message = err.response?.data?.message || '添加路径历史记录时发生错误';
            uiNotificationsStore.showError(message);
        }
    };

    // 删除单条历史记录
    const deletePath = async (id: number) => {
        try {
            await apiClient.delete(`/path-history/${id}`);
            // 删除成功后，更新本地列表
            const index = historyList.value.findIndex(entry => entry.id === id);
            if (index !== -1) {
                historyList.value.splice(index, 1);
            }
            uiNotificationsStore.showSuccess('路径历史记录已删除');
        } catch (err: any) {
            console.error('[PathHistoryStore] 删除路径历史记录失败:', err);
            const message = err.response?.data?.message || '删除路径历史记录时发生错误';
            uiNotificationsStore.showError(message);
        }
    };

    // 清空历史记录（默认只清当前主机；不传 uuid 才是全清）
    const clearAllHistory = async (connectionUuid?: string | null) => {
        const targetUuid = connectionUuid ?? currentConnectionUuid.value;
        if (!targetUuid) return;
        try {
            await apiClient.delete('/path-history', { params: { connectionUuid: targetUuid } });
            historyList.value = []; // 清空本地列表
            uiNotificationsStore.showSuccess('该主机的路径历史记录已清空');
        } catch (err: any) {
            console.error('[PathHistoryStore] 清空路径历史记录失败:', err);
            const message = err.response?.data?.message || '清空路径历史记录时发生错误';
            uiNotificationsStore.showError(message);
        }
    };

    // 设置搜索词
    const setSearchTerm = (term: string) => {
        searchTerm.value = term;
        resetSelection(); // 搜索词变化时重置选中项
    };

    return {
        historyList,
        searchTerm,
        isLoading,
        error,
        filteredHistory,
        selectedIndex,
        currentConnectionUuid,
        fetchHistory,
        addPath,
        deletePath,
        clearAllHistory,
        setSearchTerm,
        selectNextPath,
        selectPreviousPath,
        resetSelection,
    };
});