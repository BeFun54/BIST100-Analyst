'use strict';

/**
 * BIST100 Analyst - sunucu
 *  - Statik dosya sunumu (public/)
 *  - Yahoo Finance ve haber uclari icin guvenli proxy
 *  - Basit TTL onbellek (cani fiyat verisi icin)
 *
 * Bagimlilik yoktur; sadece "node server.js" ile calisir.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const yahoo = require('./lib/yahoo');
const news = require('./lib/news');
const { BIST100, bySymbol } = require('./data/bist100');
const { PATTERN_LIBRARY, scanBullishPatterns, etaLabel } = require('./lib/patterns');

const PORT = process.env.PORT || 3000;
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
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

/* ------------------------------------------------------------------ *
 *  API : /api/overview
 *  Tum BIST100 hisseleri icin anlik ozet + haftalik/aylik degisim.
 *  2 istekte tum listeyi doldurur (spark + quote).
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

/* ------------------------------------------------------------------ *
 *  API : /api/formations
 *  BIST100 hisselerini klasik boga formasyonlariyla karsilastirir.
 *  Tek spark isteğiyle 1 yillik gunluk kapanis serilerini alir,
 *  sadece YUKSELIS beklenen eslesmeleri dondurur. 15 dk onbellek.
 * ------------------------------------------------------------------ */

async function buildFormations() {
  const symbols = BIST100.map((s) => s.yahoo);
  let spark = {};
  try {
    spark = await yahoo.getSpark(symbols, '1y', '1d');
  } catch (e) {
    spark = {};
  }

  const results = [];
  const stats = {
    scanned: BIST100.length,
    withData: 0,
    tooShort: 0,
    perPattern: {}
  };
  for (const stock of BIST100) {
    const sp = spark[stock.yahoo];
    if (!sp || !sp.points || !sp.points.length) continue;
    if (sp.points.length < 60) {
      stats.tooShort++;
      continue;
    }
    stats.withData++;

    const matches = scanBullishPatterns(sp.points);
    if (!matches.length) continue;

    const lastClose = sp.points[sp.points.length - 1].c;
    for (const m of matches) {
      stats.perPattern[m.key] = (stats.perPattern[m.key] || 0) + 1;
      const lib = PATTERN_LIBRARY[m.key];
      results.push({
        symbol: stock.symbol,
        name: stock.name,
        lastClose: round(lastClose, 2),
        pattern: m.key,
        patternName: lib ? lib.name : m.key,
        type: lib ? lib.type : '',
        reliability: lib ? lib.reliability : '',
        eta: etaLabel(m.key, Date.now()),
        timeframe: lib ? lib.timeframe : '',
        description: lib ? lib.description : '',
        confidence: m.confidence,
        upsidePct: m.upsidePct,
        detail: m.detail
      });
    }
  }

  results.sort((a, b) => b.confidence - a.confidence || b.upsidePct - a.upsidePct);

  return {
    updatedAt: Date.now(),
    stats,
    count: results.length,
    results
  };
}

/* ------------------------------------------------------------------ *
 *  Yonlendirme
 * ------------------------------------------------------------------ */

async function handleApi(req, res, urlObj) {
  const p = urlObj.pathname;

  if (p === '/api/overview') {
    let data = cacheGet('overview');
    if (!data) {
      data = await dedupe('overview', () =>
        buildOverview().then((v) => cacheSet('overview', v, 60 * 1000))
      );
    }
    return sendJson(res, 200, data);
  }

  if (p === '/api/formations') {
    let data = cacheGet('formations');
    if (!data) {
      data = await dedupe('formations', () => buildFormations().then((v) =>
        cacheSet('formations', v, 15 * 60 * 1000)
      ));
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
          yahoo
            .getChart(stock.yahoo, range)
            .then((v) => cacheSet(key, v, 5 * 60 * 1000))
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
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png'
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

server.listen(PORT, () => {
  console.log('BIST100 Analyst calisiyor -> http://localhost:' + PORT);
  console.log(BIST100.length + ' hisse yuklendi.');
});

module.exports = server;
