/**
 * 屏幕共享（WebRTC 直连）。
 *
 * 角色：
 *   · 共享者：用 getDisplayMedia 采集屏幕，给房间里每个观看者各建一条 WebRTC 连接
 *   · 观看者：接收共享者的画面，渲染到 <video> 上
 *
 * 关键点：**画面走 P2P 直连，完全不经过服务端**。服务端只转发 SDP 和 ICE 候选。
 *
 * 安全上下文限制（实测结论）：
 *   getDisplayMedia 只在安全上下文可用 —— https:// 或 http://127.0.0.1 / localhost。
 *   所以"采集端"必须在电脑上用 127.0.0.1 打开页面；普通局域网 IP 下按钮不会出现。
 */

export class ScreenShare {
  constructor({ send, onRemoteStream, onRemoteEnded, onStatus }) {
    this.send = send;
    this.onRemoteStream = onRemoteStream || (() => {});
    this.onRemoteEnded = onRemoteEnded || (() => {});
    this.onStatus = onStatus || (() => {});

    /** 我正在共享时的采集流 */
    this.localStream = null;
    /** 我是共享者时：viewerId -> { pc } */
    this.peers = new Map();
    /** 我是观看者时：与共享者的那一条连接 */
    this.viewerPc = null;
    this.presenterId = null;

    this.iceServers = [];
    this.lastError = null;
    /** 刚开始共享的时刻：用来忽略抢跑回传的房间状态 */
    this.startedAt = 0;

    /** 采集与编码参数（可由服务端配置覆盖） */
    this.frameRate = 60;
    this.maxBitrate = 8_000_000;
    /**
     * 带宽不足时牺牲谁。
     * 默认 'maintain-resolution'：共享屏幕主要是看内容（文档、网页、代码），
     * 糊掉就没意义了；宁可帧率掉一点。
     */
    this.degradationPreference = 'maintain-resolution';
  }

  /** 这台设备能不能采集屏幕（电脑上多半可以，手机基本不行） */
  static canCapture() {
    return Boolean(
      window.isSecureContext &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getDisplayMedia === 'function' &&
        typeof window.RTCPeerConnection === 'function'
    );
  }

  /** 能不能看别人共享（只需要 RTCPeerConnection，HTTP 下也可用） */
  static canReceive() {
    return typeof window.RTCPeerConnection === 'function';
  }

  get isSharing() {
    return Boolean(this.localStream);
  }

  get isWatching() {
    return Boolean(this.viewerPc);
  }

  setIceServers(list) {
    this.iceServers = Array.isArray(list) ? list : [];
  }

  /**
   * 设置采集帧率与码率上限。
   * 只设采集端还不够 —— 浏览器的编码器会按自己的判断把帧率压到 30，
   * 所以发送端也要显式声明 maxFramerate（见 tuneSender）。
   */
  setEncoding({ frameRate, maxBitrateMbps, degradationPreference } = {}) {
    if (Number.isFinite(frameRate) && frameRate > 0) this.frameRate = frameRate;
    if (Number.isFinite(maxBitrateMbps) && maxBitrateMbps > 0) {
      this.maxBitrate = maxBitrateMbps * 1_000_000;
    }
    if (degradationPreference) this.degradationPreference = String(degradationPreference);
  }

  /** 我正在共享时，采集流里有没有声音轨 */
  get localHasAudio() {
    return Boolean(this.localStream && this.localStream.getAudioTracks().length > 0);
  }

  /** 采集屏幕并开始共享 */
  async startCapture() {
    this.lastError = null;
    if (!ScreenShare.canCapture()) {
      this.lastError = window.isSecureContext
        ? '这个浏览器不支持屏幕采集'
        : '屏幕采集需要安全上下文：请在电脑上用 http://127.0.0.1:8080 打开本页面（或等 HTTPS 配好）';
      throw new Error(this.lastError);
    }

    const videoConstraints = { frameRate: { ideal: this.frameRate, max: this.frameRate } };

    let stream;
    try {
      // 连声音一起采。注意：Windows 上共享"整个屏幕"时，浏览器弹窗里
      // 需要手动勾选「分享系统音频」，否则只有画面没有声音。
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: true,
      });
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        this.lastError = '你取消了共享';
        throw err;
      }
      // 有些浏览器/平台不支持采集音频，退化成纯画面，不要让整个共享失败
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: videoConstraints,
          audio: false,
        });
      } catch (err2) {
        this.lastError = String((err2 && err2.message) || err2);
        throw err2;
      }
    }

    this.startWithStream(stream, '屏幕');
    this.onStatus({ sharing: true, hasAudio: this.localHasAudio });
    return stream;
  }

  /**
   * 用一个现成的流开始共享。
   * 除了内部复用，也供自动化测试注入 canvas 流来验证整条链路。
   */
  startWithStream(stream, label = '屏幕') {
    this.stopLocal({ announce: false });
    this.localStream = stream;
    this.startedAt = Date.now();

    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        // 用户点了浏览器自带的"停止共享"
        if (this.localStream) this.stopLocal({ announce: true });
      });
    }

    this.send({ t: 'share-start' });
    this.onStatus({ sharing: true, label, viewers: 0 });
  }

  stopLocal({ announce = true } = {}) {
    if (!this.localStream) return;
    for (const track of this.localStream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* 忽略 */
      }
    }
    this.localStream = null;

    for (const [, entry] of this.peers) {
      try {
        entry.pc.close();
      } catch {
        /* 忽略 */
      }
    }
    this.peers.clear();

    if (announce) this.send({ t: 'share-stop' });
    this.onStatus({ sharing: false, viewers: 0 });
  }

  /** 房间成员变化时调用：给新来的观看者补一条连接，给走掉的收掉 */
  syncPeers(clients, myId) {
    if (!this.localStream) return;

    const viewerIds = new Set((clients || []).map((c) => c.id).filter((cid) => cid && cid !== myId));
    for (const viewerId of viewerIds) {
      if (!this.peers.has(viewerId)) this.createConnectionFor(viewerId).catch(() => {});
    }
    for (const [viewerId, entry] of [...this.peers]) {
      if (!viewerIds.has(viewerId)) {
        try {
          entry.pc.close();
        } catch {
          /* 忽略 */
        }
        this.peers.delete(viewerId);
      }
    }
    this.onStatus({ sharing: true, viewers: this.peers.size });
  }

  /**
   * 显式告诉编码器帧率与码率上限。
   *
   * 只把 frameRate 写进 getDisplayMedia 的约束是不够的：那约束的是"采集"，
   * 编码/发送侧仍可能自行降到 30fps。要真正跑到 60fps，必须在 sender 上声明。
   */
  async tuneSender(sender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxFramerate = this.frameRate;
      params.encodings[0].maxBitrate = this.maxBitrate;
      params.degradationPreference = this.degradationPreference;
      await sender.setParameters(params);
    } catch {
      /* 部分浏览器不允许改写编码参数，忽略即可 */
    }
  }

  /** 读取共享端实际的编码参数，用于自检与测试 */
  async describeSenders() {
    const out = [];
    for (const [viewerId, entry] of this.peers) {
      try {
        const params = entry.pc.getSenders()[0].getParameters();
        out.push({
          viewerId,
          maxFramerate: params.encodings && params.encodings[0] ? params.encodings[0].maxFramerate : null,
          maxBitrate: params.encodings && params.encodings[0] ? params.encodings[0].maxBitrate : null,
          degradationPreference: params.degradationPreference || null,
        });
      } catch {
        out.push({ viewerId, error: true });
      }
    }
    return out;
  }

  async createConnectionFor(viewerId) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const entry = { pc };
    this.peers.set(viewerId, entry);

    for (const track of this.localStream.getTracks()) {
      const sender = pc.addTrack(track, this.localStream);
      // 只对视频调编码参数；给音频设 maxFramerate/maxBitrate 没有意义
      if (track.kind === 'video') this.tuneSender(sender).catch(() => {});
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) this.send({ t: 'rtc-ice', to: viewerId, candidate: event.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        try {
          pc.close();
        } catch {
          /* 忽略 */
        }
        this.peers.delete(viewerId);
      }
      this.onStatus({ sharing: true, viewers: this.peers.size, connectionState: pc.connectionState });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send({ t: 'rtc-offer', to: viewerId, sdp: pc.localDescription });
  }

  /** 处理收到的信令消息；返回 true 表示已消费 */
  async handleMessage(msg) {
    if (msg.t === 'rtc-offer') {
      await this.acceptOffer(msg);
      return true;
    }
    if (msg.t === 'rtc-answer') {
      const entry = this.peers.get(msg.from);
      if (entry) await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      return true;
    }
    if (msg.t === 'rtc-ice') {
      await this.addIce(msg);
      return true;
    }
    return false;
  }

  /** 观看端：收到的画面里有没有声音 */
  get remoteHasAudio() {
    const stream = this.remoteStream;
    return Boolean(stream && stream.getAudioTracks().length > 0);
  }

  async acceptOffer(msg) {
    if (!ScreenShare.canReceive()) return;

    const presenterId = msg.from;

    // 换共享者时先把旧连接收掉
    if (this.viewerPc && this.presenterId !== presenterId) this.teardownViewer();

    if (!this.viewerPc) {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      this.viewerPc = pc;
      pc.onicecandidate = (event) => {
        if (event.candidate) this.send({ t: 'rtc-ice', to: presenterId, candidate: event.candidate });
      };
      pc.ontrack = (event) => {
        const stream = (event.streams && event.streams[0]) || new MediaStream([event.track]);
        this.remoteStream = stream;
        this.onRemoteStream(stream);
      };
      pc.onconnectionstatechange = () => {
        this.onStatus({ watching: true, connectionState: pc.connectionState });
        if (['failed', 'closed'].includes(pc.connectionState)) this.teardownViewer();
      };
    }

    this.presenterId = presenterId;
    const pc = this.viewerPc;
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.send({ t: 'rtc-answer', to: presenterId, sdp: pc.localDescription });
    this.onStatus({ watching: true, presenterId });
  }

  async addIce(msg) {
    const candidate = msg.candidate ? new RTCIceCandidate(msg.candidate) : null;
    if (!candidate) return;

    const entry = this.peers.get(msg.from);
    if (entry) {
      await entry.pc.addIceCandidate(candidate).catch(() => {});
      return;
    }
    if (this.viewerPc && this.presenterId === msg.from) {
      await this.viewerPc.addIceCandidate(candidate).catch(() => {});
    }
  }

  teardownViewer() {
    if (this.viewerPc) {
      try {
        this.viewerPc.close();
      } catch {
        /* 忽略 */
      }
    }
    this.viewerPc = null;
    this.presenterId = null;
    this.remoteStream = null;
    this.onRemoteEnded();
    this.onStatus({ watching: false });
  }

  /** 房间显示"没人在共享"时调用 */
  handleSharingInactive(myId, presenterId) {
    if (presenterId === myId) return;
    if (this.localStream) {
      // 刚点下"共享"的头两秒忽略状态回传，否则会抢在服务端确认之前把自己的流掐掉
      if (Date.now() - this.startedAt < 2000) return;
      this.stopLocal({ announce: false });
    }
    if (this.viewerPc) this.teardownViewer();
  }
}
