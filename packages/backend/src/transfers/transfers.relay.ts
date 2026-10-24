/**
 * 「经由本机中转」的服务器间传输（relay）
 *
 * 为什么需要它：
 *   `rsync` / `scp` 路线要求**源服务器**上具备相应工具与认证材料 ——
 *   目标机用密码登录时源机必须有 `sshpass`，目标机用带 passphrase 的私钥时还要求
 *   `sshpass` 能应答 passphrase 提示，目标机用密钥时则要把私钥临时落到源机 `/tmp`。
 *   最小化安装的 VPS 上 `sshpass` 基本都是缺的，于是「源机密钥登录 + 目标机密码登录」
 *   这种组合会直接报错，源机没有 scp/rsync 的极简系统更是一条路都走不通。
 *
 *   这里换成最原始也最通用的办法：后端同时握住源与目标两条 SFTP 会话，
 *   把字节读出来再写进去。**完全不依赖源机上的任何命令**，密码 / 私钥 / passphrase 一律无感。
 *
 * 代价：流量要过一次后端。所以它只当兜底，rsync 能跑就跑 rsync。
 *
 * ⚠️ 本文件刻意不 import 仓库里的其它模块 —— 只依赖 `ssh2` 的类型。
 * 后端测试用 `node --experimental-strip-types` 直接跑 TS，那个 loader 解析相对 import
 * 时要求写全扩展名，而 `tsc` 的 build 又不允许 `.ts` 后缀。自包含就没有这个矛盾。
 */
import type { SFTPWrapper, Stats } from 'ssh2';

export interface RelayEntry {
    /** 源机上的绝对路径 */
    remotePath: string;
    /** 相对传输根的路径，根目录自身为空串 */
    relativePath: string;
    size: number;
    mode?: number;
    isDirectory: boolean;
}

export interface RelayProgressHandler {
    /** @param transferred 已传字节数 @param total 总字节数 @param currentPath 刚完成的条目 */
    (transferred: number, total: number, currentPath: string): void;
}

/**
 * 远程路径拼接。
 *
 * ⚠️ 一律手拼 `/`，不要用 `path.join` —— 后端可能跑在 Windows（桌面端内置后端），
 * `path.join('/a', 'b')` 会变成 `\a\b`，而 SFTP 只认 `/`。项目里到处 `.replace(/\\/g, '/')`
 * 都是在补这个洞，新代码别再制造一份。
 */
export function joinRemotePath(base: string, name: string): string {
    if (!name) return base;
    if (!base) return name;
    return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new DOMException('Transfer cancelled by user.', 'AbortError');
    }
}

function statRemote(sftp: SFTPWrapper, targetPath: string): Promise<Stats> {
    return new Promise((resolve, reject) => {
        sftp.lstat(targetPath, (error, stats) => {
            if (error) return reject(error);
            resolve(stats);
        });
    });
}

function readdirRemote(sftp: SFTPWrapper, targetPath: string): Promise<Array<{ filename: string; attrs: Stats }>> {
    return new Promise((resolve, reject) => {
        sftp.readdir(targetPath, (error, list) => {
            if (error) return reject(error);
            resolve((list ?? []) as Array<{ filename: string; attrs: Stats }>);
        });
    });
}

/** 建目录；已存在且是目录就当成功（mkdir -p 语义，逐级补父目录） */
async function ensureRemoteDir(sftp: SFTPWrapper, targetPath: string): Promise<void> {
    const normalized = targetPath.replace(/\/+$/, '') || '/';
    if (normalized === '/') return;

    let current = '';
    for (const segment of normalized.split('/').filter(Boolean)) {
        current += `/${segment}`;
        await new Promise<void>((resolve, reject) => {
            sftp.mkdir(current, (mkdirError) => {
                if (!mkdirError) return resolve();
                // 已存在（EEXIST / 4）也放行，只要它确实是目录
                sftp.lstat(current, (statError, stats) => {
                    if (!statError && stats?.isDirectory()) return resolve();
                    reject(mkdirError);
                });
            });
        });
    }
}

/**
 * 递归收集要传的条目（先扫一遍，才能算百分比）。
 *
 * 符号链接一律跳过：`rsync -a` 会保留链接本身，而 relay 只能读目标内容，
 * 跟过去可能把整个外挂盘的树拉进来。跳过并上报更安全。
 */
export async function collectRelayEntries(
    sftp: SFTPWrapper,
    rootPath: string,
    isDirectory: boolean,
    signal?: AbortSignal,
    onSkipUnsupported?: (path: string) => void
): Promise<RelayEntry[]> {
    const entries: RelayEntry[] = [];

    const pushEntry = (remotePath: string, relativePath: string, stats: Stats): void => {
        entries.push({
            remotePath,
            relativePath,
            size: stats.isDirectory() ? 0 : (stats.size ?? 0),
            mode: stats.mode,
            isDirectory: stats.isDirectory(),
        });
    };

    const walk = async (absPath: string, relativePath: string): Promise<void> => {
        throwIfAborted(signal);
        const stats = await statRemote(sftp, absPath);

        if (stats.isSymbolicLink()) {
            onSkipUnsupported?.(absPath);
            return;
        }
        if (!stats.isDirectory() && !stats.isFile()) {
            onSkipUnsupported?.(absPath);
            return;
        }

        pushEntry(absPath, relativePath, stats);
        if (!stats.isDirectory()) return;

        const items = await readdirRemote(sftp, absPath);
        // 排序只为日志/进度稳定，不影响正确性
        items.sort((left, right) => left.filename.localeCompare(right.filename));

        for (const item of items) {
            throwIfAborted(signal);
            const childPath = joinRemotePath(absPath, item.filename);
            const childRelative = joinRemotePath(relativePath, item.filename);

            // readdir 返回的是 lstat 语义的 attrs，能省掉一次往返
            const attrs = item.attrs;
            if (attrs?.isSymbolicLink() || (!attrs?.isDirectory() && !attrs?.isFile())) {
                onSkipUnsupported?.(childPath);
                continue;
            }
            if (attrs.isDirectory()) {
                await walk(childPath, childRelative);
            } else {
                pushEntry(childPath, childRelative, attrs);
            }
        }
    };

    await walk(rootPath, '');

    if (!isDirectory && entries.length > 0) {
        // 单文件：根条目本身就是那个文件，relativePath 留空由调用方拼目标名
        entries[0].relativePath = '';
    }

    return entries;
}

function createSftp(client: { sftp: (callback: (error: Error | undefined, sftp: SFTPWrapper) => void) => void }): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
        client.sftp((error, sftp) => {
            if (error) return reject(error);
            if (!sftp) return reject(new Error('无法建立 SFTP 会话'));
            resolve(sftp);
        });
    });
}

function copyStream(
    sftpIn: SFTPWrapper,
    sftpOut: SFTPWrapper,
    fromPath: string,
    toPath: string,
    onBytes: (bytes: number) => void,
    signal?: AbortSignal
): Promise<void> {
    return new Promise((resolve, reject) => {
        throwIfAborted(signal);

        const readStream = sftpIn.createReadStream(fromPath);
        const writeStream = sftpOut.createWriteStream(toPath);
        let settled = false;

        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            readStream.destroy();
            writeStream.destroy();
            reject(error);
        };

        const onAbort = () => fail(new DOMException('Transfer cancelled by user.', 'AbortError'));
        signal?.addEventListener('abort', onAbort, { once: true });

        readStream.on('error', (error: Error) => fail(new Error(`读取源文件失败 ${fromPath}: ${error.message}`)));
        writeStream.on('error', (error: Error) => fail(new Error(`写入目标文件失败 ${toPath}: ${error.message}`)));
        readStream.on('data', (chunk: Buffer) => onBytes(chunk.length));

        writeStream.on('close', () => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            resolve();
        });

        readStream.pipe(writeStream);
    });
}

function chmodQuiet(sftp: SFTPWrapper, targetPath: string, mode?: number): Promise<void> {
    // mode 里带着文件类型位（S_IFREG 等），chmod 只要权限位
    if (!mode) return Promise.resolve();
    const permissionBits = mode & 0o7777;
    return new Promise((resolve) => {
        sftp.chmod(targetPath, permissionBits, () => resolve());
    });
}

/** 简单的并发池：SFTP 每个文件都要一次 open/close 往返，串行在几千个小文件上会很慢 */
async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>,
    signal?: AbortSignal
): Promise<void> {
    let cursor = 0;
    const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
        while (cursor < items.length) {
            throwIfAborted(signal);
            const index = cursor++;
            await worker(items[index]);
        }
    });
    await Promise.all(runners);
}

export interface RelayTransferOptions {
    sourceSftp: SFTPWrapper;
    targetSftp: SFTPWrapper;
    /** 源机上要传的文件/目录绝对路径 */
    sourcePath: string;
    isDirectory: boolean;
    /** 目标机上的**父目录**（与 rsync/scp 语义一致，最终落在 <父目录>/<名字>） */
    targetParentDir: string;
    onProgress?: RelayProgressHandler;
    onPreparing?: (message: string) => void;
    signal?: AbortSignal;
}

export interface RelayTransferResult {
    bytes: number;
    files: number;
    skippedUnsupported: number;
}

/**
 * 把 `sourcePath` 整个搬到 `targetParentDir` 下（保留条目自身的名字）。
 */
export async function relayTransfer(options: RelayTransferOptions): Promise<RelayTransferResult> {
    const { sourceSftp, targetSftp, sourcePath, isDirectory, targetParentDir, onProgress, onPreparing, signal } = options;

    throwIfAborted(signal);
    onPreparing?.('Scanning source entries...');

    let skippedUnsupported = 0;
    const entries = await collectRelayEntries(sourceSftp, sourcePath, isDirectory, signal, (skipped) => {
        skippedUnsupported++;
        console.warn(`[TransfersRelay] 跳过不支持的条目 ${skipped}`);
    });

    throwIfAborted(signal);

    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    const files = entries.filter((entry) => !entry.isDirectory);
    const directories = entries.filter((entry) => entry.isDirectory);

    await ensureRemoteDir(targetSftp, targetParentDir);
    throwIfAborted(signal);

    const rootName = sourcePath.replace(/\/+$/, '').split('/').pop() || '';
    const targetRoot = rootName ? joinRemotePath(targetParentDir, rootName) : targetParentDir;

    // 目录先于文件建好
    for (const directory of directories) {
        throwIfAborted(signal);
        const destination = directory.relativePath
            ? joinRemotePath(targetRoot, directory.relativePath)
            : targetRoot;
        await ensureRemoteDir(targetSftp, destination);
        await chmodQuiet(targetSftp, destination, directory.mode);
    }

    let transferredBytes = 0;
    let completedFiles = 0;
    let lastReportAt = 0;

    const report = (currentPath: string, force = false) => {
        if (!onProgress) return;
        const now = Date.now();
        if (!force && now - lastReportAt < 200) return;
        lastReportAt = now;
        onProgress(transferredBytes, totalBytes, currentPath);
    };

    await runWithConcurrency(
        files,
        4,
        async (file) => {
            throwIfAborted(signal);
            const destination = joinRemotePath(targetRoot, file.relativePath);
            await copyStream(
                sourceSftp,
                targetSftp,
                file.remotePath,
                destination,
                (bytes) => {
                    transferredBytes += bytes;
                    report(file.relativePath);
                },
                signal
            );
            await chmodQuiet(targetSftp, destination, file.mode);
            completedFiles++;
            report(file.relativePath, true);
        },
        signal
    );

    // 总字节为 0（空目录/空文件）时也要把进度推满
    onProgress?.(totalBytes, totalBytes, '');

    return { bytes: transferredBytes, files: completedFiles, skippedUnsupported };
}

export { createSftp };
