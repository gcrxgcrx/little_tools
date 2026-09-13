'use strict';

/**
 * 片库扫描 CLI：不等服务端起来就能看扫描结果。
 *   node src/scan-cli.js
 */

const path = require('node:path');
const fsp = require('node:fs/promises');
const { Library } = require('./library');

const PROJECT_ROOT = path.join(__dirname, '..');

function fmtDuration(sec) {
  if (sec == null) return '?';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

function fmtSize(bytes) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

async function main() {
  const config = JSON.parse(await fsp.readFile(path.join(PROJECT_ROOT, 'config.json'), 'utf8'));
  const library = new Library(config, PROJECT_ROOT);

  await library.loadCache();
  const before = library.size;

  const started = Date.now();
  await library.build();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(
    `扫描完成：${library.size} 个视频（缓存命中 ${before}），遍历 ${library.progress.dirs} 个目录，用时 ${elapsed}s\n`
  );

  if (library.scanError) console.log(`扫描错误: ${library.scanError}\n`);

  const badge = { ok: '[可播]', warn: '[注意]', bad: '[需处理]' };

  for (const item of library.items) {
    console.log(
      `${badge[item.iosLevel] || '[?]'} ${item.relPath}\n` +
        `     ${fmtSize(item.size)} · ${fmtDuration(item.durationSec)} · ` +
        `${item.videoCodec || '?'} + ${item.audioCodec || '?'} · ` +
        `faststart ${item.faststart === true ? '是' : item.faststart === false ? '否' : '?'} · id ${item.id}`
    );
    for (const note of item.iosNotes || []) console.log(`     - ${note}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
