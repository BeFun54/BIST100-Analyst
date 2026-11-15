'use strict';

/**
 * AI Analiz istemcisi.
 * NVIDIA NIM (build.nvidia.com) API anahtari ile
 * hisse veya piyasa icin yapay zeka yorumu uretir.
 *
 * API: https://integrate.api.nvidia.com/v1/chat/completions
 * Model: nvidia/nemotron-3.5-super-vl-120b-a12b
 * Header: Authorization: Bearer <nvapi-...>
 */

require('./env'); // proje kokundeki .env dosyasini yukler (varsa)

const https = require('https');

const API_KEY = process.env.AI_API_KEY || 'DEV_ONLY_PLACEHOLDER';
const API_BASE = process.env.AI_API_BASE || 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = process.env.AI_MODEL || 'nvidia/nemotron-3.5-super-vl-120b-a12b';

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
    max_tokens: 3000,
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
    max_tokens: 3000,
    stream: false
  });

  return extractText(json);
}

function extractText(json) {
  try {
    const msg = json.choices && json.choices[0] && json.choices[0].message;
    if (!msg) return 'AI yorumu olusturulamadi (bos yanit).';
    // Nemotron bir "reasoning" modelidir; token butcesi tukenirse
    // asil cevap (content) null olabilir. Bu durumda reasoning_content'e dus.
    if (msg.content) return msg.content;
    if (msg.reasoning_content) return msg.reasoning_content;
    return 'AI yorumu olusturulamadi (bos yanit).';
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

/**
 * Formasyon tarama sonuclarini AI ile dogrular / torpuler.
 *
 * @param {object[]} formations  buildFormations() ciktisi (results dizisi)
 * @returns {Promise<{validations: object[], raw: string}>}
 *   validations: [{symbol, pattern, verdict, adjustedUpsidePct,
 *                  adjustedConfidence, comment}]
 */
async function validateFormations(formations) {
  if (!formations || !formations.length) {
    return { validations: [], raw: '' };
  }

  const rows = formations.slice(0, 40).map((f) => {
    const row = {
      symbol: f.symbol,
      pattern: f.patternName || f.pattern,
      type: f.type || '',
      lastPrice: f.lastClose,
      upsidePct: f.upsidePct,
      confidence: f.confidence,
      eta: f.eta || '',
      detail: (f.detail || '').slice(0, 220)
    };
    // Gercek fiyat serisi: AI'nin formasyonu elle dogrulayabilmesi icin.
    const c = f.context;
    if (c && Array.isArray(c.series) && c.series.length) {
      row.recentCloses = c.series;
      if (c.high60 != null) row.high60 = c.high60;
      if (c.low60 != null) row.low60 = c.low60;
      if (c.ma50 != null) row.ma50 = c.ma50;
      if (c.ma200 != null) row.ma200 = c.ma200;
    }
    return row;
  });

  const sys =
    'Sen BIST100 uzmani bir teknik analiz dogrulayicisin. ' +
    'Sana kural-tabanli tarama motorunun buldugu boga formasyonlari verilecek. ' +
    'Gorevin: (1) mantikli olmayan / absurt hedefleri dusurmak veya duzeltmek, ' +
    'kural olarak gercekci yukselis potansiyeli aylik %1-%35 arasidir, ' +
    'ustunde kalan degerleri bu banda ke; (2) yalnizca serideki dip-direnç ' +
    'yapisi ile uyumlu formasyonlari onaylamak, zayif olanlari reddetmek; ' +
    '(3) confidence degerini 20-90 bandina torpulemek. ' +
    'SADECE su formatta JSON dondur, baska metin yazma:\n' +
    '{"validations":[{"symbol":"...","pattern":"...","verdict":"approve|adjust|reject",' +
    '"adjustedUpsidePct":12.5,"adjustedConfidence":65,"comment":"kisa Turkce gerekce"}]}';

  const user = 'Formasyon adaylari (JSON; recentCloses = ilgili hissenin son 45 gunluk kapanis serisi):\n' +
    JSON.stringify(rows) +
    '\n\nHer adayi gercek fiyat serisine bakarak BAGIMSIZ dogrula ve TUTARLI karar ver. ' +
    'Kurallar: (1) recentCloses serisinde formasyonu destekleyen yapi yoksa verdict="reject"; ' +
    '(2) yapi var ama hedef veya guven abartiliysa verdict="adjust" ve gercekci ' +
    'adjustedUpsidePct (aylik %1-%35 arasi) ile adjustedConfidence (20-90 arasi) uret; ' +
    '(3) yapi net ve hedef makulsa verdict="approve". Benzer yapilar icin benzer ' +
    'skorlar ver; tutarlilik oncelikli. Donen dizi TUM adaylari kapsamali. ' +
    'comment alani kisaca neden bu karari verdigini Turkce aciklasin. Yalnizca JSON dondur.';

  const json = await postJson(API_BASE, {
    model: MODEL,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    temperature: 0.15,
    max_tokens: 8000,
    stream: false
  });

  const raw = extractText(json);
  const parsed = parseJsonLoose(raw);
  if (parsed && Array.isArray(parsed.validations)) {
    return { validations: parsed.validations, raw };
  }
  return { validations: [], raw };
}

/** Model yanitindan JSON objesini toleransli ayiklar. */
function parseJsonLoose(text) {
  if (!text) return null;
  // once dogrudan parse
  try { return JSON.parse(text); } catch (_) {}
  // ```json ... ``` blogu
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (_) {}
  }
  // ilk { ... } objesi
  const brace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (brace !== -1 && lastBrace > brace) {
    try {
      return JSON.parse(text.slice(brace, lastBrace + 1));
    } catch (_) {}
  }
  return null;
}

module.exports = { analyzeStock, analyzeMarket, validateFormations };