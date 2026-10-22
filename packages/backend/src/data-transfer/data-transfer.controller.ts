import { Request, Response } from 'express';
import { AuditLogService } from '../audit/audit.service';
import { listDatasets } from './datasets';
import { ExportDecryptError, exportPackage } from './exporter.service';
import { analyzePackage, executeImport, ImportSessionError } from './importer.service';
import { BadPasswordError, InvalidPackageError, isPasswordAcceptable } from './format';

const auditLogService = new AuditLogService();

function userIdOf(req: Request): number | string {
    return (req as any).user?.id ?? 'unknown';
}

const MANIFEST_ERROR_TEXT: Record<string, string> = {
    notObject: '文件不是有效的导出包',
    wrongFormat: '这不是 Nexus Terminal 的导出包',
    tooNew: '导出包来自更新的版本，请先升级本程序',
    badVersion: '导出包版本信息损坏',
    missingPayload: '导出包内容缺失或已损坏',
    badCipher: '导出包加密信息损坏',
    badKdf: '导出包密钥派生参数损坏',
    missingDatasets: '导出包数据集清单损坏',
};

export const dataTransferController = {
    /** GET /api/v1/data-transfer/datasets */
    async listAvailableDatasets(_req: Request, res: Response): Promise<void> {
        res.json({ datasets: listDatasets() });
    },

    /** POST /api/v1/data-transfer/export */
    async exportData(req: Request, res: Response): Promise<void> {
        const { datasets, secretMode, password } = req.body || {};

        if (!Array.isArray(datasets) || datasets.length === 0) {
            res.status(400).json({ message: 'NO_DATASETS_SELECTED' });
            return;
        }
        if (!isPasswordAcceptable(password)) {
            res.status(400).json({ message: 'PASSWORD_TOO_SHORT' });
            return;
        }
        const mode = secretMode === 'stripped' ? 'stripped' : 'encrypted';

        try {
            const result = await exportPackage({
                datasets: datasets.filter((key: unknown) => typeof key === 'string'),
                secretMode: mode,
                password,
            });

            void auditLogService.logAction('DATA_EXPORTED', {
                userId: userIdOf(req),
                datasets: result.manifest.datasets.map((item) => item.key),
                secretMode: mode,
                bytes: result.buffer.length,
            });

            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
            res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Dropped-Datasets');
            res.setHeader('X-Dropped-Datasets', result.droppedDatasets.join(','));
            res.send(result.buffer);
        } catch (error: any) {
            if (error instanceof ExportDecryptError) {
                res.status(500).json({
                    message: 'CREDENTIAL_DECRYPT_FAILED',
                    detail: error.failures,
                });
                return;
            }
            if (error?.message === 'NO_DATASETS_SELECTED') {
                res.status(400).json({ message: 'NO_DATASETS_SELECTED' });
                return;
            }
            console.error('[数据导出] 失败:', error);
            res.status(500).json({ message: 'EXPORT_FAILED', error: error?.message });
        }
    },

    /** POST /api/v1/data-transfer/analyze  (multipart: file + password) */
    async analyzeImport(req: Request, res: Response): Promise<void> {
        const file = (req as any).file as { buffer: Buffer } | undefined;
        const password = (req.body || {}).password;

        if (!file || !file.buffer) {
            res.status(400).json({ message: 'FILE_REQUIRED' });
            return;
        }
        if (typeof password !== 'string' || password.length === 0) {
            res.status(400).json({ message: 'PASSWORD_REQUIRED' });
            return;
        }

        try {
            const result = await analyzePackage(file.buffer, password);
            res.json(result);
        } catch (error: any) {
            if (error instanceof BadPasswordError) {
                res.status(400).json({ message: 'PASSWORD_INCORRECT' });
                return;
            }
            if (error instanceof InvalidPackageError) {
                res.status(400).json({
                    message: MANIFEST_ERROR_TEXT[error.reason] || 'INVALID_PACKAGE',
                    reason: error.reason,
                    detail: error.message,
                });
                return;
            }
            console.error('[数据导入] 解析失败:', error);
            res.status(500).json({ message: 'ANALYZE_FAILED', error: error?.message });
        }
    },

    /** POST /api/v1/data-transfer/import */
    async runImport(req: Request, res: Response): Promise<void> {
        const { token, strategies } = req.body || {};
        if (typeof token !== 'string' || token.length === 0) {
            res.status(400).json({ message: 'TOKEN_REQUIRED' });
            return;
        }

        try {
            const report = await executeImport(
                token,
                strategies && typeof strategies === 'object' ? strategies : {}
            );

            void auditLogService.logAction('DATA_IMPORTED', {
                userId: userIdOf(req),
                totals: report.totals,
                datasets: report.datasets.map((item) => ({
                    key: item.key,
                    created: item.created,
                    updated: item.updated,
                    skipped: item.skipped,
                    invalid: item.invalid,
                })),
            });

            res.json(report);
        } catch (error: any) {
            if (error instanceof ImportSessionError) {
                res.status(409).json({ message: 'IMPORT_SESSION_EXPIRED', reason: error.reason });
                return;
            }
            console.error('[数据导入] 执行失败:', error);
            res.status(500).json({ message: 'IMPORT_FAILED', error: error?.message });
        }
    },
};
