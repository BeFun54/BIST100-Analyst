'use strict';

/**
 * BIST100 Analist V2 - sunucu (v2)
 *  - Statik dosya sunumu (public/)
 *  - Yahoo Finance ve haber uclari icin guvenli proxy
 *  - Basit TTL onbellek (cani fiyat verisi icin)
 *  - AI: OpenAI uyumlu saglayicilar (EVREN/NVIDIA/OpenAI/...)
 *  - Hesaplar: e-posta + sifre, SQLite, cerez oturumu
 *  - AI anahtari: hesapta AES-256-GCM ile sifreli saklanabilir
 *
 * Bagimlilik yoktur; sadece "node server.js" ile calisir.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('./lib/env'); // proje kokundeki .env dosyasini yukler (varsa)

const yahoo = require('./lib/yahoo');
const news = require('./lib/news');
const goldSource = require('./lib/gold');
const ai = require('./lib/ai');
const db = require('./lib/db');
const auth = require('./lib/auth');
const { BIST100, bySymbol } = require('./data/bist100');
const {
  PATTERN_LIBRARY,
  scanBullishPatterns,
  scanBearishPatterns,
  etaLabel,
  computeIndicators
} = require('./lib/patterns');

const PORT = process.env.PORT || 3010;
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ *
 *  Onbellek
 * ------------------------------------------------------------------ */

const cache = new Map(); // key -> { expires, value }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { expires: Date.now() + ttlMs, value });
  return value;
}

/** Ayni anda ayni kaynaga yapilan istekleri birlestirir. */
const inflight = new Map();
function dedupe(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ------------------------------------------------------------------ *
 *  Yardimcilar
 * ------------------------------------------------------------------ */

function round(n, d = 2) {
  if (n == null || !isFinite(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function pctChange(from, to) {
  if (from == null || to == null || from === 0) return null;
  return round(((to - from) / from) * 100, 2);
}

function avg(arr) {
  if (!arr || !arr.length) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

/** Bir formasyon sonucundan sadece istemciye gidecek alanlari birakir. */
function publicFormation(f) {
  if (!f) return f;
  const { context, ...rest } = f; // eslint-disable-line no-unused-vars
  return rest;
}

/** Seride indeksten geriye dogru kapanis (negatif = geriye). */
function closeAgo(points, backSteps) {
  if (!points.length) return null;
  const idx = points.length - 1 - backSteps;
  if (idx < 0) return points[0].c;
  return points[idx].c;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, X-AI-Key, X-AI-Base, X-AI-Model, X-AI-Provider'
  });
  res.end(body);
}

/* ISTEK GOVDESI OKUYUCU (JSON POST icin, 1 MB sinirli) */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        tooBig = true;
        chunks.length = 0;
        return;
      }
      if (!tooBig) chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(new Error('Istek govdesi cok buyuk'));
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('Gecersiz JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Istemcinin gonderdigi kullanici bazli AI ayarlari (basliklar). */
function readHeaderAiOverrides(req, body) {
  const h = req.headers || {};
  const val = (name) => (h[name] ? String(h[name]).trim() : '');
  const b = body || {};
  return {
    apiKey: String(b.apiKey || val('x-ai-key') || '').trim(),
    apiBase: String(b.apiBase || val('x-ai-base') || '').trim(),
    model: String(b.model || val('x-ai-model') || '').trim(),
    provider: String(b.provider || val('x-ai-provider') || '').trim()
  };
}

function currentUser(req) {
  if (req._bistUser !== undefined) return req._bistUser;
  req._bistUser = auth.getSessionUser(req);
  return req._bistUser;
}

/**
 * AI ayarlari: once istek basliklari, yoksa oturum sahibinin hesabinda
 * sifreli saklanan anahtar.
 */
function readAiOverrides(req, body) {
  const header = readHeaderAiOverrides(req, body);
  if (header.apiKey) return header;
  const user = currentUser(req);
  if (!user) return header;
  try {
    const stored = db.getUserAiConfig(user.id);
    if (stored && stored.apiKeyEnc) {
      const key = auth.decryptSecret(stored.apiKeyEnc);
      if (key) {
        return {
          apiKey: key,
          apiBase: stored.apiBase || '',
          model: stored.model || '',
          provider: stored.provider || ''
        };
      }
    }
  } catch (_) {
    /* veritabani yoksa baslik/env ile devam */
  }
  return header;
}

function hasAiKey(overrides) {
  return !!ai.resolveConfig(overrides).apiKey;
}

function isLocalRequest(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return true;
  try {
    return new URL(origin).host === host;
  } catch (_) {
    return false;
  }
}

function accountsAvailable(res) {
  if (db.isAvailable()) return true;
  sendJson(res, 503, {
    error: 'Hesap özellikleri için Node.js 22.5+ gerekli',
    code: 'accounts_unavailable'
  });
  return false;
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) {
    sendJson(res, 401, {
      error: 'Bu işlem için oturum açmanız gerekiyor',
      code: 'auth_required'
    });
    return null;
  }
  return user;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    aiConfigured: !!user.aiConfigured
  };
}

function aiKeyRequired(res) {
  return sendJson(res, 400, {
    error: 'AI özellikleri için API anahtarı gerekli',
    detail: 'Sağ üstteki "🔑 API" bölümünden anahtarınızı girin.',
    code: 'ai_key_missing'
  });
}

/* ------------------------------------------------------------------ *
 *  API : /api/overview
 * ------------------------------------------------------------------ */

async function buildOverview() {
  const symbols = BIST100.map((s) => s.yahoo);

  // 1) Spark : tek istekte tum hisseler icin son 1 aylik gunluk kapanis serileri
  let spark = {};
  try {
    spark = await yahoo.getSpark(symbols, '1mo', '1d');
  } catch (e) {
    spark = {};
  }

  // 2) Quote : isim / anlik fiyat / hacim / piyasa degeri (opsiyonel zenginlik)
  let quotes = {};
  try {
    quotes = await yahoo.getQuotes(symbols);
  } catch (e) {
    quotes = {};
  }

  const items = BIST100.map((stock) => {
    const sp = spark[stock.yahoo];
    const q = quotes[stock.yahoo] || {};
    const points = sp ? sp.points : [];
    const meta = sp ? sp.meta : {};

    const lastClose = points.length ? points[points.length - 1].c : null;
    const prevClose = closeAgo(points, 1);

    const price =
      q.regularMarketPrice != null
        ? q.regularMarketPrice
        : meta.regularMarketPrice != null
        ? meta.regularMarketPrice
        : lastClose;

    const changePercent =
      q.regularMarketChangePercent != null
        ? round(q.regularMarketChangePercent, 2)
        : pctChange(prevClose, price);

    const change =
      q.regularMarketChange != null
        ? round(q.regularMarketChange, 2)
        : price != null && prevClose != null
        ? round(price - prevClose, 2)
        : null;

    const weekBase = closeAgo(points, 5);
    const monthBase = closeAgo(points, 21);

    return {
      symbol: stock.symbol,
      name: q.longName || q.shortName || stock.name,
      price: round(price, 2),
      change,
      changePercent,
      weekChangePercent: pctChange(weekBase, price),
      monthChangePercent: pctChange(monthBase, price),
      volume: q.regularMarketVolume != null ? q.regularMarketVolume : null,
      marketCap: q.marketCap != null ? q.marketCap : null,
      dayHigh:
        q.regularMarketDayHigh != null
          ? q.regularMarketDayHigh
          : meta.regularMarketDayHigh || null,
      dayLow:
        q.regularMarketDayLow != null
          ? q.regularMarketDayLow
          : meta.regularMarketDayLow || null,
      sparkline: points.slice(-30).map((p) => round(p.c, 2))
    };
  });

  return { updatedAt: Date.now(), items };
}

async function getOverviewCached() {
  let data = cacheGet('overview');
  if (!data) {
    data = await dedupe('overview', () =>
      buildOverview().then((v) => cacheSet('overview', v, 60 * 1000))
    );
  }
  return data;
}

/* ------------------------------------------------------------------ *
 *  API : /api/gold
 *  Birincil kaynak: Truncgil Finans (dogrudan gram/ceyrek/tam/ons).
 *  Erisilemezse lib/gold.js icindeki Yahoo yedegi devreye girer.
 * ------------------------------------------------------------------ */

async function getGoldCached() {
  let data = cacheGet('gold');
  if (!data) {
    data = await dedupe('gold', () =>
      goldSource.getGold().then((v) => cacheSet('gold', v, 60 * 1000))
    );
  }
  return data;
}

/* ------------------------------------------------------------------ *
 *  API : /api/formations
 * ------------------------------------------------------------------ */

function buildFormationItem(stock, match, direction, lastClose, context) {
  const lib = PATTERN_LIBRARY[match.key];
  const expectedPct = direction === 'bullish' ? match.upsidePct : match.downsidePct;
  const targetPrice =
    lastClose != null && expectedPct != null
      ? round(
          direction === 'bullish'
            ? lastClose * (1 + expectedPct / 100)
            : lastClose * (1 - expectedPct / 100),
          2
        )
      : null;
  return {
    symbol: stock.symbol,
    name: stock.name,
    lastClose: round(lastClose, 2),
    direction,
    pattern: match.key,
    patternName: lib ? lib.name : match.key,
    type: lib ? lib.type : '',
    reliability: lib ? lib.reliability : '',
    eta: etaLabel(match.key, Date.now()),
    timeframe: lib ? lib.timeframe : '',
    description: lib ? lib.description : '',
    confidence: match.confidence,
    upsidePct: Math.round(expectedPct * 10) / 10,
    targetPrice,
    detail: match.detail,
    context
  };
}

async function buildFormations(dir = 'bullish') {
  const symbols = BIST100.map((s) => s.yahoo);
  let spark = {};
  try {
    spark = await yahoo.getSpark(symbols, '1y', '1d');
  } catch (e) {
    spark = {};
  }

  const stats = {
    scanned: BIST100.length,
    withData: 0,
    tooShort: 0,
    perPattern: {}
  };
  const scanBullish = dir === 'bullish' || dir === 'all';
  const scanBearish = dir === 'bearish' || dir === 'all';

  // Hisse + yon basina en iyi (yuksek guven) eslesmeyi tut.
  const bestByStockDir = new Map();
  const stockBullish = new Set();
  const stockBearish = new Set();

  const pushResult = (stock, m, direction, lastClose, context) => {
    const key = stock.symbol + '|' + direction;
    const existing = bestByStockDir.get(key);
    if (!existing || m.confidence > existing.m.confidence) {
      bestByStockDir.set(key, { stock, m, direction, lastClose, context });
    }
    if (direction === 'bullish') stockBullish.add(stock.symbol);
    else stockBearish.add(stock.symbol);
  };

  for (const stock of BIST100) {
    const sp = spark[stock.yahoo];
    if (!sp || !sp.points || !sp.points.length) continue;
    if (sp.points.length < 60) {
      stats.tooShort++;
      continue;
    }
    stats.withData++;

    const allCloses = sp.points.map((p) => p.c);
    const lastClose = allCloses[allCloses.length - 1];
    const w60 = allCloses.slice(-60);
    const ind = computeIndicators(sp.points) || {};
    const context = {
      series: allCloses.slice(-20).map((c) => round(c, 2)),
      high60: round(Math.max.apply(null, w60), 2),
      low60: round(Math.min.apply(null, w60), 2),
      ma50: allCloses.length >= 50 ? round(avg(allCloses.slice(-50)), 2) : null,
      ma200: allCloses.length >= 200 ? round(avg(allCloses.slice(-200)), 2) : null,
      rsi14: ind.rsi14 != null ? ind.rsi14 : null,
      trend: ind.trend || ''
    };

    if (scanBullish) {
      const matches = scanBullishPatterns(sp.points);
      for (const m of matches) pushResult(stock, m, 'bullish', lastClose, context);
    }
    if (scanBearish) {
      const matches = scanBearishPatterns(sp.points);
      for (const m of matches) pushResult(stock, m, 'bearish', lastClose, context);
    }
  }

  // 'all' modunda iki yonde de eslesen hisseleri ele (belirsiz sinyal).
  const cancelledSymbols = new Set();
  if (dir === 'all') {
    for (const sym of stockBullish) {
      if (stockBearish.has(sym)) cancelledSymbols.add(sym);
    }
  }

  const bullishResults = [];
  const bearishResults = [];

  for (const [, { stock, m, direction, lastClose, context }] of bestByStockDir) {
    if (cancelledSymbols.has(stock.symbol)) continue;
    const item = buildFormationItem(stock, m, direction, lastClose, context);
    stats.perPattern[m.key] = (stats.perPattern[m.key] || 0) + 1;
    if (direction === 'bullish') bullishResults.push(item);
    else bearishResults.push(item);
  }

  const sortFn = (a, b) =>
    b.confidence - a.confidence ||
    (b.upsidePct || 0) - (a.upsidePct || 0);
  bullishResults.sort(sortFn);
  bearishResults.sort(sortFn);

  if (dir === 'all') {
    return {
      updatedAt: Date.now(),
      scanned: stats.withData,
      dir: 'all',
      bullish: { stats, count: bullishResults.length, results: bullishResults },
      bearish: { stats, count: bearishResults.length, results: bearishResults }
    };
  }

  const allResults = dir === 'bullish' ? bullishResults : bearishResults;
  return {
    updatedAt: Date.now(),
    stats,
    count: allResults.length,
    dir,
    results: allResults
  };
}

async function getFormationsCached(dir) {
  const key = 'formations:' + dir;
  let data = cacheGet(key);
  if (!data) {
    data = await dedupe(key, () =>
      buildFormations(dir).then((v) => cacheSet(key, v, 15 * 60 * 1000))
    );
  }
  return data;
}

/**
 * AI dogrulama sonuclarini formasyon listesine isler.
 *  - approve : degerler korunur, AI yorumu eklenir
 *  - adjust  : upsidePct / confidence AI degerleriyle guncellenir
 *  - reject  : formasyon listeden cikarilir
 *  - AI degerlendirmemisse: formasyon korunur (unvalidated)
 */
function mergeValidations(base, validations, aiError) {
  if (!base) return base;
  if (!validations || !validations.length) {
    return Object.assign({}, base, {
      aiValidated: false,
      aiError: aiError || 'AI doğrulaması alınamadı.',
      aiSummary: {
        approved: 0,
        adjusted: 0,
        rejected: 0,
        scanned: (base.results || []).length,
        unvalidated: (base.results || []).length
      }
    });
  }

  const norm = (s) => String(s || '').toUpperCase().trim();
  const keyOf = (f) => norm(f.symbol) + '|' + norm(f.patternName || f.pattern);
  const altKeyOf = (f) => norm(f.symbol) + '|' + norm(f.pattern);

  const byKey = new Map();
  for (const v of validations) {
    byKey.set(norm(v.symbol) + '|' + norm(v.pattern), v);
  }

  const kept = [];
  let approved = 0;
  let adjusted = 0;
  let rejected = 0;
  let unvalidated = 0;

  for (const f of base.results || []) {
    const v = byKey.get(keyOf(f)) || byKey.get(altKeyOf(f));
    if (!v) {
      unvalidated++;
      kept.push(publicFormation(f));
      continue;
    }
    const verdict = String(v.verdict || '').toLowerCase();
    if (verdict === 'reject') {
      rejected++;
      continue;
    }
    const out = Object.assign(publicFormation(f), {
      aiVerdict: verdict || 'approve',
      aiComment: v.comment || ''
    });
    if (verdict === 'adjust') {
      if (v.adjustedUpsidePct != null && isFinite(Number(v.adjustedUpsidePct))) {
        const candidate = round(
          Math.max(1, Math.min(35, Number(v.adjustedUpsidePct))),
          1
        );
        // AI yalnizca hedefi dusurebilir; orijinalin uzerine cikamaz.
        const newUp =
          f.upsidePct != null ? Math.min(f.upsidePct, candidate) : candidate;
        if (f.upsidePct == null || newUp !== f.upsidePct) {
          out.origUpsidePct = f.upsidePct;
          out.upsidePct = newUp;
          if (f.lastClose != null) {
            out.targetPrice =
              f.direction === 'bearish'
                ? round(f.lastClose * (1 - out.upsidePct / 100), 2)
                : round(f.lastClose * (1 + out.upsidePct / 100), 2);
          }
        }
      }
      if (v.adjustedConfidence != null && isFinite(Number(v.adjustedConfidence))) {
        const candidate = Math.max(
          10,
          Math.min(95, Math.round(Number(v.adjustedConfidence)))
        );
        const newConf =
          f.confidence != null ? Math.min(f.confidence, candidate) : candidate;
        if (f.confidence == null || newConf !== f.confidence) {
          out.origConfidence = f.confidence;
          out.confidence = newConf;
        }
      }
      adjusted++;
    } else {
      approved++;
    }
    kept.push(out);
  }

  kept.sort(
    (a, b) => b.confidence - a.confidence || (b.upsidePct || 0) - (a.upsidePct || 0)
  );

  return {
    updatedAt: Date.now(),
    stats: base.stats,
    count: kept.length,
    dir: base.dir,
    aiValidated: true,
    aiError: aiError || null,
    aiSummary: {
      approved,
      adjusted,
      rejected,
      unvalidated,
      scanned: (base.results || []).length
    },
    results: kept
  };
}

/* ------------------------------------------------------------------ *
 *  AI veri hazirlama
 * ------------------------------------------------------------------ */

function marketBreadth(items) {
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const it of items) {
    if (it.changePercent == null) continue;
    if (it.changePercent > 0.01) up++;
    else if (it.changePercent < -0.01) down++;
    else flat++;
  }
  return { total: items.length, up, down, flat };
}

function byChange(items, key, descending, n) {
  return items
    .filter((it) => it[key] != null && isFinite(it[key]))
    .sort((a, b) => (descending ? b[key] - a[key] : a[key] - b[key]))
    .slice(0, n)
    .map((it) => ({ symbol: it.symbol, name: it.name, changePercent: it[key] }));
}

function buildMarketAiInput(overview, formations, marketNews, gold, index) {
  const items = (overview && overview.items) || [];
  return {
    breadth: marketBreadth(items),
    index: index || null,
    topGainers: byChange(items, 'changePercent', true, 6),
    topLosers: byChange(items, 'changePercent', false, 6),
    weekLeaders: byChange(items, 'weekChangePercent', true, 6),
    weekLosers: byChange(items, 'weekChangePercent', false, 6),
    monthLeaders: byChange(items, 'monthChangePercent', true, 6),
    monthLosers: byChange(items, 'monthChangePercent', false, 6),
    formations: {
      bullish: ((formations && formations.bullish && formations.bullish.results) || []).slice(0, 10),
      bearish: ((formations && formations.bearish && formations.bearish.results) || []).slice(0, 10)
    },
    news: marketNews || [],
    gold: gold || null
  };
}

function findSupportResistance(candles) {
  if (!candles || candles.length < 10) return { support: null, resistance: null };
  const last = candles[candles.length - 1].c;
  const recent = candles.slice(-80);
  const supports = [];
  const resistances = [];
  for (let i = 3; i < recent.length - 3; i++) {
    const cur = recent[i];
    if (cur.l == null || cur.h == null) continue;
    let isLow = true;
    let isHigh = true;
    for (let j = i - 3; j <= i + 3; j++) {
      if (j === i) continue;
      if (recent[j].l < cur.l) isLow = false;
      if (recent[j].h > cur.h) isHigh = false;
    }
    if (isLow && cur.l < last * 1.01) supports.push(cur.l);
    if (isHigh && cur.h > last * 0.99) resistances.push(cur.h);
  }
  const last20 = recent.slice(-20);
  let support = supports.length
    ? Math.max.apply(null, supports)
    : Math.min.apply(null, last20.map((c) => c.l != null ? c.l : c.c));
  let resistance = resistances.length
    ? Math.min.apply(null, resistances)
    : Math.max.apply(null, last20.map((c) => c.h != null ? c.h : c.c));
  if (support != null && support > last) support = last * 0.97;
  if (resistance != null && resistance < last) resistance = last * 1.03;
  return { support: round(support, 2), resistance: round(resistance, 2) };
}

function changeOver(candles, bars) {
  if (!candles || candles.length < 2) return null;
  const last = candles[candles.length - 1].c;
  const idx = Math.max(0, candles.length - 1 - bars);
  return pctChange(candles[idx].c, last);
}

function buildStockFormations(symbol, name, lastClose, candles) {
  const bull = scanBullishPatterns(candles);
  const bear = scanBearishPatterns(candles);
  const mk = (m, direction) => {
    const lib = PATTERN_LIBRARY[m.key] || {};
    const expected = direction === 'bullish' ? m.upsidePct : m.downsidePct;
    const targetPrice =
      lastClose != null && expected != null
        ? round(
            direction === 'bullish'
              ? lastClose * (1 + expected / 100)
              : lastClose * (1 - expected / 100),
            2
          )
        : null;
    return {
      symbol,
      name,
      direction,
      pattern: m.key,
      patternName: lib.name || m.key,
      type: lib.type || '',
      reliability: lib.reliability || '',
      description: lib.description || '',
      timeframe: lib.timeframe || '',
      eta: etaLabel(m.key, Date.now()),
      confidence: m.confidence,
      upsidePct: expected,
      targetPrice,
      lastClose: round(lastClose, 2),
      detail: m.detail
    };
  };
  return {
    bullish: bull.map((m) => mk(m, 'bullish')),
    bearish: bear.map((m) => mk(m, 'bearish'))
  };
}

function buildStockAiInput(symbol, stock, daily, weekly, overview) {
  const candles = (daily && daily.candles) || [];
  const last = candles.length ? candles[candles.length - 1].c : null;
  const ind = computeIndicators(candles) || {};
  const levels = findSupportResistance(candles);
  const items = (overview && overview.items) || [];
  const breadth = marketBreadth(items);
  const tone =
    breadth.up > breadth.down * 1.2
      ? 'pozitif'
      : breadth.down > breadth.up * 1.2
      ? 'negatif'
      : 'karışık';

  const weeklyCandles = (weekly && weekly.candles) || [];
  return {
    symbol,
    name: stock ? stock.name : symbol,
    price: round(last, 2),
    changes: {
      daily: changeOver(candles, 1),
      weekly: changeOver(candles, 5),
      monthly: changeOver(candles, 21),
      quarterly: changeOver(candles, 63),
      yearly: changeOver(candles, 240)
    },
    ind,
    levels,
    dailyCloses: candles.slice(-20).map((c) => round(c.c, 2)),
    weeklyCloses: weeklyCandles.slice(-12).map((c) => round(c.c, 2)),
    formations: buildStockFormations(symbol, stock ? stock.name : symbol, last, candles),
    news: [],
    market: {
      up: breadth.up,
      down: breadth.down,
      flat: breadth.flat,
      tone
    }
  };
}

/* ------------------------------------------------------------------ *
 *  API yonlendirme
 * ------------------------------------------------------------------ */

async function handleApi(req, res, urlObj) {
  const p = urlObj.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Accept, X-AI-Key, X-AI-Base, X-AI-Model, X-AI-Provider'
    });
    return res.end();
  }

  // Ayni kaynak disindan gelen yazma isteklerini reddet (CSRF korumasi).
  if (
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
    !sameOrigin(req)
  ) {
    return sendJson(res, 403, {
      error: 'Gecersiz istek kaynagi',
      code: 'csrf_rejected'
    });
  }

  /* ---------------------------- hesaplar ---------------------------- */

  if (p === '/api/auth/register') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Yontem desteklemiyor' });
    if (!accountsAvailable(res)) return;
    const ip = auth.clientIp(req);
    const rl = auth.rateLimit('register:' + ip, 8, 15 * 60 * 1000);
    if (!rl.allowed) {
      return sendJson(res, 429, {
        error: 'Cok fazla kayit denemesi. Lutfen biraz sonra tekrar deneyin.',
        retryAfter: rl.retryAfter
      });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || 'Gecersiz istek') });
    }
    const email = auth.normalizeEmail(body.email);
    const password = String(body.password || '');
    if (!auth.isValidEmail(email)) {
      return sendJson(res, 400, { error: 'Gecerli bir e-posta adresi girin.' });
    }
    if (!auth.isValidPassword(password)) {
      return sendJson(res, 400, { error: 'Sifre en az 8 karakter olmalidir.' });
    }
    try {
      if (db.findUserByEmail(email)) {
        return sendJson(res, 409, { error: 'Bu e-posta ile bir hesap zaten var.' });
      }
      const { hash, salt } = await auth.hashPassword(password);
      const row = db.createUser({
        id: crypto.randomUUID(),
        email,
        passwordHash: hash,
        passwordSalt: salt
      });
      auth.createUserSession(req, res, row.id);
      const user = db.mapUser(row);
      req._bistUser = user;
      return sendJson(res, 201, {
        authenticated: true,
        accounts: true,
        user: publicUser(user)
      });
    } catch (e) {
      return sendJson(res, 500, {
        error: 'Hesap olusturulamadi',
        detail: String((e && e.message) || e)
      });
    }
  }

  if (p === '/api/auth/login') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Yontem desteklemiyor' });
    if (!accountsAvailable(res)) return;
    const ip = auth.clientIp(req);
    const rl = auth.rateLimit('login:' + ip, 10, 15 * 60 * 1000);
    if (!rl.allowed) {
      return sendJson(res, 429, {
        error: 'Cok fazla giris denemesi. Lutfen biraz sonra tekrar deneyin.',
        retryAfter: rl.retryAfter
      });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || 'Gecersiz istek') });
    }
    const email = auth.normalizeEmail(body.email);
    const password = String(body.password || '');
    if (!email || !password) {
      return sendJson(res, 400, { error: 'E-posta ve sifre gerekli.' });
    }
    try {
      const row = db.findUserByEmail(email);
      const ok =
        row && (await auth.verifyPassword(password, row.password_hash, row.password_salt));
      if (!ok) {
        return sendJson(res, 401, { error: 'E-posta veya sifre hatali.' });
      }
      db.purgeExpiredSessions();
      auth.createUserSession(req, res, row.id);
      const user = db.mapUser(row);
      req._bistUser = user;
      return sendJson(res, 200, {
        authenticated: true,
        accounts: true,
        user: publicUser(user)
      });
    } catch (e) {
      return sendJson(res, 500, {
        error: 'Giris yapilamadi',
        detail: String((e && e.message) || e)
      });
    }
  }

  if (p === '/api/auth/logout') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Yontem desteklemiyor' });
    auth.destroySession(req, res);
    req._bistUser = null;
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/auth/me') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Yontem desteklemiyor' });
    if (!accountsAvailable(res)) return;
    const user = currentUser(req);
    if (!user) {
      return sendJson(res, 200, {
        authenticated: false,
        accounts: true
      });
    }
    return sendJson(res, 200, {
      authenticated: true,
      accounts: true,
      user: publicUser(user)
    });
  }

  if (p === '/api/auth/ai-key') {
    if (!accountsAvailable(res)) return;
    const user = requireUser(req, res);
    if (!user) return;
    if (req.method === 'DELETE') {
      try {
        db.clearUserAiConfig(user.id);
        return sendJson(res, 200, { ok: true, configured: false, source: 'account' });
      } catch (e) {
        return sendJson(res, 500, {
          error: 'Anahtar silinemedi',
          detail: String((e && e.message) || e)
        });
      }
    }
    if (req.method !== 'PUT' && req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Yontem desteklemiyor' });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || 'Gecersiz istek') });
    }
    const apiKey = String(body.apiKey || '').trim();
    if (!apiKey || apiKey.length > 4096) {
      return sendJson(res, 400, { error: 'Gecerli bir API anahtari girin.' });
    }
    const provider = String(body.provider || '').slice(0, 40);
    const apiBase = String(body.apiBase || '').slice(0, 500);
    const model = String(body.model || '').slice(0, 200);
    try {
      const enc = auth.encryptSecret(apiKey);
      const updated = db.setUserAiConfig(user.id, {
        apiKeyEnc: enc,
        provider,
        apiBase,
        model
      });
      req._bistUser = updated;
      return sendJson(res, 200, {
        ok: true,
        config: {
          configured: true,
          provider: updated.aiProvider || provider,
          apiBase: updated.aiBase || apiBase,
          model: updated.aiModel || model,
          source: 'account'
        }
      });
    } catch (e) {
      return sendJson(res, 500, {
        error: 'Anahtar kaydedilemedi',
        detail: String((e && e.message) || e)
      });
    }
  }

  /* ---------------------------- varliklar --------------------------- */

  if (p === '/api/assets') {
    if (!accountsAvailable(res)) return;
    const user = requireUser(req, res);
    if (!user) return;
    if (req.method === 'GET') {
      try {
        return sendJson(res, 200, { assets: db.listAssets(user.id) });
      } catch (e) {
        return sendJson(res, 500, {
          error: 'Varliklar alinamadi',
          detail: String((e && e.message) || e)
        });
      }
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: String(e.message || 'Gecersiz istek') });
      }
      const symbol = String(body.symbol || '').toUpperCase().trim();
      const qty = Number(body.qty);
      const buyPrice = Number(body.buyPrice);
      const buyDate = String(body.buyDate || '').slice(0, 10);
      if (!/^[A-Z0-9]{2,12}$/.test(symbol)) {
        return sendJson(res, 400, { error: 'Gecerli bir hisse sembolu girin.' });
      }
      if (!isFinite(qty) || qty <= 0) {
        return sendJson(res, 400, { error: 'Adet sifirdan buyuk olmalidir.' });
      }
      if (!isFinite(buyPrice) || buyPrice <= 0) {
        return sendJson(res, 400, { error: 'Alis fiyati sifirdan buyuk olmalidir.' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(buyDate)) {
        return sendJson(res, 400, { error: 'Gecerli bir alis tarihi girin.' });
      }
      try {
        const asset = db.insertAsset(user.id, {
          symbol,
          qty,
          buyPrice,
          buyDate,
          patternName: body.patternName,
          upsidePct: body.upsidePct,
          eta: body.eta
        });
        return sendJson(res, 201, { asset });
      } catch (e) {
        return sendJson(res, 500, {
          error: 'Varlik kaydedilemedi',
          detail: String((e && e.message) || e)
        });
      }
    }
    return sendJson(res, 405, { error: 'Yontem desteklemiyor' });
  }

  if (p === '/api/assets/import') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Yontem desteklemiyor' });
    if (!accountsAvailable(res)) return;
    const user = requireUser(req, res);
    if (!user) return;
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || 'Gecersiz istek') });
    }
    const list = Array.isArray(body.assets) ? body.assets : null;
    if (!list) return sendJson(res, 400, { error: 'assets dizisi gerekli.' });
    if (list.length > 500) {
      return sendJson(res, 400, { error: 'Tek seferde en fazla 500 varlik aktarilabilir.' });
    }
    try {
      const result = db.importAssets(user.id, list);
      return sendJson(res, 200, Object.assign({ ok: true }, result));
    } catch (e) {
      return sendJson(res, 500, {
        error: 'Varliklar aktarilamadi',
        detail: String((e && e.message) || e)
      });
    }
  }

  const assetMatch = p.match(/^\/api\/assets\/([^/]+)$/);
  if (assetMatch) {
    if (req.method !== 'DELETE') {
      return sendJson(res, 405, { error: 'Yontem desteklemiyor' });
    }
    if (!accountsAvailable(res)) return;
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const removed = db.deleteAsset(user.id, decodeURIComponent(assetMatch[1]));
      if (!removed) return sendJson(res, 404, { error: 'Varlik bulunamadi' });
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, {
        error: 'Varlik silinemedi',
        detail: String((e && e.message) || e)
      });
    }
  }

  /* ----------------------------- favoriler -------------------------- */

  if (p === '/api/favorites') {
    if (!accountsAvailable(res)) return;
    const user = requireUser(req, res);
    if (!user) return;
    if (req.method === 'GET') {
      try {
        return sendJson(res, 200, { favorites: db.listFavorites(user.id) });
      } catch (e) {
        return sendJson(res, 500, {
          error: 'Favoriler alinamadi',
          detail: String((e && e.message) || e)
        });
      }
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: String(e.message || 'Gecersiz istek') });
      }
      const symbol = String(body.symbol || '').toUpperCase().trim();
      if (!/^[A-Z0-9]{2,12}$/.test(symbol)) {
        return sendJson(res, 400, { error: 'Gecerli bir hisse sembolu girin.' });
      }
      try {
        const favorites = db.setFavorite(user.id, symbol, body.favorite !== false);
        return sendJson(res, 200, { ok: true, favorites });
      } catch (e) {
        return sendJson(res, 500, {
          error: 'Favori guncellenemedi',
          detail: String((e && e.message) || e)
        });
      }
    }
    return sendJson(res, 405, { error: 'Yontem desteklemiyor' });
  }

  if (p === '/api/overview') {
    const data = await getOverviewCached();
    return sendJson(res, 200, data);
  }

  if (p === '/api/gold') {
    try {
      const data = await getGoldCached();
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 502, {
        error: 'Altin verisi alinamadi',
        detail: String((e && e.message) || e)
      });
    }
  }

  if (p === '/api/formations') {
    const dir = urlObj.searchParams.get('dir') || 'bullish';
    const data = await getFormationsCached(dir);
    if (dir === 'all') {
      return sendJson(res, 200, {
        ...data,
        bullish: {
          ...data.bullish,
          results: (data.bullish.results || []).map(publicFormation)
        },
        bearish: {
          ...data.bearish,
          results: (data.bearish.results || []).map(publicFormation)
        }
      });
    }
    return sendJson(res, 200, {
      ...data,
      results: (data.results || []).map(publicFormation)
    });
  }

  if (p === '/api/ai-formations') {
    const dir = urlObj.searchParams.get('dir') || 'bullish';
    const overrides = readAiOverrides(req);
    if (!hasAiKey(overrides)) return aiKeyRequired(res);
    const sig = ai.configSignature(overrides);
    const fresh = urlObj.searchParams.get('fresh') === '1';
    const ckey = 'ai:formations:' + dir + ':' + sig;
    let data = fresh ? undefined : cacheGet(ckey);
    if (!data) {
      try {
        if (dir === 'all') {
          const base = await getFormationsCached('all');
          const bullSlice = (base.bullish.results || []).slice(0, 10);
          const bearSlice = (base.bearish.results || []).slice(0, 10);

          const [bRes, aRes] = await Promise.allSettled([
            ai.validateFormations(bullSlice, overrides),
            ai.validateFormations(bearSlice, overrides)
          ]);
          const bVal = bRes.status === 'fulfilled' ? bRes.value : { validations: [], error: String(bRes.reason && bRes.reason.message) };
          const aVal = aRes.status === 'fulfilled' ? aRes.value : { validations: [], error: String(aRes.reason && aRes.reason.message) };

          const bullish = mergeValidations(base.bullish, bVal.validations, bVal.error);
          const bearish = mergeValidations(base.bearish, aVal.validations, aVal.error);

          let comparison = '';
          try {
            comparison = await ai.compareDirections(bullish.results, bearish.results, overrides);
          } catch (e) {
            comparison = 'AI karşılaştırması alınamadı: ' + String((e && e.message) || e);
          }
          data = {
            updatedAt: Date.now(),
            dir: 'all',
            bullish,
            bearish,
            comparison
          };
        } else {
          const base = await getFormationsCached(dir);
          const slice = (base.results || []).slice(0, 10);
          let val;
          try {
            val = await ai.validateFormations(slice, overrides);
          } catch (e) {
            val = { validations: [], error: String((e && e.message) || e) };
          }
          data = mergeValidations(base, val.validations, val.error);
          data.dir = dir;
        }
        cacheSet(ckey, data, 30 * 60 * 1000);
      } catch (e) {
        return sendJson(res, 502, {
          error: 'AI formasyon doğrulaması alınamadı',
          detail: String((e && e.message) || e)
        });
      }
    }
    return sendJson(res, 200, data);
  }

  if (p === '/api/chart') {
    const symbol = (urlObj.searchParams.get('symbol') || '').toUpperCase();
    const range = urlObj.searchParams.get('range') || '1y';
    const stock = bySymbol[symbol];
    if (!stock) return sendJson(res, 400, { error: 'Bilinmeyen sembol' });

    const key = 'chart:' + symbol + ':' + range;
    let data = cacheGet(key);
    if (!data) {
      try {
        data = await dedupe(key, () =>
          yahoo.getChart(stock.yahoo, range).then((v) => cacheSet(key, v, 5 * 60 * 1000))
        );
      } catch (e) {
        return sendJson(res, 502, {
          error: 'Grafik alinamadi',
          detail: String((e && e.message) || e)
        });
      }
    }
    return sendJson(res, 200, data);
  }

  if (p === '/api/news') {
    const symbol = (urlObj.searchParams.get('symbol') || '').toUpperCase();
    let query = urlObj.searchParams.get('q');
    const stock = bySymbol[symbol];

    if (!query) {
      if (stock) query = '"' + stock.name + '" OR ' + stock.symbol;
      else query = 'BIST100 OR "Borsa Istanbul"';
    }

    const key = 'news:' + query;
    let data = cacheGet(key);
    if (!data) {
      try {
        data = await dedupe(key, () =>
          news
            .getNews(query, { days: 7, limit: 24 })
            .then((v) => cacheSet(key, v, 10 * 60 * 1000))
        );
      } catch (e) {
        return sendJson(res, 502, {
          error: 'Haber alinamadi',
          detail: String((e && e.message) || e)
        });
      }
    }
    return sendJson(res, 200, {
      query,
      symbol: symbol || null,
      name: stock ? stock.name : 'Piyasa Genel',
      items: data
    });
  }

  if (p === '/api/ai-analysis') {
    const overrides = readAiOverrides(req);
    if (!hasAiKey(overrides)) return aiKeyRequired(res);
    const sig = ai.configSignature(overrides);
    const fresh = urlObj.searchParams.get('fresh') === '1';
    const key = 'ai:market:' + sig;
    let data = fresh ? undefined : cacheGet(key);
    if (!data) {
      try {
        const [overview, formations, gold, marketNews, indexSpark, indexQuotes] = await Promise.all([
          getOverviewCached(),
          getFormationsCached('all'),
          getGoldCached().catch(() => null),
          news
            .getNews('BIST100 OR "Borsa Istanbul"', { days: 7, limit: 12 })
            .catch(() => []),
          yahoo.getSpark(['XU100.IS'], '1mo', '1d').catch(() => ({})),
          yahoo.getQuotes(['XU100.IS']).catch(() => ({}))
        ]);
        const idxQuote = (indexQuotes && indexQuotes['XU100.IS']) || {};
        const idxSpark = indexSpark && indexSpark['XU100.IS'];
        const idxPoints = (idxSpark && idxSpark.points) || [];
        const idxLast = idxPoints.length
          ? idxPoints[idxPoints.length - 1].c
          : idxQuote.regularMarketPrice;
        const idxCloses = idxPoints
          .map((p) => p.c)
          .filter((v) => v != null && isFinite(v));
        const idxSupport =
          idxCloses.length >= 5
            ? Math.min.apply(null, idxCloses.slice(-20))
            : null;
        const idxResistance =
          idxCloses.length >= 5
            ? Math.max.apply(null, idxCloses.slice(-20))
            : null;
        const index =
          idxLast != null
            ? {
                price: round(idxLast, 2),
                changePercent:
                  idxQuote.regularMarketChangePercent != null
                    ? round(idxQuote.regularMarketChangePercent, 2)
                    : pctChange(closeAgo(idxPoints, 1), idxLast),
                weekChangePercent: pctChange(closeAgo(idxPoints, 5), idxLast),
                monthChangePercent: pctChange(closeAgo(idxPoints, 21), idxLast),
                support: idxSupport == null ? null : round(idxSupport, 2),
                resistance: idxResistance == null ? null : round(idxResistance, 2)
              }
            : null;
        const input = buildMarketAiInput(overview, formations, marketNews, gold, index);
        const summary = await ai.analyzeMarket(input, overrides);
        const cfg = ai.resolveConfig(overrides);
        data = {
          updatedAt: Date.now(),
          summary,
          provider: cfg.provider,
          model: cfg.model
        };
        cacheSet(key, data, 10 * 60 * 1000);
      } catch (e) {
        return sendJson(res, 502, {
          error: 'AI piyasa analizi alinamadi',
          detail: String((e && e.message) || e)
        });
      }
    }
    return sendJson(res, 200, data);
  }

  if (p === '/api/ai-analysis-stock') {
    const symbol = (urlObj.searchParams.get('symbol') || '').toUpperCase();
    const stock = bySymbol[symbol];
    if (!stock) return sendJson(res, 400, { error: 'Bilinmeyen sembol' });

    const overrides = readAiOverrides(req);
    if (!hasAiKey(overrides)) return aiKeyRequired(res);

    const horizon = urlObj.searchParams.get('horizon') || 'all';
    const sig = ai.configSignature(overrides);
    const fresh = urlObj.searchParams.get('fresh') === '1';
    const key = 'ai:stock:' + symbol + ':' + horizon + ':' + sig;
    let data = fresh ? undefined : cacheGet(key);
    if (!data) {
      try {
        const range = urlObj.searchParams.get('range') || '1y';
        const [chartData, weeklyData, overview, stockNews] = await Promise.all([
          dedupe('chart:' + symbol + ':' + range, () =>
            yahoo.getChart(stock.yahoo, range).then((v) =>
              cacheSet('chart:' + symbol + ':' + range, v, 5 * 60 * 1000)
            )
          ).catch(() => ({ candles: [] })),
          dedupe('chart:' + symbol + ':5y', () =>
            yahoo.getChart(stock.yahoo, '5y').then((v) =>
              cacheSet('chart:' + symbol + ':5y', v, 10 * 60 * 1000)
            )
          ).catch(() => ({ candles: [] })),
          getOverviewCached().catch(() => ({ items: [] })),
          news
            .getNews('"' + stock.name + '" OR ' + stock.symbol, {
              days: 7,
              limit: 8
            })
            .catch(() => [])
        ]);

        const input = buildStockAiInput(symbol, stock, chartData, weeklyData, overview);
        input.news = stockNews;
        input.horizon = horizon === 'short' || horizon === 'long' ? horizon : 'all';

        const summary = await ai.analyzeStock(input, overrides);
        const cfg = ai.resolveConfig(overrides);
        data = {
          symbol: stock.symbol,
          name: stock.name,
          summary,
          provider: cfg.provider,
          model: cfg.model,
          updatedAt: Date.now()
        };
        cacheSet(key, data, 10 * 60 * 1000);
      } catch (e) {
        return sendJson(res, 502, {
          error: 'AI hisse analizi alinamadi',
          detail: String((e && e.message) || e)
        });
      }
    }
    return sendJson(res, 200, data);
  }

  if (p === '/api/ai-models') {
    const overrides = readAiOverrides(req);
    if (!hasAiKey(overrides)) return aiKeyRequired(res);
    try {
      const result = await ai.listModels(overrides);
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 502, {
        error: 'Model listesi alınamadı',
        detail: String((e && e.message) || e)
      });
    }
  }

  if (p === '/api/ai-config') {
    if (req.method === 'GET') {
      const user = currentUser(req);
      if (user) {
        let stored = null;
        try {
          stored = db.getUserAiConfig(user.id);
        } catch (_) {
          stored = null;
        }
        if (stored && stored.apiKeyEnc) {
          const key = auth.decryptSecret(stored.apiKeyEnc);
          if (key) {
            const cfg = ai.resolveConfig({
              apiBase: stored.apiBase || '',
              model: stored.model || '',
              provider: stored.provider || ''
            });
            return sendJson(res, 200, {
              configured: true,
              provider: cfg.provider,
              apiBase: cfg.apiBase,
              model: cfg.model,
              source: 'account'
            });
          }
          return sendJson(res, 200, {
            configured: false,
            source: 'account',
            error: 'Kayitli anahtar cozulemedi; yeniden girin.'
          });
        }
      }

      const overrides = readHeaderAiOverrides(req);
      if (hasAiKey(overrides)) {
        const cfg = ai.resolveConfig(overrides);
        return sendJson(res, 200, {
          configured: true,
          provider: cfg.provider,
          apiBase: cfg.apiBase,
          model: cfg.model,
          source: 'browser'
        });
      }
      return sendJson(res, 200, ai.getPublicConfig());
    }
    if (req.method === 'POST') {
      // Sunucu geneli varsayilan anahtar degisikligi yalnizca yerel makineden.
      if (!isLocalRequest(req)) {
        return sendJson(res, 403, {
          error: 'Sunucu geneli AI ayari yalnizca yerel makineden degistirilebilir.',
          detail: 'Kendi API anahtarinizi arayuzdeki "🔑 API" penceresinden girin.'
        });
      }
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'Gecersiz istek gövdesi' });
      }
      try {
        const cfg = ai.setRuntimeConfig(body);
        return sendJson(res, 200, { ok: true, config: cfg });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }
    return sendJson(res, 405, { error: 'Yontem desteklemiyor' });
  }

  if (p === '/api/ai-test' && req.method === 'POST') {
    let body = {};
    try {
      body = await readBody(req);
    } catch (_) {
      body = {};
    }
    const overrides = readAiOverrides(req, body);
    if (!hasAiKey(overrides)) return aiKeyRequired(res);
    try {
      const result = await ai.testConnection(overrides);
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 502, {
        error: 'AI sunucusuna bağlanılamadı',
        detail: String((e && e.message) || e)
      });
    }
  }

  return sendJson(res, 404, { error: 'Bulunamadi' });
}

/* ------------------------------------------------------------------ *
 *  Statik dosya sunumu
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res, urlObj) {
  let rel = decodeURIComponent(urlObj.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Yasak');
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Bulunamadi');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (urlObj.pathname.startsWith('/api/')) {
    handleApi(req, res, urlObj).catch((e) => {
      sendJson(res, 500, {
        error: 'Sunucu hatasi',
        detail: String((e && e.message) || e)
      });
    });
    return;
  }

  serveStatic(req, res, urlObj);
});

// AI analizleri uzun surebilir (reasoning modelleri); 5 dk varsayilanini kaldir.
server.requestTimeout = 0;

server.listen(PORT, () => {
  console.log('BIST100 Analist V2 calisiyor -> http://localhost:' + PORT);
  console.log(BIST100.length + ' hisse yuklendi.');
  if (db.init()) {
    try {
      db.purgeExpiredSessions();
    } catch (_) {
      /* yoksay */
    }
    console.log('Hesap veritabani hazir: ' + db.DB_PATH);
    setInterval(() => {
      try {
        db.purgeExpiredSessions();
      } catch (_) {
        /* yoksay */
      }
    }, 60 * 60 * 1000).unref();
  } else {
    console.log('Hesap ozellikleri kapali (Node.js 22.5+ gerekli).');
  }
});

module.exports = server;
