// packages/backend/src/sync/sync.v2.service.ts
import { getDbInstance, runDb, getDb, allDb, acquireApplyLock, applyContext } from '../database/connection';
import { envelopeCryptoService } from './envelope-crypto.service';
import { syncEventsManager } from './sync.events';
import http from 'http';
import https from 'https';
import { URL } from 'url';

export interface SyncV2ChangeItem {
  seq?: number;
  tbl: string;
  row_id: string; // UUID
  op: 'U' | 'D';
  hlc: string;
  data?: any;     // 当 op='U' 时携带白名单字段；当 op='D' 时为 null
}

export interface PushRequestPayload {
  device_id: string;
  changes: SyncV2ChangeItem[];
}

export interface PushResponseResult {
  accepted: Array<{ tbl: string; row_id: string; seq?: number }>;
  stale: Array<{ tbl: string; row_id: string; reason?: string }>;
  rejected: Array<{ tbl: string; row_id: string; reason: string }>;
  server_time: number;
}

export interface PullResponseResult {
  changes: SyncV2ChangeItem[];
  next_cursor: number;
  has_more: boolean;
  min_valid_cursor: number;
  server_time: number;
}

export interface SnapshotResponseResult {
  snapshot_cursor: number;
  page: number;
  page_size: number;
  total_count: number;
  has_more: boolean;
  entities: {
    tags: Array<{ uuid: string; name: string; updated_hlc: string }>;
    quick_command_tags: Array<{ uuid: string; name: string; updated_hlc: string }>;
    ssh_keys: Array<{ uuid: string; name: string; encrypted_private_key: string | null; encrypted_passphrase: string | null; updated_hlc: string }>;
    proxies: Array<{
      uuid: string;
      name: string;
      type: string;
      host: string;
      port: number;
      username?: string | null;
      auth_method?: string;
      encrypted_password?: string | null;
      encrypted_private_key?: string | null;
      encrypted_passphrase?: string | null;
      updated_hlc: string;
    }>;
    quick_commands: Array<{
      uuid: string;
      name?: string | null;
      command: string;
      variables?: string | null;
      tag_uuids: string[];
      updated_hlc: string;
    }>;
    connections: Array<{
      uuid: string;
      name?: string | null;
      type: string;
      host: string;
      port: number;
      username: string;
      auth_method: string;
      encrypted_password?: string | null;
      encrypted_private_key?: string | null;
      encrypted_passphrase?: string | null;
      proxy_uuid?: string | null;
      proxy_type?: string | null;
      ssh_key_uuid?: string | null;
      notes?: string | null;
      jump_chain?: any;
      background_color?: string | null;
      tag_uuids: string[];
      updated_hlc: string;
    }>;
    settings: Array<{
      uuid: string;
      key: string;
      value: string;
      updated_hlc: string;
    }>;
  };
  tombstones: Array<{ tbl: string; row_id: string; deleted_hlc: string; deleted_at: number }>;
  server_time: number;
}

export const syncV2Service = {
  /**
   * 待解析外键引用解析：当父记录到达后，回填挂起引用并清除登记
   */
  async resolvePendingReferences(targetTbl: string, targetUuid: string, targetPhysId: number): Promise<void> {
    const db = await getDbInstance();
    try {
      const pendings = await allDb<{ id: number; child_tbl: string; child_uuid: string; fk_field: string }>(
        db,
        `SELECT id, child_tbl, child_uuid, fk_field FROM sync_pending_references WHERE target_tbl = ? AND target_uuid = ?`,
        [targetTbl, targetUuid]
      );

      for (const p of pendings) {
        if (p.child_tbl === 'connections' && (p.fk_field === 'proxy_id' || p.fk_field === 'ssh_key_id')) {
          await runDb(db, `UPDATE connections SET ${p.fk_field} = ? WHERE uuid = ?`, [targetPhysId, p.child_uuid]);
        }
      }

      if (pendings.length > 0) {
        await runDb(db, `DELETE FROM sync_pending_references WHERE target_tbl = ? AND target_uuid = ?`, [targetTbl, targetUuid]);
        console.log(`[SyncV2] 成功为 ${targetTbl}:${targetUuid} 缝合了 ${pendings.length} 条待解析外键关联。`);
      }
    } catch (err: any) {
      console.warn(`[SyncV2] 外键引用缝合时发生告警:`, err.message);
    }
  },

  /**
   * 应用远端变更集 (核心幂等应用与单条 SAVEPOINT 隔离)
   */
  async applyRemoteChanges(
    changes: SyncV2ChangeItem[],
    originDeviceId: string,
    pairingSecret: string,
    isServerSide: boolean = false
  ): Promise<{ accepted: PushResponseResult['accepted']; stale: PushResponseResult['stale']; rejected: PushResponseResult['rejected'] }> {
    const db = await getDbInstance();
    const releaseLock = await acquireApplyLock();

    const accepted: PushResponseResult['accepted'] = [];
    const stale: PushResponseResult['stale'] = [];
    const rejected: PushResponseResult['rejected'] = [];

    const nowMs = Date.now();
    const fiveMinutesMs = 5 * 60 * 1000;

    try {
      await applyContext.run({ isApplying: true }, async () => {
        await runDb(db, 'BEGIN IMMEDIATE');
        await runDb(db, 'PRAGMA defer_foreign_keys = ON');
        await runDb(db, 'UPDATE sync_state SET applying = 1 WHERE id = 1');

        for (let i = 0; i < changes.length; i++) {
          const item = changes[i];
          const savepointName = `sp_sync_${i}`;
          await runDb(db, `SAVEPOINT ${savepointName}`);

          try {
            // 1. HLC 5 分钟上限检测与服务端自动时钟钳制
            let effectiveHlc = item.hlc;
            const hlcParts = effectiveHlc.split('-');
            const itemTimeMs = parseInt(hlcParts[0] || '0', 10);
            if (itemTimeMs > nowMs + fiveMinutesMs) {
              console.warn(`[SyncV2] 远端记录 ${item.tbl}:${item.row_id} HLC 超前超过 5 分钟 (${itemTimeMs} > ${nowMs})，执行时钟钳制！`);
              effectiveHlc = `${String(nowMs + 1).padStart(13, '0')}-00000-${originDeviceId}`;
            }

            // 2. 处理删除变更 (op === 'D')
            if (item.op === 'D') {
              const localTombstone = await getDb<{ deleted_hlc: string }>(
                db,
                `SELECT deleted_hlc FROM sync_tombstones WHERE tbl = ? AND row_id = ?`,
                [item.tbl, item.row_id]
              );

              // 检查本地存活记录
              const localLive = await getDb<{ updated_hlc: string }>(
                db,
                `SELECT updated_hlc FROM ${item.tbl} WHERE uuid = ?`,
                [item.row_id]
              );

              if (localLive && localLive.updated_hlc > effectiveHlc) {
                // 本地修改新于远端删除：保留本地
                stale.push({ tbl: item.tbl, row_id: item.row_id, reason: '本地修改版本更新于远端删除' });
              } else if (localTombstone && localTombstone.deleted_hlc >= effectiveHlc) {
                // 已有相同或更新的墓碑
                accepted.push({ tbl: item.tbl, row_id: item.row_id });
              } else {
                // 执行删除并写墓碑
                await runDb(db, `DELETE FROM ${item.tbl} WHERE uuid = ?`, [item.row_id]);
                await runDb(
                  db,
                  `INSERT OR REPLACE INTO sync_tombstones (tbl, row_id, deleted_hlc, deleted_at) VALUES (?, ?, ?, ?)`,
                  [item.tbl, item.row_id, effectiveHlc, nowMs]
                );

                // 若在 VPS 服务端，记入服务端 sync_changes 供其他设备拉取
                if (isServerSide) {
                  const insChange = await runDb(
                    db,
                    `INSERT INTO sync_changes (tbl, row_id, op, origin) VALUES (?, ?, 'D', ?)`,
                    [item.tbl, item.row_id, originDeviceId]
                  );
                  accepted.push({ tbl: item.tbl, row_id: item.row_id, seq: insChange.lastID });
                } else {
                  accepted.push({ tbl: item.tbl, row_id: item.row_id });
                }
              }
              await runDb(db, `RELEASE SAVEPOINT ${savepointName}`);
              continue;
            }

            // 3. 处理更新/插入变更 (op === 'U')
            // 3.1 检查墓碑与本地存活版本的 HLC
            const existingTombstone = await getDb<{ deleted_hlc: string }>(
              db,
              `SELECT deleted_hlc FROM sync_tombstones WHERE tbl = ? AND row_id = ?`,
              [item.tbl, item.row_id]
            );
            if (existingTombstone && existingTombstone.deleted_hlc >= effectiveHlc) {
              stale.push({ tbl: item.tbl, row_id: item.row_id, reason: '本地已存在更新的删除墓碑' });
              await runDb(db, `RELEASE SAVEPOINT ${savepointName}`);
              continue;
            }

            const existingLive = await getDb<{ id?: number; key?: string; updated_hlc: string }>(
              db,
              item.tbl === 'settings'
                ? `SELECT key, updated_hlc FROM settings WHERE uuid = ?`
                : `SELECT id, updated_hlc FROM ${item.tbl} WHERE uuid = ?`,
              [item.row_id]
            );
            if (existingLive && existingLive.updated_hlc >= effectiveHlc) {
              stale.push({ tbl: item.tbl, row_id: item.row_id, reason: '本地数据版本较新或一致' });
              await runDb(db, `RELEASE SAVEPOINT ${savepointName}`);
              continue;
            }

            // 3.2 准备写入数据并解封凭据字段
            const data = item.data || {};
            let targetPhysId = existingLive ? existingLive.id : null;

            if (item.tbl === 'settings') {
              const settingKey = data.key;
              if (settingKey === 'desktop_sync_config' || settingKey === 'syncApiKey' || (typeof settingKey === 'string' && settingKey.startsWith('desktop_'))) {
                continue; // 保护本地私有配置
              }
              const settingValue = typeof data.value === 'string' ? data.value : String(data.value || '');
              const nowSec = Math.floor(nowMs / 1000);
              if (existingLive) {
                await runDb(
                  db,
                  `UPDATE settings SET value = ?, updated_hlc = ?, updated_at = ? WHERE uuid = ?`,
                  [settingValue, effectiveHlc, nowSec, item.row_id]
                );
              } else {
                // 若 uuid 未命中，检查 key 是否存在
                const existingByKey = await getDb<{ key: string }>(db, `SELECT key FROM settings WHERE key = ?`, [settingKey]);
                if (existingByKey) {
                  await runDb(
                    db,
                    `UPDATE settings SET value = ?, uuid = ?, updated_hlc = ?, updated_at = ? WHERE key = ?`,
                    [settingValue, item.row_id, effectiveHlc, nowSec, settingKey]
                  );
                } else {
                  await runDb(
                    db,
                    `INSERT INTO settings (key, value, created_at, updated_at, uuid, updated_hlc) VALUES (?, ?, ?, ?, ?, ?)`,
                    [settingKey, settingValue, nowSec, nowSec, item.row_id, effectiveHlc]
                  );
                }
              }
            } else if (item.tbl === 'tags' || item.tbl === 'quick_command_tags') {
              if (existingLive) {
                await runDb(db, `UPDATE ${item.tbl} SET name = ?, updated_hlc = ? WHERE uuid = ?`, [
                  data.name,
                  effectiveHlc,
                  item.row_id
                ]);
              } else {
                const ins = await runDb(
                  db,
                  `INSERT INTO ${item.tbl} (uuid, name, updated_hlc) VALUES (?, ?, ?)`,
                  [item.row_id, data.name, effectiveHlc]
                );
                targetPhysId = ins.lastID;
              }
            } else if (item.tbl === 'ssh_keys') {
              const encKey = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_private_key, pairingSecret);
              const encPass = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_passphrase, pairingSecret);
              if (existingLive) {
                await runDb(
                  db,
                  `UPDATE ssh_keys SET name = ?, encrypted_private_key = ?, encrypted_passphrase = ?, updated_hlc = ? WHERE uuid = ?`,
                  [data.name, encKey, encPass, effectiveHlc, item.row_id]
                );
              } else {
                const ins = await runDb(
                  db,
                  `INSERT INTO ssh_keys (uuid, name, encrypted_private_key, encrypted_passphrase, updated_hlc) VALUES (?, ?, ?, ?, ?)`,
                  [item.row_id, data.name, encKey, encPass, effectiveHlc]
                );
                targetPhysId = ins.lastID;
              }
              if (targetPhysId) {
                await this.resolvePendingReferences('ssh_keys', item.row_id, targetPhysId);
              }
            } else if (item.tbl === 'proxies') {
              const encPwd = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_password, pairingSecret);
              const encKey = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_private_key, pairingSecret);
              const encPass = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_passphrase, pairingSecret);
              if (existingLive) {
                await runDb(
                  db,
                  `UPDATE proxies SET name = ?, type = ?, host = ?, port = ?, username = ?, auth_method = ?,
                                      encrypted_password = ?, encrypted_private_key = ?, encrypted_passphrase = ?, updated_hlc = ?
                   WHERE uuid = ?`,
                  [data.name, data.type, data.host, data.port, data.username || null, data.auth_method || 'none', encPwd, encKey, encPass, effectiveHlc, item.row_id]
                );
              } else {
                const ins = await runDb(
                  db,
                  `INSERT INTO proxies (uuid, name, type, host, port, username, auth_method, encrypted_password, encrypted_private_key, encrypted_passphrase, updated_hlc)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [item.row_id, data.name, data.type, data.host, data.port, data.username || null, data.auth_method || 'none', encPwd, encKey, encPass, effectiveHlc]
                );
                targetPhysId = ins.lastID;
              }
              if (targetPhysId) {
                await this.resolvePendingReferences('proxies', item.row_id, targetPhysId);
              }
            } else if (item.tbl === 'quick_commands') {
              if (existingLive) {
                await runDb(
                  db,
                  `UPDATE quick_commands SET name = ?, command = ?, variables = ?, updated_hlc = ? WHERE uuid = ?`,
                  [data.name || null, data.command, data.variables || null, effectiveHlc, item.row_id]
                );
              } else {
                const ins = await runDb(
                  db,
                  `INSERT INTO quick_commands (uuid, name, command, usage_count, variables, updated_hlc)
                   VALUES (?, ?, ?, ?, ?, ?)`,
                  [item.row_id, data.name || null, data.command, data.usage_count || 0, data.variables || null, effectiveHlc]
                );
                targetPhysId = ins.lastID;
              }

              // 对齐 quick_command_tag_associations 关联
              if (targetPhysId && Array.isArray(data.tag_uuids)) {
                await runDb(db, `DELETE FROM quick_command_tag_associations WHERE quick_command_id = ?`, [targetPhysId]);
                for (const tUuid of data.tag_uuids) {
                  const tRow = await getDb<{ id: number }>(db, `SELECT id FROM quick_command_tags WHERE uuid = ?`, [tUuid]);
                  if (tRow) {
                    await runDb(db, `INSERT OR IGNORE INTO quick_command_tag_associations (quick_command_id, tag_id) VALUES (?, ?)`, [targetPhysId, tRow.id]);
                  }
                }
              }
            } else if (item.tbl === 'connections') {
              const encPwd = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_password, pairingSecret);
              const encKey = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_private_key, pairingSecret);
              const encPass = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_passphrase, pairingSecret);

              // 解析 proxy_uuid 物理外键
              let resolvedProxyId: number | null = null;
              if (data.proxy_uuid) {
                const p = await getDb<{ id: number }>(db, `SELECT id FROM proxies WHERE uuid = ?`, [data.proxy_uuid]);
                if (p) {
                  resolvedProxyId = p.id;
                } else {
                  // 父记录未到达，记入待解析挂起表
                  await runDb(
                    db,
                    `INSERT INTO sync_pending_references (child_tbl, child_uuid, fk_field, target_tbl, target_uuid) VALUES ('connections', ?, 'proxy_id', 'proxies', ?)`,
                    [item.row_id, data.proxy_uuid]
                  );
                }
              }

              // 解析 ssh_key_uuid 物理外键
              let resolvedSshKeyId: number | null = null;
              if (data.ssh_key_uuid) {
                const k = await getDb<{ id: number }>(db, `SELECT id FROM ssh_keys WHERE uuid = ?`, [data.ssh_key_uuid]);
                if (k) {
                  resolvedSshKeyId = k.id;
                } else {
                  await runDb(
                    db,
                    `INSERT INTO sync_pending_references (child_tbl, child_uuid, fk_field, target_tbl, target_uuid) VALUES ('connections', ?, 'ssh_key_id', 'ssh_keys', ?)`,
                    [item.row_id, data.ssh_key_uuid]
                  );
                }
              }

              if (existingLive) {
                await runDb(
                  db,
                  `UPDATE connections SET name = ?, type = ?, host = ?, port = ?, username = ?, auth_method = ?,
                                         encrypted_password = ?, encrypted_private_key = ?, encrypted_passphrase = ?,
                                         proxy_id = ?, proxy_type = ?, ssh_key_id = ?, notes = ?, jump_chain = ?,
                                         background_color = ?, updated_hlc = ?
                   WHERE uuid = ?`,
                  [
                    data.name || null,
                    data.type || 'SSH',
                    data.host,
                    data.port,
                    data.username,
                    data.auth_method,
                    encPwd,
                    encKey,
                    encPass,
                    resolvedProxyId,
                    data.proxy_type || null,
                    resolvedSshKeyId,
                    data.notes || null,
                    data.jump_chain ? JSON.stringify(data.jump_chain) : null,
                    data.background_color || null,
                    effectiveHlc,
                    item.row_id
                  ]
                );
                targetPhysId = existingLive.id;
              } else {
                const ins = await runDb(
                  db,
                  `INSERT INTO connections (uuid, name, type, host, port, username, auth_method,
                                           encrypted_password, encrypted_private_key, encrypted_passphrase,
                                           proxy_id, proxy_type, ssh_key_id, notes, jump_chain, background_color,
                                           updated_hlc)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    item.row_id,
                    data.name || null,
                    data.type || 'SSH',
                    data.host,
                    data.port,
                    data.username,
                    data.auth_method,
                    encPwd,
                    encKey,
                    encPass,
                    resolvedProxyId,
                    data.proxy_type || null,
                    resolvedSshKeyId,
                    data.notes || null,
                    data.jump_chain ? JSON.stringify(data.jump_chain) : null,
                    data.background_color || null,
                    effectiveHlc
                  ]
                );
                targetPhysId = ins.lastID;
              }

              // 对齐 connection_tags 折叠关联
              if (targetPhysId && Array.isArray(data.tag_uuids)) {
                await runDb(db, `DELETE FROM connection_tags WHERE connection_id = ?`, [targetPhysId]);
                for (const tUuid of data.tag_uuids) {
                  const tRow = await getDb<{ id: number }>(db, `SELECT id FROM tags WHERE uuid = ?`, [tUuid]);
                  if (tRow) {
                    await runDb(db, `INSERT OR IGNORE INTO connection_tags (connection_id, tag_id) VALUES (?, ?)`, [targetPhysId, tRow.id]);
                  }
                }
              }
            }

            // 清理墓碑
            await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = ? AND row_id = ?`, [item.tbl, item.row_id]);

            // 若在 VPS 服务端，向服务端 sync_changes 记一行，origin 填发送端 ID
            if (isServerSide) {
              const insChange = await runDb(
                db,
                `INSERT INTO sync_changes (tbl, row_id, op, origin) VALUES (?, ?, 'U', ?)`,
                [item.tbl, item.row_id, originDeviceId]
              );
              accepted.push({ tbl: item.tbl, row_id: item.row_id, seq: insChange.lastID });
            } else {
              accepted.push({ tbl: item.tbl, row_id: item.row_id });
            }

            await runDb(db, `RELEASE SAVEPOINT ${savepointName}`);
          } catch (itemErr: any) {
            console.error(`[SyncV2] 应用单条记录 ${item.tbl}:${item.row_id} 失败，回滚该条保存点:`, itemErr.message);
            await runDb(db, `ROLLBACK TO SAVEPOINT ${savepointName}`);
            rejected.push({ tbl: item.tbl, row_id: item.row_id, reason: itemErr.message });
          }
        }

        // 4. 推进本机 HLC 状态
        await runDb(
          db,
          `UPDATE sync_state SET
            hlc_ms = MAX(hlc_ms, ${nowMs}),
            applying = 0
           WHERE id = 1`
        );

        await runDb(db, 'COMMIT');
      });
    } catch (txErr: any) {
      console.error('[SyncV2] 应用远端事务严重异常，整体回滚:', txErr.message);
      await runDb(db, 'UPDATE sync_state SET applying = 0 WHERE id = 1');
      await runDb(db, 'ROLLBACK');
      throw txErr;
    } finally {
      releaseLock();
    }

    return { accepted, stale, rejected };
  },

  /**
   * 服务端处理桌面端的 PUSH 请求
   */
  async handlePush(payload: PushRequestPayload, pairingSecret: string): Promise<PushResponseResult> {
    const { device_id, changes } = payload;
    const serverTime = Math.floor(Date.now() / 1000);

    const { accepted, stale, rejected } = await this.applyRemoteChanges(changes, device_id, pairingSecret, true);

    // 统计本次变更入库产生的最大 seq 并通过 SSE 广播通知其他在线客户端
    let maxSeq = 0;
    for (const a of accepted) {
      if (a.seq && a.seq > maxSeq) {
        maxSeq = a.seq;
      }
    }
    if (maxSeq > 0) {
      syncEventsManager.broadcastChange(maxSeq, device_id);
    }

    return {
      accepted,
      stale,
      rejected,
      server_time: serverTime
    };
  },

  /**
   * 服务端处理桌面端的 PULL 请求 (基于单调递增 seq 游标)
   */
  async handlePull(deviceId: string, cursor: number, limit: number = 200, pairingSecret: string): Promise<PullResponseResult> {
    const db = await getDbInstance();
    const serverTime = Math.floor(Date.now() / 1000);

    // 检查游标有效性 (410 判定)
    const stateRow = await getDb<{ min_valid_cursor: number }>(db, `SELECT min_valid_cursor FROM sync_state WHERE id = 1`);
    const minValid = stateRow?.min_valid_cursor || 0;
    if (cursor > 0 && cursor < minValid) {
      const err: any = new Error('游标已过期 (410 Gone)，请执行快照重建');
      err.statusCode = 410;
      throw err;
    }

    // 查询 seq > cursor 且 origin 不是请求设备的变更日志
    const changesRows = await allDb<{ seq: number; tbl: string; row_id: string; op: 'U' | 'D' }>(
      db,
      `SELECT seq, tbl, row_id, op FROM sync_changes
       WHERE seq > ? AND (origin IS NULL OR origin != ?)
       ORDER BY seq ASC LIMIT ?`,
      [cursor, deviceId, limit + 1]
    );

    const hasMore = changesRows.length > limit;
    const itemsToProcess = hasMore ? changesRows.slice(0, limit) : changesRows;

    let nextCursor = cursor;
    const resultChanges: SyncV2ChangeItem[] = [];

    // 去重并提取记录当前完整状态
    for (const row of itemsToProcess) {
      nextCursor = Math.max(nextCursor, row.seq);

      if (row.op === 'D') {
        const tomb = await getDb<{ deleted_hlc: string }>(
          db,
          `SELECT deleted_hlc FROM sync_tombstones WHERE tbl = ? AND row_id = ?`,
          [row.tbl, row.row_id]
        );
        resultChanges.push({
          seq: row.seq,
          tbl: row.tbl,
          row_id: row.row_id,
          op: 'D',
          hlc: tomb?.deleted_hlc || `${Date.now()}-00000-server`
        });
      } else {
        // op === 'U'
        if (row.tbl === 'connections') {
          const c = await getDb<any>(
            db,
            `SELECT c.*, p.uuid as proxy_uuid, sk.uuid as ssh_key_uuid
             FROM connections c
             LEFT JOIN proxies p ON c.proxy_id = p.id
             LEFT JOIN ssh_keys sk ON c.ssh_key_id = sk.id
             WHERE c.uuid = ?`,
            [row.row_id]
          );
          if (c) {
            const tagRows = await allDb<{ uuid: string }>(
              db,
              `SELECT t.uuid FROM connection_tags ct JOIN tags t ON ct.tag_id = t.id WHERE ct.connection_id = ?`,
              [c.id]
            );
            const tagUuids = tagRows.map(t => t.uuid).filter(Boolean);

            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: c.updated_hlc || `${Date.now()}-00000-server`,
              data: {
                name: c.name,
                type: c.type,
                host: c.host,
                port: c.port,
                username: c.username,
                auth_method: c.auth_method,
                encrypted_password: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_password, pairingSecret),
                encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_private_key, pairingSecret),
                encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_passphrase, pairingSecret),
                proxy_uuid: c.proxy_uuid || null,
                proxy_type: c.proxy_type || null,
                ssh_key_uuid: c.ssh_key_uuid || null,
                notes: c.notes || null,
                jump_chain: c.jump_chain ? JSON.parse(c.jump_chain) : null,
                background_color: c.background_color || null,
                tag_uuids: tagUuids
              }
            });
          }
        } else if (row.tbl === 'proxies') {
          const p = await getDb<any>(db, `SELECT * FROM proxies WHERE uuid = ?`, [row.row_id]);
          if (p) {
            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: p.updated_hlc,
              data: {
                name: p.name,
                type: p.type,
                host: p.host,
                port: p.port,
                username: p.username,
                auth_method: p.auth_method,
                encrypted_password: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_password, pairingSecret),
                encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_private_key, pairingSecret),
                encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_passphrase, pairingSecret)
              }
            });
          }
        } else if (row.tbl === 'ssh_keys') {
          const k = await getDb<any>(db, `SELECT * FROM ssh_keys WHERE uuid = ?`, [row.row_id]);
          if (k) {
            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: k.updated_hlc,
              data: {
                name: k.name,
                encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(k.encrypted_private_key, pairingSecret),
                encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(k.encrypted_passphrase, pairingSecret)
              }
            });
          }
        } else if (row.tbl === 'tags' || row.tbl === 'quick_command_tags') {
          const t = await getDb<any>(db, `SELECT * FROM ${row.tbl} WHERE uuid = ?`, [row.row_id]);
          if (t) {
            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: t.updated_hlc,
              data: { name: t.name }
            });
          }
        } else if (row.tbl === 'quick_commands') {
          const q = await getDb<any>(db, `SELECT * FROM quick_commands WHERE uuid = ?`, [row.row_id]);
          if (q) {
            const tagRows = await allDb<{ uuid: string }>(
              db,
              `SELECT qt.uuid FROM quick_command_tag_associations qa JOIN quick_command_tags qt ON qa.tag_id = qt.id WHERE qa.quick_command_id = ?`,
              [q.id]
            );
            const tagUuids = tagRows.map(t => t.uuid).filter(Boolean);

            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: q.updated_hlc,
              data: {
                name: q.name,
                command: q.command,
                variables: q.variables,
                tag_uuids: tagUuids
              }
            });
          }
        } else if (row.tbl === 'settings') {
          const s = await getDb<any>(db, `SELECT * FROM settings WHERE uuid = ?`, [row.row_id]);
          if (s && s.key !== 'desktop_sync_config' && s.key !== 'syncApiKey' && !String(s.key || '').startsWith('desktop_')) {
            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: s.updated_hlc || `${Date.now()}-00000-server`,
              data: {
                key: s.key,
                value: s.value
              }
            });
          }
        }
      }
    }

    return {
      changes: resultChanges,
      next_cursor: nextCursor,
      has_more: hasMore,
      min_valid_cursor: minValid,
      server_time: serverTime
    };
  },

  /**
   * 桌面端提取本地未确认的变更 (seq > push_cursor) 并打包
   */
  async extractLocalChangesToPush(pairingSecret: string): Promise<{ changes: SyncV2ChangeItem[]; maxSeq: number }> {
    const db = await getDbInstance();
    const state = await getDb<{ push_cursor: number }>(db, `SELECT push_cursor FROM sync_state WHERE id = 1`);
    const pushCursor = state?.push_cursor || 0;

    const rows = await allDb<{ seq: number; tbl: string; row_id: string; op: 'U' | 'D' }>(
      db,
      `SELECT seq, tbl, row_id, op FROM sync_changes
       WHERE seq > ? AND origin IS NULL
       ORDER BY seq ASC LIMIT 200`,
      [pushCursor]
    );

    let maxSeq = pushCursor;
    const list: SyncV2ChangeItem[] = [];

    for (const r of rows) {
      maxSeq = Math.max(maxSeq, r.seq);
      if (r.op === 'D') {
        const tomb = await getDb<{ deleted_hlc: string }>(
          db,
          `SELECT deleted_hlc FROM sync_tombstones WHERE tbl = ? AND row_id = ?`,
          [r.tbl, r.row_id]
        );
        list.push({
          seq: r.seq,
          tbl: r.tbl,
          row_id: r.row_id,
          op: 'D',
          hlc: tomb?.deleted_hlc || `${Date.now()}-00000-local`
        });
      } else {
        // op === 'U'
        if (r.tbl === 'connections') {
          const c = await getDb<any>(
            db,
            `SELECT c.*, p.uuid as proxy_uuid, sk.uuid as ssh_key_uuid
             FROM connections c
             LEFT JOIN proxies p ON c.proxy_id = p.id
             LEFT JOIN ssh_keys sk ON c.ssh_key_id = sk.id
             WHERE c.uuid = ?`,
            [r.row_id]
          );
          if (c) {
            const tagRows = await allDb<{ uuid: string }>(
              db,
              `SELECT t.uuid FROM connection_tags ct JOIN tags t ON ct.tag_id = t.id WHERE ct.connection_id = ?`,
              [c.id]
            );
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: c.updated_hlc,
              data: {
                name: c.name,
                type: c.type,
                host: c.host,
                port: c.port,
                username: c.username,
                auth_method: c.auth_method,
                encrypted_password: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_password, pairingSecret),
                encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_private_key, pairingSecret),
                encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_passphrase, pairingSecret),
                proxy_uuid: c.proxy_uuid || null,
                proxy_type: c.proxy_type || null,
                ssh_key_uuid: c.ssh_key_uuid || null,
                notes: c.notes || null,
                jump_chain: c.jump_chain ? JSON.parse(c.jump_chain) : null,
                background_color: c.background_color || null,
                tag_uuids: tagRows.map(t => t.uuid).filter(Boolean)
              }
            });
          }
        } else if (r.tbl === 'proxies') {
          const p = await getDb<any>(db, `SELECT * FROM proxies WHERE uuid = ?`, [r.row_id]);
          if (p) {
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: p.updated_hlc,
              data: {
                name: p.name,
                type: p.type,
                host: p.host,
                port: p.port,
                username: p.username,
                auth_method: p.auth_method,
                encrypted_password: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_password, pairingSecret),
                encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_private_key, pairingSecret),
                encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_passphrase, pairingSecret)
              }
            });
          }
        } else if (r.tbl === 'ssh_keys') {
          const k = await getDb<any>(db, `SELECT * FROM ssh_keys WHERE uuid = ?`, [r.row_id]);
          if (k) {
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: k.updated_hlc,
              data: {
                name: k.name,
                encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(k.encrypted_private_key, pairingSecret),
                encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(k.encrypted_passphrase, pairingSecret)
              }
            });
          }
        } else if (r.tbl === 'tags' || r.tbl === 'quick_command_tags') {
          const t = await getDb<any>(db, `SELECT * FROM ${r.tbl} WHERE uuid = ?`, [r.row_id]);
          if (t) {
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: t.updated_hlc,
              data: { name: t.name }
            });
          }
        } else if (r.tbl === 'quick_commands') {
          const q = await getDb<any>(db, `SELECT * FROM quick_commands WHERE uuid = ?`, [r.row_id]);
          if (q) {
            const tagRows = await allDb<{ uuid: string }>(
              db,
              `SELECT qt.uuid FROM quick_command_tag_associations qa JOIN quick_command_tags qt ON qa.tag_id = qt.id WHERE qa.quick_command_id = ?`,
              [q.id]
            );
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: q.updated_hlc,
              data: {
                name: q.name,
                command: q.command,
                variables: q.variables,
                tag_uuids: tagRows.map(t => t.uuid).filter(Boolean)
              }
            });
          }
        } else if (r.tbl === 'settings') {
          const s = await getDb<any>(db, `SELECT * FROM settings WHERE uuid = ?`, [r.row_id]);
          if (s) {
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: s.updated_hlc || `${Date.now()}-00000-local`,
              data: {
                key: s.key,
                value: s.value
              }
            });
          }
        }
      }
    }

    return { changes: list, maxSeq };
  },

  /**
   * 桌面端执行一轮完整的 PUSH + PULL 双向增量同步
   */
  async executeSyncCycle(
    vpsUrl: string,
    deviceToken: string,
    pairingSecret: string
  ): Promise<{ pushed: number; pulled: number; conflicts: number }> {
    const db = await getDbInstance();
    const state = await getDb<{ device_id: string; pull_cursor: number }>(db, `SELECT device_id, pull_cursor FROM sync_state WHERE id = 1`);
    const deviceId = state?.device_id || 'desktop-client';
    let pullCursor = state?.pull_cursor || 0;

    const cleanUrl = vpsUrl.replace(/\/+$/, '');
    let totalPushed = 0;
    let totalPulled = 0;

    // --- 步骤 1: PUSH 本地变更 ---
    const { changes: localChanges, maxSeq } = await this.extractLocalChangesToPush(pairingSecret);
    if (localChanges.length > 0) {
      console.log(`[SyncV2:Client] 正在推送 ${localChanges.length} 条本地变更至云端...`);
      const pushRes = await this.sendHttpJson(`${cleanUrl}/api/sync/v2/push`, {
        method: 'POST',
        headers: { 'x-device-token': deviceToken },
        body: { device_id: deviceId, changes: localChanges }
      });

      if (pushRes && pushRes.success && pushRes.data) {
        const data: PushResponseResult = pushRes.data;
        totalPushed += data.accepted.length;
        // 推进 push_cursor
        await runDb(db, `UPDATE sync_state SET push_cursor = ? WHERE id = 1`, [maxSeq]);
      }
    }

    // --- 步骤 2: PULL 云端变更并循环排空 ---
    let hasMore = true;
    while (hasMore) {
      const pullRes = await this.sendHttpJson(`${cleanUrl}/api/sync/v2/pull?device_id=${deviceId}&cursor=${pullCursor}&limit=200`, {
        method: 'GET',
        headers: { 'x-device-token': deviceToken }
      });

      if (!pullRes || !pullRes.success || !pullRes.data) {
        break;
      }

      const pullData: PullResponseResult = pullRes.data;
      if (pullData.changes.length > 0) {
        console.log(`[SyncV2:Client] 收到云端 ${pullData.changes.length} 条变更，正在应用...`);
        const applyRes = await this.applyRemoteChanges(pullData.changes, 'vps-server', pairingSecret, false);
        totalPulled += applyRes.accepted.length;
      }

      pullCursor = pullData.next_cursor;
      hasMore = pullData.has_more;

      // 推进 pull_cursor
      await runDb(db, `UPDATE sync_state SET pull_cursor = ? WHERE id = 1`, [pullCursor]);
    }

    return { pushed: totalPushed, pulled: totalPulled, conflicts: 0 };
  },

  /**
   * HTTP 客户端辅助请求
   */
  async sendHttpJson(urlStr: string, options: { method: string; headers?: Record<string, string>; body?: any }): Promise<any> {
    const parsedUrl = new URL(urlStr);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;
    const postData = options.body ? JSON.stringify(options.body) : '';

    const reqOptions: http.RequestOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: options.method,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...options.headers
      }
    };

    return new Promise((resolve, reject) => {
      const req = client.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(parsed.message || parsed.error || `HTTP ${res.statusCode}: ${data}`));
            }
          } catch {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, data });
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求超时'));
      });

      if (postData) req.write(postData);
      req.end();
    });
  },

  /**
   * 服务端快照接口：用于客户端初次同步或 410 游标过期后的全量状态重建
   */
  async getSnapshot(page: number = 1, pageSize: number = 200, pairingSecret: string): Promise<SnapshotResponseResult> {
    const db = await getDbInstance();
    const serverTime = Math.floor(Date.now() / 1000);

    // 1. 获取当前系统最新 seq 作为快照游标
    const maxSeqRow = await getDb<{ maxSeq: number }>(db, `SELECT COALESCE(MAX(seq), 0) as maxSeq FROM sync_changes`);
    const snapshotCursor = maxSeqRow?.maxSeq || 0;

    // 2. 提取有效墓碑列表 (仅第 1 页携带)
    let tombstones: Array<{ tbl: string; row_id: string; deleted_hlc: string; deleted_at: number }> = [];
    if (page === 1) {
      tombstones = await allDb<{ tbl: string; row_id: string; deleted_hlc: string; deleted_at: number }>(
        db,
        `SELECT tbl, row_id, deleted_hlc, deleted_at FROM sync_tombstones ORDER BY deleted_at DESC`
      );
    }

    // 3. 提取 tags 标签 (确定性 UUID)
    const tags = await allDb<{ uuid: string; name: string; updated_hlc: string }>(
      db,
      `SELECT uuid, name, updated_hlc FROM tags ORDER BY id ASC`
    );

    // 4. 提取 quick_command_tags
    const quickCommandTags = await allDb<{ uuid: string; name: string; updated_hlc: string }>(
      db,
      `SELECT uuid, name, updated_hlc FROM quick_command_tags ORDER BY id ASC`
    );

    // 5. 提取 ssh_keys (信封加密)
    const rawSshKeys = await allDb<any>(db, `SELECT * FROM ssh_keys ORDER BY id ASC`);
    const sshKeys = rawSshKeys.map(k => ({
      uuid: k.uuid,
      name: k.name,
      encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(k.encrypted_private_key, pairingSecret),
      encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(k.encrypted_passphrase, pairingSecret),
      updated_hlc: k.updated_hlc
    }));

    // 6. 提取 proxies (信封加密)
    const rawProxies = await allDb<any>(db, `SELECT * FROM proxies ORDER BY id ASC`);
    const proxies = rawProxies.map(p => ({
      uuid: p.uuid,
      name: p.name,
      type: p.type,
      host: p.host,
      port: p.port,
      username: p.username || null,
      auth_method: p.auth_method || 'none',
      encrypted_password: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_password, pairingSecret),
      encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_private_key, pairingSecret),
      encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_passphrase, pairingSecret),
      updated_hlc: p.updated_hlc
    }));

    // 7. 提取 quick_commands (折叠标签)
    const rawQuickCommands = await allDb<any>(db, `SELECT * FROM quick_commands ORDER BY id ASC`);
    const quickCommands = [];
    for (const q of rawQuickCommands) {
      const tagRows = await allDb<{ uuid: string }>(
        db,
        `SELECT qt.uuid FROM quick_command_tag_associations qa JOIN quick_command_tags qt ON qa.tag_id = qt.id WHERE qa.quick_command_id = ?`,
        [q.id]
      );
      quickCommands.push({
        uuid: q.uuid,
        name: q.name || null,
        command: q.command,
        variables: q.variables || null,
        tag_uuids: tagRows.map(t => t.uuid).filter(Boolean),
        updated_hlc: q.updated_hlc
      });
    }

    // 8. 提取 connections (折叠标签、解析外键 UUID、信封加密)
    const rawConnections = await allDb<any>(
      db,
      `SELECT c.*, p.uuid as proxy_uuid, sk.uuid as ssh_key_uuid
       FROM connections c
       LEFT JOIN proxies p ON c.proxy_id = p.id
       LEFT JOIN ssh_keys sk ON c.ssh_key_id = sk.id
       ORDER BY c.id ASC`
    );
    const connections = [];
    for (const c of rawConnections) {
      const tagRows = await allDb<{ uuid: string }>(
        db,
        `SELECT t.uuid FROM connection_tags ct JOIN tags t ON ct.tag_id = t.id WHERE ct.connection_id = ?`,
        [c.id]
      );
      connections.push({
        uuid: c.uuid,
        name: c.name || null,
        type: c.type || 'SSH',
        host: c.host,
        port: c.port,
        username: c.username,
        auth_method: c.auth_method,
        encrypted_password: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_password, pairingSecret),
        encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_private_key, pairingSecret),
        encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_passphrase, pairingSecret),
        proxy_uuid: c.proxy_uuid || null,
        proxy_type: c.proxy_type || null,
        ssh_key_uuid: c.ssh_key_uuid || null,
        notes: c.notes || null,
        jump_chain: c.jump_chain ? JSON.parse(c.jump_chain) : null,
        background_color: c.background_color || null,
        tag_uuids: tagRows.map(t => t.uuid).filter(Boolean),
        updated_hlc: c.updated_hlc
      });
    }

    // 9. 提取 settings (严格排除本地私有配置)
    const rawSettings = await allDb<any>(
      db,
      `SELECT * FROM settings 
       WHERE key NOT IN ('desktop_sync_config', 'syncApiKey') 
         AND key NOT LIKE 'desktop_%' 
       ORDER BY key ASC`
    );
    const settings = rawSettings.map(s => ({
      uuid: s.uuid,
      key: s.key,
      value: s.value,
      updated_hlc: s.updated_hlc || `${Date.now()}-00000-server`
    }));

    const totalCount = tags.length + quickCommandTags.length + sshKeys.length + proxies.length + quickCommands.length + connections.length + settings.length;

    return {
      snapshot_cursor: snapshotCursor,
      page,
      page_size: pageSize,
      total_count: totalCount,
      has_more: false,
      entities: {
        tags,
        quick_command_tags: quickCommandTags,
        ssh_keys: sshKeys,
        proxies,
        quick_commands: quickCommands,
        connections,
        settings
      },
      tombstones,
      server_time: serverTime
    };
  },

  /**
   * 墓碑定期 GC 与 sync_changes 冗余压缩
   * 默认清理 30 天以前的墓碑并推进 min_valid_cursor
   */
  async cleanOldTombstonesAndCompressChanges(retentionDays: number = 30): Promise<{ purgedTombstones: number; compressedChanges: number }> {
    const db = await getDbInstance();
    const now = Date.now();
    const cutoff = now - retentionDays * 86400 * 1000;

    // 1. 查找超期墓碑
    const oldTombstones = await allDb<{ tbl: string; row_id: string }>(
      db,
      `SELECT tbl, row_id FROM sync_tombstones WHERE deleted_at < ?`,
      [cutoff]
    );

    let purgedCount = 0;
    if (oldTombstones.length > 0) {
      const rowIds = oldTombstones.map(t => t.row_id);
      const placeholders = rowIds.map(() => '?').join(',');
      const maxSeqRow = await getDb<{ maxSeq: number }>(
        db,
        `SELECT COALESCE(MAX(seq), 0) as maxSeq FROM sync_changes WHERE op = 'D' AND row_id IN (${placeholders})`,
        rowIds
      );
      const maxPurgedSeq = maxSeqRow?.maxSeq || 0;

      await runDb(db, `DELETE FROM sync_tombstones WHERE deleted_at < ?`, [cutoff]);
      if (maxPurgedSeq > 0) {
        await runDb(db, `UPDATE sync_state SET min_valid_cursor = MAX(min_valid_cursor, ?) WHERE id = 1`, [maxPurgedSeq]);
      }
      purgedCount = oldTombstones.length;
      console.log(`[SyncV2:GC] 成功清理 ${purgedCount} 条过期墓碑，推进 min_valid_cursor 至 ${maxPurgedSeq}`);
    }

    // 2. 压缩 sync_changes 表中的历史冗余行 (仅保留每条实体的最大 seq)
    const totalChangesRow = await getDb<{ count: number }>(db, `SELECT COUNT(*) as count FROM sync_changes`);
    let compressedCount = 0;
    if ((totalChangesRow?.count || 0) > 1000) {
      const minCursorRow = await getDb<{ min_valid_cursor: number }>(db, `SELECT min_valid_cursor FROM sync_state WHERE id = 1`);
      const minCursor = minCursorRow?.min_valid_cursor || 0;

      const delRes = await runDb(
        db,
        `DELETE FROM sync_changes
         WHERE seq < ? AND seq NOT IN (
           SELECT MAX(seq) FROM sync_changes GROUP BY tbl, row_id
         )`,
        [minCursor > 0 ? minCursor : 999999999]
      );
      compressedCount = delRes.changes || 0;
      console.log(`[SyncV2:GC] 压缩历史变更日志，移除了 ${compressedCount} 条历史冗余行。`);
    }

    return { purgedTombstones: purgedCount, compressedChanges: compressedCount };
  }
};
