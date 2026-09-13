'use strict';

/**
 * 关机 API 的隔离测试。
 *
 *   node tools/test-power-api.js
 *
 * 会另外起一个**独立实例**（不同端口、独立数据目录、强制 dryRun），
 * 因此绝对不会碰到正在运行的正式服务，也绝对不会真的关机。
 */

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.VW_TEST_PORT || 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, '..', 'src', 'server.js');

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
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  return false;
}

async function main() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vw-power-api-'));

  console.log(`启动隔离实例: 端口 ${PORT}, 数据目录 ${dataDir}, dryRun=1\n`);

  // stdio 用 ignore：不捕获子进程输出，避免管道相关限制
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      VW_PORT: String(PORT),
      VW_DATA_DIR: dataDir,
      VW_POWER_DRY_RUN: '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    const healthy = await waitForHealthy();
    if (!healthy) {
      console.error('隔离实例没有在预期时间内起来，无法继续。');
      process.exit(1);
    }

    console.log('1) 初始状态');
    const initial = await api('/api/power');
    check('GET /api/power 可用', initial.status === 200, `HTTP ${initial.status}`);
    check('默认未武装', initial.body?.armed === false);
    check('关机功能是启用的', initial.body?.enabled === true);
    check('运行在 dryRun 模式', initial.body?.dryRun === true, '不会真的关机');

    console.log('\n2) 武装与解除');
    const armed = await api('/api/power', {
      method: 'POST',
      body: JSON.stringify({ armed: true }),
    });
    check('武装成功', armed.status === 200 && armed.body?.armed === true, armed.body?.reason || '');

    const stateAfterArm = await api('/api/state');
    check(
      '房间状态里带上了关机信息',
      stateAfterArm.body?.power?.armed === true,
      `armed=${stateAfterArm.body?.power?.armed}`
    );
    check('此时还没有安排关机', stateAfterArm.body?.power?.scheduledAtMs === null);

    const disarmed = await api('/api/power', {
      method: 'POST',
      body: JSON.stringify({ armed: false }),
    });
    check('解除成功', disarmed.body?.armed === false);

    console.log('\n3) 取消接口幂等');
    const cancel1 = await api('/api/power/cancel', { method: 'POST' });
    check('无待执行任务时取消也不报错', cancel1.status === 200 && cancel1.body?.scheduledAtMs === null);
    const cancel2 = await api('/api/power/cancel', { method: 'POST' });
    check('重复取消仍然正常', cancel2.status === 200);

    console.log('\n4) 鉴权');
    // 隔离实例同样是回环免密，这里只确认接口存在且不因鉴权炸掉
    check('回环地址可访问（开发便利）', initial.status === 200);
  } finally {
    child.kill();
    await sleep(300);
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
