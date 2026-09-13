'use strict';

/**
 * 访问控制。
 *
 * 三种放行方式（满足其一即可）：
 *   1. 本机回环地址（便于你在电脑上直接调试，不用输 PIN）
 *   2. Tailscale 身份头白名单（走 tailscale serve 时由 Tailscale 注入，无法伪造）
 *   3. 一次性 PIN 换取的会话 token（存在 cookie 里，视频 Range 请求会自动带上）
 *
 * 之所以用 cookie 而不是自定义请求头：<video> 元素无法设置自定义头，
 * 但会自动携带同源 cookie，这样 /media 的 Range 请求才能被鉴权覆盖。
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const COOKIE_NAME = 'vw_token';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

class Auth {
  constructor(config, configPath) {
    this.config = config;
    this.configPath = configPath;
    this.tokens = new Set();
    this.trusted = new Set(
      (config.trustedTailscaleLogins || []).map((s) => String(s).toLowerCase()).filter(Boolean)
    );
    this.pin = String(config.pin || '').trim();
    this.generated = false;
  }

  /** 若配置里没有 PIN，则生成一个 6 位数字并写回 config.json。 */
  async ensurePin() {
    if (this.pin) return this.pin;
    return this.setPin('');
  }

  /** 把 PIN 写进 config.json（Node 的 JSON.stringify 不会转义中文） */
  async persistPin(pin) {
    this.pin = pin;
    try {
      const raw = await fsp.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);
      parsed.pin = pin;
      await fsp.writeFile(this.configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      return true;
    } catch {
      // 写不进去也不影响运行，PIN 仍在本进程内有效
      return false;
    }
  }

  /**
   * 设置新 PIN。传空字符串表示"随机生成一个"。
   * @returns {Promise<{pin: string, generated: boolean, persisted: boolean}>}
   */
  async setPin(pinOrEmpty) {
    const next = String(pinOrEmpty || '').trim();
    const generated = !next;
    const value = next || String(crypto.randomInt(100000, 1000000));
    const persisted = await this.persistPin(value);
    this.generated = generated;
    return { pin: value, generated, persisted };
  }

  /** 让所有已发出的会话令牌失效（改 PIN 时用） */
  clearTokens() {
    const count = this.tokens.size;
    this.tokens.clear();
    return count;
  }

  /** 给当前请求者重新签发一个令牌，免得改 PIN 把自己也踢下线 */
  issueToken() {
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.add(token);
    return token;
  }

  isLoopback(ip) {
    return LOOPBACK.has(String(ip || ''));
  }

  tailscaleLogin(req) {
    const login = req.headers['tailscale-user-login'];
    return login ? String(login).toLowerCase() : null;
  }

  /** 校验 PIN，成功返回 token。 */
  login(pin) {
    const candidate = String(pin || '').trim();
    if (!candidate || candidate !== this.pin) return null;
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.add(token);
    return token;
  }

  /** 判断一个请求是否已授权。 */
  authorize(req) {
    if (this.isLoopback(req.socket && req.socket.remoteAddress)) return true;
    if (this.isLoopback(req.ip)) return true;

    const login = this.tailscaleLogin(req);
    if (login && this.trusted.has(login)) return true;

    const cookies = parseCookies(req.headers.cookie);
    if (cookies[COOKIE_NAME] && this.tokens.has(cookies[COOKIE_NAME])) return true;

    const queryToken = req.query && req.query.token;
    if (queryToken && this.tokens.has(String(queryToken))) return true;

    return false;
  }

  setCookie(res, token, secure) {
    const parts = [
      `${COOKIE_NAME}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=2592000',
    ];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
}

module.exports = { Auth, COOKIE_NAME, parseCookies };
