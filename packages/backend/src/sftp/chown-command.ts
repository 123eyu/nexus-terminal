/**
 * `chown` 命令生成（纯函数，零依赖，直接跑单测）。
 *
 * 为什么不用 `sftp.chown(path, uid, gid)`：
 * SFTP 协议里的 chown 只收**数字** uid/gid，用户在界面里填的是 `www-data`
 * 这类名字，还得先跑一次 `getent passwd` 解析 —— 两次往返、两条失败路径。
 * 直接走 SSH 执行 `chown 用户名:组名 路径` 一次搞定，SFTP/SCP 两种模式也能共用一份实现。
 *
 * 安全要点：`chown` 的第一个参数和路径都会进 shell，所以
 *  - 用户名/组名只允许 `[A-Za-z0-9._-]`（或纯数字），其它一律拒绝；
 *  - 路径整体单引号包裹，内部的单引号按 POSIX 规则转义。
 */

export interface ChownTargets {
    owner?: string;
    group?: string;
}

export type ChownErrorCode = 'emptyTargets' | 'invalidOwner' | 'invalidGroup';

export interface ChownCommandResult {
    /** 可执行的完整命令；校验失败时为 null。 */
    command: string | null;
    /** 校验失败原因。 */
    error?: ChownErrorCode;
    /** 归一化后的 chown 目标（`user:group` / `user` / `:group`）。 */
    spec?: string;
}

/** 用户名/组名合法字符：字母数字开头，允许 `._-`，不允许空格、冒号、斜杠、`$` 等。 */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
/** 纯数字 uid/gid（上限 10 位，超过 32 位整数范围没有意义）。 */
const NUMERIC_RE = /^[0-9]{1,10}$/;

export function isValidChownName(value: string): boolean {
    const text = (value || '').trim();
    if (!text) return false;
    return NUMERIC_RE.test(text) || NAME_RE.test(text);
}

/** POSIX 单引号转义（路径里可能有空格、中文、单引号）。 */
export function shellQuote(value: string): string {
    const text = value == null ? '' : String(value);
    if (text === '') return "''";
    if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(text)) return text;
    return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * 生成 chown 命令。
 *
 * - 只填 owner → `chown user path`（组不动）
 * - 只填 group → `chown :group path`
 * - 都填 → `chown user:group path`
 * - 都空 → 不执行（调用方应视为「本次没有改所有者」）
 */
export function buildChownCommand(path: string, targets: ChownTargets): ChownCommandResult {
    const owner = (targets.owner || '').trim();
    const group = (targets.group || '').trim();

    if (!owner && !group) return { command: null, error: 'emptyTargets' };
    if (owner && !isValidChownName(owner)) return { command: null, error: 'invalidOwner' };
    if (group && !isValidChownName(group)) return { command: null, error: 'invalidGroup' };

    const spec = owner && group ? `${owner}:${group}` : (owner ? owner : `:${group}`);
    const targetPath = (path || '').trim();
    if (!targetPath) return { command: null, error: 'emptyTargets', spec };

    // `--` 兜底：万一路径以 `-` 开头，也不会被 chown 当成选项
    return { command: `chown -- ${shellQuote(spec)} ${shellQuote(targetPath)}`, spec };
}
