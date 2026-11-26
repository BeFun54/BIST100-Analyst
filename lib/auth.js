'use strict';

/**
 * Hesap guvenligi: sifre hash'leme, oturum cerezleri, AES-256-GCM ile
 * AI anahtari sifreleme ve basit hiz siniri.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const SESSION_COOKIE = 'bist100_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 gun
const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/* --------------------------- sifre hash ---------------------------- */

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTS, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt);
  return { hash: key.toString('hex'), salt };
}

async function verifyPassword(password, hash, salt) {
  try {
    const key = await scrypt(password, salt);
    const expected = Buffer.from(hash, 'hex');
    if (expected.length !== key.length) return false;
    return crypto.timingSafeEqual(expected, key);
  } catch (_) {
    return false;
  }
}

/* --------------------------- oturumlar ----------------------------- */

function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch (_) {
      out[name] = value;
    }
  }
  return out;
}

function getCookie(req, name) {
  return parseCookies(req.headers.cookie)[name] || null;
}

function isSecure(req) {
  return (
    req.socket && req.socket.encrypted === true ||
    String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https'
  );
}

function setSessionCookie(req, res, token) {
  const maxAge = Math.floor(SESSION_TTL / 1000);
  const secure = isSecure(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    SESSION_COOKIE +
      '=' +
      encodeURIComponent(token) +
      '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
      maxAge +
      secure
  );
}

function clearSessionCookie(req, res) {
  const secure = isSecure(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secure
  );
}

function createUserSession(req, res, userId) {
  const token = createSessionToken();
  db.createSession({
    tokenHash: hashToken(token),
    userId,
    expiresAt: Date.now() + SESSION_TTL,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300)
  });
  setSessionCookie(req, res, token);
  return token;
}

function getSessionUser(req) {
  try {
    const token = getCookie(req, SESSION_COOKIE);
    if (!token) return null;
    const session = db.findSession(hashToken(token));
    return session ? session.user : null;
  } catch (_) {
    return null;
  }
}

function destroySession(req, res) {
  try {
    const token = getCookie(req, SESSION_COOKIE);
    if (token) db.deleteSession(hashToken(token));
  } catch (_) {
    /* yoksay */
  }
  clearSessionCookie(req, res);
}

/* ------------------------ AI anahtari sifreleme --------------------- */

let cachedKey = null;

function getAppSecret() {
  if (cachedKey) return cachedKey;
  const envSecret = String(process.env.APP_SECRET || '').trim();
  if (envSecret) {
    cachedKey = crypto.createHash('sha256').update(envSecret).digest();
    return cachedKey;
  }
  const secretPath = path.join(__dirname, '..', 'data', '.secret');
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 32) {
      cachedKey = crypto.createHash('sha256').update(existing).digest();
      return cachedKey;
    }
  } catch (_) {
    /* dosya yok: olustur */
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  } catch (e) {
    console.error('[auth] data/.secret yazilamadi:', e.message);
  }
  cachedKey = crypto.createHash('sha256').update(secret).digest();
  return cachedKey;
}

function encryptSecret(plain) {
  const key = getAppSecret();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    'v1.' +
    iv.toString('base64url') +
    '.' +
    tag.toString('base64url') +
    '.' +
    enc.toString('base64url')
  );
}

function decryptSecret(payload) {
  if (!payload) return null;
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const key = getAppSecret();
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const data = Buffer.from(parts[3], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

/* --------------------------- dogrulama ------------------------------ */

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  const value = normalizeEmail(email);
  return value.length >= 5 && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200;
}

/* ---------------------------- hiz siniri ---------------------------- */

const buckets = new Map();

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1 };
  }
  if (entry.count >= max) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true, remaining: max - entry.count };
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL,
  hashPassword,
  verifyPassword,
  createSessionToken,
  hashToken,
  parseCookies,
  getCookie,
  setSessionCookie,
  clearSessionCookie,
  createUserSession,
  getSessionUser,
  destroySession,
  encryptSecret,
  decryptSecret,
  normalizeEmail,
  isValidEmail,
  isValidPassword,
  rateLimit,
  clientIp
};
