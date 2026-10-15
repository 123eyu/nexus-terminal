import { Client, ClientChannel } from 'ssh2';
import { ClientState } from '../../websocket/types';
import * as jschardet from 'jschardet';
import * as iconv from 'iconv-lite';

export interface ScpFileItem {
    filename: string;
    longname: string;
    attrs: {
        size: number;
        uid: number;
        gid: number;
        mode: number;
        atime: number;
        mtime: number;
        isDirectory: boolean;
        isFile: boolean;
        isSymbolicLink: boolean;
    };
}

/**
 * 将权限字符串 (如 drwxr-xr-x) 转换为 Unix mode 数字
 */
export function parseModeFromString(permStr: string): number {
    if (!permStr || permStr.length < 10) return 0;
    let mode = 0;

    // 文件类型掩码 (POSIX stat constants)
    const typeChar = permStr[0];
    if (typeChar === 'd') mode |= 0o040000;      // S_IFDIR
    else if (typeChar === 'l') mode |= 0o120000; // S_IFLNK
    else if (typeChar === 'c') mode |= 0o020000; // S_IFCHR
    else if (typeChar === 'b') mode |= 0o060000; // S_IFBLK
    else if (typeChar === 'p') mode |= 0o010000; // S_IFIFO
    else if (typeChar === 's') mode |= 0o140000; // S_IFSOCK
    else mode |= 0o100000;                       // S_IFREG (普通文件)

    // Owner (rwx)
    if (permStr[1] === 'r') mode |= 0o400;
    if (permStr[2] === 'w') mode |= 0o200;
    if (permStr[3] === 'x') mode |= 0o100;
    else if (permStr[3] === 's') mode |= 0o4100;
    else if (permStr[3] === 'S') mode |= 0o4000;

    // Group (rwx)
    if (permStr[4] === 'r') mode |= 0o040;
    if (permStr[5] === 'w') mode |= 0o020;
    if (permStr[6] === 'x') mode |= 0o010;
    else if (permStr[6] === 's') mode |= 0o2010;
    else if (permStr[6] === 'S') mode |= 0o2000;

    // Others (rwx)
    if (permStr[7] === 'r') mode |= 0o004;
    if (permStr[8] === 'w') mode |= 0o002;
    if (permStr[9] === 'x') mode |= 0o001;
    else if (permStr[9] === 't') mode |= 0o1001;
    else if (permStr[9] === 'T') mode |= 0o1000;

    return mode;
}

/**
 * 解析各种格式的 Unix 时间字符串，转换为毫秒时间戳
 */
export function parseUnixDate(dateStr: string): number {
    try {
        // 尝试格式：YYYY-MM-DD HH:mm
        if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
            const parsed = new Date(dateStr).getTime();
            if (!isNaN(parsed)) return parsed;
        }

        // 标准 POSIX ls 格式：MMM DD HH:mm 或 MMM DD YYYY (如 Oct 15 12:30 或 Oct 15 2025)
        const parts = dateStr.trim().split(/\s+/);
        if (parts.length >= 3) {
            const monthStr = parts[0];
            const day = parseInt(parts[1], 10);
            const timeOrYear = parts[2];
            const now = new Date();
            const currentYear = now.getFullYear();

            const monthMap: Record<string, number> = {
                Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
                Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
            };
            const month = monthMap[monthStr] ?? now.getMonth();

            if (timeOrYear.includes(':')) {
                const [hour, minute] = timeOrYear.split(':').map(Number);
                const d = new Date(currentYear, month, day, hour || 0, minute || 0, 0);
                // 如果解析出来的月份在未来超过半年，说明是去年的文件
                if (d.getTime() > now.getTime() + 86400000 * 2) {
                    d.setFullYear(currentYear - 1);
                }
                return d.getTime();
            } else {
                const year = parseInt(timeOrYear, 10);
                return new Date(year || currentYear, month, day, 0, 0, 0).getTime();
            }
        }
    } catch {
        // 忽略解析错误，回退到当前时间
    }
    return Date.now();
}

/**
 * 解析兼容 Linux / BusyBox 的 `ls -lan` 输出行
 */
export function parseLsLine(line: string): ScpFileItem | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('total ') || trimmed.startsWith('总用量 ')) {
        return null;
    }

    // 匹配: 权限 (10字符) 链接数 UID GID 大小 日期... 文件名
    // 支持标准 ls: drwxr-xr-x 2 0 0 4096 Oct 15 11:30 filename
    // 支持 BusyBox: drwxr-xr-x 2 0 0 4096 2026-10-15 11:30 filename
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 8) return null;

    const permStr = tokens[0];
    if (permStr.length !== 10) return null;

    const typeChar = permStr[0];
    const isDirectory = typeChar === 'd';
    const isSymbolicLink = typeChar === 'l';
    const isFile = typeChar === '-';

    const uid = parseInt(tokens[2], 10) || 0;
    const gid = parseInt(tokens[3], 10) || 0;
    const size = parseInt(tokens[4], 10) || 0;

    let dateStr = '';
    let filenameIndex = 5;

    // 判断日期是 2 段 (2026-10-15 11:30) 还是 3 段 (Oct 15 11:30 / Oct 15 2025)
    if (/^\d{4}-\d{2}-\d{2}$/.test(tokens[5])) {
        dateStr = `${tokens[5]} ${tokens[6]}`;
        filenameIndex = 7;
    } else {
        dateStr = `${tokens[5]} ${tokens[6]} ${tokens[7]}`;
        filenameIndex = 8;
    }

    if (filenameIndex > tokens.length) return null;

    let rawFilename = tokens.slice(filenameIndex).join(' ');
    if (rawFilename === '.' || rawFilename === '..') {
        return null;
    }

    // 处理软链接情况: link_name -> /target/path
    let filename = rawFilename;
    if (isSymbolicLink && rawFilename.includes(' -> ')) {
        filename = rawFilename.split(' -> ')[0].trim();
    }

    const mode = parseModeFromString(permStr);
    const mtime = parseUnixDate(dateStr);

    return {
        filename,
        longname: trimmed,
        attrs: {
            size,
            uid,
            gid,
            mode,
            atime: mtime,
            mtime,
            isDirectory,
            isFile,
            isSymbolicLink
        }
    };
}

/**
 * 基于 SSH Exec + SCP 的远程文件驱动服务 (ScpFileService)
 * 专门适配小米路由器、精简版 OpenWrt 与 BusyBox 等未安装 openssh-sftp-server 的嵌入式设备。
 * 对外统一输出与 SftpFileService 一致的 WebSocket 事件与数据载荷，实现前端零修改透明复用。
 */
export class ScpFileService {
    constructor(private clientStates: Map<string, ClientState>) {}

    /**
     * 辅助执行 SSH 命令并捕获完整输出
     */
    private execCommand(sshClient: Client, command: string, inputBuffer?: Buffer): Promise<{ stdout: Buffer; stderr: string; code: number }> {
        return new Promise((resolve, reject) => {
            sshClient.exec(command, (err, stream: ClientChannel) => {
                if (err) return reject(err);

                const stdoutChunks: Buffer[] = [];
                let stderr = '';

                stream.on('data', (chunk: Buffer) => {
                    stdoutChunks.push(chunk);
                });

                stream.stderr.on('data', (data: Buffer) => {
                    stderr += data.toString();
                });

                stream.on('close', (code: number | null) => {
                    resolve({
                        stdout: Buffer.concat(stdoutChunks),
                        stderr,
                        code: code ?? 0
                    });
                });

                stream.on('error', (streamErr: Error) => {
                    reject(streamErr);
                });

                if (inputBuffer && inputBuffer.length > 0) {
                    stream.write(inputBuffer);
                    stream.end();
                } else if (inputBuffer) {
                    stream.end();
                }
            });
        });
    }

    /**
     * 转义 shell 参数中的单引号，安全包裹在单引号中
     */
    private escapePath(filePath: string): string {
        return `'${filePath.replace(/'/g, "'\\''")}'`;
    }

    /**
     * 将任意相对路径或绝对路径规范化为标准绝对路径
     * 解决前端在未获得默认绝对路径时回退到 '.'，后续产生 './bin'、'./file' 等相对路径导致 BusyBox/Dropbear 报错
     */
    private normalizePath(filePath: string): string {
        if (!filePath || filePath.trim() === '' || filePath.trim() === '.') {
            return '/';
        }
        let p = filePath.trim();
        // 处理 ./ 开头
        if (p.startsWith('./')) {
            p = '/' + p.slice(2);
        }
        // 处理非 / 开头
        if (!p.startsWith('/')) {
            p = '/' + p;
        }
        // 压缩连续斜杠
        p = p.replace(/\/+/g, '/');
        // 去除末尾斜杠 (根目录除外)
        if (p.length > 1 && p.endsWith('/')) {
            p = p.slice(0, -1);
        }
        return p;
    }

    /**
     * 读取目录列表 (兼容 BusyBox 的 ls -lan)
     */
    async readdir(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient) {
            console.warn(`[SCP ${sessionId}] SSH 客户端未就绪，无法执行 readdir (ID: ${requestId})`);
            state?.ws.send(JSON.stringify({ type: 'sftp:readdir:error', path, payload: 'SSH 会话未就绪', requestId }));
            return;
        }

        const normPath = this.normalizePath(path);
        console.debug(`[SCP ${sessionId}] readdir 开始: ${path} -> ${normPath} (ID: ${requestId})`);

        try {
            // 在 BusyBox / Linux 执行兼容的 ls 命令 (不使用 -- 以免精简版 BusyBox 报错 unrecognized option)
            const cmd = `export LC_ALL=C; ls -lan ${this.escapePath(normPath)}`;
            const result = await this.execCommand(state.sshClient, cmd);

            if (result.code !== 0) {
                const errMsg = result.stderr.trim() || `ls 命令退出码: ${result.code}`;
                console.error(`[SCP ${sessionId}] readdir 失败: ${errMsg}`);
                state.ws.send(JSON.stringify({ type: 'sftp:readdir:error', path: normPath, payload: `读取目录失败: ${errMsg}`, requestId }));
                return;
            }

            const outputStr = result.stdout.toString('utf-8');
            const lines = outputStr.split(/\r?\n/);
            const files: ScpFileItem[] = [];

            for (const line of lines) {
                const item = parseLsLine(line);
                if (item) {
                    files.push(item);
                }
            }

            console.log(`[SCP ${sessionId}] readdir 成功: ${normPath}, 提取到 ${files.length} 个条目 (ID: ${requestId})`);
            state.ws.send(JSON.stringify({ type: 'sftp:readdir:success', path: normPath, payload: files, requestId }));
        } catch (error: any) {
            console.error(`[SCP ${sessionId}] readdir 异常:`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:readdir:error', path: normPath, payload: `读取目录发生异常: ${error.message}`, requestId }));
        }
    }

    /**
     * 获取文件或目录属性 (兼容 ls -land)
     */
    async stat(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient) {
            state?.ws.send(JSON.stringify({ type: 'sftp:stat:error', path, payload: 'SSH 会话未就绪', requestId }));
            return;
        }

        const normPath = this.normalizePath(path);
        console.debug(`[SCP ${sessionId}] stat 开始: ${path} -> ${normPath} (ID: ${requestId})`);
        try {
            const cmd = `export LC_ALL=C; ls -land ${this.escapePath(normPath)}`;
            const result = await this.execCommand(state.sshClient, cmd);

            if (result.code !== 0) {
                const errMsg = result.stderr.trim() || `未找到文件或目录: ${normPath}`;
                state.ws.send(JSON.stringify({ type: 'sftp:stat:error', path: normPath, payload: errMsg, requestId }));
                return;
            }

            const lines = result.stdout.toString('utf-8').trim().split(/\r?\n/);
            const item = lines.length > 0 ? parseLsLine(lines[0]) : null;

            if (!item) {
                state.ws.send(JSON.stringify({ type: 'sftp:stat:error', path: normPath, payload: '无法解析文件属性', requestId }));
                return;
            }

            state.ws.send(JSON.stringify({ type: 'sftp:stat:success', path: normPath, payload: item.attrs, requestId }));
        } catch (error: any) {
            console.error(`[SCP ${sessionId}] stat 异常:`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:stat:error', path: normPath, payload: `获取状态发生异常: ${error.message}`, requestId }));
        }
    }

    /**
     * 读取文件内容 (支持文本编码自动探测)
     */
    async readFile(sessionId: string, path: string, requestId: string, requestedEncoding?: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient) {
            state?.ws.send(JSON.stringify({ type: 'sftp:readfile:error', path, payload: 'SSH 会话未就绪', requestId }));
            return;
        }

        const normPath = this.normalizePath(path);
        console.debug(`[SCP ${sessionId}] readFile 开始: ${path} -> ${normPath} (ID: ${requestId})`);
        try {
            const cmd = `cat ${this.escapePath(normPath)}`;
            const result = await this.execCommand(state.sshClient, cmd);

            if (result.code !== 0) {
                const errMsg = result.stderr.trim() || `读取文件失败，退出码: ${result.code}`;
                state.ws.send(JSON.stringify({ type: 'sftp:readfile:error', path: normPath, payload: errMsg, requestId }));
                return;
            }

            const fileData = result.stdout;
            let encodingUsed: string = 'utf-8';
            let decodedContent: string = '';
            let decodeError: string | null = null;

            try {
                if (requestedEncoding) {
                    if (iconv.encodingExists(requestedEncoding)) {
                        decodedContent = iconv.decode(fileData, requestedEncoding);
                        encodingUsed = requestedEncoding;
                    } else {
                        decodedContent = fileData.toString('utf-8');
                        encodingUsed = 'utf-8';
                    }
                } else {
                    const detected = jschardet.detect(fileData);
                    let targetEncoding = 'utf-8';
                    if (detected && detected.encoding && detected.confidence > 0.8) {
                        const normalized = detected.encoding.toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (iconv.encodingExists(normalized)) {
                            targetEncoding = normalized;
                        }
                    }
                    decodedContent = iconv.decode(fileData, targetEncoding);
                    encodingUsed = targetEncoding;
                }
            } catch (decErr: any) {
                decodedContent = fileData.toString('utf-8');
                encodingUsed = 'utf-8';
                decodeError = decErr.message;
            }

            state.ws.send(JSON.stringify({
                type: 'sftp:readfile:success',
                path: normPath,
                payload: {
                    content: decodedContent,
                    encoding: encodingUsed,
                    decodeError
                },
                requestId
            }));
        } catch (error: any) {
            console.error(`[SCP ${sessionId}] readFile 异常:`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:readfile:error', path: normPath, payload: `读取文件发生异常: ${error.message}`, requestId }));
        }
    }

    /**
     * 写入文件内容 (通过 SSH 管道流式写入)
     */
    async writefile(sessionId: string, path: string, data: string, requestId: string, encoding?: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient) {
            state?.ws.send(JSON.stringify({ type: 'sftp:writefile:error', path, payload: 'SSH 会话未就绪', requestId }));
            return;
        }

        const normPath = this.normalizePath(path);
        const targetEncoding = encoding || 'utf-8';
        console.debug(`[SCP ${sessionId}] writefile 开始: ${path} -> ${normPath} (ID: ${requestId}, 编码: ${targetEncoding})`);

        try {
            let buffer: Buffer;
            try {
                buffer = iconv.encode(data, targetEncoding);
            } catch (encErr: any) {
                state.ws.send(JSON.stringify({ type: 'sftp:writefile:error', path: normPath, payload: `编码失败: ${encErr.message}`, requestId }));
                return;
            }

            // 通过 cat > 文件写入
            const cmd = `cat > ${this.escapePath(normPath)}`;
            const result = await this.execCommand(state.sshClient, cmd, buffer);

            if (result.code !== 0) {
                const errMsg = result.stderr.trim() || `写入失败，退出码: ${result.code}`;
                state.ws.send(JSON.stringify({ type: 'sftp:writefile:error', path: normPath, payload: errMsg, requestId }));
                return;
            }

            // 获取写入后的最新文件属性
            const statCmd = `export LC_ALL=C; ls -land ${this.escapePath(normPath)}`;
            const statResult = await this.execCommand(state.sshClient, statCmd);
            let updatedItem: ScpFileItem | null = null;
            if (statResult.code === 0) {
                const lines = statResult.stdout.toString('utf-8').trim().split(/\r?\n/);
                if (lines.length > 0) {
                    updatedItem = parseLsLine(lines[0]);
                }
            }

            state.ws.send(JSON.stringify({ type: 'sftp:writefile:success', path: normPath, payload: updatedItem, requestId }));
        } catch (error: any) {
            console.error(`[SCP ${sessionId}] writefile 异常:`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:writefile:error', path: normPath, payload: `写入文件发生异常: ${error.message}`, requestId }));
        }
    }

    /**
     * 创建目录 (mkdir -p)
     */
    async mkdir(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient) {
            state?.ws.send(JSON.stringify({ type: 'sftp:mkdir:error', path, payload: 'SSH 会话未就绪', requestId }));
            return;
        }

        const normPath = this.normalizePath(path);
        console.debug(`[SCP ${sessionId}] mkdir 开始: ${path} -> ${normPath} (ID: ${requestId})`);
        try {
            const cmd = `mkdir -p ${this.escapePath(normPath)}`;
            const result = await this.execCommand(state.sshClient, cmd);

            if (result.code !== 0) {
                const errMsg = result.stderr.trim() || `创建目录失败，退出码: ${result.code}`;
                state.ws.send(JSON.stringify({ type: 'sftp:mkdir:error', path: normPath, payload: errMsg, requestId }));
                return;
            }

            // 获取新创建目录的属性
            const statCmd = `export LC_ALL=C; ls -land ${this.escapePath(normPath)}`;
            const statResult = await this.execCommand(state.sshClient, statCmd);
            let newItem: ScpFileItem | null = null;
            if (statResult.code === 0) {
                const lines = statResult.stdout.toString('utf-8').trim().split(/\r?\n/);
                if (lines.length > 0) {
                    newItem = parseLsLine(lines[0]);
                }
            }

            state.ws.send(JSON.stringify({ type: 'sftp:mkdir:success', path: normPath, payload: newItem, requestId }));
        } catch (error: any) {
            console.error(`[SCP ${sessionId}] mkdir 异常:`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:mkdir:error', path: normPath, payload: `创建目录发生异常: ${error.message}`, requestId }));
        }
    }

    /**
     * 删除目录 (rm -rf)
     */
    async rmdir(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient) {
            state?.ws.send(JSON.stringify({ type: 'sftp:rmdir:error', path, payload: 'SSH 会话未就绪', requestId }));
            return;
        }

        const normPath = this.normalizePath(path);
        console.debug(`[SCP ${sessionId}] rmdir 开始: ${path} -> ${normPath} (ID: ${requestId})`);
        try {
            const cmd = `rm -rf ${this.escapePath(normPath)}`;
            const result = await this.execCommand(state.sshClient, cmd);

            if (result.code !== 0) {
                const errMsg = result.stderr.trim() || `删除目录失败，退出码: ${result.code}`;
                state.ws.send(JSON.stringify({ type: 'sftp:rmdir:error', path: normPath, payload: errMsg, requestId }));
                return;
            }

            state.ws.send(JSON.stringify({ type: 'sftp:rmdir:success', path: normPath, requestId }));
        } catch (error: any) {
            console.error(`[SCP ${sessionId}] rmdir 异常:`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:rmdir:error', path: normPath, payload: `删除目录发生异常: ${error.message}`, requestId }));
        }
    }

    /**
     * 删除文件 (rm -f)
     */
    async unlink(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient) {
            state?.ws.send(JSON.stringify({ type: 'sftp:unlink:error', path, payload: 'SSH 会话未就绪', requestId }));
            return;
        }

        const normPath = this.normalizePath(path);
        console.debug(`[SCP ${sessionId}] unlink 开始: ${path} -> ${normPath} (ID: ${requestId})`);
        try {
            const cmd = `rm -f ${this.escapePath(normPath)}`;
            const result = await this.execCommand(state.sshClient, cmd);

            if (result.code !== 0) {
                const errMsg = result.stderr.trim() || `删除文件失败，退出码: ${result.code}`;
                state.ws.send(JSON.stringify({ type: 'sftp:unlink:error', path: normPath, payload: errMsg, requestId }));
                return;
            }

            state.ws.send(JSON.stringify({ type: 'sftp:unlink:success', path: normPath, requestId }));
        } catch (error: any) {
            console.error(`[SCP ${sessionId}] unlink 异常:`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:unlink:error', path: normPath, payload: `删除文件发生异常: ${error.message}`, requestId }));
        }
    }

    /**
     * 重命名/移动文件或目录 (mv)
     */
    async rename(sessionId: string, oldPath: string, newPath: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient) {
            state?.ws.send(JSON.stringify({ type: 'sftp:rename:error', oldPath, newPath, payload: 'SSH 会话未就绪', requestId }));
            return;
        }

        const normOldPath = this.normalizePath(oldPath);
        const normNewPath = this.normalizePath(newPath);
        console.debug(`[SCP ${sessionId}] rename 开始: ${oldPath} -> ${normOldPath} 至 ${newPath} -> ${normNewPath} (ID: ${requestId})`);
        try {
            const cmd = `mv ${this.escapePath(normOldPath)} ${this.escapePath(normNewPath)}`;
            const result = await this.execCommand(state.sshClient, cmd);

            if (result.code !== 0) {
                const errMsg = result.stderr.trim() || `重命名/移动失败，退出码: ${result.code}`;
                state.ws.send(JSON.stringify({ type: 'sftp:rename:error', oldPath: normOldPath, newPath: normNewPath, payload: errMsg, requestId }));
                return;
            }

            // 获取新路径属性
            const statCmd = `export LC_ALL=C; ls -land ${this.escapePath(normNewPath)}`;
            const statResult = await this.execCommand(state.sshClient, statCmd);
            let newItem: ScpFileItem | null = null;
            if (statResult.code === 0) {
                const lines = statResult.stdout.toString('utf-8').trim().split(/\r?\n/);
                if (lines.length > 0) {
                    newItem = parseLsLine(lines[0]);
                }
            }

            state.ws.send(JSON.stringify({
                type: 'sftp:rename:success',
                payload: { oldPath: normOldPath, newPath: normNewPath, newItem },
                requestId
            }));
        } catch (error: any) {
            console.error(`[SCP ${sessionId}] rename 异常:`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:rename:error', oldPath: normOldPath, newPath: normNewPath, payload: `重命名发生异常: ${error.message}`, requestId }));
        }
    }

    /**
     * 修改权限 (chmod)
     */
    async chmod(sessionId: string, path: string, mode: number | string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient) {
            state?.ws.send(JSON.stringify({ type: 'sftp:chmod:error', path, payload: 'SSH 会话未就绪', requestId }));
            return;
        }

        const normPath = this.normalizePath(path);
        // 格式化为八进制字符串 (如 755 或 0755)
        const octalMode = typeof mode === 'number' ? (mode & 0o777).toString(8) : String(mode);
        console.debug(`[SCP ${sessionId}] chmod 开始: ${path} -> ${normPath} (${octalMode}) (ID: ${requestId})`);

        try {
            const cmd = `chmod ${octalMode} ${this.escapePath(normPath)}`;
            const result = await this.execCommand(state.sshClient, cmd);

            if (result.code !== 0) {
                const errMsg = result.stderr.trim() || `修改权限失败，退出码: ${result.code}`;
                state.ws.send(JSON.stringify({ type: 'sftp:chmod:error', path: normPath, payload: errMsg, requestId }));
                return;
            }

            // 获取更新后属性
            const statCmd = `export LC_ALL=C; ls -land ${this.escapePath(normPath)}`;
            const statResult = await this.execCommand(state.sshClient, statCmd);
            let updatedItem: ScpFileItem | null = null;
            if (statResult.code === 0) {
                const lines = statResult.stdout.toString('utf-8').trim().split(/\r?\n/);
                if (lines.length > 0) {
                    updatedItem = parseLsLine(lines[0]);
                }
            }

            state.ws.send(JSON.stringify({ type: 'sftp:chmod:success', path: normPath, payload: updatedItem, requestId }));
        } catch (error: any) {
            console.error(`[SCP ${sessionId}] chmod 异常:`, error);
            state.ws.send(JSON.stringify({ type: 'sftp:chmod:error', path: normPath, payload: `修改权限发生异常: ${error.message}`, requestId }));
        }
    }

    /**
     * 解析真实路径 (全面对齐 SftpFileService 的数据结构与符号链接 targetType 探测)
     * 返回结构严格遵循: { requestedPath: path, absolutePath: resolvedPath, targetType: 'file' | 'directory' | 'unknown' }
     */
    async realpath(sessionId: string, path: string, requestId: string): Promise<void> {
        const state = this.clientStates.get(sessionId);
        if (!state || !state.sshClient) {
            state?.ws.send(JSON.stringify({
                type: 'sftp:realpath:error',
                path,
                payload: { requestedPath: path, error: 'SSH 会话未就绪' },
                requestId
            }));
            return;
        }

        const normPath = this.normalizePath(path);
        console.debug(`[SCP ${sessionId}] realpath 开始: ${path} -> ${normPath} (ID: ${requestId})`);

        try {
            // 如果请求的是根目录或默认家目录标识，直接返回根目录 '/'
            if (normPath === '/') {
                state.ws.send(JSON.stringify({
                    type: 'sftp:realpath:success',
                    path,
                    payload: {
                        requestedPath: path,
                        absolutePath: '/',
                        targetType: 'directory'
                    },
                    requestId
                }));
                return;
            }

            // 探测目标文件或目录是否存在并获取属性
            const cmd = `export LC_ALL=C; ls -land ${this.escapePath(normPath)}`;
            const result = await this.execCommand(state.sshClient, cmd);

            if (result.code !== 0) {
                const errMsg = result.stderr.trim() || `文件或目录不存在: ${normPath}`;
                state.ws.send(JSON.stringify({
                    type: 'sftp:realpath:error',
                    path,
                    payload: { requestedPath: path, error: errMsg },
                    requestId
                }));
                return;
            }

            const lines = result.stdout.toString('utf-8').trim().split(/\r?\n/);
            const item = lines.length > 0 ? parseLsLine(lines[0]) : null;

            let absolutePath = normPath;
            let targetType: 'file' | 'directory' | 'unknown' = 'unknown';

            if (item) {
                if (item.attrs.isSymbolicLink) {
                    // 处理符号链接：readlink -f (不带 -- 双横杠，避免精简版 BusyBox 报错)
                    const readlinkCmd = `readlink -f ${this.escapePath(normPath)} 2>/dev/null || echo ${this.escapePath(normPath)}`;
                    const readlinkResult = await this.execCommand(state.sshClient, readlinkCmd);
                    const resolvedTarget = readlinkResult.stdout.toString('utf-8').trim();
                    if (resolvedTarget) {
                        absolutePath = this.normalizePath(resolvedTarget);
                        // 探测符号链接指向的目标类型
                        const targetStatCmd = `export LC_ALL=C; ls -land ${this.escapePath(absolutePath)}`;
                        const targetStatRes = await this.execCommand(state.sshClient, targetStatCmd);
                        if (targetStatRes.code === 0) {
                            const targetLines = targetStatRes.stdout.toString('utf-8').trim().split(/\r?\n/);
                            const targetItem = targetLines.length > 0 ? parseLsLine(targetLines[0]) : null;
                            if (targetItem) {
                                targetType = targetItem.attrs.isDirectory ? 'directory' : (targetItem.attrs.isFile ? 'file' : 'unknown');
                            }
                        }
                    }
                } else {
                    targetType = item.attrs.isDirectory ? 'directory' : (item.attrs.isFile ? 'file' : 'unknown');
                }
            }

            console.log(`[SCP ${sessionId}] realpath 成功: ${path} -> ${absolutePath} (类型: ${targetType}, ID: ${requestId})`);
            state.ws.send(JSON.stringify({
                type: 'sftp:realpath:success',
                path,
                payload: {
                    requestedPath: path,
                    absolutePath,
                    targetType
                },
                requestId
            }));
        } catch (error: any) {
            console.error(`[SCP ${sessionId}] realpath 异常:`, error);
            state.ws.send(JSON.stringify({
                type: 'sftp:realpath:error',
                path,
                payload: { requestedPath: path, error: error.message },
                requestId
            }));
        }
    }
}
