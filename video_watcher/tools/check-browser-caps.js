'use strict';

/**
 * 浏览器能力探测：确认"屏幕共享"在当前部署方式下能不能用。
 *
 *   node tools/check-browser-caps.js
 *
 * 关键问题：
 *   · getDisplayMedia（采集屏幕）要求"安全上下文"—— http://<局域网IP> 不算，
 *     只有 https:// 或 http://127.0.0.1 / http://localhost 才算
 *   · RTCPeerConnection（接收方要用）在不安全来源下是否还能用，各浏览器策略不同
 *
 * 这份输出直接决定"屏幕共享要不要等 HTTPS 做好"。
 */

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

const PORT = Number(process.env.VW_PORT || 8080);
const LAN = pickLanAddress();

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const PROBE = () => ({
  origin: location.origin,
  isSecureContext: window.isSecureContext,
  rtcPeerConnection: typeof window.RTCPeerConnection,
  mediaDevices: typeof navigator.mediaDevices,
  getDisplayMedia: navigator.mediaDevices ? typeof navigator.mediaDevices.getDisplayMedia : 'n/a',
  getUserMedia: navigator.mediaDevices ? typeof navigator.mediaDevices.getUserMedia : 'n/a',
  wakeLock: 'wakeLock' in navigator,
});

async function probe(page, url, label) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const result = await page.evaluate(PROBE);
  console.log(`\n${label}`);
  console.log(`  地址              ${result.origin}`);
  console.log(`  安全上下文        ${result.isSecureContext ? '✅ 是' : '❌ 否'}`);
  console.log(`  RTCPeerConnection ${result.rtcPeerConnection === 'function' ? '✅ 可用' : `❌ ${result.rtcPeerConnection}`}`);
  console.log(`  mediaDevices      ${result.mediaDevices === 'object' ? '✅ 可用' : `❌ ${result.mediaDevices}`}`);
  console.log(`  getDisplayMedia   ${result.getDisplayMedia === 'function' ? '✅ 可用（可采集屏幕）' : `❌ ${result.getDisplayMedia}`}`);
  console.log(`  getUserMedia      ${result.getUserMedia === 'function' ? '✅ 可用' : `❌ ${result.getUserMedia}`}`);
  console.log(`  Wake Lock         ${result.wakeLock ? '✅ 可用' : '❌ 不可用'}`);
  return result;
}

async function main() {
  console.log(`浏览器: ${EDGE}`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--mute-audio'],
  });

  const results = {};

  try {
    console.log('\n================ 桌面 Chromium（Edge） ================');
    const desktop = await browser.newPage();

    results.lan = await probe(desktop, `http://${LAN}:${PORT}/`, `【局域网 IP — 也是她访问的那种地址】`);
    results.loopback = await probe(desktop, `http://127.0.0.1:${PORT}/`, `【本机回环 — 你在电脑上自己打开】`);

    console.log('\n================ 伪装 iOS Safari ================');
    const ctx = await browser.createBrowserContext();
    const phone = await ctx.newPage();
    await phone.setUserAgent(IPHONE_UA);
    results.ios = await probe(phone, `http://${LAN}:${PORT}/`, `【她手机会走的地址（UA 伪装，非真实 Safari）】`);
  } finally {
    const proc = typeof browser.process === 'function' ? browser.process() : null;
    try {
      await browser.close();
    } catch {
      /* 忽略 */
    }
    await new Promise((r) => setTimeout(r, 400));
    if (proc && !proc.killed) {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
    }
  }

  console.log('\n================ 结论 ================');
  const lanBlocked = results.lan && !results.lan.isSecureContext;
  const loopbackOk = results.loopback && results.loopback.isSecureContext;

  if (lanBlocked && loopbackOk) {
    console.log('· 局域网 IP 下不是安全上下文 → 在手机 / 局域网设备上「采集屏幕」会被浏览器拒绝');
    console.log('· 本机回环（http://127.0.0.1）是安全上下文 → 在电脑自己身上采集屏幕可以');
    console.log('');
    console.log('结论：屏幕共享的「采集端」（也就是你这台电脑）现在就能用，');
    console.log('      只要你在电脑上打开 http://127.0.0.1:' + PORT + ' 而不是局域网 IP。');
    console.log('      「接收端」（她的手机）需要的是 RTCPeerConnection —— 见上面的可用性。');
    if (results.ios && results.ios.rtcPeerConnection !== 'function') {
      console.log('      ⚠️ 侦测到接收端 RTCPeerConnection 不可用，那就必须先上 HTTPS。');
    }
  }
}

main().catch((err) => {
  console.error('探测失败:', err);
  process.exit(1);
});
