'use strict';

/**
 * HEVC 封装修补工具
 *
 *   node src/fix-hevc-cli.js <文件或目录> [...]          # 预演（默认，不改文件）
 *   node src/fix-hevc-cli.js --apply <文件或目录> [...]  # 真正写入
 *
 * 背景：
 *   Apple 平台（QuickTime / Safari / AVFoundation）只认可 `hvc1` 封装的 HEVC，
 *   而 `hev1` 封装在 iOS 上通常直接播不出来。
 *   MP4 里两种封装的箱子结构完全一致，只有 sample entry 的 4 字节 fourcc 不同，
 *   因此在 hvcC 参数集齐全的前提下，改这 4 个字节即可让 iPhone 正常播放，
 *   无损、瞬时、不重新编码。
 *
 * 安全前提：
 *   hvcC 中必须存在参数集（NAL 类型 32=VPS、33=SPS、34=PPS）。
 *   若缺失（参数集只以带内方式存放），则本工具拒绝修改，需要 ffmpeg 重新封装。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { analyzeVideoSampleEntry, retagFourcc } = require('./mp4');

const ISO_EXT = new Set(['.mp4', '.m4v', '.mov']);
const ALL_EXT = new Set([...ISO_EXT, '.mkv', '.webm', '.avi', '.ts']);
const PARAM_SET_NAL_TYPES = [32, 33, 34];

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
    if (entry.isDirectory()) await collect(full, acc);
    else if (entry.isFile() && ALL_EXT.has(path.extname(entry.name).toLowerCase())) acc.push(full);
  }
  return acc;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const targets = argv.filter((a) => a !== '--apply');

  if (targets.length === 0) {
    console.error('用法: node src/fix-hevc-cli.js [--apply] <文件或目录> [...]');
    process.exit(2);
  }

  const files = [];
  for (const target of targets) await collect(path.resolve(target), files);

  if (files.length === 0) {
    console.log('没有找到视频文件。');
    return;
  }

  let patched = 0;
  let already = 0;
  let refused = 0;
  let skipped = 0;

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();

    if (!ISO_EXT.has(ext)) {
      console.log(`[跳过] ${path.basename(file)} —— ${ext} 不是 ISO BMFF 容器，无法用此方式修补`);
      skipped += 1;
      continue;
    }

    const entry = await analyzeVideoSampleEntry(file);
    if (!entry) {
      console.log(`[跳过] ${path.basename(file)} —— 未找到视频轨 sample entry`);
      skipped += 1;
      continue;
    }

    if (entry.fourcc === 'hvc1') {
      console.log(`[无需处理] ${path.basename(file)} —— 已经是 hvc1`);
      already += 1;
      continue;
    }

    if (entry.fourcc !== 'hev1') {
      console.log(`[无需处理] ${path.basename(file)} —— 视频编码为 ${entry.fourcc}，与本问题无关`);
      already += 1;
      continue;
    }

    const nalTypes = entry.hvcC?.nalTypes ?? [];
    const hasParamSets = PARAM_SET_NAL_TYPES.every((t) => nalTypes.includes(t));

    if (!hasParamSets) {
      console.log(
        `[拒绝修改] ${path.basename(file)} —— hvcC 参数集不全 (NAL 类型: ${nalTypes.join(',') || '无'})，` +
          '需要 ffmpeg 重新封装：ffmpeg -i in.mp4 -c copy -tag:v hvc1 out.mp4'
      );
      refused += 1;
      continue;
    }

    if (apply) {
      await retagFourcc(file, entry.fourccOffset, 'hvc1');
      console.log(
        `[已修补] ${path.basename(file)} —— hev1 → hvc1（偏移 ${entry.fourccOffset}，参数集 NAL: ${nalTypes.join(',')}）`
      );
      patched += 1;
    } else {
      console.log(
        `[可修补] ${path.basename(file)} —— hev1 → hvc1（参数集 NAL: ${nalTypes.join(',')}）`
      );
      patched += 1;
    }
  }

  console.log(
    `\n汇总：${apply ? '已修补' : '可修补'} ${patched} · 无需处理 ${already} · 拒绝 ${refused} · 跳过 ${skipped}`
  );
  if (!apply && patched > 0) {
    console.log('这是预演。确认无误后加 --apply 真正写入（只改 4 个字节，不改文件大小）。');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
