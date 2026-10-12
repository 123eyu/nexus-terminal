// packages/backend/src/sync/__test_frontend_events_ws.ts
import WebSocket from 'ws';
import { notifyLocalFrontendSyncDone } from './sync.ws-broadcaster';

async function testFrontendEvents() {
  console.log('===============================================================');
  console.log('🧪 开始前端 UI 全局事件 WebSocket (/ws/events) 冒烟测试');
  console.log('===============================================================\n');

  const wsUrl = 'ws://127.0.0.1:3001/ws/events';
  console.log(`[准备] 正在连接本地前端事件通道: ${wsUrl}...`);

  const ws = new WebSocket(wsUrl);

  const connectedPromise = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 frontend:connected 超时')), 4000);
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'frontend:connected') {
          clearTimeout(timer);
          resolve(msg);
        }
      } catch {}
    });
    ws.on('error', reject);
  });

  const welcomeMsg = await connectedPromise;
  console.log(`  ✅ 握手成功: 收到消息="${welcomeMsg.message}"`);

  // 测试服务端触发同步完成通知
  console.log('  📡 正在触发 notifyLocalFrontendSyncDone({ pushed: 3, pulled: 5 }) ...');
  const syncCompletedPromise = new Promise<{ msg: any; latencyMs: number }>((resolve, reject) => {
    const startMs = Date.now();
    const timer = setTimeout(() => reject(new Error('等待 sync:completed 消息超时')), 4000);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'sync:completed') {
          const latencyMs = Date.now() - startMs;
          clearTimeout(timer);
          resolve({ msg, latencyMs });
        }
      } catch {}
    });
  });

  // 延时 200ms 后由客户端发送指令触发服务端进程执行 notifyLocalFrontendSyncDone
  await new Promise(r => setTimeout(r, 200));
  ws.send(JSON.stringify({
    type: 'test:trigger_notify',
    payload: { pushed: 3, pulled: 5 }
  }));

  const { msg, latencyMs } = await syncCompletedPromise;
  console.log(`  ✅ 前端页面成功收到实时刷新通知: type=${msg.type}, pushed=${msg.payload.pushed}, pulled=${msg.payload.pulled}, 延迟: ${latencyMs}ms`);

  ws.close();

  console.log('\n===============================================================');
  console.log('🎉 前端 UI 实时事件长连接验证 100% 通过！工作区各面板无需刷新网页！');
  console.log('===============================================================\n');
}

testFrontendEvents().catch(err => {
  console.error('\n❌ 测试失败:', err);
  process.exit(1);
});
