'use strict';

/**
 * 控制台 API（挂在 /api/admin 下，全部需要鉴权）。
 *
 * 存在的意义：把原先散落在 PowerShell 脚本里的运维操作搬到网页上，
 * 这样你在电脑浏览器、甚至在手机上都能改访问码、重扫片库、看日志。
 * 需要管理员权限的少数操作（防睡眠、开机自启的 SYSTEM 模式）仍然只能走脚本，
 * 这里只做状态展示与提示。
 */

const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');
const express = require('express');
const { asyncHandler } = require('./async-handler');

// 允许用环境变量换一个任务名：测试时不会动到你真实注册的那个
const TASK_NAME = process.env.VW_TASK_NAME || 'VideoWatcher';

/**
 * 执行系统命令并取回输出。
 *
 * 注意：某些受限环境（或企业策略）不允许创建管道，execFile 会**同步抛出** spawn EPERM。
 * 这里必须把它兜住并转成"失败结果"，否则异常会顺着 async 路由冒出去把进程带走。
 */
function run(file, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const fail = (message) =>
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: message, spawnFailed: true });

    let child;
    try {
      child = execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err ? String(err.message || err) : null,
          spawnFailed: false,
        });
      });
    } catch (err) {
      fail(String((err && err.message) || err));
      return;
    }

    // 双保险：某些平台下错误只会以事件形式抛出
    if (child && typeof child.on === 'function') {
      child.on('error', () => {});
    }
  });
}

function listLanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;
      if (addr.address.startsWith('26.')) continue;
      if (addr.address.endsWith('.255') || addr.address.endsWith('.0')) continue;
      out.push({ name, address: addr.address });
    }
  }
  return out;
}

async function readLogTail(file, lines) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const all = raw.split(/\r?\n/);
    return { available: true, lines: all.slice(-lines) };
  } catch {
    return {
      available: false,
      lines: [],
      hint: '没有日志文件。前台启动（tools\\start.bat）时日志直接打在控制台；只有后台启动才会写 data\\server.log。',
    };
  }
}

async function getAutostartStatus() {
  const result = await run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V']);

  // 查不到 ≠ 没注册：命令本身跑不起来时要如实说明，别让界面显示"未注册"误导人
  if (result.spawnFailed) {
    return { registered: null, error: '当前环境不允许服务端调用系统命令', detail: result.error };
  }
  if (!result.ok) return { registered: false };

  const pick = (label) => {
    const line = result.stdout.split(/\r?\n/).find((l) => l.trim().startsWith(`${label}:`));
    return line ? line.slice(line.indexOf(':') + 1).trim() : null;
  };

  return {
    registered: true,
    taskName: TASK_NAME,
    scheduleType: pick('Schedule Type'),
    runAsUser: pick('Run As User'),
    taskToRun: pick('Task To Run'),
    status: pick('Status'),
  };
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.auth
 * @param {object} deps.library
 * @param {object} deps.room
 * @param {object} deps.power
 * @param {object} deps.progress
 * @param {string} deps.projectRoot
 * @param {string} deps.dataDir
 * @param {string} deps.logFile
 */
function createAdminRouter(deps) {
  const { config, auth, library, room, power, progress, dataDir, logFile } = deps;
  const router = express.Router();

  router.get('/status', (req, res) => {
    const rooms = room.snapshot();
    res.json({
      service: {
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        nodeVersion: process.version,
        port: Number(config.port) || 8080,
        bind: config.bind || '0.0.0.0',
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      },
      pin: auth.pin,
      pinGenerated: Boolean(auth.generated),
      library: {
        count: library.size,
        builtAt: library.builtAt,
        scanning: library.scanning,
        scanError: library.scanError,
        roots: library.roots,
      },
      room: {
        mediaId: rooms.mediaId,
        playing: rooms.playing,
        targetPos: rooms.targetPos,
        clients: (rooms.clients || []).map((c) => ({
          id: c.id,
          name: c.name,
          isIOS: c.isIOS,
          buffering: c.buffering,
          stale: c.stale,
        })),
      },
      progress: { savedBreaks: progress.size },
      power: power.snapshot(),
      urls: {
        lan: listLanAddresses().map((a) => `http://${a.address}:${Number(config.port) || 8080}`),
        loopback: `http://127.0.0.1:${Number(config.port) || 8080}`,
      },
    });
  });

  router.post(
    '/pin',
    asyncHandler(async (req, res) => {
      const requested = String((req.body && req.body.pin) || '').trim();
      if (requested && !/^\d{4,12}$/.test(requested)) {
        return res.status(400).json({ error: '访问码需要是 4–12 位数字' });
      }

      const cleared = auth.clearTokens();
      const result = await auth.setPin(requested);

      // 给操作者补发一个令牌，免得改完 PIN 把自己也踢出去
      const token = auth.issueToken();
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      auth.setCookie(res, token, secure);

      return res.json({
        ok: true,
        pin: result.pin,
        generated: result.generated,
        persisted: result.persisted,
        invalidatedSessions: cleared,
        note: result.persisted ? null : '已生效，但写回 config.json 失败，重启后会恢复旧值',
      });
    })
  );

  router.post('/rescan', (req, res) => {
    if (library.scanning) return res.json({ ok: true, alreadyRunning: true });
    library.build().catch(() => {});
    return res.json({ ok: true, started: true });
  });

  router.get(
    '/log',
    asyncHandler(async (req, res) => {
      const lines = Math.min(1000, Math.max(20, Number(req.query.lines) || 200));
      res.json(await readLogTail(logFile, lines));
    })
  );

  router.get(
    '/autostart',
    asyncHandler(async (req, res) => {
      res.json(await getAutostartStatus());
    })
  );

  router.post(
    '/autostart',
    asyncHandler(async (req, res) => {
      const enabled = Boolean(req.body && req.body.enabled);
      const vbs = path.join(__dirname, '..', 'tools', 'start-hidden.vbs');

      if (enabled) {
        if (!(await fsp.stat(vbs).catch(() => null))) {
          return res.status(500).json({ error: `找不到启动脚本: ${vbs}` });
        }

        const result = await run('schtasks', [
          '/Create', '/TN', TASK_NAME,
          '/TR', `wscript.exe "${vbs}"`,
          '/SC', 'ONLOGON', '/DELAY', '0000:20', '/F',
        ]);

        if (!result.ok) {
          return res.status(503).json({
            error: result.spawnFailed
              ? '当前环境不允许服务端调用系统命令，请改用脚本注册'
              : '注册失败，可能需要管理员权限',
            hint: 'powershell -ExecutionPolicy Bypass -File tools\\install-autostart.ps1',
            detail: (result.error || result.stderr || result.stdout || '').trim().slice(0, 300),
          });
        }
      } else {
        const result = await run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
        if (result.spawnFailed) {
          return res.status(503).json({
            error: '当前环境不允许服务端调用系统命令，请改用脚本移除',
            hint: 'powershell -ExecutionPolicy Bypass -File tools\\install-autostart.ps1 -Remove',
          });
        }
      }

      return res.json({ ok: true, ...(await getAutostartStatus()) });
    })
  );

  router.get('/progress', (req, res) => {
    const entries = [];
    for (const [id, entry] of progress.map) {
      entries.push({ mediaId: id, ...entry });
    }
    entries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    res.json({ count: entries.length, entries: entries.slice(0, 100) });
  });

  router.post(
    '/progress/clear',
    asyncHandler(async (req, res) => {
      const mediaId = req.body && req.body.mediaId;
      if (mediaId) {
        progress.clear(String(mediaId));
      } else {
        progress.map.clear();
        progress.scheduleSave();
      }
      await progress.flush().catch(() => {});
      res.json({ ok: true, remaining: progress.size });
    })
  );

  router.get('/paths', (req, res) => {
    res.json({
      projectRoot: path.join(__dirname, '..'),
      configPath: auth.configPath,
      dataDir,
      logFile,
    });
  });

  return router;
}

module.exports = { createAdminRouter };
