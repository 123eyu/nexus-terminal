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
 * 免密（服务器允许免密 sudo，或本来就是 root）：
 *   `sudo -n /usr/lib/openssh/sftp-server`
 *   加 `-n` 是为了没有免密 sudo 时立刻失败，而不是卡在密码提示上等超时。
 *
 * 需要密码：
 *   `sh -c 'IFS= read -r _p; { printf "%s\n" "$_p"; cat; } | exec sudo -S -p "" <path>'`
 *   第一行是密码，被 `read` 吃掉交给 sudo；之后 `cat` 把剩余字节原样转发给 sftp-server。
 *   密码不进命令行（不进 `ps`、不进 shell history），只走 stdin。
 *
 * ⚠️ 两种模式必须由**服务端**决定：如果服务器其实免密，我们把密码行写进 stdin，
 * 这一行就会落进 sftp-server 的协议流里，包长直接错乱。所以探测阶段顺手跑一次
 * `sudo -n true`，客户端据此决定要不要写密码行。
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
 * 找一个可执行的 sftp-server 打到 stdout，顺便报告 sudo 要不要密码。
 *
 * 输出两行：
 *   /usr/lib/openssh/sftp-server
 *   nopass | pass
 *
 * 找不到路径时退出码 2（与「找到了但 sudo 要密码」区分开）。
 */
export const buildSftpServerProbeCommand = (): string => {
    const candidates = SFTP_SERVER_CANDIDATES.map((p) => `"${p}"`).join(' ');
    return [
        'for p in "$(command -v sftp-server 2>/dev/null)"',
        `${candidates};`,
        'do [ -n "$p" ] && [ -x "$p" ] && { printf "%s\\n" "$p"; break; }; done;',
        // 兜底：PATH 里没有、固定路径也没有 → 退出码 2，前端能给出"服务器没装 sftp-server"
        '[ -n "$p" ] && [ -x "$p" ] || exit 2;',
        'if sudo -n true 2>/dev/null; then echo nopass; else echo pass; fi',
    ].join(' ');
};

/**
 * 拼出启动 sudo sftp-server 的命令。
 * 路径来自上面的固定候选（不含引号/空格），这里仍然加引号防万一。
 */
export const buildSudoSftpCommand = (serverPath: string, needsPassword: boolean): string => {
    const quoted = `"${serverPath.replace(/(["\\$`])/g, '\\$1')}"`;
    if (!needsPassword) return `sudo -n ${quoted}`;
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
    /** sudo 密码；留空 = 要求服务器允许免密 sudo */
    password?: string;
    /** 启动超时（含探测），默认 15s */
    timeoutMs?: number;
}

/**
 * 打开一条以 root 身份跑的 SFTP 通道。
 * 失败时直接抛错，调用方负责回退到普通 SFTP（提权只是加分项，不能让文件管理器整个用不了）。
 */
export const openSudoSftp = async (client: Client, options: SudoSftpOptions = {}): Promise<SFTPWrapper> => {
    const timeoutMs = options.timeoutMs ?? 15_000;

    const probe = await execCapture(client, buildSftpServerProbeCommand(), Math.min(timeoutMs, 8_000));
    const lines = probe.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const serverPath = lines[0];
    const needsPassword = lines[1] !== 'nopass';

    if (!serverPath || probe.code !== 0 || !/^\//.test(serverPath)) {
        const detail = probe.stderr.trim();
        throw new Error(`服务器上找不到 sftp-server${detail ? `（${detail}）` : ''}`);
    }

    // 服务端要密码但用户没填：不要硬闯（写空密码行会把协议流搞乱），直接回退并说明原因
    if (needsPassword && !options.password) {
        throw new Error('服务器要求 sudo 密码，请在该连接里填写 sudo 密码');
    }

    const command = buildSudoSftpCommand(serverPath, needsPassword);

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

            timer = setTimeout(() => {
                try { stream.close(); } catch { /* 通道可能已经没了 */ }
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
            sftp.on('error', (sftpErr: Error) => finish(() => reject(sftpErr)));

            // 密码必须写在 SFTP 的 INIT 之前：远端 `read` 先吃掉这一行，剩下的才是协议数据
            if (needsPassword) stream.write(`${options.password}\n`);
            sftp._init();
        });
    });
};
