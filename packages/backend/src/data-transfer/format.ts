import crypto from 'crypto';

/**
 * 导出包的磁盘格式。
 *
 * 一个导出包就是一个 zip，里面只有三个文件：
 *   manifest.json  明文。格式标识、版本、加密参数、每个数据集有多少条。
 *   payload.enc    密文。真正的数据（JSON 序列化后整体 AES-256-GCM）。
 *   README.txt     明文。给人看的恢复说明。
 *
 * 为什么是「整体加密」而不是「逐个文件加密」：
 * 1. manifest 必须明文，否则导入器在不知道密码时无法判断"这是不是我的包、版本对不对"；
 * 2. 只有一处加解密，出错点少；AES-GCM 自带认证，密码错 == 解密失败，不需要额外校验位；
 * 3. 不依赖 zip 级加密库（archiver-zip-encrypted 这类实现兼容性差，且不支持 AEAD）。
 *
 * ⚠️ 包密码与数据库的 ENCRYPTION_KEY 是两回事。前者由用户在导出时自定，
 * 后者只用于落库加密。混用会导致「丢了 .env 就永久打不开自己的备份」。
 */

export const EXPORT_FORMAT = 'nexus-terminal-export';

/** 包格式版本。只增不减；导入器只认识 <= 自己支持的版本。 */
export const EXPORT_SCHEMA_VERSION = 1;

export const EXPORT_ENTRY_MANIFEST = 'manifest.json';
export const EXPORT_ENTRY_PAYLOAD = 'payload.enc';
export const EXPORT_ENTRY_README = 'README.txt';

export type SecretMode = 'encrypted' | 'stripped';

export interface ExportDatasetInfo {
    key: string;
    count: number;
}

export interface ExportManifest {
    format: string;
    schemaVersion: number;
    appVersion: string;
    exportedAt: string;
    secretMode: SecretMode;
    payload: { entry: string; bytes: number; sha256: string };
    kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number; keyLength: number };
    cipher: { name: 'aes-256-gcm'; iv: string; tag: string };
    datasets: ExportDatasetInfo[];
}

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLength: 32 } as const;

export const MIN_PASSWORD_LENGTH = 8;

/** 密码错误。导入时要把它转成「密码不对」，而不是笼统的 500。 */
export class BadPasswordError extends Error {
    constructor() {
        super('BAD_PASSWORD');
        this.name = 'BadPasswordError';
    }
}

/** 包本身不合法（不是我们的包 / 版本太新 / 结构不对）。 */
export class InvalidPackageError extends Error {
    // 显式声明字段而不是构造器参数属性：node --experimental-strip-types 只做类型擦除，
    // 不支持 `constructor(public readonly x)` 这种会生成代码的语法。
    readonly reason: ManifestErrorReason;

    constructor(reason: ManifestErrorReason, message?: string) {
        super(message || reason);
        this.name = 'InvalidPackageError';
        this.reason = reason;
    }
}

export type ManifestErrorReason =
    | 'notObject'
    | 'wrongFormat'
    | 'tooNew'
    | 'badVersion'
    | 'missingPayload'
    | 'badCipher'
    | 'badKdf'
    | 'missingDatasets';

export function sha256Hex(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function deriveKey(password: string, salt: Buffer, params = SCRYPT_PARAMS): Buffer {
    // maxmem 必须显式给：默认 32MB，128*N*r = 16MB 刚好踩线，参数稍大就会抛错。
    return crypto.scryptSync(password, salt, params.keyLength, {
        N: params.N,
        r: params.r,
        p: params.p,
        maxmem: 128 * 1024 * 1024,
    });
}

export interface EncryptedPayload {
    data: Buffer;
    salt: Buffer;
    iv: Buffer;
    tag: Buffer;
}

export function encryptPayload(plain: Buffer, password: string): EncryptedPayload {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(password, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { data, salt, iv, tag: cipher.getAuthTag() };
}

export function decryptPayload(
    data: Buffer,
    password: string,
    salt: Buffer,
    iv: Buffer,
    tag: Buffer
): Buffer {
    const key = deriveKey(password, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    try {
        return Buffer.concat([decipher.update(data), decipher.final()]);
    } catch {
        // GCM 认证失败只有一种常见原因就是密码错，统一抛出可识别的错误
        throw new BadPasswordError();
    }
}

export function buildManifest(input: {
    appVersion: string;
    exportedAt: Date;
    secretMode: SecretMode;
    payload: EncryptedPayload;
    datasets: ExportDatasetInfo[];
}): ExportManifest {
    return {
        format: EXPORT_FORMAT,
        schemaVersion: EXPORT_SCHEMA_VERSION,
        appVersion: input.appVersion,
        exportedAt: input.exportedAt.toISOString(),
        secretMode: input.secretMode,
        payload: {
            entry: EXPORT_ENTRY_PAYLOAD,
            bytes: input.payload.data.length,
            sha256: sha256Hex(input.payload.data),
        },
        kdf: {
            name: 'scrypt',
            salt: input.payload.salt.toString('base64'),
            ...SCRYPT_PARAMS,
        },
        cipher: {
            name: 'aes-256-gcm',
            iv: input.payload.iv.toString('base64'),
            tag: input.payload.tag.toString('base64'),
        },
        datasets: input.datasets,
    };
}

function isPlainObject(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64(value: unknown): Buffer | null {
    if (typeof value !== 'string' || value.length === 0) return null;
    try {
        const buf = Buffer.from(value, 'base64');
        return buf.length > 0 ? buf : null;
    } catch {
        return null;
    }
}

export interface ValidatedManifest {
    manifest: ExportManifest;
    salt: Buffer;
    iv: Buffer;
    tag: Buffer;
}

/**
 * 解析并校验 manifest。任何一个字段不合法都拒绝，绝不"尽力而为"——
 * 半解析的 manifest 会让后面写库时出现难以解释的状态。
 */
export function validateManifest(
    raw: unknown,
    supportedVersion: number = EXPORT_SCHEMA_VERSION
): ValidatedManifest {
    if (!isPlainObject(raw)) throw new InvalidPackageError('notObject');
    if (raw.format !== EXPORT_FORMAT) throw new InvalidPackageError('wrongFormat');

    const version = raw.schemaVersion;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        throw new InvalidPackageError('badVersion');
    }
    if (version > supportedVersion) {
        throw new InvalidPackageError(
            'tooNew',
            `Package schema ${version} is newer than supported ${supportedVersion}`
        );
    }

    if (!isPlainObject(raw.payload) || typeof raw.payload.sha256 !== 'string') {
        throw new InvalidPackageError('missingPayload');
    }
    if (!isPlainObject(raw.cipher) || raw.cipher.name !== 'aes-256-gcm') {
        throw new InvalidPackageError('badCipher');
    }
    if (!isPlainObject(raw.kdf) || raw.kdf.name !== 'scrypt') {
        throw new InvalidPackageError('badKdf');
    }

    const salt = decodeBase64(raw.kdf.salt);
    const iv = decodeBase64(raw.cipher.iv);
    const tag = decodeBase64(raw.cipher.tag);
    if (!salt || !iv || !tag) throw new InvalidPackageError('badCipher');

    if (!Array.isArray(raw.datasets)) throw new InvalidPackageError('missingDatasets');

    const datasets: ExportDatasetInfo[] = [];
    for (const item of raw.datasets) {
        if (!isPlainObject(item)) continue;
        if (typeof item.key !== 'string' || item.key.length === 0) continue;
        const count = typeof item.count === 'number' && Number.isFinite(item.count) ? item.count : 0;
        datasets.push({ key: item.key, count });
    }

    const manifest: ExportManifest = {
        format: EXPORT_FORMAT,
        schemaVersion: version,
        appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : 'unknown',
        exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
        secretMode: raw.secretMode === 'stripped' ? 'stripped' : 'encrypted',
        payload: {
            entry: typeof raw.payload.entry === 'string' ? raw.payload.entry : EXPORT_ENTRY_PAYLOAD,
            bytes: typeof raw.payload.bytes === 'number' ? raw.payload.bytes : 0,
            sha256: raw.payload.sha256,
        },
        kdf: {
            name: 'scrypt',
            salt: raw.kdf.salt,
            N: Number(raw.kdf.N) || SCRYPT_PARAMS.N,
            r: Number(raw.kdf.r) || SCRYPT_PARAMS.r,
            p: Number(raw.kdf.p) || SCRYPT_PARAMS.p,
            keyLength: Number(raw.kdf.keyLength) || SCRYPT_PARAMS.keyLength,
        },
        cipher: {
            name: 'aes-256-gcm',
            iv: raw.cipher.iv,
            tag: raw.cipher.tag,
        },
        datasets,
    };

    return { manifest, salt, iv, tag };
}

/** 校验密码长度。前端也会拦，但后端不能只靠前端。 */
export function isPasswordAcceptable(password: unknown): password is string {
    return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH;
}

export function buildReadme(manifest: ExportManifest): string {
    const lines = [
        'Nexus Terminal 数据导出包',
        '',
        `导出时间：${manifest.exportedAt}`,
        `导出程序版本：${manifest.appVersion}`,
        `包格式版本：${manifest.schemaVersion}`,
        `敏感信息：${manifest.secretMode === 'stripped' ? '未包含（密码/私钥已清除）' : '已包含（用你设置的密码加密）'}`,
        '',
        '内容清单：',
        ...manifest.datasets.map((d) => `  - ${d.key}: ${d.count} 条`),
        '',
        '如何恢复：',
        '  1. 登录 Nexus Terminal，进入 设置 → 数据管理 → 导入数据；',
        '  2. 选择本 zip 文件，输入导出时设置的密码；',
        '  3. 先看一遍预览（会显示新增/冲突/无效各多少条），确认后再执行导入。',
        '',
        '注意：',
        '  - 这个密码只在导出时设置，和服务器上的 ENCRYPTION_KEY 无关；',
        '  - 密码丢失后包内数据无法恢复，请与文件分开保存密码。',
        '',
    ];
    return lines.join('\n');
}
