import { defineStore } from 'pinia';
import apiClient from '../utils/apiClient';

export interface HighlightColorOption {
  key: string;
  color: string;
  name: string;
}

export const PRESET_HIGHLIGHT_COLORS: HighlightColorOption[] = [
  { key: 'red', color: '#ef4444', name: '红色' },
  { key: 'orange', color: '#f97316', name: '橙色' },
  { key: 'amber', color: '#f59e0b', name: '琥珀' },
  { key: 'yellow', color: '#eab308', name: '黄色' },
  { key: 'green', color: '#22c55e', name: '绿色' },
  { key: 'cyan', color: '#06b6d4', name: '青色' },
  { key: 'blue', color: '#3b82f6', name: '蓝色' },
  { key: 'purple', color: '#a855f7', name: '紫色' },
  { key: 'pink', color: '#ec4899', name: '粉色' },
];

/**
 * 路径标准化规范，保证末尾斜杠不影响查表
 */
export function normalizeHighlightPath(p: string): string {
  if (!p) return '';
  let normalized = p.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export interface FileColorHighlightsState {
  highlights: Record<number, Record<string, string>>;
  loadedConnections: Set<number>;
  isLoading: boolean;
}

export const useFileColorHighlightsStore = defineStore('fileColorHighlights', {
  state: (): FileColorHighlightsState => ({
    highlights: {},
    loadedConnections: new Set<number>(),
    isLoading: false,
  }),

  actions: {
    /**
     * 加载指定连接的文件高亮配置
     */
    async loadHighlights(connectionId: number, force = false): Promise<Record<string, string>> {
      if (!connectionId) return {};
      if (!force && this.loadedConnections.has(connectionId)) {
        return this.highlights[connectionId] || {};
      }

      this.isLoading = true;
      try {
        const response = await apiClient.get<{ success: boolean; data: Record<string, string> }>(
          `/connections/${connectionId}/file-color-highlights`
        );
        const data = response.data?.data || {};
        this.highlights[connectionId] = { ...data };
        this.loadedConnections.add(connectionId);
        return this.highlights[connectionId];
      } catch (error: any) {
        console.warn(`[FileColorHighlights] 加载连接 ${connectionId} 高亮失败:`, error?.message || error);
        if (!this.highlights[connectionId]) {
          this.highlights[connectionId] = {};
        }
        return this.highlights[connectionId];
      } finally {
        this.isLoading = false;
      }
    },

    /**
     * 设置或更新指定文件/文件夹的高亮颜色
     */
    async setHighlight(connectionId: number, path: string, color: string): Promise<void> {
      if (!connectionId || !path || !color) return;
      const normalized = normalizeHighlightPath(path);

      // 乐观更新本地缓存
      if (!this.highlights[connectionId]) {
        this.highlights[connectionId] = {};
      }
      this.highlights[connectionId][normalized] = color;
      this.loadedConnections.add(connectionId);

      try {
        await apiClient.post(`/connections/${connectionId}/file-color-highlights`, {
          path: normalized,
          color,
        });
      } catch (error: any) {
        console.error(`[FileColorHighlights] 设置高亮失败:`, error?.message || error);
        // 出错时刷新重载
        await this.loadHighlights(connectionId, true);
        throw error;
      }
    },

    /**
     * 清除指定文件/文件夹的高亮颜色
     */
    async removeHighlight(connectionId: number, path: string): Promise<void> {
      if (!connectionId || !path) return;
      const normalized = normalizeHighlightPath(path);

      // 乐观删除本地缓存
      if (this.highlights[connectionId]) {
        delete this.highlights[connectionId][normalized];
      }

      try {
        await apiClient.delete(
          `/connections/${connectionId}/file-color-highlights?path=${encodeURIComponent(normalized)}`
        );
      } catch (error: any) {
        console.error(`[FileColorHighlights] 清除高亮失败:`, error?.message || error);
        await this.loadHighlights(connectionId, true);
        throw error;
      }
    },

    /**
     * 重新加载所有已加载连接的高亮配置 (用于双端数据同步完成后无感刷新)
     */
    async reloadLoadedHighlights(): Promise<void> {
      const connIds = Array.from(this.loadedConnections);
      this.loadedConnections.clear();
      await Promise.all(connIds.map((id) => this.loadHighlights(id, true)));
    },

    /**
     * 高速获取特定路径的高亮颜色
     */
    getColor(connectionId: number | null | undefined, path: string): string | undefined {
      if (!connectionId || !path) return undefined;
      const connMap = this.highlights[connectionId];
      if (!connMap) return undefined;
      const normalized = normalizeHighlightPath(path);
      return connMap[normalized];
    },
  },
});
