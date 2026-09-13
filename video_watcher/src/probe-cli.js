'use strict';

/**
 * 命令行探测工具：
 *   node src/probe-cli.js <文件或目录> [更多路径...]
 *
 * 输出每个视频的容器结构结论与"iOS 能否直接播"的评估。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { probeMp4, assessForIos } = require('./mp4');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.ts']);

async function collect(target, acc) {
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    console.error(`跳过（无法访问）: ${target}`);
    return acc;
  }

  if (stat.isFile()) {
    acc.push(target);
    return acc;
  }

  let entries = [];
  try {
    entries = await fsp.readdir(target, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await collect(full, acc);
    } else if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
      acc.push(full);
    }
  }
  return acc;
}

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

function fmtGB(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error('用法: node src/probe-cli.js <文件或目录> [...]');
    process.exit(2);
  }

  const files = [];
  for (const target of targets) {
    await collect(path.resolve(target), files);
  }

  if (files.length === 0) {
    console.log('没有找到视频文件。');
    return;
  }

  console.log(`共 ${files.length} 个文件\n`);

  const tally = { ok: 0, warn: 0, bad: 0 };

  for (const file of files) {
    const stat = await fsp.stat(file).catch(() => null);
    const ext = path.extname(file).toLowerCase();
    const isIsoBase = ext === '.mp4' || ext === '.m4v' || ext === '.mov';
    const probe = isIsoBase ? await probeMp4(file) : null;
    const { level, notes } = isIsoBase
      ? assessForIos(probe)
      : { level: 'warn', notes: [`${ext} 不是 iOS Safari 友好容器，需要 remux 成 MP4`] };

    tally[level] += 1;

    const badge = level === 'ok' ? '[可播]' : level === 'warn' ? '[注意]' : '[需处理]';
    console.log(`${badge} ${path.basename(file)}`);
    console.log(
      `     ${stat ? fmtGB(stat.size) : '?'} · 时长 ${fmtDuration(probe?.durationSec)} · ` +
        `${probe?.videoCodec || '?'} + ${probe?.audioCodec || '?'} · ` +
        `faststart ${probe?.faststart === true ? '是' : probe?.faststart === false ? '否' : '?'}`
    );
    for (const note of notes) console.log(`     - ${note}`);
    console.log('');
  }

  console.log(`汇总：可播 ${tally.ok} · 注意 ${tally.warn} · 需处理 ${tally.bad}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
