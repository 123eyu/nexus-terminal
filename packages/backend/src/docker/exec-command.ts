/**
 * 「进入容器」命令的纯逻辑（不依赖 ssh2 / 数据库，方便单测）。
 *
 * 背景：Docker 面板原来写死 `docker exec -it <id> sh`，但
 *   - Alpine / BusyBox 只有 ash、sh
 *   - Debian / Ubuntu 通常有 bash
 *   - Windows 容器只有 powershell / cmd
 *   - distroless 根本没有 shell
 *
 * 所以命令一律靠探测得出。**刻意不做「连接级固定命令」配置**：同一个 SSH 主机上
 * 跑的容器本来就是不同发行版，一条给整个连接用的固定命令必然会错；
 * 探不到（distroless）就退回 sh，用户在终端里自己换。
 */

/**
 * 生成最终要丢进终端的命令。
 * @param shell 探测到的 shell；为空（distroless 之类）时退回 `sh`
 */
export function buildDockerExecCommand(containerId: string, shell?: string | null): string {
    const safeShell = (shell || '').trim() || 'sh';
    return `docker exec -it ${containerId} ${safeShell}`;
}

/**
 * 生成探测脚本（一次 SSH exec 跑完）。
 *
 * ⚠️ 必须保持多行：用 `'; '` 把 `if/then/for` 拼起来会直接变成语法错误。
 * ⚠️ 所有探测输出都重定向掉 —— 试探不存在的 shell 时 docker 会往 stderr 写
 *    "executable file not found"，那种噪音不能漏到用户终端。
 * ⚠️ `cmd` 的参数是 `/c` 不是 `-c`，单独用 case 处理。
 */
export function buildShellProbeCommand(containerId: string): string {
    return [
        `CID='${containerId}'`,
        `OS=$(docker inspect -f '{{.Os}}' "$CID" 2>/dev/null)`,
        `FOUND=''`,
        `if [ "$OS" = "windows" ]; then`,
        `  for s in powershell pwsh cmd; do`,
        `    case "$s" in`,
        `      cmd) docker exec "$CID" cmd /c exit >/dev/null 2>&1 && FOUND=$s ;;`,
        `      *)   docker exec "$CID" "$s" -c 'exit 0' >/dev/null 2>&1 && FOUND=$s ;;`,
        `    esac`,
        `    [ -n "$FOUND" ] && break`,
        `  done`,
        `else`,
        `  for s in bash ash sh; do`,
        `    docker exec "$CID" "$s" -c 'exit 0' >/dev/null 2>&1 && FOUND=$s`,
        `    [ -n "$FOUND" ] && break`,
        `  done`,
        `fi`,
        `echo "NEXUS_OS=$OS"`,
        `echo "NEXUS_SHELL=$FOUND"`,
    ].join('\n');
}

/** 解析探测脚本的输出；shell 为空表示一个候选都没有（distroless 之类） */
export function parseShellProbeOutput(stdout: string): { shell: string; os: string } {
    const shell = (/NEXUS_SHELL=([^\s]*)/.exec(stdout)?.[1] || '').trim();
    const os = (/NEXUS_OS=([^\s]*)/.exec(stdout)?.[1] || '').trim() || 'unknown';
    return { shell, os };
}
