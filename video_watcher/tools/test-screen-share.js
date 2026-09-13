'use strict';

/**
 * 屏幕共享的端到端测试。
 *
 *   node tools/test-screen-share.js
 *
 * 用两个独立的浏览器上下文模拟"共享者"和"观看者"，
 * 共享端注入一个 canvas 动画流（而不是真的采集屏幕 —— 无头环境没有屏幕可采），
 * 从而把整条链路都跑通：信令转发 → WebRTC 建连 → 观看端真的收到画面。
 *
 * 唯一没被覆盖的只有"点系统弹窗选屏幕"那一步，那是浏览器行为、不是我们的代码。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const EDGE =
  process.env.VW_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function pickLanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.') || addr.address.startsWith('26.')) continue;
      if (addr.address.endsWith('.255') || addr.address.endsWith('.0')) continue;
      return addr.address;
    }
  }
  return null;
}

const LAN = pickLanAddress();
const BASE = process.env.VW_BASE || (LAN ? `http://${LAN}:8080` : 'http://127.0.0.1:8080');

function resolvePin() {
  if (process.env.VW_PIN) return process.env.VW_PIN;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
    const pin = JSON.parse(raw).pin;
    if (pin) return String(pin);
    console.warn('⚠️ config.json 里没有 pin 字段，使用默认值');
  } catch (err) {
    console.warn(`⚠️ 读取 config.json 的 pin 失败：${err.message}`);
  }
  return '000000';
}

const PIN = resolvePin();

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function login(page) {
  const overlay = await page
    .waitForSelector('#login:not(.hidden)', { timeout: 10000 })
    .catch(() => null);
  if (!overlay) return;
  await page.type('#pinInput', PIN);
  await page.click('#pinBtn');
  await page.waitForSelector('#login.hidden', { timeout: 15000 });
}

async function info(page) {
  return page.evaluate(() => window.__vw.shareInfo);
}

async function main() {
  if (!fs.existsSync(EDGE)) {
    console.error(`找不到浏览器: ${EDGE}`);
    process.exit(2);
  }

  console.log(`浏览器: ${EDGE}`);
  console.log(`服务端: ${BASE}\n`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });

  const makeDevice = async (label) => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.on('pageerror', (err) => consoleErrors.push(`[${label}] ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/favicon/i.test(msg.text())) {
        consoleErrors.push(`[${label}] console: ${msg.text()}`);
      }
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await login(page);
    await page.waitForSelector('.item', { timeout: 20000 });
    await page.waitForFunction(() => window.__vw && window.__vw.shareInfo, { timeout: 15000 });
    return page;
  };

  try {
    console.log('1) 两端进入房间');
    const presenter = await makeDevice('共享端');
    const viewer = await makeDevice('观看端');
    await sleep(1200);

    const pInfo = await info(presenter);
    const vInfo = await info(viewer);
    check('两端都拿到了自己的客户端 id', Boolean(pInfo.myClientId && vInfo.myClientId),
      `${pInfo.myClientId} / ${vInfo.myClientId}`);
    check('两端都能接收 WebRTC', pInfo.canReceive && vInfo.canReceive);
    console.log(`    （网络来源下能否采集屏幕：${pInfo.canCapture ? '可以' : '不可以 —— 需要 https 或 127.0.0.1'}）`);

    console.log('\n2) 共享端开始共享（注入 canvas 流代替真实屏幕采集）');
    await presenter.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      let n = 0;
      setInterval(() => {
        n += 1;
        ctx.fillStyle = `hsl(${(n * 7) % 360} 70% 55%)`;
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 48px sans-serif';
        ctx.fillText(`frame ${n}`, 40, 200);
      }, 100);

      const stream = canvas.captureStream(10);
      window.__vw.startShareWithStream(stream);
    });

    await sleep(1500);
    const sharingState = await presenter.evaluate(() => window.__vw.sync.state);
    check('房间状态标记为正在共享', sharingState?.sharing?.active === true,
      `presenter=${sharingState?.sharing?.presenterName}`);

    console.log('\n3) 观看端收到画面');
    const received = await viewer
      .waitForFunction(() => window.__vw.shareInfo.remoteWidth > 0, { timeout: 25000 })
      .then(() => true)
      .catch(() => false);
    const vAfter = await info(viewer);
    check('观看端建立了对共享端的连接', vAfter.watching === true, `peers=${vAfter.peers}`);
    check(
      '观看端真的收到了视频画面',
      received && vAfter.remoteWidth > 0,
      `${vAfter.remoteWidth}x${vAfter.remoteHeight}`
    );

    // 刚建连时带宽估计还在爬升，分辨率会被临时压低（默认策略是保帧率，
    // 也就是宁可先糊一点也要跟住帧率）。这里只要求"确实收到有效画面"，
    // 稳态表现由第 9 节在等待带宽爬升之后测量。
    check(
      '收到有效分辨率（WebRTC 会按带宽自适应）',
      vAfter.remoteWidth > 0,
      `${vAfter.remoteWidth}x${vAfter.remoteHeight}（源 640x360）`
    );

    console.log('\n4) 画面在动（确认不是一帧静态图）');
    const hash1 = await viewer.evaluate(() => {
      const v = document.getElementById('shareVideo');
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 18;
      c.getContext('2d').drawImage(v, 0, 0, 32, 18);
      return c.toDataURL().slice(-40);
    });
    await sleep(1200);
    const hash2 = await viewer.evaluate(() => {
      const v = document.getElementById('shareVideo');
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 18;
      c.getContext('2d').drawImage(v, 0, 0, 32, 18);
      return c.toDataURL().slice(-40);
    });
    check('画面持续更新', hash1 !== hash2, `${hash1.slice(0, 12)} → ${hash2.slice(0, 12)}`);

    console.log('\n5) 第三个设备加入时也能自动接上');
    const third = await makeDevice('第三端');
    await sleep(2500);
    const thirdOk = await third
      .waitForFunction(() => window.__vw.shareInfo.remoteWidth > 0, { timeout: 25000 })
      .then(() => true)
      .catch(() => false);
    const pWithThree = await info(presenter);
    check('共享端为第三个设备也建了连接', pWithThree.peers >= 2, `peers=${pWithThree.peers}`);
    check('第三个设备也收到了画面', thirdOk, JSON.stringify((await info(third)).remoteWidth));

    console.log('\n6) 结束共享');
    await presenter.evaluate(() => window.__vw.stopShare());
    await sleep(2000);
    const stateAfter = await presenter.evaluate(() => window.__vw.sync.state);
    check('房间状态不再显示共享', stateAfter?.sharing?.active === false);
    const vEnded = await info(viewer);
    check('观看端已断开', vEnded.watching === false || vEnded.remoteWidth === 0, `watching=${vEnded.watching}`);

    console.log('\n7) 共享端断开时自动收尾');
    await presenter.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d');
      setInterval(() => ctx.fillRect(0, 0, 320, 180), 100);
      window.__vw.startShareWithStream(canvas.captureStream(5));
    });
    await sleep(1500);
    await presenter.close();
    await sleep(2500);
    const stateAfterLeave = await viewer.evaluate(() => window.__vw.sync.state);
    check('共享者离开后共享状态被清掉', stateAfterLeave?.sharing?.active === false,
      `presenter=${stateAfterLeave?.sharing?.presenterId}`);

    console.log('\n8) 真实拓扑：电脑(127.0.0.1) 共享 → 手机(局域网IP) 观看');
    // 这就是实际用法：采集必须在安全上下文（电脑上用 localhost 打开），
    // 而手机走的是局域网 IP —— 两个页面不同源，全靠服务端中转信令。
    const LOOPBACK = 'http://127.0.0.1:8080';

    const pcSide = await browser.createBrowserContext().then((c) => c.newPage());
    pcSide.on('pageerror', (err) => consoleErrors.push(`[电脑] ${err.message}`));
    await pcSide.goto(LOOPBACK, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pcSide.waitForFunction(() => window.__vw && window.__vw.shareInfo, { timeout: 15000 });
    const pcCaps = await info(pcSide);
    check('电脑端(localhost)可以采集屏幕', pcCaps.canCapture === true);

    // 手机上刻意**不选任何视频**，停在片库页 —— 验证"没选片也能看到共享提示"
    const phoneSide = await makeDevice('手机');
    const barBefore = await phoneSide.evaluate(() => {
      const bar = document.getElementById('shareBar');
      const playerHidden = document.getElementById('playerView').classList.contains('hidden');
      return { hidden: bar.classList.contains('hidden'), onLibrary: playerHidden };
    });
    check('手机此刻停在片库页（没选片）', barBefore.onLibrary === true);
    check('还没人共享时提示条是隐藏的', barBefore.hidden === true);

    await pcSide.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 450;
      const ctx = canvas.getContext('2d');
      let n = 0;
      setInterval(() => {
        n += 1;
        ctx.fillStyle = `hsl(${(n * 5) % 360} 60% 45%)`;
        ctx.fillRect(0, 0, 800, 450);
      }, 100);
      window.__vw.startShareWithStream(canvas.captureStream(10));
    });

    await sleep(2000);
    const barAfter = await phoneSide.evaluate(() => {
      const bar = document.getElementById('shareBar');
      const watch = document.getElementById('shareWatchBtn');
      return {
        hidden: bar.classList.contains('hidden'),
        text: document.getElementById('shareText').textContent,
        watchVisible: !watch.classList.contains('hidden'),
        onLibrary: document.getElementById('playerView').classList.contains('hidden'),
      };
    });
    check('手机在片库页就看到了共享提示', barAfter.hidden === false && barAfter.onLibrary === true,
      `"${barAfter.text}"`);
    check('提示条上有「观看」按钮', barAfter.watchVisible === true);

    const phoneGot = await phoneSide
      .waitForFunction(() => window.__vw.shareInfo.remoteWidth > 0, { timeout: 25000 })
      .then(() => true)
      .catch(() => false);
    const phoneInfo = await info(phoneSide);
    check(
      '手机收到电脑共享的画面（跨源 P2P 打通）',
      phoneGot && phoneInfo.remoteWidth > 0,
      `${phoneInfo.remoteWidth}x${phoneInfo.remoteHeight}`
    );

    // 点开观看后应该能真的渲染出来
    await phoneSide.evaluate(() => document.getElementById('shareWatchBtn').click());
    await sleep(800);
    const stage = await phoneSide.evaluate(() => {
      const v = document.getElementById('shareVideo');
      return {
        open: !document.getElementById('shareStage').classList.contains('hidden'),
        width: v.videoWidth,
        paused: v.paused,
      };
    });
    check('点「观看」后画面层打开且正在播放', stage.open && stage.width > 0 && stage.paused === false,
      `${stage.width}px, paused=${stage.paused}`);

    await pcSide.evaluate(() => window.__vw.stopShare());
    await sleep(1200);

    console.log('\n9) 60 帧链路：采集 → 编码 → 接收端实际帧率');
    // 注入一个真的按 60fps 变化的源，然后数接收端实际拿到多少帧
    await pcSide.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext('2d');
      let n = 0;
      // 用 requestAnimationFrame 驱动，尽量接近 60fps
      const draw = () => {
        n += 1;
        ctx.fillStyle = `hsl(${(n * 3) % 360} 70% 50%)`;
        ctx.fillRect(0, 0, 1280, 720);
        requestAnimationFrame(draw);
      };
      draw();
      window.__vw.startShareWithStream(canvas.captureStream(60));
    });
    await sleep(2500);

    const senders = await pcSide.evaluate(() => window.__vw.describeShareSenders());
    const sender = senders[0] || {};
    check(
      '发送端声明的帧率上限是 60',
      sender.maxFramerate === 60,
      `maxFramerate=${sender.maxFramerate}, maxBitrate=${sender.maxBitrate}`
    );
    check(
      '发送端声明了码率上限',
      Number.isFinite(sender.maxBitrate) && sender.maxBitrate >= 4_000_000,
      `${Math.round((sender.maxBitrate || 0) / 1e6)} Mbps`
    );
    check('默认策略是保帧率（游戏/视频优先流畅）',
      sender.degradationPreference === 'maintain-framerate',
      String(sender.degradationPreference));

    await phoneSide
      .waitForFunction(() => window.__vw.shareInfo.remoteWidth > 0, { timeout: 25000 })
      .catch(() => {});

    // 等带宽估计爬上来再看稳态 —— 刚建连时编码器从很低的码率起步，
    // 这时候测出来的分辨率会偏低，不代表稳态表现
    console.log('    （等待 8 秒让带宽估计爬升，再看稳态）');
    await sleep(8000);

    const steady = await info(phoneSide);
    const measuredFps = await phoneSide.evaluate(
      () =>
        new Promise((resolve) => {
          const v = document.getElementById('shareVideo');
          if (!v || typeof v.requestVideoFrameCallback !== 'function') return resolve(0);
          let frames = 0;
          const started = performance.now();
          const tick = () => {
            frames += 1;
            const elapsed = performance.now() - started;
            if (elapsed < 3000) v.requestVideoFrameCallback(tick);
            else resolve(Math.round((frames / elapsed) * 1000));
          };
          v.requestVideoFrameCallback(tick);
        })
    );

    const srcWidth = 1280;
    const keepRatio = steady.remoteWidth / srcWidth;
    console.log(
      `    稳态：${steady.remoteWidth}x${steady.remoteHeight}（源的 ${Math.round(keepRatio * 100)}%）、${measuredFps} fps`
    );

    check(
      '分辨率没有被砍到看不清（≥ 源的 70%）',
      keepRatio >= 0.7,
      `${steady.remoteWidth}x${steady.remoteHeight}（源 ${srcWidth}x720）`
    );
    check('接收端帧率高于 30', measuredFps > 30, `实测 ${measuredFps} fps`);

    console.log('\n9b) 画质预设与实时链路指标');

    const presetBefore = await pcSide.evaluate(() => window.__vw.describeShareSenders());
    check(
      '默认使用保帧率策略（适合游戏/视频）',
      presetBefore[0]?.degradationPreference === 'maintain-framerate',
      String(presetBefore[0]?.degradationPreference)
    );

    await pcSide.evaluate(() => window.__vw.applySharePreset('smooth'));
    await sleep(700);
    const smooth = await pcSide.evaluate(() => window.__vw.describeShareSenders());
    check(
      '「流畅」预设主动降分辨率换帧率',
      smooth[0]?.scaleResolutionDownBy > 1,
      `scaleResolutionDownBy=${smooth[0]?.scaleResolutionDownBy}`
    );
    check('「流畅」仍是保帧率', smooth[0]?.degradationPreference === 'maintain-framerate');

    await pcSide.evaluate(() => window.__vw.applySharePreset('sharp'));
    await sleep(700);
    const sharp = await pcSide.evaluate(() => window.__vw.describeShareSenders());
    check(
      '「清晰」预设改为保分辨率（适合文档/代码）',
      sharp[0]?.degradationPreference === 'maintain-resolution',
      String(sharp[0]?.degradationPreference)
    );

    await pcSide.evaluate(() => window.__vw.applySharePreset('balanced'));
    await sleep(2500);

    // 第一次调用就能算码率（基线从共享开始累计），但仍再采一次以便观察稳定性
    await pcSide.evaluate(() => window.__vw.collectShareStats());
    await sleep(1200);
    const stats = await pcSide.evaluate(() => window.__vw.collectShareStats());
    check('共享端能采到实时链路指标', Boolean(stats && stats.presenter));
    check('指标含发送帧率', Number.isFinite(stats?.presenter?.fps), `${stats?.presenter?.fps} fps`);
    check(
      '指标含实时码率',
      Number.isFinite(stats?.presenter?.bitrateMbps),
      `${stats?.presenter?.bitrateMbps?.toFixed?.(2)} Mbps`
    );
    check(
      '指标含「受限原因」——用于判断卡顿是网络还是本机',
      typeof stats?.presenter?.limitation === 'string',
      `limitation=${stats?.presenter?.limitation}（${stats?.presenter?.limitationText}）`
    );

    const viewerStats = await phoneSide.evaluate(() => window.__vw.collectShareStats());
    check('观看端能采到接收侧指标', Boolean(viewerStats && viewerStats.viewer), JSON.stringify(viewerStats?.viewer));

    console.log('\n10) 共享画面层有全屏入口');
    const fsInfo = await phoneSide.evaluate(() => ({
      hasButton: Boolean(document.getElementById('shareStageFs')),
      label: document.getElementById('shareStageFs')?.textContent || '',
    }));
    check('存在全屏按钮', fsInfo.hasButton && fsInfo.label.includes('全屏'), fsInfo.label);

    const fsWorked = await phoneSide
      .evaluate(async () => {
        document.getElementById('shareStageFs').click();
        await new Promise((r) => setTimeout(r, 600));
        return Boolean(document.fullscreenElement) || Boolean(document.webkitFullscreenElement);
      })
      .catch(() => false);
    console.log(`    （无头环境下全屏是否真的生效：${fsWorked ? '是' : '否，需真机确认'}）`);

    await pcSide.evaluate(() => window.__vw.stopShare());
    await sleep(800);

    console.log('\n11) 共享声音');
    // 无头环境没有系统声音可采，用 WebAudio 生成一条真实的音频轨注入
    await pcSide.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      let n = 0;
      const draw = () => {
        n += 1;
        ctx.fillStyle = `hsl(${(n * 9) % 360} 70% 50%)`;
        ctx.fillRect(0, 0, 640, 360);
        requestAnimationFrame(draw);
      };
      draw();

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ac = new AudioCtx();
      if (ac.state === 'suspended') await ac.resume();
      const osc = ac.createOscillator();
      osc.frequency.value = 440;
      const dest = ac.createMediaStreamDestination();
      const gain = ac.createGain();
      gain.gain.value = 0.05; // 小音量，免得测试环境里刺耳
      osc.connect(gain).connect(dest);
      osc.start();

      const stream = new MediaStream([
        ...canvas.captureStream(30).getVideoTracks(),
        ...dest.stream.getAudioTracks(),
      ]);
      window.__vw.startShareWithStream(stream);
    });

    await sleep(2000);
    const pAudio = await info(pcSide);
    check('共享端确实采到了音频轨', pAudio.localHasAudio === true);
    check('共享端自己的预览保持静音（避免啸叫）', pAudio.muted === true);

    const phoneAudio = await phoneSide
      .waitForFunction(() => window.__vw.shareInfo.remoteHasAudio === true, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    const vAudio = await info(phoneSide);
    check('观看端收到了音频轨', phoneAudio && vAudio.remoteHasAudio === true);
    check('观看端默认静音（浏览器不允许无操作带声播放）', vAudio.muted === true, `muted=${vAudio.muted}`);
    check(
      '出现「开启声音」提示按钮',
      vAudio.soundButtonVisible === true,
      vAudio.soundButtonLabel
    );

    // 点「观看」是一个真实手势，应该能在这个手势里解除静音
    await phoneSide.evaluate(() => {
      document.getElementById('shareStage').classList.add('hidden');
      document.getElementById('shareWatchBtn').click();
    });
    await sleep(900);
    const afterUnmute = await info(phoneSide);
    check(
      '点「观看」后声音打开（手势内解除静音）',
      afterUnmute.muted === false,
      `muted=${afterUnmute.muted}`
    );
    check('按钮文字变成「静音」', afterUnmute.soundButtonLabel === '静音', afterUnmute.soundButtonLabel);

    // 声音条要真的在跑（音频轨处于活跃状态）
    const audioLive = await phoneSide.evaluate(() => {
      const s = document.getElementById('shareVideo').srcObject;
      if (!s) return false;
      const tracks = s.getAudioTracks();
      return tracks.length > 0 && tracks.some((t) => t.readyState === 'live' && !t.muted);
    });
    check('音频轨处于活跃状态', audioLive === true);

    await phoneSide.evaluate(() => document.getElementById('shareSoundBtn').click());
    await sleep(500);
    const afterMute = await info(phoneSide);
    check('再次点击可以静音', afterMute.muted === true, `muted=${afterMute.muted}`);

    await pcSide.evaluate(() => window.__vw.stopShare());
    await sleep(800);

    console.log('\n12) 没有未捕获的脚本错误');
    check('全程无 JS 运行时错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '无');
  } finally {
    if (consoleErrors.length) {
      console.log('\n---- 捕获到的浏览器错误 ----');
      for (const e of consoleErrors.slice(0, 8)) console.log(`  ${e}`);
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
