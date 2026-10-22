/**
 * 自动安装 rsync
 *
 * 背景：发文件时如果源机或目标机没有 rsync，`auto` 模式会退回 scp，`rsync` 模式直接报错，
 * 用户只能自己登上机器 `apt install rsync` 再重试。这里在检测到缺失时**尝试**非交互安装一次。
 *
 * 三条硬约束：
 *  1. **绝不阻塞在交互提示上** —— 只在 root 或有免密 sudo 时动手，否则直接放弃（不弹密码、不挂死）。
 *  2. 每个主机只试一次（结果缓存），多子任务并发时共享同一次尝试，避免 5 条命令同时 apt。
 *  3. 失败不改变原有语义 —— auto 仍然退回 scp，rsync 偏好仍然报错，只是错误信息里带上原因。
 */

export type PackageManager = 'apt-get' | 'dnf' | 'yum' | 'apk' | 'zypper' | 'pacman';

export interface RsyncInstallProbe {
  packageManager: PackageManager | null;
  isRoot: boolean;
  hasPasswordlessSudo: boolean;
}

/**
 * 一次 exec 同时探测包管理器和提权能力（输出形如 `PM=apt-get ROOT=1 SUDO=0`）。
 * 用 printf 而不是 echo，避免部分 shell 对 `-n` 的解释差异。
 */
export const RSYNC_PROBE_SCRIPT = [
  'PM="";',
  'for c in apt-get dnf yum apk zypper pacman; do',
  'if command -v "$c" >/dev/null 2>&1; then PM="$c"; break; fi;',
  'done;',
  'IS_ROOT=0; [ "$(id -u 2>/dev/null)" = "0" ] && IS_ROOT=1;',
  'SUDO=0;',
  'if command -v sudo >/dev/null 2>&1; then sudo -n true >/dev/null 2>&1 && SUDO=1; fi;',
  'printf "PM=%s\\nROOT=%s\\nSUDO=%s\\n" "$PM" "$IS_ROOT" "$SUDO"',
].join(' ');

const KNOWN_PACKAGE_MANAGERS: PackageManager[] = ['apt-get', 'dnf', 'yum', 'apk', 'zypper', 'pacman'];

export function parseRsyncProbe(stdout: string): RsyncInstallProbe {
  const read = (key: string): string => {
    const matched = new RegExp(`${key}=([^\\s]*)`).exec(stdout || '');
    return matched ? matched[1].trim() : '';
  };

  const pmRaw = read('PM');
  const packageManager = (KNOWN_PACKAGE_MANAGERS as string[]).includes(pmRaw)
    ? (pmRaw as PackageManager)
    : null;

  return {
    packageManager,
    isRoot: read('ROOT') === '1',
    hasPasswordlessSudo: read('SUDO') === '1',
  };
}

function installCommandFor(packageManager: PackageManager): string {
  switch (packageManager) {
    case 'apt-get':
      // 不更新索引：多数机器上 rsync 就在现有索引里；失败时再用 fallback 更新一次
      return 'env DEBIAN_FRONTEND=noninteractive apt-get install -y rsync';
    case 'dnf':
      return 'dnf install -y rsync';
    case 'yum':
      return 'yum install -y rsync';
    case 'apk':
      return 'apk add --no-cache rsync';
    case 'zypper':
      return 'zypper --non-interactive install rsync';
    case 'pacman':
      return 'pacman -Sy --noconfirm --needed rsync';
  }
}

/**
 * 返回要依次尝试的命令：第一个是直接安装，第二个（仅 apt）是更新索引后重装。
 * 拿不到提权能力时返回空数组 —— 调用方据此放弃自动安装。
 *
 * 提权用 `sudo -n <cmd>` 前缀而不是 `sh -c '...'`：不用做 shell 引号转义，
 * `-n` 保证没有免密 sudo 时立刻失败而不是卡在密码提示上。
 */
export function buildRsyncInstallCommands(probe: RsyncInstallProbe): string[] {
  const { packageManager, isRoot, hasPasswordlessSudo } = probe;
  if (!packageManager) return [];
  if (!isRoot && !hasPasswordlessSudo) return [];

  const sudo = isRoot ? '' : 'sudo -n ';
  const install = `${sudo}${installCommandFor(packageManager)}`;

  if (packageManager === 'apt-get') {
    // apt 的索引可能太旧，第一次失败后再来一次「先 update」
    return [install, `${sudo}env DEBIAN_FRONTEND=noninteractive apt-get update && ${install}`];
  }

  return [install];
}
