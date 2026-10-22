import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { allDb, getDbInstance } from '../database/connection';
import { decrypt } from '../utils/crypto';
import { DATASETS, isExcludedSettingKey, resolveDatasetOrder } from './datasets';
import {
    EXPORT_ENTRY_MANIFEST,
    EXPORT_ENTRY_PAYLOAD,
    EXPORT_ENTRY_README,
    ExportDatasetInfo,
    ExportManifest,
    SecretMode,
    buildManifest,
    buildReadme,
    encryptPayload,
} from './format';

/** 加密列在包里的对应列名：encrypted_password -> plain_password */
export function toPlainColumn(column: string): string {
    return `plain_${column.replace(/^encrypted_/, '')}`;
}

/** 反向：plain_password -> encrypted_password */
export function toEncryptedColumn(column: string): string {
    return `encrypted_${column.replace(/^plain_/, '')}`;
}

export interface ExportPayload {
    datasets: Record<string, Record<string, Array<Record<string, any>>>>;
}

export interface ExportRequest {
    datasets: string[];
    secretMode: SecretMode;
    password: string;
}

export interface ExportResult {
    buffer: Buffer;
    filename: string;
    manifest: ExportManifest;
    /** stripped 模式下被强制剔除的数据集，前端要告诉用户 */
    droppedDatasets: string[];
}

let cachedVersion: string | null = null;

export function resolveAppVersion(): string {
    if (cachedVersion) return cachedVersion;
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            if (pkg && pkg.name === 'nexus-terminal' && typeof pkg.version === 'string') {
                cachedVersion = pkg.version;
                return cachedVersion!;
            }
        } catch {
            /* 继续往上找 */
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    cachedVersion = '0.0.0';
    return cachedVersion;
}

export class ExportDecryptError extends Error {
    readonly failures: Array<{ dataset: string; row: number; column: string }>;

    constructor(failures: Array<{ dataset: string; row: number; column: string }>) {
        super('CREDENTIAL_DECRYPT_FAILED');
        this.name = 'ExportDecryptError';
        this.failures = failures;
    }
}

function decryptOrThrow(
    value: string,
    datasetKey: string,
    rowIndex: number,
    column: string,
    failures: Array<{ dataset: string; row: number; column: string }>
): string | null {
    try {
        return decrypt(value);
    } catch {
        failures.push({ dataset: datasetKey, row: rowIndex, column });
        return null;
    }
}

/**
 * 读取选中的数据集并组装成可序列化的 payload。
 *
 * 加密列在这里被**解密成明文**（列名改成 plain_*），因为目标机的 ENCRYPTION_KEY
 * 和源机不同，直接搬密文过去等于搬一堆解不开的字节。
 */
export async function buildExportPayload(request: ExportRequest): Promise<{
    payload: ExportPayload;
    infos: ExportDatasetInfo[];
    droppedDatasets: string[];
}> {
    const db = await getDbInstance();
    const droppedDatasets: string[] = [];

    let wanted = resolveDatasetOrder(request.datasets).filter((key) => !!DATASETS[key]);
    if (wanted.length === 0) throw new Error('NO_DATASETS_SELECTED');

    // stripped 模式不含任何凭据，SSH 私钥整张表都不该带出去
    if (request.secretMode === 'stripped') {
        const before = wanted.length;
        wanted = wanted.filter((key) => key !== 'sshKeys');
        if (wanted.length !== before) droppedDatasets.push('sshKeys');
        if (wanted.length === 0) throw new Error('NO_DATASETS_SELECTED');
    }

    const payload: ExportPayload = { datasets: {} };
    const infos: ExportDatasetInfo[] = [];
    const decryptFailures: Array<{ dataset: string; row: number; column: string }> = [];

    for (const key of wanted) {
        const spec = DATASETS[key];
        const tables: Record<string, Array<Record<string, any>>> = {};
        let total = 0;

        for (const tableSpec of spec.tables) {
            let rows = await allDb<Record<string, any>>(db, `SELECT * FROM ${tableSpec.table}`);
            const drop = new Set(tableSpec.dropColumns || []);

            rows = rows
                .filter((row) => {
                    if (tableSpec.table === 'settings') return !isExcludedSettingKey(row.key);
                    return true;
                })
                .map((row, index) => {
                    const next: Record<string, any> = {};
                    for (const [column, value] of Object.entries(row)) {
                        if (drop.has(column)) continue;

                        if (tableSpec.encryptedColumns?.includes(column)) {
                            if (request.secretMode === 'stripped') {
                                next[toPlainColumn(column)] = null;
                            } else if (value === null || value === undefined || value === '') {
                                next[toPlainColumn(column)] = null;
                            } else {
                                next[toPlainColumn(column)] = decryptOrThrow(
                                    String(value),
                                    key,
                                    index,
                                    column,
                                    decryptFailures
                                );
                            }
                            continue;
                        }

                        next[column] = value;
                    }
                    return next;
                });

            tables[tableSpec.table] = rows;
            total += rows.length;
        }

        payload.datasets[key] = tables;
        infos.push({ key, count: total });
    }

    // 凭据解密失败说明 ENCRYPTION_KEY 和数据库里的密文对不上，
    // 这时候导出的包看起来是成功的、其实密码全是空的 —— 必须拦下来。
    if (decryptFailures.length > 0) {
        throw new ExportDecryptError(decryptFailures.slice(0, 20));
    }

    return { payload, infos, droppedDatasets };
}

function formatStamp(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
        date.getHours()
    )}${pad(date.getMinutes())}`;
}

export async function exportPackage(request: ExportRequest): Promise<ExportResult> {
    const { payload, infos, droppedDatasets } = await buildExportPayload(request);

    const plain = Buffer.from(JSON.stringify(payload), 'utf8');
    const encrypted = encryptPayload(plain, request.password);
    const now = new Date();

    const manifest = buildManifest({
        appVersion: resolveAppVersion(),
        exportedAt: now,
        secretMode: request.secretMode,
        payload: encrypted,
        datasets: infos,
    });

    const zip = new AdmZip();
    zip.addFile(EXPORT_ENTRY_MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    zip.addFile(EXPORT_ENTRY_PAYLOAD, encrypted.data);
    zip.addFile(EXPORT_ENTRY_README, Buffer.from(buildReadme(manifest), 'utf8'));

    return {
        buffer: zip.toBuffer(),
        filename: `nexus-export-${formatStamp(now)}.zip`,
        manifest,
        droppedDatasets,
    };
}
