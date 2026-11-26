'use strict';

/**
 * Altin fiyati kaynagi.
 *
 * Birincil kaynak: Truncgil Finans (https://finans.truncgil.com/today.json)
 *  - gram-altin, ceyrek-altin, tam-altin : TL satis fiyatlari (dogrudan)
 *  - ons : USD/ons satis fiyati (dogrudan)
 *  - USD : USD/TRY satis kuru
 *  - Update_Date / Degisim alanlari
 *
 * Bu kaynak erisilemezse yedek olarak Yahoo Finance (GC=F + TRY=X) ile
 * hesaplama yapilir. Yedek sonuc "source: yahoo" olarak isaretlenir.
 */

const yahoo = require('./yahoo');

const TRUNCGIL_URL = 'https://finans.truncgil.com/today.json';
const GRAM_PER_OZ = 31.1034768;
const CEYREK_GRAM = 1.75;
const TAM_GRAM = 7;

let lastGood = null;

function round(n, d = 2) {
  if (n == null || !isFinite(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

/** "5.814,78" / "$3.568,37" / "%-2,60" -> number */
function parseTrNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;
  let s = String(value).trim();
  if (!s) return null;
  s = s
    .replace(/\s/g, '')
    .replace(/\$/g, '')
    .replace(/₺/g, '')
    .replace(/%/g, '')
    .replace(/TL/gi, '');
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return isFinite(n) ? n : null;
}

function parseTrPercent(value) {
  const n = parseTrNumber(value);
  return n == null ? null : round(n, 2);
}

function sourceTimeOf(updateDate) {
  if (!updateDate) return null;
  const m = String(updateDate).match(/(\d{1,2}:\d{2}:\d{2})/);
  return m ? m[1] : null;
}

async function fetchTruncgil() {
  const res = await yahoo._request(TRUNCGIL_URL, {
    timeout: 15000,
    headers: { Accept: 'application/json,text/plain,*/*' }
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error('Truncgil HTTP ' + res.status);
  }
  let json;
  try {
    json = JSON.parse(res.body);
  } catch (e) {
    throw new Error('Truncgil gecersiz JSON');
  }

  const gramObj = json['gram-altin'] || {};
  const ceyrekObj = json['ceyrek-altin'] || {};
  const tamObj = json['tam-altin'] || {};
  const onsObj = json['ons'] || {};
  const usdObj = json['USD'] || {};

  const gram = parseTrNumber(gramObj['Satış'] != null ? gramObj['Satış'] : gramObj['Alış']);
  const ceyrek = parseTrNumber(
    ceyrekObj['Satış'] != null ? ceyrekObj['Satış'] : ceyrekObj['Alış']
  );
  const tam = parseTrNumber(tamObj['Satış'] != null ? tamObj['Satış'] : tamObj['Alış']);
  const onsUsd = parseTrNumber(onsObj['Satış'] != null ? onsObj['Satış'] : onsObj['Alış']);
  const usdTry = parseTrNumber(usdObj['Satış'] != null ? usdObj['Satış'] : usdObj['Alış']);

  if (!(gram > 0 && ceyrek > 0 && tam > 0)) {
    throw new Error('Truncgil altin alanlari eksik');
  }

  return {
    gram: round(gram, 2),
    ceyrek: round(ceyrek, 2),
    tam: round(tam, 2),
    onsUsd: onsUsd != null ? round(onsUsd, 2) : null,
    onsTry: null,
    usdTry: usdTry != null ? round(usdTry, 4) : null,
    changes: {
      gram: parseTrPercent(gramObj['Değişim']),
      ceyrek: parseTrPercent(ceyrekObj['Değişim']),
      tam: parseTrPercent(tamObj['Değişim']),
      ons: parseTrPercent(onsObj['Değişim']),
      usdTry: parseTrPercent(usdObj['Değişim'])
    },
    source: 'truncgil',
    sourceLabel: 'Truncgil Finans',
    sourceUpdatedAt: json.Update_Date || null,
    sourceTime: sourceTimeOf(json.Update_Date),
    updatedAt: Date.now(),
    stale: false
  };
}

async function quoteOrLast(symbol, quote) {
  if (quote && quote.regularMarketPrice != null) return quote.regularMarketPrice;
  try {
    const chart = await yahoo.getChart(symbol, '1d');
    const candles = (chart && chart.candles) || [];
    if (candles.length) return candles[candles.length - 1].c;
  } catch (_) {
    /* yedek grafik de alinamadi */
  }
  return null;
}

async function fetchYahooFallback() {
  const quotes = await yahoo.getQuotes(['GC=F', 'TRY=X']);
  const gold = quotes['GC=F'] || {};
  const usdTry = quotes['TRY=X'] || {};

  const onsUsd = round(await quoteOrLast('GC=F', gold), 2);
  const usdTryRate = round(await quoteOrLast('TRY=X', usdTry), 4);

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

  if (gram == null || ceyrek == null || tam == null) {
    throw new Error('Yahoo altin verisi alinamadi');
  }

  return {
    gram,
    ceyrek,
    tam,
    onsUsd,
    onsTry,
    usdTry: usdTryRate,
    changes: null,
    source: 'yahoo',
    sourceLabel: 'Yahoo Finance (yedek)',
    sourceUpdatedAt: null,
    sourceTime: null,
    updatedAt: Date.now(),
    stale: false
  };
}

async function getGold() {
  try {
    const data = await fetchTruncgil();
    lastGood = data;
    return data;
  } catch (_) {
    /* birincil kaynak basarisiz: yedek */
  }

  try {
    const data = await fetchYahooFallback();
    lastGood = data;
    return data;
  } catch (_) {
    /* yedek de basarisiz: son bilinen veri */
  }

  if (lastGood) {
    return Object.assign({}, lastGood, { stale: true });
  }
  throw new Error('Altin verisi alinamadi');
}

module.exports = {
  getGold,
  fetchTruncgil,
  fetchYahooFallback,
  parseTrNumber,
  parseTrPercent,
  TRUNCGIL_URL
};
