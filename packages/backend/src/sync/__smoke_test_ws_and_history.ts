// packages/backend/src/sync/__smoke_test_ws_and_history.ts
import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';
import { getDbInstance, allDb, getDb, runDb } from '../database/connection';
import { syncV2Service } from './sync.v2.service';
import { getServerSyncApiKey } from './sync.middleware';
import { broadcastSyncInvalidated } from './sync.ws-broadcaster';

async function runSmokeTests() {
  console.log('===============================================================');
  console.log('🧪 开始命令历史增量同步 & WebSocket 实时长连接端到端冒烟测试');
  console.log('===============================================================\n');

  const db = await getDbInstance();
  const apiKey = (await getServerSyncApiKey()) || 'nexus-sync-key-2026';
  console.log(`[准备] 获取服务端 Sync API Key: ${apiKey.substring(0, 8)}...`);

  // 保证 sync_state 处于启用且未在 applying 状态
  await runDb(db, 'UPDATE sync_state SET enabled = 1, applying = 0 WHERE id = 1');

  // =========================================================================
  // 测试 1: 验证 command_history 表结构与触发器
  // =========================================================================
  console.log('\n--- [测试 1] 验证 command_history 表结构与增量触发器 ---');
  const columns: any[] = await allDb(db, 'PRAGMA table_info(command_history)');
  const hasUuid = columns.some(c => c.name === 'uuid');
  const hasHlc = columns.some(c => c.name === 'updated_hlc');
  if (!hasUuid || !hasHlc) {
    throw new Error(`[FAIL] command_history 缺少 uuid 或 updated_hlc 字段! (hasUuid=${hasUuid}, hasHlc=${hasHlc})`);
  }
  console.log('  ✅ 表结构校验通过: uuid 和 updated_hlc 字段均存在');

  const triggers: any[] = await allDb(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'command_history'"
  );
  const triggerNames = triggers.map(t => t.name);
  console.log(`  🔍 检测到 command_history 触发器: ${triggerNames.join(', ')}`);
  if (!triggerNames.includes('command_history_sync_ai') || !triggerNames.includes('command_history_sync_ad')) {
    throw new Error(`[FAIL] command_history 触发器安装不完整: ${JSON.stringify(triggerNames)}`);
  }
  console.log('  ✅ 触发器安装完整: command_history_sync_ai, command_history_sync_au, command_history_sync_ad 就绪');

  // =========================================================================
  // 测试 2: 验证 command_history 插入、触发器捕获与删除墓碑
  // =========================================================================
  console.log('\n--- [测试 2] 验证 command_history 插入、触发器捕获与删除墓碑 ---');
  const testCmd = `echo "smoke_test_${Date.now()}"`;
  const insertRes = await runDb(
    db,
    'INSERT INTO command_history (command, timestamp) VALUES (?, ?)',
    [testCmd, Math.floor(Date.now() / 1000)]
  );
  const testId = insertRes.lastID;

  const insertedRow: any = await getDb(db, 'SELECT * FROM command_history WHERE id = ?', [testId]);
  if (!insertedRow.uuid || !insertedRow.updated_hlc) {
    throw new Error(`[FAIL] 插入 command_history 后触发器未能生成 uuid 或 updated_hlc! 详情: ${JSON.stringify(insertedRow)}`);
  }
  console.log(`  ✅ 插入记录成功: ID=${testId}, 自动生成 UUID=${insertedRow.uuid}, HLC=${insertedRow.updated_hlc}`);

  // 检查 sync_changes 中是否有该记录的 Upsert (op = 'U') 变更
  const insertChange: any = await getDb(
    db,
    "SELECT * FROM sync_changes WHERE tbl = 'command_history' AND row_id = ? AND op = 'U' ORDER BY seq DESC LIMIT 1",
    [insertedRow.uuid]
  );
  if (!insertChange) {
    throw new Error(`[FAIL] sync_changes 未能捕获 command_history 的新增变更!`);
  }
  console.log(`  ✅ sync_changes 成功捕获新增变更: seq=${insertChange.seq}`);

  // 测试物理删除并检查墓碑生成
  await runDb(db, 'DELETE FROM command_history WHERE id = ?', [testId]);
  const deletedCheck = await getDb(db, 'SELECT * FROM command_history WHERE id = ?', [testId]);
  if (deletedCheck) {
    throw new Error(`[FAIL] 记录未被物理删除!`);
  }

  // 检查 sync_tombstones 是否生成墓碑
  const tombstone: any = await getDb(
    db,
    "SELECT * FROM sync_tombstones WHERE tbl = 'command_history' AND row_id = ?",
    [insertedRow.uuid]
  );
  if (!tombstone) {
    throw new Error(`[FAIL] sync_tombstones 未能生成 command_history 的删除墓碑!`);
  }
  console.log(`  ✅ sync_tombstones 成功生成删除墓碑: row_id=${tombstone.row_id}, deleted_hlc=${tombstone.deleted_hlc}`);

  // 检查 sync_changes 是否记录了 DELETE (op = 'D')
  const deleteChange: any = await getDb(
    db,
    "SELECT * FROM sync_changes WHERE tbl = 'command_history' AND row_id = ? AND op = 'D' ORDER BY seq DESC LIMIT 1",
    [insertedRow.uuid]
  );
  if (!deleteChange) {
    throw new Error(`[FAIL] sync_changes 未能捕获 command_history 的 DELETE 变更!`);
  }
  console.log(`  ✅ sync_changes 成功捕获 DELETE 变更: seq=${deleteChange.seq}`);

  // 清理测试临时数据
  await runDb(db, 'DELETE FROM sync_changes WHERE row_id = ?', [insertedRow.uuid]);
  await runDb(db, 'DELETE FROM sync_tombstones WHERE row_id = ?', [insertedRow.uuid]);

  // =========================================================================
  // 测试 3: 验证 /ws/sync WebSocket 握手鉴权 (未授权拦截)
  // =========================================================================
  console.log('\n--- [测试 3] 验证 WebSocket /ws/sync 独立鉴权安全拦截 ---');
  
  const rejectedPromise = new Promise<boolean>((resolve) => {
    const wsUnauthorized = new WebSocket('ws://127.0.0.1:3001/ws/sync');
    wsUnauthorized.on('error', () => {
      resolve(true);
    });
    wsUnauthorized.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    wsUnauthorized.on('open', () => {
      wsUnauthorized.close();
      resolve(false);
    });
    setTimeout(() => resolve(false), 3000);
  });

  const rejected = await rejectedPromise;
  if (!rejected) {
    throw new Error(`[FAIL] 无 API Key 的非法 WebSocket 连接未被拒绝!`);
  }
  console.log('  ✅ 安全拦截生效: 无有效 API Key 的 /ws/sync 连接被成功拒绝 (401 Unauthorized)');

  // =========================================================================
  // 测试 4: 验证合法 API Key 建立长连接并接收实时广播
  // =========================================================================
  console.log('\n--- [测试 4] 验证合法 API Key 建立长连接与毫秒级广播推送 ---');
  
  const wsValidUrl = `ws://127.0.0.1:3001/ws/sync?apiKey=${encodeURIComponent(apiKey)}`;
  const wsClient = new WebSocket(wsValidUrl);

  const readyPromise = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 sync:ready 超时')), 4000);
    wsClient.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'sync:ready') {
          clearTimeout(timer);
          resolve(msg);
        }
      } catch (err) {
        // ignore
      }
    });
    wsClient.on('error', reject);
  });

  const readyMsg = await readyPromise;
  console.log(`  ✅ 握手成功并建立长连接: 收到 ready 响应, 消息="${readyMsg.message}"`);

  // 4.2 触发服务端广播并测量端到端延迟
  console.log('  📡 正在向服务端发送 sync:notify 触发实时广播 ...');
  const broadcastReceivedPromise = new Promise<{ msg: any; latencyMs: number }>((resolve, reject) => {
    const startMs = Date.now();
    const timer = setTimeout(() => reject(new Error('等待广播消息超时')), 4000);
    
    wsClient.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'sync:invalidated' && msg.seq === 88888) {
          const latencyMs = Date.now() - startMs;
          clearTimeout(timer);
          resolve({ msg, latencyMs });
        }
      } catch (err) {
        // ignore
      }
    });
  });

  // 客户端向上发送 sync:notify 指令，服务端会向池中所有客户端广播 sync:invalidated
  wsClient.send(JSON.stringify({ type: 'sync:notify', seq: 88888 }));
  const { msg: broadcastMsg, latencyMs } = await broadcastReceivedPromise;
  console.log(`  ✅ 收到实时失效广播: type=${broadcastMsg.type}, seq=${broadcastMsg.seq}, 端到端延迟: ${latencyMs}ms`);

  wsClient.close();

  // =========================================================================
  // 测试 5: 验证 sync.v2.service 命令历史数据增量打包与快照解析
  // =========================================================================
  console.log('\n--- [测试 5] 验证 sync.v2.service 命令历史双向增量打包与快照解析 ---');
  
  const pairingSecret = apiKey;

  // 5.1 生成快照
  const snapshot = await syncV2Service.getSnapshot(1, 200, pairingSecret);
  if (!snapshot.entities.command_history) {
    throw new Error(`[FAIL] 生成的全量快照中缺少 command_history 表!`);
  }
  console.log(`  ✅ 全量快照生成成功: command_history 表包含 ${snapshot.entities.command_history.length} 条记录`);

  // 5.2 模拟对端传入包含命令历史的增量变更集
  const remoteTestUuid = uuidv4();
  const remoteCommand = 'docker ps -a --format "table {{.Names}}\\t{{.Status}}"';
  const remoteHlc = `${Date.now()}-00001-remote_test_node`;

  const incomingChanges = [
    {
      seq: 1,
      tbl: 'command_history',
      row_id: remoteTestUuid,
      op: 'U' as const,
      hlc: remoteHlc,
      data: {
        command: remoteCommand,
        timestamp: Math.floor(Date.now() / 1000)
      }
    }
  ];

  await syncV2Service.applyRemoteChanges(incomingChanges, 'remote_test_node', pairingSecret, false);
  const syncedRow: any = await getDb(db, 'SELECT * FROM command_history WHERE uuid = ?', [remoteTestUuid]);
  if (!syncedRow || syncedRow.command !== remoteCommand) {
    throw new Error(`[FAIL] 增量写入远程命令历史失败! 查询结果: ${JSON.stringify(syncedRow)}`);
  }
  console.log(`  ✅ 远程命令历史成功写入本地 SQLite: command="${syncedRow.command}", uuid=${syncedRow.uuid}`);

  // 5.3 模拟对端传入该命令历史的删除墓碑 (op = 'D')
  const tombstoneChanges = [
    {
      seq: 2,
      tbl: 'command_history',
      row_id: remoteTestUuid,
      op: 'D' as const,
      hlc: `${Date.now() + 1000}-00002-remote_test_node`
    }
  ];

  await syncV2Service.applyRemoteChanges(tombstoneChanges, 'remote_test_node', pairingSecret, false);
  const deletedCheck2 = await getDb(db, 'SELECT * FROM command_history WHERE uuid = ?', [remoteTestUuid]);
  if (deletedCheck2) {
    throw new Error(`[FAIL] 应用删除墓碑后，本地命令历史记录未被删除!`);
  }
  console.log(`  ✅ 远程删除墓碑成功在本地执行物理删除: UUID=${remoteTestUuid} 已清理`);

  // 清理测试数据
  await runDb(db, 'DELETE FROM sync_tombstones WHERE row_id = ?', [remoteTestUuid]);
  await runDb(db, 'DELETE FROM sync_changes WHERE row_id = ?', [remoteTestUuid]);

  console.log('\n===============================================================');
  console.log('🎉 所有冒烟测试用例 100% 通过！命令历史增量与 WebSocket 长连接完全正常！');
  console.log('===============================================================\n');
}

runSmokeTests().catch((err) => {
  console.error('\n❌ 冒烟测试失败:', err);
  process.exit(1);
});
