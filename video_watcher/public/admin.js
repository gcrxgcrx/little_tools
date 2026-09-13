const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (res.status === 401) {
    showLogin();
    throw Object.assign(new Error('unauthorized'), { code: 401 });
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw Object.assign(new Error((body && body.error) || `HTTP ${res.status}`), { body });
  }
  return body;
}

function showLogin() {
  $('login').classList.remove('hidden');
}

async function doLogin() {
  const pin = $('pinInput').value.trim();
  if (!pin) return;
  $('pinError').textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  }).catch(() => null);

  if (!res || !res.ok) {
    $('pinError').textContent = '访问码不对';
    return;
  }
  $('login').classList.add('hidden');
  await loadAll();
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${r} 秒`;
  return `${r} 秒`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function renderKv(container, rows) {
  container.innerHTML = '';
  for (const [k, v, cls] of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = k;
    const val = document.createElement('span');
    val.className = `v${cls ? ` ${cls}` : ''}`;
    val.textContent = v == null ? '—' : String(v);
    row.append(key, val);
    container.append(row);
  }
}

let latestStatus = null;

async function loadStatus() {
  const s = await api('/api/admin/status');
  latestStatus = s;

  renderKv($('serviceGrid'), [
    ['状态', '正在运行', 'good'],
    ['进程号', s.service.pid],
    ['已运行', fmtDuration(s.service.uptimeSec)],
    ['启动于', fmtTime(s.service.startedAt)],
    ['Node 版本', s.service.nodeVersion],
    ['监听', `${s.service.bind}:${s.service.port}`],
  ]);

  $('currentPin').textContent = s.pin || '（未设置）';

  const lib = s.library;
  renderKv($('libraryGrid'), [
    ['视频数量', `${lib.count} 个`],
    ['扫描状态', lib.scanning ? '正在扫描…' : '空闲', lib.scanning ? 'warn' : 'good'],
    ['上次扫描', fmtTime(lib.builtAt)],
    ['根目录', (lib.roots || []).join('、')],
    ...(lib.scanError ? [['扫描错误', lib.scanError, 'bad']] : []),
  ]);

  const urls = $('urlList');
  urls.innerHTML = '';
  const addUrl = (label, url) => {
    const row = document.createElement('div');
    row.textContent = `${label}：`;
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    row.append(a);
    urls.append(row);
  };
  addUrl('本机', s.urls.loopback);
  for (const u of s.urls.lan) addUrl('局域网', u);
  if (s.urls.lan.length === 0) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = '没检测到局域网地址。';
    urls.append(p);
  }

  const room = s.room;
  renderKv($('progressGrid'), [
    ['已记录断点', `${s.progress.savedBreaks} 个`],
    ['当前媒体', room.mediaId || '（未选片）'],
    ['在线设备', room.clients.length ? room.clients.map((c) => c.name).join('、') : '无'],
  ]);

  const power = s.power;
  renderKv($('powerGrid'), [
    ['功能', power.enabled ? '已启用' : '已禁用', power.enabled ? 'good' : 'warn'],
    ['开关', power.armed ? '已开启（播完会关机）' : '未开启', power.armed ? 'warn' : ''],
    ['待执行', power.scheduledAtMs ? `${Math.ceil(Math.max(0, power.remainingMs) / 1000)} 秒后` : '无', power.scheduledAtMs ? 'bad' : ''],
  ]);
  $('powerArmBtn').textContent = power.armed ? '关闭' : '开启';

  try {
    const a = await api('/api/admin/autostart');
    renderKv($('autostartGrid'), [
      ['状态', a.registered ? '已注册' : '未注册', a.registered ? 'good' : 'warn'],
      ['触发方式', a.scheduleType || '—'],
      ['运行身份', a.runAsUser || '—'],
    ]);
  } catch {
    renderKv($('autostartGrid'), [['状态', '查询失败', 'bad']]);
  }
}

async function loadLog() {
  const box = $('logBox');
  try {
    const data = await api('/api/admin/log?lines=200');
    if (!data.available) {
      box.textContent = data.hint || '没有日志。';
      return;
    }
    box.textContent = data.lines.filter((l) => l !== '').join('\n') || '（日志为空）';
    box.scrollTop = box.scrollHeight;
  } catch (err) {
    box.textContent = `读取日志失败：${err.message}`;
  }
}

async function loadAll() {
  await loadStatus();
  await loadLog();
}

// —— 交互 ——

$('pinBtn').addEventListener('click', doLogin);
$('pinInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

$('refreshBtn').addEventListener('click', () => loadAll().catch(() => {}));
$('logRefreshBtn').addEventListener('click', () => loadLog());

$('copyPinBtn').addEventListener('click', async () => {
  const pin = $('currentPin').textContent;
  try {
    await navigator.clipboard.writeText(pin);
    $('pinMsg').textContent = '已复制到剪贴板';
    $('pinMsg').className = 'msg';
  } catch {
    $('pinMsg').textContent = '复制失败，请手动选中';
    $('pinMsg').className = 'msg bad';
  }
});

async function changePin(pin) {
  $('pinMsg').textContent = '正在修改…';
  $('pinMsg').className = 'msg';
  try {
    const result = await api('/api/admin/pin', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    });
    $('pinMsg').textContent =
      `已改为 ${result.pin}（其他 ${result.invalidatedSessions} 个会话已失效）` +
      (result.note ? ` · ${result.note}` : '');
    $('pinMsg').className = 'msg';
    $('newPin').value = '';
    await loadStatus();
  } catch (err) {
    $('pinMsg').textContent = err.message;
    $('pinMsg').className = 'msg bad';
  }
}

$('setPinBtn').addEventListener('click', () => {
  const pin = $('newPin').value.trim();
  if (!pin) {
    $('pinMsg').textContent = '请先填一个 4–12 位数字';
    $('pinMsg').className = 'msg bad';
    return;
  }
  changePin(pin);
});

$('randomPinBtn').addEventListener('click', () => {
  const pin = String(Math.floor(100000 + Math.random() * 900000));
  $('newPin').value = pin;
  changePin(pin);
});

$('rescanBtn').addEventListener('click', async () => {
  try {
    await api('/api/admin/rescan', { method: 'POST' });
    $('libraryGrid').insertAdjacentHTML('beforeend', '');
    setTimeout(() => loadStatus().catch(() => {}), 1200);
  } catch {
    /* 忽略 */
  }
});

$('autostartOnBtn').addEventListener('click', async () => {
  try {
    await api('/api/admin/autostart', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  } catch (err) {
    alert(`注册失败：${err.message}`);
  }
  await loadStatus().catch(() => {});
});

$('autostartOffBtn').addEventListener('click', async () => {
  try {
    await api('/api/admin/autostart', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  } catch (err) {
    alert(`移除失败：${err.message}`);
  }
  await loadStatus().catch(() => {});
});

$('powerArmBtn').addEventListener('click', async () => {
  const armed = latestStatus && latestStatus.power && latestStatus.power.armed;
  try {
    await api('/api/power', { method: 'POST', body: JSON.stringify({ armed: !armed }) });
  } catch {
    /* 忽略 */
  }
  await loadStatus().catch(() => {});
});

$('powerCancelBtn').addEventListener('click', async () => {
  try {
    await api('/api/power/cancel', { method: 'POST' });
  } catch {
    /* 忽略 */
  }
  await loadStatus().catch(() => {});
});

$('clearProgressBtn').addEventListener('click', async () => {
  if (!confirm('确定要清空所有观看断点吗？之后每个视频都会从头开始。')) return;
  try {
    await api('/api/admin/progress/clear', { method: 'POST', body: JSON.stringify({}) });
  } catch {
    /* 忽略 */
  }
  await loadStatus().catch(() => {});
});

// —— 启动 ——

(async function init() {
  try {
    const session = await api('/api/session');
    if (!session.authorized) {
      showLogin();
      return;
    }
    await loadAll();
  } catch {
    /* 未授权时 api() 已经弹出登录框 */
  }
})();

// 状态与关机倒计时定时刷新
setInterval(() => {
  if ($('login').classList.contains('hidden')) loadStatus().catch(() => {});
}, 5000);
