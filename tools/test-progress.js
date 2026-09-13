'use strict';

/**
 * 断点记忆与播完关机的单元测试（不需要启动服务器）。
 *
 *   node tools/test-progress.js
 *
 * 关机部分一律用 dryRun，只打日志，绝不真的执行 shutdown。
 */

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const { ProgressStore } = require('../src/progress');
const { PowerManager } = require('../src/power');

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

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vw-progress-'));

  console.log('1) 断点记录的门槛');
  {
    const store = new ProgressStore(tmp, {
      enabled: true,
      rewindSec: 5,
      minPositionSec: 30,
      endThresholdSec: 90,
    });

    store.record('m1', 10, 1000);
    check('刚看 10 秒不记（低于 minPositionSec）', store.get('m1') === null);

    store.record('m1', 100, 1000);
    check('看到 100 秒会记下来', store.get('m1')?.positionSec === 100, `记录 ${store.get('m1')?.positionSec}s`);

    const point = store.resumePointFor('m1');
    check('续播点提前了 5 秒', point != null && Math.abs(point.from - 95) < 0.01, `从 ${point?.from}s 继续`);
    check('同时保留原始断点位置', point?.savedPositionSec === 100);

    console.log('\n2) 看到结尾视为看完');
    store.record('m2', 950, 1000); // 剩 50 秒 < endThresholdSec
    check('接近结尾不记断点', store.get('m2') === null);

    store.record('m3', 500, 1000);
    check('中间位置会记', store.get('m3')?.positionSec === 500);
    store.record('m3', 960, 1000);
    check('后来看到结尾就清掉', store.get('m3') === null);

    console.log('\n3) 回退起点不会变成负数');
    store.record('m4', 31, 1000);
    const p4 = store.resumePointFor('m4');
    check('31 秒的断点回退后仍为正', p4 != null && p4.from > 0, `从 ${p4?.from}s`);

    store.record('m5', 32, 1000);
    const bigRewind = new ProgressStore(tmp, { enabled: true, rewindSec: 40, minPositionSec: 30 });
    bigRewind.record('m5', 32, 1000);
    const p5 = bigRewind.resumePointFor('m5');
    check(
      '回退幅度超过位置本身时不会出现负数',
      p5 === null || p5.from >= 0,
      p5 ? `从 ${p5.from}s` : '（起点不足 1 秒，视为无断点）'
    );

    console.log('\n4) 落盘与重新加载');
    await store.flush();
    const reloaded = new ProgressStore(tmp, { enabled: true });
    await reloaded.load();
    check('重新加载后断点还在', reloaded.get('m1')?.positionSec === 100, `${reloaded.size} 条记录`);
    check('续播点计算一致', Math.abs(reloaded.resumePointFor('m1').from - 95) < 0.01);

    console.log('\n5) 关闭功能时不记录');
    const off = new ProgressStore(tmp, { enabled: false });
    off.record('mx', 500, 1000);
    check('enabled=false 时完全不记录', off.get('mx') === null && off.resumePointFor('mx') === null);
  }

  console.log('\n6) 播完关机：默认不武装');
  {
    const logs = [];
    const power = new PowerManager({
      enableShutdown: true,
      delaySec: 60,
      dryRun: true,
      log: (m) => logs.push(m),
    });

    check('默认未武装', power.armed === false);
    power.schedule('测试');
    check('未武装时 schedule 无效', power.scheduledAtMs === null, '不会误关机');

    console.log('\n7) 武装后才会安排关机（dryRun，不会真关）');
    power.arm(true);
    check('已武装', power.armed === true);
    power.schedule('播完最后一个视频');
    check('已安排关机', power.scheduledAtMs !== null, `${Math.round(power.snapshot().remainingMs / 1000)} 秒后`);
    check('关机原因被记录', power.snapshot().reason === '播完最后一个视频');
    check('dryRun 下没有真的调用系统命令', logs.some((l) => l.includes('dryRun')), logs.join(' / '));

    console.log('\n8) 取消与解除武装');
    power.cancel('测试取消');
    check('取消后没有待执行任务', power.scheduledAtMs === null);
    power.schedule('再来一次');
    check('可以再次安排', power.scheduledAtMs !== null);
    power.arm(false);
    check('关闭开关会一并取消', power.armed === false && power.scheduledAtMs === null);

    console.log('\n9) 空房计时');
    const idle = new PowerManager({
      enableShutdown: true,
      delaySec: 60,
      onEmptyRoomSec: 300,
      dryRun: true,
      log: () => {},
    });
    idle.arm(true);
    check('刚有人时不该关', idle.shouldShutdownForIdle() === false);

    idle.markRoomEmpty();
    check('刚变空还没到时间', idle.shouldShutdownForIdle() === false);

    idle.emptySinceMs = Date.now() - 301 * 1000;
    check('空房超过阈值就该关', idle.shouldShutdownForIdle() === true);

    idle.markRoomOccupied();
    check('有人回来就重新计时', idle.shouldShutdownForIdle() === false && idle.emptySinceMs === null);

    console.log('\n10) 关闭功能时完全不动作');
    const disabled = new PowerManager({ enableShutdown: false, dryRun: true });
    disabled.arm(true);
    check('禁用后武装无效', disabled.armed === false);
    disabled.schedule('x');
    check('禁用后不会安排关机', disabled.scheduledAtMs === null);
  }

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});

  console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
