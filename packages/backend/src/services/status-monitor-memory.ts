/**
 * 状态监视器里的内存 / 交换解析。
 *
 * 单独抽出来是为了两件事：
 * 1) 纯函数，能被单测直接覆盖（不用起 SSH、不用连数据库）；
 * 2) 把「为什么不能依赖 free 的 Mem: 标签」这件事集中说明 —— 见下。
 *
 * ⚠️ 背景（Issue #80）：procps-ng 4.0 起 `free` 的输出走了 gettext，
 * `Mem:` / `Swap:` 这些标签会随 locale 翻译。Debian 12 自带 procps 4.0.2，
 * 中文环境下 `free -m` 打出来的是：
 *
 *     总计  已用  空闲  共享  缓冲/缓存  可用
 *     内存： 7957  1582  3226   108    3148  5990
 *     交换： 2047     0  2047
 *
 * 于是 `line.startsWith('Mem:')` 永远匹配不上 → memTotal/memUsed/memPercent 全是
 * undefined，前端回落成「不可用」，而 CPU / 磁盘 / 负载 / 网速都正常，症状极像
 * 「只有内存读不到」。procps < 4.0（Ubuntu 22.04、CentOS 等）不会翻译，所以只在
 * 新版发行版上复现。
 *
 * 对策是双保险：
 * - 首选读 `/proc/meminfo`，它的 key 是内核导出的英文常量，与 locale 无关；
 * - 退路才用 `free`，且命令前置 `LC_ALL=C` 强制英文。
 */

export interface MemUsage {
    /** 总内存，MB */
    memTotal: number;
    /** 已用内存，MB（与 free 的口径一致：total - available） */
    memUsed: number;
    /** 交换区总量，MB */
    swapTotal: number;
    /** 已用交换区，MB */
    swapUsed: number;
}

/**
 * 解析 `/proc/meminfo`。
 *
 * 单位统一是 kB，输出形如 `MemTotal:       8147068 kB`。
 * `MemAvailable` 要 Linux 3.14+ 才有，老内核上回退成 MemFree + Buffers + Cached
 * （这也是 free 在引入 MemAvailable 之前的口径）。
 *
 * 换算成 MB 用 floor 而不是 round，跟 `free -m` 的截断口径对齐。
 *
 * @returns 解析成功返回 MB 为单位的数据；文件缺失或没有 MemTotal 时返回 null
 */
export function parseProcMeminfo(output: string): MemUsage | null {
    if (!output) return null;
    const kv: Record<string, number> = {};
    for (const line of output.split('\n')) {
        const m = line.match(/^(\w+):\s+(\d+)\s*kB/i);
        if (m) kv[m[1]] = parseInt(m[2], 10);
    }
    const totalKb = kv['MemTotal'];
    if (!totalKb || isNaN(totalKb)) return null;

    const availKb = kv['MemAvailable'] !== undefined
        ? kv['MemAvailable']
        : (kv['MemFree'] ?? 0) + (kv['Buffers'] ?? 0) + (kv['Cached'] ?? 0);

    const swapTotalKb = kv['SwapTotal'] ?? 0;
    const swapFreeKb = kv['SwapFree'] ?? swapTotalKb;
    // 两者都是 0 时 SwapFree 可能整个字段缺失，clamp 一下别出负数
    const swapUsedKb = Math.max(0, swapTotalKb - swapFreeKb);

    // 与 `free -m` 的口径保持一致：procps 是截断而不是四舍五入（475604 kB → 464），
    // 用 floor 才不会出现「两条路差 1 MB」的迷惑现象。
    const toMb = (kb: number) => Math.floor(kb / 1024);
    return {
        memTotal: toMb(totalKb),
        memUsed: toMb(Math.max(0, totalKb - availKb)),
        swapTotal: toMb(swapTotalKb),
        swapUsed: toMb(swapUsedKb),
    };
}

/**
 * 解析 `free -m`（BusyBox 是 `free`，单位 kB）的输出。
 *
 * 调用方必须把命令写成 `LC_ALL=C free -m`，否则 procps 4.0+ 在非英文 locale 下
 * 会把标签翻译掉（见文件头注释），这里就什么都匹配不到了。
 *
 * @param isBusyBox BusyBox 的 free 没有 -m，输出单位是 Byte，需要换算成 MB
 * @returns 解析成功返回 MB 为单位的数据；找不到 Mem 行时返回 null
 */
export function parseFreeOutput(output: string, isBusyBox = false): MemUsage | null {
    if (!output) return null;
    const lines = output.split('\n');

    const pick = (prefix: string): number[] | null => {
        const line = lines.find(l => l.trimStart().startsWith(prefix));
        if (!line) return null;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) return null;
        const raw = [parseInt(parts[1], 10), parseInt(parts[2], 10)];
        if (raw.some(isNaN)) return null;
        return isBusyBox ? raw.map(v => Math.floor(v / 1024)) : raw;
    };

    const mem = pick('Mem:');
    if (!mem) return null;
    const swap = pick('Swap:') ?? [0, 0];

    return {
        memTotal: mem[0],
        memUsed: mem[1],
        swapTotal: swap[0],
        swapUsed: swap[1],
    };
}
