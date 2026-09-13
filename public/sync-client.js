/**
 * 客户端同步引擎。
 *
 * 职责：
 *   1. 时钟同步 —— 用 NTP/Cristian 算法估计本地时钟与服务器时钟的偏移，
 *      取最近若干次中 RTT 最小的样本，避免网络抖动污染估计
 *   2. 漂移校正 —— 桌面/安卓走 rate nudging；iOS 因 WebKit #163433
 *      （播放中改 playbackRate 会卡顿 80–300ms，2016 年报告至今未修）
 *      改为"惰性 seek 校正"
 *   3. 缓冲门控 —— 缓冲不足时上报，让房间整体等待，避免越跑越远
 */

const CLOCK_SAMPLES = 15;
const PING_INTERVAL_MS = 5000;
const TICK_INTERVAL_MS = 500;
const REPORT_INTERVAL_MS = 2000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class SyncClient {
  constructor({ video, isIOS, settings, send, onStatus, onCountdown, onRemoteAction }) {
    this.video = video;
    this.isIOS = isIOS;
    this.settings = settings;
    this.send = send;
    this.onStatus = onStatus || (() => {});
    this.onCountdown = onCountdown || (() => {});
    this.onRemoteAction = onRemoteAction || (() => {});

    this.state = null;
    this.samples = [];
    this.clockOffsetMs = 0;
    this.hasClock = false;

    /** 本地操作后的抑制窗口：避免刚 seek 就被自己的校正逻辑拽回去 */
    this.suppressUntil = 0;
    this.lastHardSeekAt = 0;
    this.lastRateSet = 1;
    /** 刚对齐完的稳定窗口：这段时间内不校正，避免刚 seek 完就又被拽一下 */
    this.alignSettleUntil = 0;
    /** 硬校正次数：iOS 上这个数字越低越好（每次都是一次可见的跳变） */
    this.hardSeekCount = 0;

    this.intendPlaying = false;
    this.waitingForBuffer = false;
    this.reportedBuffering = false;
    this.bufferWaitStartedAt = 0;

    /** 未解锁播放（iOS 需要一次用户手势）时为 true */
    this.blocked = false;

    /** 媒体信息与实测带宽，用于自适应前置缓冲 */
    this.mediaSizeBytes = null;
    this.mediaDurationSec = null;
    this.measuredThroughputBps = null;

    this.timers = [];
  }

  start() {
    this.timers.push(setInterval(() => this.ping(), PING_INTERVAL_MS));
    this.timers.push(setInterval(() => this.tick(), TICK_INTERVAL_MS));
    this.timers.push(setInterval(() => this.report(), REPORT_INTERVAL_MS));
    this.ping();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // —— 时钟同步 ——

  ping() {
    this.send({ t: 'ping', cts: Date.now() });
  }

  onPong(msg) {
    const now = Date.now();
    const rtt = now - msg.cts;
    if (!Number.isFinite(rtt) || rtt < 0) return;

    // Cristian 算法：假设往返对称
    const offset = msg.serverMs - (msg.cts + rtt / 2);
    this.samples.push({ rtt, offset });
    if (this.samples.length > CLOCK_SAMPLES) this.samples.shift();

    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;

    this.clockOffsetMs = best.offset;
    this.hasClock = true;
    this.emitStatus();
  }

  serverNow() {
    return Date.now() + this.clockOffsetMs;
  }

  // —— 权威状态 ——

  onState(state) {
    const previous = this.state;
    this.state = state;

    if (previous && previous.mediaId !== state.mediaId) {
      this.onRemoteAction({ type: 'load', state });
      this.emitStatus();
      return;
    }

    // 远端发起的动作：直接跳到目标位置，不走平滑校正
    const remoteChanged =
      !previous ||
      previous.playing !== state.playing ||
      Math.abs(previous.anchorPos - state.anchorPos) > 0.4 ||
      Math.abs(previous.anchorServerMs - state.anchorServerMs) > 600;

    if (remoteChanged && !this.isSuppressed()) {
      this.hardAlign(state);
      this.onRemoteAction({ type: 'align', state });
    }

    if (state.playing && !this.intendPlaying) this.intendPlaying = true;
    if (!state.playing && this.intendPlaying) this.intendPlaying = false;

    this.emitStatus();
  }

  isSuppressed() {
    return Date.now() < this.suppressUntil;
  }

  suppress(ms = 1500) {
    this.suppressUntil = Date.now() + ms;
  }

  targetPos(serverMs = this.serverNow()) {
    const s = this.state;
    if (!s) return 0;
    if (!s.playing) return s.anchorPos;
    const elapsed = (serverMs - s.anchorServerMs) / 1000;
    if (elapsed <= 0) return s.anchorPos;
    return s.anchorPos + elapsed * s.rate;
  }

  hardAlign(state) {
    const serverMs = this.serverNow();
    const countingDown = state.playing && serverMs < state.anchorServerMs;
    const target = countingDown ? state.anchorPos : this.targetPos(serverMs);

    if (Math.abs(this.video.currentTime - target) > 0.15) {
      try {
        this.video.currentTime = Math.max(0, target);
      } catch {
        /* 尚未可 seek */
      }
    }
    this.setRate(1);

    if (!state.playing || countingDown) {
      if (!this.video.paused) {
        this.programmatic(() => this.video.pause());
      }
    }

    // 只设稳定窗口，**不**更新 lastHardSeekAt。
    // lastHardSeekAt 是用来限制"连续"校正的；如果这里也更新它，
    // 开局对齐后一旦落后（seek + 缓冲耗时），就要等满 minIntervalSec
    // 才允许第一次校正 —— iOS 上是 120 秒，表现为长期落后几百毫秒。
    this.alignSettleUntil = Date.now() + 1500;
  }

  // —— 周期校正 ——

  tick() {
    if (!this.state || !this.video.duration) return;

    const serverMs = this.serverNow();
    const state = this.state;

    // 关键：不论房间是否在播放，都要持续评估"我缓冲好了没"。
    // 否则一旦因为自己缓冲不足把房间按停，房间就变成 playing=false，
    // 而评估又依赖 playing —— 我们永远没机会报告"我好了"，全局死锁。
    this.evaluateReadiness();

    if (state.playing && serverMs < state.anchorServerMs) {
      const remain = (state.anchorServerMs - serverMs) / 1000;
      this.onCountdown(remain);
      if (!this.video.paused) this.programmatic(() => this.video.pause());
      return;
    }
    this.onCountdown(0);

    if (state.playing) {
      const target = this.targetPos(serverMs);
      const driftMs = (this.video.currentTime - target) * 1000;

      if (this.video.paused && this.intendPlaying) {
        this.maybePlay();
        return;
      }
      if (this.isSuppressed()) return;
      this.applyCorrection(driftMs, target);
    } else {
      if (this.video.paused) {
        // 暂停状态下的位置偏差修正是零成本的
        if (Math.abs(this.video.currentTime - state.anchorPos) > 0.2 && !this.isSuppressed()) {
          try {
            this.video.currentTime = state.anchorPos;
          } catch {
            /* 忽略 */
          }
        }
      }
    }
    this.emitStatus();
  }

  applyCorrection(driftMs, target) {
    const abs = Math.abs(driftMs);

    // 刚对齐完先让它稳定一会儿
    if (Date.now() < this.alignSettleUntil) return;

    if (this.isIOS) {
      // iOS 绝不使用 rate nudging（WebKit #163433）
      const cfg = this.settings.iosLazySeek || { thresholdMs: 200, minIntervalSec: 120 };
      if (this.video.paused) {
        if (abs > 60) this.seekTo(target);
        return;
      }
      const elapsed = Date.now() - this.lastHardSeekAt;
      if (abs >= cfg.thresholdMs && elapsed > cfg.minIntervalSec * 1000) {
        this.seekTo(target);
      }
      return;
    }

    const cfg = this.settings.desktopRateNudge || {
      deadZoneMs: 60,
      hardSeekMs: 800,
      gain: 0.5,
      rateClamp: 0.04,
    };

    if (abs < cfg.deadZoneMs) {
      this.setRate(1);
      return;
    }
    if (abs < cfg.hardSeekMs) {
      const driftSec = driftMs / 1000;
      const rate = clamp(1 - driftSec * cfg.gain, 1 - cfg.rateClamp, 1 + cfg.rateClamp);
      this.setRate(rate);
      return;
    }
    this.seekTo(target);
  }

  seekTo(target) {
    if (this.video.readyState < 1) return;
    try {
      this.video.currentTime = Math.max(0, target);
      this.lastHardSeekAt = Date.now();
      this.hardSeekCount += 1;
      this.suppress(1200);
    } catch {
      /* 忽略 */
    }
  }

  setRate(rate) {
    if (this.isIOS) return; // 保护：iOS 上永不改动速率
    if (Math.abs(this.lastRateSet - rate) < 0.002) return;
    this.lastRateSet = rate;
    try {
      this.video.playbackRate = rate;
    } catch {
      /* 忽略 */
    }
  }

  // —— 缓冲门控 ——

  bufferedAheadSec() {
    const t = this.video.currentTime;
    const b = this.video.buffered;
    for (let i = 0; i < b.length; i += 1) {
      if (b.start(i) <= t && t <= b.end(i)) return b.end(i) - t;
    }
    return 0;
  }

  isReadyToPlay() {
    const required = this.requiredBufferSec();
    if (this.bufferedAheadSec() >= required) return true;
    // 浏览器（尤其是暂停状态下）不一定愿意预读那么远，
    // HAVE_ENOUGH_DATA 是它自己的判断，可以采信，避免我们把房间卡死。
    if (this.video.readyState >= 4) return true;
    return (
      this.bufferWaitStartedAt > 0 &&
      Date.now() - this.bufferWaitStartedAt > (this.settings.bufferWaitTimeoutSec || 90) * 1000
    );
  }

  /** 片源码率（字节/秒），来自片库记录的体积与时长 */
  get mediaBitrateBps() {
    if (!this.mediaSizeBytes || !this.mediaDurationSec || this.mediaDurationSec <= 0) return null;
    return this.mediaSizeBytes / this.mediaDurationSec;
  }

  /**
   * 自适应前置缓冲。
   *
   * 固定 25 秒的问题是：局域网下根本不需要等，每次拖动进度条都白等；
   * 而跨洋链路上 25 秒又可能不够。所以按实测带宽与片源码率算出需要多少秒缓冲：
   * 链路越接近满载（load → 1），越需要大缓冲来扛住波动。
   */
  requiredBufferSec() {
    const maxSec = this.settings.clientBufferAheadSec || 20;
    if (this.settings.adaptiveBuffer === false) return maxSec;

    const minSec = Math.min(this.settings.minBufferAheadSec || 5, maxSec);
    const throughput = this.measuredThroughputBps;
    const bitrate = this.mediaBitrateBps;
    if (!throughput || !bitrate || throughput <= 0) return maxSec;

    const load = Math.min(1, bitrate / throughput);
    return clamp(Math.round(minSec + (maxSec - minSec) * load), minSec, maxSec);
  }

  setMediaInfo({ size, durationSec }) {
    this.mediaSizeBytes = Number.isFinite(size) ? size : null;
    this.mediaDurationSec = Number.isFinite(durationSec) ? durationSec : null;
  }

  /**
   * 用一次小范围请求实测下载带宽。
   * 取 1 MiB：局域网下几毫秒，跨洋链路下约一秒，代价可以忽略。
   */
  async probeThroughput(bytes = 1 << 20) {
    const url = this.video.currentSrc || this.video.src;
    if (!url) return null;

    try {
      const started = performance.now();
      const res = await fetch(url, {
        headers: { Range: `bytes=0-${bytes - 1}` },
        cache: 'no-store',
      });
      if (!res.ok && res.status !== 206) return null;
      const buf = await res.arrayBuffer();
      const seconds = (performance.now() - started) / 1000;
      if (seconds <= 0 || buf.byteLength < 4096) return null;

      const bps = buf.byteLength / seconds;
      // 只保留更好的那次测量：网络抖动会让某次偏慢，但不该因此把缓冲需求抬高
      this.measuredThroughputBps = Math.max(this.measuredThroughputBps || 0, bps);
      this.emitStatus();
      return this.measuredThroughputBps;
    } catch {
      return null;
    }
  }

  /**
   * 持续评估缓冲就绪状态并上报。
   *
   * 必须独立于"房间是否在播放"运行：一旦我们因为缓冲不足把房间按停，
   * 房间会变成 playing=false；若评估也依赖 playing，就再没有机会报告就绪，
   * 整个房间会永久停在"等待缓冲"。
   */
  evaluateReadiness() {
    if (this.blocked) {
      // 还没拿到播放许可（iOS 需要一次手势），先让房间等我们
      this.setBuffering(true);
      return;
    }

    if (this.isReadyToPlay()) {
      this.waitingForBuffer = false;
      this.bufferWaitStartedAt = 0;
      this.setBuffering(false);
      return;
    }

    if (!this.waitingForBuffer) {
      this.waitingForBuffer = true;
      this.bufferWaitStartedAt = Date.now();
    }

    // 宽限期：刚拖动完进度条必然短暂没有缓冲，不该立刻把整个房间按停，
    // 否则每次 seek 都会触发一轮"等待缓冲 + 倒数"，手感很拖沓。
    const grace = this.settings.bufferingGraceMs ?? 400;
    if (Date.now() - this.bufferWaitStartedAt < grace) return;

    this.setBuffering(true);
  }

  maybePlay() {
    // 没缓冲够就不要急着 play()，否则视频元素会处于"播放中但推进不了"的假活状态
    if (this.blocked || !this.isReadyToPlay()) return;
    this.programmatic(() => {
      const p = this.video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    });
  }

  setBuffering(buffering) {
    const next = Boolean(buffering);
    if (this.reportedBuffering === next) return;
    this.reportedBuffering = next;
    if (!next) {
      this.waitingForBuffer = false;
      this.bufferWaitStartedAt = 0;
    }
    this.send({ t: 'buffering', buffering: next });
  }

  programmatic(fn) {
    this.suppress(400);
    fn();
  }

  // —— 上报 ——

  report() {
    if (!this.state) return;
    // 没有在放片子就完全不上报：页面开着但没人看的时候不该有任何周期性流量
    if (!this.state.mediaId) return;

    const best = this.samples.reduce((a, b) => (a && a.rtt <= b.rtt ? a : b), null);
    this.send({
      t: 'report',
      pos: Number(this.video.currentTime.toFixed(3)),
      rttMs: best ? Math.round(best.rtt) : null,
    });
  }

  // —— 本地操作 ——

  localPlay() {
    this.intendPlaying = true;
    this.suppress(1200);
    this.setBuffering(false);
    this.programmatic(() => {
      const p = this.video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    });
    this.send({
      t: 'intent',
      action: 'play',
      pos: Number(this.video.currentTime.toFixed(3)),
      durationSec: Number.isFinite(this.video.duration) ? this.video.duration : null,
    });
    this.emitStatus();
  }

  localPause() {
    this.intendPlaying = false;
    this.suppress(1200);
    this.programmatic(() => this.video.pause());
    this.send({ t: 'intent', action: 'pause', pos: Number(this.video.currentTime.toFixed(3)) });
    this.emitStatus();
  }

  localSeek(position) {
    this.suppress(1800);
    try {
      this.video.currentTime = Math.max(0, position);
    } catch {
      /* 忽略 */
    }
    this.send({
      t: 'intent',
      action: 'seek',
      pos: Number(Math.max(0, position).toFixed(3)),
      durationSec: Number.isFinite(this.video.duration) ? this.video.duration : null,
    });
    this.emitStatus();
  }

  // —— 状态输出 ——

  emitStatus() {
    if (!this.state) return;
    const serverMs = this.serverNow();
    this.onStatus({
      clockOffsetMs: Math.round(this.clockOffsetMs),
      hasClock: this.hasClock,
      driftMs: this.state.playing ? Math.round((this.video.currentTime - this.targetPos(serverMs)) * 1000) : null,
      bufferedAheadSec: this.bufferedAheadSec(),
      targetPos: this.targetPos(serverMs),
      peers: this.state.clients || [],
      waiting: this.state.waiting || [],
      holdReason: this.state.holdReason,
      playing: this.state.playing,
      countingDown: this.state.playing && serverMs < this.state.anchorServerMs,
      rate: this.video.playbackRate,
      isIOS: this.isIOS,
      nextUp: this.state.nextUp || null,
      autoPlayNext: this.state.autoPlayNext !== false,
      hardSeekCount: this.hardSeekCount,
      requiredBufferSec: this.requiredBufferSec(),
      throughputMbps:
        this.measuredThroughputBps != null
          ? Number(((this.measuredThroughputBps * 8) / 1e6).toFixed(1))
          : null,
    });
  }
}
