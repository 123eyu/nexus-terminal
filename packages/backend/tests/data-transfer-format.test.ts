import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    BadPasswordError,
    EXPORT_FORMAT,
    EXPORT_SCHEMA_VERSION,
    InvalidPackageError,
    buildManifest,
    buildReadme,
    decryptPayload,
    encryptPayload,
    isPasswordAcceptable,
    sha256Hex,
    validateManifest,
} from '../src/data-transfer/format.ts';

/**
 * 导出包的格式层。
 *
 * 这里的分量全在「导入方能不能安全地拒绝坏包」——文件来自用户上传，
 * 任何字段都可能是垃圾。所以断言的重点是 throw 的 reason，
 * 而不是"能用就行"。
 */

const PW = 'correct horse battery';

function makeManifest() {
    const plain = Buffer.from(JSON.stringify({ datasets: {} }), 'utf8');
    const encrypted = encryptPayload(plain, PW);
    return buildManifest({
        appVersion: '0.9.12',
        exportedAt: new Date('2026-10-22T12:00:00.000Z'),
        secretMode: 'encrypted',
        payload: encrypted,
        datasets: [{ key: 'connections', count: 3 }],
    });
}

test('密文可以原样解回明文', () => {
    const plain = Buffer.from('中文也要能往返 🚀', 'utf8');
    const enc = encryptPayload(plain, PW);
    const back = decryptPayload(enc.data, PW, enc.salt, enc.iv, enc.tag);
    assert.deepEqual(back, plain);
});

test('密码错时抛 BadPasswordError 而不是随便一个异常', () => {
    const enc = encryptPayload(Buffer.from('secret'), PW);
    assert.throws(
        () => decryptPayload(enc.data, 'wrong password', enc.salt, enc.iv, enc.tag),
        (error: unknown) => error instanceof BadPasswordError
    );
});

test('相同明文两次加密得到不同密文（salt/iv 每次都随机）', () => {
    const plain = Buffer.from('same content');
    const a = encryptPayload(plain, PW);
    const b = encryptPayload(plain, PW);
    assert.notEqual(a.data.toString('hex'), b.data.toString('hex'));
    assert.notEqual(a.salt.toString('hex'), b.salt.toString('hex'));
    assert.notEqual(a.iv.toString('hex'), b.iv.toString('hex'));
});

test('manifest 字段齐全且可反向解析', () => {
    const manifest = makeManifest();
    assert.equal(manifest.format, EXPORT_FORMAT);
    assert.equal(manifest.schemaVersion, EXPORT_SCHEMA_VERSION);
    assert.equal(manifest.secretMode, 'encrypted');
    assert.equal(manifest.cipher.name, 'aes-256-gcm');
    assert.equal(manifest.kdf.name, 'scrypt');
    assert.equal(manifest.payload.sha256.length, 64);
    assert.deepEqual(manifest.datasets, [{ key: 'connections', count: 3 }]);
});

test('合法 manifest 能通过校验', () => {
    const manifest = makeManifest();
    const validated = validateManifest(JSON.parse(JSON.stringify(manifest)));
    assert.equal(validated.manifest.schemaVersion, EXPORT_SCHEMA_VERSION);
    assert.equal(validated.salt.length, 16);
    assert.equal(validated.iv.length, 12);
    assert.equal(validated.tag.length, 16);
});

test('别的程序的包会被拒绝', () => {
    const manifest = makeManifest();
    const broken = { ...manifest, format: 'some-other-tool' };
    assert.throws(
        () => validateManifest(broken),
        (error: unknown) => error instanceof InvalidPackageError && error.reason === 'wrongFormat'
    );
});

test('来自更高版本的包会被拒绝（宁可拒绝，也不要半懂不懂地写库）', () => {
    const manifest = makeManifest();
    const future = { ...manifest, schemaVersion: EXPORT_SCHEMA_VERSION + 1 };
    assert.throws(
        () => validateManifest(future),
        (error: unknown) => error instanceof InvalidPackageError && error.reason === 'tooNew'
    );
});

test('版本号非法时拒绝', () => {
    const manifest = makeManifest();
    for (const bad of [0, -1, 1.5, '1', null]) {
        assert.throws(
            () => validateManifest({ ...manifest, schemaVersion: bad }),
            (error: unknown) => error instanceof InvalidPackageError && error.reason === 'badVersion'
        );
    }
});

test('缺 payload / cipher / kdf 时各自的 reason 正确', () => {
    const manifest = makeManifest();
    const cases: Array<[Record<string, unknown>, string]> = [
        [{ ...manifest, payload: undefined }, 'missingPayload'],
        [{ ...manifest, cipher: undefined }, 'badCipher'],
        [{ ...manifest, kdf: undefined }, 'badKdf'],
        [{ ...manifest, datasets: undefined }, 'missingDatasets'],
    ];
    for (const [input, reason] of cases) {
        assert.throws(
            () => validateManifest(input),
            (error: unknown) => error instanceof InvalidPackageError && error.reason === reason
        );
    }
});

test('cipher 里的 base64 坏掉时拒绝', () => {
    const manifest = makeManifest();
    const broken = JSON.parse(JSON.stringify(manifest));
    broken.cipher.iv = '';
    assert.throws(
        () => validateManifest(broken),
        (error: unknown) => error instanceof InvalidPackageError && error.reason === 'badCipher'
    );
});

test('数据集清单里的坏条目被丢弃，不影响其它条目', () => {
    const manifest = makeManifest();
    const dirty = JSON.parse(JSON.stringify(manifest));
    dirty.datasets = [{ key: 'connections', count: 3 }, { count: 1 }, null, { key: 'tags', count: 2 }];
    const validated = validateManifest(dirty);
    assert.deepEqual(
        validated.manifest.datasets.map((item) => item.key),
        ['connections', 'tags']
    );
});

test('密码长度下限', () => {
    assert.equal(isPasswordAcceptable('1234567'), false);
    assert.equal(isPasswordAcceptable('12345678'), true);
    assert.equal(isPasswordAcceptable(''), false);
    assert.equal(isPasswordAcceptable(12345678), false);
});

test('sha256Hex 稳定', () => {
    assert.equal(
        sha256Hex(Buffer.from('abc')),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
});

test('README 里带上版本与数据集条数', () => {
    const readme = buildReadme(makeManifest());
    assert.match(readme, /0\.9\.12/);
    assert.match(readme, /connections: 3 条/);
    assert.match(readme, /数据管理/);
});
