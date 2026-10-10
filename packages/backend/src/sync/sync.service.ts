// packages/backend/src/sync/sync.service.ts
import { getDbInstance, runDb, getDb, allDb } from '../database/connection';
import { envelopeCryptoService } from './envelope-crypto.service';
import { recordTombstone, getTombstonesSince } from './tombstone.service';
import http from 'http';
import https from 'https';
import { URL } from 'url';

export interface SyncEntityItem {
  uuid: string;
  updated_at: number;
  data: any;
}

export interface SyncExchangePayload {
  clientTime: number;
  lastSyncTime?: number;
  entities: {
    tags?: SyncEntityItem[];
    ssh_keys?: SyncEntityItem[];
    proxies?: SyncEntityItem[];
    connections?: SyncEntityItem[];
    quick_commands?: SyncEntityItem[];
    workspace_sync?: SyncEntityItem[];
  };
  tombstones: Array<{ entity_type: string; uuid: string; deleted_at: number }>;
}

export interface SyncExchangeResult {
  serverTime: number;
  syncedEntities: {
    tags?: SyncEntityItem[];
    ssh_keys?: SyncEntityItem[];
    proxies?: SyncEntityItem[];
    connections?: SyncEntityItem[];
    quick_commands?: SyncEntityItem[];
    workspace_sync?: SyncEntityItem[];
  };
  tombstones: Array<{ entity_type: string; uuid: string; deleted_at: number }>;
  stats: {
    pulled: number;
    pushed: number;
    conflictsResolved: number;
  };
}

export const syncService = {
  /**
   * 导出本端自 sinceTimestamp 之后更新的数据与删除墓碑
   */
  async exportIncrementalData(sinceTimestamp: number, apiKey: string): Promise<{
    entities: SyncExchangePayload['entities'];
    tombstones: Array<{ entity_type: string; uuid: string; deleted_at: number }>;
  }> {
    const db = await getDbInstance();

    // 1. 获取 Tombstones
    const tombstones = await getTombstonesSince(sinceTimestamp);

    // 2. 导出 Tags
    const tagsRows = await allDb<any>(
      db,
      `SELECT uuid, name, created_at, updated_at FROM tags WHERE updated_at > ?`,
      [sinceTimestamp]
    );
    const tags: SyncEntityItem[] = tagsRows.map(r => ({
      uuid: r.uuid,
      updated_at: r.updated_at,
      data: { name: r.name, created_at: r.created_at, updated_at: r.updated_at }
    }));

    // 3. 导出 SshKeys (敏感字段打上信封密文)
    const sshKeysRows = await allDb<any>(
      db,
      `SELECT uuid, name, encrypted_private_key, encrypted_passphrase, created_at, updated_at FROM ssh_keys WHERE updated_at > ?`,
      [sinceTimestamp]
    );
    const ssh_keys: SyncEntityItem[] = sshKeysRows.map(r => ({
      uuid: r.uuid,
      updated_at: r.updated_at,
      data: {
        name: r.name,
        encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_private_key, apiKey),
        encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_passphrase, apiKey),
        created_at: r.created_at,
        updated_at: r.updated_at
      }
    }));

    // 4. 导出 Proxies
    const proxiesRows = await allDb<any>(
      db,
      `SELECT uuid, name, type, host, port, username, auth_method, encrypted_password, encrypted_private_key, encrypted_passphrase, created_at, updated_at FROM proxies WHERE updated_at > ?`,
      [sinceTimestamp]
    );
    const proxies: SyncEntityItem[] = proxiesRows.map(r => ({
      uuid: r.uuid,
      updated_at: r.updated_at,
      data: {
        name: r.name,
        type: r.type,
        host: r.host,
        port: r.port,
        username: r.username,
        auth_method: r.auth_method,
        encrypted_password: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_password, apiKey),
        encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_private_key, apiKey),
        encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_passphrase, apiKey),
        created_at: r.created_at,
        updated_at: r.updated_at
      }
    }));

    // 5. 导出 Connections (解析 proxy_uuid, ssh_key_uuid 以及关联的 tag_uuids)
    const connectionsRows = await allDb<any>(
      db,
      `SELECT c.id, c.uuid, c.name, c.type, c.host, c.port, c.username, c.auth_method,
              c.encrypted_password, c.encrypted_private_key, c.encrypted_passphrase,
              c.proxy_type, c.notes, c.jump_chain, c.background_color,
              c.created_at, c.updated_at,
              p.uuid as proxy_uuid, sk.uuid as ssh_key_uuid
       FROM connections c
       LEFT JOIN proxies p ON c.proxy_id = p.id
       LEFT JOIN ssh_keys sk ON c.ssh_key_id = sk.id
       WHERE c.updated_at > ?`,
      [sinceTimestamp]
    );

    const connections: SyncEntityItem[] = [];
    for (const r of connectionsRows) {
      // 查关联标签 UUID
      const tagRows = await allDb<{ uuid: string }>(
        db,
        `SELECT t.uuid FROM connection_tags ct JOIN tags t ON ct.tag_id = t.id WHERE ct.connection_id = ?`,
        [r.id]
      );
      const tagUuids = tagRows.map(t => t.uuid).filter(Boolean);

      connections.push({
        uuid: r.uuid,
        updated_at: r.updated_at,
        data: {
          name: r.name,
          type: r.type,
          host: r.host,
          port: r.port,
          username: r.username,
          auth_method: r.auth_method,
          encrypted_password: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_password, apiKey),
          encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_private_key, apiKey),
          encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_passphrase, apiKey),
          proxy_uuid: r.proxy_uuid || null,
          proxy_type: r.proxy_type || null,
          ssh_key_uuid: r.ssh_key_uuid || null,
          notes: r.notes || null,
          jump_chain: r.jump_chain || null,
          background_color: r.background_color || null,
          tag_uuids: tagUuids,
          created_at: r.created_at,
          updated_at: r.updated_at
        }
      });
    }

    // 6. 导出 QuickCommands
    const quickCmdRows = await allDb<any>(
      db,
      `SELECT uuid, name, command, usage_count, variables, created_at, updated_at FROM quick_commands WHERE updated_at > ?`,
      [sinceTimestamp]
    );
    const quick_commands: SyncEntityItem[] = quickCmdRows.map(r => ({
      uuid: r.uuid,
      updated_at: r.updated_at,
      data: {
        name: r.name,
        command: r.command,
        usage_count: r.usage_count,
        variables: r.variables,
        created_at: r.created_at,
        updated_at: r.updated_at
      }
    }));

    // 7. 导出 WorkspaceSync (快照)
    const wsRows = await allDb<any>(
      db,
      `SELECT user_id, state, active_client_id, updated_at FROM workspace_sync WHERE updated_at > ?`,
      [sinceTimestamp]
    );
    const workspace_sync: SyncEntityItem[] = wsRows.map(r => ({
      uuid: `ws_user_${r.user_id}`,
      updated_at: r.updated_at,
      data: {
        user_id: r.user_id,
        state: r.state,
        active_client_id: r.active_client_id,
        updated_at: r.updated_at
      }
    }));

    return {
      entities: {
        tags,
        ssh_keys,
        proxies,
        connections,
        quick_commands,
        workspace_sync
      },
      tombstones
    };
  },

  /**
   * 应用传入的数据并按 LWW (Last-Write-Wins) 规则执行冲突合并
   */
  async applyIncomingData(
    payload: {
      entities?: SyncExchangePayload['entities'];
      tombstones?: Array<{ entity_type: string; uuid: string; deleted_at: number }>;
    },
    apiKey: string
  ): Promise<{ pushed: number; conflictsResolved: number }> {
    const db = await getDbInstance();
    let pushed = 0;
    let conflictsResolved = 0;

    const { entities = {}, tombstones = [] } = payload;

    // --- 步骤 1: 处理删除墓碑 ---
    for (const t of tombstones) {
      if (t.entity_type === 'connections') {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM connections WHERE uuid = ?`,
          [t.uuid]
        );
        if (local) {
          if (local.updated_at <= t.deleted_at) {
            await runDb(db, `DELETE FROM connections WHERE uuid = ?`, [t.uuid]);
            await recordTombstone('connections', t.uuid, t.deleted_at);
            pushed++;
          } else {
            conflictsResolved++; // 本地修改比远端删除更新，保留本地
          }
        }
      } else if (t.entity_type === 'proxies') {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM proxies WHERE uuid = ?`,
          [t.uuid]
        );
        if (local) {
          if (local.updated_at <= t.deleted_at) {
            await runDb(db, `DELETE FROM proxies WHERE uuid = ?`, [t.uuid]);
            await recordTombstone('proxies', t.uuid, t.deleted_at);
            pushed++;
          } else {
            conflictsResolved++;
          }
        }
      } else if (t.entity_type === 'ssh_keys') {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM ssh_keys WHERE uuid = ?`,
          [t.uuid]
        );
        if (local) {
          if (local.updated_at <= t.deleted_at) {
            await runDb(db, `DELETE FROM ssh_keys WHERE uuid = ?`, [t.uuid]);
            await recordTombstone('ssh_keys', t.uuid, t.deleted_at);
            pushed++;
          } else {
            conflictsResolved++;
          }
        }
      } else if (t.entity_type === 'tags') {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM tags WHERE uuid = ?`,
          [t.uuid]
        );
        if (local) {
          if (local.updated_at <= t.deleted_at) {
            await runDb(db, `DELETE FROM tags WHERE uuid = ?`, [t.uuid]);
            await recordTombstone('tags', t.uuid, t.deleted_at);
            pushed++;
          } else {
            conflictsResolved++;
          }
        }
      } else if (t.entity_type === 'quick_commands') {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM quick_commands WHERE uuid = ?`,
          [t.uuid]
        );
        if (local) {
          if (local.updated_at <= t.deleted_at) {
            await runDb(db, `DELETE FROM quick_commands WHERE uuid = ?`, [t.uuid]);
            await recordTombstone('quick_commands', t.uuid, t.deleted_at);
            pushed++;
          } else {
            conflictsResolved++;
          }
        }
      }
    }

    // --- 步骤 2: 合并 Tags ---
    if (entities.tags) {
      for (const item of entities.tags) {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM tags WHERE uuid = ?`,
          [item.uuid]
        );
        if (!local) {
          // 检查 name 是否重复
          const existingName = await getDb<{ id: number }>(
            db,
            `SELECT id FROM tags WHERE name = ?`,
            [item.data.name]
          );
          if (existingName) {
            await runDb(db, `UPDATE tags SET uuid = ?, updated_at = ? WHERE id = ?`, [
              item.uuid,
              item.updated_at,
              existingName.id
            ]);
          } else {
            await runDb(
              db,
              `INSERT INTO tags (uuid, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
              [item.uuid, item.data.name, item.data.created_at || item.updated_at, item.updated_at]
            );
          }
          pushed++;
        } else if (item.updated_at > local.updated_at) {
          await runDb(db, `UPDATE tags SET name = ?, updated_at = ? WHERE uuid = ?`, [
            item.data.name,
            item.updated_at,
            item.uuid
          ]);
          pushed++;
          conflictsResolved++;
        }
      }
    }

    // --- 步骤 3: 合并 SshKeys ---
    if (entities.ssh_keys) {
      for (const item of entities.ssh_keys) {
        const localEncKey = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_private_key, apiKey);
        const localEncPass = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_passphrase, apiKey);

        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM ssh_keys WHERE uuid = ?`,
          [item.uuid]
        );
        if (!local) {
          // 检查同名
          const existingName = await getDb<{ id: number }>(
            db,
            `SELECT id FROM ssh_keys WHERE name = ?`,
            [item.data.name]
          );
          if (existingName) {
            await runDb(
              db,
              `UPDATE ssh_keys SET uuid = ?, encrypted_private_key = ?, encrypted_passphrase = ?, updated_at = ? WHERE id = ?`,
              [item.uuid, localEncKey, localEncPass, item.updated_at, existingName.id]
            );
          } else {
            await runDb(
              db,
              `INSERT INTO ssh_keys (uuid, name, encrypted_private_key, encrypted_passphrase, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
              [item.uuid, item.data.name, localEncKey, localEncPass, item.data.created_at || item.updated_at, item.updated_at]
            );
          }
          pushed++;
        } else if (item.updated_at > local.updated_at) {
          await runDb(
            db,
            `UPDATE ssh_keys SET name = ?, encrypted_private_key = ?, encrypted_passphrase = ?, updated_at = ? WHERE uuid = ?`,
            [item.data.name, localEncKey, localEncPass, item.updated_at, item.uuid]
          );
          pushed++;
          conflictsResolved++;
        }
      }
    }

    // --- 步骤 4: 合并 Proxies ---
    if (entities.proxies) {
      for (const item of entities.proxies) {
        const localEncPwd = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_password, apiKey);
        const localEncKey = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_private_key, apiKey);
        const localEncPass = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_passphrase, apiKey);

        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM proxies WHERE uuid = ?`,
          [item.uuid]
        );
        if (!local) {
          await runDb(
            db,
            `INSERT INTO proxies (uuid, name, type, host, port, username, auth_method, encrypted_password, encrypted_private_key, encrypted_passphrase, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              item.uuid,
              item.data.name,
              item.data.type,
              item.data.host,
              item.data.port,
              item.data.username || null,
              item.data.auth_method || 'none',
              localEncPwd,
              localEncKey,
              localEncPass,
              item.data.created_at || item.updated_at,
              item.updated_at
            ]
          );
          pushed++;
        } else if (item.updated_at > local.updated_at) {
          await runDb(
            db,
            `UPDATE proxies SET name = ?, type = ?, host = ?, port = ?, username = ?, auth_method = ?,
                                encrypted_password = ?, encrypted_private_key = ?, encrypted_passphrase = ?, updated_at = ?
             WHERE uuid = ?`,
            [
              item.data.name,
              item.data.type,
              item.data.host,
              item.data.port,
              item.data.username || null,
              item.data.auth_method || 'none',
              localEncPwd,
              localEncKey,
              localEncPass,
              item.updated_at,
              item.uuid
            ]
          );
          pushed++;
          conflictsResolved++;
        }
      }
    }

    // --- 步骤 5: 合并 Connections ---
    if (entities.connections) {
      for (const item of entities.connections) {
        const localEncPwd = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_password, apiKey);
        const localEncKey = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_private_key, apiKey);
        const localEncPass = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_passphrase, apiKey);

        // 解析依赖关系 ID
        let resolvedProxyId: number | null = null;
        if (item.data.proxy_uuid) {
          const p = await getDb<{ id: number }>(db, `SELECT id FROM proxies WHERE uuid = ?`, [item.data.proxy_uuid]);
          if (p) resolvedProxyId = p.id;
        }

        let resolvedSshKeyId: number | null = null;
        if (item.data.ssh_key_uuid) {
          const k = await getDb<{ id: number }>(db, `SELECT id FROM ssh_keys WHERE uuid = ?`, [item.data.ssh_key_uuid]);
          if (k) resolvedSshKeyId = k.id;
        }

        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM connections WHERE uuid = ?`,
          [item.uuid]
        );

        let targetConnectionId: number;

        if (!local) {
          const insertResult = await runDb(
            db,
            `INSERT INTO connections (uuid, name, type, host, port, username, auth_method,
                                     encrypted_password, encrypted_private_key, encrypted_passphrase,
                                     proxy_id, proxy_type, ssh_key_id, notes, jump_chain, background_color,
                                     created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              item.uuid,
              item.data.name || null,
              item.data.type || 'SSH',
              item.data.host,
              item.data.port,
              item.data.username,
              item.data.auth_method,
              localEncPwd,
              localEncKey,
              localEncPass,
              resolvedProxyId,
              item.data.proxy_type || null,
              resolvedSshKeyId,
              item.data.notes || null,
              item.data.jump_chain ? JSON.stringify(item.data.jump_chain) : null,
              item.data.background_color || null,
              item.data.created_at || item.updated_at,
              item.updated_at
            ]
          );
          targetConnectionId = insertResult.lastID;
          pushed++;
        } else if (item.updated_at > local.updated_at) {
          await runDb(
            db,
            `UPDATE connections SET name = ?, type = ?, host = ?, port = ?, username = ?, auth_method = ?,
                                   encrypted_password = ?, encrypted_private_key = ?, encrypted_passphrase = ?,
                                   proxy_id = ?, proxy_type = ?, ssh_key_id = ?, notes = ?, jump_chain = ?, background_color = ?,
                                   updated_at = ?
             WHERE uuid = ?`,
            [
              item.data.name || null,
              item.data.type || 'SSH',
              item.data.host,
              item.data.port,
              item.data.username,
              item.data.auth_method,
              localEncPwd,
              localEncKey,
              localEncPass,
              resolvedProxyId,
              item.data.proxy_type || null,
              resolvedSshKeyId,
              item.data.notes || null,
              item.data.jump_chain ? JSON.stringify(item.data.jump_chain) : null,
              item.data.background_color || null,
              item.updated_at,
              item.uuid
            ]
          );
          targetConnectionId = local.id;
          pushed++;
          conflictsResolved++;
        } else {
          targetConnectionId = local.id;
        }

        // 重新对齐 connection_tags
        if (targetConnectionId && Array.isArray(item.data.tag_uuids)) {
          await runDb(db, `DELETE FROM connection_tags WHERE connection_id = ?`, [targetConnectionId]);
          for (const tUuid of item.data.tag_uuids) {
            const t = await getDb<{ id: number }>(db, `SELECT id FROM tags WHERE uuid = ?`, [tUuid]);
            if (t) {
              await runDb(db, `INSERT OR IGNORE INTO connection_tags (connection_id, tag_id) VALUES (?, ?)`, [
                targetConnectionId,
                t.id
              ]);
            }
          }
        }
      }
    }

    // --- 步骤 6: 合并 QuickCommands ---
    if (entities.quick_commands) {
      for (const item of entities.quick_commands) {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM quick_commands WHERE uuid = ?`,
          [item.uuid]
        );
        if (!local) {
          await runDb(
            db,
            `INSERT INTO quick_commands (uuid, name, command, usage_count, variables, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              item.uuid,
              item.data.name || null,
              item.data.command,
              item.data.usage_count || 0,
              item.data.variables || null,
              item.data.created_at || item.updated_at,
              item.updated_at
            ]
          );
          pushed++;
        } else if (item.updated_at > local.updated_at) {
          await runDb(
            db,
            `UPDATE quick_commands SET name = ?, command = ?, usage_count = ?, variables = ?, updated_at = ? WHERE uuid = ?`,
            [
              item.data.name || null,
              item.data.command,
              item.data.usage_count || 0,
              item.data.variables || null,
              item.updated_at,
              item.uuid
            ]
          );
          pushed++;
          conflictsResolved++;
        }
      }
    }

    // --- 步骤 7: 合并 WorkspaceSync (工作区快照) ---
    if (entities.workspace_sync && entities.workspace_sync.length > 0) {
      for (const item of entities.workspace_sync) {
        const targetUserId = item.data.user_id || 1;
        const local = await getDb<{ updated_at: number }>(
          db,
          `SELECT updated_at FROM workspace_sync WHERE user_id = ?`,
          [targetUserId]
        );
        if (!local) {
          await runDb(
            db,
            `INSERT INTO workspace_sync (user_id, state, active_client_id, updated_at) VALUES (?, ?, ?, ?)`,
            [targetUserId, item.data.state || '{}', item.data.active_client_id || null, item.updated_at]
          );
          pushed++;
        } else if (item.updated_at > local.updated_at) {
          await runDb(
            db,
            `UPDATE workspace_sync SET state = ?, active_client_id = ?, updated_at = ? WHERE user_id = ?`,
            [item.data.state || '{}', item.data.active_client_id || null, item.updated_at, targetUserId]
          );
          pushed++;
          conflictsResolved++;
        }
      }
    }

    return { pushed, conflictsResolved };
  },

  /**
   * 服务端处理双向数据交换
   */
  async processExchange(payload: SyncExchangePayload, apiKey?: string): Promise<SyncExchangeResult> {
    const key = apiKey || process.env.SYNC_API_KEY || 'default-fallback-key';
    const serverTime = Math.floor(Date.now() / 1000);
    const clientLastSyncTime = payload.lastSyncTime || 0;

    // 1. 应用客户端推送过来的数据
    const { pushed, conflictsResolved } = await this.applyIncomingData(payload, key);

    // 2. 导出服务端自 clientLastSyncTime 之后更新的数据并返回
    const exportResult = await this.exportIncrementalData(clientLastSyncTime, key);

    let pulledCount = 0;
    Object.values(exportResult.entities).forEach(list => {
      if (Array.isArray(list)) pulledCount += list.length;
    });

    return {
      serverTime,
      syncedEntities: exportResult.entities,
      tombstones: exportResult.tombstones,
      stats: {
        pulled: pulledCount,
        pushed,
        conflictsResolved
      }
    };
  },

  /**
   * 客户端发送 HTTP/HTTPS JSON 请求辅助函数
   */
  async makeHttpRequest(urlStr: string, options: { method: string; headers?: Record<string, string>; body?: any; timeoutMs?: number }): Promise<any> {
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
      timeout: options.timeoutMs || 10000,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...options.headers
      }
    };

    return new Promise((resolve, reject) => {
      const req = client.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
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
              resolve(data);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求远程 VPS 超时'));
      });

      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  },

  /**
   * 客户端主动测试 VPS 连通性
   */
  async testRemoteConnection(vpsUrl: string, apiKey: string): Promise<{ success: boolean; latencyMs: number; data?: any }> {
    const cleanUrl = vpsUrl.replace(/\/+$/, '');
    const pingEndpoint = `${cleanUrl}/api/v1/sync/ping`;
    const startTime = Date.now();

    const response = await this.makeHttpRequest(pingEndpoint, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey
      },
      timeoutMs: 8000
    });

    const latencyMs = Date.now() - startTime;
    return {
      success: true,
      latencyMs,
      data: response
    };
  },

  /**
   * 客户端主动向 VPS 触发全量双向同步
   */
  async triggerClientSync(vpsUrl: string, apiKey: string, lastSyncTime: number = 0): Promise<{
    success: boolean;
    serverTime: number;
    stats: {
      pushed: number;
      pulled: number;
      conflictsResolved: number;
    };
  }> {
    const cleanUrl = vpsUrl.replace(/\/+$/, '');
    const exchangeEndpoint = `${cleanUrl}/api/v1/sync/exchange`;

    // 1. 搜集客户端自上次同步以来产生的新数据与删除墓碑
    const clientIncremental = await this.exportIncrementalData(lastSyncTime, apiKey);

    const payload: SyncExchangePayload = {
      clientTime: Math.floor(Date.now() / 1000),
      lastSyncTime,
      entities: clientIncremental.entities,
      tombstones: clientIncremental.tombstones
    };

    // 2. 发起 HTTP 请求到 VPS exchange 接口
    const res = await this.makeHttpRequest(exchangeEndpoint, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey
      },
      body: payload,
      timeoutMs: 30000
    });

    if (!res || !res.success || !res.data) {
      throw new Error(res?.error || '远程同步响应格式不正确');
    }

    const exchangeData: SyncExchangeResult = res.data;

    // 3. 客户端本地应用 VPS 返回的变更
    const applyStats = await this.applyIncomingData(
      {
        entities: exchangeData.syncedEntities,
        tombstones: exchangeData.tombstones
      },
      apiKey
    );

    return {
      success: true,
      serverTime: exchangeData.serverTime,
      stats: {
        pushed: exchangeData.stats.pushed,
        pulled: applyStats.pushed,
        conflictsResolved: exchangeData.stats.conflictsResolved + applyStats.conflictsResolved
      }
    };
  }
};
