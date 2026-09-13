'use strict';

/**
 * 一次性诊断：B 断开后，A 到底收到了什么状态。
 *   node tools/diag-disconnect.js
 */

const WebSocket = require('ws');

const BASE = 'http://127.0.0.1:8080';
const WS_URL = 'ws://127.0.0.1:8080/ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const log = [];
  const make = (label) => {
    const ws = new WebSocket(WS_URL);
    const rec = { label, ws, states: [], welcome: null };
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === 'welcome') rec.welcome = msg;
      if (msg.t === 'state') {
        rec.states.push({
          t: Date.now(),
          mediaId: msg.state.mediaId,
          clients: (msg.state.clients || []).map((c) => c.id),
          playing: msg.state.playing,
        });
      }
    });
    return rec;
  };

  const a = make('A');
  const b = make('B');
  await Promise.all([
    new Promise((r) => a.ws.on('open', r)),
    new Promise((r) => b.ws.on('open', r)),
  ]);

  console.log('A id =', a.welcome?.clientId);
  console.log('B id =', b.welcome?.clientId);

  await sleep(400);
  console.log('\n--- 关闭 B 之前，A 收到的状态 ---');
  for (const s of a.states) console.log(`  +${s.t} clients=[${s.clients.join(',')}]`);

  const clearedAt = Date.now();
  a.states = [];
  b.ws.close();

  console.log('\n--- 关闭 B ---');
  for (let i = 0; i < 12; i += 1) {
    await sleep(250);
    if (a.states.length) {
      for (const s of a.states) {
        console.log(`  +${s.t - clearedAt}ms clients=[${s.clients.join(',')}] playing=${s.playing}`);
      }
      a.states = [];
    }
  }

  console.log('\n--- B 的 readyState ---', b.ws.readyState, '(3=CLOSED)');

  // 直接问 HTTP 接口，看服务端认为房间里有几个人
  const state = await fetch(`${BASE}/api/state`).then((r) => r.json());
  console.log('服务端 /api/state 认为在线人数:', (state.clients || []).length,
    (state.clients || []).map((c) => c.id).join(','));

  a.ws.close();
  b.ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
