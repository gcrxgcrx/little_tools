'use strict';

/**
 * 观影室服务端。
 *
 *   HTTP  : 网页外壳 + 片库 API + 视频文件（支持 Range）
 *   WS    : 房间 + 权威时间轴广播 + 时钟同步 ping/pong
 *
 * 视频字节只从这台电脑流向观看端，路径上没有任何第三方；
 * 同步消息每条只有几十字节。
 */

const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const express = require('express');
const { WebSocketServer } = require('ws');

const { Library } = require('./library');
const { Auth } = require('./auth');
const { Room } = require('./sync');
const { serveVideo } = require('./media');
const { ProgressStore } = require('./progress');
const { PowerManager } = require('./power');
const { createAdminRouter } = require('./admin');
const { createRtcRelay } = require('./rtc');

const PROJECT_ROOT = path.join(__dirname, '..');
// 允许用环境变量指向另一份配置：测试时就不会碰到你正在用的 config.json
const CONFIG_PATH = process.env.VW_CONFIG
  ? path.resolve(process.env.VW_CONFIG)
  : path.join(PROJECT_ROOT, 'config.json');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

function log(...args) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...args);
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

async function loadConfig() {
  const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);

  // 测试用的环境变量覆盖：可以起一个隔离实例，不影响正在运行的正式服务
  if (process.env.VW_PORT) config.port = Number(process.env.VW_PORT);
  if (process.env.VW_BIND) config.bind = process.env.VW_BIND;
  if (process.env.VW_DATA_DIR) config.dataDir = process.env.VW_DATA_DIR;
  if (process.env.VW_POWER_DRY_RUN === '1') {
    config.power = { ...(config.power || {}), dryRun: true };
  }

  return config;
}

function resolveDataDir(config) {
  return config.dataDir ? path.resolve(config.dataDir) : path.join(PROJECT_ROOT, 'data');
}

function listLanAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue; // 链路本地，没意义
      // 跳过看起来像网络号/广播地址的条目（例如 Radmin 虚拟网卡会报 26.x.x.255）
      if (addr.address.endsWith('.255') || addr.address.endsWith('.0')) continue;
      out.push({ name, address: addr.address });
    }
  }
  return out;
}

async function main() {
  const config = await loadConfig();
  const dataDir = resolveDataDir(config);

  // 防止重复启动：自动启动与手动启动撞在一起时，第二个实例要立刻退出，
  // 否则会抢 8080 端口并抛出一个对用户毫无意义的 EADDRINUSE。
  const pidFile = path.join(dataDir, 'server.pid');
  try {
    await fsp.mkdir(dataDir, { recursive: true });
    const previous = Number((await fsp.readFile(pidFile, 'utf8')).trim());
    if (Number.isInteger(previous) && previous > 0) {
      let alive = false;
      try {
        process.kill(previous, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) {
        console.log(`观影室已经在运行了（进程 ${previous}）。`);
        console.log(`如需重启，先运行：powershell -ExecutionPolicy Bypass -File tools\\stop-server.ps1`);
        process.exit(0);
      }
    }
  } catch {
    // 没有 pid 文件或读不出来，正常继续
  }
  await fsp.writeFile(pidFile, String(process.pid), 'utf8').catch(() => {});

  const auth = new Auth(config, CONFIG_PATH);
  const pin = await auth.ensurePin();

  const library = new Library(config, PROJECT_ROOT);
  await library.loadCache();

  const progress = new ProgressStore(dataDir, config.resume || {});
  await progress.load();

  const power = new PowerManager({
    ...(config.power || {}),
    log: (message) => log(message),
  });

  const room = new Room({
    onChange: (state) => broadcastState(state),
    resumeCountdownMs: config.bufferingResumeCountdownMs,
  });

  // 屏幕共享的信令中转（画面本身走 WebRTC 直连，不经过这里）
  const rtc = createRtcRelay({ room });

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));

  // 网页外壳本身不含敏感信息，公开可访问；真正的数据与视频都需要鉴权
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));

  const requireAuth = (req, res, next) => {
    if (auth.authorize(req)) return next();
    return res.status(401).json({ error: 'unauthorized', needPin: true });
  };

  // —— 连通性自检（无需鉴权，用于 M0 验证"她的设备能不能连到这里"）——
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      app: 'video-watcher',
      items: library.size,
      scanning: library.scanning,
      builtAt: library.builtAt,
      time: new Date().toISOString(),
    });
  });

  // 会话探测：永远返回 200，让前端在不产生 401 控制台噪音的前提下判断是否需要输 PIN
  app.get('/api/session', (req, res) => {
    res.json({ authorized: auth.authorize(req) });
  });

  app.post('/api/login', (req, res) => {
    const token = auth.login(req.body && req.body.pin);
    if (!token) {
      // 失败限速，避免 PIN 被暴力枚举
      return setTimeout(() => res.status(401).json({ error: 'wrong-pin' }), 600);
    }
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    auth.setCookie(res, token, secure);
    return res.json({ ok: true });
  });

  app.get('/api/library', requireAuth, (req, res) => {
    res.json({
      builtAt: library.builtAt,
      scanning: library.scanning,
      scanError: library.scanError,
      progress: library.progress,
      roots: library.roots,
      items: library.list(),
    });
  });

  app.post('/api/rescan', requireAuth, (req, res) => {
    if (library.scanning) return res.json({ ok: true, alreadyRunning: true });
    library.build().catch((err) => log('扫描失败:', err.message));
    return res.json({ ok: true, started: true });
  });

  app.get('/api/settings', requireAuth, (req, res) => {    res.json({
      clientBufferAheadSec: config.clientBufferAheadSec,
      minBufferAheadSec: config.minBufferAheadSec,
      adaptiveBuffer: config.adaptiveBuffer,
      bufferWaitTimeoutSec: config.bufferWaitTimeoutSec,
      bufferingGraceMs: config.bufferingGraceMs,
      iosLazySeek: config.iosLazySeek,
      desktopRateNudge: config.desktopRateNudge,
      rtcIceServers: (config.rtc && config.rtc.iceServers) || [],
      rtcFrameRate: (config.rtc && config.rtc.frameRate) || 60,
      rtcMaxBitrateMbps: (config.rtc && config.rtc.maxBitrateMbps) || 8,
      rtcDegradationPreference:
        (config.rtc && config.rtc.degradationPreference) || 'maintain-resolution',
    });
  });

  app.get('/api/state', requireAuth, (req, res) => {
    res.json(enrichState(room.snapshot()));
  });

  // —— 播完关机 ——
  app.get('/api/power', requireAuth, (req, res) => {
    res.json(power.snapshot());
  });

  app.post('/api/power', requireAuth, (req, res) => {
    const snapshot = power.arm(Boolean(req.body && req.body.armed));
    broadcastState(room.snapshot());
    res.json(snapshot);
  });

  app.post('/api/power/cancel', requireAuth, (req, res) => {
    const snapshot = power.cancel('用户在界面上取消');
    broadcastState(room.snapshot());
    res.json(snapshot);
  });

  // —— 控制台 API（改访问码、重扫片库、看日志、开机自启开关）——
  app.use(
    '/api/admin',
    requireAuth,
    createAdminRouter({
      config,
      auth,
      library,
      room,
      power,
      progress,
      dataDir,
      logFile: path.join(dataDir, 'server.log'),
    })
  );

  // —— 视频本体：手写 Range 处理，并可在传输时无损改写 hev1 → hvc1 ——
  app.get('/media/:id', requireAuth, (req, res) => {
    const item = library.get(req.params.id);
    if (!item) return res.status(404).json({ error: 'not-found' });

    // Apple 平台只认 hvc1 封装的 HEVC。这里在传输时改写那 4 个字节，
    // 硬盘上的原文件保持不动，且因为长度不变，Range 语义完全不受影响。
    let patch = null;
    if (
      config.patchHevcOnServe !== false &&
      (item.videoCodec || '').toLowerCase() === 'hev1' &&
      Number.isFinite(item.fourccOffset) &&
      item.hevcPatchable
    ) {
      patch = { offset: item.fourccOffset, replacement: Buffer.from('hvc1', 'latin1') };
    }

    return serveVideo(req, res, item, { patch }).catch(() => {
      if (!res.headersSent) res.status(500).json({ error: 'serve-failed' });
    });
  });

  // —— 兜底错误处理 ——
  // 必须放在所有路由之后。没有它，async 路由里抛出的异常会变成未处理的
  // Promise rejection，而 Node 15+ 默认会因此**终止整个进程** ——
  // 也就是说管理接口里一个意外错误就能把正在看片的人踢下线。
  app.use((err, req, res, next) => {
    log(`请求出错 ${req.method} ${req.originalUrl}: ${(err && err.message) || err}`);
    if (res.headersSent) return next(err);
    return res.status(500).json({
      error: 'internal-error',
      message: String((err && err.message) || err),
    });
  });

  // —— HTTP / HTTPS 服务 ——
  let server;
  const tls = config.tls || {};
  if (tls.key && tls.cert) {
    const [key, cert] = await Promise.all([
      fsp.readFile(path.resolve(PROJECT_ROOT, tls.key)),
      fsp.readFile(path.resolve(PROJECT_ROOT, tls.cert)),
    ]);
    server = https.createServer({ key, cert }, app);
  } else {
    server = http.createServer(app);
  }

  // —— WebSocket ——
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    // 升级请求也要鉴权（cookie 会随升级请求带上）
    const fakeReq = { headers: req.headers, socket, ip: req.socket.remoteAddress, query: {} };
    if (!auth.authorize(fakeReq)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function send(ws, payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  /** 按片库顺序找出同一目录里的下一个视频（用于连播，避免从剧集跳进电影） */
  function nextItemAfter(itemId) {
    const items = library.items;
    const index = items.findIndex((i) => i.id === itemId);
    if (index < 0) return null;
    const current = items[index];
    for (let i = index + 1; i < items.length; i += 1) {
      if (items[i].dir === current.dir) return items[i];
    }
    return null;
  }

  /** 给状态补上连播信息再发出 */
  function enrichState(state) {
    const next = state.mediaId ? nextItemAfter(state.mediaId) : null;
    return {
      ...state,
      autoPlayNext: config.autoPlayNext !== false,
      nextUp: next ? { id: next.id, name: next.name, durationSec: next.durationSec } : null,
      power: power.snapshot(),
    };
  }

  function broadcastState(state) {
    const message = JSON.stringify({ t: 'state', state: enrichState(state) });
    for (const client of room.clients.values()) {
      if (client.ws && client.ws.readyState === client.ws.OPEN) client.ws.send(message);
    }
  }

  /**
   * 处理"播完了"。
   *
   * 两台设备各自本地解码，几乎同时触发 ended —— 只有第一次应该生效。
   * 既按 mediaId 去重，也用一个时间窗兜住"第一台刚切完片、第二台的 ended 才到"这种竞态。
   */
  let lastEnded = { mediaId: null, at: 0 };

  function handleEnded() {
    const current = room.mediaId;
    if (!current) return;

    const now = Date.now();
    const sameMediaAgain = lastEnded.mediaId === current && now - lastEnded.at < 5000;
    const justAdvanced = now - lastEnded.at < 4000;
    if (sameMediaAgain || justAdvanced) return;
    lastEnded = { mediaId: current, at: now };

    // 这一集看完了，清掉断点，下次从头开始
    progress.clear(current);

    if (config.autoPlayNext === false) return;

    const next = nextItemAfter(current);
    if (!next) {
      log('已到该目录最后一个视频，停止连播');
      if (power.armed && power.onPlaylistEnd) {
        power.schedule('已播完该目录的最后一个视频');
        broadcastState(room.snapshot());
      }
      return;
    }

    log(`自动连播 → ${next.fileName}`);
    room.setMedia(next.id, next.durationSec, {
      autoStart: true,
      countdownMs: Number(config.autoPlayNextCountdownMs) || 6000,
    });
  }

  wss.on('connection', (ws, req) => {
    const id = crypto.randomBytes(6).toString('hex');
    const client = {
      id,
      ws,
      name: `设备-${id.slice(0, 4)}`,
      isIOS: String(req.headers['user-agent'] || '').includes('iPhone') ||
        String(req.headers['user-agent'] || '').includes('iPad'),
      buffering: false,
      lastPos: null,
      lastReportMs: null,
      rttMs: null,
      lastSeenMs: Date.now(),
    };
    room.addClient(client);

    send(ws, {
      t: 'welcome',
      clientId: id,
      state: enrichState(room.snapshot()),
      settings: {
        clientBufferAheadSec: config.clientBufferAheadSec,
        minBufferAheadSec: config.minBufferAheadSec,
        adaptiveBuffer: config.adaptiveBuffer,
        bufferWaitTimeoutSec: config.bufferWaitTimeoutSec,
        bufferingGraceMs: config.bufferingGraceMs,
        iosLazySeek: config.iosLazySeek,
        desktopRateNudge: config.desktopRateNudge,
        rtcIceServers: (config.rtc && config.rtc.iceServers) || [],
        rtcFrameRate: (config.rtc && config.rtc.frameRate) || 60,
        rtcMaxBitrateMbps: (config.rtc && config.rtc.maxBitrateMbps) || 8,
        rtcDegradationPreference:
          (config.rtc && config.rtc.degradationPreference) || 'maintain-resolution',
      },
    });

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      // 曾经被当作失联清理掉的客户端，只要再发一条消息就自动重新加入房间
      if (!room.clients.has(id)) room.addClient(client);
      room.touch(id);

      // 屏幕共享信令：只做转发，服务端不接触画面
      const relayed = rtc.handle(id, msg, (targetId, payload) => {
        const target = room.clients.get(targetId);
        if (target && target.ws) send(target.ws, payload);
      });
      if (relayed) return;

      switch (msg.t) {
        case 'hello':
          room.updateClient(id, {
            name: String(msg.name || '').slice(0, 24) || client.name,
            isIOS: Boolean(msg.isIOS),
          });
          room.emit();
          break;

        case 'ping':
          send(ws, { t: 'pong', cts: msg.cts, serverMs: Date.now() });
          break;

        case 'load': {
          const item = library.get(String(msg.mediaId || ''));
          if (!item) {
            send(ws, { t: 'error', message: '片库中找不到该视频' });
            break;
          }
          lastEnded = { mediaId: null, at: 0 }; // 手动换片，允许新的连播触发
          power.cancel('有人开始播放'); // 有人回来看片了，撤销待执行的关机

          // 断点续播：回退几秒再开始，免得正好停在关键台词之后
          const resumePoint = progress.resumePointFor(item.id);
          const durationSec = item.durationSec != null ? item.durationSec : msg.durationSec;
          room.setMedia(item.id, durationSec, {
            startPos: resumePoint ? resumePoint.from : 0,
            savedPositionSec: resumePoint ? resumePoint.savedPositionSec : null,
          });
          log(
            `${client.name} 选择播放: ${item.fileName}` +
              (resumePoint ? `（从 ${fmtClock(resumePoint.from)} 续播）` : '')
          );
          break;
        }

        case 'ended':
          handleEnded();
          break;

        case 'share-start':
          rtc.start(id, client.name);
          log(`${client.name} 开始共享屏幕`);
          break;

        case 'share-stop':
          rtc.stop(id);
          log(`${client.name} 结束共享屏幕`);
          break;

        case 'intent':
          room.applyIntent(id, msg.action, msg.pos, msg.durationSec);
          break;

        case 'buffering':
          room.setBuffering(id, Boolean(msg.buffering));
          break;

        case 'report':
          room.report(id, msg.pos, msg.rttMs);
          break;

        default:
          break;
      }
    });

    ws.on('close', () => {
      log(`${client.name} 断开`);
      room.removeClient(id);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* 忽略 */
      }
    }
  }, 10000);
  wss.on('close', () => clearInterval(heartbeat));

  // 维护任务：断点记忆落盘 + 空房计时（用于"没人了就关机"）
  const maintenance = setInterval(() => {
    if (room.mediaId && room.playing) {
      progress.record(room.mediaId, room.targetPos(), room.mediaDurationSec);
    }

    if (room.clients.size === 0) {
      power.markRoomEmpty();
      if (power.shouldShutdownForIdle()) {
        power.schedule('房间已经没人了');
        broadcastState(room.snapshot());
      }
    } else {
      power.markRoomOccupied();
    }

    // 清掉长时间没消息的幽灵连接（浏览器强杀后 TCP 可能很久都不报错，
    // 而协议层 ping/pong 由浏览器自动回复，靠它判断不出页面是否还活着）
    room.pruneStale(60000);
  }, Math.max(5, Number((config.resume || {}).saveIntervalSec) || 10) * 1000);
  wss.on('close', () => clearInterval(maintenance));

  const port = Number(config.port) || 8080;
  const bind = config.bind || '0.0.0.0';

  server.listen(port, bind, () => {
    const scheme = tls.key && tls.cert ? 'https' : 'http';
    console.log('');
    log('观影室已启动');
    console.log(`  访问码 (PIN): ${pin}${auth.generated ? '   ← 已自动生成并写入 config.json' : ''}`);
    console.log('');
    console.log('  本机可用地址:');
    console.log(`    ${scheme}://127.0.0.1:${port}    （这台电脑自己）`);
    for (const { name, address } of listLanAddresses()) {
      console.log(`    ${scheme}://${address}:${port}    （局域网 · ${name}）`);
    }
    console.log('');
    console.log('  给她的地址:');
    console.log('    - 若用 Tailscale：先 `tailscale serve ' + port + '`，再用 https://<机器名>.<tailnet>.ts.net');
    console.log('    - 若用公网直连：需要路由器端口转发 + 域名证书（见 PLAN.md 地基 ①）');
    console.log('');
    console.log(`  连通性自检（她手机浏览器直接打开，不需要 PIN）:`);
    console.log(`    ${scheme}://<上面任一地址>:${port}/api/health`);
    console.log('');
  });

  // 启动后后台扫描片库
  library
    .build()
    .then(() => log(`片库扫描完成：${library.size} 个视频，用时 ${library.progress.dirs} 个目录`))
    .catch((err) => log('片库扫描失败:', err.message));

  const shutdown = async () => {
    log('正在退出…');
    clearInterval(heartbeat);
    clearInterval(maintenance);

    // 安全兜底：服务端退出时不留待执行的关机任务，免得重启服务把自己关掉
    power.cancel('服务端退出');

    if (room.mediaId && room.playing) {
      progress.record(room.mediaId, room.targetPos(), room.mediaDurationSec);
    }
    await progress.flush().catch(() => {});
    await fsp.rm(pidFile, { force: true }).catch(() => {});

    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };

  process.on('exit', () => {
    try {
      require('node:fs').unlinkSync(pidFile);
    } catch {
      /* 忽略 */
    }
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 保命兜底：宁可带着一个已记录的异常继续服务，也不要让正在看片的人突然断线。
  // 处理完必须留下明显日志，方便事后排查。
  process.on('unhandledRejection', (reason) => {
    log('⚠️ 未处理的 Promise 异常（已阻止进程退出）:', (reason && reason.stack) || reason);
  });
  process.on('uncaughtException', (err) => {
    log('⚠️ 未捕获异常（已阻止进程退出）:', (err && err.stack) || err);
  });
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
