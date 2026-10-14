'use strict';
// Защита веб-панели: один пароль (без логина), scrypt-хэш в settings.json,
// сессия — HMAC-подписанная httpOnly-кука. Без сторонних зависимостей.
const crypto = require('crypto');
const { loadSettings, saveSettings } = require('../config');

const COOKIE = 'tc_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 дней

// ── хранение в settings.json (web.passwordHash / web.sessionSecret) ───────────
function _web() { const s = loadSettings(); return s.web || {}; }
function _saveWeb(patch) {
  const s = loadSettings();
  s.web = { ...(s.web || {}), ...patch };
  saveSettings(s);
}

function isPasswordSet() { return !!_web().passwordHash; }

function setPassword(password) {
  const pw = String(password || '');
  if (pw.length < 4) throw new Error('пароль слишком короткий (мин. 4 символа)');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  _saveWeb({ passwordHash: `${salt.toString('hex')}:${hash.toString('hex')}` });
}

function verifyPassword(password) {
  const stored = _web().passwordHash;
  if (!stored) return false;
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  let candidate;
  try { candidate = crypto.scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), 64); }
  catch { return false; }
  const expected = Buffer.from(hashHex, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// HMAC-секрет сессий: автогенерируется и сохраняется (переживает рестарт)
function _secret() {
  let s = _web().sessionSecret;
  if (!s) { s = crypto.randomBytes(32).toString('hex'); _saveWeb({ sessionSecret: s }); }
  return s;
}

// ── токены сессии ────────────────────────────────────────────────────────────
function _sign(data) { return crypto.createHmac('sha256', _secret()).update(data).digest('base64url'); }

function makeToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${_sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  const expSig = _sign(payload);
  const a = Buffer.from(sig), b = Buffer.from(expSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp > Date.now();
  } catch { return false; }
}

// ── куки ─────────────────────────────────────────────────────────────────────
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
function _isHttps(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function setSessionCookie(res, req, token) {
  const parts = [`${COOKIE}=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (_isHttps(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}
function isAuthed(req) {
  return verifyToken(parseCookies(req)[COOKIE]);
}

// ── анти-брутфорс по IP ──────────────────────────────────────────────────────
const _attempts = new Map(); // ip -> {fails, lockedUntil}
function loginLockMs(ip) {
  const a = _attempts.get(ip);
  if (a && a.lockedUntil > Date.now()) return a.lockedUntil - Date.now();
  return 0;
}
function noteLoginFail(ip) {
  const a = _attempts.get(ip) || { fails: 0, lockedUntil: 0 };
  a.fails++;
  if (a.fails >= 5) { a.lockedUntil = Date.now() + Math.min(15 * 60 * 1000, 30 * 1000 * 2 ** (a.fails - 5)); }
  _attempts.set(ip, a);
}
function noteLoginOk(ip) { _attempts.delete(ip); }

module.exports = {
  COOKIE, isPasswordSet, setPassword, verifyPassword,
  makeToken, verifyToken, setSessionCookie, clearSessionCookie, isAuthed,
  loginLockMs, noteLoginFail, noteLoginOk,
};
