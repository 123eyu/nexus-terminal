import { SFTPWrapper, Stats } from 'ssh2';
import * as pathModule from 'path';

export interface SftpDirEntry {
    filename: string;
    longname: string;
    attrs: Stats;
}

/**
 * 判断一个 SFTP 错误是否表示“路径不存在”。
 *
 * ssh2 客户端把 SFTP STATUS 码原样塞进 `err.code`（数值 2 = NO_SUCH_FILE），
 * 并不会转成 Node 的 'ENOENT'；而 `err.message` 是服务端给的自由文本
 * （OpenSSH 是 "No such file"，其它实现/本地化环境可能是别的写法）。
 * 所以三路任一命中都算“不存在”，否则重命名前的目标探测会把正常情况误判成故障。
 */
export function isSftpNotFoundError(err: any): boolean {
    if (!err) return false;
    if (err.code === 2 || err.code === 'NO_SUCH_FILE') return true;
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return true;
    return typeof err.message === 'string' && /no such file|not found|不存在/i.test(err.message);
}

/**
 * 获取文件或目录的 Stats 属性
 */
export function getStats(sftp: SFTPWrapper, targetPath: string): Promise<Stats> {
    return new Promise((resolve, reject) => {
        sftp.lstat(targetPath, (err, stats) => {
            if (err) {
                reject(err);
            } else {
                resolve(stats);
            }
        });
    });
}

/**
 * 递归确保目录存在，不存在则逐级创建
 */
export async function ensureDirectoryExists(sftp: SFTPWrapper, dirPath: string): Promise<void> {
    const normalizedPath = dirPath.replace(/\/$/, '');
    if (!normalizedPath || normalizedPath === '/') {
        return;
    }

    try {
        await getStats(sftp, normalizedPath);
        return;
    } catch (statError: any) {
        if (isSftpNotFoundError(statError)) {
            try {
                await new Promise<void>((resolveMkdir, rejectMkdir) => {
                    // @ts-ignore - 部分 ssh2 实现支持 recursive 参数
                    sftp.mkdir(normalizedPath, { recursive: true }, (mkdirErr: any) => {
                        if (mkdirErr) {
                            rejectMkdir(mkdirErr);
                        } else {
                            resolveMkdir();
                        }
                    });
                });
                return;
            } catch (recursiveMkdirError) {
                const parentDir = pathModule.dirname(normalizedPath).replace(/\\/g, '/');
                if (parentDir && parentDir !== '/' && parentDir !== '.') {
                    await ensureDirectoryExists(sftp, parentDir);
                }
                try {
                    await new Promise<void>((resolveMkdir, rejectMkdir) => {
                        sftp.mkdir(normalizedPath, (mkdirErr) => {
                            if (mkdirErr) {
                                rejectMkdir(new Error(`创建目录失败 ${normalizedPath}: ${mkdirErr.message}`));
                            } else {
                                resolveMkdir();
                            }
                        });
                    });
                } catch (iterativeMkdirError: any) {
                    try {
                        const finalStats = await getStats(sftp, normalizedPath);
                        if (!finalStats.isDirectory()) {
                            throw new Error(`路径 ${normalizedPath} 已存在但不是目录`);
                        }
                    } catch (finalStatError) {
                        throw iterativeMkdirError;
                    }
                }
            }
        } else {
            throw new Error(`检查目录失败 ${normalizedPath}: ${statError.message}`);
        }
    }
}

/**
 * 列出远程目录项
 */
export function listDirectory(sftp: SFTPWrapper, targetPath: string): Promise<SftpDirEntry[]> {
    return new Promise((resolve, reject) => {
        sftp.readdir(targetPath, (err, list) => {
            if (err) {
                reject(err);
            } else {
                resolve(list as SftpDirEntry[]);
            }
        });
    });
}

/**
 * 执行远程重命名或移动
 */
export function performRename(sftp: SFTPWrapper, oldPath: string, newPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.rename(oldPath, newPath, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

/**
 * 将远程文件 Stats 转换为文件列表格式返回对象
 */
export function formatStatsToFileListItem(itemPath: string, stats: Stats): any {
    return {
        filename: pathModule.basename(itemPath),
        longname: '',
        attrs: {
            size: stats.size,
            uid: stats.uid,
            gid: stats.gid,
            mode: stats.mode,
            atime: stats.atime * 1000,
            mtime: stats.mtime * 1000,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            isSymbolicLink: stats.isSymbolicLink(),
        }
    };
}
