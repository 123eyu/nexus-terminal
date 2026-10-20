import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractVariableNames,
  getMissingVariableNames,
  resolveCommandVariables,
  useQuickCommandExecution,
} from '../src/composables/quickCommands/useQuickCommandExecution.ts';

test('resolveCommandVariables：基本替换', () => {
  assert.equal(
    resolveCommandVariables('ssh ${user}@${host}', { user: 'root', host: '10.0.0.1' }),
    'ssh root@10.0.0.1'
  );
});

test('resolveCommandVariables：同一变量出现多次全部替换', () => {
  assert.equal(
    resolveCommandVariables('echo ${x} && echo ${x}', { x: 'A' }),
    'echo A && echo A'
  );
});

test('resolveCommandVariables：未定义的占位符保持原样（不能静默清空）', () => {
  // 清空会变成"执行了一条不完整的命令"，比留着占位符更危险
  assert.equal(
    resolveCommandVariables('cp ${src} ${dst}', { src: '/a' }),
    'cp /a ${dst}'
  );
});

test('resolveCommandVariables：变量名含正则特殊字符不会抛错也不会错配', () => {
  // 旧实现直接拼 RegExp，名字里有 . ( ) 会抛 Invalid regular expression
  assert.equal(
    resolveCommandVariables('echo ${a.b} ${a_b}', { 'a.b': 'dot', a_b: 'under' }),
    'echo dot under'
  );
  assert.equal(
    resolveCommandVariables('run ${f(x)}', { 'f(x)': 'ok' }),
    'run ok'
  );
});

test('resolveCommandVariables：替换值里的 $ 不会被当成替换模式', () => {
  // String.replace 的第二个参数里 $& $1 有特殊含义，用函数式替换或直接传字符串要注意
  assert.equal(
    resolveCommandVariables('echo ${v}', { v: 'a$&b' }),
    'echo a$&b'
  );
});

test('resolveCommandVariables：空模板与空变量表', () => {
  assert.equal(resolveCommandVariables('', { a: '1' }), '');
  assert.equal(resolveCommandVariables('ls', {}), 'ls');
  assert.equal(resolveCommandVariables('ls ${a}', null), 'ls ${a}');
});

test('extractVariableNames：按出现顺序去重', () => {
  assert.deepEqual(
    extractVariableNames('cp ${src} ${dst} ${src}'),
    ['src', 'dst']
  );
});

test('extractVariableNames：没有占位符时返回空数组', () => {
  assert.deepEqual(extractVariableNames('ls -la'), []);
  assert.deepEqual(extractVariableNames(''), []);
});

test('getMissingVariableNames：没有占位符 / 全部有值时不缺', () => {
  assert.deepEqual(getMissingVariableNames('ls -la', { a: '' }), []);
  assert.deepEqual(getMissingVariableNames('cp ${src} ${dst}', { src: '/a', dst: '/b' }), []);
});

test('getMissingVariableNames：未定义、空串、纯空白都算没填', () => {
  assert.deepEqual(getMissingVariableNames('cp ${src} ${dst}', { src: '/a' }), ['dst']);
  assert.deepEqual(getMissingVariableNames('cp ${src} ${dst}', { src: '/a', dst: '' }), ['dst']);
  assert.deepEqual(getMissingVariableNames('cp ${src} ${dst}', { src: '   ', dst: '/b' }), ['src']);
  assert.deepEqual(getMissingVariableNames('echo ${a}', null), ['a']);
});

test('getMissingVariableNames：顺序跟随模板，且去重', () => {
  assert.deepEqual(
    getMissingVariableNames('ssh ${host} -p ${port} ${host}', { port: '' }),
    ['host', 'port']
  );
});

test('getMissingVariableNames：变量名区分大小写（与替换逻辑一致）', () => {
  assert.deepEqual(getMissingVariableNames('echo ${User}', { user: 'root' }), ['User']);
});

/** 构造一个可断言的执行环境 */
function makeCtx(overrides: Record<string, any> = {}) {
  const emitted: { command: string; sessionId: string }[] = [];
  const usage: number[] = [];
  const ctx: any = {
    incrementUsage: (id: number) => usage.push(id),
    getActiveSessionId: () => 'sess-1',
    emitProcessed: (payload: any) => emitted.push(payload),
    noActiveSessionMessage: () => 'no session',
    onNoActiveSession: () => usage.push(-1),
    ...overrides,
  };
  return { ctx, emitted, usage };
}

test('executeCommand：变量齐全时直接发送，不弹窗', async () => {
  const { ctx, emitted, usage } = makeCtx();
  let prompted = 0;
  const { executeCommand } = useQuickCommandExecution({
    ...ctx,
    promptVariables: async () => {
      prompted += 1;
      return {};
    },
  });

  await executeCommand({ id: 1, command: 'echo ${x}', variables: { x: 'hi' } } as any);

  assert.equal(prompted, 0);
  assert.deepEqual(emitted, [{ command: 'echo hi', sessionId: 'sess-1' }]);
  assert.deepEqual(usage, [1]);
});

test('executeCommand：变量为空时弹窗补填后再发送', async () => {
  const { ctx, emitted, usage } = makeCtx();
  const asked: string[][] = [];
  const { executeCommand } = useQuickCommandExecution({
    ...ctx,
    promptVariables: async (cmd) => {
      asked.push(getMissingVariableNames(cmd.command, cmd.variables));
      return { dst: '/tmp/b' };
    },
  });

  await executeCommand({ id: 7, command: 'cp ${src} ${dst}', variables: { src: '/a', dst: '' } } as any);

  assert.deepEqual(asked, [['dst']]);
  assert.deepEqual(emitted, [{ command: 'cp /a /tmp/b', sessionId: 'sess-1' }]);
  assert.deepEqual(usage, [7]);
});

test('executeCommand：用户取消补填 → 不发、不计数', async () => {
  const { ctx, emitted, usage } = makeCtx();
  const { executeCommand } = useQuickCommandExecution({
    ...ctx,
    promptVariables: async () => null,
  });

  await executeCommand({ id: 3, command: 'echo ${x}', variables: {} } as any);

  assert.deepEqual(emitted, []);
  assert.deepEqual(usage, []);
});

test('executeCommand：没有活动会话时不弹窗、不计数', async () => {
  const { ctx, emitted, usage } = makeCtx({ getActiveSessionId: () => null });
  let prompted = 0;
  const { executeCommand } = useQuickCommandExecution({
    ...ctx,
    promptVariables: async () => {
      prompted += 1;
      return {};
    },
  });

  await executeCommand({ id: 9, command: 'echo ${x}', variables: {} } as any);

  assert.equal(prompted, 0);
  assert.deepEqual(emitted, []);
  assert.deepEqual(usage, [-1]); // 走了 onNoActiveSession
});

test('executeCommand：弹窗抛异常时不执行（不把半成品命令发出去）', async () => {
  const { ctx, emitted } = makeCtx();
  const { executeCommand } = useQuickCommandExecution({
    ...ctx,
    promptVariables: async () => {
      throw new Error('boom');
    },
  });

  const originalError = console.error;
  console.error = () => {};
  try {
    await executeCommand({ id: 4, command: 'echo ${x}', variables: {} } as any);
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(emitted, []);
});
