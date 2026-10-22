/**
 * 服务器之间「发送文件」的命令拼装（纯函数，方便单测）
 *
 * 背景：这个功能是在**源服务器**上起一个 `rsync` / `scp` 子进程，把文件推到目标服务器，
 * 所以命令字符串的每一个字符都会影响结果 —— 尤其是 rsync 源路径的**尾斜杠**。
 */

/**
 * 单引号包裹，内部单引号按 shell 规则转义
 */
export function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * 去掉路径末尾的斜杠（根目录 `/` 原样保留）
 *
 * ⚠️ 必须做：rsync / scp 里源目录的尾斜杠是**语义开关**
 * - `rsync -a /src/test  host:/dst` → `/dst/test`
 * - `rsync -a /src/test/ host:/dst` → `/dst/`（test 里的内容被摊进 dst）
 *
 * 用户在弹窗里填的是「父目录」，期望 `<父目录>/<文件夹名>`，
 * 所以源路径一律不带尾斜杠。
 */
export function stripTrailingSlashes(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export interface TransferCommandTarget {
  username: string;
  host: string;
  port?: number;
}

export interface TransferCommandOptions {
  /** 例如 "sshpass -p 'xxx'" */
  sshPassCommand?: string;
  /** 例如 "-i '/tmp/nexus_target_key_abc'" */
  sshIdentityFileOption?: string;
  /** 例如 "user@host" */
  targetUserAndHost: string;
  /** scp 是 "-P 2222"，rsync 是 "-p 2222" */
  sshPortOption?: string;
}

/**
 * 拼出在源服务器上执行的传输命令
 *
 * @param sourceItemPathOnA 源服务器上的绝对路径
 * @param isDir 源路径是不是目录
 * @param targetPathOnB 目标服务器上的**父目录**
 * @param executableCommand rsync / scp 的绝对路径
 * @param commandType 用哪个命令
 */
export function buildTransferCommandString(
  sourceItemPathOnA: string,
  isDir: boolean,
  targetPathOnB: string,
  executableCommand: string,
  commandType: 'rsync' | 'scp',
  options: TransferCommandOptions
): string {
  const remoteBase = targetPathOnB.endsWith('/') ? targetPathOnB : `${targetPathOnB}/`;
  const remoteFullDest = `${options.targetUserAndHost}:${escapeShellArg(remoteBase)}`;

  // 源路径不带尾斜杠：目标下应该出现「文件夹本身」，而不是把里面的内容摊进去
  const sourcePath = escapeShellArg(stripTrailingSlashes(sourceItemPathOnA));

  const commandParts: string[] = [];
  if (options.sshPassCommand) {
    commandParts.push(options.sshPassCommand);
  }

  commandParts.push(executableCommand);

  if (commandType === 'rsync') {
    commandParts.push('-avz --progress'); // rsync specific options
    // For rsync, SSH options go into the -e argument
    let sshArgsForRsync = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
    if (options.sshPortOption && options.sshPortOption.startsWith('-p')) {
      // rsync uses -p for port inside its -e "ssh -p XXX"
      sshArgsForRsync += ` ${options.sshPortOption}`;
    }
    if (options.sshIdentityFileOption) {
      // -i for identity file is an ssh option
      sshArgsForRsync += ` ${options.sshIdentityFileOption}`;
    }
    commandParts.push(`-e "${sshArgsForRsync.trim()}"`);
    commandParts.push(sourcePath);
    commandParts.push(remoteFullDest);
  } else {
    // scp
    commandParts.push('-o StrictHostKeyChecking=no');
    commandParts.push('-o UserKnownHostsFile=/dev/null');
    if (isDir) commandParts.push('-r');
    if (options.sshPortOption && options.sshPortOption.startsWith('-P')) {
      // scp uses -P for port
      commandParts.push(options.sshPortOption);
    }
    if (options.sshIdentityFileOption) {
      // scp uses -i for identity file
      commandParts.push(options.sshIdentityFileOption);
    }
    commandParts.push(sourcePath);
    commandParts.push(remoteFullDest);
  }

  return commandParts.join(' ');
}
