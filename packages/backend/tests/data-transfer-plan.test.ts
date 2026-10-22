import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    aggregatePlan,
    buildDuplicateName,
    buildIdentityKey,
    classifyRows,
    isBlankIdentity,
    normalizeIdentityValue,
} from '../src/data-transfer/plan.ts';

/**
 * 冲突判定。
 *
 * 这段逻辑被"预览"和"执行"共用，所以它错一次会同时错两处 ——
 * 预览说新增 5 条、实际新增 3 条，用户就再也不敢信这个功能了。
 */

test('身份值归一化：NULL 与空串等价，数字转字符串', () => {
    assert.equal(normalizeIdentityValue(null), '');
    assert.equal(normalizeIdentityValue(undefined), '');
    assert.equal(normalizeIdentityValue('  web  '), 'web');
    assert.equal(normalizeIdentityValue(22), '22');
    assert.equal(normalizeIdentityValue(0), '0');
});

test('身份键用不可见分隔符拼接，不会因为字段里含逗号而串位', () => {
    const withComma = buildIdentityKey(['name', 'host'], { name: 'a,b', host: 'c' });
    const shifted = buildIdentityKey(['name', 'host'], { name: 'a', host: 'b,c' });
    assert.notEqual(withComma, shifted);
});

test('身份列全空判定为无效行', () => {
    assert.equal(isBlankIdentity(['name'], { name: null }), true);
    assert.equal(isBlankIdentity(['name'], { name: '   ' }), true);
    assert.equal(isBlankIdentity(['name'], { name: 'x' }), false);
    assert.equal(
        isBlankIdentity(['host', 'port'], { host: 'example.com', port: null }),
        false,
        '只要有一列非空就不算空身份'
    );
});

test('新增与冲突的拆分', () => {
    const rows = [
        { host: 'a', port: 22 },
        { host: 'b', port: 22 },
        { host: 'a', port: 22 },
    ];
    const existing = new Set([buildIdentityKey(['host', 'port'], { host: 'a', port: 22 })]);
    const plan = aggregatePlan('connections', rows, ['host', 'port'], existing);

    assert.equal(plan.incoming, 3);
    assert.equal(plan.conflict, 2, 'a:22 出现两次且已存在');
    assert.equal(plan.create, 1, '只有 b:22 是新的');
    assert.equal(plan.invalid, 0);
});

test('空身份行计入 invalid 并带索引', () => {
    const rows = [{ host: 'a', port: 22 }, { host: null, port: null }];
    const plan = aggregatePlan('connections', rows, ['host', 'port'], new Set());

    assert.equal(plan.invalid, 1);
    assert.equal(plan.create, 1);
    assert.deepEqual(plan.errors[0], { index: 1, message: 'missingIdentity' });
});

test('外部传入的无效项（例如缺代理）也计入 invalid，且不重复计数', () => {
    const rows = [{ host: 'a', port: 22 }, { host: 'b', port: 22 }];
    const plan = aggregatePlan('connections', rows, ['host', 'port'], new Set(), [
        { index: 0, message: 'missingReference:proxies' },
    ]);

    assert.equal(plan.invalid, 1);
    assert.equal(plan.create, 1, '被标为无效的那行不能再算新增');
    assert.equal(plan.errors.length, 1);
});

test('classifyRows 与 aggregatePlan 的结论一致', () => {
    const rows = [{ name: 'x' }, { name: 'y' }];
    const existing = new Set(['x']);
    const classified = classifyRows(rows, ['name'], existing);
    const plan = aggregatePlan('tags', rows, ['name'], existing);

    assert.equal(classified.filter((item) => item.exists).length, plan.conflict);
    assert.equal(classified.filter((item) => !item.exists).length, plan.create);
});

test('duplicate 策略下的重命名不撞已有名字', () => {
    const existing = new Set(['web-1', 'web-1 (2)', 'web-1 (3)']);
    assert.equal(buildDuplicateName('web-1', existing), 'web-1 (4)');
});

test('无冲突时 duplicate 从 (2) 开始', () => {
    assert.equal(buildDuplicateName('web-1', new Set()), 'web-1 (2)');
});

test('名字为空时 duplicate 也能给个可用名字', () => {
    assert.equal(buildDuplicateName(null, new Set()), '(2)');
    assert.equal(buildDuplicateName('   ', new Set()), '(2)');
});
