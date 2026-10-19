import type { QuickCommandFE } from '../../stores/quickCommands.store';

/**
 * 快捷指令执行（桌面 / 移动两个视图共用）。
 *
 * 以前这段逻辑在 DesktopQuickCommandsView 和 MobileQuickCommandsView 里各有一份
 * 几乎逐字相同的实现，改一处必须记得改另一处。
 *
 * 顺带修掉两个问题：
 * 1. 变量名直接拼进 RegExp —— 名字里有 `.` `(` 之类的字符会抛异常或错配；
 * 2. 算出来的 `undefinedVariables` 从来没被读过（死代码），已删除。
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 用已保存的变量值替换 `${name}` 占位符。
 *
 * 未定义的变量保持原样（用户能看到还缺哪个），不做静默清空 ——
 * 清空会变成"执行了一条不完整的命令"，比直接报错更危险。
 */
export function resolveCommandVariables(
  template: string,
  savedVariables: Record<string, string> | null | undefined
): string {
  if (!template) return '';
  const vars = savedVariables || {};
  let result = template;
  for (const varName of Object.keys(vars)) {
    const value = vars[varName];
    if (value === undefined || value === null) continue;
    const placeholder = new RegExp(`\\$\\{${escapeRegExp(varName)}\\}`, 'g');
    // 必须用函数式替换：直接传字符串时，值里的 $& / $1 会被当成替换模式
    result = result.replace(placeholder, () => value);
  }
  return result;
}

/** 取出模板里声明的变量名（去重，按出现顺序） */
export function extractVariableNames(template: string): string[] {
  const matches = template?.match(/\$\{([^}]+)\}/g) || [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of matches) {
    const name = raw.slice(2, -1);
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export interface QuickCommandExecutionContext {
  /** 使用次数 +1 */
  incrementUsage: (id: number) => void;
  /** 当前活动 SSH 会话 */
  getActiveSessionId: () => string | null;
  /** 把处理后的命令发给工作区 */
  emitProcessed: (payload: { command: string; sessionId: string }) => void;
  /** 没有活动会话时的提示文案 */
  noActiveSessionMessage: () => string;
  /** 没有活动会话时的处理（通常是 toast） */
  onNoActiveSession: () => void;
  /** 执行完的附加回调（桌面版用来 emit 给父组件） */
  onExecuted?: (processedCommand: string) => void;
}

export function useQuickCommandExecution(ctx: QuickCommandExecutionContext) {
  function executeCommand(cmd: QuickCommandFE) {
    ctx.incrementUsage(cmd.id);

    const processedCommand = resolveCommandVariables(cmd.command, cmd.variables);

    const activeSessionId = ctx.getActiveSessionId();
    if (!activeSessionId) {
      ctx.onNoActiveSession();
      return;
    }

    ctx.emitProcessed({ command: processedCommand, sessionId: activeSessionId });
    ctx.onExecuted?.(processedCommand);
  }

  return { executeCommand };
}
