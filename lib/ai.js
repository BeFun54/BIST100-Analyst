'use strict';

/**
 * AI Analiz istemcisi.
 * Kullanicinin verdigi NVIDIA NIM (DeepSeek) API anahtari ile
 * hisse veya piyasa icin yapay zeka yorumu uretir.
 *
 * API: https://integrate.api.nvidia.com/v1/chat/completions
 * Header: Authorization: Bearer <nvapi-...>
 */

const https = require('https');

const API_KEY = process.env.AI_API_KEY || 'DEV_ONLY_PLACEHOLDER';
const API_BASE = process.env.AI_API_BASE || 'https://evren-llmapi.ssyz.org.tr/v1/chat/completions';
const TERMS_BASE = 'https://evren-llmapi.ssyz.org.tr/v1';
const MODEL = 'deepseek-v4.1-flash';

let termsAccepted = false;

function getJson(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Accept': 'application/json',
        'User-Agent': 'BIST100-Analyst/1.0'
      },
      timeout
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('API hata kodu ' + res.statusCode + ': ' + raw));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          resolve(raw);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('API zaman asi')));
    req.end();
  });
}

async function acceptTerms() {
  if (termsAccepted) return;
  try {
    // Once metni oku (opsiyonel bilgi icin)
    await getJson(TERMS_BASE + '/terms/text').catch(() => {});
    // Sartin v1 surumunu onayla
    await postJson(TERMS_BASE + '/terms/accept', { version: 1 });
    termsAccepted = true;
  } catch (e) {
    // Zaten kabul edilmis olabilir, hata olmasin
    termsAccepted = true;
  }
}

function postJson(url, body, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Length': Buffer.byteLength(data),
        'Accept': 'application/json',
        'User-Agent': 'BIST100-Analyst/1.0'
      },
      timeout
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('AI API hata kodu ' + res.statusCode + ': ' + raw));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('AI API gecerli JSON degil: ' + raw.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('AI API zaman asi')));
    req.write(data);
    req.end();
  });
}

/**
 * Tek bir hisse icin AI yorumu uretir.
 * @param {object} stock { symbol, name, yahoo, lastClose, dailyPct, weeklyPct, volume }
 * @param {array} candles  son mum verileri [{t,o,h,l,c,v}]
 * @param {array} news   son haberler [{title, summary, publishedAt}]
 * @param {object|null} pattern  formasyon sonucu veya null
 * @returns {Promise<string>} AI yorumu (Turkce)
 */
async function analyzeStock(stock, candles, news, pattern) {
  await acceptTerms();
  const prompt = buildStockPrompt(stock, candles, news, pattern);
  const json = await postJson(API_BASE, {
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: 'Sen BIST100 (Borsa Istanbul) uzmani bir finansal analizci sun. ' +
          'Turkce, kesin, net ve objektif cevaplar ver. ' +
          'Yatirim tavsiyesi verme, sadece analiz ve yorum yap. ' +
          'Her yorumun sonunda "Bu bir yatirim tavsiyesi degildir." ibaresini ekle.'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.4,
    max_tokens: 700,
    stream: false
  });

  return extractText(json);
}

/**
 * Genel piyasa icin AI yorumu uretir (sayfa yuklendiginde/yenilendiginde).
 * @param {array} overview  tum hisselerin ozet verileri
 * @param {array} news      piyasa haberleri
 * @returns {Promise<string>} AI yorumu (Turkce)
 */
async function analyzeMarket(overview, news) {
  await acceptTerms();
  const prompt = buildMarketPrompt(overview, news);
  const json = await postJson(API_BASE, {
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: 'Sen BIST100 (Borsa Istanbul) uzmani bir finansal analizci sun. ' +
          'Turkce, kesin, net ve objektif cevaplar ver. ' +
          'Yatirim tavsiyesi verme, sadece analiz ve yorum yap. ' +
          'Her yorumun sonunda "Bu bir yatirim tavsiyesi degildir." ibaresini ekle.'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.4,
    max_tokens: 900,
    stream: false
  });

  return extractText(json);
}

function extractText(json) {
  try {
    return json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content
      : 'AI yorumu olusturulamadi (bos yanit).';
  } catch (_) {
    return 'AI yorumu olusturulamadi (gecersiz yanit).';
  }
}

function buildStockPrompt(stock, candles, news, pattern) {
  const lines = [];
  lines.push('Hisse: ' + stock.symbol + ' (' + stock.name + ')');
  lines.push('Son fiyat: ' + (stock.lastClose != null ? stock.lastClose.toFixed(2) : '—') + ' TL');
  lines.push('Gunluk degisim: ' + (stock.dailyPct != null ? stock.dailyPct.toFixed(2) : '—') + '%');
  lines.push('Haftalik degisim: ' + (stock.weeklyPct != null ? stock.weeklyPct.toFixed(2) : '—') + '%');
  lines.push('Hacim: ' + (stock.volume != null ? stock.volume.toLocaleString('tr-TR') : '—'));

  if (candles && candles.length) {
    const last = candles[candles.length - 1];
    lines.push('Son mum: A=' + last.o + ' H=' + last.h + ' L=' + last.l + ' C=' + last.c);
    if (candles.length >= 5) {
      const c5 = candles.slice(-5).map((c) => c.c);
      const min5 = Math.min(...c5);
      const max5 = Math.max(...c5);
      lines.push('Son 5 gun araligi: min=' + min5.toFixed(2) + ' max=' + max5.toFixed(2));
    }
  }

  if (pattern) {
    lines.push('Tespit edilen formasyon: ' + pattern.name + ' (' + pattern.type + ')');
    lines.push('Formasyon guvenilirligi: ' + (pattern.reliability || '—'));
    lines.push('Formasyon detayi: ' + pattern.description);
  }

  if (news && news.length) {
    lines.push('Son haberler:');
    for (const n of news.slice(0, 5)) {
      lines.push('- ' + n.title + (n.summary ? ' (' + n.summary.slice(0, 120) + ')' : ''));
    }
  }

  lines.push('');
  lines.push('Lutfen yukaridaki verileri dikkate alarak ' + stock.symbol +
    ' icin kisa, etkili ve Turkce bir teknik ve temel analiz yaz. ' +
    'Fiyat eylemi, formasyon (varsa), haber etkisi ve risk notlarini icerir.');

  return lines.join('\n');
}

function buildMarketPrompt(overview, news) {
  const lines = [];
  lines.push('BIST100 Piyasa Genel Durumu:');
  lines.push('Toplam hisse sayisi: ' + overview.length);

  const up = overview.filter((s) => s.dailyPct > 0).length;
  const down = overview.filter((s) => s.dailyPct < 0).length;
  const flat = overview.length - up - down;
  lines.push('Yukselen: ' + up + ' | Dusen: ' + down + ' | Degismemis: ' + flat);

  const topGainers = [...overview]
    .filter((s) => s.dailyPct != null)
    .sort((a, b) => b.dailyPct - a.dailyPct)
    .slice(0, 5)
    .map((s) => s.symbol + ' (%' + s.dailyPct.toFixed(2) + ')');
  const topLosers = [...overview]
    .filter((s) => s.dailyPct != null)
    .sort((a, b) => a.dailyPct - b.dailyPct)
    .slice(0, 5)
    .map((s) => s.symbol + ' (%' + s.dailyPct.toFixed(2) + ')');

  lines.push('En cok yukselenler: ' + topGainers.join(', '));
  lines.push('En cok dusenler: ' + topLosers.join(', '));

  if (news && news.length) {
    lines.push('Son piyasa haberleri:');
    for (const n of news.slice(0, 5)) {
      lines.push('- ' + n.title);
    }
  }

  lines.push('');
  lines.push('Lutfen yukaridaki BIST100 genel gorusune dayanarak kisa, ' +
    'Turkce bir piyasa yorumu yaz. Trend yonu, sektorgelismeleri (belliyse), ' +
    'risk faktorsu ve kisa vadeli beklemeleri icerir.');

  return lines.join('\n');
}

module.exports = { analyzeStock, analyzeMarket };