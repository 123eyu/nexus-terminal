import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildGotifyMessageUrl,
    normalizeGotifyBaseUrl,
    normalizeGotifyPriority,
} from '../src/notifications/gotify-url.ts';

/**
 * Gotify 地址归一化。
 *
 * 真实用户输入五花八门：结尾多个 `/`、直接把 `/message?token=...` 整条粘过来、
 * 反代到子路径、甚至填成 `ws://`。归一化错了的表现是 404 或者「和 Gotify 服务器通信失败」，
 * 用户完全不知道自己哪填错了，所以这几条要钉死。
 */

test('常见写法都能归一化到同一个基地址', () => {
    assert.deepEqual(normalizeGotifyBaseUrl('https://gotify.example.com'), {
        baseUrl: 'https://gotify.example.com',
    });
    assert.deepEqual(normalizeGotifyBaseUrl('https://gotify.example.com/'), {
        baseUrl: 'https://gotify.example.com',
    });
    assert.deepEqual(normalizeGotifyBaseUrl('  https://gotify.example.com///  '), {
        baseUrl: 'https://gotify.example.com',
    });
});

test('粘上 /message 或整条消息地址也能救回来', () => {
    assert.equal(normalizeGotifyBaseUrl('https://gotify.example.com/message').baseUrl,
        'https://gotify.example.com');
    assert.equal(normalizeGotifyBaseUrl('https://gotify.example.com/message?token=abc').baseUrl,
        'https://gotify.example.com');
});

test('反代到子路径时保留前缀', () => {
    assert.equal(normalizeGotifyBaseUrl('https://host/gotify/').baseUrl, 'https://host/gotify');
    assert.equal(normalizeGotifyBaseUrl('https://host/gotify/message').baseUrl, 'https://host/gotify');
});

test('端口保留，非法协议与空值被拒绝', () => {
    assert.equal(normalizeGotifyBaseUrl('http://192.168.1.5:8080').baseUrl, 'http://192.168.1.5:8080');
    assert.equal(normalizeGotifyBaseUrl('ws://gotify.example.com').error, 'unsupportedProtocol');
    assert.equal(normalizeGotifyBaseUrl('gotify.example.com').error, 'invalidUrl');
    assert.equal(normalizeGotifyBaseUrl('').error, 'invalidUrl');
});

test('消息地址里的 token 会被正确编码', () => {
    assert.equal(buildGotifyMessageUrl('https://gotify.example.com', 'A1b2.C3d4'),
        'https://gotify.example.com/message?token=A1b2.C3d4');
    assert.equal(buildGotifyMessageUrl('https://host/gotify/', 'a b&c'),
        'https://host/gotify/message?token=a%20b%26c');
});

test('优先级钳制到 0~10，非法值回落 5', () => {
    assert.equal(normalizeGotifyPriority(8), 8);
    assert.equal(normalizeGotifyPriority(0), 0);
    assert.equal(normalizeGotifyPriority(99), 10);
    assert.equal(normalizeGotifyPriority(-3), 0);
    assert.equal(normalizeGotifyPriority(4.6), 5);
    assert.equal(normalizeGotifyPriority(undefined), 5);
    assert.equal(normalizeGotifyPriority('7'), 7);
    assert.equal(normalizeGotifyPriority('abc'), 5);
});
