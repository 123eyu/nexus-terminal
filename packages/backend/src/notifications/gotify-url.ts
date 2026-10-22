/**
 * Gotify 地址/参数归一化（纯函数，零依赖，可直接跑单测）。
 *
 * 这些看起来只是「拼个 URL」，但实际踩坑很集中：
 * 用户往往把 Gotify 后台那条完整消息地址粘过来（`https://host/message?token=xxx`），
 * 或者结尾多一个 `/`，或者反代在子路径上（`https://host/gotify`）。
 * 统一在这里归一化成 `协议//主机/路径前缀`，发送端只管在后面接 `/message`。
 */

export type GotifyUrlError = 'invalidUrl' | 'unsupportedProtocol';

export interface GotifyUrlResult {
    /** 归一化后的基地址（不含 `/message`，不含结尾斜杠）；失败时为 null。 */
    baseUrl: string | null;
    error?: GotifyUrlError;
}

/**
 * 归一化 Gotify 服务器地址。
 * - 自动去掉结尾 `/`
 * - 自动去掉用户误粘的 `/message`
 * - 只接受 http/https
 */
export function normalizeGotifyBaseUrl(serverUrl: string): GotifyUrlResult {
    const raw = (serverUrl || '').trim();
    if (!raw) return { baseUrl: null, error: 'invalidUrl' };

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return { baseUrl: null, error: 'invalidUrl' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { baseUrl: null, error: 'unsupportedProtocol' };
    }

    let path = parsed.pathname.replace(/\/+$/, '');
    // 用户把 `.../message` 一起粘过来的情况（query 里的 token 我们不用，token 走配置）
    path = path.replace(/\/message$/i, '');

    return { baseUrl: `${parsed.protocol}//${parsed.host}${path}` };
}

/** 拼出最终的消息投递地址。 */
export function buildGotifyMessageUrl(baseUrl: string, token: string): string {
    const base = (baseUrl || '').replace(/\/+$/, '');
    const suffix = `token=${encodeURIComponent(token || '')}`;
    return `${base}/message?${suffix}`;
}

/** 优先级钳制到 0~10 的整数，非法值回落 5（Gotify 默认）。 */
export function normalizeGotifyPriority(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return 5;
    return Math.min(10, Math.max(0, Math.round(parsed)));
}
