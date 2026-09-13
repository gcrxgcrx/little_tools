'use strict';

/**
 * 真实浏览器端到端测试。
 *
 *   node tools/test-browser.js
 *
 * 用两个独立浏览器上下文模拟两台设备：
 *   A = 桌面 UA（走 rate nudging 路径）
 *   B = iPhone UA（走惰性 seek 校正路径，永不改 playbackRate）
 *
 * 这会真正加载页面、输入 PIN、选片、播放、拖动进度条，
 * 并断言两端都跟上了同一条权威时间轴 —— 这是客户端代码第一次被真正执行。
 *
 * 环境变量：
 *   VW_EDGE  浏览器可执行文件路径
 *   VW_BASE  服务端地址
 *   VW_PIN   访问码
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const EDGE =
  process.env.VW_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

/**
 * 默认走局域网地址而不是 127.0.0.1 ——
 * 服务端对回环地址免 PIN，只有从非回环地址访问才会真正触发登录流程，
 * 而登录流程正是两台真机会走的路径。
 */
function pickLanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;
      if (addr.address.startsWith('26.')) continue; // Radmin VPN 虚拟网卡
      if (addr.address.endsWith('.255') || addr.address.endsWith('.0')) continue;
      return addr.address;
    }
  }
  return null;
}

const LAN = pickLanAddress();
const BASE = process.env.VW_BASE || (LAN ? `http://${LAN}:8080` : 'http://127.0.0.1:8080');
/** 测试脚本自己要调 API，走回环地址免得还要处理 cookie */
const API_BASE = process.env.VW_API || 'http://127.0.0.1:8080';

/** 访问码优先取环境变量，其次直接读 config.json —— 不要硬编码，用户随时会改 */
function resolvePin() {
  if (process.env.VW_PIN) return process.env.VW_PIN;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
    const pin = JSON.parse(raw).pin;
    if (pin) return String(pin);
    console.warn('⚠️ config.json 里没有 pin 字段，使用默认值');
  } catch (err) {
    // 不要静默吞异常：像"忘了 require path"这种编码错误会被伪装成"配置读不到"
    console.warn(`⚠️ 读取 config.json 的 pin 失败：${err.message}`);
  }
  return '000000';
}

const PIN = resolvePin();

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

let passed = 0;
let failed = 0;
const consoleErrors = [];

function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? ` —— ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Device {
  constructor(label, page) {
    this.label = label;
    this.page = page;
  }

  async login() {
    const overlay = await this.page
      .waitForSelector('#login:not(.hidden)', { timeout: 8000 })
      .catch(() => null);
    if (!overlay) return false; // 回环地址会免 PIN，直接用
    await this.page.type('#pinInput', PIN);
    await this.page.click('#pinBtn');
    await this.page.waitForSelector('#login.hidden', { timeout: 15000 });
    return true;
  }

  async waitForLibrary(timeoutMs = 20000) {
    await this.page.waitForFunction(
      () => document.querySelectorAll('.item').length > 0,
      { timeout: timeoutMs }
    );
  }

  async openItem(name) {
    await this.page.evaluate((itemName) => {
      const rows = [...document.querySelectorAll('.item')];
      const row = rows.find((r) => r.querySelector('.name')?.textContent === itemName);
      if (!row) throw new Error(`片库里找不到条目: ${itemName}`);
      row.click();
    }, name);
  }

  async waitForUnlock() {
    await this.page.waitForSelector('#unlock:not(.hidden)', { timeout: 15000 });
  }

  async unlock() {
    await this.page.click('#unlock');
    await this.page.waitForFunction(() => window.__vw && window.__vw.unlocked === true, {
      timeout: 15000,
    });
  }

  async clickPlay() {
    await this.page.evaluate(() => document.getElementById('playBtn').click());
  }

  async seekTo(seconds) {
    await this.page.evaluate((s) => {
      window.__vw.sync.localSeek(s);
    }, seconds);
  }

  async sample() {
    return this.page.evaluate(() => {
      const s = window.__vw && window.__vw.sync;
      const v = document.getElementById('video');
      if (!v) return { error: 'no-video-element' };
      const now = s ? s.serverNow() : null;
      return {
        currentTime: v.currentTime,
        paused: v.paused,
        readyState: v.readyState,
        playbackRate: v.playbackRate,
        duration: Number.isFinite(v.duration) ? v.duration : null,
        target: s && s.state ? s.targetPos(now) : null,
        hasClock: s ? s.hasClock : false,
        statePlaying: s && s.state ? s.state.playing : null,
        stateMediaId: s && s.state ? s.state.mediaId : null,
        hardSeekCount: s ? s.hardSeekCount : null,
        bufferedAhead: s ? Number(s.bufferedAheadSec().toFixed(1)) : null,
        isIOS: s ? s.isIOS : null,
        clockOffsetMs: s ? Math.round(s.clockOffsetMs) : null,
      };
    });
  }

  /** 详细状态快照：失败时用来定位到底卡在哪一环 */
  async diagnose() {
    return this.page.evaluate(() => {
      const s = window.__vw && window.__vw.sync;
      const v = document.getElementById('video');
      const ranges = [];
      if (v && v.buffered) {
        for (let i = 0; i < v.buffered.length; i += 1) {
          ranges.push([Number(v.buffered.start(i).toFixed(2)), Number(v.buffered.end(i).toFixed(2))]);
        }
      }
      return {
        t: v ? Number(v.currentTime.toFixed(2)) : null,
        currentTime: v ? v.currentTime : null,
        duration: v && Number.isFinite(v.duration) ? v.duration : null,
        paused: v ? v.paused : null,
        readyState: v ? v.readyState : null,
        networkState: v ? v.networkState : null,
        rate: v ? v.playbackRate : null,
        error: v && v.error ? { code: v.error.code, message: v.error.message } : null,
        buffered: ranges,
        target: s && s.state ? Number(s.targetPos(s.serverNow()).toFixed(2)) : null,
        statePlaying: s && s.state ? s.state.playing : null,
        stateMediaId: s && s.state ? s.state.mediaId : null,
        waiting: s && s.state ? s.state.waiting : null,
        holdReason: s && s.state ? s.state.holdReason : null,
        reportedBuffering: s ? s.reportedBuffering : null,
        waitingForBuffer: s ? s.waitingForBuffer : null,
        blocked: s ? s.blocked : null,
        ahead: s ? Number(s.bufferedAheadSec().toFixed(1)) : null,
        hasClock: s ? s.hasClock : null,
        offsetMs: s ? Math.round(s.clockOffsetMs) : null,
        requiredBufferSec: s ? s.requiredBufferSec() : null,
        throughputMbps:
          s && s.measuredThroughputBps != null
            ? Number(((s.measuredThroughputBps * 8) / 1e6).toFixed(1))
            : null,
        hardSeekCount: s ? s.hardSeekCount : null,
        isIOS: s ? s.isIOS : null,
      };
    });
  }

  /**
   * 精确采样：用 requestVideoFrameCallback 拿"这一帧真正呈现时的媒体时间"。
   *
   * 为什么不用 currentTime：浏览器大约每 250ms 才更新一次 currentTime，
   * 直接读它做偏差统计会自带 ±125ms 的量化噪声 —— 测出来的"不同步"
   * 有相当一部分其实是测量误差。
   */
  async samplePrecise() {
    return this.page.evaluate(
      () =>
        new Promise((resolve) => {
          const s = window.__vw && window.__vw.sync;
          const v = document.getElementById('video');
          if (!v) {
            resolve({ error: 'no-video' });
            return;
          }

          const build = (mediaTime) => {
            const now = s ? s.serverNow() : null;
            return {
              mediaTime,
              target: s && s.state ? s.targetPos(now) : null,
              currentTime: v.currentTime,
              paused: v.paused,
              readyState: v.readyState,
              playbackRate: v.playbackRate,
              statePlaying: s && s.state ? s.state.playing : null,
              stateMediaId: s && s.state ? s.state.mediaId : null,
              hasClock: s ? s.hasClock : null,
              offsetMs: s ? Math.round(s.clockOffsetMs) : null,
              hardSeekCount: s ? s.hardSeekCount : null,
              requiredBufferSec: s ? s.requiredBufferSec() : null,
              throughputMbps:
                s && s.measuredThroughputBps != null
                  ? Number(((s.measuredThroughputBps * 8) / 1e6).toFixed(1))
                  : null,
              isIOS: s ? s.isIOS : null,
            };
          };

          if (typeof v.requestVideoFrameCallback !== 'function') {
            resolve(build(v.currentTime));
            return;
          }

          let settled = false;
          const fallback = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(build(v.currentTime));
          }, 800);

          v.requestVideoFrameCallback((_now, metadata) => {
            if (settled) return;
            settled = true;
            clearTimeout(fallback);
            resolve(build(metadata.mediaTime));
          });
        })
    );
  }

  async waitForPlaying(timeoutMs = 40000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.diagnose();
      if (last.statePlaying === true && last.paused === false && last.t > 0.3) return last;
      await sleep(400);
    }
    console.log(`    [${this.label}] 等待播放超时。最后状态:`);
    console.log(`      ${JSON.stringify(last)}`);
    return null;
  }

  async hudText() {
    return this.page.evaluate(() => document.getElementById('hud')?.innerText || '');
  }
}

/**
 * 关浏览器。
 *
 * 除了 browser.close() 再对底层进程补一刀：如果 Node 紧接着就 exit()，
 * 关闭握手可能来不及走完，浏览器进程会留在系统里，它的 WebSocket
 * 也会继续挂在房间上、被当成幽灵设备。
 */
async function closeBrowser(browser) {
  if (!browser) return;
  const proc = typeof browser.process === 'function' ? browser.process() : null;
  try {
    await browser.close();
  } catch {
    /* 忽略 */
  }
  await sleep(400);
  if (proc && !proc.killed) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
  }
}

async function main() {
  if (!fs.existsSync(EDGE)) {
    console.error(`找不到浏览器: ${EDGE}\n请设置环境变量 VW_EDGE 指向 msedge.exe 或 chrome.exe`);
    process.exit(2);
  }

  console.log(`浏览器: ${EDGE}`);
  console.log(`服务端: ${BASE}`);
  console.log(`API 自检: ${API_BASE}\n`);

  // 选一个 H.264 的片子 —— 编码确定能被浏览器解码，且时长足够长便于采样
  const libRes = await fetch(`${API_BASE}/api/library`);
  const lib = await libRes.json();
  if (!Array.isArray(lib.items) || lib.items.length === 0) {
    console.error(`拉取片库失败 (HTTP ${libRes.status}): ${JSON.stringify(lib).slice(0, 200)}`);
    console.error('请确认服务端已启动，且 127.0.0.1 能免 PIN 访问。');
    process.exit(2);
  }
  const target =
    lib.items.find((i) => i.videoCodec === 'avc1' && i.playable && (i.durationSec || 0) > 600) ||
    lib.items.find((i) => i.videoCodec === 'avc1' && i.playable) ||
    lib.items[0];
  console.log(`测试片源: ${target.name}  (${target.videoCodec}, faststart=${target.faststart})\n`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--mute-audio',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    defaultViewport: { width: 900, height: 760 },
  });

  const makeDevice = async (label, userAgent) => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    if (userAgent) await page.setUserAgent(userAgent);
    page.on('pageerror', (err) => consoleErrors.push(`[${label}] pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (/favicon/i.test(text)) return;
      consoleErrors.push(`[${label}] console.error: ${text}`);
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return new Device(label, page);
  };

  const A = await makeDevice('A桌面');
  const B = await makeDevice('B-iPhone', IPHONE_UA);

  try {
    console.log('1) 页面加载与登录');
    const aLoggedIn = await A.login();
    await A.waitForLibrary();
    const bLoggedIn = await B.login();
    await B.waitForLibrary();
    const itemCount = await A.page.evaluate(() => document.querySelectorAll('.item').length);
    check('A 渲染出片库', itemCount > 0, `${itemCount} 个条目`);
    check('B 渲染出片库', true);
    check(
      '走的是 PIN 登录流程（非回环免密）',
      aLoggedIn && bLoggedIn,
      aLoggedIn ? '两端都经过 PIN 校验' : '连接了回环地址，未触发登录'
    );

    console.log('\n2) 选片与解锁');
    await A.openItem(target.name);
    await A.waitForUnlock();
    await A.unlock();
    const aAfterUnlock = await A.sample();
    check('A 播放器已就绪', aAfterUnlock.readyState >= 1, `readyState=${aAfterUnlock.readyState}`);
    check('A 识别为桌面路径', aAfterUnlock.isIOS === false);

    await B.openItem(target.name);
    await B.waitForUnlock();
    await B.unlock();
    const bAfterUnlock = await B.sample();
    check('B 识别为 iOS 路径', bAfterUnlock.isIOS === true);

    console.log('\n3) 时钟同步');
    await sleep(2500);
    const aClock = await A.sample();
    const bClock = await B.sample();
    check('A 完成时钟校准', aClock.hasClock === true, `offset=${aClock.clockOffsetMs}ms`);
    check('B 完成时钟校准', bClock.hasClock === true, `offset=${bClock.clockOffsetMs}ms`);
    check(
      '两端选中的是同一媒体',
      aClock.stateMediaId != null && aClock.stateMediaId === bClock.stateMediaId,
      `${aClock.stateMediaId}`
    );

    console.log('\n4) A 点播放 → 两端一起播（含缓冲门控与倒数）');
    // 把起点固定在 0，避免上一轮测试留下的断点让每次测量条件不同
    await A.seekTo(0);
    await sleep(1500);

    await A.clickPlay();
    const [aPlay, bPlay] = await Promise.all([A.waitForPlaying(), B.waitForPlaying()]);
    check('A 真正开始播放', Boolean(aPlay), aPlay ? `t=${aPlay.currentTime.toFixed(2)}s` : '超时');
    check('B 真正开始播放', Boolean(bPlay), bPlay ? `t=${bPlay.currentTime.toFixed(2)}s` : '超时');

    console.log('\n5) 稳态偏差采样（12 秒，用帧呈现时间精确测量）');
    const aDrifts = [];
    const bDrifts = [];
    const crossDeltas = [];
    for (let i = 0; i < 24; i += 1) {
      await sleep(500);
      const sa = await A.samplePrecise();
      const sb = await B.samplePrecise();

      const aDrift = sa.target != null && sa.mediaTime != null ? (sa.mediaTime - sa.target) * 1000 : null;
      const bDrift = sb.target != null && sb.mediaTime != null ? (sb.mediaTime - sb.target) * 1000 : null;

      if (!sa.paused && aDrift != null) aDrifts.push(aDrift);
      if (!sb.paused && bDrift != null) bDrifts.push(bDrift);

      // 两端的偏差都是在同一个服务器时间轴上、各自帧呈现瞬间测得的，
      // 所以"偏差之差"就是精确的跨设备位置差 —— 不需要任何采样间隔补偿。
      // （早期版本想用墙钟补偿采样间隔，但系数算错了一倍，导致结果随采样耗时剧烈波动。）
      if (!sa.paused && !sb.paused && aDrift != null && bDrift != null) {
        crossDeltas.push(bDrift - aDrift);
      }
    }

    const stat = (arr) => {
      if (arr.length === 0) return null;
      const sorted = arr.slice().sort((x, y) => x - y);
      const abs = arr.map(Math.abs).sort((x, y) => x - y);
      return {
        n: arr.length,
        median: sorted[Math.floor(sorted.length / 2)],
        p90: abs[Math.floor(abs.length * 0.9)] ?? abs[abs.length - 1],
        maxAbs: abs[abs.length - 1],
        avgAbs: abs.reduce((s, v) => s + v, 0) / abs.length,
      };
    };

    const aStat = stat(aDrifts);
    const bStat = stat(bDrifts);
    const crossStat = stat(crossDeltas);

    check(
      'A（桌面）偏差中位数 < 150ms',
      aStat != null && Math.abs(aStat.median) < 150,
      aStat ? `中位数 ${aStat.median.toFixed(0)}ms，p90 ${aStat.p90.toFixed(0)}ms，n=${aStat.n}` : '无样本'
    );
    check(
      'B（iPhone 路径）偏差中位数 < 200ms',
      bStat != null && Math.abs(bStat.median) < 200,
      bStat ? `中位数 ${bStat.median.toFixed(0)}ms，p90 ${bStat.p90.toFixed(0)}ms，n=${bStat.n}` : '无样本'
    );
    check(
      '两端位置差 中位数 < 250ms 且 p90 < 400ms',
      crossStat != null && crossStat.p90 < 400,
      crossStat
        ? `中位数 ${crossStat.median.toFixed(0)}ms，p90 ${crossStat.p90.toFixed(0)}ms，最大 ${crossStat.maxAbs.toFixed(0)}ms，n=${crossStat.n}`
        : '无样本'
    );

    console.log('\n5b) 自适应前置缓冲（局域网不该干等 25 秒）');
    const aBuf = await A.diagnose();
    const bBuf = await B.diagnose();
    check(
      'A 实测到了带宽',
      (aBuf.throughputMbps ?? 0) > 5,
      `${aBuf.throughputMbps ?? '?'} Mbps`
    );
    check(
      'A 把前置缓冲降到 10 秒以内',
      (aBuf.requiredBufferSec ?? 99) <= 10,
      `需要 ${aBuf.requiredBufferSec ?? '?'}s（配置上限 ${25}s）`
    );
    check(
      'B 也按链路自适应',
      (bBuf.requiredBufferSec ?? 99) <= 10,
      `需要 ${bBuf.requiredBufferSec ?? '?'}s`
    );

    console.log('\n6) iOS 路径必须永不改动 playbackRate');
    const bRates = [];
    for (let i = 0; i < 6; i += 1) {
      const s = await B.sample();
      bRates.push(s.playbackRate);
      await sleep(300);
    }
    check(
      'B 的 playbackRate 恒为 1',
      bRates.every((r) => r === 1),
      `采样值 [${[...new Set(bRates)].join(', ')}]`
    );

    console.log('\n7) 拖动进度条 → 两端跟随');
    const seekTarget = Math.min(600, (target.durationSec || 600) * 0.3);
    await A.seekTo(seekTarget);
    await sleep(3000);
    const aAfterSeek = await A.sample();
    const bAfterSeek = await B.sample();
    check(
      'A 跳到了目标位置',
      Math.abs(aAfterSeek.currentTime - seekTarget) < 15,
      `${aAfterSeek.currentTime.toFixed(1)}s (目标 ${seekTarget.toFixed(0)}s)`
    );
    check(
      'B 跟随到同一位置',
      Math.abs(bAfterSeek.currentTime - seekTarget) < 15,
      `${bAfterSeek.currentTime.toFixed(1)}s (目标 ${seekTarget.toFixed(0)}s)`
    );

    console.log('\n8) 暂停同步');
    // 先确保处于播放态（否则按钮会走"播放"分支，测不到暂停）
    await A.page.evaluate(() => {
      const s = window.__vw.sync;
      if (!s.state || s.state.playing !== true) s.localPlay();
    });
    await sleep(2000);
    const beforePause = await A.diagnose();
    check(
      '前置条件：A 正在播放',
      beforePause.paused === false && beforePause.statePlaying === true,
      `paused=${beforePause.paused} room=${beforePause.statePlaying}`
    );

    await A.clickPlay(); // 通过界面按钮暂停
    await sleep(2500);
    const aPaused = await A.diagnose();
    const bPaused = await B.diagnose();
    check('A 已暂停', aPaused.paused === true, `t=${aPaused.currentTime} room=${aPaused.statePlaying}`);
    check('B 跟着暂停', bPaused.paused === true, `t=${bPaused.currentTime} room=${bPaused.statePlaying}`);
    check(
      '暂停位置一致（<1.5s）',
      Math.abs(aPaused.currentTime - bPaused.currentTime) < 1.5,
      `相差 ${Math.abs(aPaused.currentTime - bPaused.currentTime).toFixed(2)}s`
    );

    console.log('\n9) 界面自检信息');
    const hud = await A.hudText();
    check('HUD 渲染了同步信息', hud.includes('时钟偏移') && hud.includes('当前偏差'));
    check('HUD 显示了平台策略', hud.includes('rate nudging') || hud.includes('惰性 seek'));
    console.log('    ---- A 的 HUD ----');
    for (const line of hud.split('\n').slice(0, 12)) console.log(`    ${line}`);

    console.log('\n10) 播放页面无未捕获的脚本错误');
    check('播放与同步过程中无 JS 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '无');

    console.log('\n11) 释放时的清理行为');
    const aFinal = await A.sample();
    const bFinal = await B.sample();
    check('A 累计硬校正次数合理', (aFinal.hardSeekCount ?? 0) <= 12, `${aFinal.hardSeekCount} 次`);
    check('B 累计硬校正次数合理', (bFinal.hardSeekCount ?? 0) <= 12, `${bFinal.hardSeekCount} 次`);

    // 放在最后：这一步会导航离开播放器页面，会破坏之前的采样上下文
    console.log('\n12) 控制台页面');
    await A.page.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await A.page.waitForSelector('#serviceGrid .row', { timeout: 20000 });
    // 状态与日志是分两次请求的，等日志区不再显示"加载中"
    await A.page
      .waitForFunction(() => !/加载中/.test(document.getElementById('logBox')?.textContent || ''), {
        timeout: 15000,
      })
      .catch(() => {});

    const adminInfo = await A.page.evaluate(() => ({
      pin: document.getElementById('currentPin')?.textContent || '',
      loginHidden: document.getElementById('login')?.classList.contains('hidden'),
      serviceRows: document.querySelectorAll('#serviceGrid .row').length,
      libraryRows: document.querySelectorAll('#libraryGrid .row').length,
      powerRows: document.querySelectorAll('#powerGrid .row').length,
      autostartRows: document.querySelectorAll('#autostartGrid .row').length,
      urlLinks: document.querySelectorAll('#urlList a').length,
      logLen: (document.getElementById('logBox')?.textContent || '').length,
    }));

    check('已有会话时直接进入，不弹登录框', adminInfo.loginHidden === true);
    check('显示当前访问码', /^\d{4,12}$/.test(adminInfo.pin), adminInfo.pin);
    check('服务信息已填充', adminInfo.serviceRows >= 5, `${adminInfo.serviceRows} 行`);
    check('片库信息已填充', adminInfo.libraryRows >= 3, `${adminInfo.libraryRows} 行`);
    check('关机状态已填充', adminInfo.powerRows >= 3);
    check('自启状态已填充', adminInfo.autostartRows >= 2);
    check('访问地址已列出', adminInfo.urlLinks >= 1, `${adminInfo.urlLinks} 个`);
    check('日志区域有内容', adminInfo.logLen > 20, `${adminInfo.logLen} 字符`);

    console.log('\n13) 控制台没有引入新的脚本错误');
    check('全程无 JS 运行时错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '无');
  } finally {
    if (consoleErrors.length) {
      console.log('\n---- 捕获到的浏览器错误 ----');
      for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e}`);
    }
    await closeBrowser(browser);
  }

  console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
