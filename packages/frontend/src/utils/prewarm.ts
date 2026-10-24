/**
 * 挂载前预取（prewarm）的一次性请求登记表。
 *
 * 背景：网页版冷启动时，`main.ts` 要等路由懒加载的 chunk 下载完才能挂载；
 * 而「拉云端工作区快照 / 抢接管租约 / 拉挂起会话 / 拉连接列表」这几个往返
 * 原本都排在挂载之后（`WorkspaceView.onMounted` → `initSync`），
 * 于是浏览器只能先画一个"没有任何会话"的空工作区，等这几个 RTT 走完再往里填。
 *
 * 这里让这几件事在 **chunk 下载的同时** 就发起：数据先到内存，
 * 挂载后的恢复流程 `await` 到的是已经 resolve 的 promise，
 * 只剩微任务 —— 标签在首帧绘制之前就已经躺在 store 里了。
 *
 * 语义是一次性的：谁 `usePrewarm` 谁消费；没有登记的 key 就现场发请求，
 * 所以「手动刷新工作区」「切屏重进」这些路径完全不受影响。
 */

const tasks = new Map<string, Promise<unknown>>();

/**
 * 冷启动预取的 key。恢复工作区要用的四个往返都在这里，
 * 名字集中放是为了「谁取用谁写错 key」这种问题能一眼看出来。
 */
export const PREWARM_KEYS = {
  /** GET /workspace-sync */
  snapshot: 'prewarm:workspace-snapshot',
  /** POST /workspace-sync/claim */
  claim: 'prewarm:workspace-claim',
  /** GET ssh-suspend/suspended-sessions（必须排在 claim 之后） */
  suspended: 'prewarm:suspended-sessions',
  /** GET /connections */
  connections: 'prewarm:connections',
} as const;

/** 登记一个「挂载前就已发起」的请求（key 全局唯一，重复登记以最后一次为准） */
export function registerPrewarm<T>(key: string, task: Promise<T>): Promise<T> {
  tasks.set(key, task);
  return task;
}

/** 是否有登记过（只探测，不消费） */
export function hasPrewarm(key: string): boolean {
  return tasks.has(key);
}

/**
 * 取用（一次性）：有登记就用那次请求的结果，没有就调用 `fallback` 现场发。
 * 登记的请求本身已经 `catch` 过、失败时给 null，调用方只需处理"拿不到数据"。
 */
export function usePrewarm<T>(key: string, fallback: () => Promise<T>): Promise<T> {
  const task = tasks.get(key) as Promise<T> | undefined;
  if (!task) return fallback();
  tasks.delete(key);
  return task;
}
