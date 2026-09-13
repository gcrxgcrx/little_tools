'use strict';

/**
 * 控制台 API 的隔离测试。
 *
 *   node tools/test-admin-api.js
 *
 * 起一个完全隔离的实例：
 *   · 独立端口
 *   · 独立数据目录
 *   · **独立的 config.json 副本**（否则改访问码会写坏你正在用的那份）
 *   · 独立的计划任务名（否则会删掉你真实注册的开机自启）
 *   · 强制 dryRun（不会真的关机）
 */

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.VW_TEST_PORT || 8098);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const REAL_CONFIG = path.join(__dirname, '..', 'config.json');
const TEST_TASK = 'VideoWatcherTest';

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

async function api(pathname, options) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function waitForHealthy(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  return false;
}

/** 记录真实 config.json 的内容，结束时对比确认没被动过 */
async function main() {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vw-admin-'));
  const tempConfig = path.join(tempDir, 'config.json');
  const realConfigBefore = await fsp.readFile(REAL_CONFIG, 'utf8');
  await fsp.writeFile(tempConfig, realConfigBefore, 'utf8');

  console.log(`隔离实例: 端口 ${PORT}`);
  console.log(`临时配置: ${tempConfig}`);
  console.log(`临时数据: ${tempDir}`);
  console.log(`临时任务名: ${TEST_TASK}\n`);

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      VW_PORT: String(PORT),
      VW_DATA_DIR: tempDir,
      VW_CONFIG: tempConfig,
      VW_TASK_NAME: TEST_TASK,
      VW_POWER_DRY_RUN: '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    if (!(await waitForHealthy())) {
      console.error('隔离实例没有起来，无法继续。');
      process.exit(1);
    }

    console.log('1) 状态接口');
    const status = await api('/api/admin/status');
    check('GET /api/admin/status 可用', status.status === 200, `HTTP ${status.status}`);
    check('带上了服务信息', Number.isFinite(status.body?.service?.pid), `PID ${status.body?.service?.pid}`);
    check('带上了 Node 版本', typeof status.body?.service?.nodeVersion === 'string', status.body?.service?.nodeVersion);
    check('带上了片库信息', Number.isFinite(status.body?.library?.count), `${status.body?.library?.count} 个视频`);
    check('带上了访问码', typeof status.body?.pin === 'string' && status.body.pin.length >= 4, status.body?.pin);
    check('带上了局域网地址列表', Array.isArray(status.body?.urls?.lan));
    check('带上了关机状态', typeof status.body?.power?.armed === 'boolean');

    console.log('\n2) 修改访问码');
    const bad = await api('/api/admin/pin', { method: 'POST', body: JSON.stringify({ pin: 'abc' }) });
    check('非数字被拒绝', bad.status === 400, `HTTP ${bad.status}`);

    const short = await api('/api/admin/pin', { method: 'POST', body: JSON.stringify({ pin: '12' }) });
    check('太短被拒绝', short.status === 400, `HTTP ${short.status}`);

    const changed = await api('/api/admin/pin', {
      method: 'POST',
      body: JSON.stringify({ pin: '135790' }),
    });
    check('成功改成 135790', changed.status === 200 && changed.body?.pin === '135790');
    check('提示已写回配置', changed.body?.persisted === true);

    const saved = JSON.parse(await fsp.readFile(tempConfig, 'utf8'));
    check('临时 config.json 里确实写进去了', saved.pin === '135790');
    check('中文没被转义或损坏', Array.isArray(saved.roots) && saved.roots[0].includes('片源'), saved.roots?.[0]);

    const random = await api('/api/admin/pin', { method: 'POST', body: JSON.stringify({}) });
    check('留空则随机生成', random.status === 200 && /^\d{6}$/.test(random.body?.pin || ''), random.body?.pin);

    console.log('\n3) 日志接口');
    const log = await api('/api/admin/log?lines=50');
    check('GET /api/admin/log 可用', log.status === 200);
    check('没有日志文件时给出提示而不是报错', log.body?.available === false && typeof log.body?.hint === 'string');

    console.log('\n4) 开机自启（用的是临时任务名）');
    const before = await api('/api/admin/autostart');
    check('初始未注册或明确说明无法查询', before.body?.registered === false || before.body?.registered === null,
      before.body?.error || String(before.body?.registered));

    const on = await api('/api/admin/autostart', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    });
    const spawnBlocked = on.status === 503;
    check(
      '注册成功，或在环境不允许时给出明确指引',
      (on.status === 200 && on.body?.registered === true) || spawnBlocked,
      spawnBlocked ? `环境限制: ${on.body?.error}` : on.body?.scheduleType || ''
    );
    if (spawnBlocked) {
      check('给出了替代方案', typeof on.body?.hint === 'string' && on.body.hint.includes('install-autostart'), on.body?.hint);
    }

    // 这一条才是关键：接口出错后服务必须还活着
    const stillAlive = await api('/api/health').catch(() => null);
    check('接口报错后服务仍然存活', stillAlive != null && stillAlive.body?.ok === true);

    if (!spawnBlocked) {
      const off = await api('/api/admin/autostart', {
        method: 'POST',
        body: JSON.stringify({ enabled: false }),
      });
      check('移除成功', off.status === 200 && off.body?.registered === false);
    } else {
      console.log('    （环境不允许调用系统命令，跳过移除测试）');
    }

    console.log('\n5) 断点清理');
    const cleared = await api('/api/admin/progress/clear', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    check('清空接口可用', cleared.status === 200 && cleared.body?.remaining === 0);

    console.log('\n6) 鉴权');
    const anon = await fetch(`${BASE}/api/admin/status`); // 回环免密，这里只确认路由存在
    check('回环地址可访问（开发便利）', anon.status === 200);
  } finally {
    // 兜底：万一测试中途失败，别把临时任务留在系统里
    spawn('schtasks', ['/Delete', '/TN', TEST_TASK, '/F'], { stdio: 'ignore', windowsHide: true });

    child.kill();
    await sleep(400);
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n7) 确认真实配置没有被碰到');
  const realConfigAfter = await fsp.readFile(REAL_CONFIG, 'utf8');
  check('真实的 config.json 一字未改', realConfigAfter === realConfigBefore);

  console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
