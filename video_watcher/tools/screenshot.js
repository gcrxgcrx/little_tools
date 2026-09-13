'use strict';

/**
 * 界面截图工具 —— 视觉改动不能靠想象，得看图。
 *
 *   node tools/screenshot.js
 *
 * 输出到 docs/screenshots/。用系统 Edge（无需下载浏览器）。
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
    // 不要静默吞异常：编码错误会被伪装成"配置读不到"
    console.warn(`⚠️ 读取 config.json 的 pin 失败：${err.message}`);
  }
  return '000000';
}

const PIN = resolvePin();
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');

const DESKTOP = { width: 1280, height: 860, deviceScaleFactor: 2 };
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 关浏览器。除了 browser.close() 再对底层进程补一刀：
 * Node 紧接着 exit() 时关闭握手可能来不及走完。
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

async function shoot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  const size = fs.statSync(file).size;
  console.log(`  ✓ ${name}.png  (${Math.round(size / 1024)} KB)`);
}

async function loginIfNeeded(page) {
  const overlay = await page
    .waitForSelector('#login:not(.hidden)', { timeout: 8000 })
    .catch(() => null);
  if (!overlay) return false;
  await page.type('#pinInput', PIN);
  await page.click('#pinBtn');
  await page.waitForSelector('#login.hidden', { timeout: 15000 });
  return true;
}

async function main() {
  if (!fs.existsSync(EDGE)) {
    console.error(`找不到浏览器: ${EDGE}`);
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const lib = await fetch(`${API_BASE}/api/library`).then((r) => r.json());
  const target = (lib.items || []).find((i) => i.videoCodec === 'avc1' && i.playable) || (lib.items || [])[0];
  if (!target) {
    console.error('片库为空，无法截图。');
    process.exit(2);
  }

  console.log(`浏览器: ${EDGE}`);
  console.log(`服务端: ${BASE}`);
  console.log(`输出到: ${OUT}\n`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--no-sandbox',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
    ],
  });

  try {
    // —— 桌面：片库 ——
    console.log('桌面视图');
    const desktop = await browser.newPage();
    await desktop.setViewport(DESKTOP);
    await desktop.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await desktop.waitForSelector('#login:not(.hidden)', { timeout: 15000 }).catch(() => {});
    await shoot(desktop, '01-login-desktop');
    await loginIfNeeded(desktop);
    await desktop.waitForSelector('.item', { timeout: 20000 });
    await sleep(400);
    await shoot(desktop, '02-library-desktop');

    // —— 桌面：控制台 ——
    await desktop.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await desktop.waitForSelector('#serviceGrid .row', { timeout: 20000 });
    await sleep(900);
    await shoot(desktop, '03-admin-desktop');

    // —— 手机：片库 ——
    console.log('手机视图');
    const phone = await browser.createBrowserContext().then((ctx) => ctx.newPage());
    await phone.setUserAgent(IPHONE_UA);
    await phone.setViewport(MOBILE);
    await phone.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await phone.waitForSelector('#login:not(.hidden)', { timeout: 15000 }).catch(() => {});
    await shoot(phone, '04-login-mobile');
    await loginIfNeeded(phone);
    await phone.waitForSelector('.item', { timeout: 20000 });
    await sleep(400);
    await shoot(phone, '05-library-mobile');

    // —— 手机：播放器 ——
    await phone.evaluate((name) => {
      const row = [...document.querySelectorAll('.item')].find(
        (r) => r.querySelector('.name')?.textContent === name
      );
      row.click();
    }, target.name);
    await phone.waitForSelector('#unlock:not(.hidden)', { timeout: 15000 });
    await sleep(300);
    await shoot(phone, '06-player-unlock-mobile');
    await phone.click('#unlock');
    await sleep(2000);

    // 跳到 35% 处，让进度条的"已播"填充看得见（否则停在开头几乎全是空的）
    await phone.evaluate(() => {
      const s = window.__vw.sync;
      const d = document.getElementById('video').duration;
      if (Number.isFinite(d) && d > 0) s.localSeek(d * 0.35);
    });
    await sleep(2600);
    await shoot(phone, '07-player-mobile');

    // 播放器底部（控制条与自检面板）
    await phone.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(400);
    await shoot(phone, '08-player-bottom-mobile');

    // —— 手机：控制台 ——
    await phone.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await phone.waitForSelector('#serviceGrid .row', { timeout: 20000 });
    await sleep(900);
    await shoot(phone, '09-admin-mobile');

    // —— 屏幕共享：手机侧的样子 ——
    console.log('共享屏幕状态');
    const sharer = await browser.createBrowserContext().then((ctx) => ctx.newPage());
    await sharer.setViewport(DESKTOP);
    await sharer.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await loginIfNeeded(sharer);
    await sharer.waitForFunction(() => window.__vw && window.__vw.shareInfo, { timeout: 15000 });
    await sleep(800);

    // 用 canvas 流代替真实屏幕采集（无头环境没有屏幕可选，这里只为拍界面），
    // 顺便用 WebAudio 造一条音频轨，让「声音」按钮也出现在截图里
    await sharer.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 540;
      const ctx = canvas.getContext('2d');
      let n = 0;
      // 用 rAF 驱动，源就是 60fps；用 setInterval(100ms) 的话源只有 10fps，
      // 截图底部会显示 "接收 10 fps"，看起来像链路不行
      const draw = () => {
        n += 1;
        const g = ctx.createLinearGradient(0, 0, 960, 540);
        g.addColorStop(0, `hsl(${(n * 2) % 360} 65% 60%)`);
        g.addColorStop(1, `hsl(${(n * 2 + 60) % 360} 65% 45%)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 960, 540);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 54px sans-serif';
        ctx.fillText('电脑屏幕共享中', 60, 300);
        requestAnimationFrame(draw);
      };
      draw();

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ac = new AudioCtx();
      if (ac.state === 'suspended') await ac.resume();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      gain.gain.value = 0.02;
      const dest = ac.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      osc.start();

      const stream = new MediaStream([
        ...canvas.captureStream(60).getVideoTracks(),
        ...dest.stream.getAudioTracks(),
      ]);
      window.__vw.startShareWithStream(stream);
    });
    // 等带宽估计爬升到稳态，否则截图里的帧率/分辨率都是爬升期的低值
    await sleep(7000);

    // 手机回到片库页，验证"没选片也能看到共享提示"
    await phone.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await phone.waitForSelector('.item', { timeout: 20000 });
    await sleep(2200);
    await shoot(phone, '10-share-bar-mobile');

    await phone.evaluate(() => document.getElementById('shareWatchBtn').click());
    await sleep(7000);
    await shoot(phone, '11-share-stage-mobile');

    // 再拍一张声音已打开的（点「观看」时应该已经在手势里解除了静音）
    await phone.evaluate(() => {
      const share = window.__vw.shareInfo;
      if (share.soundButtonVisible && share.muted) document.getElementById('shareSoundBtn').click();
    });
    await sleep(800);
    await shoot(phone, '12-share-stage-sound-mobile');
  } finally {
    await closeBrowser(browser);
  }

  console.log('\n完成。');
}

main().catch((err) => {
  console.error('截图失败:', err);
  process.exit(1);
});
