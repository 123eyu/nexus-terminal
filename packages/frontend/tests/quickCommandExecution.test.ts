import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractVariableNames,
  resolveCommandVariables,
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
