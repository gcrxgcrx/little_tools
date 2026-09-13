'use strict';

/**
 * 屏幕共享的信令中转。
 *
 * 服务端只做两件事：
 *   1. 记录"当前谁在共享屏幕"这个状态（跟放映状态一样是房间级的）
 *   2. 在两端之间转发 SDP 与 ICE 候选
 *
 * **画面本身完全不走服务端** —— 它是 WebRTC 直连（P2P），
 * 所以分享屏幕不会让视频内容经过这台机器之外的任何地方，
 * 也不消耗额外带宽在服务器上转一圈。
 */

const RELAY_TYPES = new Set(['rtc-offer', 'rtc-answer', 'rtc-ice']);

function createRtcRelay({ room }) {
  return {
    /**
     * 处理信令消息。
     * @returns {boolean} true 表示这条消息已被本模块消费
     */
    handle(clientId, msg, sendTo) {
      if (!RELAY_TYPES.has(msg.t)) return false;

      const target = String(msg.to || '');
      if (!target) return true;

      // 目标不在房间里就直接丢掉，不要报错刷屏（对端可能刚好断线）
      const exists = room.clients && typeof room.clients.has === 'function' && room.clients.has(target);
      if (!exists) return true;

      const payload = { t: msg.t, from: clientId };
      if (msg.sdp) payload.sdp = msg.sdp;
      if (msg.candidate !== undefined) payload.candidate = msg.candidate;

      sendTo(target, payload);
      return true;
    },

    /** 开始共享：把这个人记为房间的共享者 */
    start(clientId, name) {
      return room.setPresenter(clientId, name);
    },

    /** 结束共享；只有正在共享的那个人能结束 */
    stop(clientId) {
      return room.clearPresenter(clientId);
    },
  };
}

module.exports = { createRtcRelay, RELAY_TYPES };
