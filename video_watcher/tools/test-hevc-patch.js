'use strict';

/**
 * 验证"传输时无损改写 hev1 → hvc1"。
 *
 *   node tools/test-hevc-patch.js
 *
 * 需要服务端已在 127.0.0.1:8080 运行。
 *
 * 断言：
 *   1. 命中 fourcc 偏移的 Range 请求，服务端返回的字节是 hvc1
 *   2. 未命中该偏移的请求，返回的字节与磁盘原文件逐字节一致
 *   3. 改写不改变长度，Content-Range / Content-Length 语义正确
 *   4. 硬盘上的原始文件仍然是 hev1（一个字都没动）
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const BASE = process.env.VW_BASE || 'http://127.0.0.1:8080';

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

async function fetchRange(id, start, end) {
  const res = await fetch(`${BASE}/media/${id}`, {
    headers: { Range: `bytes=${start}-${end}` },
  });
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
}

async function readDisk(absPath, offset, length) {
  const handle = await fsp.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, offset);
    return buf;
  } finally {
    await handle.close();
  }
}

async function main() {
  console.log(`目标: ${BASE}\n`);

  const library = await fetch(`${BASE}/api/library`).then((r) => r.json());
  const patched = (library.items || []).filter((i) => i.autoPatched);

  console.log('1) 片库中的 hev1 自动改写状态');
  check('存在被自动改写的文件', patched.length > 0, `${patched.length} 个`);
  check(
    '这些文件被标记为"可直接播"',
    patched.every((i) => i.iosLevel === 'ok'),
    patched.map((i) => i.name).slice(0, 3).join(', ')
  );
  check(
    '都带有 fourcc 偏移',
    patched.every((i) => Number.isFinite(i.fourccOffset)),
    `例如 offset=${patched[0]?.fourccOffset}`
  );

  if (patched.length === 0) {
    console.log('\n没有可测的样本，退出。');
    process.exit(1);
  }

  const target = patched[0];
  const absPath = path.join(target.dir, target.fileName);
  console.log(`\n样本: ${target.name}`);
  console.log(`  文件: ${absPath}`);
  console.log(`  fourccOffset=${target.fourccOffset}\n`);

  console.log('2) 命中原文件 fourcc 位置的请求');
  const { res: hitRes, buf: hitBuf } = await fetchRange(
    target.id,
    target.fourccOffset,
    target.fourccOffset + 3
  );
  const served = hitBuf.toString('latin1');
  check('HTTP 206', hitRes.status === 206, `实际 ${hitRes.status}`);
  check('返回 4 字节', hitBuf.length === 4, `实际 ${hitBuf.length}`);
  check('服务端已改写为 hvc1', served === 'hvc1', `实际 "${served}"`);

  console.log('\n3) 未命中该偏移的请求必须与磁盘逐字节一致');
  const farOffsets = [0, 4, target.fourccOffset - 16, target.fourccOffset + 16, 1_000_000].filter(
    (o) => o >= 0 && o + 4 <= target.size
  );
  for (const offset of farOffsets) {
    const { buf } = await fetchRange(target.id, offset, offset + 3);
    const disk = await readDisk(absPath, offset, 4);
    check(`offset ${offset} 一致`, buf.equals(disk), `"${buf.toString('latin1')}"`);
  }

  console.log('\n4) Range 语义完整性');
  const { res: r206, buf: b206 } = await fetchRange(target.id, 1000, 1999);
  check(
    'Content-Range 正确',
    r206.headers.get('content-range') === `bytes 1000-1999/${target.size}`,
    r206.headers.get('content-range')
  );
  check('Content-Length 正确', Number(r206.headers.get('content-length')) === 1000);
  check('实际字节数正确', b206.length === 1000, `${b206.length}`);

  const head = await fetch(`${BASE}/media/${target.id}`, { method: 'HEAD' });
  check(
    'HEAD 返回完整长度',
    Number(head.headers.get('content-length')) === target.size,
    `${head.headers.get('content-length')} vs ${target.size}`
  );
  check('HEAD 声明支持 Range', head.headers.get('accept-ranges') === 'bytes');

  console.log('\n5) 从文件尾取 Range（非 faststart 文件的 moov 在这里）');
  const { res: tailRes, buf: tailBuf } = await fetchRange(target.id, target.size - 64, target.size - 1);
  check('尾部 Range 可用', tailRes.status === 206 && tailBuf.length === 64, `${tailBuf.length} 字节`);

  console.log('\n6) 越界 Range 应返回 416');
  const bad = await fetch(`${BASE}/media/${target.id}`, {
    headers: { Range: `bytes=${target.size + 10}-${target.size + 20}` },
  });
  check('超范围返回 416', bad.status === 416, `实际 ${bad.status}`);

  console.log('\n7) 硬盘上的原文件未被修改');
  const diskFourcc = await readDisk(absPath, target.fourccOffset, 4);
  check(
    '原文件仍是 hev1',
    diskFourcc.toString('latin1') === 'hev1',
    `实际 "${diskFourcc.toString('latin1')}"`
  );

  console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
