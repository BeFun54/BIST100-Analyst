'use strict';

/**
 * Hesap veritabani (Node yerlesik node:sqlite).
 *
 * Node 22.5+ gerekir. Desteklenmiyorsa uygulama misafir modunda calismaya
 * devam eder; hesap/senkron rotalari 503 dondurur.
 *
 * Veritabani: data/bist100.db (gitignore'da)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  DatabaseSync = null;
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'bist100.db');

let db = null;
let available = false;

function init() {
  if (db) return true;
  if (!DatabaseSync) {
    available = false;
    return false;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        ai_key_enc TEXT,
        ai_provider TEXT,
        ai_base TEXT,
        ai_model TEXT,
        ai_updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        user_agent TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        qty REAL NOT NULL,
        buy_price REAL NOT NULL,
        buy_date TEXT NOT NULL,
        pattern_name TEXT,
        upside_pct REAL,
        eta TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id);

      CREATE TABLE IF NOT EXISTS favorites (
        user_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, symbol),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        symbol TEXT,
        type TEXT NOT NULL,
        severity TEXT,
        title TEXT,
        body TEXT,
        dedupe_key TEXT,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
        ON notifications(user_id, dedupe_key);
      CREATE INDEX IF NOT EXISTS idx_notifications_user
        ON notifications(user_id, created_at);

      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    available = true;
    return true;
  } catch (e) {
    available = false;
    console.error('[db] Veritabani baslatilamadi:', e.message);
    return false;
  }
}

function ensure() {
  if (!db && !init()) {
    throw new Error('Hesap veritabani kullanilamiyor (Node.js 22.5+ gerekli)');
  }
  return db;
}

function isAvailable() {
  if (!db) init();
  return available;
}

function round(n, d = 2) {
  if (n == null || !isFinite(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    aiConfigured: !!row.ai_key_enc,
    aiProvider: row.ai_provider || null,
    aiBase: row.ai_base || null,
    aiModel: row.ai_model || null,
    aiUpdatedAt: row.ai_updated_at || null
  };
}

function mapAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    symbol: row.symbol,
    qty: row.qty,
    buyPrice: row.buy_price,
    buyDate: row.buy_date,
    patternName: row.pattern_name || null,
    upsidePct: row.upside_pct == null ? null : row.upside_pct,
    eta: row.eta || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/* ------------------------------- users ------------------------------- */

function createUser({ id, email, passwordHash, passwordSalt }) {
  const d = ensure();
  d.prepare(
    'INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, email, passwordHash, passwordSalt, Date.now());
  return findUserById(id);
}

function findUserByEmail(email) {
  const d = ensure();
  return d.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
}

function findUserById(id) {
  const d = ensure();
  return d.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/* ------------------------------ sessions ----------------------------- */

function createSession({ tokenHash, userId, expiresAt, userAgent }) {
  const d = ensure();
  d.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'
  ).run(tokenHash, userId, Date.now(), expiresAt, userAgent || null);
}

function findSession(tokenHash) {
  const d = ensure();
  const row = d
    .prepare(
      'SELECT s.token_hash, s.user_id, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
    )
    .get(tokenHash);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    d.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return { user: mapUser(row), expiresAt: row.expires_at };
}

function deleteSession(tokenHash) {
  const d = ensure();
  d.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

function deleteUserSessions(userId) {
  const d = ensure();
  d.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function purgeExpiredSessions() {
  const d = ensure();
  d.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

/* ------------------------------- assets ------------------------------ */

function listAssets(userId) {
  const d = ensure();
  return d
    .prepare('SELECT * FROM assets WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId)
    .map(mapAsset);
}

function insertAsset(userId, input) {
  const d = ensure();
  const id = crypto.randomUUID();
  const now = Date.now();
  d.prepare(
    `INSERT INTO assets
      (id, user_id, symbol, qty, buy_price, buy_date, pattern_name, upside_pct, eta, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    String(input.symbol || '').toUpperCase(),
    Number(input.qty) || 0,
    Number(input.buyPrice) || 0,
    String(input.buyDate || ''),
    input.patternName ? String(input.patternName) : null,
    input.upsidePct == null ? null : Number(input.upsidePct),
    input.eta ? String(input.eta) : null,
    now,
    now
  );
  return mapAsset(d.prepare('SELECT * FROM assets WHERE id = ?').get(id));
}

function deleteAsset(userId, id) {
  const d = ensure();
  const info = d.prepare('DELETE FROM assets WHERE id = ? AND user_id = ?').run(id, userId);
  return info.changes > 0;
}

/**
 * Bu cihazdaki varliklari hesaba aktarir; ayni sembol/adet/fiyat/tarih
 * kombinasyonu zaten varsa atlar.
 */
function importAssets(userId, assets) {
  const d = ensure();
  let imported = 0;
  let skipped = 0;
  const find = d.prepare(
    'SELECT id FROM assets WHERE user_id = ? AND symbol = ? AND qty = ? AND buy_price = ? AND buy_date = ?'
  );
  for (const a of assets || []) {
    const symbol = String(a.symbol || '').toUpperCase();
    const qty = Number(a.qty) || 0;
    const buyPrice = Number(a.buyPrice) || 0;
    const buyDate = String(a.buyDate || '');
    if (!symbol || qty <= 0 || buyPrice <= 0) {
      skipped++;
      continue;
    }
    const existing = find.get(userId, symbol, qty, buyPrice, buyDate);
    if (existing) {
      skipped++;
      continue;
    }
    insertAsset(userId, {
      symbol,
      qty,
      buyPrice,
      buyDate,
      patternName: a.patternName,
      upsidePct: a.upsidePct,
      eta: a.eta
    });
    imported++;
  }
  return { imported, skipped, assets: listAssets(userId) };
}

/* ----------------------------- favorites ----------------------------- */

function listFavorites(userId) {
  const d = ensure();
  return d
    .prepare('SELECT symbol FROM favorites WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId)
    .map((r) => r.symbol);
}

function setFavorite(userId, symbol, favorite) {
  const d = ensure();
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return listFavorites(userId);
  if (favorite) {
    d.prepare('INSERT OR IGNORE INTO favorites (user_id, symbol, created_at) VALUES (?, ?, ?)').run(
      userId,
      sym,
      Date.now()
    );
  } else {
    d.prepare('DELETE FROM favorites WHERE user_id = ? AND symbol = ?').run(userId, sym);
  }
  return listFavorites(userId);
}

/* ---------------------------- bildirimler ---------------------------- */

function mapNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    symbol: row.symbol || null,
    type: row.type,
    severity: row.severity || 'info',
    title: row.title || '',
    body: row.body || '',
    dedupeKey: row.dedupe_key || null,
    createdAt: row.created_at,
    readAt: row.read_at || null
  };
}

function listNotifications(userId, limit) {
  const d = ensure();
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 200);
  return d
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, lim)
    .map(mapNotification);
}

function countUnreadNotifications(userId) {
  const d = ensure();
  return d
    .prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId).c;
}

/**
 * Bildirim ekler. dedupe_key ayni ise tekrar eklemez (INSERT OR IGNORE).
 * Donus: { created, notification }
 */
function insertNotification(userId, input) {
  const d = ensure();
  const n = input || {};
  const id = crypto.randomUUID();
  const dedupeKey = n.dedupeKey ? String(n.dedupeKey).slice(0, 200) : null;
  const createdAt = Number(n.createdAt) || Date.now();
  const info = d
    .prepare(
      `INSERT OR IGNORE INTO notifications
        (id, user_id, symbol, type, severity, title, body, dedupe_key, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      id,
      userId,
      n.symbol ? String(n.symbol).toUpperCase().slice(0, 12) : null,
      String(n.type || 'info').slice(0, 40),
      String(n.severity || 'info').slice(0, 16),
      String(n.title || '').slice(0, 160),
      String(n.body || '').slice(0, 600),
      dedupeKey,
      createdAt
    );

  if (!info.changes) {
    const existing = dedupeKey
      ? d
          .prepare('SELECT * FROM notifications WHERE user_id = ? AND dedupe_key = ?')
          .get(userId, dedupeKey)
      : null;
    return { created: false, notification: mapNotification(existing) };
  }
  const row = d.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  // Kullanici basina en yeni 200 bildirimi tut.
  d.prepare(
    `DELETE FROM notifications
     WHERE user_id = ? AND id NOT IN (
       SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200
     )`
  ).run(userId, userId);
  return { created: true, notification: mapNotification(row) };
}

function markNotificationsRead(userId, ids) {
  const d = ensure();
  const now = Date.now();
  if (Array.isArray(ids) && ids.length) {
    const stmt = d.prepare(
      'UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL'
    );
    for (const id of ids.slice(0, 200)) stmt.run(now, userId, String(id));
  } else {
    d.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(
      now,
      userId
    );
  }
  return countUnreadNotifications(userId);
}

function clearNotifications(userId) {
  const d = ensure();
  d.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
}

/* ---------------------------- kullanici ayarlari -------------------- */

function getUserSettings(userId) {
  const d = ensure();
  const row = d.prepare('SELECT data FROM user_settings WHERE user_id = ?').get(userId);
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch (_) {
    return null;
  }
}

function saveUserSettings(userId, data) {
  const d = ensure();
  const json = JSON.stringify(data && typeof data === 'object' ? data : {});
  d.prepare(
    `INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(userId, json, Date.now());
  return data || {};
}

/* ------------------------------ AI key ------------------------------- */

function setUserAiConfig(userId, { apiKeyEnc, provider, apiBase, model }) {
  const d = ensure();
  d.prepare(
    'UPDATE users SET ai_key_enc = ?, ai_provider = ?, ai_base = ?, ai_model = ?, ai_updated_at = ? WHERE id = ?'
  ).run(apiKeyEnc || null, provider || null, apiBase || null, model || null, Date.now(), userId);
  return mapUser(findUserById(userId));
}

function getUserAiConfig(userId) {
  const d = ensure();
  const row = d
    .prepare('SELECT ai_key_enc, ai_provider, ai_base, ai_model, ai_updated_at FROM users WHERE id = ?')
    .get(userId);
  if (!row) return null;
  return {
    apiKeyEnc: row.ai_key_enc || null,
    provider: row.ai_provider || null,
    apiBase: row.ai_base || null,
    model: row.ai_model || null,
    updatedAt: row.ai_updated_at || null
  };
}

function clearUserAiConfig(userId) {
  const d = ensure();
  d.prepare(
    'UPDATE users SET ai_key_enc = NULL, ai_provider = NULL, ai_base = NULL, ai_model = NULL, ai_updated_at = ? WHERE id = ?'
  ).run(Date.now(), userId);
  return mapUser(findUserById(userId));
}

module.exports = {
  DB_PATH,
  init,
  isAvailable,
  mapUser,
  createUser,
  findUserByEmail,
  findUserById,
  createSession,
  findSession,
  deleteSession,
  deleteUserSessions,
  purgeExpiredSessions,
  listAssets,
  insertAsset,
  deleteAsset,
  importAssets,
  listFavorites,
  setFavorite,
  listNotifications,
  countUnreadNotifications,
  insertNotification,
  markNotificationsRead,
  clearNotifications,
  getUserSettings,
  saveUserSettings,
  setUserAiConfig,
  getUserAiConfig,
  clearUserAiConfig
};
