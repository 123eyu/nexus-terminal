/**
 * 脚本模式连接批量导入解析器
 *
 * 支持的写法（可以混着粘，一行一个连接）：
 *  1. 选项式：      admin@10.0.0.5:2222 -p "P@ss" -name 生产网关 -folder 生产 -note "别乱动"
 *  2. 缺省用户名/端口：10.0.0.5 -p pass            （默认 root:22）
 *  3. OpenSSH 命令行：ssh -p 2222 -i my-key root@10.0.0.5
 *  4. URL 形式：     ssh://root:pass@10.0.0.5:22 、 rdp://Administrator:pass@1.2.3.4:3389
 *  5. 冒号四段式：   10.0.0.5:22:root:pass
 *  6. 空格四段式：   10.0.0.5 22 root pass
 *  7. 注释与空行：#、//、; 开头直接跳过
 *
 * 与「添加连接」表单对齐的选项（这些是后来加的，老脚本不用改也能跑）：
 *  -folder/-folders  文件夹（表单里是单选，脚本给多个时只取第一个建文件夹关联，其余忽略）
 *  -protocol      文件传输协议 auto|sftp|scp
 *  -jump          跳板机链，按连接名（逗号或空格分隔，仅 SSH）
 *  -color         卡片背景色，如 -color "#3b82f6"
 *  -range         IP 范围可以直接写在 host 上：10.0.0.10~20 或 10.0.0.10~10.0.0.20
 *
 * 这个文件刻意保持**零 import**：前端单测用 `node --experimental-strip-types` 跑，
 * 解析不了无扩展名的相对导入。
 */

export type ScriptConnectionType = 'SSH' | 'RDP' | 'VNC';
export type ScriptFileProtocol = 'auto' | 'sftp' | 'scp';

export interface ParsedScriptConnection {
  type: ScriptConnectionType;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method?: 'password' | 'key';
  password?: string;
  keyName?: string;
  proxyName?: string;
  /** 跳板机链（连接名） */
  jumpNames?: string[];
  folders?: string[];
  note?: string;
  fileProtocol?: ScriptFileProtocol;
  backgroundColor?: string;
  /** 由 IP 范围展开时，记录原始范围文本，UI 用来提示「1 行 → N 台」 */
  rangeSource?: string;
}

export type ScriptErrorCode =
  | 'missingValue'
  | 'invalidPort'
  | 'portOutOfRange'
  | 'unsupportedType'
  | 'invalidProtocol'
  | 'invalidColor'
  | 'missingTarget'
  | 'invalidHostPort'
  | 'cannotParseHost'
  | 'missingCredential'
  | 'missingPassword'
  | 'invalidRange';

export interface ScriptLineError {
  /** 中文兜底文案（和错误码并存：老调用方直接显示这句也行） */
  message: string;
  code: ScriptErrorCode;
  params?: Record<string, string | number>;
}

export interface ParsedScriptRow {
  /** 1-based 行号 */
  lineIndex: number;
  raw: string;
  items: ParsedScriptConnection[];
  error?: string;
  errorCode?: ScriptErrorCode;
  errorParams?: Record<string, string | number>;
  skipped?: boolean;
}

export interface ParseScriptResult {
  rows: ParsedScriptRow[];
  validConnections: ParsedScriptConnection[];
  errors: Array<{ lineIndex: number; line: string; error: string; code?: ScriptErrorCode; params?: Record<string, string | number> }>;
  totalLines: number;
  skippedLines: number;
}

const DEFAULT_PORTS: Record<ScriptConnectionType, number> = { SSH: 22, RDP: 3389, VNC: 5900 };

/** 分词：按空白切，但保留双引号 / 单引号内的整体 */
export function tokenizeArgs(str: string): string[] {
  const result: string[] = [];
  const regex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(str)) !== null) {
    result.push(match[0]);
  }
  return result;
}

function stripQuotes(val: string): string {
  if (!val) return '';
  return val.replace(/^["']|["']$/g, '');
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

/**
 * 把 `10.0.0.10~20` / `10.0.0.10~10.0.0.20` 展开成主机列表。
 * 只认 `~`（和表单里的 IP 范围一致）；普通主机名原样返回。
 */
export function expandHostRange(host: string): { hosts: string[]; error?: ScriptLineError } {
  const raw = (host || '').trim();
  if (!raw.includes('~')) return { hosts: [raw] };

  const shortForm = raw.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})~(\d{1,3})$/);
  const longForm = raw.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})~(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);

  let prefix = '';
  let start = 0;
  let end = 0;

  if (shortForm) {
    prefix = shortForm[1];
    start = parseInt(shortForm[2], 10);
    end = parseInt(shortForm[3], 10);
  } else if (longForm) {
    const from = longForm[1].split('.').map((n) => parseInt(n, 10));
    const to = longForm[2].split('.').map((n) => parseInt(n, 10));
    if (from.slice(0, 3).join('.') !== to.slice(0, 3).join('.')) {
      return {
        hosts: [],
        error: {
          message: `IP 范围必须落在同一个 C 段内（例如 10.0.0.10~10.0.0.20）: ${raw}`,
          code: 'invalidRange',
          params: { range: raw },
        },
      };
    }
    prefix = from.slice(0, 3).join('.');
    start = from[3];
    end = to[3];
  } else {
    return {
      hosts: [],
      error: {
        message: `无法识别的 IP 范围: ${raw}`,
        code: 'invalidRange',
        params: { range: raw },
      },
    };
  }

  if ([start, end].some((n) => Number.isNaN(n) || n < 0 || n > 255) || start > end) {
    return {
      hosts: [],
      error: { message: `IP 范围无效: ${raw}`, code: 'invalidRange', params: { range: raw } },
    };
  }

  const hosts: string[] = [];
  for (let i = start; i <= end; i++) hosts.push(`${prefix}.${i}`);
  return { hosts };
}

interface ParsedTarget {
  username: string;
  host: string;
  port: number | null;
}

/**
 * 解析 `[user@]host[:port]`，用户名 / 端口可被显式选项覆盖。
 */
function parseTargetPart(
  targetPart: string,
  explicitUser: string | null,
  explicitPort: number | null
): ParsedTarget | ScriptLineError {
  const part = stripQuotes(targetPart);

  let userFromTarget = '';
  let hostPort = part;
  if (part.includes('@')) {
    const at = part.lastIndexOf('@');
    userFromTarget = part.slice(0, at).trim();
    hostPort = part.slice(at + 1).trim();
  }

  let host = hostPort;
  let port = explicitPort;
  if (hostPort.includes(':')) {
    const idx = hostPort.lastIndexOf(':');
    host = hostPort.slice(0, idx).trim();
    if (port === null) {
      const p = parseInt(hostPort.slice(idx + 1).trim(), 10);
      if (Number.isNaN(p)) {
        return {
          message: `无效的主机端口号: ${hostPort.slice(idx + 1)}`,
          code: 'invalidHostPort',
          params: { port: hostPort.slice(idx + 1) },
        };
      }
      port = p;
    }
  }

  if (!host) {
    return { message: `无法识别主机地址: ${part}`, code: 'cannotParseHost', params: { host: part } };
  }

  return { username: explicitUser || userFromTarget || 'root', host, port };
}

function isLineError(v: unknown): v is ScriptLineError {
  return !!v && typeof v === 'object' && 'code' in (v as Record<string, unknown>) && 'message' in (v as Record<string, unknown>);
}

/**
 * 解析单行，返回**展开后**的连接列表（IP 范围会变成多条）。
 */
export function parseScriptLine(rawLine: string): { skipped: true } | ScriptLineError | { items: ParsedScriptConnection[] } {
  let line = rawLine.trim();

  if (!line || line.startsWith('#') || line.startsWith('//') || line.startsWith(';')) {
    return { skipped: true };
  }

  // 协议前缀 / OpenSSH 命令行前缀
  let inferredType: ScriptConnectionType = 'SSH';
  let isSshCli = false;

  const urlProtocolMatch = line.match(/^(ssh|rdp|vnc):\/\/(.*)$/i);
  if (urlProtocolMatch) {
    inferredType = urlProtocolMatch[1].toUpperCase() as ScriptConnectionType;
    line = urlProtocolMatch[2].trim();
  } else if (/^ssh\s+/i.test(line)) {
    inferredType = 'SSH';
    isSshCli = true;
    line = line.replace(/^ssh\s+/i, '').trim();
  }

  // 冒号四段式 host:port:user:password（不含任何选项时才判定，避免误伤）
  const fourColonMatch = line.match(/^([^:\s]+):(\d{1,5}):([^:\s]+):(.+)$/);
  if (fourColonMatch && !line.includes(' -')) {
    const cPort = parseInt(fourColonMatch[2], 10);
    const cHost = fourColonMatch[1].trim();
    const cUser = fourColonMatch[3].trim();
    if (isPort(cPort) && cHost && cUser) {
      const range = expandHostRange(cHost);
      if (range.error) return range.error;
      return {
        items: range.hosts.map((h) => ({
          type: inferredType,
          name: defaultName(cUser, h, cPort, inferredType),
          host: h,
          port: cPort,
          username: cUser,
          auth_method: 'password' as const,
          password: stripQuotes(fourColonMatch[4].trim()),
          folders: [],
          note: '',
          ...(range.hosts.length > 1 ? { rangeSource: cHost } : {}),
        })),
      };
    }
  }

  // 空格分隔的 3~4 段纯文本：host port [user] password
  const initialTokens = tokenizeArgs(line);
  if (initialTokens.length >= 3 && !initialTokens.some((tk) => tk.startsWith('-'))) {
    if (initialTokens.length === 4 && /^\d+$/.test(initialTokens[1])) {
      const portVal = parseInt(initialTokens[1], 10);
      if (isPort(portVal)) {
        const u = stripQuotes(initialTokens[2]);
        const h = stripQuotes(initialTokens[0]);
        const range = expandHostRange(h);
        if (range.error) return range.error;
        return {
          items: range.hosts.map((host) => ({
            type: inferredType,
            name: defaultName(u, host, portVal, inferredType),
            host,
            port: portVal,
            username: u,
            auth_method: 'password' as const,
            password: stripQuotes(initialTokens[3]),
            folders: [],
            note: '',
            ...(range.hosts.length > 1 ? { rangeSource: h } : {}),
          })),
        };
      }
    }
    if (initialTokens.length === 3 && /^\d+$/.test(initialTokens[1])) {
      const portVal = parseInt(initialTokens[1], 10);
      if (isPort(portVal)) {
        const h = stripQuotes(initialTokens[0]);
        const range = expandHostRange(h);
        if (range.error) return range.error;
        return {
          items: range.hosts.map((host) => ({
            type: inferredType,
            name: defaultName('root', host, portVal, inferredType),
            host,
            port: portVal,
            username: 'root',
            auth_method: 'password' as const,
            password: stripQuotes(initialTokens[2]),
            folders: [],
            note: '',
            ...(range.hosts.length > 1 ? { rangeSource: h } : {}),
          })),
        };
      }
    }
  }

  // Token 扫描
  const tokens = tokenizeArgs(line);
  let type: ScriptConnectionType = inferredType;
  let customName: string | null = null;
  let password: string | null = null;
  let keyName: string | null = null;
  let proxyName: string | null = null;
  let jumpNames: string[] = [];
  let folders: string[] = [];
  let note: string | null = null;
  let explicitPort: number | null = null;
  let explicitUser: string | null = null;
  let fileProtocol: ScriptFileProtocol | null = null;
  let backgroundColor: string | null = null;

  const positionalTokens: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const rawArg = tokens[i];

    if (!rawArg.startsWith('-')) {
      positionalTokens.push(rawArg);
      i++;
      continue;
    }

    const isDoubleDash = rawArg.startsWith('--');
    const rawFlag = rawArg.replace(/^-+/, '');
    const flagLower = rawFlag.toLowerCase();
    i++;

    // 多值选项：一直吃到下一个 -flag
    const collectValues = (): string[] => {
      const out: string[] = [];
      while (i < tokens.length && !tokens[i].startsWith('-')) {
        const v = stripQuotes(tokens[i]);
        if (v) out.push(...v.split(',').map((x) => x.trim()).filter(Boolean));
        i++;
      }
      return out;
    };

    if (flagLower === 'tag' || flagLower === 'tags' || flagLower === 'folder' || flagLower === 'folders' || flagLower === 'dir') {
      folders.push(...collectValues());
      continue;
    }

    if (flagLower === 'note' || flagLower === 'notes' || flagLower === 'memo' || flagLower === 'desc') {
      const noteParts: string[] = [];
      while (i < tokens.length && !tokens[i].startsWith('-')) {
        noteParts.push(tokens[i]);
        i++;
      }
      note = stripQuotes(noteParts.join(' '));
      continue;
    }

    if (flagLower === 'jump' || flagLower === 'jumps' || flagLower === 'jumpchain') {
      jumpNames = collectValues();
      continue;
    }

    if (i >= tokens.length) {
      return {
        message: `选项 ${rawArg} 缺少对应的值`,
        code: 'missingValue',
        params: { flag: rawArg },
      };
    }

    const val = stripQuotes(tokens[i]);
    i++;

    if (!isDoubleDash && rawFlag === 'P') {
      const pNum = parseInt(val, 10);
      if (!isPort(pNum)) {
        return { message: `无效的端口号: ${val}`, code: 'invalidPort', params: { port: val } };
      }
      explicitPort = pNum;
    } else if (flagLower === 'port') {
      const pNum = parseInt(val, 10);
      if (!isPort(pNum)) {
        return { message: `无效的端口号: ${val}`, code: 'invalidPort', params: { port: val } };
      }
      explicitPort = pNum;
    } else if (flagLower === 'pass' || flagLower === 'password' || flagLower === 'pwd') {
      password = val;
    } else if (flagLower === 'p') {
      // 小写 -p 多义：ssh 命令行里的纯数字当端口，其它场景当密码
      const isNumeric = /^\d+$/.test(val);
      const pNum = parseInt(val, 10);
      if (isSshCli && isNumeric && isPort(pNum)) {
        explicitPort = pNum;
      } else {
        password = val;
      }
    } else if (
      flagLower === 'i' ||
      flagLower === 'identity' ||
      flagLower === 'k' ||
      flagLower === 'key' ||
      flagLower === 'sshkey'
    ) {
      keyName = val;
    } else if (flagLower === 'type' || flagLower === 't') {
      const upper = val.toUpperCase();
      if (upper === 'SSH' || upper === 'RDP' || upper === 'VNC') {
        type = upper;
      } else {
        return { message: `不支持的主机类型: ${val}`, code: 'unsupportedType', params: { type: val } };
      }
    } else if (flagLower === 'name' || flagLower === 'n') {
      customName = val;
    } else if (flagLower === 'proxy') {
      proxyName = val;
    } else if (flagLower === 'protocol' || flagLower === 'fileprotocol' || flagLower === 'fp') {
      const lower = val.toLowerCase();
      if (lower === 'auto' || lower === 'sftp' || lower === 'scp') {
        fileProtocol = lower;
      } else {
        return { message: `不支持的文件传输协议: ${val}（可选 auto/sftp/scp）`, code: 'invalidProtocol', params: { protocol: val } };
      }
    } else if (flagLower === 'color' || flagLower === 'colour' || flagLower === 'bg' || flagLower === 'bgcolor') {
      if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(val)) {
        return { message: `无效的颜色值: ${val}（形如 #3b82f6）`, code: 'invalidColor', params: { color: val } };
      }
      backgroundColor = val;
    } else if (flagLower === 'u' || flagLower === 'user' || flagLower === 'username') {
      explicitUser = val;
    } else {
      console.warn(`[ScriptParser] 忽略未知参数: ${rawArg}`);
    }
  }

  if (positionalTokens.length === 0) {
    return { message: '缺少主机地址或目标', code: 'missingTarget' };
  }

  // [user[:password]@]host[:port] —— 只在**这一个 token 里**找 @，
  // 千万别对整行 lastIndexOf('@')：密码里带 @（如 "P@ss word"）会把行拆坏
  let targetToken = stripQuotes(positionalTokens[0]);
  let embeddedUser: string | null = null;
  let embeddedPassword: string | null = null;
  const atIndex = targetToken.lastIndexOf('@');
  if (atIndex > 0) {
    const userPart = targetToken.slice(0, atIndex);
    targetToken = targetToken.slice(atIndex + 1);
    const colonIndex = userPart.indexOf(':');
    if (colonIndex === -1) {
      embeddedUser = userPart;
    } else {
      embeddedUser = userPart.slice(0, colonIndex);
      embeddedPassword = userPart.slice(colonIndex + 1);
    }
  }

  const target = parseTargetPart(targetToken, explicitUser || embeddedUser, explicitPort);
  if (isLineError(target)) return target;

  if (!password && embeddedPassword) password = embeddedPassword;

  // 容错：第二个位置参数当密码（还没拿到密码也没有密钥时）
  if (positionalTokens.length > 1 && !password && !keyName) {
    password = stripQuotes(positionalTokens[1]);
  }

  const port = target.port ?? DEFAULT_PORTS[type];
  if (!isPort(port)) {
    return { message: `端口号必须在 1-65535 范围内: ${port}`, code: 'portOutOfRange', params: { port } };
  }

  const range = expandHostRange(target.host);
  if (range.error) return range.error;

  let auth_method: 'password' | 'key' | undefined;
  if (type === 'SSH') {
    auth_method = keyName ? 'key' : 'password';
    if (!keyName && !password) {
      return {
        message: '缺少认证凭证：请用 -p 指定密码，或用 -k/-i 指定 SSH 密钥',
        code: 'missingCredential',
      };
    }
  } else if (!password) {
    return {
      message: `缺少认证密码：${type} 主机必须提供密码 (-p)`,
      code: 'missingPassword',
      params: { type },
    };
  }

  const multi = range.hosts.length > 1;
  return {
    items: range.hosts.map((host) => ({
      type,
      name: customName
        ? multi
          ? `${customName}-${host.split('.').pop()}`
          : customName
        : defaultName(target.username, host, port, type),
      host,
      port,
      username: target.username,
      auth_method,
      ...(password ? { password } : {}),
      ...(keyName ? { keyName } : {}),
      ...(proxyName ? { proxyName } : {}),
      ...(jumpNames.length ? { jumpNames } : {}),
      folders,
      ...(note !== null ? { note } : {}),
      ...(fileProtocol ? { fileProtocol } : {}),
      ...(backgroundColor ? { backgroundColor } : {}),
      ...(multi ? { rangeSource: target.host } : {}),
    })),
  };
}

function defaultName(username: string, host: string, port: number, type: ScriptConnectionType): string {
  // 默认端口不写出来，和表单里自动生成的卡片名保持一致
  return port === DEFAULT_PORTS[type] ? `${username}@${host}` : `${username}@${host}:${port}`;
}

/**
 * 兼容老调用方：只取第一台。
 */
export function parseScriptSingleLine(rawLine: string): {
  data?: ParsedScriptConnection;
  error?: string;
  errorCode?: ScriptErrorCode;
  errorParams?: Record<string, string | number>;
  isSkipped?: boolean;
} {
  const res = parseScriptLine(rawLine);
  if ('skipped' in res) return { isSkipped: true };
  if ('code' in res) {
    return { error: res.message, errorCode: res.code, errorParams: res.params };
  }
  return { data: res.items[0] };
}

/** 批量解析多行文本 */
export function parseScriptText(text: string): ParseScriptResult {
  const lines = (text || '').split(/\r?\n/);
  const rows: ParsedScriptRow[] = [];
  const validConnections: ParsedScriptConnection[] = [];
  const errors: ParseScriptResult['errors'] = [];
  let skippedLines = 0;

  lines.forEach((line, idx) => {
    const res = parseScriptLine(line);
    if ('skipped' in res) {
      skippedLines++;
      rows.push({ lineIndex: idx + 1, raw: line, items: [], skipped: true });
      return;
    }
    if ('code' in res) {
      errors.push({ lineIndex: idx + 1, line, error: res.message, code: res.code, params: res.params });
      rows.push({
        lineIndex: idx + 1,
        raw: line,
        items: [],
        error: res.message,
        errorCode: res.code,
        errorParams: res.params,
      });
      return;
    }
    validConnections.push(...res.items);
    rows.push({ lineIndex: idx + 1, raw: line, items: res.items });
  });

  return { rows, validConnections, errors, totalLines: lines.length, skippedLines };
}
