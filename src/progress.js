'use strict';

/**
 * 播放断点记忆。
 *
 * 以媒体 id 为键记录"看到哪儿了"，落盘到 data/progress.json。
 * 因为是服务端记录权威时间轴的位置，两台设备天然共享同一个断点，
 * 不需要各存各的、也就不会出现"两人续播位置不一致"。
 *
 * 写盘做了防抖：播放中每 10 秒更新一次内存，最多每 3 秒落一次盘，
 * 避免频繁 IO。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const SAVE_DEBOUNCE_MS = 3000;

class ProgressStore {
  constructor(dataDir, options = {}) {
    this.file = path.join(dataDir, 'progress.json');
    this.enabled = options.enabled !== false;
    this.rewindSec = Number.isFinite(options.rewindSec) ? options.rewindSec : 5;
    this.minPositionSec = Number.isFinite(options.minPositionSec) ? options.minPositionSec : 30;
    this.endThresholdSec = Number.isFinite(options.endThresholdSec) ? options.endThresholdSec : 90;

    /** mediaId -> { positionSec, durationSec, updatedAt } */
    this.map = new Map();
    this.saveTimer = null;
    this.saving = null;
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.entries === 'object' && parsed.entries) {
        for (const [id, entry] of Object.entries(parsed.entries)) {
          if (entry && Number.isFinite(entry.positionSec)) this.map.set(id, entry);
        }
      }
    } catch {
      // 首次运行没有文件，正常
    }
  }

  async flush() {
    if (!this.enabled) return;
    const entries = {};
    for (const [id, entry] of this.map) entries[id] = entry;
    const payload = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries }, null, 2);
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(this.file, payload, 'utf8');
    } catch {
      // 落盘失败不影响播放
    }
  }

  scheduleSave() {
    if (!this.enabled || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch(() => {});
    }, SAVE_DEBOUNCE_MS);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  /** 记录进度；位置太靠前或已经看到结尾就不值得记 */
  record(mediaId, positionSec, durationSec) {
    if (!this.enabled || !mediaId || !Number.isFinite(positionSec)) return;

    if (positionSec < this.minPositionSec) {
      // 刚开始看，清掉旧断点，避免下次莫名其妙跳到后面
      if (this.map.has(mediaId)) {
        this.map.delete(mediaId);
        this.scheduleSave();
      }
      return;
    }

    if (Number.isFinite(durationSec) && durationSec > 0) {
      const remaining = durationSec - positionSec;
      if (remaining <= this.endThresholdSec) {
        // 已经看到结尾，视为看完，下次从头开始
        this.clear(mediaId);
        return;
      }
    }

    this.map.set(mediaId, {
      positionSec: Math.round(positionSec * 10) / 10,
      durationSec: Number.isFinite(durationSec) ? Math.round(durationSec) : null,
      updatedAt: new Date().toISOString(),
    });
    this.scheduleSave();
  }

  clear(mediaId) {
    if (!this.map.has(mediaId)) return;
    this.map.delete(mediaId);
    this.scheduleSave();
  }

  get(mediaId) {
    return this.map.get(mediaId) || null;
  }

  /**
   * 计算续播起点：回退几秒，免得正好停在关键台词之后。
   * 返回 null 表示没有可用的断点。
   */
  resumePointFor(mediaId) {
    if (!this.enabled) return null;
    const entry = this.get(mediaId);
    if (!entry) return null;
    const from = Math.max(0, entry.positionSec - this.rewindSec);
    if (from < 1) return null;
    return { from, savedPositionSec: entry.positionSec, updatedAt: entry.updatedAt };
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { ProgressStore };
