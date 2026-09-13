'use strict';

/**
 * 网络地基自检（M0）
 *
 *   node tools/check-network.js
 *
 * 做三件事：
 *   1. 查询你的出口公网 IP（IPv4 / IPv6）
 *   2. 通过 UPnP IGD 直接问路由器要它的 WAN IP（不用登录路由器后台）
 *   3. 对比两者，判定你是"有公网 IP"还是"被运营商 CGNAT"
 *
 * 结论直接决定异地观看走哪条地基（见 PLAN.md §3.0）。
 */

const dgram = require('node:dgram');
const os = require('node:os');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isCgnat(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function localIPv4Candidates() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;
      // 排除网络号/广播地址（Radmin 虚拟网卡会报 26.x.x.255 这种）
      if (addr.address.endsWith('.255') || addr.address.endsWith('.0')) continue;
      out.push(addr.address);
    }
  }
  return out;
}

function probeFromInterface(address, timeoutMs) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();

    const probe = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n' +
        '\r\n'
    );

    const done = () => {
      try {
        socket.close();
      } catch {
        /* 忽略 */
      }
      resolve([...found.values()]);
    };

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      const loc = /LOCATION:\s*(\S+)/i.exec(text);
      if (loc) found.set(loc[1], { location: loc[1].trim(), from: rinfo.address, via: address });
    });
    socket.on('error', done);

    socket.bind(() => {
      // 关键：显式指定多播出口，否则可能被 Radmin VPN 之类 metric 更高的虚拟网卡抢走
      try {
        socket.setMulticastInterface(address);
      } catch {
        /* 某些地址不支持，继续尝试 */
      }
      try {
        socket.send(probe, 0, probe.length, SSDP_PORT, SSDP_ADDR);
      } catch {
        /* 忽略 */
      }
    });

    setTimeout(done, timeoutMs);
  });
}

async function ssdpDiscover(timeoutMs = 3500) {
  const candidates = localIPv4Candidates();
  if (candidates.length === 0) return [];

  const results = await Promise.all(candidates.map((addr) => probeFromInterface(addr, timeoutMs)));
  const merged = new Map();
  for (const list of results) for (const item of list) merged.set(item.location, item);
  return [...merged.values()];
}

/**
 * NAT-PMP（RFC 6886）：直接向网关要外部地址。
 * 小米路由器通常开启，且实现比 SSDP 简单，作为 UPnP 之外的备用探测手段。
 */
function natPmpExternalIp(gateway, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const request = Buffer.from([0, 0]); // version 0, opcode 0 = 请求外部地址

    const done = (value) => {
      try {
        socket.close();
      } catch {
        /* 忽略 */
      }
      resolve(value);
    };

    socket.on('message', (msg) => {
      // 响应：version(1) opcode(1)=128 result(2) epoch(4) externalIP(4)
      if (msg.length >= 12 && msg[0] === 0 && msg[1] === 128 && msg.readUInt16BE(2) === 0) {
        done(`${msg[8]}.${msg[9]}.${msg[10]}.${msg[11]}`);
        return;
      }
      done(null);
    });
    socket.on('error', () => done(null));

    socket.send(request, 0, request.length, 5351, gateway, (err) => {
      if (err) done(null);
    });
    setTimeout(() => done(null), timeoutMs);
  });
}

function findWanService(xml) {
  const serviceRe = /<service>([\s\S]*?)<\/service>/g;
  let match;
  while ((match = serviceRe.exec(xml)) !== null) {
    const block = match[1];
    const type = (/<serviceType>([^<]+)<\/serviceType>/.exec(block) || [])[1];
    const control = (/<controlURL>([^<]+)<\/controlURL>/.exec(block) || [])[1];
    if (!type || !control) continue;
    if (!/WAN(IP|PPP)Connection/.test(type)) continue;
    return { type: type.trim(), control: control.trim() };
  }
  return null;
}

async function queryExternalIp(location, service) {
  const controlUrl = new URL(service.control, location).href;
  const body =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:GetExternalIPAddress xmlns:u="${service.type}"/></s:Body>` +
    '</s:Envelope>';

  const res = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${service.type}#GetExternalIPAddress"`,
    },
    body,
    signal: AbortSignal.timeout(6000),
  });

  const text = await res.text();
  const ip = /<NewExternalIPAddress>([^<]*)<\/NewExternalIPAddress>/i.exec(text);
  return ip ? ip[1].trim() : null;
}

async function fetchEgress(kind) {
  const urls =
    kind === 'v4'
      ? ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://ifconfig.me/ip']
      : ['https://api64.ipify.org', 'https://ipv6.icanhazip.com'];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const text = (await res.text()).trim();
      if (text && /^[0-9a-fA-F:.]+$/.test(text)) return text;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

function listLocal() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;
      out.push({ name, family: addr.family, address: addr.address });
    }
  }
  return out;
}

async function main() {
  console.log('=== 网络地基自检 ===\n');

  console.log('1) 本机网卡地址');
  const locals = listLocal();
  for (const l of locals) console.log(`   ${l.family.padEnd(5)} ${l.address.padEnd(32)} ${l.name}`);
  const globalV6 = locals.filter((l) => l.family === 'IPv6' && !/^f[de]80:/i.test(l.address));
  console.log(
    `   → 全局 IPv6: ${globalV6.length ? globalV6.map((a) => a.address).join(', ') : '无'}\n`
  );

  console.log('2) 出口公网地址（外部服务看到的你）');
  const [egressV4, egressV6] = await Promise.all([fetchEgress('v4'), fetchEgress('v6')]);
  console.log(`   出口 IPv4: ${egressV4 || '查询失败'}`);
  console.log(`   出口 IPv6: ${egressV6 || '无（或该服务只返回 IPv4）'}\n`);

  console.log('3) 通过 UPnP 询问路由器自身的 WAN IP');
  const devices = await ssdpDiscover();
  let routerWan = null;
  let routerFrom = null;
  let usedService = null;

  for (const device of devices) {
    try {
      const res = await fetch(device.location, { signal: AbortSignal.timeout(6000) });
      const xml = await res.text();
      const service = findWanService(xml);
      if (!service) continue;
      const ip = await queryExternalIp(device.location, service);
      if (ip) {
        routerWan = ip;
        routerFrom = device.location;
        usedService = service.type;
        break;
      }
    } catch {
      /* 试下一个设备 */
    }
  }

  if (!routerWan) {
    const gateways = [
      ...new Set([
        ...localIPv4Candidates().map((ip) => ip.replace(/\.\d+$/, '.1')),
        '192.168.1.1',
      ]),
    ];
    for (const gateway of gateways) {
      const ip = await natPmpExternalIp(gateway);
      if (ip) {
        routerWan = ip;
        routerFrom = `NAT-PMP @ ${gateway}`;
        usedService = 'NAT-PMP';
        break;
      }
    }
  }

  if (routerWan) {
    console.log(`   路由器 WAN IP: ${routerWan}`);
    console.log(`   （来源：${routerFrom}${usedService ? ` / ${usedService}` : ''}）\n`);
  } else {
    console.log(
      `   自动探测失败（SSDP 发现 ${devices.length} 个设备，NAT-PMP 无响应）。` +
        '路由器可能关闭了 UPnP/NAT-PMP，需要手动登录后台查看。\n'
    );
  }

  console.log('=== 结论 ===');
  let verdict = 'unknown';

  if (routerWan) {
    if (routerWan === egressV4) {
      verdict = 'public-v4';
      console.log('✅ 路由器 WAN IP 与出口 IP 一致 → 你有公网 IPv4');
      console.log('   地基 ①（公网直连 + 域名 + Let\'s Encrypt）可行，她零安装。');
      console.log('   下一步：在路由器上把 8080（或你选的高位端口）转发到 192.168.1.100。');
    } else if (isCgnat(routerWan) || isPrivateIPv4(routerWan)) {
      verdict = 'cgnat';
      console.log(`❌ 路由器 WAN IP 是内网地址（${routerWan}）→ 你处在运营商级 NAT（CGNAT）之后`);
      console.log('   地基 ① 需要先打电话给运营商申请公网 IP（电信通常可以，说明用途是自用远程访问）。');
      console.log('   申请不下来就走地基 ②（Tailscale + 自建港/日中继）。');
    } else {
      verdict = 'multi-nat';
      console.log(`⚠️ 路由器 WAN IP (${routerWan}) 与出口 IP (${egressV4}) 不一致 → 存在多层 NAT`);
      console.log('   说明你上面还有一层运营商设备。地基 ① 需要先解决这个问题。');
    }
  } else if (egressV4 && !isCgnat(egressV4)) {
    console.log(`出口 IPv4 是 ${egressV4}（非 CGNAT 段），但无法自动确认路由器 WAN IP。`);
    console.log('请手动登录路由器后台（通常是 http://192.168.1.1）→ 上网设置 → 查看 WAN IP：');
    console.log(`   - 若显示 ${egressV4} → 有公网 IPv4，地基 ① 可行`);
    console.log('   - 若显示 100.64.x.x / 10.x.x.x → CGNAT，需打运营商电话申请');
  } else {
    console.log('无法判定，请手动查看路由器 WAN IP。');
  }

  if (globalV6.length > 0) {
    console.log('\n提示：你本机有全局 IPv6，地基 ① 也可以通过 IPv6 直连实现（需路由器放行入站）。');
  }

  console.log(`\n(verdict=${verdict})`);
}

main().catch((err) => {
  console.error('自检异常:', err);
  process.exit(1);
});
