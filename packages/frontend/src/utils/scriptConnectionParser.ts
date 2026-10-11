/**
 * 脚本模式连接批量导入解析器
 * 支持多种灵活格式：
 * 1. 标准选项式：user@host:port -p password -k keyName -name "别名" -note "备注"
 * 2. 缺省用户名/端口：192.168.1.1 -p password (默认 root:22)
 * 3. 命令行式：ssh root@192.168.1.1 -P 2222 -p password
 * 4. URL 嵌入式：ssh://root:password@192.168.1.1:22
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
 * 分词辅助函数：按空格切分，但保留双引号内的字符串
 */
export function tokenizeArgs(str: string): string[] {
  const result: string[] = [];
  const regex = /(?:[^\s"]+|"[^"]*")+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(str)) !== null) {
    result.push(match[0]);
  }
  return result;
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

  // 2. 协议前缀识别与去除 (ssh://, rdp://, vnc://)
  let inferredType: 'SSH' | 'RDP' | 'VNC' = 'SSH';
  const urlProtocolMatch = line.match(/^(ssh|rdp|vnc):\/\/(.*)$/i);
  if (urlProtocolMatch) {
    inferredType = urlProtocolMatch[1].toUpperCase() as 'SSH' | 'RDP' | 'VNC';
    line = urlProtocolMatch[2].trim();
  } else if (/^ssh\s+/i.test(line)) {
    // 兼容命令行复制：如 "ssh root@1.2.3.4"
    inferredType = 'SSH';
    line = line.replace(/^ssh\s+/i, '').trim();
  }

  // 3. 常见四段冒号格式：host:port:user:password
  // 例如：192.168.1.1:22:root:Admin@2026
  const fourMatch = line.match(/^([^:\s]+):(\d{1,5}):([^:\s]+):(.*)$/);
  if (fourMatch && !line.includes(' -') && !line.includes(' --')) {
    const cHost = fourMatch[1].trim();
    const cPort = parseInt(fourMatch[2], 10);
    const cUser = fourMatch[3].trim();
    const cPass = fourMatch[4];
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

  // 4. URL 嵌入式格式：user:password@host[:port]
  let embeddedPassword: string | null = null;
  // 查找分隔 host 的最后一个 @ (避免密码中含有 @ 导致切错)
  const lastAtIndex = line.lastIndexOf('@');
  if (lastAtIndex !== -1 && !line.startsWith('-')) {
    const userPassPart = line.substring(0, lastAtIndex);
    const colonInUserPass = userPassPart.indexOf(':');
    if (colonInUserPass !== -1 && !userPassPart.startsWith('"')) {
      const u = userPassPart.substring(0, colonInUserPass).trim();
      const p = userPassPart.substring(colonInUserPass + 1);
      if (u) {
        embeddedPassword = p;
        // 重写 line，把前面的 user:pass@ 替换为 user@
        line = `${u}@${line.substring(lastAtIndex + 1)}`;
      }
    }
  }

  // 5. 提取 target 主体（首个 token）与剩余选项
  const firstSpaceIndex = line.indexOf(' ');
  const targetPart = firstSpaceIndex === -1 ? line : line.substring(0, firstSpaceIndex).trim();
  const optionsString = firstSpaceIndex === -1 ? '' : line.substring(firstSpaceIndex + 1).trim();

  // 6. 解析 targetPart：[username@]host[:port]
  let username = 'root';
  let host = '';
  let port: number | null = null;

  if (targetPart.includes('@')) {
    const atSplit = targetPart.split('@');
    username = atSplit[0].trim() || 'root';
    const hostPort = atSplit.slice(1).join('@').trim(); // 避免 host 里包含 @
    if (hostPort.includes(':')) {
      const hp = hostPort.split(':');
      host = hp[0].trim();
      const pVal = parseInt(hp[1].trim(), 10);
      if (!isNaN(pVal) && pVal > 0 && pVal <= 65535) {
        port = pVal;
      }
    } else {
      host = hostPort;
    }
  } else {
    // 纯 host 或 host:port（无用户名，默认 root）
    if (targetPart.includes(':')) {
      const hp = targetPart.split(':');
      host = hp[0].trim();
      const pVal = parseInt(hp[1].trim(), 10);
      if (!isNaN(pVal) && pVal > 0 && pVal <= 65535) {
        port = pVal;
      }
    } else {
      host = targetPart;
    }
  }

  if (!host) {
    return { error: `无法识别主机地址：${targetPart}` };
  }

  // 7. 解析参数选项
  let type: 'SSH' | 'RDP' | 'VNC' = inferredType;
  let customName: string | null = null;
  let password: string | null = embeddedPassword;
  let keyName: string | null = null;
  let proxyName: string | null = null;
  let tags: string[] = [];
  let note: string | null = null;

  // 检查是否是空白分隔的 3~4 段纯文本格式（如: 192.168.1.1 22 root password）
  const tokens = tokenizeArgs(optionsString);
  if (tokens.length >= 2 && !tokens.some(t => t.startsWith('-'))) {
    // 可能是 host 后面紧跟 port user password
    // 例如 targetPart 是 host，tokens 是 [22, root, pass]
    if (tokens.length === 3 && /^\d+$/.test(tokens[0])) {
      port = parseInt(tokens[0], 10);
      username = tokens[1].replace(/^"|"$/g, '');
      password = tokens[2].replace(/^"|"$/g, '');
      return {
        data: {
          type,
          name: `${username}@${host}`,
          host,
          port: port || 22,
          username,
          auth_method: 'password',
          password,
          tags: [],
          note: '',
        }
      };
    } else if (tokens.length === 2 && /^\d+$/.test(tokens[0])) {
      // 如 host 22 pass
      port = parseInt(tokens[0], 10);
      password = tokens[1].replace(/^"|"$/g, '');
      return {
        data: {
          type,
          name: `${username}@${host}`,
          host,
          port: port || 22,
          username,
          auth_method: 'password',
          password,
          tags: [],
          note: '',
        }
      };
    }
  }

  let i = 0;
  while (i < tokens.length) {
    const rawArg = tokens[i];
    if (rawArg.startsWith('-')) {
      // 统一去除开头的 '-' 或 '--'，并转为小写
      const key = rawArg.replace(/^-+/, '').toLowerCase();
      i++;

      if (key === 'tag' || key === 'tags') {
        // -tags 可以跟多个空格分隔的标签，或者逗号分隔
        while (i < tokens.length && !tokens[i].startsWith('-')) {
          const val = tokens[i].replace(/^"|"$/g, '');
          if (val.includes(',')) {
            tags.push(...val.split(',').map(t => t.trim()).filter(Boolean));
          } else if (val.trim()) {
            tags.push(val.trim());
          }
          i++;
        }
      } else if (key === 'note' || key === 'notes') {
        // -note 消费后续所有内容
        const noteParts: string[] = [];
        while (i < tokens.length) {
          noteParts.push(tokens[i]);
          i++;
        }
        note = noteParts.join(' ').replace(/^"|"$/g, '');
        break;
      } else {
        if (i >= tokens.length) {
          // 参数缺少对应的值
          return { error: `选项 ${rawArg} 缺少对应的值` };
        }
        const val = tokens[i].replace(/^"|"$/g, '');
        i++;

        switch (key) {
          case 'type':
          case 't': {
            const upper = val.toUpperCase();
            if (upper === 'SSH' || upper === 'RDP' || upper === 'VNC') {
              type = upper;
            } else {
              return { error: `不支持的连接类型: ${val}` };
            }
            break;
          }
          case 'name':
          case 'n':
            customName = val;
            break;
          case 'p':
          case 'pass':
          case 'password':
            password = val;
            break;
          case 'port': {
            const pNum = parseInt(val, 10);
            if (!isNaN(pNum) && pNum > 0 && pNum <= 65535) {
              port = pNum;
            } else {
              return { error: `无效的端口号: ${val}` };
            }
            break;
          }
          case 'k':
          case 'key':
          case 'sshkey':
            keyName = val;
            break;
          case 'proxy':
            proxyName = val;
            break;
          case 'u':
          case 'user':
          case 'username':
            username = val;
            break;
          default:
            // 宽容容错：若遇到未知选项不强制爆炸，作为警告或忽略
            console.warn(`[ScriptParser] 忽略未知参数: ${rawArg}`);
            break;
        }
      }
    } else {
      // 容错：如果有未带 - 的悬空参数，且当前没有密码，尝试将其作为密码
      if (!password && !keyName) {
        password = rawArg.replace(/^"|"$/g, '');
      }
      i++;
    }
  }

  // 8. 默认端口补齐
  if (!port) {
    if (type === 'RDP') port = 3389;
    else if (type === 'VNC') port = 5900;
    else port = 22;
  }

  // 9. 确定认证方式
  let auth_method: 'password' | 'key' | undefined = undefined;
  if (type === 'SSH') {
    auth_method = keyName ? 'key' : 'password';
  }

  // 10. 确定显示名称
  const defaultName = port === 22 || port === 3389 || port === 5900
    ? `${username}@${host}`
    : `${username}@${host}:${port}`;
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
 * 批量解析多行脚本
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
