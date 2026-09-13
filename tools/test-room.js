'use strict';

/**
 * Room 状态机单元测试：不启动服务器，直接测纯逻辑。
 *
 *   node tools/test-room.js
 *
 * 重点是"失联客户端不得按住整个房间"这条 ——
 * 跨洋链路上手机掉线往往不是干净断开，如果它恰好处于缓冲中，
 * 会把所有人永久卡在"等待缓冲"。
 */

const { Room, CLIENT_STALE_MS, BUFFERING_RESUME_DELAY_MS } = require('../src/sync');

let passed = 0;
let failed = 0;

function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? ` —— ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

function makeClient(id) {
  return {
    id,
    ws: null,
    name: `设备-${id}`,
    isIOS: false,
    buffering: false,
    lastPos: null,
    lastReportMs: null,
    rttMs: null,
    lastSeenMs: Date.now(),
  };
}

function newRoom() {
  const events = [];
  const room = new Room({ onChange: (state, meta) => events.push({ state, meta }) });
  return { room, events };
}

console.log('1) 活着且缓冲中 → 按住房间');
{
  const { room } = newRoom();
  const a = makeClient('a');
  const b = makeClient('b');
  room.addClient(a);
  room.addClient(b);

  room.setBuffering('b', true);
  check('等待集合含 b', room.waitingClients.length === 1 && room.waitingClients[0] === 'b');

  room.applyIntent('a', 'play', 0);
  check('播放意图被按住', room.playing === false && Boolean(room.holdReason), room.holdReason || '');
}

console.log('\n2) 客户端失联（跨洋掉线）→ 不得再按住房间');
{
  const { room } = newRoom();
  const a = makeClient('a');
  const b = makeClient('b');
  room.addClient(a);
  room.addClient(b);

  room.setBuffering('b', true);
  b.lastSeenMs = Date.now() - CLIENT_STALE_MS - 1000; // 模拟 12 秒以上没有任何消息

  check('失联者被排除出等待集合', room.waitingClients.length === 0);
  check('快照里标记为 stale', room.snapshot().clients.find((c) => c.id === 'b').stale === true);

  room.applyIntent('a', 'play', 0);
  check('失联者存在时仍能正常播放', room.playing === true, `holdReason=${room.holdReason || '无'}`);
}

console.log('\n3) 失联者恢复 → 重新参与');
{
  const { room } = newRoom();
  const a = makeClient('a');
  const b = makeClient('b');
  room.addClient(a);
  room.addClient(b);

  b.lastSeenMs = Date.now() - CLIENT_STALE_MS - 1000;
  room.applyIntent('a', 'play', 0);
  check('先能正常播放', room.playing === true);

  room.touch('b'); // iOS 从后台回来，发了一条消息
  check('touch 后不再标记 stale', room.snapshot().clients.find((c) => c.id === 'b').stale === false);

  room.setBuffering('b', true);
  check('恢复后又会计入等待集合', room.waitingClients.length === 1);
  check('并重新按住房间', room.playing === false, room.holdReason || '');
}

console.log('\n4) 全部就绪 → 倒数后自动恢复');
{
  const { room } = newRoom();
  const a = makeClient('a');
  const b = makeClient('b');
  room.addClient(a);
  room.addClient(b);

  room.applyIntent('a', 'play', 10);
  room.setBuffering('b', true);
  const frozenAt = room.anchorPos;

  room.setBuffering('b', false);
  check('恢复后进入倒数', room.playing === true && room.isCountingDown());
  const remaining = room.anchorServerMs - room.now();
  check(
    `倒数时长约 ${BUFFERING_RESUME_DELAY_MS}ms`,
    Math.abs(remaining - BUFFERING_RESUME_DELAY_MS) < 200,
    `${Math.round(remaining)}ms`
  );
  check('暂停位置被保留', Math.abs(frozenAt - room.anchorPos) < 0.01, `pos=${room.anchorPos}`);
}

console.log('\n5) 权威时间轴不变式');
{
  const { room } = newRoom();
  const a = makeClient('a');
  room.addClient(a);

  room.setMedia('m1', 100);
  check('初始为暂停在 0', room.playing === false && room.anchorPos === 0);

  room.applyIntent('a', 'play', 30);
  const t0 = room.now();
  const p0 = room.targetPos(t0);
  check('播放后位置就是意图位置', Math.abs(p0 - 30) < 0.01, `${p0.toFixed(2)}`);

  const p1 = room.targetPos(t0 + 5000);
  check('5 秒后推进 5 秒', Math.abs(p1 - p0 - 5) < 0.01, `${p0.toFixed(2)} → ${p1.toFixed(2)}`);

  room.applyIntent('a', 'pause', p1);
  check('暂停后位置冻结', Math.abs(room.targetPos(Date.now() + 10000) - p1) < 0.01);
}

console.log('\n6) 最后一人离开 → 房间冻结');
{
  const { room } = newRoom();
  const a = makeClient('a');
  room.addClient(a);
  room.setMedia('m1', 100);
  room.applyIntent('a', 'play', 5);

  room.removeClient('a');
  check('无人时自动暂停', room.playing === false);
  check('位置被冻结在离开那一刻', room.anchorPos >= 5);
  check('等待集合清空', room.waitingClients.length === 0);
}

console.log('\n7) 连播切集：带倒数自动开始');
{
  const { room } = newRoom();
  const a = makeClient('a');
  room.addClient(a);

  room.setMedia('m1', 100);
  room.applyIntent('a', 'play', 90);
  room.setMedia('m2', 200, { autoStart: true, countdownMs: 6000 });

  check('切集后位置归零', room.anchorPos === 0);
  check('切集后处于播放态', room.playing === true);
  check('切集后先倒数', room.isCountingDown(), `${Math.round(room.anchorServerMs - room.now())}ms`);
  check('倒数期间位置不推进', room.targetPos(room.now()) === 0);
  check('倒数结束后开始推进', room.targetPos(room.anchorServerMs + 3000) > 2.9);
}

console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
