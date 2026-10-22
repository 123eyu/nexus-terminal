import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildChownCommand, isValidChownName, shellQuote } from '../src/sftp/chown-command.ts';

/**
 * 修改文件所有者（chown）的命令生成。
 *
 * 这里最容易出的事故是 shell 注入 —— 用户名和路径都会被拼进一条在远端执行命令的
 * shell 字符串里。所以单测的重点是「非法字符必须被拒」，而不是命令长什么样。
 */

test('所有者/组名只接受安全字符', () => {
    assert.equal(isValidChownName('www-data'), true);
    assert.equal(isValidChownName('root'), true);
    assert.equal(isValidChownName('1000'), true);
    assert.equal(isValidChownName('user.name_1'), true);

    assert.equal(isValidChownName(''), false);
    assert.equal(isValidChownName('a b'), false);
    assert.equal(isValidChownName('root:root'), false, '冒号由我们自己拼，不该从输入里传');
    assert.equal(isValidChownName('a/b'), false);
    assert.equal(isValidChownName('$(id)'), false);
    assert.equal(isValidChownName('a;rm -rf /'), false);
    assert.equal(isValidChownName('a`whoami`'), false);
});

test('只改用户 / 只改组 / 两者都改', () => {
    assert.deepEqual(buildChownCommand('/var/www', { owner: 'www-data' }), {
        command: 'chown -- www-data /var/www',
        spec: 'www-data',
    });
    assert.deepEqual(buildChownCommand('/var/www', { group: 'www-data' }), {
        command: 'chown -- :www-data /var/www',
        spec: ':www-data',
    });
    assert.deepEqual(buildChownCommand('/var/www', { owner: 'nginx', group: 'nginx' }), {
        command: 'chown -- nginx:nginx /var/www',
        spec: 'nginx:nginx',
    });
});

test('两个都不填就不执行', () => {
    const result = buildChownCommand('/var/www', {});
    assert.equal(result.command, null);
    assert.equal(result.error, 'emptyTargets');
});

test('非法输入被拒绝，且不会拼出命令行', () => {
    assert.equal(buildChownCommand('/x', { owner: 'a b' }).error, 'invalidOwner');
    assert.equal(buildChownCommand('/x', { owner: 'a b' }).command, null);
    assert.equal(buildChownCommand('/x', { group: 'g;h' }).error, 'invalidGroup');
    assert.equal(buildChownCommand('/x', { owner: 'ok', group: '$(x)' }).command, null);
});

test('带空格/中文/单引号的路径被正确转义', () => {
    assert.equal(shellQuote('/opt/my app'), "'/opt/my app'");
    assert.equal(shellQuote("/opt/it's"), `'/opt/it'\\''s'`);
    assert.equal(buildChownCommand("/数据/我的'文件", { owner: 'root' }).command,
        `chown -- root '/数据/我的'\\''文件'`);
});

test('以 - 开头的路径不会被当成选项', () => {
    assert.equal(buildChownCommand('-rf', { owner: 'root' }).command, 'chown -- root -rf');
});
