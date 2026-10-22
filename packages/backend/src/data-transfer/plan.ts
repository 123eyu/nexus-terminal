/**
 * 冲突判定与预览聚合。纯函数，不碰数据库 —— 这样「预览说会新增 12 条」和
 * 「实际执行新增 12 条」走的是同一段逻辑，不会出现预览一套、执行另一套。
 */

export type ConflictStrategy = 'skip' | 'overwrite' | 'duplicate';

export const IDENTITY_SEPARATOR = '\u0001';

export function normalizeIdentityValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function buildIdentityKey(
    identityColumns: string[],
    row: Record<string, any>
): string {
    return identityColumns
        .map((column) => normalizeIdentityValue(row[column]))
        .join(IDENTITY_SEPARATOR);
}

/** 身份列全为空说明这条数据没有可判定的身份，直接算无效 */
export function isBlankIdentity(identityColumns: string[], row: Record<string, any>): boolean {
    return identityColumns.every(
        (column) => normalizeIdentityValue(row[column]).length === 0
    );
}

export interface RowClassification {
    index: number;
    key: string;
    exists: boolean;
}

export function classifyRows(
    rows: Record<string, any>[],
    identityColumns: string[],
    existingKeys: Set<string>
): RowClassification[] {
    return rows.map((row, index) => {
        const key = buildIdentityKey(identityColumns, row);
        return { index, key, exists: existingKeys.has(key) };
    });
}

export interface DatasetPlan {
    key: string;
    incoming: number;
    create: number;
    conflict: number;
    invalid: number;
    errors: Array<{ index: number; message: string }>;
}

export function aggregatePlan(
    key: string,
    rows: Record<string, any>[],
    identityColumns: string[],
    existingKeys: Set<string>,
    invalidErrors: Array<{ index: number; message: string }> = []
): DatasetPlan {
    const invalidIndexes = new Set(invalidErrors.map((item) => item.index));
    let create = 0;
    let conflict = 0;
    let invalid = invalidErrors.length;

    rows.forEach((row, index) => {
        if (invalidIndexes.has(index)) return;
        if (isBlankIdentity(identityColumns, row)) {
            invalid++;
            invalidErrors.push({ index, message: 'missingIdentity' });
            return;
        }
        const key = buildIdentityKey(identityColumns, row);
        if (existingKeys.has(key)) conflict++;
        else create++;
    });

    return {
        key,
        incoming: rows.length,
        create,
        conflict,
        invalid,
        errors: invalidErrors.slice(0, 50),
    };
}

export function totalPlan(plans: DatasetPlan[]): {
    incoming: number;
    create: number;
    conflict: number;
    invalid: number;
} {
    return plans.reduce(
        (acc, plan) => ({
            incoming: acc.incoming + plan.incoming,
            create: acc.create + plan.create,
            conflict: acc.conflict + plan.conflict,
            invalid: acc.invalid + plan.invalid,
        }),
        { incoming: 0, create: 0, conflict: 0, invalid: 0 }
    );
}

/**
 * duplicate 策略下生成不撞名的副本名。
 * `web-1` → `web-1 (2)` → `web-1 (3)`；空名回落到 `(2)`。
 */
export function buildDuplicateName(base: unknown, existing: Set<string>): string {
    const original = typeof base === 'string' ? base.trim() : base === null || base === undefined ? '' : String(base);
    for (let attempt = 2; attempt < 1000; attempt++) {
        const candidate = original.length > 0 ? `${original} (${attempt})` : `(${attempt})`;
        if (!existing.has(candidate)) return candidate;
    }
    return `${original} (${Date.now()})`;
}
