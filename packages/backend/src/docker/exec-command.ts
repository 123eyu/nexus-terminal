/**
 * 「进入容器」命令的纯逻辑（不依赖 ssh2 / 数据库，方便单测）。
 *
 * 背景：Docker 面板原来写死 `docker exec -it <id> sh`，但
 *   - Alpine / BusyBox 只有 ash、sh
 *   - Debian / Ubuntu 通常有 bash
 *   - Windows 容器只有 powershell / cmd
 *   - distroless 根本没有 shell
 * 所以默认改成「探测」，并允许在连接的高级选项里用 `docker_exec_command` 覆盖。
 */

export interface BuildDockerExecOptions {
    containerId: string;
    containerName?: string;
    /** 连接上配置的模板；空 / 'auto' = 自动探测 */
    template?: string | null;
    /** 探测到的 shell（template 为空或含 {shell} 时才有意义） */
    shell?: string | null;
}

/**
 * 生成最终要丢进终端的命令。三种写法：
 *   1. 空 / `auto`           → `docker exec -it <id> <shell||sh>`
 *   2. 含 `{id}`/`{name}`/`{shell}` → 当完整命令模板，替换占位符（要加 `-u root` 就得用这种）
 *   3. 其它（如 `bash`）     → 当程序名/参数，拼到容器 ID 后面
 */
export function buildDockerExecCommand(opts: BuildDockerExecOptions): string {
    const id = opts.containerId;
    const name = (opts.containerName || '').trim() || id;
    const shell = (opts.shell || '').trim() || 'sh';
    const tpl = (opts.template || '').trim();
    if (!tpl || tpl.toLowerCase() === 'auto') {
        return `docker exec -it ${id} ${shell}`;
    }
    if (/\{(id|name|shell)\}/.test(tpl)) {
        return tpl.replace(/\{id\}/g, id).replace(/\{name\}/g, name).replace(/\{shell\}/g, shell);
    }
    return `docker exec -it ${id} ${tpl}`;
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
