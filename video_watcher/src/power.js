'use strict';

/**
 * 播完关机。
 *
 * 安全设计（关机是不可逆操作，必须留足反悔空间）：
 *   1. **默认不武装** —— 必须由用户在界面上明确打开，且只对本次会话有效
 *   2. 触发后不是立刻关机，而是交给 Windows 自己的 `shutdown /t` 定时器，
 *      期间界面显示倒计时，手机上随时可以点"取消"
 *   3. 服务端退出时会取消待执行的关机，避免重启服务时被意外关机
 *   4. 支持 dryRun，测试时只打日志不真的执行
 */

const path = require('node:path');
const { execFile } = require('node:child_process');

const SHUTDOWN_EXE = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'shutdown.exe'
);

class PowerManager {
  constructor(options = {}) {
    this.enabled = options.enableShutdown !== false;
    this.delaySec = Number.isFinite(options.delaySec) ? Math.max(10, options.delaySec) : 120;
    this.onPlaylistEnd = options.onPlaylistEnd !== false;
    this.onEmptyRoomSec = Number.isFinite(options.onEmptyRoomSec) ? options.onEmptyRoomSec : 300;
    this.dryRun = Boolean(options.dryRun);
    this.log = typeof options.log === 'function' ? options.log : () => {};

    /** 是否已由用户在本会话中开启 */
    this.armed = false;
    /** 已安排的关机时刻（毫秒时间戳），null 表示没有待执行任务 */
    this.scheduledAtMs = null;
    this.reason = null;
    /** 房间从什么时刻开始变成空的 */
    this.emptySinceMs = null;
  }

  snapshot() {
    return {
      enabled: this.enabled,
      armed: this.armed,
      delaySec: this.delaySec,
      scheduledAtMs: this.scheduledAtMs,
      remainingMs: this.scheduledAtMs ? Math.max(0, this.scheduledAtMs - Date.now()) : null,
      reason: this.reason,
      dryRun: this.dryRun,
    };
  }

  arm(armed, reason) {
    if (!this.enabled) return this.snapshot();
    this.armed = Boolean(armed);
    if (this.armed) {
      this.reason = reason || '播完关机已开启';
      this.log('播完关机：已开启');
    } else {
      this.cancel('用户关闭播完关机');
    }
    return this.snapshot();
  }

  markRoomEmpty() {
    if (this.emptySinceMs == null) this.emptySinceMs = Date.now();
  }

  markRoomOccupied() {
    this.emptySinceMs = null;
  }

  shouldShutdownForIdle() {
    if (!this.armed || !this.onEmptyRoomSec || this.emptySinceMs == null) return false;
    if (this.scheduledAtMs) return false;
    return Date.now() - this.emptySinceMs >= this.onEmptyRoomSec * 1000;
  }

  schedule(reason) {
    if (!this.enabled || !this.armed || this.scheduledAtMs) return this.snapshot();

    this.scheduledAtMs = Date.now() + this.delaySec * 1000;
    this.reason = reason || this.reason;
    this.log(`已安排 ${this.delaySec} 秒后关机 —— ${this.reason}`);

    if (this.dryRun) {
      this.log('[dryRun] 跳过真正的 shutdown 调用');
      return this.snapshot();
    }

    execFile(SHUTDOWN_EXE, ['/s', '/t', String(this.delaySec), '/c', `观影室: ${this.reason}`], (err) => {
      if (err) this.log(`调用关机命令失败: ${err.message}`);
    });
    return this.snapshot();
  }

  cancel(reason) {
    const wasScheduled = Boolean(this.scheduledAtMs);
    this.scheduledAtMs = null;
    this.reason = this.armed ? this.reason : null;

    if (wasScheduled && !this.dryRun) {
      execFile(SHUTDOWN_EXE, ['/a'], (err) => {
        if (err) this.log(`取消关机未成功（可能本来就没有待执行任务）: ${err.message}`);
      });
    }
    if (wasScheduled) {
      this.log(`已取消关机 —— ${reason || '手动取消'}`);
      if (!this.armed) this.reason = null;
    }
    return this.snapshot();
  }
}

module.exports = { PowerManager, SHUTDOWN_EXE };
