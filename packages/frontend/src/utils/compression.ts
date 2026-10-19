/**
 * 请求体压缩。
 *
 * 工作区快照里 84% 的体积是终端 buffer（实测 1.2MB 里 1.0MB 是 ANSI 文本），
 * 直接 POST 会给带宽和移动端网络带来明显开销。gzip 对这类文本的压缩比在 8x 左右。
 *
 * 用浏览器原生 `CompressionStream`，不引第三方库：
 * - Chrome/Edge 80+、Safari 16.4+、Tauri 的 WebView2 都支持
 * - 不支持时返回 null，调用方回退到未压缩上传（功能不受影响）
 *
 * 后端不需要任何改动：`express.json()` 的 `inflate` 默认为 true，
 * 收到 `Content-Encoding: gzip` 会自动解压再解析 JSON。
 */

/** 环境是否支持流式压缩（只用来提前给出可读的降级日志） */
export function canCompressRequest(): boolean {
  return typeof CompressionStream !== 'undefined';
}

/**
 * 把文本压成 gzip 字节流。失败或环境不支持时返回 null（调用方应回退）。
 *
 * 注意返回值是 `Uint8Array` 而不是 base64 字符串：
 * base64 会让体积凭空涨 33%，直接发二进制才能把收益吃满。
 */
export async function gzipText(text: string): Promise<Uint8Array | null> {
  if (!canCompressRequest()) return null;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  } catch (error) {
    console.warn('[compression] gzip 压缩失败，本次回退为未压缩上传:', error);
    return null;
  }
}
