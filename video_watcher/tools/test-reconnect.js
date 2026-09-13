'use strict';

/**
 * 验证"服务端重启后客户端能正确要求重新登录"。
 *
 *   node tools/test-reconnect.js
 *
 * 背景：访问码换来的会话令牌只存在服务端内存里，所以每次重启服务都会失效。
 * 早期版本在 WebSocket 断开后只是无脑重连，页面会永远停在
 * "已断开，重连中…"，用户根本没有机会重新输入访问码 ——
 * 表现出来就是"手机突然连不上了"。
 *
 * 这个测试会在中途真的重启一次服务，然后检查页面是否弹出了登录框。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');

const EDGE =
  process.env.VW_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROJECT = path.join(__dirname, '..');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function resolvePin() {
  if (process.env.VW_PIN) return process.env.VW_PIN;
  try {
    const raw = fs.readFileSync(path.join(PROJECT, 'config.json'), 'utf8');
    const pin = JSON.parse(raw).pin;
    if (pin) return String(pin);
  } catch (err) {
    console.warn(`⚠️ 读取 config.json 的 pin 失败：${err.message}`);
  }
  return '000000';
}

const PIN = resolvePin();
const LAN = pickLanAddress();
const BASE = process.env.VW_BASE || (LAN ? `http://${LAN}:8080` : 'http://127.0.0.1:8080');

function restartServer() {
  spawnSync(
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-File', path.join(PROJECT, 'tools', 'stop-server.ps1')],
    { stdio: 'ignore', windowsHide: true }
  );
  spawnSync('wscript.exe', [path.join(PROJECT, 'tools', 'start-hidden.vbs')], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function waitForHealthy(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch('http://127.0.0.1:8080/api/health')).ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  return false;
}

async function main() {
  console.log(`浏览器: ${EDGE}`);
  console.log(`访问地址: ${BASE}\n`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--mute-audio'],
  });

  try {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    console.log('1) 登录并确认已连接');
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const overlay = await page
      .waitForSelector('#login:not(.hidden)', { timeout: 10000 })
      .catch(() => null);

    if (overlay) {
      await page.type('#pinInput', PIN);
      await page.click('#pinBtn');
      await page.waitForSelector('#login.hidden', { timeout: 15000 });
    }
    await page.waitForFunction(() => window.__vw && window.__vw.shareInfo, { timeout: 15000 });
    await page.waitForFunction(() => document.getElementById('conn').textContent.includes('已连接'), {
      timeout: 15000,
    });
    check('登录成功且 WebSocket 已连接', true);

    console.log('\n2) 重启服务端（会话令牌随之失效）');
    restartServer();
    const healthy = await waitForHealthy();
    check('服务端已重启并恢复', healthy);

    console.log('\n3) 等待客户端察觉断开');
    const showedLogin = await page
      .waitForFunction(() => !document.getElementById('login').classList.contains('hidden'), {
        timeout: 30000,
      })
      .then(() => true)
      .catch(() => false);

    const state = await page.evaluate(() => ({
      loginVisible: !document.getElementById('login').classList.contains('hidden'),
      conn: document.getElementById('conn').textContent,
    }));

    check(
      '页面弹出登录框，而不是无限重连',
      showedLogin && state.loginVisible,
      `连接状态: ${state.conn}`
    );

    console.log('\n4) 重新输入访问码后应恢复连接');
    await page.type('#pinInput', PIN);
    await page.click('#pinBtn');
    await page.waitForSelector('#login.hidden', { timeout: 15000 });
    await page.waitForFunction(
      () => document.getElementById('conn').textContent.includes('已连接'),
      { timeout: 20000 }
    );
    check('重新登录后恢复连接', true);

    check('过程中没有脚本错误', errors.length === 0, errors.slice(0, 2).join(' | ') || '无');
  } finally {
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

  console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
