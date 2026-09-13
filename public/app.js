import { SyncClient } from './sync-client.js';
import { ScreenShare } from './screen-share.js';

const $ = (id) => document.getElementById(id);

const dom = {
  login: $('login'),
  pinInput: $('pinInput'),
  pinBtn: $('pinBtn'),
  pinError: $('pinError'),
  backBtn: $('backBtn'),
  title: $('title'),
  conn: $('conn'),
  libraryView: $('libraryView'),
  libStatus: $('libStatus'),
  libList: $('libList'),
  rescanBtn: $('rescanBtn'),
  playerView: $('playerView'),
  video: $('video'),
  unlock: $('unlock'),
  countdown: $('countdown'),
  holdBanner: $('holdBanner'),
  seek: $('seek'),
  playBtn: $('playBtn'),
  back10: $('back10'),
  fwd10: $('fwd10'),
  timeLabel: $('timeLabel'),
  fsBtn: $('fsBtn'),
  localBtn: $('localBtn'),
  downloadBtn: $('downloadBtn'),
  localFile: $('localFile'),
  restartBtn: $('restartBtn'),
  powerBtn: $('powerBtn'),
  resumeNotice: $('resumeNotice'),
  resumeText: $('resumeText'),
  resumeDismiss: $('resumeDismiss'),
  powerNotice: $('powerNotice'),
  powerText: $('powerText'),
  powerCancel: $('powerCancel'),
  shareBtn: $('shareBtn'),
  shareBar: $('shareBar'),
  shareText: $('shareText'),
  shareWatchBtn: $('shareWatchBtn'),
  shareStopBtn: $('shareStopBtn'),
  shareStage: $('shareStage'),
  shareVideo: $('shareVideo'),
  shareHint: $('shareHint'),
  shareStageText: $('shareStageText'),
  shareStageFs: $('shareStageFs'),
  shareSoundBtn: $('shareSoundBtn'),
  shareClose: $('shareClose'),
  hud: $('hud'),
};

const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let settings = {
  clientBufferAheadSec: 20,
  minBufferAheadSec: 5,
  adaptiveBuffer: true,
  bufferWaitTimeoutSec: 90,
  bufferingGraceMs: 400,
  iosLazySeek: { thresholdMs: 200, minIntervalSec: 120 },
  desktopRateNudge: { deadZoneMs: 60, hardSeekMs: 800, gain: 0.5, rateClamp: 0.04 },
};

let ws = null;
let sync = null;
let reconnectDelay = 1000;
let libraryItems = [];
let currentItem = null;
let unlocked = false;
let scrubbing = false;
let wakeLock = null;

/** 本地文件模式：她提前把整片下到手机，播放时完全不占国际带宽 */
let localFileUrl = null;
let localFileMeta = null;
let lastStatus = null;
let lastRoomState = null;
/** 已经提示过断点的媒体 id，避免同一次播放反复弹 */
let resumeNoticeFor = null;

/** 屏幕共享 */
let screenShare = null;
let myClientId = null;
let remoteShareStream = null;

// —— 工具 ——

function fmtDur(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setConn(text, state) {
  dom.conn.textContent = text;
  dom.conn.className = `conn${state ? ` ${state}` : ''}`;
}

// —— 网络 ——

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  if (res.status === 401) {
    showLogin();
    const err = new Error('unauthorized');
    err.code = 401;
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function showLogin() {
  dom.login.classList.remove('hidden');
}

function hideLogin() {
  dom.login.classList.add('hidden');
}

async function doLogin() {
  const pin = dom.pinInput.value.trim();
  if (!pin) return;
  dom.pinError.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!res.ok) {
      dom.pinError.textContent = '访问码不对';
      return;
    }
    hideLogin();
    await boot();
  } catch {
    dom.pinError.textContent = '连接失败';
  }
}

function wsSend(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    reconnectDelay = 1000;
    setConn('已连接', 'on');
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };

  ws.onclose = () => {
    setConn('已断开，重连中…', 'off');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };

  ws.onerror = () => {};
}

function handleMessage(msg) {
  // 屏幕共享的信令直接交给共享模块处理
  if (msg.t === 'rtc-offer' || msg.t === 'rtc-answer' || msg.t === 'rtc-ice') {
    ensureShare()
      .handleMessage(msg)
      .catch((err) => console.warn('屏幕共享信令处理失败:', err));
    return;
  }

  switch (msg.t) {
    case 'welcome': {
      if (msg.settings) settings = { ...settings, ...msg.settings };
      myClientId = msg.clientId;
      ensureSync();
      const share = ensureShare();
      if (msg.settings) {
        if (msg.settings.rtcIceServers) share.setIceServers(msg.settings.rtcIceServers);
        share.setEncoding({
          frameRate: msg.settings.rtcFrameRate,
          maxBitrateMbps: msg.settings.rtcMaxBitrateMbps,
          degradationPreference: msg.settings.rtcDegradationPreference,
        });
      }
      wsSend({ t: 'hello', name: deviceName(), isIOS });
      if (currentItem) wsSend({ t: 'load', mediaId: currentItem.id });
      lastRoomState = msg.state;
      maybeShowResumeNotice(msg.state);
      updatePowerNotice();
      updateSharing(msg.state);
      break;
    }
    case 'state':
      if (sync) sync.onState(msg.state);
      lastRoomState = msg.state;
      maybeShowResumeNotice(msg.state);
      updatePowerNotice();
      updateSharing(msg.state);
      break;
    case 'pong':
      if (sync) sync.onPong(msg);
      break;
    case 'error':
      dom.libStatus.textContent = msg.message || '服务端报错';
      break;
    default:
      break;
  }
}

function deviceName() {
  if (isIOS) return 'iPhone';
  if (/Android/i.test(navigator.userAgent)) return 'Android';
  return '电脑';
}

function ensureSync() {
  if (sync) return;
  sync = new SyncClient({
    video: dom.video,
    isIOS,
    settings,
    send: wsSend,
    onStatus: renderHud,
    onCountdown: renderCountdown,
    onRemoteAction: (evt) => {
      if (evt.type === 'load') {
        const item = libraryItems.find((i) => i.id === evt.state.mediaId);
        if (item) openItem(item, false);
      }
    },
  });
  sync.blocked = !unlocked;
  sync.start();
}

// —— 片库 ——

async function boot() {
  try {
    const remoteSettings = await fetchJson('/api/settings');
    settings = { ...settings, ...remoteSettings };
  } catch (err) {
    if (err.code === 401) return;
  }

  await refreshLibrary();
  connect();
}

async function refreshLibrary() {
  try {
    const data = await fetchJson('/api/library');
    libraryItems = data.items || [];
    renderLibrary(data);
  } catch (err) {
    if (err.code !== 401) dom.libStatus.textContent = '片库读取失败';
  }
}

function renderLibrary(data) {
  const scanning = data.scanning ? '（正在扫描…）' : '';
  dom.libStatus.textContent =
    `共 ${libraryItems.length} 个视频${scanning}` +
    (data.builtAt ? ` · ${new Date(data.builtAt).toLocaleString('zh-CN')}` : '');

  dom.libList.innerHTML = '';

  if (libraryItems.length === 0) {
    dom.libList.append(
      el('p', 'muted small', scanning ? '正在扫描片库，请稍候…' : '没有找到视频文件，检查 config.json 的 roots 设置。')
    );
    return;
  }

  const groups = new Map();
  for (const item of libraryItems) {
    if (!groups.has(item.dir)) groups.set(item.dir, []);
    groups.get(item.dir).push(item);
  }

  for (const [dir, items] of groups) {
    const section = el('div');
    section.append(el('p', 'groupTitle', dir));

    for (const item of items) {
      const row = el('div', 'item');

      const meta = el('div', 'meta');
      meta.append(el('div', 'name', item.name));
      const bits = [fmtDur(item.durationSec), fmtSize(item.size), item.videoCodec, item.audioCodec]
        .filter(Boolean)
        .join(' · ');
      meta.append(el('div', 'sub', bits));
      row.append(meta);

      const level = item.playable ? item.iosLevel : 'bad';
      const label = level === 'ok' ? '可播' : level === 'warn' ? '注意' : '需处理';
      row.append(el('span', `badge ${level}`, label));

      row.addEventListener('click', () => openItem(item, true));
      section.append(row);
    }
    dom.libList.append(section);
  }
}

// —— 播放 ——

function showView(name) {
  const player = name === 'player';
  dom.playerView.classList.toggle('hidden', !player);
  dom.libraryView.classList.toggle('hidden', player);
  dom.backBtn.classList.toggle('hidden', !player);
  dom.title.textContent = player ? currentItem?.name || '' : '片库';
}

function openItem(item, announce) {
  currentItem = item;

  // 切换到服务器片源时，退出本地文件模式
  if (localFileUrl) {
    URL.revokeObjectURL(localFileUrl);
    localFileUrl = null;
    localFileMeta = null;
  }

  const target = new URL(`/media/${item.id}`, location.href).href;

  if (dom.video.src !== target) {
    dom.video.src = target;
    dom.video.load();
  }

  showView('player');
  dom.seek.value = 0;
  dom.timeLabel.textContent = `0:00 / ${fmtDur(item.durationSec)}`;

  if (!unlocked) dom.unlock.classList.remove('hidden');

  // 把片源体积/时长交给同步引擎，并实测一次带宽 —— 前置缓冲按链路自适应
  if (sync) {
    sync.setMediaInfo({ size: item.size, durationSec: item.durationSec });
    sync.probeThroughput().catch(() => {});
  }

  if (announce) {
    wsSend({ t: 'load', mediaId: item.id });
    if (sync) sync.suppress(1000);
  }
}

function unlockPlayback() {
  const video = dom.video;
  try {
    const previousMuted = video.muted;
    video.muted = true;
    const p = video.play();
    const finish = () => {
      video.pause();
      video.muted = previousMuted;
      video.currentTime = 0;
      unlocked = true;
      if (sync) {
        sync.blocked = false;
        if (sync.state) sync.hardAlign(sync.state);
      }
      dom.unlock.classList.add('hidden');
    };
    if (p && typeof p.then === 'function') p.then(finish).catch(finish);
    else finish();
  } catch {
    unlocked = true;
    if (sync) sync.blocked = false;
    dom.unlock.classList.add('hidden');
  }
}

// —— 本地文件模式：跨洋场景下提前下载整片，播放时完全不占国际带宽 ——

function downloadCurrent() {
  if (!currentItem) return;

  const ok = confirm(
    `将下载《${currentItem.name}》（${fmtSize(currentItem.size)}）到本机。\n\n` +
      '下载到的是服务端处理过的版本（hev1 已自动改写为 hvc1），iPhone 可直接播放。\n' +
      '下载完成后回到这个页面点「用本地文件播放」选中它，看片时就不再走国际带宽了。'
  );
  if (!ok) return;

  const link = document.createElement('a');
  link.href = `/media/${currentItem.id}`;
  link.download = currentItem.fileName;
  document.body.append(link);
  link.click();
  link.remove();
}

function useLocalFile(file) {
  if (!currentItem) {
    dom.libStatus.textContent = '请先在片库里选一个视频';
    return;
  }

  const url = URL.createObjectURL(file);
  const probe = document.createElement('video');
  probe.preload = 'metadata';
  probe.src = url;

  const accept = () => {
    if (localFileUrl) URL.revokeObjectURL(localFileUrl);
    localFileUrl = url;
    localFileMeta = { name: file.name, size: file.size };
    dom.video.src = url;
    dom.video.load();
    showView('player');
    if (sync) {
      sync.suppress(1500);
      if (sync.state) sync.hardAlign(sync.state);
    }
    if (lastStatus) renderHud(lastStatus);
  };

  probe.addEventListener('loadedmetadata', () => {
    const expected = currentItem.durationSec;
    const actual = probe.duration;
    if (Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(actual - expected) > 3) {
      const proceed = confirm(
        `本地文件时长 ${fmtDur(actual)} 与片库记录的 ${fmtDur(expected)} 不一致，` +
          '可能不是同一个版本，同步将失去意义。\n\n仍然使用？'
      );
      if (!proceed) {
        URL.revokeObjectURL(url);
        return;
      }
    }
    accept();
  });

  probe.addEventListener('error', () => {
    URL.revokeObjectURL(url);
    alert('无法读取这个视频文件（格式可能不被浏览器支持）');
  });
}

// —— 断点提示与播完关机 ——

function maybeShowResumeNotice(state) {
  if (!state || !state.mediaId) return;

  if (state.resumeFrom == null) {
    dom.resumeNotice.classList.add('hidden');
    resumeNoticeFor = null;
    return;
  }
  if (resumeNoticeFor === state.mediaId) return;

  resumeNoticeFor = state.mediaId;
  const saved = Number.isFinite(state.resumeSavedPosition)
    ? state.resumeSavedPosition
    : state.resumeFrom;
  dom.resumeText.textContent = `上次看到 ${fmtDur(saved)}，已为你回到 ${fmtDur(state.resumeFrom)} 继续`;
  dom.resumeNotice.classList.remove('hidden');
}

function powerSnapshot() {
  return (lastRoomState && lastRoomState.power) || null;
}

function updatePowerNotice() {
  const power = powerSnapshot();
  const armed = Boolean(power && power.armed);

  const label = `播完关机：${armed ? '开' : '关'}`;
  if (dom.powerBtn.textContent !== label) dom.powerBtn.textContent = label;
  dom.powerBtn.classList.toggle('primary', armed);

  if (!power || !power.scheduledAtMs) {
    dom.powerNotice.classList.add('hidden');
    return;
  }

  const remainMs = power.scheduledAtMs - (sync ? sync.serverNow() : Date.now());
  dom.powerText.textContent =
    remainMs > 0
      ? `将在 ${Math.ceil(remainMs / 1000)} 秒后关机（${power.reason || ''}）`
      : '正在关机…';
  dom.powerNotice.classList.remove('hidden');
}

// —— 屏幕共享 ——

/** 上一次同步给 WebRTC 的对端集合，用来避免重复建连（也避免递归） */
let lastSyncedPeerKey = '';

/** 只刷新共享提示条的文字，**不要**在这里做任何会反过来触发 onStatus 的事 */
function refreshShareBar() {
  const sharing = (lastRoomState && lastRoomState.sharing) || { active: false };
  if (!sharing.active) return;

  const iAmPresenter = sharing.presenterId === myClientId;
  if (iAmPresenter) {
    const viewers = screenShare ? screenShare.peers.size : 0;
    dom.shareText.textContent =
      viewers > 0 ? `你正在共享屏幕 · ${viewers} 台设备在观看` : '你正在共享屏幕';
  } else {
    dom.shareText.textContent = `${sharing.presenterName || '对方'} 正在共享屏幕`;
  }
}

function ensureShare() {
  if (screenShare) return screenShare;
  screenShare = new ScreenShare({
    send: wsSend,
    onRemoteStream: (stream) => {
      remoteShareStream = stream;
      dom.shareVideo.srcObject = stream;
      // 先静音自动播放（不带声音的自动播放浏览器才允许），
      // 声音等用户点「观看」那个手势里再打开
      const played = dom.shareVideo.play();
      if (played && typeof played.catch === 'function') played.catch(() => {});
      dom.shareHint.classList.add('hidden');
      updateShareSound();
    },
    onRemoteEnded: () => {
      remoteShareStream = null;
      dom.shareVideo.srcObject = null;
      closeShareStage();
      dom.shareHint.classList.remove('hidden');
      updateShareSound();
    },
    // 注意：这里只能刷新文字。早先这里调用了 updateSharing，
    // 而 updateSharing 又会调用 syncPeers → onStatus —— 直接无限递归爆栈。
    onStatus: refreshShareBar,
  });
  return screenShare;
}

function updateSharing(state) {
  const share = ensureShare();
  const sharing = (state && state.sharing) || { active: false };
  const iAmPresenter = sharing.active && sharing.presenterId === myClientId;

  if (!sharing.active) {
    lastSyncedPeerKey = '';
    share.handleSharingInactive(myClientId, null);
    dom.shareBar.classList.add('hidden');
  } else {
    dom.shareBar.classList.remove('hidden');
    if (iAmPresenter) {
      dom.shareStopBtn.classList.remove('hidden');
      dom.shareWatchBtn.classList.add('hidden');

      // 只有对端集合真的变了才重建连接，否则每次状态更新都会重连一遍
      const ids = ((state && state.clients) || [])
        .map((c) => c.id)
        .filter((id) => id && id !== myClientId)
        .sort();
      const key = ids.join(',');
      if (key !== lastSyncedPeerKey) {
        lastSyncedPeerKey = key;
        share.syncPeers((state && state.clients) || [], myClientId);
      }

      const viewers = share.peers.size;
      dom.shareText.textContent =
        viewers > 0 ? `你正在共享屏幕 · ${viewers} 台设备在观看` : '你正在共享屏幕';
    } else {
      dom.shareText.textContent = `${sharing.presenterName || '对方'} 正在共享屏幕`;
      dom.shareWatchBtn.classList.toggle('hidden', !ScreenShare.canReceive());
      dom.shareStopBtn.classList.add('hidden');
    }
  }

  // 采集不可用时按钮**仍然显示**（只是样式不同、点了会说明原因）。
  // 静默消失会让用户以为这个功能不存在 —— 之前就是这么被误解的。
  const canCapture = ScreenShare.canCapture();
  dom.shareBtn.classList.toggle('hidden', Boolean(sharing.active));
  dom.shareBtn.classList.toggle('unavailable', !canCapture);
  dom.shareBtn.title = canCapture
    ? '共享这台设备的屏幕'
    : '当前地址不支持采集屏幕（需要 https 或 127.0.0.1）';
}

function closeShareStage() {
  dom.shareStage.classList.add('hidden');
}

function openShareStage() {
  dom.shareStage.classList.remove('hidden');
  dom.shareHint.classList.toggle('hidden', Boolean(dom.shareVideo.srcObject));
}

/**
 * 声音按钮的显示逻辑。
 *
 * 浏览器的自动播放策略不允许"无用户操作时带声音播放"，所以观看端一开始必须是静音的；
 * 等到用户在「观看」按钮或这个按钮上点一下（真实手势），才解除静音。
 * 共享端自己看的是本地预览，永远静音 —— 否则会自己听自己，产生啸叫。
 */
function updateShareSound() {
  const hasAudio = Boolean(screenShare && screenShare.remoteHasAudio);
  const isPresenter = Boolean(screenShare && screenShare.isSharing);
  const showButton = hasAudio && !isPresenter;

  dom.shareSoundBtn.classList.toggle('hidden', !showButton);
  dom.shareSoundBtn.textContent = dom.shareVideo.muted ? '开启声音' : '静音';
  dom.shareSoundBtn.classList.toggle('primary', dom.shareVideo.muted && showButton);
}

function renderCountdown(remainSec) {
  if (remainSec > 0.05) {
    dom.countdown.classList.remove('hidden');
    dom.countdown.textContent = String(Math.max(1, Math.ceil(remainSec)));
  } else {
    dom.countdown.classList.add('hidden');
  }
}

function renderHud(status) {
  lastStatus = status;
  const rows = [];
  const add = (label, value, cls) => {
    const row = el('div', 'row');
    row.append(el('span', null, label));
    row.append(el('span', `val${cls ? ` ${cls}` : ''}`, value));
    rows.push(row);
  };

  add('片源', localFileMeta ? `本地文件 · ${localFileMeta.name}` : '服务器串流', localFileMeta ? 'good' : '');
  if (status.nextUp) add('下一集', `${status.nextUp.name} · 播完自动接上`, 'good');
  add('平台策略', status.isIOS ? 'iOS · 惰性 seek 校正' : '桌面/安卓 · rate nudging');
  add('时钟偏移', status.hasClock ? `${status.clockOffsetMs} ms` : '校准中…', status.hasClock ? '' : 'warn');

  if (status.driftMs != null) {
    const abs = Math.abs(status.driftMs);
    add('当前偏差', `${status.driftMs} ms`, abs < 150 ? 'good' : abs < 600 ? 'warn' : 'bad');
  } else {
    add('当前偏差', '未播放');
  }

  add(
    '已缓冲',
    `${status.bufferedAheadSec.toFixed(1)} s / 需要 ${status.requiredBufferSec ?? '-'} s`
  );
  if (status.throughputMbps != null) add('实测带宽', `${status.throughputMbps} Mbps`);
  add(
    '校正次数',
    `${status.hardSeekCount} 次`,
    status.hardSeekCount > 6 ? 'warn' : 'good'
  );
  add('播放速率', status.isIOS ? '1.00（iOS 不改速率）' : status.rate.toFixed(2));

  const peers = status.peers || [];
  add(
    '在线设备',
    peers.length
      ? peers
          .map((p) => `${p.name}${p.buffering ? '(缓冲中)' : ''}${p.stale ? '(可能离线)' : ''}`)
          .join('、')
      : '仅你'
  );
  if (status.holdReason) add('房间状态', status.holdReason, 'warn');

  dom.hud.innerHTML = '';
  for (const row of rows) dom.hud.append(row);

  dom.holdBanner.classList.toggle('hidden', !status.holdReason);
  dom.holdBanner.textContent = status.holdReason || '';

  const playLabel = status.playing ? '❚❚' : '▶';
  if (dom.playBtn.textContent !== playLabel) dom.playBtn.textContent = playLabel;
}

// —— 事件绑定 ——

dom.pinBtn.addEventListener('click', doLogin);
dom.pinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

dom.unlock.addEventListener('click', unlockPlayback);

dom.downloadBtn.addEventListener('click', downloadCurrent);

dom.localBtn.addEventListener('click', () => dom.localFile.click());

dom.localFile.addEventListener('change', () => {
  const file = dom.localFile.files && dom.localFile.files[0];
  if (file) useLocalFile(file);
  dom.localFile.value = '';
});

dom.resumeDismiss.addEventListener('click', () => dom.resumeNotice.classList.add('hidden'));

dom.restartBtn.addEventListener('click', () => {
  if (sync) sync.localSeek(0);
});

dom.powerBtn.addEventListener('click', async () => {
  const power = powerSnapshot();
  try {
    await fetchJson('/api/power', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ armed: !(power && power.armed) }),
    });
  } catch {
    /* 忽略 */
  }
});

dom.powerCancel.addEventListener('click', async () => {
  try {
    await fetchJson('/api/power/cancel', { method: 'POST' });
  } catch {
    /* 忽略 */
  }
});

// 关机倒计时每秒刷新（用服务器时间戳，两台设备显示一致）
setInterval(updatePowerNotice, 1000);

// —— 屏幕共享的按钮 ——

dom.shareBtn.addEventListener('click', async () => {
  const share = ensureShare();

  if (!ScreenShare.canCapture()) {
    alert(
      '这台设备现在不能采集屏幕。\n\n' +
        (window.isSecureContext
          ? '当前浏览器没有提供屏幕采集能力。'
          : `原因：屏幕采集要求安全上下文（https 或 http://127.0.0.1）。\n` +
            `当前地址是 ${location.origin}。\n\n` +
            `请在电脑上用 http://127.0.0.1:8080 打开本页面再点共享。`)
    );
    return;
  }

  try {
    await share.startCapture();
  } catch (err) {
    alert(share.lastError || String(err));
    return;
  }

  dom.shareVideo.srcObject = share.localStream;
  dom.shareVideo.muted = true; // 本地预览必须静音，否则会自己听自己
  dom.shareStageText.textContent = '你正在共享屏幕（这是你自己的预览）';
  openShareStage();
  updateShareSound();

  // 不用等下一次状态广播，立刻给已经在房间里的人建连接
  share.syncPeers((lastRoomState && lastRoomState.clients) || [], myClientId);
  updateSharing(lastRoomState);
});

dom.shareStopBtn.addEventListener('click', () => {
  ensureShare().stopLocal();
  closeShareStage();
});

dom.shareWatchBtn.addEventListener('click', () => {
  const share = ensureShare();
  const sharing = (lastRoomState && lastRoomState.sharing) || {};
  dom.shareStageText.textContent = sharing.presenterName
    ? `${sharing.presenterName} 的屏幕`
    : '屏幕共享';
  openShareStage();

  // 关键：必须在这个点击手势里解除静音，否则浏览器会拒绝带声音播放
  if (share.remoteHasAudio) {
    dom.shareVideo.muted = false;
    const played = dom.shareVideo.play();
    if (played && typeof played.catch === 'function') {
      played.catch(() => {
        // 仍被拦下就退回静音，并让「开启声音」按钮亮起来提示用户再点一下
        dom.shareVideo.muted = true;
        updateShareSound();
      });
    }
  }
  updateShareSound();
});

dom.shareSoundBtn.addEventListener('click', () => {
  dom.shareVideo.muted = !dom.shareVideo.muted;
  if (!dom.shareVideo.muted) {
    const played = dom.shareVideo.play();
    if (played && typeof played.catch === 'function') played.catch(() => {});
  }
  updateShareSound();
});

dom.shareClose.addEventListener('click', closeShareStage);

dom.shareStageFs.addEventListener('click', () => {
  const video = dom.shareVideo;

  // iPhone Safari 只支持视频元素的原生全屏（不支持对 div 调 requestFullscreen），
  // 所以先试这条；桌面 Chrome 上它不存在，会自然落到下面的标准 API。
  if (typeof video.webkitEnterFullscreen === 'function') {
    video.webkitEnterFullscreen();
    return;
  }
  if (typeof video.webkitRequestFullscreen === 'function') {
    video.webkitRequestFullscreen();
    return;
  }
  const target = dom.shareStage;
  if (typeof target.requestFullscreen === 'function') {
    target.requestFullscreen().catch(() => {});
  } else if (typeof video.requestFullscreen === 'function') {
    video.requestFullscreen().catch(() => {});
  }
});

dom.backBtn.addEventListener('click', () => {
  showView('library');
  refreshLibrary();
});

dom.rescanBtn.addEventListener('click', async () => {
  dom.libStatus.textContent = '正在重新扫描…';
  try {
    await fetchJson('/api/rescan', { method: 'POST' });
  } catch {
    /* 忽略 */
  }
  setTimeout(refreshLibrary, 1200);
});

dom.playBtn.addEventListener('click', () => {
  if (!sync) return;
  if (dom.video.paused) sync.localPlay();
  else sync.localPause();
});

dom.back10.addEventListener('click', () => {
  if (sync) sync.localSeek(dom.video.currentTime - 10);
});

dom.fwd10.addEventListener('click', () => {
  if (sync) sync.localSeek(dom.video.currentTime + 10);
});

dom.seek.addEventListener('input', () => {
  scrubbing = true;
  updateSeekFill();
  if (Number.isFinite(dom.video.duration)) {
    dom.timeLabel.textContent = `${fmtDur(Number(dom.seek.value))} / ${fmtDur(dom.video.duration)}`;
  }
});

dom.seek.addEventListener('change', () => {
  scrubbing = false;
  if (sync) sync.localSeek(Number(dom.seek.value));
});

dom.fsBtn.addEventListener('click', () => {
  const video = dom.video;
  if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  else if (video.requestFullscreen) video.requestFullscreen().catch(() => {});
  else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
});

/** 更新进度条的已播填充比例（纯装饰，浏览器默认轨道在浅色主题下太抢眼） */
function updateSeekFill() {
  const max = Number(dom.seek.max) || 0;
  const value = Number(dom.seek.value) || 0;
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  dom.seek.style.setProperty('--seek-progress', `${pct}%`);
}

dom.video.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(dom.video.duration)) dom.seek.max = String(dom.video.duration);
  updateSeekFill();
});

dom.video.addEventListener('timeupdate', () => {
  if (scrubbing) return;
  dom.seek.value = String(dom.video.currentTime);
  dom.timeLabel.textContent = `${fmtDur(dom.video.currentTime)} / ${fmtDur(dom.video.duration)}`;
  updateSeekFill();
});

dom.video.addEventListener('waiting', () => {
  if (sync) sync.setBuffering(true);
});

dom.video.addEventListener('playing', () => {
  if (sync) sync.setBuffering(false);
});

// 播完了 → 交给服务端决定是否连播（两台设备都会报，服务端只认第一次）
dom.video.addEventListener('ended', () => {
  wsSend({ t: 'ended' });
});

dom.video.addEventListener('error', () => {
  dom.libStatus.textContent = '视频加载失败（可能是编码不被浏览器支持）';
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  // 回到前台：不信本地进度，按服务器时间戳重新对齐
  if (sync && sync.state && unlocked) sync.hardAlign(sync.state);
  await requestWakeLock();
});

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    /* 需要 HTTPS 与用户手势，失败无所谓 */
  }
}

dom.video.addEventListener('play', () => {
  requestWakeLock();
});

// —— 启动 ——

// 供自动化测试与线上排查使用的只读句柄
window.__vw = {
  get sync() {
    return sync;
  },
  get currentItem() {
    return currentItem;
  },
  get localMeta() {
    return localFileMeta;
  },
  get settings() {
    return settings;
  },
  get unlocked() {
    return unlocked;
  },
  /** 用现成的流开始共享（自动化测试用 canvas 流注入，绕开真实的屏幕采集） */
  startShareWithStream(stream) {
    const share = ensureShare();
    share.startWithStream(stream, '测试流');
    share.syncPeers((lastRoomState && lastRoomState.clients) || [], myClientId);
    return true;
  },
  stopShare() {
    ensureShare().stopLocal();
  },
  /** 共享端实际生效的编码参数（帧率/码率上限），用于自检与测试 */
  describeShareSenders() {
    return screenShare ? screenShare.describeSenders() : Promise.resolve([]);
  },
  get shareInfo() {
    return {
      sharing: screenShare ? screenShare.isSharing : false,
      watching: screenShare ? screenShare.isWatching : false,
      peers: screenShare ? screenShare.peers.size : 0,
      canCapture: ScreenShare.canCapture(),
      canReceive: ScreenShare.canReceive(),
      myClientId,
      remoteWidth: dom.shareVideo.videoWidth,
      remoteHeight: dom.shareVideo.videoHeight,
      remoteHasAudio: screenShare ? screenShare.remoteHasAudio : false,
      localHasAudio: screenShare ? screenShare.localHasAudio : false,
      muted: dom.shareVideo.muted,
      soundButtonVisible: !dom.shareSoundBtn.classList.contains('hidden'),
      soundButtonLabel: dom.shareSoundBtn.textContent,
      stageOpen: !dom.shareStage.classList.contains('hidden'),
    };
  },
};

(async function init() {
  try {
    const session = await fetchJson('/api/session');
    if (!session.authorized) {
      showLogin();
      return;
    }
    await boot();
  } catch {
    dom.libStatus.textContent = '无法连接服务端';
  }
})();
