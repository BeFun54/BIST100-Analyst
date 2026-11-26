'use strict';

/**
 * AI Analiz istemcisi (v2).
 *
 * Desteklenen saglayicilar (OpenAI uyumlu /chat/completions):
 *  - EVREN (T.C. SSB Milli Yapay Zeka Platformu)  https://evren-llmapi.ssyz.org.tr/v1
 *  - NVIDIA NIM, OpenAI, OpenRouter, Groq, DeepSeek ve ozel adresler
 *
 * Onemli duzeltmeler:
 *  - API anahtari artik her istekte istemciden (tarayicidan) gelebilir; boylece
 *    uygulama birden fazla kullaniciya sunuldugunda herkes kendi anahtarini kullanir.
 *  - EVREN'in zorunlu kullanim sartlari akisi (terms/status -> terms/accept)
 *    otomatik yonetilir; 403 terms_not_accepted alinirsa bir kez onaylanip tekrar denenir.
 *  - Akil yurutme (reasoning) modellerinde nihai cevap icin yeterli token ayrilir
 *    (max_tokens >= 4096); boylece content bos donmez.
 *  - Piyasa ve hisse promptlari haberleri, formasyonlari ve gostergeleri birlikte
 *    degerlendirip yakin (1-4 hafta) ve uzak (3-12 ay) vadeli tahmin uretir.
 */

require('./env'); // proje kokundeki .env dosyasini yukler (varsa)

const https = require('https');
const http = require('http');
const crypto = require('crypto');

/* ------------------------------------------------------------------ *
 *  Saglayici tanimlari
 * ------------------------------------------------------------------ */

const PROVIDERS = {
  evren: {
    label: 'EVREN (SSB Milli Yapay Zeka)',
    apiBase: 'https://evren-llmapi.ssyz.org.tr/v1/chat/completions',
    model: 'auto',
    keyHint: 'evren_llm_...'
  },
  nvidia: {
    label: 'NVIDIA NIM',
    apiBase: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    keyHint: 'nvapi-...'
  },
  openai: {
    label: 'OpenAI',
    apiBase: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o',
    keyHint: 'sk-...'
  },
  openrouter: {
    label: 'OpenRouter',
    apiBase: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'openai/gpt-4o',
    keyHint: 'sk-or-...'
  },
  groq: {
    label: 'Groq',
    apiBase: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.1-405b-instruct',
    keyHint: 'gsk_...'
  },
  deepseek: {
    label: 'DeepSeek',
    apiBase: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    keyHint: 'sk-...'
  },
  custom: {
    label: 'Özel / Diğer (OpenAI uyumlu)',
    apiBase: '',
    model: '',
    keyHint: 'API anahtarı'
  }
};

const FALLBACK_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';

/* ------------------------------------------------------------------ *
 *  Yardimcilar
 * ------------------------------------------------------------------ */

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/** Kullanicinin girdigi adresi /chat/completions ucuna tamamlar. */
function normalizeChatUrl(raw) {
  let base = trimSlash(raw);
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+(?:\.\d+)?$/i.test(base)) return base + '/chat/completions';
  if (/\/v\d+\//i.test(base)) return base + '/chat/completions';
  return base + '/v1/chat/completions';
}

/** Chat adresinden /models adresini uretir. */
function modelsUrl(raw) {
  let base = normalizeChatUrl(raw);
  if (!base) return '';
  const u = new URL(base);
  let path = u.pathname.replace(/\/+$/, '');
  path = path.replace(/\/chat\/completions$/i, '');
  if (!/\/v\d+(?:\.\d+)?$/i.test(path)) {
    const m = path.match(/^(.*\/v\d+(?:\.\d+)?)(\/.*)?$/i);
    if (m) path = m[1];
  }
  return u.origin + path + '/models';
}

function detectProvider(apiKey, apiBase) {
  const k = String(apiKey || '').toLowerCase();
  const b = String(apiBase || '').toLowerCase();
  if (k.startsWith('evren_llm_') || b.includes('evren-llmapi.ssyz.org.tr')) return 'evren';
  if (k.startsWith('nvapi-') || b.includes('integrate.api.nvidia.com')) return 'nvidia';
  if (k.startsWith('gsk_') || b.includes('groq.com')) return 'groq';
  if (b.includes('openrouter.ai')) return 'openrouter';
  if (b.includes('deepseek.com')) return 'deepseek';
  if (b.includes('api.openai.com')) return 'openai';
  return 'custom';
}

function defaultModelFor(provider, apiBase) {
  const p = PROVIDERS[provider];
  if (p && p.model) return p.model;
  const detected = detectProvider('', apiBase);
  return (PROVIDERS[detected] && PROVIDERS[detected].model) || FALLBACK_MODEL;
}

/**
 * Istek bazli AI ayarini cozer.
 * Oncelik: istemciden gelen degerler > .env > saglayici varsayilani.
 */
function resolveConfig(overrides) {
  const o = overrides || {};
  const envKeyRaw = process.env.AI_API_KEY || '';
  const envKey = envKeyRaw && envKeyRaw !== 'DEV_ONLY_PLACEHOLDER' ? envKeyRaw : '';
  const apiKey = String(o.apiKey || envKey || '').trim();
  const rawBase = trimSlash(o.apiBase || process.env.AI_API_BASE || '');
  let provider = String(o.provider || detectProvider(apiKey, rawBase)).trim() || 'nvidia';
  if (provider === 'custom' && !rawBase && !apiKey) provider = 'nvidia';
  const preset = PROVIDERS[provider] || PROVIDERS.custom;
  const apiBase = normalizeChatUrl(rawBase || preset.apiBase || PROVIDERS.nvidia.apiBase);
  const model =
    String(o.model || process.env.AI_MODEL || '').trim() ||
    defaultModelFor(provider, apiBase);
  const isEvren =
    provider === 'evren' ||
    /evren-llmapi\.ssyz\.org\.tr/i.test(apiBase) ||
    /^evren_llm_/i.test(apiKey);
  return { apiKey, apiBase, model, provider, isEvren };
}

function configSignature(overrides) {
  const c = resolveConfig(overrides || {});
  return sha1(c.apiKey + '|' + c.apiBase + '|' + c.model).slice(0, 12);
}

/* ------------------------------------------------------------------ *
 *  HTTP istemcisi
 * ------------------------------------------------------------------ */

function authHeaders(cfg) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'BIST100-Analist-V2/2.0'
  };
  if (cfg.apiKey) {
    headers.Authorization = 'Bearer ' + cfg.apiKey;
    // EVREN hem Bearer hem X-API-Key kabul eder; ikisini de gonderiyoruz.
    if (cfg.isEvren) headers['X-API-Key'] = cfg.apiKey;
  }
  return headers;
}

function requestRaw(method, targetUrl, body, cfg, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    const url = new URL(targetUrl);
    const lib = url.protocol === 'http:' ? http : https;
    const data = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const headers = authHeaders(cfg);
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = lib.request(
      url,
      {
        method: method || 'GET',
        headers,
        timeout: timeout || 90000
      },
      (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, targetUrl).toString();
          requestRaw(method, next, body, cfg, timeout).then(
            (r) => done(resolve, r),
            (e) => done(reject, e)
          );
          return;
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => done(resolve, { status, headers: res.headers, raw }));
        res.on('error', (e) => done(reject, e));
      }
    );

    req.on('error', (e) => done(reject, e));
    req.on('timeout', () => {
      req.destroy(new Error('AI API zaman aşımı (' + Math.round((timeout || 90000) / 1000) + ' sn)'));
    });
    if (data) req.write(data);
    req.end();
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/** Model yanitindan JSON objesini toleransli ayiklar. */
function parseJsonLoose(text) {
  if (!text) return null;
  const clean = String(text).trim();
  try {
    return JSON.parse(clean);
  } catch (_) {
    /* devam */
  }
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch (_) {
      /* devam */
    }
  }
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const candidate = clean.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {
      /* trailing comma temizligi */
      try {
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

function providerError(status, raw) {
  const body = parseJson(raw) || {};
  const err = body.error && typeof body.error === 'object' ? body.error : {};
  const message = String(
    (typeof body.error === 'string' ? body.error : '') ||
      err.message ||
      body.message ||
      body.detail ||
      raw ||
      ''
  ).slice(0, 600);

  if (status === 401) return 'API anahtarı geçersiz veya yetkisiz (HTTP 401). Anahtarı kontrol edin.';
  if (status === 402) return 'API kredisi/kotası yetersiz (HTTP 402).';
  if (status === 403 && /terms/i.test(message)) {
    return 'EVREN kullanım şartları onaylanmamış. Otomatik onay denendi ancak başarısız oldu.';
  }
  if (status === 403) return 'Erişim reddedildi (HTTP 403): ' + message;
  if (status === 404) {
    return 'Sunucu adresi veya model bulunamadı (HTTP 404). Base URL ve model kimliğini kontrol edin.';
  }
  if (status === 429) return 'Kota/hız sınırı aşıldı (HTTP 429). Kısa bir süre sonra tekrar deneyin.';
  if (status === 502 || status === 503) {
    return 'AI sağlayıcısı şu anda yoğun (HTTP ' + status + '). Birkaç saniye sonra tekrar deneyin.';
  }
  return 'AI API hatası (HTTP ' + status + '): ' + message;
}

function isTermsError(err) {
  return (
    err &&
    Number(err.status) === 403 &&
    /terms|şart|sart/i.test(String(err.body || err.message || ''))
  );
}

function apiError(status, raw) {
  const e = new Error(providerError(status, raw));
  e.status = status;
  e.body = raw;
  return e;
}

/* ------------------------------------------------------------------ *
 *  EVREN kullanim sartlari (terms gate)
 * ------------------------------------------------------------------ */

const termsState = new Map(); // key -> acceptedAt

function termsOrigin(cfg) {
  try {
    return new URL(cfg.apiBase).origin;
  } catch (_) {
    return 'https://evren-llmapi.ssyz.org.tr';
  }
}

async function ensureEvrenTerms(cfg, force) {
  if (!cfg.isEvren || !cfg.apiKey) return;
  const cacheKey = sha1(cfg.apiKey + '|' + termsOrigin(cfg));
  if (!force && termsState.has(cacheKey)) return;

  const origin = termsOrigin(cfg);
  try {
    const statusRes = await requestRaw(
      'GET',
      origin + '/v1/terms/status',
      null,
      cfg,
      20000
    );
    let version = 1;
    let accepted = false;
    const statusJson = parseJson(statusRes.raw);
    if (statusJson) {
      if (statusJson.current_version != null) version = Number(statusJson.current_version) || 1;
      accepted = statusJson.accepted === true;
    }
    if (!accepted && statusRes.status >= 200 && statusRes.status < 300) {
      // Metni okumak zorunlu degil; surum numarasini onaylamak yeterli.
      const acceptRes = await requestRaw(
        'POST',
        origin + '/v1/terms/accept',
        JSON.stringify({ version }),
        cfg,
        20000
      ).catch(() => null);
      accepted = !!acceptRes && acceptRes.status >= 200 && acceptRes.status < 300;
    }
    if (accepted) termsState.set(cacheKey, Date.now());
  } catch (_) {
    // Sart kontrolu basarisiz olsa bile sohbet istegini engellemiyoruz;
    // gercek 403 alinirsa tekrar denenecek.
  }
}

/* ------------------------------------------------------------------ *
 *  Sohbet cagrisi
 * ------------------------------------------------------------------ */

async function postChat(cfg, payload, opts) {
  const options = opts || {};
  const timeout = options.timeout || 180000;
  const maxRetries = options.retries == null ? 2 : options.retries;

  await ensureEvrenTerms(cfg, false);

  const attempt = async (n, forceTerms) => {
    let res;
    try {
      res = await requestRaw('POST', cfg.apiBase, payload, cfg, timeout);
    } catch (e) {
      if (n > 0) {
        await sleep(1200);
        return attempt(n - 1, forceTerms);
      }
      throw new Error('AI sunucusuna bağlanılamadı: ' + e.message);
    }

    let err = null;
    if (res.status < 200 || res.status >= 300) {
      err = apiError(res.status, res.raw);
    }

    if (err && cfg.isEvren && !forceTerms && isTermsError(err)) {
      await ensureEvrenTerms(cfg, true);
      return attempt(n, true);
    }

    if (err && n > 0 && [429, 502, 503, 504].includes(res.status)) {
      await sleep(res.status === 429 ? 2500 : 1200);
      return attempt(n - 1, forceTerms);
    }

    if (err) throw err;

    const json = parseJson(res.raw);
    if (!json) {
      throw new Error('AI API geçerli JSON döndürmedi: ' + String(res.raw).slice(0, 220));
    }
    // Bazi saglayicilar HTTP 200 icinde hata gövdesi dondurebilir.
    if (json.error && !json.choices) {
      throw new Error(providerError(200, res.raw));
    }
    return json;
  };

  return attempt(maxRetries, false);
}

/** Model mesajindan nihai metni cikarir (reasoning fallback'li). */
function extractText(json) {
  try {
    const msg = json.choices && json.choices[0] && json.choices[0].message;
    if (!msg) return 'AI yorumu oluşturulamadı (boş yanıt).';
    if (msg.content && String(msg.content).trim()) return String(msg.content).trim();
    const reasoning = msg.reasoning_content || msg.reasoning;
    if (reasoning && String(reasoning).trim()) return String(reasoning).trim();
    return 'AI yorumu oluşturulamadı (boş yanıt).';
  } catch (_) {
    return 'AI yorumu oluşturulamadı (geçersiz yanıt).';
  }
}

function chatMessages(system, user) {
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

const ANALYST_SYSTEM =
  'Sen BIST100 (Borsa İstanbul) uzmanı, deneyimli bir finansal analistsin. ' +
  'Türkçe, net, objektif ve veriye dayalı yaz. Yatırım tavsiyesi verme; "al", "sat", ' +
  '"pozisyon aç/kapat" gibi ifadeler kullanma. Sadece analiz, olası senaryo ve riskleri ' +
  'açıkla. Uydurma veri veya haber ekleme; yalnızca sana verilen verileri kullan. ' +
  'Cevabın sonunda mutlaka "Bu bir yatırım tavsiyesi değildir." yaz.';

/* ------------------------------------------------------------------ *
 *  Piyasa analizi (haber + formasyon + yakin/uzak vade)
 * ------------------------------------------------------------------ */

function fmtNum(v, digits) {
  if (v == null || !isFinite(v)) return '—';
  return Number(v).toLocaleString('tr-TR', {
    minimumFractionDigits: digits == null ? 2 : digits,
    maximumFractionDigits: digits == null ? 2 : digits
  });
}

function fmtPct(v) {
  if (v == null || !isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + fmtNum(v, 2) + '%';
}

function formationLine(f) {
  const dir = f.direction === 'bearish' ? 'düşüş' : 'yükseliş';
  const price = f.lastClose != null ? ' | fiyat ' + fmtNum(f.lastClose) + ' TL' : '';
  const target =
    f.targetPrice != null
      ? ' → hedef ' + fmtNum(f.targetPrice) + ' TL'
      : f.upsidePct != null
      ? ' → beklenen %' + f.upsidePct
      : '';
  return (
    f.symbol +
    ' — ' +
    f.patternName +
    ' (' +
    (f.type || '') +
    ') | güven %' +
    f.confidence +
    price +
    target +
    ' | ' +
    dir +
    ' | ' +
    (f.eta || f.timeframe || '')
  );
}

function buildMarketPrompt(input) {
  const lines = [];
  const breadth = input.breadth || {};
  lines.push('TARİH: ' + new Date().toLocaleDateString('tr-TR'));
  lines.push('BIST100 PİYASA GENEL DURUMU');
  lines.push(
    'Toplam hisse: ' +
      (breadth.total || 0) +
      ' | Yükselen: ' +
      (breadth.up || 0) +
      ' | Düşen: ' +
      (breadth.down || 0) +
      ' | Yatay: ' +
      (breadth.flat || 0)
  );
  if (input.index) {
    lines.push(
      'BIST100 Endeksi (XU100): ' +
        fmtNum(input.index.price) +
        ' TL | günlük ' +
        fmtPct(input.index.changePercent) +
        ' | haftalık ' +
        fmtPct(input.index.weekChangePercent) +
        ' | aylık ' +
        fmtPct(input.index.monthChangePercent) +
        ' | 20 günlük destek ' +
        fmtNum(input.index.support) +
        ' TL | 20 günlük direnç ' +
        fmtNum(input.index.resistance) +
        ' TL'
    );
  }

  const list = (arr, title) => {
    if (!arr || !arr.length) return;
    lines.push(title + ': ' + arr.map((s) => s.symbol + ' (' + fmtPct(s.changePercent) + ')').join(', '));
  };
  list(input.topGainers, 'Günün en çok yükselenleri');
  list(input.topLosers, 'Günün en çok düşenleri');
  list(input.weekLeaders, 'Haftanın en çok yükselenleri');
  list(input.weekLosers, 'Haftanın en çok düşenleri');
  list(input.monthLeaders, 'Ayın en çok yükselenleri');
  list(input.monthLosers, 'Ayın en çok düşenleri');

  if (input.gold) {
    const g = input.gold;
    const ons =
      g.onsUsd != null
        ? '$' + fmtNum(g.onsUsd)
        : g.onsTry != null
        ? fmtNum(g.onsTry) + ' TL'
        : '—';
    const changeText =
      g.changes && (g.changes.gram != null || g.changes.ceyrek != null || g.changes.tam != null)
        ? ' | günlük değişim: gram ' +
          fmtPct(g.changes.gram) +
          ' · çeyrek ' +
          fmtPct(g.changes.ceyrek) +
          ' · tam ' +
          fmtPct(g.changes.tam) +
          ' · ons ' +
          fmtPct(g.changes.ons)
        : '';
    lines.push(
      'Altın (' +
        (g.sourceLabel || 'kaynak') +
        ', satış): gram ' +
        fmtNum(g.gram) +
        ' TL | çeyrek ' +
        fmtNum(g.ceyrek) +
        ' TL | tam ' +
        fmtNum(g.tam) +
        ' TL | ons ' +
        ons +
        ' | USD/TRY ' +
        fmtNum(g.usdTry, 4) +
        changeText
    );
  }

  const bull = (input.formations && input.formations.bullish) || [];
  const bear = (input.formations && input.formations.bearish) || [];
  lines.push('');
  lines.push('AKTİF TEKNİK FORMASYON TARAMASI');
  lines.push('Yükseliş beklenen (' + bull.length + '):');
  if (bull.length) for (const f of bull.slice(0, 10)) lines.push('- ' + formationLine(f));
  else lines.push('- Belirgin tamamlanmış yükseliş formasyonu yok.');
  lines.push('Düşüş beklenen (' + bear.length + '):');
  if (bear.length) for (const f of bear.slice(0, 10)) lines.push('- ' + formationLine(f));
  else lines.push('- Belirgin tamamlanmış düşüş formasyonu yok.');

  const news = input.news || [];
  lines.push('');
  lines.push('SON HABERLER (Google Haberler, son 7 gün):');
  if (news.length) {
    for (const n of news.slice(0, 12)) {
      const date = n.publishedAt
        ? new Date(n.publishedAt).toLocaleDateString('tr-TR')
        : 'tarih yok';
      lines.push(
        '- [' +
          date +
          '] ' +
          (n.source ? n.source + ': ' : '') +
          n.title +
          (n.summary ? ' — ' + String(n.summary).slice(0, 180) : '')
      );
    }
  } else {
    lines.push('- Haber bulunamadı.');
  }

  lines.push('');
  lines.push(
    'ÖNEMLİ VERİ KURALI: Sana verilmeyen fiyat seviyesi, destek/direnç, sektör, tarih ' +
      'veya haber UYDURMA. Formasyon satırlarındaki "fiyat" ve "hedef" değerlerini kullan. ' +
      'BIST100 için destek/direnç olarak yalnızca yukarıdaki "20 günlük destek/direnç" ' +
      'değerlerini kullan. Sektör bilgisi verilmediyse sektör adı uydurma; emin değilsen ' +
      '"sektör bilgisi yok" de. Seviye verisi olmayan hisseler için "seviye verisi yok" de.'
  );
  lines.push('');
  lines.push(
    'GÖREV: Yukarıdaki fiyat hareketlerini, formasyonları ve haberleri birlikte değerlendir. ' +
      'Haberlerin piyasa üzerindeki olası etkisini somut biçimde açıkla. ' +
      'Yanıtı şu başlıklarla Markdown olarak ver:\n' +
      '## 📌 Piyasa Özeti\n' +
      '## 📰 Haber Akışı ve Etkisi\n' +
      '## 📈 Yakın Vadeli Görünüm (1-4 Hafta)\n' +
      '## 🔭 Uzak Vadeli Görünüm (3-12 Ay)\n' +
      '## ⚠️ Riskler ve Senaryolar\n' +
      'Yakın vade için yön, olası destek/direnç bantları ve katalizörler; uzak vade için ' +
      'trend projeksiyonu, sektör/gündem etkisi ve riskler olsun. Somut rakamlar kullan.'
  );
  return lines.join('\n');
}

async function analyzeMarket(input, overrides) {
  const cfg = resolveConfig(overrides);
  if (!cfg.apiKey) throw new Error('AI API anahtarı girilmedi.');
  const prompt = buildMarketPrompt(input || {});
  const json = await postChat(
    cfg,
    {
      model: cfg.model,
      messages: chatMessages(ANALYST_SYSTEM, prompt),
      temperature: 0.35,
      max_tokens: 8000,
      stream: false
    },
    { timeout: 300000 }
  );
  return extractText(json);
}

/* ------------------------------------------------------------------ *
 *  Hisse analizi (haber + formasyon + yakin/uzak vade)
 * ------------------------------------------------------------------ */

function buildStockPrompt(input) {
  const lines = [];
  const c = input.changes || {};
  const ind = input.ind || {};
  lines.push('TARİH: ' + new Date().toLocaleDateString('tr-TR'));
  lines.push('HİSSE: ' + input.symbol + ' (' + (input.name || '') + ')');
  lines.push('Son fiyat: ' + fmtNum(input.price) + ' TL');
  lines.push(
    'Değişimler: günlük ' +
      fmtPct(c.daily) +
      ' | haftalık ' +
      fmtPct(c.weekly) +
      ' | aylık ' +
      fmtPct(c.monthly) +
      ' | 3 aylık ' +
      fmtPct(c.quarterly) +
      ' | yıllık ' +
      fmtPct(c.yearly)
  );
  lines.push(
    'Göstergeler: SMA20 ' +
      fmtNum(ind.sma20) +
      ' | SMA50 ' +
      fmtNum(ind.sma50) +
      ' | SMA200 ' +
      fmtNum(ind.sma200) +
      ' | RSI14 ' +
      fmtNum(ind.rsi14, 1) +
      ' | ATR% ' +
      fmtNum(ind.atrPct) +
      ' | 52h konum %' +
      fmtNum(ind.pos52, 0) +
      ' (' +
      fmtNum(ind.low52) +
      ' - ' +
      fmtNum(ind.high52) +
      ') | trend: ' +
      (ind.trend || '—')
  );
  if (ind.momentum20 != null) {
    lines.push(
      'Momentum: 5g ' +
        fmtPct(ind.momentum5) +
        ' | 20g ' +
        fmtPct(ind.momentum20) +
        ' | 60g ' +
        fmtPct(ind.momentum60) +
        ' | 120g ' +
        fmtPct(ind.momentum120)
    );
  }
  if (input.levels) {
    lines.push(
      'Yakın destek: ' +
        fmtNum(input.levels.support) +
        ' TL | Yakın direnç: ' +
        fmtNum(input.levels.resistance) +
        ' TL'
    );
  }
  if (input.market) {
    lines.push(
      'Piyasa bağlamı: BIST100 yükselen ' +
        (input.market.up || 0) +
        ' / düşen ' +
        (input.market.down || 0) +
        ' | endeks yönü: ' +
        (input.market.tone || 'karışık')
    );
  }

  const formations = input.formations || {};
  const bull = formations.bullish || [];
  const bear = formations.bearish || [];
  lines.push('');
  lines.push('TESPİT EDİLEN FORMASYONLAR');
  if (bull.length) {
    lines.push('Yükseliş:');
    for (const f of bull) {
      lines.push(
        '- ' +
          f.patternName +
          ' (' +
          f.type +
          ') | güven %' +
          f.confidence +
          ' | fiyat ' +
          fmtNum(f.lastClose) +
          ' TL → hedef ' +
          fmtNum(f.targetPrice) +
          ' TL | ' +
          (f.eta || f.timeframe || '') +
          ' | ' +
          f.detail
      );
    }
  } else {
    lines.push('Yükseliş: belirgin tamamlanmış formasyon yok.');
  }
  if (bear.length) {
    lines.push('Düşüş:');
    for (const f of bear) {
      lines.push(
        '- ' +
          f.patternName +
          ' (' +
          f.type +
          ') | güven %' +
          f.confidence +
          ' | fiyat ' +
          fmtNum(f.lastClose) +
          ' TL → hedef ' +
          fmtNum(f.targetPrice) +
          ' TL | ' +
          (f.eta || f.timeframe || '') +
          ' | ' +
          f.detail
      );
    }
  } else {
    lines.push('Düşüş: belirgin tamamlanmış formasyon yok.');
  }

  if (input.dailyCloses && input.dailyCloses.length) {
    lines.push('');
    lines.push(
      'Son ' +
        input.dailyCloses.length +
        ' günlük kapanış (eskiden yeniye): ' +
        input.dailyCloses.join(', ')
    );
  }
  if (input.weeklyCloses && input.weeklyCloses.length) {
    lines.push(
      'Son ' +
        input.weeklyCloses.length +
        ' haftalık kapanış (eskiden yeniye): ' +
        input.weeklyCloses.join(', ')
    );
  }

  const news = input.news || [];
  lines.push('');
  lines.push('SON HABERLER (son 7 gün):');
  if (news.length) {
    for (const n of news.slice(0, 8)) {
      const date = n.publishedAt
        ? new Date(n.publishedAt).toLocaleDateString('tr-TR')
        : 'tarih yok';
      lines.push(
        '- [' +
          date +
          '] ' +
          (n.source ? n.source + ': ' : '') +
          n.title +
          (n.summary ? ' — ' + String(n.summary).slice(0, 200) : '')
      );
    }
  } else {
    lines.push('- Haber bulunamadı.');
  }

  const horizon = input.horizon || 'all';
  const horizonNote =
    horizon === 'short'
      ? 'Kullanıcı özellikle YAKIN VADE (1-4 hafta) tahminine odaklanmak istiyor; yine de uzak vadeye kısaca değin.'
      : horizon === 'long'
      ? 'Kullanıcı özellikle UZAK VADE (3-12 ay) tahminine odaklanmak istiyor; yine de yakın vadeye kısaca değin.'
      : 'Hem yakın hem uzak vadeyi dengeli biçimde ele al.';

  lines.push('');
  lines.push(
    'ÖNEMLİ VERİ KURALI: Yukarıda verilmeyen fiyat seviyesi, destek/direnç, haber veya ' +
      'sektör bilgisi UYDURMA. Destek/direnç için yalnızca "Yakın destek" ve "Yakın direnç" ' +
      'değerlerini kullan; verilmeyen bir şey için "veri yok" de.'
  );
  lines.push('');
  lines.push(
    'GÖREV: ' +
      horizonNote +
      ' Haberleri fiyat/formasyon verisiyle ilişkilendir; her haberin olası etkisini ' +
      '(pozitif/negatif/nötr) ve nedenini açıkla. Yanıtı şu başlıklarla Markdown olarak ver:\n' +
      '## 📌 Kısa Özet\n' +
      '## 📰 Haberler ve Olası Etkileri\n' +
      '## 📐 Teknik Görünüm ve Formasyonlar\n' +
      '## 🎯 Yakın Vadeli Tahmin (1-4 Hafta)\n' +
      '## 🔭 Uzak Vadeli Tahmin (3-12 Ay)\n' +
      '## ⚠️ Riskler ve Senaryolar\n' +
      'Yakın vade için yön, hedef/destek fiyat bantları ve tetikleyiciler; uzak vade için ' +
      'trend projeksiyonu ve riskler ver. Kesin al/sat tavsiyesi verme.'
  );
  return lines.join('\n');
}

async function analyzeStock(input, overrides) {
  const cfg = resolveConfig(overrides);
  if (!cfg.apiKey) throw new Error('AI API anahtarı girilmedi.');
  const prompt = buildStockPrompt(input || {});
  const json = await postChat(
    cfg,
    {
      model: cfg.model,
      messages: chatMessages(ANALYST_SYSTEM, prompt),
      temperature: 0.35,
      max_tokens: 8000,
      stream: false
    },
    { timeout: 300000 }
  );
  return extractText(json);
}

/* ------------------------------------------------------------------ *
 *  Portfoy risk izleme (yapilandirilmis JSON)
 * ------------------------------------------------------------------ */

const PORTFOLIO_SYSTEM =
  'Sen BIST100 portföy risk analistisin. Sana her hisse için güncel fiyat, kullanıcının ' +
  'alış bilgisi, formasyon hedefi ve teknik göstergeler verilecek. Görevin yakın vadede ' +
  '(1-4 hafta) gerçekçi zirve fiyatını ve düşüş riskini değerlendirmek. Kesin al/sat emri ' +
  'vermezsin; veriye dayalı risk uyarısı üretirsin. Yalnızca istenen JSON şemasında yanıt ver.';

function fmtNum(v, d) {
  if (v == null || !isFinite(Number(v))) return 'veri yok';
  return Number(v).toFixed(d == null ? 2 : d);
}

function buildPortfolioPrompt(input) {
  const items = (input && input.items) || [];
  const lines = [];
  lines.push('PORTFÖY İZLEME İSTEĞİ');
  lines.push('Aşağıdaki her hisse için yakın vadeli zirve ve düşüş riski değerlendirmesi yap.');
  lines.push('');

  for (const it of items) {
    lines.push('--- ' + it.symbol + ' (' + (it.name || it.symbol) + ') ---');
    lines.push('Güncel fiyat: ' + fmtNum(it.price) + ' TL');
    lines.push(
      'Kullanıcı alış: ' + fmtNum(it.buyPrice) + ' TL · Adet: ' + fmtNum(it.qty, 2)
    );
    if (it.target != null) {
      lines.push(
        'Formasyon tahmini satış hedefi: ' +
          fmtNum(it.target) +
          ' TL' +
          (it.patternName ? ' (' + it.patternName + ')' : '')
      );
    }
    if (it.changePercent != null || it.weekChangePercent != null) {
      lines.push(
        'Değişim: günlük %' +
          fmtNum(it.changePercent) +
          ' · haftalık %' +
          fmtNum(it.weekChangePercent) +
          ' · aylık %' +
          fmtNum(it.monthChangePercent)
      );
    }
    if (it.rsi14 != null) lines.push('RSI14: ' + fmtNum(it.rsi14, 1));
    if (it.ma20 != null || it.ma50 != null) {
      lines.push('MA20: ' + fmtNum(it.ma20) + ' · MA50: ' + fmtNum(it.ma50));
    }
    if (it.high60 != null || it.low60 != null) {
      lines.push('60 gün yüksek: ' + fmtNum(it.high60) + ' · düşük: ' + fmtNum(it.low60));
    }
    if (Array.isArray(it.closes) && it.closes.length) {
      lines.push('Son kapanışlar (eskiden yeniye): ' + it.closes.join(', '));
    }
    const news = Array.isArray(it.news) ? it.news : [];
    if (news.length) {
      lines.push('Son haberler:');
      for (const n of news.slice(0, 3)) {
        lines.push(
          '- ' + (n.source ? n.source + ': ' : '') + String(n.title || '').slice(0, 140)
        );
      }
    }
    lines.push('');
  }

  lines.push('KURALLAR:');
  lines.push(
    '- aiTarget: 1-4 hafta içinde görülebilecek gerçekçi zirve fiyatı (TL). Veri yetersizse null.'
  );
  lines.push(
    '- aiTarget güncel fiyatın 0.85 ile 1.60 katı arasında olmalı; dışına çıkarsan sınıra çek.'
  );
  lines.push('- risk: "low" | "medium" | "high" (yakın vadede düşüş riski).');
  lines.push('- action: "hold" | "watch" | "take_profit" | "reduce".');
  lines.push(
    '- reason: Türkçe, en fazla 160 karakter; direnç, RSI, hacim veya haber gibi somut veriye dayan.'
  );
  lines.push('- confidence: 0-100 arası tam sayı.');
  lines.push('- Her hisse için tek satır; verilmeyen veriyi uydurma.');
  lines.push('');
  lines.push('Yanıtı SADECE aşağıdaki JSON olarak ver:');
  lines.push(
    '{"symbols":[{"symbol":"GARAN","aiTarget":125.4,"risk":"medium","action":"watch",' +
      '"confidence":60,"reason":"Kısa gerekçe"}]}'
  );
  return lines.join('\n');
}

async function analyzePortfolio(input, overrides) {
  const cfg = resolveConfig(overrides);
  if (!cfg.apiKey) throw new Error('AI API anahtarı girilmedi.');
  const prompt = buildPortfolioPrompt(input || {});
  const json = await postChat(
    cfg,
    {
      model: cfg.model,
      messages: chatMessages(PORTFOLIO_SYSTEM, prompt),
      temperature: 0.25,
      max_tokens: 4000,
      stream: false
    },
    { timeout: 240000 }
  );
  const text = extractText(json);
  const parsed = parseJsonLoose(text);
  if (!parsed || !Array.isArray(parsed.symbols)) {
    throw new Error('AI portföy yanıtı çözümlenemedi');
  }
  return parsed.symbols;
}

/* ------------------------------------------------------------------ *
 *  Formasyon AI dogrulamasi
 * ------------------------------------------------------------------ */

function validationRows(formations) {
  return (formations || []).map((f) => {
    const row = {
      symbol: f.symbol,
      pattern: f.patternName || f.pattern,
      patternKey: f.pattern || '',
      type: f.type || '',
      direction: f.direction || 'bullish',
      lastPrice: f.lastClose,
      upsidePct: f.upsidePct,
      confidence: f.confidence,
      eta: f.eta || '',
      detail: String(f.detail || '').slice(0, 240)
    };
    const c = f.context;
    if (c) {
      if (Array.isArray(c.series) && c.series.length) row.recentCloses = c.series;
      if (c.high60 != null) row.high60 = c.high60;
      if (c.low60 != null) row.low60 = c.low60;
      if (c.ma50 != null) row.ma50 = c.ma50;
      if (c.ma200 != null) row.ma200 = c.ma200;
      if (c.rsi14 != null) row.rsi14 = c.rsi14;
      if (c.trend) row.trend = c.trend;
    }
    return row;
  });
}

const VALIDATION_SYSTEM =
  'Sen BIST100 teknik analiz doğrulayıcısısın. Sana kural tabanlı tarama motorunun ' +
  'bulduğu formasyon adayları JSON olarak verilecek. Her adayı gerçek fiyat serisine ' +
  '(recentCloses) ve verilen göstergelere bakarak bağımsız değerlendir. ' +
  'Kurallar: (1) hedef yükseliş/düşüş büyüklüğü aylık %1-35 aralığında olmalı, üstünü düzelt; ' +
  '(2) fiyat yapısı formasyonu desteklemiyorsa "reject"; (3) yapı var ama hedef/güven ' +
  'abartılıysa "adjust" ve gerçekçi adjustedUpsidePct (1-35) ile adjustedConfidence (20-90) üret; ' +
  'adjust kararında adjustedUpsidePct orijinal upsidePct değerinden BÜYÜK OLMASIN, yalnızca ' +
  'düşür veya aynı bırak; adjustedConfidence da orijinalden büyük olmasın; ' +
  '(4) yapı netse "approve"; (5) benzer yapılara benzer skor ver, tutarlı ol. ' +
  'SADECE şu şemada geçerli JSON döndür, başka metin yazma: ' +
  '{"validations":[{"symbol":"SYMBOL","pattern":"PATTERN","verdict":"approve|adjust|reject",' +
  '"adjustedUpsidePct":12.5,"adjustedConfidence":70,"comment":"kısa Türkçe gerekçe"}]} ' +
  'symbol ve pattern alanlarında sana verilen değerleri aynen kullan.';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizeValidations(parsed, rows) {
  if (!parsed || !Array.isArray(parsed.validations)) return [];
  const allowed = new Set();
  for (const r of rows) {
    allowed.add(String(r.symbol).toUpperCase() + '|' + String(r.pattern));
    if (r.patternKey) {
      allowed.add(String(r.symbol).toUpperCase() + '|' + String(r.patternKey));
    }
  }
  const out = [];
  for (const v of parsed.validations) {
    if (!v || !v.symbol) continue;
    const symbol = String(v.symbol).toUpperCase().trim();
    const pattern = String(v.pattern || '').trim();
    if (!pattern) continue;
    let matched = allowed.has(symbol + '|' + pattern);
    if (!matched) {
      // AI formasyon adini kucuk farkla yazmis olabilir: ayni sembolde tek aday varsa esle.
      const sameSymbol = rows.filter((r) => String(r.symbol).toUpperCase() === symbol);
      if (sameSymbol.length === 1) matched = true;
    }
    if (!matched) continue;
    const verdict = String(v.verdict || '').toLowerCase();
    out.push({
      symbol,
      pattern,
      verdict: ['approve', 'adjust', 'reject'].includes(verdict) ? verdict : 'approve',
      adjustedUpsidePct: v.adjustedUpsidePct,
      adjustedConfidence: v.adjustedConfidence,
      comment: String(v.comment || '').slice(0, 500)
    });
  }
  return out;
}

async function validateChunk(cfg, rows) {
  const user =
    'Formasyon adayları (JSON; recentCloses = ilgili hissenin son 20 günlük kapanış serisi):\n' +
    JSON.stringify(rows) +
    '\n\nHer adayı değerlendir. Dönen validations dizisi TÜM adayları kapsamalı. ' +
    'Yalnızca JSON döndür; açıklama veya düşünme metni ekleme.';

  const call = async (maxTokens) => {
    const json = await postChat(
      cfg,
      {
        model: cfg.model,
        messages: chatMessages(VALIDATION_SYSTEM, user),
        temperature: 0.1,
        max_tokens: maxTokens,
        stream: false
      },
      { timeout: 300000, retries: 1 }
    );
    return extractText(json);
  };

  let raw = await call(6000);
  let parsed = parseJsonLoose(raw);
  if (!parsed) {
    // Bazi modeller dusunme metnini de content'e koyar; JSON parcasini tekrar dene.
    raw = await call(4000);
    parsed = parseJsonLoose(raw);
  }
  return { parsed, raw };
}

async function validateFormations(formations, overrides) {
  const cfg = resolveConfig(overrides);
  if (!cfg.apiKey) throw new Error('AI API anahtarı girilmedi.');
  if (!formations || !formations.length) {
    return { validations: [], raw: '', error: null };
  }

  const rows = validationRows(formations);
  const groups = chunk(rows, 10);
  const all = [];
  const errors = [];
  let rawSample = '';

  for (let i = 0; i < groups.length; i++) {
    try {
      const { parsed, raw } = await validateChunk(cfg, groups[i]);
      if (!rawSample) rawSample = raw;
      const vals = normalizeValidations(parsed, groups[i]);
      if (!vals.length) {
        errors.push('AI yanıtı ayrıştırılamadı (grup ' + (i + 1) + ').');
      }
      all.push.apply(all, vals);
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
  }

  // Ayni symbol|pattern icin son kaydi tut.
  const byKey = new Map();
  for (const v of all) {
    byKey.set(v.symbol + '|' + v.pattern, v);
  }
  return {
    validations: Array.from(byKey.values()),
    raw: rawSample,
    error: errors.length ? errors.join(' | ') : null
  };
}

/* ------------------------------------------------------------------ *
 *  Yon karsilastirmasi
 * ------------------------------------------------------------------ */

async function compareDirections(bullish, bearish, overrides) {
  const cfg = resolveConfig(overrides);
  if (!cfg.apiKey) throw new Error('AI API anahtarı girilmedi.');
  const bRows = (bullish || []).slice(0, 12).map((f) => ({
    symbol: f.symbol,
    pattern: f.patternName || f.pattern,
    expectedPct: f.upsidePct,
    confidence: f.confidence
  }));
  const aRows = (bearish || []).slice(0, 12).map((f) => ({
    symbol: f.symbol,
    pattern: f.patternName || f.pattern,
    expectedPct: f.upsidePct,
    confidence: f.confidence
  }));
  const system =
    'Sen BIST100 teknik analistisin. Boga ve ayi formasyon adaylarını karşılaştır. ' +
    'Türkçe, 3-5 cümlelik kısa bir metin yaz. Hangi yönün daha baskın olduğunu, kısa ' +
    'piyasa eğilimini ve riski belirt. JSON veya markdown kullanma.';
  const user =
    'Yükseliş beklenen (boga) adaylar: ' +
    JSON.stringify(bRows) +
    '\nDüşüş beklenen (ayı) adaylar: ' +
    JSON.stringify(aRows) +
    '\n\nİki yönü karşılaştır ve kısa bir piyasa yorumu yaz.';
  const json = await postChat(
    cfg,
    {
      model: cfg.model,
      messages: chatMessages(system, user),
      temperature: 0.25,
      max_tokens: 3000,
      stream: false
    },
    { timeout: 180000 }
  );
  const text = extractText(json);
  return text;
}

/* ------------------------------------------------------------------ *
 *  Model listesi / baglanti testi
 * ------------------------------------------------------------------ */

const MODEL_LABELS = {
  'auto': 'auto (otomatik yönlendirme)',
  'glm-5.3': 'glm-5.3 (Z.ai GLM)',
  'deepseek-v4.1-flash': 'deepseek-v4.1-flash (DeepSeek)',
  'deepseek-v4-flash': 'deepseek-v4-flash (DeepSeek)',
  'mimo-v2.6-pro': 'mimo-v2.6-pro (Xiaomi)',
  'qwen3.8-flash-next': 'qwen3.8-flash-next (Qwen)',
  'gemma-4-31b': 'gemma-4-31b (Google)',
  'qwen3-vl-30b': 'qwen3-vl-30b (Qwen görsel)',
  'nvidia/nemotron-3.5-super-vl-120b-a12b': 'Nemotron 3.5 Super (NVIDIA)',
  'nvidia/llama-3.1-nemotron-70b-instruct': 'Nemotron 70B (NVIDIA)',
  'gpt-4o': 'GPT-4o (OpenAI)',
  'gpt-4o-mini': 'GPT-4o mini (OpenAI)',
  'deepseek-chat': 'deepseek-chat',
  'deepseek-reasoner': 'deepseek-reasoner'
};

async function listModels(overrides) {
  const cfg = resolveConfig(overrides);
  if (!cfg.apiKey) throw new Error('Model listesi için API anahtarı gerekli.');
  if (cfg.isEvren) await ensureEvrenTerms(cfg, false);

  const url = modelsUrl(cfg.apiBase);
  const res = await requestRaw('GET', url, null, cfg, 30000);
  if (res.status < 200 || res.status >= 300) {
    throw apiError(res.status, res.raw);
  }
  const json = parseJson(res.raw);
  const data = (json && (json.data || json.models)) || [];
  const models = [];
  for (const item of data) {
    const id = typeof item === 'string' ? item : item && (item.id || item.name);
    if (!id) continue;
    const task = (item && item.task) || 'chat';
    // Sohbet ucunda kullanilamayan OCR/embedding/rerank/karar modellerini ele.
    if (task && task !== 'chat' && task !== 'text') continue;
    models.push({
      id,
      label: MODEL_LABELS[id] || id,
      task
    });
  }
  models.sort((a, b) => (a.id === 'auto' ? -1 : b.id === 'auto' ? 1 : a.id.localeCompare(b.id)));
  return { models, provider: cfg.provider, apiBase: cfg.apiBase, model: cfg.model };
}

async function testConnection(overrides) {
  const cfg = resolveConfig(overrides);
  if (!cfg.apiKey) throw new Error('API anahtarı girilmedi.');

  let modelCount = null;
  try {
    const list = await listModels(overrides);
    modelCount = list.models.length;
  } catch (_) {
    // Model ucu desteklenmiyor olabilir; sohbet testi yeterli.
  }

  const json = await postChat(
    cfg,
    {
      model: cfg.model,
      messages: [{ role: 'user', content: 'Sadece "OK" yaz.' }],
      temperature: 0,
      max_tokens: 2048,
      stream: false
    },
    { timeout: 90000, retries: 1 }
  );
  // HTTP 200 + gecerli choices = anahtar calisiyor (reasoning nedeniyle content bos olabilir).
  const ok = !!(json && json.choices);
  if (!ok) throw new Error('AI sunucusu beklenen yanıtı döndürmedi.');
  return {
    ok: true,
    provider: cfg.provider,
    apiBase: cfg.apiBase,
    model: cfg.model,
    modelCount
  };
}

/* ------------------------------------------------------------------ *
 *  Sunucu varsayilan ayarlari (opsiyonel .env)
 * ------------------------------------------------------------------ */

function getPublicConfig() {
  const c = resolveConfig({});
  return {
    configured: !!c.apiKey,
    provider: c.provider,
    apiBase: c.apiBase,
    model: c.model,
    source: 'server'
  };
}

/** Sunucu geneli varsayilan ayari gunceller (yalnizca bu proses icin). */
function setRuntimeConfig(input) {
  const apiKey = input && input.apiKey ? String(input.apiKey).trim() : '';
  if (!apiKey) throw new Error('API anahtarı boş olamaz');
  const apiBase = input && input.apiBase ? String(input.apiBase).trim() : '';
  const model = input && input.model ? String(input.model).trim() : '';
  if (!apiBase) throw new Error('Sunucu adresi boş olamaz');
  if (!model) throw new Error('Model seçilmelidir');
  process.env.AI_API_KEY = apiKey;
  process.env.AI_API_BASE = normalizeChatUrl(apiBase);
  process.env.AI_MODEL = model;
  return getPublicConfig();
}

module.exports = {
  PROVIDERS,
  resolveConfig,
  configSignature,
  analyzeStock,
  analyzeMarket,
  analyzePortfolio,
  validateFormations,
  compareDirections,
  listModels,
  testConnection,
  getPublicConfig,
  setRuntimeConfig,
  parseJsonLoose,
  normalizeChatUrl,
  modelsUrl
};
