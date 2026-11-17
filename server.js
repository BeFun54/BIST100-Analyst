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

require('./lib/env'); // proje kokundeki .env dosyasini yukler (varsa)

const yahoo = require('./lib/yahoo');
const news = require('./lib/news');
const ai = require('./lib/ai');
const { BIST100, bySymbol } = require('./data/bist100');
const { PATTERN_LIBRARY, scanBullishPatterns, scanBearishPatterns, etaLabel } = require('./lib/patterns');

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
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

/* ISTEK GOVDESI OKUYUCU (JSON POST icin) */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('Gecersiz JSON')); }
    });
    req.on('error', reject);
  });
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
 *  API : /api/gold
 *  Altin fiyati: Yahoo Finance'dan Ons altin (GC=F, USD/ons) ve
 *  USD/TRY (TRY=X) kuru alinir. Gram / ceyrek / tam altin onstan
 *  hesaplanir (1 ons = 31.1035 gram, ceyrek = 1.75 g, tam = 7 g).
 *  Bu degerler haremaltin.com gibi yerel sarfiyat fiyatlarindan
 *  farkli olabilir (kesin fiyat degildir). 5 dakika onbelleklenir.
 * ------------------------------------------------------------------ */

const GRAM_PER_OZ = 31.1034768;
const CEYREK_GRAM = 1.75;
const TAM_GRAM = 7;

async function buildGold() {
  const quotes = await yahoo.getQuotes(['GC=F', 'TRY=X']);
  const gold = quotes['GC=F'] || {};
  const usdTry = quotes['TRY=X'] || {};

  const onsUsd =
    gold.regularMarketPrice != null ? round(gold.regularMarketPrice, 2) : null;
  const usdTryRate =
    usdTry.regularMarketPrice != null ? round(usdTry.regularMarketPrice, 4) : null;

  let onsTry = null;
  let gram = null;
  let ceyrek = null;
  let tam = null;

  if (onsUsd != null && usdTryRate != null) {
    onsTry = round(onsUsd * usdTryRate, 2);
    gram = round((onsUsd * usdTryRate) / GRAM_PER_OZ, 2);
    ceyrek = round(gram * CEYREK_GRAM, 2);
    tam = round(gram * TAM_GRAM, 2);
  }

  return {
    onsUsd,
    onsTry,
    gram,
    ceyrek,
    tam,
    usdTry: usdTryRate,
    updatedAt: Date.now()
  };
}

/* ------------------------------------------------------------------ *
 *  API : /api/formations
 *  BIST100 hisselerini klasik boga formasyonlariyla karsilastirir.
 *  Tek spark isteğiyle 1 yillik gunluk kapanis serilerini alir,
 *  sadece YUKSELIS beklenen eslesmeleri dondurur. 15 dk onbellek.
 * ------------------------------------------------------------------ */

async function buildFormations(dir = 'bullish') {
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
  const scanBullish = dir === 'bullish' || dir === 'all';
  const scanBearish = dir === 'bearish' || dir === 'all';

  /** Tek bir formasyon eslesmesini sonuca ekler (yon duyarlı). */
  const pushResult = (stock, m, direction, lastClose, context) => {
    const lib = PATTERN_LIBRARY[m.key];
    // upsidePct = beklenen hareketin büyüklüğü (pozitif), isaret direction'dan belli olur.
    const expectedPct = direction === 'bullish' ? m.upsidePct : m.downsidePct;
    stats.perPattern[m.key] = (stats.perPattern[m.key] || 0) + 1;
    results.push({
      symbol: stock.symbol,
      name: stock.name,
      lastClose: round(lastClose, 2),
      direction,
      pattern: m.key,
      patternName: lib ? lib.name : m.key,
      type: lib ? lib.type : '',
      reliability: lib ? lib.reliability : '',
      eta: etaLabel(m.key, Date.now()),
      timeframe: lib ? lib.timeframe : '',
      description: lib ? lib.description : '',
      confidence: m.confidence,
      upsidePct: Math.round(expectedPct * 10) / 10, // pozitif büyüklük
      detail: m.detail,
      context
    });
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
    // AI dogrulamasi icin kompakt fiyat baglami (istemciye gonderilmez).
    const w60 = allCloses.slice(-60);
    const context = {
      series: allCloses.slice(-20).map((c) => round(c, 2)),
      high60: round(Math.max.apply(null, w60), 2),
      low60: round(Math.min.apply(null, w60), 2),
      ma50: allCloses.length >= 50 ? round(avg(allCloses.slice(-50)), 2) : null,
      ma200: allCloses.length >= 200 ? round(avg(allCloses.slice(-200)), 2) : null
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

  results.sort((a, b) => b.confidence - a.confidence || b.upsidePct - a.upsidePct);

  return {
    updatedAt: Date.now(),
    stats,
    count: results.length,
    dir,
    results
  };
}

/**
 * AI dogrulama sonuclarini formasyon listesine isler.
 *  - approve : degerler korunur, AI yorumu eklenir
 *  - adjust  : upsidePct / confidence AI degerleriyle guncellenir
 *  - reject  : formasyon listeden cikarilir
 */
function mergeValidations(base, validations) {
  if (!validations || !validations.length) {
    return { ...base, aiValidated: false };
  }

  const norm = (s) => String(s || '').toUpperCase().trim();
  const keyOf = (f) => norm(f.symbol) + '|' + norm(f.patternName || f.pattern);
  const altKeyOf = (f) => norm(f.symbol) + '|' + norm(f.pattern);

  const byKey = new Map();
  for (const v of validations) {
    const k = norm(v.symbol) + '|' + norm(v.pattern);
    byKey.set(k, v);
  }

  const kept = [];
  let approved = 0;
  let adjusted = 0;
  let rejected = 0;

  for (const f of base.results) {
    let v = byKey.get(keyOf(f)) || byKey.get(altKeyOf(f));
    if (!v) {
      // AI bu formasyonu degerlendirmemis: aynen koru
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
        out.origUpsidePct = f.upsidePct;
        out.upsidePct = round(Math.max(1, Math.min(45, Number(v.adjustedUpsidePct))), 1);
      }
      if (v.adjustedConfidence != null && isFinite(Number(v.adjustedConfidence))) {
        out.origConfidence = f.confidence;
        out.confidence = Math.max(10, Math.min(95, Math.round(Number(v.adjustedConfidence))));
      }
      adjusted++;
    } else {
      approved++;
    }
    kept.push(out);
  }

  kept.sort((a, b) => b.confidence - a.confidence || b.upsidePct - a.upsidePct);

  return {
    updatedAt: Date.now(),
    stats: base.stats,
    count: kept.length,
    aiValidated: true,
    aiSummary: {
      approved,
      adjusted,
      rejected,
      scanned: base.results.length
    },
    results: kept
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

  if (p === '/api/gold') {
    let data = cacheGet('gold');
    if (!data) {
      data = await dedupe('gold', () =>
        buildGold().then((v) => cacheSet('gold', v, 5 * 60 * 1000))
      );
    }
    return sendJson(res, 200, data);
  }

  if (p === '/api/formations') {
    const dir = (urlObj.searchParams.get('dir') || 'bullish');
    const ckey = 'formations:' + dir;
    let data = cacheGet(ckey);
    if (!data) {
      data = await dedupe(ckey, () => buildFormations(dir).then((v) =>
        cacheSet(ckey, v, 15 * 60 * 1000)
      ));
    }
    // context (AI icin fiyat serisi) istemciye gonderilmez.
    return sendJson(res, 200, {
      ...data,
      results: (data.results || []).map(publicFormation)
    });
  }

  if (p === '/api/ai-formations') {
    // Kural-tabanli formasyon taramasi + AI dogrulamasu/torpilemesi.
    // dir: bullish | bearish | all (iki yonun da karsilastirmasi)
    const dir = (urlObj.searchParams.get('dir') || 'bullish');
    const ckey = 'ai:formations:' + dir;
    let data = cacheGet(ckey);
    if (!data) {
      try {
        if (dir === 'all') {
          const bullBase = await dedupe('formations:bullish', () => buildFormations('bullish').then((v) =>
            cacheSet('formations:bullish', v, 15 * 60 * 1000)
          ));
          const bearBase = await dedupe('formations:bearish', () => buildFormations('bearish').then((v) =>
            cacheSet('formations:bearish', v, 15 * 60 * 1000)
          ));
          const { validations: bValidations } = await ai.validateFormations(bullBase.results);
          const { validations: aValidations } = await ai.validateFormations(bearBase.results);
          const bullish = mergeValidations(bullBase, bValidations);
          const bearish = mergeValidations(bearBase, aValidations);
          let comparison = '';
          try {
            comparison = await ai.compareDirections(bullish.results, bearish.results);
          } catch (_) {
            comparison = 'AI karsilasmasi alinamadi.';
          }
          data = {
            updatedAt: Date.now(),
            dir: 'all',
            bullish,
            bearish,
            comparison
          };
        } else {
          const base = await dedupe('formations:' + dir, () => buildFormations(dir).then((v) =>
            cacheSet('formations:' + dir, v, 15 * 60 * 1000)
          ));
          const { validations } = await ai.validateFormations(base.results);
          data = mergeValidations(base, validations);
          data.dir = dir;
        }
        cacheSet(ckey, data, 30 * 60 * 1000); // 30 dk onbellek
      } catch (e) {
        return sendJson(res, 502, {
          error: 'AI formasyon dogrulamasi alinamadi',
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

  if (p === '/api/ai-analysis') {
    let data = cacheGet('ai:market');
    if (!data) {
      try {
        const overview = await buildOverview();
        const marketNews = await news.getNews(
          'BIST100 OR "Borsa Istanbul"', { days: 7, limit: 10 }
        );
        const summary = await ai.analyzeMarket(overview.items, marketNews);
        data = { updatedAt: Date.now(), summary };
        cacheSet('ai:market', data, 10 * 60 * 1000); // 10 dk onbellek
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

    const range = urlObj.searchParams.get('range') || '1y';
    let chartData = null;
    try {
      chartData = await dedupe('chart:' + symbol + ':' + range, () =>
        yahoo.getChart(stock.yahoo, range).then((v) =>
          cacheSet('chart:' + symbol + ':' + range, v, 5 * 60 * 1000)
        )
      );
    } catch (e) {
      // grafik olmasa da analiz yapilabilir
    }

    let stockNews = [];
    try {
      stockNews = await news.getNews(
        '"' + stock.name + '" OR ' + stock.symbol,
        { days: 7, limit: 5 }
      );
    } catch (_) {
      stockNews = [];
    }

    const pattern = null; // formsiyon verisi istemci tarafindan gonderebilir
    let summary = '';
    try {
      // Basit hisse  bilgileri (grafikten son kapanis, degisimler)
      let lastClose = null;
      let dailyPct = null;
      let weeklyPct = null;
      let volume = null;
      if (chartData && chartData.candles && chartData.candles.length) {
        const c = chartData.candles;
        lastClose = c[c.length - 1].c;
        if (c.length >= 2) {
          dailyPct = round(((c[c.length - 1].c - c[c.length - 2].c) / c[c.length - 2].c) * 100, 2);
        }
        const weekBaseIdx = Math.max(0, c.length - 6);
        weeklyPct = round(((c[c.length - 1].c - c[weekBaseIdx].c) / c[weekBaseIdx].c) * 100, 2);
        volume = c[c.length - 1].v || 0;
      }

      summary = await ai.analyzeStock(
        {
          symbol: stock.symbol,
          name: stock.name,
          lastClose,
          dailyPct,
          weeklyPct,
          volume
        },
        chartData ? chartData.candles : [],
        stockNews,
        pattern
      );
    } catch (e) {
      return sendJson(res, 502, {
        error: 'AI hisse analizi alinamadi',
        detail: String((e && e.message) || e)
      });
    }

    return sendJson(res, 200, {
      symbol: stock.symbol,
      name: stock.name,
      summary,
      updatedAt: Date.now()
    });
  }

  if (p === '/api/ai-config') {
    if (req.method === 'GET') {
      return sendJson(res, 200, ai.getPublicConfig());
    }
    if (req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) {
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
    try {
      const result = await ai.testConnection();
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 502, {
        error: 'AI sunucusuna baglanilamadi',
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
