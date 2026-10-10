// packages/backend/src/sync/envelope-crypto.service.ts
import crypto from 'crypto';
import { decrypt, encrypt } from '../utils/crypto';

const ENVELOPE_PREFIX = 'env:v1:';
const GCM_IV_LENGTH = 12; // 推荐的 GCM IV 长度为 12 字节
const GCM_TAG_LENGTH = 16; // GCM 认证标签 16 字节

/**
 * 基于共享的 API Key 派生出 32 字节 AES 密钥
 */
function deriveKey(apiKey: string): Buffer {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest();
}

/**
 * 传输信封加解密服务
 * 解决桌面端与 VPS 端各自本地 ENCRYPTION_KEY 独立导致的跨端密文无法直接解密的问题
 */
export const envelopeCryptoService = {
  /**
   * 使用 API Key 将明文打包为信封密文
   */
  encryptForTransport(plainText: string, apiKey: string): string {
    if (!plainText) return '';
    const key = deriveKey(apiKey);
    const iv = crypto.randomBytes(GCM_IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // 结构：IV(12) + TAG(16) + CIPHERTEXT
    const combined = Buffer.concat([iv, tag, encrypted]);
    return `${ENVELOPE_PREFIX}${combined.toString('base64')}`;
  },

  /**
   * 使用 API Key 将信封密文解密为明文
   */
  decryptFromTransport(envelopeText: string, apiKey: string): string {
    if (!envelopeText) return '';
    if (!envelopeText.startsWith(ENVELOPE_PREFIX)) {
      throw new Error('无效的信封格式前缀');
    }

    const base64Data = envelopeText.slice(ENVELOPE_PREFIX.length);
    const combined = Buffer.from(base64Data, 'base64');

    if (combined.length < GCM_IV_LENGTH + GCM_TAG_LENGTH) {
      throw new Error('信封数据长度不足');
    }

    const iv = combined.subarray(0, GCM_IV_LENGTH);
    const tag = combined.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_TAG_LENGTH);
    const ciphertext = combined.subarray(GCM_IV_LENGTH + GCM_TAG_LENGTH);

    const key = deriveKey(apiKey);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  },

  /**
   * 将本地加密字段转换为传输信封密文 (本地密文 -> 内存明文 -> 网络信封)
   */
  convertLocalToEnvelope(localEncryptedText: string | null | undefined, apiKey: string): string | null {
    if (!localEncryptedText) return null;
    try {
      const plainText = decrypt(localEncryptedText);
      return this.encryptForTransport(plainText, apiKey);
    } catch (err: any) {
      console.warn('[EnvelopeCrypto] 本地密文解密失败，跳过信封打包:', err.message);
      return null;
    }
  },

  /**
   * 将传输信封密文转换为目标端本地密文 (网络信封 -> 内存明文 -> 目标端本地密文)
   */
  convertEnvelopeToLocal(envelopeText: string | null | undefined, apiKey: string): string | null {
    if (!envelopeText) return null;
    try {
      const plainText = this.decryptFromTransport(envelopeText, apiKey);
      return encrypt(plainText);
    } catch (err: any) {
      console.error('[EnvelopeCrypto] 网络信封解密失败:', err.message);
      throw new Error(`敏感字段信封解密失败: ${err.message}`);
    }
  }
};
