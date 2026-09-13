'use strict';

/**
 * 同步层集成测试：不开浏览器就能验证权威时间轴、时钟同步、缓冲门控。
 *
 *   node tools/test-sync.js
 *
 * 需要服务端已在 127.0.0.1:8080 运行（回环地址免 PIN）。
 */

const WebSocket = require('ws');

const BASE = process.env.VW_BASE || 'http://127.0.0.1:8080';
const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TestClient {
  constructor(label) {
    this.label = label;
    this.states = [];
    this.pongs = [];
    this.welcome = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.t === 'welcome') this.welcome = msg;
        if (msg.t === 'state') this.states.push({ at: Date.now(), state: msg.state });
        if (msg.t === 'pong') this.pongs.push({ at: Date.now(), ...msg });
      });
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  latest() {
    return this.states.length ? this.states[this.states.length - 1].state : null;
  }

  clear() {
    this.states = [];
  }

  async waitFor(predicate, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const latest = this.latest();
      if (latest && predicate(latest)) return latest;
      await sleep(50);
    }
    return null;
  }

  async waitForWelcome(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.welcome) return this.welcome;
      await sleep(20);
    }
    return null;
  }

  /**
   * 取一次当前服务器时间。
   * 关键：服务端只在状态变化时广播，客户端必须用本地推算来让时间轴继续走，
   * 所以测试也必须按同样的方式推算，否则会得到"没有新广播 = 时间轴没走"的假象。
   */
  async clock(timeoutMs = 3000) {
    this.pongs = [];
    this.send({ t: 'ping', cts: Date.now() });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && this.pongs.length === 0) await sleep(10);
    const pong = this.pongs[0];
    if (!pong) return null;
    const rtt = pong.at - pong.cts;
    return { serverMs: pong.serverMs, offset: pong.serverMs - (pong.cts + rtt / 2), rtt };
  }

  /** 用权威状态 + 当前服务器时间推算此刻的期望播放位置。 */
  static expectedPos(state, serverMs) {
    if (!state.playing) return state.anchorPos;
    const elapsed = (serverMs - state.anchorServerMs) / 1000;
    return elapsed <= 0 ? state.anchorPos : state.anchorPos + elapsed * state.rate;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

async function main() {
  console.log(`目标: ${WS_URL}\n`);

  const library = await fetch(`${BASE}/api/library`).then((r) => r.json());
  if (!library.items || library.items.length === 0) {
    console.error('片库为空，无法测试。');
    process.exit(1);
  }
  const media = library.items[0];
  console.log(`使用片源: ${media.name} (${media.id})`);

  // 先等房间清空：上一次测试或截图留下的连接可能还没被服务端心跳清理掉，
  // 残留会让"房间里有几台设备"这类断言变得不确定。
  const settleDeadline = Date.now() + 30000;
  let waited = 0;
  for (;;) {
    const state = await fetch(`${BASE}/api/state`).then((r) => r.json()).catch(() => null);
    const count = (state && state.clients ? state.clients.length : 0) || 0;
    if (count === 0) break;
    if (Date.now() > settleDeadline) {
      console.log(`（等待 30 秒后房间仍有 ${count} 个连接，继续测试）`);
      break;
    }
    if (waited === 0) console.log(`房间里有 ${count} 个残留连接，等待清理…`);
    waited += 1;
    await sleep(1000);
  }
  console.log('');

  const a = new TestClient('A');
  const b = new TestClient('B');
  await a.connect();
  await b.connect();

  console.log('1) 握手');
  const welcomeA = await a.waitForWelcome();
  const welcomeB = await b.waitForWelcome();
  check('A 收到 welcome', Boolean(welcomeA));
  check('B 收到 welcome', Boolean(welcomeB));
  check('welcome 带服务端时间戳', Number.isFinite(welcomeA?.state?.serverMs));
  await sleep(200);
  // 精确校验"这两个测试客户端都在房间里"，而不是数总数 ——
  // 别的测试或用户自己的浏览器可能留下连接，数总数会让断言变得不稳定。
  const freshPeers = (a.latest()?.clients || []).filter((c) => !c.stale);
  const freshIds = new Set(freshPeers.map((c) => c.id));
  const peerAId = a.welcome?.clientId;
  const peerBId = b.welcome?.clientId;
  check(
    'A 与 B 两个测试客户端都在房间里',
    Boolean(peerAId && peerBId && freshIds.has(peerAId) && freshIds.has(peerBId)),
    `在线 ${freshPeers.length} 台，其中 A=${freshIds.has(peerAId)} B=${freshIds.has(peerBId)}`
  );

  console.log('\n2) 时钟同步（Cristian 算法）');
  for (let i = 0; i < 5; i += 1) {
    a.send({ t: 'ping', cts: Date.now() });
    await sleep(60);
  }
  await sleep(300);
  const rtts = a.pongs.map((p) => p.at - p.cts);
  const offsets = a.pongs.map((p) => p.serverMs - (p.cts + (p.at - p.cts) / 2));
  check('收到 pong', a.pongs.length >= 3, `${a.pongs.length} 个`);
  check(
    '时钟偏移估计稳定（同机应接近 0）',
    offsets.length > 0 && Math.max(...offsets.map(Math.abs)) < 100,
    `offset=${offsets.map((o) => Math.round(o)).join(',')} ms, rtt=${rtts.join(',')} ms`
  );

  console.log('\n3) 权威时间轴：A 选片 → 双方一致');
  a.clear();
  b.clear();
  a.send({ t: 'load', mediaId: media.id });
  const loadedByB = await b.waitFor((s) => s.mediaId === media.id);
  check('B 收到选片状态', Boolean(loadedByB), `mediaId=${loadedByB?.mediaId}`);
  check('初始为暂停', loadedByB?.playing === false);

  console.log('\n4) 播放意图 → 双方同步推进');
  a.clear();
  b.clear();
  a.send({ t: 'intent', action: 'play', pos: 100 });
  const playA = await a.waitFor((s) => s.playing === true);
  const playB = await b.waitFor((s) => s.playing === true);
  check('A 收到播放状态', Boolean(playA), `anchorPos=${playA?.anchorPos}`);
  check('B 收到播放状态', Boolean(playB));
  check('发起者位置被采纳', Math.abs((playA?.anchorPos ?? -1) - 100) < 0.01);

  const t0 = a.latest();
  const c0 = await a.clock();
  const pos0 = TestClient.expectedPos(t0, c0.serverMs);
  await sleep(2000);
  const c1 = await a.clock();
  const pos1 = TestClient.expectedPos(t0, c1.serverMs);
  const wall = (c1.serverMs - c0.serverMs) / 1000;
  check(
    '服务器时间轴以 1x 推进（客户端本地推算）',
    Math.abs(pos1 - pos0 - wall) < 0.35 && wall > 1.5,
    `${pos0.toFixed(2)} → ${pos1.toFixed(2)}，墙钟走 ${wall.toFixed(2)}s`
  );

  console.log('\n5) 缓冲门控：一方缓冲不足 → 全员暂停等待');
  a.clear();
  b.clear();
  b.send({ t: 'buffering', buffering: true });
  const held = await a.waitFor((s) => s.playing === false && s.waiting.length > 0);
  check('B 缓冲时房间暂停', Boolean(held), `holdReason=${held?.holdReason}`);
  check('暂停位置已冻结', held != null && Number.isFinite(held.anchorPos));

  console.log('\n6) 缓冲恢复 → 3-2-1 倒数（锚点设在未来）');
  a.clear();
  b.clear();
  b.send({ t: 'buffering', buffering: false });
  const resumed = await a.waitFor((s) => s.playing === true && s.countingDown === true);
  check('恢复后进入倒数状态', Boolean(resumed), `countdownMs=${Math.round(resumed?.countdownMs || 0)}`);
  check(
    '倒数时长是配置值且不至于拖沓（≤4s）',
    resumed != null && resumed.countdownMs > 0 && resumed.countdownMs <= 4000,
    `${Math.round(resumed?.countdownMs || 0)} ms`
  );

  // 倒数结束后服务端不会再广播（状态没变），客户端靠本地推算跨过锚点。
  // 所以这里必须用"权威状态 + 新鲜服务器时间"来判断，而不是等新消息。
  const anchorState = a.latest();
  const c2 = await a.clock();
  check(
    '倒数进行中（锚点在未来）',
    c2 != null && c2.serverMs < anchorState.anchorServerMs,
    `还需 ${Math.round((anchorState.anchorServerMs - c2.serverMs) / 1000)}s`
  );

  // 倒数占掉 3.2 秒，所以要多等一会儿才看得出推进
  await sleep(4500);
  const c3 = await a.clock();
  const advance = TestClient.expectedPos(anchorState, c3.serverMs) - anchorState.anchorPos;
  const expectedAdvance = Math.max(0, (c3.serverMs - anchorState.anchorServerMs) / 1000);
  check(
    '倒数结束后时间轴开始推进',
    c3 != null && advance > 0.8 && Math.abs(advance - expectedAdvance) < 0.01,
    `倒数结束后推进 ${advance.toFixed(2)}s（位置 ${anchorState.anchorPos.toFixed(2)} → ${(anchorState.anchorPos + advance).toFixed(2)}）`
  );

  console.log('\n7) 暂停与跳转');
  a.clear();
  b.clear();
  b.send({ t: 'intent', action: 'seek', pos: 500 });
  const seeked = await a.waitFor((s) => Math.abs(s.anchorPos - 500) < 0.01);
  check('B 的跳转被 A 接收', Boolean(seeked), `anchorPos=${seeked?.anchorPos}`);

  a.clear();
  b.clear();
  b.send({ t: 'intent', action: 'pause', pos: 505 });
  const paused = await a.waitFor((s) => s.playing === false && Math.abs(s.anchorPos - 505) < 0.01);
  check('B 的暂停被 A 接收', Boolean(paused), `anchorPos=${paused?.anchorPos}`);

  console.log('\n8) 连播：播完自动接同目录的下一个');
  const ep1 = library.items[0];
  const ep2 = library.items[1];
  check('测试样本同目录', ep1.dir === ep2.dir, `${ep1.name} → ${ep2.name}`);

  a.clear();
  b.clear();
  a.send({ t: 'load', mediaId: ep1.id });
  await b.waitFor((s) => s.mediaId === ep1.id);

  a.send({ t: 'ended' });
  b.send({ t: 'ended' }); // 模拟两台设备几乎同时上报"播完了"
  const advanced = await b.waitFor((s) => s.mediaId === ep2.id, 3000);
  check('自动切到下一个视频', Boolean(advanced), `${ep1.name} → ${advanced ? ep2.name : '(未切换)'}`);
  check(
    '切换后带倒数自动开始',
    Boolean(advanced) && advanced.playing === true && advanced.countingDown === true,
    `countdownMs=${Math.round(advanced?.countdownMs || 0)}`
  );
  await sleep(600);
  check(
    '两台设备同时报结束只跳一集',
    a.latest()?.mediaId === ep2.id,
    `当前 ${a.latest()?.mediaId}`
  );

  console.log('\n9) 连播信息随状态下发');
  a.clear();
  a.send({ t: 'load', mediaId: ep1.id });
  const withNext = await a.waitFor((s) => s.mediaId === ep1.id && s.nextUp);
  check('播放有下一集的视频时状态含 nextUp', Boolean(withNext), withNext?.nextUp?.name || '无');
  check('状态含 autoPlayNext 标志', withNext?.autoPlayNext === true);

  console.log('\n10) 断点记忆：看一段后重新打开');
  a.clear();
  b.clear();
  a.send({ t: 'load', mediaId: ep1.id });
  await a.waitFor((s) => s.mediaId === ep1.id);
  const fresh = a.latest();
  check('没有断点的片源从 0 开始', fresh?.resumeFrom == null, `resumeFrom=${fresh?.resumeFrom}`);

  a.send({ t: 'intent', action: 'play', pos: 120 });
  // 服务端的维护任务每 10 秒记录一次进度
  await sleep(12000);
  a.send({ t: 'intent', action: 'pause', pos: 160 });
  await sleep(600);

  a.clear();
  a.send({ t: 'load', mediaId: ep1.id });
  const resumeState = await a.waitFor((s) => s.mediaId === ep1.id && s.resumeFrom != null, 5000);
  check(
    '重新打开时带出断点',
    Boolean(resumeState),
    resumeState
      ? `从 ${Math.round(resumeState.resumeFrom)}s 续播（断点记录在 ${Math.round(resumeState.resumeSavedPosition)}s）`
      : '没有带出断点'
  );
  check(
    '续播位置比断点提前了几秒',
    resumeState != null && resumeState.resumeFrom < resumeState.resumeSavedPosition,
    resumeState ? `提前 ${(resumeState.resumeSavedPosition - resumeState.resumeFrom).toFixed(1)}s` : '无'
  );
  check(
    '断点位置确实记住了播放进度',
    resumeState != null && resumeState.resumeFrom > 100,
    resumeState ? `${Math.round(resumeState.resumeFrom)}s` : '无'
  );

  console.log('\n11) 断线：该客户端从房间移除');
  const bId = welcomeB?.clientId;
  b.close();
  const gone = await a.waitFor((s) => !(s.clients || []).some((c) => c.id === bId), 4000);
  check('B 断开后从房间移除', Boolean(gone), `剩余 ${gone?.clients?.length} 台`);

  a.close();
  await sleep(900); // 让关闭帧真正发出去，避免在服务端留下幽灵连接影响下次运行
  console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
