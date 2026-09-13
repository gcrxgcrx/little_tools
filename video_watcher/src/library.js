'use strict';

/**
 * 片库扫描与索引。
 *
 * 设计要点：
 *   - 递归扫描 roots，按目录名黑名单剪枝 + 最大深度限制（避免把 Steam 库之类扫穿）
 *   - 对 ISO BMFF 容器（mp4/m4v/mov）解析出时长、编码、faststart，并给出 iOS 兼容性结论
 *   - 结果按 (路径, 大小, mtime) 缓存到 data/library.json，只有变化的文件才重新解析
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { probeMp4, assessForIos, analyzeVideoSampleEntry } = require('./mp4');

const ISO_EXT = new Set(['.mp4', '.m4v', '.mov']);
const PROBE_CONCURRENCY = 4;
const PARAM_SET_NAL_TYPES = [32, 33, 34];
/** 索引结构版本：item 字段有增减就 +1，旧缓存会自动失效重建 */
const LIBRARY_SCHEMA = 2;

function videoId(relPath) {
  return crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 12);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

class Library {
  constructor(config, projectRoot) {
    this.config = config;
    this.roots = (config.roots || []).map((r) => path.resolve(r));
    this.exclude = new Set((config.excludeDirs || []).map((d) => String(d).toLowerCase()));
    this.maxDepth = Number.isFinite(config.maxDepth) ? config.maxDepth : 5;
    this.videoExt = new Set((config.videoExtensions || []).map((e) => String(e).toLowerCase()));
    this.playableExt = new Set(
      (config.playableExtensions || ['.mp4', '.m4v', '.mov', '.webm']).map((e) => String(e).toLowerCase())
    );

    this.dataDir = config.dataDir ? path.resolve(config.dataDir) : path.join(projectRoot, 'data');
    this.indexFile = path.join(this.dataDir, 'library.json');

    /** 传输时把 hev1 改写成 hvc1（让 iPhone 能播，且不动硬盘上的文件） */
    this.patchHevcOnServe = config.patchHevcOnServe !== false;

    this.items = [];
    this.byId = new Map();
    this.builtAt = null;
    this.scanning = false;
    this.scanError = null;
    this.progress = { dirs: 0, files: 0 };
  }

  get size() {
    return this.items.length;
  }

  async loadCache() {
    try {
      const raw = await fsp.readFile(this.indexFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.schema === LIBRARY_SCHEMA && Array.isArray(parsed.items)) {
        this.items = parsed.items;
        this.builtAt = parsed.builtAt || null;
        this.byId = new Map(this.items.map((i) => [i.id, i]));
      }
    } catch {
      // 首次运行没有缓存，正常
    }
  }

  async saveCache() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    const payload = JSON.stringify(
      { schema: LIBRARY_SCHEMA, builtAt: this.builtAt, items: this.items },
      null,
      2
    );
    await fsp.writeFile(this.indexFile, payload, 'utf8');
  }

  async walk(dir, depth, out) {
    if (depth > this.maxDepth) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    this.progress.dirs += 1;

    for (const entry of entries) {
      // 跳过符号链接/junction，避免目录环
      if (entry.isSymbolicLink()) continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const name = entry.name.toLowerCase();
        if (this.exclude.has(name)) continue;
        if (name.startsWith('$')) continue;
        await this.walk(full, depth + 1, out);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (this.videoExt.has(ext)) out.push(full);
      }
    }
  }

  async describe(file, stat) {
    const ext = path.extname(file).toLowerCase();
    const parsed = path.parse(file);
    const relPath = path.relative(parsed.root, file);

    const item = {
      id: videoId(relPath),
      name: path.basename(file, path.extname(file)),
      fileName: path.basename(file),
      dir: path.dirname(file),
      relPath,
      path: file,
      ext,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      playable: this.playableExt.has(ext),
      durationSec: null,
      videoCodec: null,
      audioCodec: null,
      faststart: null,
      iosLevel: 'warn',
      iosNotes: [],
    };

    if (ISO_EXT.has(ext)) {
      const probe = await probeMp4(file);
      if (probe) {
        item.durationSec = probe.durationSec;
        item.videoCodec = probe.videoCodec;
        item.audioCodec = probe.audioCodec;
        item.faststart = probe.faststart;
      }
      const assess = assessForIos(probe);
      item.iosLevel = assess.level;
      item.iosNotes = assess.notes;

      // hev1：定位 sample entry 里 fourcc 的绝对偏移，供传输时无损改写为 hvc1
      if ((item.videoCodec || '').toLowerCase() === 'hev1') {
        const entry = await analyzeVideoSampleEntry(file);
        if (entry) {
          item.fourccOffset = entry.fourccOffset;
          const nalTypes = entry.hvcC?.nalTypes ?? [];
          item.hevcPatchable = PARAM_SET_NAL_TYPES.every((t) => nalTypes.includes(t));
        } else {
          item.hevcPatchable = false;
        }
      }
    } else {
      item.playable = false;
      item.iosLevel = 'bad';
      item.iosNotes = [`${ext} 不是 iOS Safari 能直接播的容器，需要 remux 成 MP4`];
    }

    return item;
  }

  async build() {
    if (this.scanning) return;
    this.scanning = true;
    this.scanError = null;
    this.progress = { dirs: 0, files: 0 };

    try {
      const found = [];
      for (const root of this.roots) {
        try {
          await fsp.access(root);
        } catch {
          continue;
        }
        await this.walk(root, 1, found);
      }

      const previous = new Map(this.items.map((i) => [i.path, i]));

      const items = await mapLimit(found, PROBE_CONCURRENCY, async (file) => {
        const stat = await fsp.stat(file).catch(() => null);
        if (!stat || !stat.isFile()) return null;
        this.progress.files += 1;

        const cached = previous.get(file);
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
          return cached;
        }
        return this.describe(file, stat);
      });

      const next = items.filter(Boolean);
      next.sort((a, b) => a.dir.localeCompare(b.dir, 'zh') || a.name.localeCompare(b.name, 'zh', { numeric: true }));

      this.items = next;
      this.byId = new Map(next.map((i) => [i.id, i]));
      this.builtAt = new Date().toISOString();
      await this.saveCache();
    } catch (err) {
      this.scanError = String(err && err.message ? err.message : err);
    } finally {
      this.scanning = false;
    }
  }

  list() {
    return this.items.map((item) => {
      const patchable =
        this.patchHevcOnServe &&
        (item.videoCodec || '').toLowerCase() === 'hev1' &&
        Number.isFinite(item.fourccOffset) &&
        Boolean(item.hevcPatchable);

      // 服务端能在传输时自动改写 fourcc，对使用者来说这个文件就是"可以直接播"
      const iosLevel = patchable ? 'ok' : item.iosLevel;
      const iosNotes = patchable
        ? [
            'HEVC 以 hev1 封装，服务端已在传输时自动改写为 hvc1，iPhone 可直接播放（硬盘上的原文件未被改动）',
            ...item.iosNotes.filter((n) => !n.includes('Apple 平台')),
          ]
        : item.iosNotes;

      return {
        id: item.id,
        name: item.name,
        fileName: item.fileName,
        dir: item.dir,
        ext: item.ext,
        size: item.size,
        durationSec: item.durationSec,
        videoCodec: item.videoCodec,
        audioCodec: item.audioCodec,
        faststart: item.faststart,
        playable: item.playable,
        iosLevel,
        iosNotes,
        fourccOffset: Number.isFinite(item.fourccOffset) ? item.fourccOffset : null,
        hevcPatchable: Boolean(item.hevcPatchable),
        autoPatched: patchable,
      };
    });
  }

  get(id) {
    return this.byId.get(id) || null;
  }
}

module.exports = { Library };
