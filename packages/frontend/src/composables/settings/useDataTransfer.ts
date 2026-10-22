import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { isAxiosError } from 'axios';
import apiClient from '../../utils/apiClient';

export type SecretMode = 'encrypted' | 'stripped';
export type ConflictStrategy = 'skip' | 'overwrite' | 'duplicate';

export interface DatasetDescriptor {
    key: string;
    defaultSelected: boolean;
    sensitive: boolean;
}

export interface DatasetPlan {
    key: string;
    incoming: number;
    create: number;
    conflict: number;
    invalid: number;
    errors: Array<{ index: number; message: string }>;
}

export interface AnalyzeResult {
    token: string;
    manifest: {
        format: string;
        schemaVersion: number;
        appVersion: string;
        exportedAt: string;
        secretMode: SecretMode;
        datasets: Array<{ key: string; count: number }>;
        payloadBytes: number;
    };
    plans: DatasetPlan[];
    totals: { incoming: number; create: number; conflict: number; invalid: number };
    unknownDatasets: string[];
}

export interface DatasetReport {
    key: string;
    incoming: number;
    created: number;
    updated: number;
    skipped: number;
    invalid: number;
    errors: Array<{ index: number; message: string }>;
}

export interface ImportReport {
    startedAt: string;
    finishedAt: string;
    datasets: DatasetReport[];
    totals: {
        incoming: number;
        created: number;
        updated: number;
        skipped: number;
        invalid: number;
    };
}

const KNOWN_ERROR_CODES = [
    'NO_DATASETS_SELECTED',
    'PASSWORD_TOO_SHORT',
    'CREDENTIAL_DECRYPT_FAILED',
    'FILE_REQUIRED',
    'PASSWORD_REQUIRED',
    'PASSWORD_INCORRECT',
    'IMPORT_SESSION_EXPIRED',
    'FILE_TOO_LARGE',
    'EXPORT_FAILED',
    'ANALYZE_FAILED',
    'IMPORT_FAILED',
] as const;

export function useDataTransfer() {
    const { t } = useI18n();

    const datasets = ref<DatasetDescriptor[]>([]);
    const selectedKeys = ref<Set<string>>(new Set());
    const secretMode = ref<SecretMode>('encrypted');
    const password = ref('');
    const passwordConfirm = ref('');
    const exporting = ref(false);
    const exportError = ref('');
    const exportNotice = ref('');

    const importFile = ref<File | null>(null);
    const importPassword = ref('');
    const analyzing = ref(false);
    const importing = ref(false);
    const analysis = ref<AnalyzeResult | null>(null);
    const strategies = ref<Record<string, ConflictStrategy>>({});
    const report = ref<ImportReport | null>(null);
    const importError = ref('');

    const selectedCount = computed(() => selectedKeys.value.size);
    const exportReady = computed(
        () =>
            selectedKeys.value.size > 0 &&
            password.value.length >= 8 &&
            password.value === passwordConfirm.value
    );

    function resolveBackendMessage(codeOrText: unknown, fallback: string): string {
        const text = typeof codeOrText === 'string' ? codeOrText : '';
        if (!text) return fallback;
        const known = KNOWN_ERROR_CODES.find((code) => text.includes(code));
        if (known) return t(`settings.dataTransfer.errors.${known}`);
        return text;
    }

    async function readErrorPayload(error: unknown, fallback: string): Promise<string> {
        if (isAxiosError(error) && error.response?.data) {
            const data = error.response.data;
            if (data instanceof Blob) {
                try {
                    const parsed = JSON.parse(await data.text());
                    return resolveBackendMessage(parsed?.message, fallback);
                } catch {
                    return fallback;
                }
            }
            if (typeof data === 'string') return resolveBackendMessage(data, fallback);
            if (data && typeof data === 'object' && 'message' in data) {
                return resolveBackendMessage((data as any).message, fallback);
            }
        }
        const message = (error as any)?.message;
        return typeof message === 'string' && message.length > 0 ? message : fallback;
    }

    async function loadDatasets(): Promise<void> {
        try {
            const { data } = await apiClient.get('/data-transfer/datasets');
            datasets.value = Array.isArray(data?.datasets) ? data.datasets : [];
            selectedKeys.value = new Set(
                datasets.value.filter((item) => item.defaultSelected).map((item) => item.key)
            );
        } catch (error) {
            console.error('加载数据集清单失败:', error);
        }
    }

    function toggleDataset(key: string): void {
        const next = new Set(selectedKeys.value);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        selectedKeys.value = next;
    }

    function selectAll(selected: boolean): void {
        selectedKeys.value = selected
            ? new Set(datasets.value.map((item) => item.key))
            : new Set();
    }

    function isSelected(key: string): boolean {
        return selectedKeys.value.has(key);
    }

    async function handleExport(): Promise<void> {
        exportError.value = '';
        exportNotice.value = '';
        if (selectedKeys.value.size === 0) {
            exportError.value = t('settings.dataTransfer.errors.NO_DATASETS_SELECTED');
            return;
        }
        if (password.value.length < 8) {
            exportError.value = t('settings.dataTransfer.errors.PASSWORD_TOO_SHORT');
            return;
        }
        if (password.value !== passwordConfirm.value) {
            exportError.value = t('settings.dataTransfer.errors.passwordMismatch');
            return;
        }

        exporting.value = true;
        try {
            const response = await apiClient.post(
                '/data-transfer/export',
                {
                    datasets: [...selectedKeys.value],
                    secretMode: secretMode.value,
                    password: password.value,
                },
                { responseType: 'blob', timeout: 300000 }
            );

            let filename = 'nexus-export.zip';
            const disposition = String(response.headers['content-disposition'] || '');
            const match = /filename="?([^";]+)"?/.exec(disposition);
            if (match?.[1]) filename = match[1];

            const blob = new Blob([response.data], { type: 'application/zip' });
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', filename);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(url);

            const dropped = String(response.headers['x-dropped-datasets'] || '')
                .split(',')
                .filter(Boolean);
            exportNotice.value = dropped.length
                ? t('settings.dataTransfer.exportDropped', { items: dropped.join(', ') })
                : t('settings.dataTransfer.exportSuccess');

            password.value = '';
            passwordConfirm.value = '';
        } catch (error) {
            console.error('导出失败:', error);
            exportError.value = await readErrorPayload(
                error,
                t('settings.dataTransfer.errors.EXPORT_FAILED')
            );
        } finally {
            exporting.value = false;
        }
    }

    function onFileChange(event: Event): void {
        const input = event.target as HTMLInputElement;
        importFile.value = input.files?.[0] ?? null;
        analysis.value = null;
        report.value = null;
        importError.value = '';
    }

    async function handleAnalyze(): Promise<void> {
        importError.value = '';
        report.value = null;
        if (!importFile.value) {
            importError.value = t('settings.dataTransfer.errors.FILE_REQUIRED');
            return;
        }
        if (!importPassword.value) {
            importError.value = t('settings.dataTransfer.errors.PASSWORD_REQUIRED');
            return;
        }

        analyzing.value = true;
        try {
            const form = new FormData();
            form.append('file', importFile.value);
            form.append('password', importPassword.value);
            const { data } = await apiClient.post('/data-transfer/analyze', form, {
                timeout: 300000,
            });
            analysis.value = data as AnalyzeResult;
            const next: Record<string, ConflictStrategy> = {};
            for (const plan of analysis.value.plans) next[plan.key] = 'skip';
            strategies.value = next;
        } catch (error) {
            console.error('解析导入包失败:', error);
            analysis.value = null;
            importError.value = await readErrorPayload(
                error,
                t('settings.dataTransfer.errors.ANALYZE_FAILED')
            );
        } finally {
            analyzing.value = false;
        }
    }

    async function handleImport(): Promise<void> {
        if (!analysis.value) return;
        importError.value = '';
        importing.value = true;
        try {
            const { data } = await apiClient.post(
                '/data-transfer/import',
                { token: analysis.value.token, strategies: strategies.value },
                { timeout: 600000 }
            );
            report.value = data as ImportReport;
            analysis.value = null;
            importFile.value = null;
            importPassword.value = '';
        } catch (error) {
            console.error('执行导入失败:', error);
            importError.value = await readErrorPayload(
                error,
                t('settings.dataTransfer.errors.IMPORT_FAILED')
            );
        } finally {
            importing.value = false;
        }
    }

    function resetImport(): void {
        analysis.value = null;
        report.value = null;
        importFile.value = null;
        importPassword.value = '';
        importError.value = '';
    }

    return {
        datasets,
        selectedKeys,
        selectedCount,
        secretMode,
        password,
        passwordConfirm,
        exporting,
        exportError,
        exportNotice,
        exportReady,
        importFile,
        importPassword,
        analyzing,
        importing,
        analysis,
        strategies,
        report,
        importError,
        loadDatasets,
        toggleDataset,
        selectAll,
        isSelected,
        handleExport,
        onFileChange,
        handleAnalyze,
        handleImport,
        resetImport,
    };
}
