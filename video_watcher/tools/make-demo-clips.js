'use strict';

/**
 * 生成演示片库：用无头浏览器把 canvas 动画录成真实视频文件。
 *
 *   node tools/make-demo-clips.js [输出目录]
 *
 * 目的是给 README 拍界面截图时有一个**不含任何个人内容**的片库，
 * 而不是拿真实影片的截图去公开。
 *
 * 优先录 MP4（H.264），因为片库扫描器对 MP4 会解析编码信息、界面更真实；
 * 浏览器不支持时退回 WebM。
 */

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const EDGE =
  process.env.VW_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const OUT = process.argv[2] || 'D:\\Movies';

/** 演示内容：[子目录, 文件名, 标题, 主色相, 秒数] */
const CLIPS = [
  ['演示剧集', '第 01 集', '演示剧集 · 01', 210, 12],
  ['演示剧集', '第 02 集', '演示剧集 · 02', 265, 12],
  ['演示剧集', '第 03 集', '演示剧集 · 03', 320, 12],
  ['演示电影', '示例电影A', '示例电影 A', 20, 12],
  ['演示电影', '示例电影B', '示例电影 B', 140, 12],
];

async function closeBrowser(browser) {
  if (!browser) return;
  const proc = typeof browser.process === 'function' ? browser.process() : null;
  try {
    await browser.close();
  } catch {
    /* 忽略 */
  }
  await new Promise((r) => setTimeout(r, 300));
  if (proc && !proc.killed) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 回填 mvhd 里的时长。
 *
 * MediaRecorder 录出来的是分片 MP4，`mvhd.duration` 是 0，
 * 于是片库扫描出来"时长未知"，界面显示 `--:--`，截图看着像坏了。
 * 这里按已知的实际录制秒数写回去 —— 只改这一个元数据字段，不影响播放
 * （分片 MP4 的实际时长由 moof 分片决定）。
 */
function patchMp4Duration(file, seconds) {
  const buf = fs.readFileSync(file);

  const walk = (start, end, want) => {
    let off = start;
    while (off + 8 <= end) {
      const size = buf.readUInt32BE(off);
      const type = buf.toString('latin1', off + 4, off + 8);
      if (size < 8 || off + size > end) return null;
      if (type === want) return { start: off, contentStart: off + 8, end: off + size };
      off += size;
    }
    return null;
  };

  const moov = walk(0, buf.length, 'moov');
  if (!moov) return false;

  const mvhd = walk(moov.contentStart, moov.end, 'mvhd');
  if (!mvhd) return false;

  const version = buf.readUInt8(mvhd.contentStart);
  const timescale =
    version === 1 ? buf.readUInt32BE(mvhd.contentStart + 20) : buf.readUInt32BE(mvhd.contentStart + 12);
  if (!timescale) return false;

  const duration = Math.round(seconds * timescale);
  if (version === 1) {
    buf.writeBigUInt64BE(BigInt(duration), mvhd.contentStart + 24);
  } else {
    buf.writeUInt32BE(duration, mvhd.contentStart + 16);
  }

  fs.writeFileSync(file, buf);
  return true;
}

async function main() {
  if (!fs.existsSync(EDGE)) {
    console.error(`找不到浏览器: ${EDGE}`);
    process.exit(2);
  }

  console.log(`输出目录: ${OUT}`);
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });

  try {
    const page = await browser.newPage();
    await page.goto('about:blank');

    const mp4Supported = await page.evaluate(() => {
      if (typeof MediaRecorder === 'undefined') return false;
      return (
        MediaRecorder.isTypeSupported('video/mp4;codecs="avc1.42E01E"') ||
        MediaRecorder.isTypeSupported('video/mp4')
      );
    });
    const mimeType = mp4Supported ? 'video/mp4' : 'video/webm';
    const ext = mp4Supported ? '.mp4' : '.webm';
    console.log(`录制格式: ${mimeType}（MP4 支持: ${mp4Supported}）\n`);

    for (const [dir, name, title, hue, seconds] of CLIPS) {
      const targetDir = path.join(OUT, dir);
      fs.mkdirSync(targetDir, { recursive: true });

      const base64 = await page.evaluate(
        async ({ mimeType, title, hue, seconds }) => {
          const canvas = document.createElement('canvas');
          canvas.width = 1280;
          canvas.height = 720;
          const ctx = canvas.getContext('2d');

          const stream = canvas.captureStream(30);
          const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
          const chunks = [];
          rec.ondataavailable = (e) => {
            if (e.data && e.data.size) chunks.push(e.data);
          };

          rec.start(250);

          const started = performance.now();
          await new Promise((resolve) => {
            const draw = () => {
              const t = (performance.now() - started) / 1000;

              const g = ctx.createLinearGradient(0, 0, 1280, 720);
              g.addColorStop(0, `hsl(${(hue + t * 12) % 360} 68% 58%)`);
              g.addColorStop(1, `hsl(${(hue + 70 + t * 12) % 360} 68% 42%)`);
              ctx.fillStyle = g;
              ctx.fillRect(0, 0, 1280, 720);

              // 一点动态元素，让画面确实在变（截图里更真实，也便于验证同步）
              ctx.globalAlpha = 0.18;
              ctx.fillStyle = '#fff';
              for (let i = 0; i < 6; i += 1) {
                const x = ((t * 90 + i * 220) % 1400) - 100;
                ctx.beginPath();
                ctx.arc(x, 120 + i * 95, 46, 0, Math.PI * 2);
                ctx.fill();
              }
              ctx.globalAlpha = 1;

              ctx.fillStyle = 'rgba(255,255,255,0.94)';
              ctx.font = 'bold 76px "Segoe UI", sans-serif';
              ctx.fillText(title, 80, 380);

              ctx.font = '34px "Segoe UI", sans-serif';
              ctx.fillText(`${t.toFixed(1)} s`, 80, 445);

              ctx.font = '26px "Segoe UI", sans-serif';
              ctx.fillText('演示素材 · 由 canvas 动画生成', 80, 640);

              if (t < seconds) requestAnimationFrame(draw);
              else resolve();
            };
            draw();
          });

          rec.stop();
          await new Promise((resolve) => {
            rec.onstop = resolve;
          });

          const blob = new Blob(chunks, { type: mimeType });
          const buf = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < buf.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
          }
          return btoa(binary);
        },
        { mimeType, title, hue, seconds }
      );

      const file = path.join(targetDir, `${name}${ext}`);
      fs.writeFileSync(file, Buffer.from(base64, 'base64'));

      const patched = ext === '.mp4' ? patchMp4Duration(file, seconds) : false;
      const size = fs.statSync(file).size;
      console.log(
        `  ✓ ${path.relative(OUT, file)}  ${(size / 1024).toFixed(0)} KB  (${seconds}s` +
          `${ext === '.mp4' ? `，时长回填${patched ? '成功' : '失败'}` : ''})`
      );
    }
  } finally {
    await closeBrowser(browser);
  }

  console.log('\n演示片库已生成。');
}

main().catch((err) => {
  console.error('生成失败:', err);
  process.exit(1);
});
