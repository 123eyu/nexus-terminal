import http from 'http';
import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import sqlite3 from 'sqlite3';

const CLOUD_PORT = 19999;
const LOCAL_PORT = 19998;
const TEST_API_KEY = 'test-sync-api-key-8888';

const projectRoot = path.resolve(__dirname, '../../../..');
const cloudDataDir = path.resolve(projectRoot, 'test_env/cloud_data');
const localDataDir = path.resolve(projectRoot, 'test_env/local_data');

function cleanDir(dirPath: string) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

function requestJson(urlStr: string, options: { method: string; headers?: Record<string, string>; body?: any }): Promise<any> {
  const url = new URL(urlStr);
  const postData = options.body ? JSON.stringify(options.body) : '';
  const reqOptions: http.RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || 80,
    path: `${url.pathname}${url.search}`,
    method: options.method,
    headers: {
      'Content-Type': 'application/json',
      ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
      ...options.headers
    }
  };

  return new Promise((resolve, reject) => {
    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function waitForServer(port: number, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await requestJson(`http://127.0.0.1:${port}/api/v1/status`, { method: 'GET' });
      if (res.status === 200) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function openDb(dbPath: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function runSql(db: sqlite3.Database, sql: string, params: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function querySql<T = any>(db: sqlite3.Database, sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as T[]);
    });
  });
}

async function main() {
  console.log('===============================================================');
  console.log('🧪 开始云端与桌面端双向同步冒烟测试：模拟复现对齐清空 Bug');
  console.log('===============================================================');

  // 1. 初始化独立的数据目录
  console.log('[1/7] 清理并准备测试数据目录...');
  cleanDir(cloudDataDir);
  cleanDir(localDataDir);

  // 写入桌面端配置
  fs.writeFileSync(
    path.join(localDataDir, 'desktop-settings.json'),
    JSON.stringify({
      syncVpsUrl: `http://127.0.0.1:${CLOUD_PORT}`,
      syncApiKey: TEST_API_KEY,
      syncAutoInterval: 0 // 冒烟阶段禁用自动定时轮询，由测试显式控制
    }, null, 2)
  );

  const distScript = path.resolve(projectRoot, 'packages/backend/dist/index.js');
  let cloudProc: ChildProcess | null = null;
  let localProc: ChildProcess | null = null;

  try {
    // 2. 启动模拟云端服务 (PORT: 19999)
    console.log(`[2/7] 正在启动模拟云端 VPS (端口: ${CLOUD_PORT})...`);
    cloudProc = spawn('node', [distScript], {
      env: {
        ...process.env,
        PORT: String(CLOUD_PORT),
        NEXUS_DATA_DIR: cloudDataDir,
        SYNC_API_KEY: TEST_API_KEY,
        NODE_ENV: 'production'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    cloudProc.stdout?.on('data', d => {
      const line = d.toString().trim();
      if (line.includes('[Sync') || line.includes('error') || line.includes('DELETE')) {
        console.log(`  [Cloud] ${line}`);
      }
    });

    // 3. 启动模拟本地桌面端服务 (PORT: 19998)
    console.log(`[3/7] 正在启动模拟本地桌面端 (端口: ${LOCAL_PORT})...`);
    localProc = spawn('node', [distScript], {
      env: {
        ...process.env,
        PORT: String(LOCAL_PORT),
        NEXUS_DATA_DIR: localDataDir,
        SYNC_VPS_URL: `http://127.0.0.1:${CLOUD_PORT}`,
        SYNC_API_KEY: TEST_API_KEY,
        NODE_ENV: 'production'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    localProc.stdout?.on('data', d => {
      const line = d.toString().trim();
      if (line.includes('[Sync') || line.includes('error') || line.includes('DELETE')) {
        console.log(`  [Local] ${line}`);
      }
    });

    const cloudReady = await waitForServer(CLOUD_PORT);
    const localReady = await waitForServer(LOCAL_PORT);

    if (!cloudReady || !localReady) {
      throw new Error(`服务启动失败: CloudReady=${cloudReady}, LocalReady=${localReady}`);
    }
    console.log('✅ 云端与桌面端双服务均已就绪并监听端口！');

    // 4. 初始化两端的数据
    console.log('\n[4/7] 往云端和本地注入测试数据...');
    const cloudDbPath = path.join(cloudDataDir, 'nexus-terminal.db');
    const localDbPath = path.join(localDataDir, 'nexus-terminal.db');

    const cloudDb = await openDb(cloudDbPath);
    const localDb = await openDb(localDbPath);

    // 云端配置 key
    await runSql(cloudDb, `INSERT OR REPLACE INTO settings (key, value) VALUES ('syncApiKey', ?)`, [TEST_API_KEY]);

    // 云端插入 2 台主机
    const nowSec = Math.floor(Date.now() / 1000);
    await runSql(cloudDb, `
      INSERT INTO connections (uuid, name, type, host, port, username, auth_method, created_at, updated_at)
      VALUES ('cloud-host-uuid-1', '生产主机-Web-1', 'SSH', '1.1.1.1', 22, 'root', 'password', ?, ?)
    `, [nowSec, nowSec]);

    await runSql(cloudDb, `
      INSERT INTO connections (uuid, name, type, host, port, username, auth_method, created_at, updated_at)
      VALUES ('cloud-host-uuid-2', '生产主机-DB-2', 'SSH', '1.1.1.2', 22, 'root', 'password', ?, ?)
    `, [nowSec, nowSec]);

    // 关键仿真：用户之前已经同步过一次（或者本地已有这批云端资产），本地数据库中也有这两个 UUID
    await runSql(localDb, `
      INSERT INTO connections (uuid, name, type, host, port, username, auth_method, created_at, updated_at)
      VALUES ('cloud-host-uuid-1', '生产主机-Web-1', 'SSH', '1.1.1.1', 22, 'root', 'password', ?, ?)
    `, [nowSec, nowSec]);

    await runSql(localDb, `
      INSERT INTO connections (uuid, name, type, host, port, username, auth_method, created_at, updated_at)
      VALUES ('cloud-host-uuid-2', '生产主机-DB-2', 'SSH', '1.1.1.2', 22, 'root', 'password', ?, ?)
    `, [nowSec, nowSec]);

    await runSql(localDb, `
      INSERT INTO connections (uuid, name, type, host, port, username, auth_method, created_at, updated_at)
      VALUES ('local-host-uuid-extra', '本地额外临时机', 'SSH', '192.168.1.88', 22, 'user', 'password', ?, ?)
    `, [nowSec, nowSec]);

    const initialCloudHosts = await querySql(cloudDb, `SELECT id, uuid, name, host FROM connections`);
    const initialLocalHosts = await querySql(localDb, `SELECT id, uuid, name, host FROM connections`);

    console.log(`  -> 初始云端主机 (${initialCloudHosts.length} 台):`, initialCloudHosts.map(h => `${h.name} (${h.host})`));
    console.log(`  -> 初始本地主机 (${initialLocalHosts.length} 台):`, initialLocalHosts.map(h => `${h.name} (${h.host})`));

    if (initialCloudHosts.length !== 2 || initialLocalHosts.length !== 3) {
      throw new Error('测试数据初始化失败');
    }

    // 5. 模拟用户在对齐向导中点击【以云端为准 (覆盖本地)】
    console.log('\n[5/7] 模拟用户在桌面端执行【以云端为准 (覆盖本地)】(cloud_to_local)...');
    const syncRes = await requestJson(`http://127.0.0.1:${LOCAL_PORT}/api/v1/desktop/sync/trigger`, {
      method: 'POST',
      body: {
        vpsUrl: `http://127.0.0.1:${CLOUD_PORT}`,
        apiKey: TEST_API_KEY,
        mode: 'cloud_to_local',
        modules: ['connections']
      }
    });

    console.log('  -> 本地同步触发响应:', syncRes.body);

    // 检查本地 sync_changes 状态
    const localChangesAfterClear = await querySql(localDb, `SELECT seq, tbl, row_id, op, origin FROM sync_changes`);
    console.log(`  -> 本地 sync_changes 记录数: ${localChangesAfterClear.length}`);
    for (const c of localChangesAfterClear) {
      console.log(`     - [${c.op}] tbl=${c.tbl}, row_id=${c.row_id}, origin=${c.origin}`);
    }

    // 等待 3 秒观察后台调度器/后续同步行为
    console.log('\n[6/7] 等待 3 秒观察后台调度器与变更推送情况...');
    await new Promise(r => setTimeout(r, 3000));

    // 检查云端与本地当前的主机数据
    const currentCloudHosts = await querySql(cloudDb, `SELECT id, uuid, name, host FROM connections`);
    const currentLocalHosts = await querySql(localDb, `SELECT id, uuid, name, host FROM connections`);
    const cloudChanges = await querySql(cloudDb, `SELECT seq, tbl, row_id, op, origin FROM sync_changes`);
    const cloudTombstones = await querySql(cloudDb, `SELECT tbl, row_id, deleted_at FROM sync_tombstones`);

    console.log('\n[7/7] 冒烟测试核验结果:');
    console.log(`  -> 此时本地主机数: ${currentLocalHosts.length} 台`, currentLocalHosts.map(h => h.name));
    console.log(`  -> 此时云端主机数: ${currentCloudHosts.length} 台`, currentCloudHosts.map(h => h.name));
    console.log(`  -> 云端 sync_tombstones 数: ${cloudTombstones.length}`);
    console.log(`  -> 云端 sync_changes 数: ${cloudChanges.length}`);

    if (currentCloudHosts.length === 0) {
      console.log('\n🚨🚨🚨 [第一幕复现成功！P0 级 Bug 现场抓获] 🚨🚨🚨');
      console.log('云端生产主机原本有 2 台，但在本地执行【以云端为准覆盖本地】后，云端主机全部被清空为 0 台！');
      console.log('这就是用户遭遇的致命现象：云端内容被莫名清空，相当于“移动”到了本地！');
    }

    // =========================================================
    // 第二幕：用户发现云端空了，在本地点击【以本地为准 (覆盖云端)】试图恢复
    // =========================================================
    console.log('\n===============================================================');
    console.log('💥 第二幕：模拟用户发现云端空了，点击【以本地覆盖云端】试图挽救...');
    console.log('===============================================================');

    const restoreRes = await requestJson(`http://127.0.0.1:${LOCAL_PORT}/api/v1/desktop/sync/trigger`, {
      method: 'POST',
      body: {
        vpsUrl: `http://127.0.0.1:${CLOUD_PORT}`,
        apiKey: TEST_API_KEY,
        mode: 'local_to_cloud',
        modules: ['connections']
      }
    });

    console.log('  -> 本地点击【以本地覆盖云端】响应:', restoreRes.body);

    console.log('  -> 等待 4 秒观察两端调度与反向拉取...');
    await new Promise(r => setTimeout(r, 4000));

    const finalCloudHosts = await querySql(cloudDb, `SELECT id, uuid, name, host FROM connections`);
    const finalLocalHosts = await querySql(localDb, `SELECT id, uuid, name, host FROM connections`);

    console.log('\n💥 第二幕最终结果:');
    console.log(`  -> 最终本地主机数: ${finalLocalHosts.length} 台`, finalLocalHosts.map(h => h.name));
    console.log(`  -> 最终云端主机数: ${finalCloudHosts.length} 台`, finalCloudHosts.map(h => h.name));

    if (finalLocalHosts.length === 0 && finalCloudHosts.length === 0) {
      console.log('\n💀💀💀 [两端彻底归零！完全重现用户惨剧！] 💀💀💀');
      console.log('用户在本地点击【以本地覆盖云端】后，本地数据也全被抹杀，两端彻底变为空白！');
    }

    cloudDb.close();
    localDb.close();

  } finally {
    console.log('\n正在清理测试进程...');
    if (cloudProc) cloudProc.kill();
    if (localProc) localProc.kill();
  }
}

main().catch(err => {
  console.error('冒烟测试脚本异常退出:', err);
  process.exit(1);
});
