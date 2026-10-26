import type { Client, SFTPWrapper } from 'ssh2';
import { SFTP as SftpProtocol } from 'ssh2/lib/protocol/SFTP.js';

/**
 * 用 `sudo sftp-server` 开一条 SFTP 通道。
 *
 * 为什么不能直接 `client.sftp()`：SSH 的 sftp 是一个**子系统请求**（subsystem: sftp），
 * 服务端由 sshd 直接 fork 出 sftp-server，权限就是登录用户，sudo 无法插在中间。
 * 想以 root 跑，只能自己 exec 一条 `sudo sftp-server`，再把这条 exec 通道的
 * stdin/stdout 当成 SFTP 协议的字节流用。
 *
 * 先试免密：
 *   `sudo -n /usr/lib/openssh/sftp-server`
 *   加 `-n` 是为了没有免密 sudo 时立刻失败，而不是卡在密码提示上等超时。
 *
 * 失败且用户填了密码，再试密码版：
 *   `sh -c 'IFS= read -r _p; { printf "%s\n" "$_p"; cat; } | exec sudo -S -p "" <path>'`
 *   第一行是密码，被 `read` 吃掉交给 sudo；之后 `cat` 把剩余字节原样转发给 sftp-server。
 *   密码不进命令行（不进 `ps`、不进 shell history），只走 stdin。
 *
 * ⚠️ 为什么靠「先跑一次」而不是事先探测 sudo 要不要密码：
 * 早期实现用 `sudo -n true` 猜，只要它失败就认为「要密码」。但最小权限的加固机器
 * 常见配置是 `user ALL=(ALL) NOPASSWD: /usr/lib/openssh/sftp-server` —— 只放开这一条命令，
 * `sudo -n true` 因不在允许列表而失败，于是被误判成需要密码；而这条路径其实是免密的。
 * 反过来，凭据时间戳还在缓存里时 `sudo -l` 之类的查询又会误判成免密。
 * 唯一无歧义的判据就是「这条命令到底跑没跑起来」，所以改成先 exec 免密版，
 * 握手失败再退到密码版。代价是密码机器上多花一次立刻返回的 exec。
 */

/** 常见发行版里 sftp-server 的落点（Debian/Ubuntu、RHEL/Fedora、Alpine、源码编译） */
export const SFTP_SERVER_CANDIDATES = [
    '/usr/lib/openssh/sftp-server',
    '/usr/libexec/openssh/sftp-server',
    '/usr/lib/ssh/sftp-server',
    '/usr/libexec/sftp-server',
    '/usr/local/libexec/sftp-server',
    '/usr/local/lib/openssh/sftp-server',
];

/**
 * 找一个可执行的 sftp-server 打到 stdout。
 *
 * 只负责找路径，不再顺带判断 sudo 要不要密码（见文件头注释）。
 * 找不到路径时退出码 2，与「找到了但 sudo 跑不起来」区分开。
 */
export const buildSftpServerProbeCommand = (): string => {
    const candidates = SFTP_SERVER_CANDIDATES.map((p) => `"${p}"`).join(' ');
    return [
        'for p in "$(command -v sftp-server 2>/dev/null)"',
        `${candidates};`,
        'do [ -n "$p" ] && [ -x "$p" ] && { printf "%s\\n" "$p"; break; }; done;',
        // 兜底：PATH 里没有、固定路径也没有 → 退出码 2，前端能给出"服务器没装 sftp-server"
        '[ -n "$p" ] && [ -x "$p" ] || exit 2;',
    ].join(' ');
};

/** 路径来自固定候选，这里仍然加引号防万一 */
const quotePath = (serverPath: string): string => `"${serverPath.replace(/(["\\$`])/g, '\\$1')}"`;

/**
 * 拼出启动 sudo sftp-server 的命令。
 * withPassword=false 走免密（`sudo -n`），true 走 `sh -c read` 版本，密码由调用方写进 stdin。
 */
export const buildSudoSftpCommand = (serverPath: string, withPassword = false): string => {
    const quoted = quotePath(serverPath);
    if (!withPassword) return `sudo -n ${quoted}`;
    // 注意：printf 的 "\n" 要原样传给远端 printf，所以这里是反斜杠 + n 两个字符
    return `sh -c 'IFS= read -r _p; { printf "%s\\n" "$_p"; cat; } | exec sudo -S -p "" ${quoted}'`;
};

interface ExecResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

/** 跑一条命令并收完 stdout/stderr。必须消费 stdout，否则 ssh2 的 close 事件不触发（Promise 悬死）。 */
const execCapture = (client: Client, command: string, timeoutMs: number): Promise<ExecResult> => {
    return new Promise<ExecResult>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            fn();
        };
        timer = setTimeout(() => finish(() => reject(new Error(`执行超时（${timeoutMs}ms）`))), timeoutMs);

        client.exec(command, { pty: false }, (err, stream) => {
            if (err) return finish(() => reject(err));
            let stdout = '';
            let stderr = '';
            stream.on('data', (data: Buffer) => { stdout += data.toString(); });
            stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
            stream.on('close', (code: number | null) => finish(() => resolve({ code, stdout, stderr })));
            stream.on('error', (execErr: Error) => finish(() => reject(execErr)));
        });
    });
};

export interface SudoSftpOptions {
    /** sudo 密码；留空 = 只用免密 sudo */
    password?: string;
    /** 启动超时（含探测），默认 15s */
    timeoutMs?: number;
}

/** 开一条 exec 通道并把它包成 SFTP 协议解析器。password 有值时先往 stdin 写一行。 */
const openChannel = (
    client: Client,
    command: string,
    password: string | undefined,
    timeoutMs: number,
): Promise<SFTPWrapper> => {
    return new Promise<SFTPWrapper>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            fn();
        };

        client.exec(command, { pty: false }, (err, stream) => {
            if (err) return finish(() => reject(err));

            // sudo 失败（密码错、不在 sudoers、requiretty）只会体现在 stderr 上，
            // 通道本身照样打开 —— 留着这段文本，超时/退出时当错误原因用。
            let stderr = '';
            stream.stderr.on('data', (data: Buffer) => {
                stderr = (stderr + data.toString()).slice(-2000);
            });

            const sftp = new SftpProtocol(client as any, stream as any, {}) as unknown as SFTPWrapper & {
                push: (data: Buffer | null) => void;
                _init: () => void;
            };

            /** 失败时要收掉通道，否则重试密码版会同时挂两条 sftp-server */
            const closeQuietly = (): void => {
                try { stream.close(); } catch { /* 通道可能已经没了 */ }
            };

            timer = setTimeout(() => {
                closeQuietly();
                const detail = stderr.trim();
                finish(() => reject(new Error(`sudo sftp-server 启动超时${detail ? `：${detail}` : '（没有任何输出，可能卡在密码提示或 tty 要求上）'}`)));
            }, timeoutMs);

            // exec 通道 → SFTP 协议解析器
            stream.on('data', (chunk: Buffer) => sftp.push(chunk));
            stream.on('end', () => sftp.push(null));
            stream.on('close', () => {
                sftp.push(null);
                const detail = stderr.trim();
                finish(() => reject(new Error(`sudo sftp-server 已退出${detail ? `：${detail}` : '（提早退出，通常是 sudo 校验失败）'}`)));
            });

            sftp.on('ready', () => finish(() => resolve(sftp)));
            sftp.on('error', (sftpErr: Error) => {
                closeQuietly();
                finish(() => reject(sftpErr));
            });

            // 密码必须写在 SFTP 的 INIT 之前：远端 `read` 先吃掉这一行，剩下的才是协议数据
            if (password) stream.write(`${password}\n`);
            sftp._init();
        });
    });
};

/**
 * 打开一条以 root 身份跑的 SFTP 通道。
 * 失败时直接抛错，调用方负责回退到普通 SFTP（提权只是加分项，不能让文件管理器整个用不了）。
 */
export const openSudoSftp = async (client: Client, options: SudoSftpOptions = {}): Promise<SFTPWrapper> => {
    const timeoutMs = options.timeoutMs ?? 15_000;

    const probe = await execCapture(client, buildSftpServerProbeCommand(), Math.min(timeoutMs, 8_000));
    const serverPath = probe.stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0];

    if (!serverPath || probe.code !== 0 || !/^\//.test(serverPath)) {
        const detail = probe.stderr.trim();
        throw new Error(`服务器上找不到 sftp-server${detail ? `（${detail}）` : ''}`);
    }

    // 一轮：免密。`sudo -n` 需要密码时会立刻退出，不会卡住，所以这条路是零成本的判据。
    // 超时收紧到 8s：真免密的话握手不用 1s，剩下的时间都是"卡在奇怪的地方"。
    try {
        return await openChannel(client, buildSudoSftpCommand(serverPath), undefined, Math.min(timeoutMs, 8_000));
    } catch (noPassErr: any) {
        const firstReason = noPassErr?.message || '未知原因';
        if (!options.password) {
            throw new Error(`服务器要求 sudo 密码（免密尝试失败：${firstReason}），请在该连接里填写 sudo 密码`);
        }
        // 二轮：用户填了密码，用 `sh -c read` 版本重试，密码只走 stdin
        try {
            return await openChannel(client, buildSudoSftpCommand(serverPath, true), options.password, timeoutMs);
        } catch (passErr: any) {
            const secondReason = passErr?.message || '未知原因';
            throw new Error(`sudo 提权失败：${secondReason}（免密尝试同样失败：${firstReason}）`);
        }
    }
};
