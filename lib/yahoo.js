'use strict';

/**
 * Yahoo Finance istemcisi (bagimliliksiz, sadece Node'un https/http modulu).
 *
 * Neden sunucu tarafinda proxy?
 *  - Tarayici, Yahoo Finance'e dogrudan istek atinca CORS hatasi verir.
 *  - Bu yuzden tum istekler Node sunucusundan gecirilir.
 *
 * Kullanilan uclar:
 *  - spark  : Cok sayida sembol icin kisa fiyat serisi (tek istekte ~100 hisse)
 *  - quote  : Anlik fiyat, degisim, hacim, piyasa degeri
 *  - chart  : Her hisse icin 5 yila kadar gunluk/mum verisi
 */

const https = require('https');
const http = require('http');

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8'
};

/* ------------------------------------------------------------------ *
 *  Basit HTTP istemcisi (yonlendirme + cerez toplama destekli)
 * ------------------------------------------------------------------ */

function request(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    const lib = targetUrl.startsWith('http://') ? http : https;
    const req = lib.get(
      targetUrl,
      { headers: { ...UA, ...(options.headers || {}) } },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;

        if ([301, 302, 303, 307, 308].includes(status) && location) {
          res.resume();
          const next = new URL(location, targetUrl).toString();
          request(next, options).then(
            (r) => done(resolve, r),
            (e) => done(reject, e)
          );
          return;
        }

        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          done(resolve, { status, headers: res.headers, body: data })
        );
        res.on('error', (e) => done(reject, e));
      }
    );

    req.on('error', (e) => done(reject, e));
    req.setTimeout(options.timeout || 20000, () => {
      req.destroy(new Error('istek zaman asimi: ' + targetUrl));
    });
  });
}

async function getJson(targetUrl, options) {
  const res = await request(targetUrl, options);
  if (res.status < 200 || res.status >= 300) {
    const err = new Error('Yahoo Finance yanit kodu ' + res.status);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(res.body);
}

/* ------------------------------------------------------------------ *
 *  Cerez (cookie) + crumb yonetimi
 *  Yahoo, quote ucunda crumb dogrulamasi ister. Spark/chart icin gerekmez
 *  ama gonderirsek daha kararli olur.
 * ------------------------------------------------------------------ */

let cookieHeader = '';
let crumbValue = '';
let crumbFetchedAt = 0;
const CRUMB_TTL = 30 * 60 * 1000; // 30 dakika
let crumbInflight = null;

function collectCookies(res) {
  const sc = res.headers['set-cookie'];
  if (!sc) return '';
  return sc.map((c) => c.split(';')[0]).join('; ');
}

async function refreshCrumb() {
  try {
    // fc.yahoo.com 404 dondurur ama A1/A3 cerezlerini set eder.
    let res = await request('https://fc.yahoo.com/', { timeout: 10000 }).catch(
      () => null
    );
    let cookie = res ? collectCookies(res) : '';
    if (!cookie) {
      res = await request('https://finance.yahoo.com/', {
        timeout: 10000
      }).catch(() => null);
      cookie = res ? collectCookies(res) : '';
    }
    cookieHeader = cookie;

    const c = await request(
      'https://query1.finance.yahoo.com/v1/test/getcrumb',
      { headers: cookieHeader ? { Cookie: cookieHeader } : {}, timeout: 10000 }
    );
    const body = (c.body || '').trim();
    if (c.status === 200 && body && body.length < 40 && !body.includes('<')) {
      crumbValue = body;
      crumbFetchedAt = Date.now();
      return crumbValue;
    }
  } catch (e) {
    /* sessizce gec, crumb olmadan da devam edilir */
  }
  crumbFetchedAt = Date.now();
  return crumbValue;
}

async function ensureCrumb() {
  if (crumbValue && Date.now() - crumbFetchedAt < CRUMB_TTL) return crumbValue;
  if (!crumbInflight) {
    crumbInflight = refreshCrumb().finally(() => (crumbInflight = null));
  }
  return crumbInflight;
}

function authQuery() {
  const parts = [];
  if (crumbValue) parts.push('crumb=' + encodeURIComponent(crumbValue));
  parts.push('corsDomain=finance.yahoo.com');
  parts.push('formatted=false');
  return parts.join('&');
}

function authHeaders() {
  return cookieHeader ? { Cookie: cookieHeader } : {};
}

/* ------------------------------------------------------------------ *
 *  Spark : tek istekte cok sayida sembol icin fiyat serisi
 * ------------------------------------------------------------------ */

const SPARK_BATCH = 20; // Yahoo spark: en fazla 20 sembol
const QUOTE_BATCH = 50;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getSpark(symbols, range = '1mo', interval = '1d') {
  const parts = await Promise.all(
    chunk(symbols, SPARK_BATCH).map((b) =>
      sparkOnce(b, range, interval).catch(() => ({}))
    )
  );
  const out = {};
  for (const p of parts) Object.assign(out, p);
  return out;
}

async function sparkOnce(symbols, range = '1mo', interval = '1d') {
  await ensureCrumb();
  const url =
    'https://query1.finance.yahoo.com/v7/finance/spark?symbols=' +
    symbols.join(',') +
    '&range=' + range +
    '&interval=' + interval +
    '&indicators=close&' + authQuery();

  const json = await getJson(url, { headers: authHeaders() });
  const results = (json.spark && json.spark.result) || [];
  const out = {};
  for (const r of results) {
    const resp = r.response && r.response[0];
    if (!resp) continue;
    const ts = resp.timestamp || [];
    const closes =
      (resp.indicators &&
        resp.indicators.quote &&
        resp.indicators.quote[0] &&
        resp.indicators.quote[0].close) ||
      [];
    const points = [];
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] != null) points.push({ t: ts[i], c: closes[i] });
    }
    out[r.symbol] = { meta: resp.meta || {}, points };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Quote : anlik fiyat / degisim / hacim / piyasa degeri
 * ------------------------------------------------------------------ */

async function getQuotes(symbols) {
  const parts = await Promise.all(
    chunk(symbols, QUOTE_BATCH).map((b) =>
      quotesOnce(b).catch(() => ({}))
    )
  );
  const out = {};
  for (const p of parts) Object.assign(out, p);
  return out;
}

async function quotesOnce(symbols) {
  await ensureCrumb();
  const url =
    'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' +
    symbols.join(',') + '&' + authQuery();

  const json = await getJson(url, { headers: authHeaders() });
  const results = (json.quoteResponse && json.quoteResponse.result) || [];
  const out = {};
  for (const q of results) out[q.symbol] = q;
  return out;
}

/* ------------------------------------------------------------------ *
 *  Chart : mum grafikleri icin OHLC serisi
 * ------------------------------------------------------------------ */

const RANGE_MAP = {
  '5y': { range: '5y', interval: '1wk' },
  '1y': { range: '1y', interval: '1d' },
  '6mo': { range: '6mo', interval: '1d' },
  '1mo': { range: '1mo', interval: '1d' },
  '1d': { range: '1d', interval: '5m' }
};

async function getChart(symbol, rangeKey) {
  const cfg = RANGE_MAP[rangeKey] || RANGE_MAP['1y'];
  await ensureCrumb();
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) +
    '?range=' + cfg.range +
    '&interval=' + cfg.interval +
    '&includePrePost=false&events=div%2Csplit';

  const json = await getJson(url, { headers: authHeaders() });
  const result = json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error('Grafik verisi bulunamadi: ' + symbol);

  const ts = result.timestamp || [];
  const q =
    (result.indicators &&
      result.indicators.quote &&
      result.indicators.quote[0]) ||
    {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open ? q.open[i] : null;
    const h = q.high ? q.high[i] : null;
    const l = q.low ? q.low[i] : null;
    const c = q.close ? q.close[i] : null;
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({
      t: ts[i] * 1000,
      o,
      h,
      l,
      c,
      v: (q.volume ? q.volume[i] : null) || 0
    });
  }

  const meta = result.meta || {};
  return {
    symbol,
    range: rangeKey,
    interval: cfg.interval,
    currency: meta.currency || 'TRY',
    previousClose: meta.chartPreviousClose || meta.previousClose || null,
    candles
  };
}

module.exports = {
  getSpark,
  getQuotes,
  getChart,
  RANGE_MAP,
  _request: request
};
