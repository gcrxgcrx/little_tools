'use strict';

/**
 * 房间状态机：唯一权威时间轴。
 *
 * 核心不变式：
 *   playing 时，任意服务器时刻 t 的期望播放位置为
 *       targetPos(t) = anchorPos + (t - anchorServerMs) / 1000 * rate
 *   paused 时，期望位置恒为 anchorPos。
 *
 * 客户端只上报"意图"（play/pause/seek），由本类更新 anchor 并广播，
 * 所有客户端（含发起者）一律以广播结果为准 —— 这样双人同时操作不会打架。
 *
 * 倒计时的实现很取巧但很干净：把 anchorServerMs 设为"未来某时刻"，
 * 客户端看到 playing 但 serverNow < anchorServerMs 时自然就进入倒数等待，
 * 到点后位置公式自动开始走动。不需要额外的倒计时消息。
 */

const BUFFERING_RESUME_DELAY_MS = 3200;

/**
 * 超过这么久没有任何消息的客户端视为"失联"。
 *
 * 为什么需要这个：跨洋链路上手机掉线往往不是干净断开（锁屏、切后台、信号丢失），
 * 服务端的 TCP 层可能要很久才发现。如果这个客户端恰好在"缓冲中"状态，
 * 它会永久按住整个房间（大家看到"等待缓冲"却永远等不到）。
 * 所以等待判定必须排除失联客户端 —— 但**不**把它踢出房间，
 * 这样它恢复后（比如 iOS 从后台回来）发一条消息就能重新参与，无需重新加入。
 */
const CLIENT_STALE_MS = 12000;

class Room {
  constructor({ onChange, resumeCountdownMs } = {}) {
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.resumeCountdownMs = Number.isFinite(resumeCountdownMs)
      ? resumeCountdownMs
      : BUFFERING_RESUME_DELAY_MS;
    this.clients = new Map();

    this.mediaId = null;
    this.mediaDurationSec = null;
    this.playing = false;
    this.anchorPos = 0;
    this.anchorServerMs = Date.now();
    this.rate = 1;
    this.resumeFrom = null;
    this.resumeSavedPosition = null;

    /** 正在共享屏幕的客户端 id（null 表示没有人在共享） */
    this.presenterId = null;
    this.presenterName = null;

    /** 因缓冲不足而暂停时记录的原因，用于恢复后播报 */
    this.holdReason = null;
  }

  now() {
    return Date.now();
  }

  targetPos(serverMs = this.now()) {
    if (!this.playing) return this.anchorPos;
    const elapsed = (serverMs - this.anchorServerMs) / 1000;
    if (elapsed <= 0) return this.anchorPos;
    return this.anchorPos + elapsed * this.rate;
  }

  isStale(client, now = this.now()) {
    return now - (client.lastSeenMs || 0) > CLIENT_STALE_MS;
  }

  /** 只有"活着且在缓冲"的客户端才算等待，失联者不能按住房间 */
  get waitingClients() {
    const now = this.now();
    return [...this.clients.values()]
      .filter((c) => c.buffering && !this.isStale(c, now))
      .map((c) => c.id);
  }

  /** 收到该客户端的任何消息都刷新它的存活时间 */
  touch(id) {
    const client = this.clients.get(id);
    if (client) client.lastSeenMs = this.now();
  }

  /**
   * 清理长时间没有任何消息的客户端。
   *
   * 为什么需要：浏览器被强杀、标签页崩溃、或者只是网络断了，TCP 层可能很久都不报错；
   * 而 WebSocket 协议层的 ping/pong 是由浏览器自动回复的，即使页面已经不再发任何
   * 应用层消息，服务端也会认为它"活着"。结果就是房间里堆着永远不走的幽灵。
   *
   * 被清理掉的客户端不必担心：它只要再发一条消息，服务端会自动把它重新加回来。
   */
  pruneStale(maxAgeMs = 60000) {
    const now = this.now();
    let removed = 0;

    for (const [id, client] of [...this.clients]) {
      if (now - (client.lastSeenMs || 0) > maxAgeMs) {
        this.clients.delete(id);
        removed += 1;
      }
    }

    if (removed > 0) {
      if (this.clients.size === 0) {
        this.anchorPos = this.targetPos();
        this.playing = false;
        this.holdReason = null;
      }
      this.emit({ action: 'prune-stale', removed });
    }
    return removed;
  }

  isCountingDown(serverMs = this.now()) {
    return this.playing && serverMs < this.anchorServerMs;
  }

  snapshot() {
    const serverMs = this.now();
    return {
      serverMs,
      mediaId: this.mediaId,
      mediaDurationSec: this.mediaDurationSec,
      playing: this.playing,
      anchorPos: this.anchorPos,
      anchorServerMs: this.anchorServerMs,
      rate: this.rate,
      targetPos: this.targetPos(serverMs),
      countingDown: this.isCountingDown(serverMs),
      countdownMs: Math.max(0, this.anchorServerMs - serverMs),
      holdReason: this.holdReason,
      resumeFrom: this.resumeFrom,
      resumeSavedPosition: this.resumeSavedPosition,
      sharing: {
        active: Boolean(this.presenterId),
        presenterId: this.presenterId,
        presenterName: this.presenterName,
      },
      waiting: this.waitingClients,
      clients: [...this.clients.values()].map((c) => ({
        id: c.id,
        name: c.name,
        isIOS: c.isIOS,
        buffering: c.buffering,
        stale: this.isStale(c, serverMs),
        lastPos: c.lastPos,
        lastReportMs: c.lastReportMs,
        rttMs: c.rttMs,
      })),
    };
  }

  addClient(client) {
    this.clients.set(client.id, client);
    this.emit();
  }

  removeClient(id) {
    const existed = this.clients.delete(id);
    if (existed) {
      // 共享屏幕的人走了，共享状态也要跟着结束，否则其他人会一直等一个不会来的画面
      if (this.presenterId === id) {
        this.presenterId = null;
        this.presenterName = null;
      }
      // 若唯一在线的人走了，房间保持在暂停状态，避免空转
      if (this.clients.size === 0) {
        this.anchorPos = this.targetPos();
        this.playing = false;
        this.holdReason = null;
      }
      this.emit();
    }
  }

  /** 开始共享屏幕 */
  setPresenter(clientId, name) {
    if (this.presenterId === clientId) return this.snapshot();
    const client = this.clients.get(clientId);
    this.presenterId = clientId;
    this.presenterName = name || (client && client.name) || '未知设备';
    this.emit({ action: 'share-start' });
    return this.snapshot();
  }

  /** 结束共享；只有当前共享者可以结束 */
  clearPresenter(clientId) {
    if (!this.presenterId) return this.snapshot();
    if (clientId && this.presenterId !== clientId) return this.snapshot();
    this.presenterId = null;
    this.presenterName = null;
    this.emit({ action: 'share-stop' });
    return this.snapshot();
  }

  updateClient(id, patch) {
    const client = this.clients.get(id);
    if (!client) return;
    Object.assign(client, patch);
  }

  /**
   * 切换媒体。
   * @param {object} [options]
   * @param {boolean} [options.autoStart] 切完自动开始（用于连播）
   * @param {number}  [options.countdownMs] 自动开始时先倒数多久
   * @param {string}  [options.by] 发起换片的客户端 id
   * @param {number}  [options.startPos] 起始位置（断点续播）
   * @param {number}  [options.savedPositionSec] 断点原始位置
   */
  setMedia(mediaId, durationSec, options = {}) {
    this.mediaId = mediaId;
    this.mediaDurationSec = Number.isFinite(durationSec) ? durationSec : null;
    this.anchorPos = Number.isFinite(options.startPos) ? Math.max(0, options.startPos) : 0;
    /** 本次是从断点续播的：起点位置与断点原始位置 */
    this.resumeFrom = Number.isFinite(options.startPos) && options.startPos >= 1 ? options.startPos : null;
    this.resumeSavedPosition = Number.isFinite(options.savedPositionSec)
      ? options.savedPositionSec
      : null;
    this.holdReason = null;
    for (const client of this.clients.values()) client.buffering = false;

    if (options.autoStart) {
      // 复用倒数机制：锚点设在未来，客户端看到 playing 但还没到点就会显示倒数
      this.playing = true;
      this.anchorServerMs = this.now() + (Number(options.countdownMs) || 0);
    } else {
      this.playing = false;
      this.anchorServerMs = this.now();
    }

    // by 用于告诉其他客户端"是谁换的片"，以便在对方界面上给出提示；
    // 自动连播时没有 by，属于系统行为，不需要提示。
    this.emit({
      action: 'set-media',
      by: options.by || null,
      autoStart: Boolean(options.autoStart),
    });
  }

  applyIntent(clientId, action, pos, durationSec) {
    const position = Number.isFinite(pos) ? Math.max(0, pos) : this.targetPos();
    if (Number.isFinite(durationSec) && durationSec > 0) this.mediaDurationSec = durationSec;

    switch (action) {
      case 'play': {
        if (this.waitingClients.length > 0) {
          // 有人还没缓冲好，先按住，等所有人就绪
          this.playing = false;
          this.anchorPos = position;
          this.anchorServerMs = this.now();
          this.holdReason = '等待对方缓冲';
          break;
        }
        this.playing = true;
        this.anchorPos = position;
        this.anchorServerMs = this.now();
        this.holdReason = null;
        break;
      }
      case 'pause': {
        this.playing = false;
        this.anchorPos = position;
        this.anchorServerMs = this.now();
        this.holdReason = null;
        break;
      }
      case 'seek': {
        this.anchorPos = position;
        this.anchorServerMs = this.now();
        if (this.playing && this.waitingClients.length > 0) {
          this.playing = false;
          this.holdReason = '等待对方缓冲';
        }
        break;
      }
      default:
        return;
    }

    this.emit({ by: clientId, action });
  }

  setBuffering(clientId, buffering) {
    const client = this.clients.get(clientId);
    if (!client || client.buffering === buffering) return;

    client.buffering = buffering;

    if (buffering) {
      if (this.playing) {
        this.anchorPos = this.targetPos();
        this.playing = false;
        this.holdReason = '等待缓冲';
      }
      this.emit({ by: clientId, action: 'buffering' });
      return;
    }

    // 变为就绪：若所有人都不在缓冲且此前是被按住的，则起倒数
    if (this.waitingClients.length === 0 && this.holdReason) {
      this.playing = true;
      this.anchorServerMs = this.now() + this.resumeCountdownMs;
      this.holdReason = null;
      this.emit({ by: clientId, action: 'resume-countdown' });
      return;
    }

    this.emit({ by: clientId, action: 'ready' });
  }

  report(id, pos, rttMs) {
    const client = this.clients.get(id);
    if (!client) return;
    if (Number.isFinite(pos)) client.lastPos = pos;
    if (Number.isFinite(rttMs)) client.rttMs = rttMs;
    client.lastReportMs = this.now();
    // 位置上报不触发广播，避免高频抖动
  }

  emit(meta) {
    this.onChange(this.snapshot(), meta || null);
  }
}

module.exports = { Room, BUFFERING_RESUME_DELAY_MS, CLIENT_STALE_MS };
