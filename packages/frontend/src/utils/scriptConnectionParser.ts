/**
 * 脚本模式连接批量导入解析器
 * 支持多种灵活格式：
 * 1. 标准选项式：user@host:port -p password -k keyName -name "别名" -note "备注"
 * 2. 缺省用户名/端口：192.168.1.1 -p password (默认 root:22)
 * 3. OpenSSH 命令行复制式（支持选项在前或在后）：
 *    - ssh root@192.168.1.1 -P 2222 -p password
 *    - ssh -p 2222 -i my-key root@192.168.1.1
 *    - ssh -i id_rsa -p 2200 -pass "Secret123" root@192.168.1.1
 * 4. URL 嵌入式：ssh://root:password@192.168.1.1:22 或 rdp://Administrator:pass@1.2.3.4:3389
 * 5. 常见四段式：192.168.1.1:22:root:password 或 192.168.1.1 22 root password
 * 6. 注释与空行自动忽略（#、//、;）
 */

export interface ParsedScriptConnection {
  type: 'SSH' | 'RDP' | 'VNC';
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method?: 'password' | 'key';
  password?: string;
  keyName?: string;
  proxyName?: string;
  tags?: string[];
  note?: string;
}

export interface ParseScriptResult {
  validConnections: ParsedScriptConnection[];
  errors: Array<{ lineIndex: number; line: string; error: string }>;
  totalLines: number;
  skippedLines: number;
}

/**
 * 分词辅助函数：按空格切分，保留双引号或单引号内的完整字符串
 */
export function tokenizeArgs(str: string): string[] {
  const result: string[] = [];
  const regex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(str)) !== null) {
    result.push(match[0]);
  }
  return result;
}

/**
 * 清除外层包裹的引号
 */
function stripQuotes(val: string): string {
  if (!val) return '';
  return val.replace(/^["']|["']$/g, '');
}

/**
 * 解析单行脚本文本
 */
export function parseScriptSingleLine(rawLine: string): { data?: ParsedScriptConnection; error?: string; isSkipped?: boolean } {
  let line = rawLine.trim();

  // 1. 空行或注释行过滤
  if (!line || line.startsWith('#') || line.startsWith('//') || line.startsWith(';')) {
    return { isSkipped: true };
  }

  // 2. 协议前缀与命令行前缀识别 (ssh://, rdp://, vnc://, ssh ...)
  let inferredType: 'SSH' | 'RDP' | 'VNC' = 'SSH';
  let isSshCli = false;

  const urlProtocolMatch = line.match(/^(ssh|rdp|vnc):\/\/(.*)$/i);
  if (urlProtocolMatch) {
    inferredType = urlProtocolMatch[1].toUpperCase() as 'SSH' | 'RDP' | 'VNC';
    line = urlProtocolMatch[2].trim();
  } else if (/^ssh\s+/i.test(line)) {
    inferredType = 'SSH';
    isSshCli = true;
    line = line.replace(/^ssh\s+/i, '').trim();
  }

  // 3. 常见四段冒号格式：host:port:user:password
  // 例如：192.168.1.1:22:root:Admin@2026
  const fourColonMatch = line.match(/^([^:\s]+):(\d{1,5}):([^:\s]+):(.+)$/);
  if (fourColonMatch && !line.includes(' -') && !line.includes(' --')) {
    const cHost = fourColonMatch[1].trim();
    const cPort = parseInt(fourColonMatch[2], 10);
    const cUser = fourColonMatch[3].trim();
    const cPass = stripQuotes(fourColonMatch[4].trim());
    if (cPort > 0 && cPort <= 65535 && cHost && cUser) {
      return {
        data: {
          type: inferredType,
          name: `${cUser}@${cHost}`,
          host: cHost,
          port: cPort,
          username: cUser,
          auth_method: 'password',
          password: cPass,
          tags: [],
          note: '',
        }
      };
    }
  }

  // 4. 空白分隔的 3~4 段纯文本格式检查（如: 192.168.1.1 22 root password）
  const initialTokens = tokenizeArgs(line);
  if (initialTokens.length >= 2 && !initialTokens.some(t => t.startsWith('-'))) {
    // 4 段格式：host port user password
    if (initialTokens.length === 4 && /^\d+$/.test(initialTokens[1])) {
      const portVal = parseInt(initialTokens[1], 10);
      if (portVal > 0 && portVal <= 65535) {
        const u = stripQuotes(initialTokens[2]);
        const h = stripQuotes(initialTokens[0]);
        return {
          data: {
            type: inferredType,
            name: `${u}@${h}`,
            host: h,
            port: portVal,
            username: u,
            auth_method: 'password',
            password: stripQuotes(initialTokens[3]),
            tags: [],
            note: '',
          }
        };
      }
    }
    // 3 段格式：host 22 password (默认 root 用户)
    if (initialTokens.length === 3 && /^\d+$/.test(initialTokens[1])) {
      const portVal = parseInt(initialTokens[1], 10);
      if (portVal > 0 && portVal <= 65535) {
        const h = stripQuotes(initialTokens[0]);
        return {
          data: {
            type: inferredType,
            name: `root@${h}`,
            host: h,
            port: portVal,
            username: 'root',
            auth_method: 'password',
            password: stripQuotes(initialTokens[2]),
            tags: [],
            note: '',
          }
        };
      }
    }
  }

  // 5. URL 嵌入式密码提取：user:password@host[:port] 或 :password@host[:port]
  let embeddedPassword: string | null = null;
  const lastAtIndex = line.lastIndexOf('@');
  if (lastAtIndex !== -1 && !line.startsWith('-')) {
    const userPassPart = line.substring(0, lastAtIndex);
    const colonInUserPass = userPassPart.indexOf(':');
    if (colonInUserPass !== -1 && !userPassPart.startsWith('"') && !userPassPart.startsWith("'")) {
      const u = userPassPart.substring(0, colonInUserPass).trim();
      const p = userPassPart.substring(colonInUserPass + 1);
      embeddedPassword = p;
      const finalUser = u || 'root';
      line = `${finalUser}@${line.substring(lastAtIndex + 1)}`;
    }
  }

  // 6. Token 扫描与提取
  const tokens = tokenizeArgs(line);
  let type: 'SSH' | 'RDP' | 'VNC' = inferredType;
  let customName: string | null = null;
  let password: string | null = embeddedPassword;
  let keyName: string | null = null;
  let proxyName: string | null = null;
  let tags: string[] = [];
  let note: string | null = null;
  let explicitPort: number | null = null;
  let explicitUser: string | null = null;

  // 收集未被选项消耗的位置参数（用于定位 target host）
  const positionalTokens: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const rawArg = tokens[i];

    if (rawArg.startsWith('-')) {
      const isDoubleDash = rawArg.startsWith('--');
      const rawFlag = rawArg.replace(/^-+/, '');
      const flagLower = rawFlag.toLowerCase();
      i++;

      // 检查标签选项 (-tag, --tag, -tags, --tags)
      if (flagLower === 'tag' || flagLower === 'tags') {
        while (i < tokens.length && !tokens[i].startsWith('-')) {
          const val = stripQuotes(tokens[i]);
          if (val.includes(',')) {
            tags.push(...val.split(',').map(t => t.trim()).filter(Boolean));
          } else if (val.trim()) {
            tags.push(val.trim());
          }
          i++;
        }
        continue;
      }

      // 检查备注选项 (-note, --note, -notes, --notes, -memo, --memo)
      if (flagLower === 'note' || flagLower === 'notes' || flagLower === 'memo') {
        const noteParts: string[] = [];
        while (i < tokens.length && !tokens[i].startsWith('-')) {
          noteParts.push(tokens[i]);
          i++;
        }
        note = stripQuotes(noteParts.join(' '));
        continue;
      }

      // 其它选项必须带有值
      if (i >= tokens.length) {
        return { error: `选项 ${rawArg} 缺少对应的值` };
      }

      const val = stripQuotes(tokens[i]);
      i++;

      // 判断选项类别（需严格区分大写 -P 与小写 -p）
      if (!isDoubleDash && rawFlag === 'P') {
        // 大写单个 -P 为端口（标准 SSH/RDP/VNC 端口选项）
        const pNum = parseInt(val, 10);
        if (!isNaN(pNum) && pNum > 0 && pNum <= 65535) {
          explicitPort = pNum;
        } else {
          return { error: `无效的端口号: ${val}` };
        }
      } else if (flagLower === 'port') {
        // -port / --port 为端口
        const pNum = parseInt(val, 10);
        if (!isNaN(pNum) && pNum > 0 && pNum <= 65535) {
          explicitPort = pNum;
        } else {
          return { error: `无效的端口号: ${val}` };
        }
      } else if (flagLower === 'pass' || flagLower === 'password' || flagLower === 'pwd') {
        // 显式密码选项
        password = val;
      } else if (flagLower === 'p') {
        // 单个小写 -p 的多义性判定：
        // 1. 如果在 ssh 命令行下且 val 为纯数字，且该行已有其他明确密码选项或有密钥选项 (-i/-k)：作为端口
        // 2. 如果在 ssh 命令行下且 val 为纯数字，且该行没有任何其他密码选项：作为端口（OpenSSH 标准：ssh -p 2222 ...）
        // 3. 否则作为密码
        const isNumeric = /^\d+$/.test(val);
        const pNum = parseInt(val, 10);
        if (isSshCli && isNumeric && pNum > 0 && pNum <= 65535) {
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
        // 私钥选项 (支持 -i, -identity, -k, -key, -sshkey)
        keyName = val;
      } else if (flagLower === 'type' || flagLower === 't') {
        const upper = val.toUpperCase();
        if (upper === 'SSH' || upper === 'RDP' || upper === 'VNC') {
          type = upper;
        } else {
          return { error: `不支持的连接类型: ${val}` };
        }
      } else if (flagLower === 'name' || flagLower === 'n') {
        customName = val;
      } else if (flagLower === 'proxy') {
        proxyName = val;
      } else if (flagLower === 'u' || flagLower === 'user' || flagLower === 'username') {
        explicitUser = val;
      } else {
        // 未知选项宽容忽略并控制台提示
        console.warn(`[ScriptParser] 忽略未知参数: ${rawArg}`);
      }
    } else {
      // 位置参数（非选项 token）
      positionalTokens.push(rawArg);
      i++;
    }
  }

  // 7. 解析 Target 主体
  if (positionalTokens.length === 0) {
    return { error: '缺少主机地址或连接目标' };
  }

  // 第一个位置参数必定为目标主机（[username@]host[:port]）
  const targetPart = stripQuotes(positionalTokens[0]);

  let username = explicitUser || 'root';
  let host = '';
  let port: number | null = explicitPort;

  if (targetPart.includes('@')) {
    const atSplit = targetPart.split('@');
    if (!explicitUser) {
      username = atSplit[0].trim() || 'root';
    }
    const hostPort = atSplit.slice(1).join('@').trim();
    if (hostPort.includes(':')) {
      const hp = hostPort.split(':');
      host = hp[0].trim();
      if (!port) {
        const pVal = parseInt(hp[1].trim(), 10);
        if (!isNaN(pVal) && pVal > 0 && pVal <= 65535) {
          port = pVal;
        } else {
          return { error: `无效的主机端口号: ${hp[1]}` };
        }
      }
    } else {
      host = hostPort;
    }
  } else {
    // 纯 host 或 host:port
    if (targetPart.includes(':')) {
      const hp = targetPart.split(':');
      host = hp[0].trim();
      if (!port) {
        const pVal = parseInt(hp[1].trim(), 10);
        if (!isNaN(pVal) && pVal > 0 && pVal <= 65535) {
          port = pVal;
        } else {
          return { error: `无效的主机端口号: ${hp[1]}` };
        }
      }
    } else {
      host = targetPart;
    }
  }

  // 容错：如果还有第 2 个位置参数，且当前尚未获取到密码且无密钥，将其作为密码
  if (positionalTokens.length > 1 && !password && !keyName) {
    password = stripQuotes(positionalTokens[1]);
  }

  if (!host) {
    return { error: `无法识别主机地址: ${targetPart}` };
  }

  // 8. 默认端口补齐与范围校验
  if (!port) {
    if (type === 'RDP') port = 3389;
    else if (type === 'VNC') port = 5900;
    else port = 22;
  }

  if (port < 1 || port > 65535) {
    return { error: `端口号必须在 1-65535 范围内: ${port}` };
  }

  // 9. 确定认证方式与完整性校验
  let auth_method: 'password' | 'key' | undefined = undefined;
  if (type === 'SSH') {
    auth_method = keyName ? 'key' : 'password';
    if (!keyName && !password) {
      return { error: `缺少认证凭证：请通过 -p 指定密码或通过 -k/-i 指定 SSH 密钥` };
    }
  } else {
    // RDP 与 VNC 必须提供密码
    if (!password) {
      return { error: `缺少认证密码：${type} 连接必须提供密码 (-p)` };
    }
  }

  // 10. 确定显示名称
  const isDefaultPort =
    (type === 'SSH' && port === 22) ||
    (type === 'RDP' && port === 3389) ||
    (type === 'VNC' && port === 5900);

  const defaultName = isDefaultPort ? `${username}@${host}` : `${username}@${host}:${port}`;
  const finalName = customName || defaultName;

  return {
    data: {
      type,
      name: finalName,
      host,
      port,
      username,
      auth_method,
      password: password ?? undefined,
      keyName: keyName ?? undefined,
      proxyName: proxyName ?? undefined,
      tags,
      note: note ?? undefined,
    }
  };
}

/**
 * 批量解析多行脚本文本
 */
export function parseScriptText(text: string): ParseScriptResult {
  const lines = text.split(/\r?\n/);
  const validConnections: ParsedScriptConnection[] = [];
  const errors: Array<{ lineIndex: number; line: string; error: string }> = [];
  let skippedLines = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const res = parseScriptSingleLine(line);
    if (res.isSkipped) {
      skippedLines++;
      continue;
    }
    if (res.error) {
      errors.push({ lineIndex: idx + 1, line, error: res.error });
      continue;
    }
    if (res.data) {
      validConnections.push(res.data);
    }
  }

  return {
    validConnections,
    errors,
    totalLines: lines.length,
    skippedLines,
  };
}
