// packages/backend/src/sftp/services/external-open.transfer.ts
import fs from 'fs';
import { Stats } from 'ssh2';
import { ClientState } from '../../websocket/types';
import { isSftpNotFoundError } from './sftp-helper';

/**
 * 「桌面端外部打开」相关的远程 ⇄ 本地文件搬运。
 *
 * 三种协议共用一套语义：SFTP 走 stream / fastPut，SCP 走 cat。
 * 这些函数都被 open-external 接口与回传监听（watcher）共用，别再各自实现一份。
 */

/** 把远程文件写到本地（返回字节数）。非普通文件抛 'NOT_A_FILE'。 */
export async function downloadRemoteFileToLocal(
    state: ClientState,
    remotePath: string,
    localPath: string
): Promise<number> {
    let bytes = 0;

    if (state.activeFileProtocol === 'scp') {
        const escapedPath = shellQuote(remotePath);
        await new Promise<void>((resolve, reject) => {
            state.sshClient.exec(`cat -- ${escapedPath}`, (err, stream) => {
                if (err) { reject(err); return; }
                const writeStream = fs.createWriteStream(localPath);
                stream.on('data', (chunk: Buffer) => { bytes += chunk.length; });
                stream.on('error', (streamErr: Error) => {
                    writeStream.destroy();
                    reject(streamErr);
                });
                writeStream.on('error', reject);
                writeStream.on('finish', () => resolve());
                stream.pipe(writeStream);
            });
        });
        return bytes;
    }

    const sftp = state.sftp;
    if (!sftp) throw new Error('SFTP 通道尚未就绪');

    // 先确认是普通文件（目录用系统程序打开没有意义）
    const stats = await new Promise<Stats>((resolve, reject) => {
        sftp.lstat(remotePath, (statErr: Error | undefined, stat: Stats) => {
            if (statErr) { reject(statErr); return; }
            resolve(stat);
        });
    });
    if (!stats.isFile()) {
        throw new Error('NOT_A_FILE');
    }

    await new Promise<void>((resolve, reject) => {
        const readStream = sftp.createReadStream(remotePath);
        const writeStream = fs.createWriteStream(localPath);
        readStream.on('data', (chunk: Buffer) => { bytes += chunk.length; });
        readStream.on('error', (readErr: Error) => {
            writeStream.destroy();
            reject(readErr);
        });
        writeStream.on('error', reject);
        writeStream.on('finish', () => resolve());
        readStream.pipe(writeStream);
    });
    return bytes;
}

/** 把本地文件覆盖写回远程。 */
export async function uploadLocalFileToRemote(
    state: ClientState,
    localPath: string,
    remotePath: string
): Promise<void> {
    if (state.activeFileProtocol === 'scp') {
        const escapedPath = shellQuote(remotePath);
        await new Promise<void>((resolve, reject) => {
            state.sshClient.exec(`cat > ${escapedPath}`, (err, stream) => {
                if (err) { reject(err); return; }
                const readStream = fs.createReadStream(localPath);
                readStream.on('error', reject);
                stream.on('error', reject);
                stream.on('close', (code: number | null) => {
                    if (code === 0 || code === null || code === undefined) resolve();
                    else reject(new Error(`SCP 上传失败（退出码 ${code}）`));
                });
                readStream.pipe(stream);
            });
        });
        return;
    }

    const sftp = state.sftp;
    if (!sftp) throw new Error('SFTP 通道尚未就绪');
    await new Promise<void>((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (err: Error | null | undefined) => {
            if (err) { reject(err); return; }
            resolve();
        });
    });
}

/**
 * 读远程文件的修改时间（秒级，SFTP attrs.mtime 本来就是秒）。
 * 拿不到（路径不存在 / 命令失败）返回 null，由调用方按"不判定冲突"处理。
 */
export async function getRemoteMtimeSeconds(
    state: ClientState,
    remotePath: string
): Promise<number | null> {
    if (state.activeFileProtocol === 'scp') {
        const escapedPath = shellQuote(remotePath);
        return new Promise<number | null>((resolve) => {
            state.sshClient.exec(`export LC_ALL=C; stat -c %Y -- ${escapedPath}`, (err, stream) => {
                if (err) { resolve(null); return; }
                let out = '';
                stream.on('data', (chunk: Buffer) => { out += chunk.toString(); });
                stream.on('close', () => {
                    const parsed = parseInt(out.trim(), 10);
                    resolve(Number.isFinite(parsed) ? parsed : null);
                });
            });
        });
    }

    const sftp = state.sftp;
    if (!sftp) return null;
    return new Promise<number | null>((resolve) => {
        sftp.lstat(remotePath, (err: Error | undefined, stats: Stats) => {
            if (err) {
                if (!isSftpNotFoundError(err)) {
                    console.warn(`[ExternalOpen] 读取远程 mtime 失败: ${remotePath}`, err.message);
                }
                resolve(null);
                return;
            }
            const mtime = Number(stats.mtime);
            resolve(Number.isFinite(mtime) ? mtime : null);
        });
    });
}

/** POSIX 单引号转义：远程路径里可能有空格 / 引号 */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
