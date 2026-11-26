'use strict';

/**
 * Klasik grafik formasyonlari bilgi tabani + tespit motoru (v2).
 *
 * v2'de duzeltilen temel sorunlar:
 *  - Bayrak formasyonlarinda geri cekilme, hisse fiyatina degil direk boyuna gore olculur.
 *  - Kama formasyonlarinda egimler gercek gun indeksleriyle hesaplanir (R^2 uyum skoru ile).
 *  - Cift dip/zirve, OBO/TOBO, ucgen ve yuvarlak formasyonlarda:
 *      * oncesinde gercek bir trend olmasi,
 *      * ara bolgede formasyonun ihlal edilmemesi,
 *      * kirilimin taze olmasi (asiri uzamis sinyaller elenir)
 *    sartlari aranir.
 *  - RSI, SMA20/50/200, ATR ve 52 haftalik konum gibi gostergeler hesaplanir;
 *    hem guven skorunda hem AI dogrulamasinda kullanilir.
 *
 * Girdi: gunluk kapanis serisi [{t, c, v?}] (kronolojik sirali).
 * Cikti: { key, confidence, upsidePct|downsidePct, detail }
 */

/* ------------------------------------------------------------------ *
 *  Formasyon bilgi tabani (hafiza)
 * ------------------------------------------------------------------ */

const PATTERN_LIBRARY = {
  doubleBottom: {
    name: 'Çift Dip',
    en: 'Double Bottom',
    type: 'dönüş (boğa)',
    reliability: 'yüksek',
    description:
      'Fiyat iki kez aynı bölgeden dip yapar, aradaki direnç (boyun çizgisi) ' +
      'aşılınca düşüş trendinin bittiği ve yükselişin başladığı kabul edilir.',
    timeframe: 'yaklaşık 2-4 ay içinde',
    psychology:
      'İki kez denenen satış baskısı aynı seviyeyi kıramamış; alıcılar bölgeyi savunuyor.'
  },
  inverseHeadShoulders: {
    name: 'Ters Omuz-Baş-Omuz',
    en: 'Inverse Head & Shoulders',
    type: 'dönüş (boğa)',
    reliability: 'çok yüksek',
    description:
      'Üç dip oluşur; ortadaki (baş) en derindir. Boyun çizgisi yukarı kırıldığında ' +
      'güçlü bir yükseliş dönüşü beklenir.',
    timeframe: 'yaklaşık 2-5 ay içinde',
    psychology:
      'Panik dibi (baş) sonrası iki kez daha derin dip denemesi başarısız; trend gücü alıcıya geçmiş.'
  },
  ascendingTriangle: {
    name: 'Yükselen Üçgen',
    en: 'Ascending Triangle',
    type: 'süreklilik (boğa)',
    reliability: 'yüksek',
    description:
      'Yatay bir direncin altında yükselen dipler oluşur. Alıcı baskısı artar ve ' +
      'direnç yukarı kırıldığında sert yükseliş beklenir.',
    timeframe: 'yaklaşık 3-8 hafta içinde',
    psychology:
      'Sabit direnci her seferinde daha yüksekten alan alıcılar, direnci kırma noktasına gelmiş.'
  },
  cupAndHandle: {
    name: 'Fincan Kulpu',
    en: 'Cup and Handle',
    type: 'süreklilik (boğa)',
    reliability: 'yüksek',
    description:
      'Yuvarlak tabanlı bir düzeltme (fincan) sonrası kısa ve sığ bir çekilme (kulup) gelir; ' +
      'kulbun üstü kırılınca önceki zirveye ve ötesine hareket beklenir.',
    timeframe: 'yaklaşık 1-3 ay içinde',
    psychology:
      'Yavaş ve sağlıklı bir taban oluşumu; sonraki sığ çekilme zayıf elden çıkışın tükendiğini gösterir.'
  },
  bullFlag: {
    name: 'Boğa Bayrağı',
    en: 'Bull Flag',
    type: 'süreklilik (boğa)',
    reliability: 'yüksek',
    description:
      'Keskin bir yükseliş (direk) sonrası kısa, hafif eğimli ve dar bir dinlenme (bayrak) olur; ' +
      'bayrağın üstünden çıkınca trend genellikle benzer güçle sürer.',
    timeframe: 'yaklaşık 1-3 hafta içinde',
    psychology:
      'Güçlü hareket sonrası kâr satışları sınırlı kalmış; trendin devamı için dinlenme tamamlanmış.'
  },
  fallingWedge: {
    name: 'Düşen Kama',
    en: 'Falling Wedge',
    type: 'dönüş (boğa)',
    reliability: 'orta-yüksek',
    description:
      'Daralan ve aşağı eğimli iki trend kanalı içindeki hareket, üst kanal yukarı kırıldığında ' +
      'genellikle yükselişle sonuçlanır.',
    timeframe: 'yaklaşık 3-10 hafta içinde',
    psychology:
      'Satış baskısı giderek zayıflıyor (düşüş ivmesi azalıyor); denge alıcıya dönüyor.'
  },
  goldenCross: {
    name: 'Altın Kesişim',
    en: 'Golden Cross',
    type: 'trend (boğa)',
    reliability: 'orta',
    description:
      'Kısa vadeli 50 günlük ortalama, uzun vadeli 200 günlük ortalamanın yukarı keser; ' +
      'uzun vadeli boğa trendinin başlangıcı olarak kabul edilir.',
    timeframe: 'yaklaşık 1-3 ay içinde',
    psychology:
      'Kısa vadeli alım gücü, uzun vadeli ortalamayı geçerek trend dönüşünü istatistiksel olarak doğruluyor.'
  },
  roundingBottom: {
    name: 'Yuvarlak Dip',
    en: 'Rounding Bottom',
    type: 'dönüş (boğa)',
    reliability: 'orta',
    description:
      'U şeklinde yavaş bir taban oluşumu; satışların kademeli azalıp alımların kademeli ' +
      'artmasıyla dönüş uzun ve istikrarlı bir yükselişe dönüşür.',
    timeframe: 'yaklaşık 2-4 ay içinde',
    psychology:
      'Kademeli fikir değişimi: korku yavaş yavaş iyimserliğe dönüyor, trend kalıcı olma eğiliminde.'
  },

  /* ------------------------------------------------------------------ *
   *  DUSUS (ayis) formasyonlari
   * ------------------------------------------------------------------ */

  doubleTop: {
    name: 'Çift Zirve',
    en: 'Double Top',
    type: 'dönüş (düşüş)',
    reliability: 'yüksek',
    description:
      'Fiyat iki kez aynı bölgeden zirve yapar, aradaki destek (boyun çizgisi) ' +
      'aşağı kırıldığında yükseliş trendinin bittiği ve düşüşün başladığı kabul edilir.',
    timeframe: 'yaklaşık 2-4 ay içinde',
    psychology:
      'İki kez denenen alış baskısı aynı seviyeyi kıramamış; satıcılar bölgeyi kontrol ediyor.'
  },
  headShoulders: {
    name: 'Omuz-Baş-Omuz',
    en: 'Head & Shoulders',
    type: 'dönüş (düşüş)',
    reliability: 'çok yüksek',
    description:
      'Üç tepe oluşur; ortadaki (baş) en yüksektir. Boyun çizgisi aşağı kırıldığında ' +
      'güçlü bir düşüş dönüşü beklenir.',
    timeframe: 'yaklaşık 2-5 ay içinde',
    psychology:
      'Panik zirvesi (baş) sonrası iki kez daha yüksek tepe denemesi başarısız; trend gücü satıcıya geçmiş.'
  },
  descendingTriangle: {
    name: 'Düşen Üçgen',
    en: 'Descending Triangle',
    type: 'süreklilik (düşüş)',
    reliability: 'yüksek',
    description:
      'Yatay bir destek üzerinde düşen tepeler oluşur. Satıcı baskısı artar ve destek ' +
      'aşağı kırıldığında sert düşüş beklenir.',
    timeframe: 'yaklaşık 3-8 hafta içinde',
    psychology:
      'Sabit desteği her seferinde daha aşağıdan satan satıcılar, desteği kırma noktasına gelmiş.'
  },
  bearFlag: {
    name: 'Ayı Bayrağı',
    en: 'Bear Flag',
    type: 'süreklilik (düşüş)',
    reliability: 'yüksek',
    description:
      'Keskin bir düşüş (direk) sonrası kısa, hafif yukarı eğimli ve dar bir dinlenme (bayrak) olur; ' +
      'bayrağın altından çıkınca trend genellikle benzer güçle sürer.',
    timeframe: 'yaklaşık 1-3 hafta içinde',
    psychology:
      'Güçlü hareket sonrası kısa kâr alışı sınırlı kalmış; trendin devamı için dinlenme tamamlanmış.'
  },
  risingWedge: {
    name: 'Yükselen Kama',
    en: 'Rising Wedge',
    type: 'dönüş (düşüş)',
    reliability: 'orta-yüksek',
    description:
      'Daralan ve yukarı eğimli iki trend kanalı içindeki hareket, alt kanal aşağı kırıldığında ' +
      'genellikle düşüşle sonuçlanır.',
    timeframe: 'yaklaşık 3-10 hafta içinde',
    psychology:
      'Alış baskısı giderek zayıflıyor (yükseliş ivmesi azalıyor); denge satıcıya dönüyor.'
  },
  deathCross: {
    name: 'Ölüm Kesişimi',
    en: 'Death Cross',
    type: 'trend (düşüş)',
    reliability: 'orta',
    description:
      'Kısa vadeli 50 günlük ortalama, uzun vadeli 200 günlük ortalamanın altına düşer; ' +
      'uzun vadeli düşüş trendinin başlangıcı olarak kabul edilir.',
    timeframe: 'yaklaşık 1-3 ay içinde',
    psychology:
      'Kısa vadeli satış gücü, uzun vadeli ortalamayı geçerek trend dönüşünü istatistiksel olarak doğruluyor.'
  },
  roundingTop: {
    name: 'Yuvarlak Tepe',
    en: 'Rounding Top',
    type: 'dönüş (düşüş)',
    reliability: 'orta',
    description:
      'Ters U şeklinde yavaş bir tepe oluşumu; alışların kademeli azalıp satışların kademeli ' +
      'artmasıyla düşüşe dönüşür.',
    timeframe: 'yaklaşık 2-4 ay içinde',
    psychology:
      'Kademeli fikir değişimi: iyimserlik yavaş yavaş korkuya dönüyor, trend kalıcı olma eğiliminde.'
  }
};

/* ------------------------------------------------------------------ *
 *  Matematiksel yardimcilar
 * ------------------------------------------------------------------ */

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round(v, d) {
  if (v == null || !isFinite(v)) return 0;
  const f = Math.pow(10, d == null ? 1 : d);
  return Math.round(v * f) / f;
}

function pctChange(from, to) {
  if (!from || !isFinite(from) || !isFinite(to)) return 0;
  return ((to - from) / from) * 100;
}

function smaAt(values, n, endIndex) {
  if (endIndex + 1 < n || n <= 0) return null;
  let sum = 0;
  for (let i = endIndex - n + 1; i <= endIndex; i++) sum += values[i];
  return sum / n;
}

/** Wilder RSI (son period*3 barlik pencere uzerinde). */
function rsiAt(values, period, endIndex) {
  const p = period || 14;
  if (endIndex < p + 1) return null;
  const start = Math.max(1, endIndex - p * 3);
  const changes = [];
  for (let i = start; i <= endIndex; i++) changes.push(values[i] - values[i - 1]);
  if (changes.length < p) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < p; i++) {
    const diff = changes[i];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= p;
  avgLoss /= p;

  for (let i = p; i < changes.length; i++) {
    const diff = changes[i];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (p - 1) + g) / p;
    avgLoss = (avgLoss * (p - 1) + l) / p;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Yerel dip/zirve indeksleri (±w penceresinde kesin ekstremum). */
function findSwings(values, w) {
  const width = w || 5;
  const rawMins = [];
  const rawMaxs = [];
  for (let i = width; i < values.length - width; i++) {
    let isMin = true;
    let isMax = true;
    for (let j = i - width; j <= i + width; j++) {
      if (j === i) continue;
      if (values[j] < values[i]) isMin = false;
      if (values[j] > values[i]) isMax = false;
    }
    if (isMin) rawMins.push(i);
    if (isMax) rawMaxs.push(i);
  }
  // Ayni duz seviyedeki ardil ekstremumlari tek indekse indir.
  const merge = (idxs, mode) => {
    const out = [];
    for (const i of idxs) {
      const last = out[out.length - 1];
      if (last != null && i - last <= 3) {
        if (mode === 'min' ? values[i] < values[last] : values[i] > values[last]) {
          out[out.length - 1] = i;
        }
      } else {
        out.push(i);
      }
    }
    return out;
  };
  return { mins: merge(rawMins, 'min'), maxs: merge(rawMaxs, 'max') };
}

function linRegXY(pts) {
  const n = pts.length;
  if (n < 2) return { slope: 0, intercept: pts.length ? pts[0].y : 0, r2: 0 };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
    syy += p.y * p.y;
  }
  const den = n * sxx - sx * sx;
  const slope = den === 0 ? 0 : (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  const yMean = sy / n;
  let ssTot = 0;
  let ssRes = 0;
  for (const p of pts) {
    const yh = intercept + slope * p.x;
    ssTot += (p.y - yMean) * (p.y - yMean);
    ssRes += (p.y - yh) * (p.y - yh);
  }
  return { slope, intercept, r2: ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot) };
}

function linRegValues(values) {
  return linRegXY(values.map((y, x) => ({ x, y })));
}

/** 3x3 dogrusal denklem cozumu (quadratic fit icin). */
function solve3(m) {
  // m: [[a,b,c,d], ...]
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let r = i + 1; r < 3; r++) {
      if (Math.abs(m[r][i]) > Math.abs(m[pivot][i])) pivot = r;
    }
    if (Math.abs(m[pivot][i]) < 1e-12) return null;
    const tmp = m[i];
    m[i] = m[pivot];
    m[pivot] = tmp;
    const div = m[i][i];
    for (let c = i; c < 4; c++) m[i][c] /= div;
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = m[r][i];
      for (let c = i; c < 4; c++) m[r][c] -= f * m[i][c];
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
}

/** y = a*x^2 + b*x + c (x 0..1 normalize) + R^2. */
function quadFit(values) {
  const n = values.length;
  if (n < 6) return null;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let t0 = 0;
  let t1 = 0;
  let t2 = 0;
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : i / (n - 1);
    const x2 = x * x;
    const y = values[i];
    s0 += 1;
    s1 += x;
    s2 += x2;
    s3 += x2 * x;
    s4 += x2 * x2;
    t0 += y;
    t1 += x * y;
    t2 += x2 * y;
  }
  const sol = solve3([
    [s0, s1, s2, t0],
    [s1, s2, s3, t1],
    [s2, s3, s4, t2]
  ]);
  if (!sol) return null;
  // Normal denklemler bilinmeyen sirasi [c, b, a] ile kuruldu.
  const c = sol[0];
  const b = sol[1];
  const a = sol[2];
  const yMean = t0 / n;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const yh = a * x * x + b * x + c;
    ssTot += (values[i] - yMean) * (values[i] - yMean);
    ssRes += (values[i] - yh) * (values[i] - yh);
  }
  return { a, b, c, r2: ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot) };
}

/**
 * Direnc yukari kirildi mi? Kirilim son `within` bar icinde ve fiyat
 * asiri uzamamissa (maxExtend) kirilim indeksini dondurur; yoksa -1.
 */
function crossedAbove(values, level, within, maxExtend) {
  const n = values.length;
  if (n < 3 || !isFinite(level) || level <= 0) return -1;
  const ext = maxExtend == null ? 0.12 : maxExtend;
  if (values[n - 1] <= level * 1.002) return -1;
  if (values[n - 1] > level * (1 + ext)) return -1;
  const from = Math.max(1, n - 1 - (within || 8));
  for (let i = from; i < n; i++) {
    if (values[i - 1] <= level * 1.004 && values[i] > level * 1.005) return i;
  }
  return -1;
}

/** Destek asagi kirildi mi? */
function crossedBelow(values, level, within, maxExtend) {
  const n = values.length;
  if (n < 3 || !isFinite(level) || level <= 0) return -1;
  const ext = maxExtend == null ? 0.12 : maxExtend;
  if (values[n - 1] >= level * 0.998) return -1;
  if (values[n - 1] < level * (1 - ext)) return -1;
  const from = Math.max(1, n - 1 - (within || 8));
  for (let i = from; i < n; i++) {
    if (values[i - 1] >= level * 0.996 && values[i] < level * 0.995) return i;
  }
  return -1;
}

/** Formasyon oncesi dusus trendi var mi? */
function priorDownTrend(closes, idx, lookback, minPct) {
  const j = Math.max(0, idx - (lookback || 25));
  return pctChange(closes[j], closes[idx]) <= -(minPct || 4);
}

/** Formasyon oncesi yukselis trendi var mi? */
function priorUpTrend(closes, idx, lookback, minPct) {
  const j = Math.max(0, idx - (lookback || 25));
  return pctChange(closes[j], closes[idx]) >= (minPct || 4);
}

function minBetween(values, a, b) {
  let m = Infinity;
  for (let i = a; i <= b; i++) m = Math.min(m, values[i]);
  return m;
}

function maxBetween(values, a, b) {
  let m = -Infinity;
  for (let i = a; i <= b; i++) m = Math.max(m, values[i]);
  return m;
}

function avgVolume(points, from, to) {
  if (!points || !points.length) return null;
  let sum = 0;
  let count = 0;
  for (let i = Math.max(0, from); i <= Math.min(points.length - 1, to); i++) {
    const v = points[i] && points[i].v;
    if (v != null && isFinite(v)) {
      sum += v;
      count++;
    }
  }
  return count ? sum / count : null;
}

/* ------------------------------------------------------------------ *
 *  Gostergeler (AI ve guven skoru icin)
 * ------------------------------------------------------------------ */

function computeIndicators(points) {
  const closes = [];
  for (const p of points || []) {
    if (p && p.c != null && isFinite(p.c)) closes.push(p.c);
  }
  const n = closes.length;
  if (!n) return null;
  const last = closes[n - 1];
  const sma20 = n >= 20 ? smaAt(closes, 20, n - 1) : null;
  const sma50 = n >= 50 ? smaAt(closes, 50, n - 1) : null;
  const sma200 = n >= 200 ? smaAt(closes, 200, n - 1) : null;
  const rsi14 = rsiAt(closes, 14, n - 1);

  let atrPct = null;
  if (points && points.length >= 15 && points[points.length - 1].h != null) {
    let sum = 0;
    let cnt = 0;
    for (let i = Math.max(1, points.length - 14); i < points.length; i++) {
      const cur = points[i];
      const prev = points[i - 1];
      if (cur.h == null || cur.l == null || prev.c == null) continue;
      const tr = Math.max(
        cur.h - cur.l,
        Math.abs(cur.h - prev.c),
        Math.abs(cur.l - prev.c)
      );
      sum += tr;
      cnt++;
    }
    if (cnt) atrPct = (sum / cnt / last) * 100;
  }
  if (atrPct == null && n >= 15) {
    let sum = 0;
    for (let i = n - 14; i < n; i++) sum += Math.abs(closes[i] - closes[i - 1]);
    atrPct = (sum / 14 / last) * 100;
  }

  const high52 = Math.max.apply(null, closes);
  const low52 = Math.min.apply(null, closes);
  const range52 = high52 - low52;
  const pos52 = range52 > 0 ? ((last - low52) / range52) * 100 : 50;

  let trend = 'karışık';
  if (sma20 != null && sma50 != null && sma200 != null) {
    if (sma20 > sma50 && sma50 > sma200 && last > sma20) trend = 'güçlü yükseliş';
    else if (sma20 < sma50 && sma50 < sma200 && last < sma20) trend = 'güçlü düşüş';
    else if (sma20 > sma50 && last > sma50) trend = 'yükseliş eğilimi';
    else if (sma20 < sma50 && last < sma50) trend = 'düşüş eğilimi';
  } else if (sma20 != null && sma50 != null) {
    if (sma20 > sma50 && last > sma20) trend = 'yükseliş eğilimi';
    else if (sma20 < sma50 && last < sma20) trend = 'düşüş eğilimi';
  }

  const mom = (days) => {
    if (n <= days) return null;
    return round(pctChange(closes[n - 1 - days], last), 2);
  };

  return {
    last: round(last, 2),
    sma20: sma20 == null ? null : round(sma20, 2),
    sma50: sma50 == null ? null : round(sma50, 2),
    sma200: sma200 == null ? null : round(sma200, 2),
    rsi14: rsi14 == null ? null : round(rsi14, 1),
    atrPct: atrPct == null ? null : round(atrPct, 2),
    high52: round(high52, 2),
    low52: round(low52, 2),
    pos52: round(pos52, 0),
    trend,
    momentum5: mom(5),
    momentum20: mom(20),
    momentum60: mom(60),
    momentum120: mom(120),
    volAvg20: avgVolume(points, n - 20, n - 1)
  };
}

/* ------------------------------------------------------------------ *
 *  Boga (yukselis) formasyon tespitleri
 * ------------------------------------------------------------------ */

/** Cift Dip: iki yakin dip + boyun cizgisi kirilimi (oncesinde dusus). */
function detectDoubleBottom(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  const { mins } = findSwings(closes, 5);
  let best = null;

  for (let a = mins.length - 1; a >= 1; a--) {
    for (let b = a - 1; b >= 0; b--) {
      const i1 = mins[b];
      const i2 = mins[a];
      const gap = i2 - i1;
      if (gap < 12 || gap > 80) continue;
      if (i2 < n - 30) continue; // ikinci dip yakin zamanda olusmali

      const p1 = closes[i1];
      const p2 = closes[i2];
      const low = Math.min(p1, p2);
      if (Math.abs(p1 - p2) / low > 0.05) continue;

      // Ara bolgede dibin altina sarkan fiyat formasyonu bozar.
      let invalid = false;
      for (let k = i1; k <= i2; k++) {
        if (closes[k] < low * 0.985) {
          invalid = true;
          break;
        }
      }
      if (invalid) continue;

      const neck = maxBetween(closes, i1, i2);
      const depth = (neck - low) / neck;
      if (depth < 0.05) continue;
      if (!priorDownTrend(closes, i1, 25, 4)) continue;

      const bx = crossedAbove(closes, neck, 10, 0.12);
      if (bx < 0) continue;
      const last = closes[n - 1];
      const target = neck + (neck - low);
      const upside = pctChange(last, target);
      if (upside < 1.5) continue;

      const symmetry = 1 - Math.abs(p1 - p2) / low / 0.05;
      const freshness = Math.max(0, 10 - (n - 1 - bx));
      const conf = clamp(
        55 + depth * 100 + symmetry * 10 + freshness * 0.9,
        55,
        92
      );
      const cand = {
        key: 'doubleBottom',
        confidence: Math.round(conf),
        upsidePct: round(upside, 1),
        detail:
          'İki dip birbirine %' +
          Math.abs(pctChange(p1, p2)).toFixed(1) +
          ' yakınlıkta oluştu; boyun çizgisi (' +
          round(neck, 2) +
          ') yukarı kırıldı ve kırılım ' +
          (n - 1 - bx) +
          ' gün önce gerçekleşti.'
      };
      if (!best || cand.confidence > best.confidence) best = cand;
    }
  }
  return best;
}

/** Ters Omuz-Bas-Omuz: uc dip, orta en derin, boyun kirilimi. */
function detectInverseHeadShoulders(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  const { mins } = findSwings(closes, 5);
  let best = null;

  for (let i = mins.length - 1; i >= 2; i--) {
    const iL = mins[i - 2];
    const iH = mins[i - 1];
    const iR = mins[i];
    if (iR < n - 30) continue;
    const pL = closes[iL];
    const pH = closes[iH];
    const pR = closes[iR];
    if (pH >= pL * 0.975 || pH >= pR * 0.975) continue;
    if (Math.abs(pL - pR) / Math.min(pL, pR) > 0.08) continue;

    const peak1 = maxBetween(closes, iL, iH);
    const peak2 = maxBetween(closes, iH, iR);
    if (Math.abs(peak1 - peak2) / Math.max(peak1, peak2) > 0.06) continue;
    const neck = (peak1 + peak2) / 2;
    if (!priorDownTrend(closes, iL, 25, 4)) continue;

    // Bas dibi kirilirsa formasyon gecersizdir.
    let invalid = false;
    for (let k = iH; k <= iR; k++) {
      if (closes[k] < pH * 0.985) {
        invalid = true;
        break;
      }
    }
    if (invalid) continue;

    const bx = crossedAbove(closes, neck, 12, 0.12);
    if (bx < 0) continue;
    const last = closes[n - 1];
    const target = neck + (neck - pH);
    const upside = pctChange(last, target);
    if (upside < 2) continue;

    const symmetry = 1 - Math.abs(pL - pR) / Math.min(pL, pR) / 0.08;
    const depth = (neck - pH) / neck;
    const conf = clamp(60 + depth * 120 + symmetry * 8 + Math.max(0, 12 - (n - 1 - bx)) * 0.6, 60, 95);
    const cand = {
      key: 'inverseHeadShoulders',
      confidence: Math.round(conf),
      upsidePct: round(upside, 1),
      detail:
        'Baş dibi (' +
        round(pH, 2) +
        ') omuzlardan belirgin derin; boyun çizgisi (' +
        round(neck, 2) +
        ') yukarı kırıldı.'
    };
    if (!best || cand.confidence > best.confidence) best = cand;
  }
  return best;
}

/** Yukselen Ucgen: yatay direnc altinda yukselen dipler + kirilim. */
function detectAscendingTriangle(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  const lookback = Math.min(70, n - 10);
  if (lookback < 30) return null;
  const seg = closes.slice(n - lookback);
  const { maxs, mins } = findSwings(seg, 3);
  if (maxs.length < 2 || mins.length < 2) return null;

  const highs = maxs.slice(-3).map((i) => seg[i]);
  const tMax = Math.max.apply(null, highs);
  const tMin = Math.min.apply(null, highs);
  if ((tMax - tMin) / tMin > 0.04) return null;

  const lows = mins.filter((i) => i > maxs[0]).map((i) => seg[i]).slice(-4);
  if (lows.length < 2) return null;
  if (lows[lows.length - 1] <= lows[0] * 1.02) return null;
  if (linRegValues(lows).slope <= 0) return null;

  const resistance = tMax;
  const height = resistance - Math.min.apply(null, lows);
  if (height <= 0) return null;

  const bx = crossedAbove(seg, resistance, 8, 0.1);
  if (bx < 0) return null;
  const last = closes[n - 1];
  const target = resistance + height * 0.8;
  const upside = pctChange(last, target);
  if (upside < 1.5) return null;

  const tightness = 1 - (tMax - tMin) / tMin / 0.04;
  const conf = clamp(62 + tightness * 10 + Math.max(0, 8 - (seg.length - 1 - bx)) * 1.2, 60, 90);
  return {
    key: 'ascendingTriangle',
    confidence: Math.round(conf),
    upsidePct: round(upside, 1),
    detail:
      'Yatay direnç (' +
      round(resistance, 2) +
      ') altında dipler yükseldi ve direnç yukarı kırıldı.'
  };
}

/** Fincan Kulpu: yuvarlak taban + sig kulup + kulup ustunden cikis. */
function detectCupAndHandle(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  if (n < 55) return null;
  let best = null;

  // Kirilim son 8 bar icinde olabilir; fincan+kulup kirilimdan hemen once biter.
  for (let bx = n - 1; bx >= Math.max(1, n - 8); bx--) {
    const daysSince = n - 1 - bx;
    for (const handleLen of [5, 6, 8, 10, 12, 15]) {
      const cupEnd = bx - handleLen;
      if (cupEnd < 35) continue;
      const cupLen = Math.min(110, cupEnd);
      const cup = closes.slice(cupEnd - cupLen, cupEnd);
      const cm = cup.length;
      if (cm < 35) continue;

      const leftRim = maxBetween(cup, 0, Math.min(8, cm - 1));
      const rightRim = maxBetween(cup, Math.max(0, cm - 9), cm - 1);
      const rim = Math.max(leftRim, rightRim);
      if (Math.abs(leftRim - rightRim) / rim > 0.06) continue;

      let trough = Infinity;
      let troughIdx = -1;
      for (let k = Math.floor(cm * 0.25); k <= Math.floor(cm * 0.75); k++) {
        if (cup[k] < trough) {
          trough = cup[k];
          troughIdx = k;
        }
      }
      if (troughIdx < 0) continue;
      const depth = (rim - trough) / rim;
      if (depth < 0.08 || depth > 0.4) continue;

      const q = quadFit(cup);
      if (!q || q.a <= 0 || q.r2 < 0.45) continue;

      const handle = closes.slice(cupEnd, bx);
      const handleLow = Math.min.apply(null, handle);
      const handleDepth = (rightRim - handleLow) / rightRim;
      if (handleLow < trough * 1.01) continue;
      if (handleDepth > depth * 0.6) continue;
      if (linRegValues(handle).slope > rightRim * 0.001) continue;

      // Kirilim bari: onceki bar direncin altinda, kirilim bari ustunde.
      if (closes[bx] <= rightRim * 1.002) continue;
      if (closes[bx - 1] > rightRim * 1.005) continue;
      const last = closes[n - 1];
      if (last > rightRim * 1.1) continue;

      const target = rightRim + (rightRim - trough) * 0.65;
      const upside = pctChange(last, target);
      if (upside < 1.5) continue;

      const conf = clamp(
        58 + q.r2 * 16 + depth * 50 - daysSince * 1.2,
        55,
        90
      );
      const cand = {
        key: 'cupAndHandle',
        confidence: Math.round(conf),
        upsidePct: round(upside, 1),
        detail:
          'Fincan tabanı %' +
          (depth * 100).toFixed(0) +
          ' derinlikte; sığ kulup tamamlandı ve kulüp üstü (' +
          round(rightRim, 2) +
          ') yukarı kırıldı.'
      };
      if (!best || cand.confidence > best.confidence) best = cand;
    }
  }
  return best;
}

/** Boga Bayragi: keskin direk + direk boyuna gore dar dinlenme + ust kirilim. */
function detectBullFlag(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  if (n < 25) return null;
  let best = null;

  // Kirilim son 5 bar icinde olabilir; bayrak kirilimdan hemen once biter.
  for (let bx = n - 1; bx >= Math.max(1, n - 5); bx--) {
    const daysSince = n - 1 - bx;
    for (const flagLen of [5, 6, 8, 10, 12, 15]) {
      const flagStart = bx - flagLen;
      if (flagStart < 12) continue;
      const flag = closes.slice(flagStart, bx);
      const flagHigh = Math.max.apply(null, flag);
      const flagLow = Math.min.apply(null, flag);
      if (closes[bx] <= flagHigh * 1.002) continue;
      if (closes[bx - 1] > flagHigh * 1.005) continue;

      for (const poleLen of [5, 6, 7, 8, 9, 10]) {
        const poleStart = flagStart - poleLen;
        if (poleStart < 0) continue;
        const pole = closes.slice(poleStart, flagStart);
        const poleGain = pctChange(pole[0], pole[pole.length - 1]);
        if (poleGain < 7) continue;

        const poleHigh = Math.max.apply(null, pole);
        const poleLow = Math.min.apply(null, pole);
        const poleHeight = poleHigh - poleLow;
        if (poleHeight <= 0) continue;
        if (pole[pole.length - 1] < poleHigh * 0.97) continue;

        if (flagHigh > poleHigh * 1.01) continue;
        const retrace = (poleHigh - flagLow) / poleHeight;
        if (retrace < 0.12 || retrace > 0.55) continue;

        const slopeRel = linRegValues(flag).slope / closes[n - 1];
        if (slopeRel > 0.0008 || slopeRel < -0.008) continue;

        const last = closes[n - 1];
        if (last > flagHigh * 1.08) continue;
        const target = last + poleHeight;
        const upside = pctChange(last, target);
        if (upside < 1.5) continue;

        const conf = clamp(
          60 + poleGain * 0.9 + (1 - retrace) * 14 - daysSince * 1.2,
          55,
          90
        );
        const cand = {
          key: 'bullFlag',
          confidence: Math.round(conf),
          upsidePct: round(upside, 1),
          detail:
            '%' +
            poleGain.toFixed(0) +
            ' güçlü direk sonrası direk boyunun %' +
            (retrace * 100).toFixed(0) +
            ' kadar geri çekilme (bayrak) ve bayrak üstü kırılımı oluştu.'
        };
        if (!best || cand.confidence > best.confidence) best = cand;
      }
    }
  }
  return best;
}

/** Dusen Kama: daralan, asagi egimli kanal + ust bant kirilimi. */
function detectFallingWedge(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  if (n < 30) return null;
  let best = null;

  for (let bx = n - 1; bx >= Math.max(1, n - 6); bx--) {
    const daysSince = n - 1 - bx;
    const lookback = Math.min(65, bx - 2);
    if (lookback < 25) continue;
    const seg = closes.slice(bx - lookback, bx);
    const m = seg.length;
    const { maxs, mins } = findSwings(seg, 3);
    if (maxs.length < 2 || mins.length < 2) continue;

    const hi = linRegXY(maxs.map((i) => ({ x: i, y: seg[i] })));
    const lo = linRegXY(mins.map((i) => ({ x: i, y: seg[i] })));
    if (hi.slope >= 0 || lo.slope >= 0) continue;
    if (Math.abs(hi.slope) < Math.abs(lo.slope) * 1.05) continue;
    if (hi.r2 < 0.25 || lo.r2 < 0.25) continue;

    const upperAt = (x) => hi.intercept + hi.slope * x;
    const lowerAt = (x) => lo.intercept + lo.slope * x;
    if (upperAt(m - 1) <= lowerAt(m - 1)) continue;

    if (closes[bx] <= upperAt(m) * 1.002) continue;
    if (closes[bx - 1] > upperAt(m - 1) * 1.004) continue;
    const last = closes[n - 1];
    if (last > upperAt(m) * 1.1) continue;

    const height = upperAt(m) - lowerAt(m);
    const target = last + height * 0.9;
    const upside = pctChange(last, target);
    if (upside < 1.5) continue;

    const conf = clamp(
      58 + Math.min(hi.r2, lo.r2) * 18 - daysSince * 1.1,
      55,
      88
    );
    const cand = {
      key: 'fallingWedge',
      confidence: Math.round(conf),
      upsidePct: round(upside, 1),
      detail:
        'Aşağı eğimli ve daralan kamada üst bant (' +
        round(upperAt(m), 2) +
        ') yukarı kırıldı; satış baskısı tükeniyor.'
    };
    if (!best || cand.confidence > best.confidence) best = cand;
  }
  return best;
}

/** Altin Kesisim: SMA50'nin SMA200'u son 10 barda yukari kesmesi. */
function detectGoldenCross(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  if (n < 210) return null;
  const s50 = smaAt(closes, 50, n - 1);
  const s200 = smaAt(closes, 200, n - 1);
  const s50Prev = smaAt(closes, 50, n - 11);
  const s200Prev = smaAt(closes, 200, n - 11);
  if (s50 == null || s200 == null || s50Prev == null || s200Prev == null) return null;
  if (!(s50 > s200 && s50Prev <= s200Prev)) return null;
  const s50Earlier = smaAt(closes, 50, n - 16);
  if (s50Earlier != null && s50 <= s50Earlier) return null;

  const last = closes[n - 1];
  const high60 = maxBetween(closes, n - 60, n - 1);
  const target = Math.max(high60, s200 * 1.08, last * 1.04);
  const upside = pctChange(last, target);
  return {
    key: 'goldenCross',
    confidence: 62,
    upsidePct: round(Math.max(2, upside), 1),
    detail:
      '50 günlük ortalama (' +
      round(s50, 2) +
      '), 200 günlük ortalamayı (' +
      round(s200, 2) +
      ') son 10 işlem günü içinde yukarı kesti.'
  };
}

/** Yuvarlak Dip: orta bolgede taban + yukselen ivme + rim kirilimi. */
function detectRoundingBottom(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  if (n < 45) return null;
  let best = null;

  for (let bx = n - 1; bx >= Math.max(1, n - 10); bx--) {
    const daysSince = n - 1 - bx;
    const lookback = Math.min(95, bx - 2);
    if (lookback < 40) continue;
    const seg = closes.slice(bx - lookback, bx);
    const m = seg.length;

    let trough = Infinity;
    let troughIdx = -1;
    for (let k = 5; k < m - 5; k++) {
      if (seg[k] < trough) {
        trough = seg[k];
        troughIdx = k;
      }
    }
    if (troughIdx < m * 0.3 || troughIdx > m * 0.7) continue;

    const leftRim = seg[0];
    const rightRim = seg[m - 1];
    const rim = Math.max(leftRim, rightRim);
    if (Math.abs(leftRim - rightRim) / rim > 0.06) continue;
    const depth = (rim - trough) / rim;
    if (depth < 0.08) continue;

    const q = quadFit(seg);
    if (!q || q.a <= 0 || q.r2 < 0.45) continue;
    if (linRegValues(seg.slice(Math.floor(m * 0.75))).slope <= 0) continue;

    if (closes[bx] <= rim * 1.002) continue;
    if (closes[bx - 1] > rim * 1.005) continue;
    const last = closes[n - 1];
    if (last > rim * 1.1) continue;

    const target = rim + (rim - trough) * 0.5;
    const upside = pctChange(last, target);
    if (upside < 1.5) continue;

    const conf = clamp(
      56 + q.r2 * 20 + depth * 45 - daysSince * 1.1,
      55,
      88
    );
    const cand = {
      key: 'roundingBottom',
      confidence: Math.round(conf),
      upsidePct: round(upside, 1),
      detail:
        'U şeklinde %' +
        (depth * 100).toFixed(0) +
        ' derinlikte yuvarlak dip oluştu; fiyat rim seviyesini (' +
        round(rim, 2) +
        ') yukarı kırdı.'
    };
    if (!best || cand.confidence > best.confidence) best = cand;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 *  Ayis (dusus) formasyon tespitleri
 * ------------------------------------------------------------------ */

/** Cift Zirve: iki yakin zirve + boyun cizgisi asagi kirilimi. */
function detectDoubleTop(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  const { maxs } = findSwings(closes, 5);
  let best = null;

  for (let a = maxs.length - 1; a >= 1; a--) {
    for (let b = a - 1; b >= 0; b--) {
      const i1 = maxs[b];
      const i2 = maxs[a];
      const gap = i2 - i1;
      if (gap < 12 || gap > 80) continue;
      if (i2 < n - 30) continue;

      const p1 = closes[i1];
      const p2 = closes[i2];
      const high = Math.max(p1, p2);
      if (Math.abs(p1 - p2) / high > 0.05) continue;

      let invalid = false;
      for (let k = i1; k <= i2; k++) {
        if (closes[k] > high * 1.015) {
          invalid = true;
          break;
        }
      }
      if (invalid) continue;

      const neck = minBetween(closes, i1, i2);
      const depth = (high - neck) / high;
      if (depth < 0.05) continue;
      if (!priorUpTrend(closes, i1, 25, 4)) continue;

      const bx = crossedBelow(closes, neck, 10, 0.12);
      if (bx < 0) continue;
      const last = closes[n - 1];
      const target = neck - (high - neck);
      const downside = pctChange(last, target) * -1;
      if (downside < 1.5) continue;

      const symmetry = 1 - Math.abs(p1 - p2) / high / 0.05;
      const conf = clamp(55 + depth * 100 + symmetry * 10 + Math.max(0, 10 - (n - 1 - bx)) * 0.9, 55, 92);
      const cand = {
        key: 'doubleTop',
        confidence: Math.round(conf),
        downsidePct: round(downside, 1),
        detail:
          'İki zirve birbirine %' +
          Math.abs(pctChange(p1, p2)).toFixed(1) +
          ' yakınlıkta oluştu; boyun çizgisi (' +
          round(neck, 2) +
          ') aşağı kırıldı.'
      };
      if (!best || cand.confidence > best.confidence) best = cand;
    }
  }
  return best;
}

/** Omuz-Bas-Omuz: uc tepe, orta en yuksek, boyun kirilimi asagi. */
function detectHeadShoulders(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  const { maxs } = findSwings(closes, 5);
  let best = null;

  for (let i = maxs.length - 1; i >= 2; i--) {
    const iL = maxs[i - 2];
    const iH = maxs[i - 1];
    const iR = maxs[i];
    if (iR < n - 30) continue;
    const pL = closes[iL];
    const pH = closes[iH];
    const pR = closes[iR];
    if (pH <= pL * 1.025 || pH <= pR * 1.025) continue;
    if (Math.abs(pL - pR) / Math.min(pL, pR) > 0.08) continue;

    const trough1 = minBetween(closes, iL, iH);
    const trough2 = minBetween(closes, iH, iR);
    if (Math.abs(trough1 - trough2) / Math.max(trough1, trough2) > 0.06) continue;
    const neck = (trough1 + trough2) / 2;
    if (!priorUpTrend(closes, iL, 25, 4)) continue;

    let invalid = false;
    for (let k = iH; k <= iR; k++) {
      if (closes[k] > pH * 1.015) {
        invalid = true;
        break;
      }
    }
    if (invalid) continue;

    const bx = crossedBelow(closes, neck, 12, 0.12);
    if (bx < 0) continue;
    const last = closes[n - 1];
    const target = neck - (pH - neck);
    const downside = pctChange(last, target) * -1;
    if (downside < 2) continue;

    const symmetry = 1 - Math.abs(pL - pR) / Math.min(pL, pR) / 0.08;
    const depth = (pH - neck) / neck;
    const conf = clamp(60 + depth * 120 + symmetry * 8 + Math.max(0, 12 - (n - 1 - bx)) * 0.6, 60, 95);
    const cand = {
      key: 'headShoulders',
      confidence: Math.round(conf),
      downsidePct: round(downside, 1),
      detail:
        'Baş zirvesi (' +
        round(pH, 2) +
        ') omuzlardan belirgin yüksek; boyun çizgisi (' +
        round(neck, 2) +
        ') aşağı kırıldı.'
    };
    if (!best || cand.confidence > best.confidence) best = cand;
  }
  return best;
}

/** Dusen Ucgen: yatay destek uzerinde dusen tepeler + destek kirilimi asagi. */
function detectDescendingTriangle(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  const lookback = Math.min(70, n - 10);
  if (lookback < 30) return null;
  const seg = closes.slice(n - lookback);
  const { maxs, mins } = findSwings(seg, 3);
  if (maxs.length < 2 || mins.length < 2) return null;

  const bottoms = mins.slice(-3).map((i) => seg[i]);
  const bMax = Math.max.apply(null, bottoms);
  const bMin = Math.min.apply(null, bottoms);
  if ((bMax - bMin) / bMin > 0.04) return null;

  const highs = maxs.filter((i) => i > mins[0]).map((i) => seg[i]).slice(-4);
  if (highs.length < 2) return null;
  if (highs[highs.length - 1] >= highs[0] * 0.98) return null;
  if (linRegValues(highs).slope >= 0) return null;

  const support = bMin;
  const height = Math.max.apply(null, highs) - support;
  if (height <= 0) return null;

  const bx = crossedBelow(seg, support, 8, 0.1);
  if (bx < 0) return null;
  const last = closes[n - 1];
  const target = support - height * 0.8;
  const downside = pctChange(last, target) * -1;
  if (downside < 1.5) return null;

  const tightness = 1 - (bMax - bMin) / bMin / 0.04;
  const conf = clamp(62 + tightness * 10 + Math.max(0, 8 - (seg.length - 1 - bx)) * 1.2, 60, 90);
  return {
    key: 'descendingTriangle',
    confidence: Math.round(conf),
    downsidePct: round(downside, 1),
    detail:
      'Yatay destek (' +
      round(support, 2) +
      ') üzerinde tepeler aşağı eğildi ve destek aşağı kırıldı.'
  };
}

/** Ayi Bayragi: keskin dusus diregi + direk boyuna gore dar dinlenme + alt kirilim. */
function detectBearFlag(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  if (n < 25) return null;
  let best = null;

  for (let bx = n - 1; bx >= Math.max(1, n - 5); bx--) {
    const daysSince = n - 1 - bx;
    for (const flagLen of [5, 6, 8, 10, 12, 15]) {
      const flagStart = bx - flagLen;
      if (flagStart < 12) continue;
      const flag = closes.slice(flagStart, bx);
      const flagHigh = Math.max.apply(null, flag);
      const flagLow = Math.min.apply(null, flag);
      if (closes[bx] >= flagLow * 0.998) continue;
      if (closes[bx - 1] < flagLow * 0.995) continue;

      for (const poleLen of [5, 6, 7, 8, 9, 10]) {
        const poleStart = flagStart - poleLen;
        if (poleStart < 0) continue;
        const pole = closes.slice(poleStart, flagStart);
        const poleLoss = pctChange(pole[0], pole[pole.length - 1]) * -1;
        if (poleLoss < 7) continue;

        const poleHigh = Math.max.apply(null, pole);
        const poleLow = Math.min.apply(null, pole);
        const poleHeight = poleHigh - poleLow;
        if (poleHeight <= 0) continue;
        if (pole[pole.length - 1] > poleLow * 1.03) continue;

        if (flagLow < poleLow * 0.99) continue;
        const retrace = (flagHigh - poleLow) / poleHeight;
        if (retrace < 0.12 || retrace > 0.55) continue;

        const slopeRel = linRegValues(flag).slope / closes[n - 1];
        if (slopeRel < -0.0008 || slopeRel > 0.008) continue;

        const last = closes[n - 1];
        if (last < flagLow * 0.92) continue;
        const target = last - poleHeight;
        const downside = pctChange(last, target) * -1;
        if (downside < 1.5) continue;

        const conf = clamp(
          60 + poleLoss * 0.9 + (1 - retrace) * 14 - daysSince * 1.2,
          55,
          90
        );
        const cand = {
          key: 'bearFlag',
          confidence: Math.round(conf),
          downsidePct: round(downside, 1),
          detail:
            '%' +
            poleLoss.toFixed(0) +
            ' güçlü düşüş sonrası direk boyunun %' +
            (retrace * 100).toFixed(0) +
            ' kadar tepki (bayrak) ve bayrak altı kırılımı oluştu.'
        };
        if (!best || cand.confidence > best.confidence) best = cand;
      }
    }
  }
  return best;
}

/** Yukselen Kama: daralan, yukari egimli kanal + alt bant kirilimi asagi. */
function detectRisingWedge(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  if (n < 30) return null;
  let best = null;

  for (let bx = n - 1; bx >= Math.max(1, n - 6); bx--) {
    const daysSince = n - 1 - bx;
    const lookback = Math.min(65, bx - 2);
    if (lookback < 25) continue;
    const seg = closes.slice(bx - lookback, bx);
    const m = seg.length;
    const { maxs, mins } = findSwings(seg, 3);
    if (maxs.length < 2 || mins.length < 2) continue;

    const hi = linRegXY(maxs.map((i) => ({ x: i, y: seg[i] })));
    const lo = linRegXY(mins.map((i) => ({ x: i, y: seg[i] })));
    if (hi.slope <= 0 || lo.slope <= 0) continue;
    if (Math.abs(lo.slope) < Math.abs(hi.slope) * 1.05) continue;
    if (hi.r2 < 0.25 || lo.r2 < 0.25) continue;

    const upperAt = (x) => hi.intercept + hi.slope * x;
    const lowerAt = (x) => lo.intercept + lo.slope * x;
    if (upperAt(m - 1) <= lowerAt(m - 1)) continue;

    if (closes[bx] >= lowerAt(m) * 0.998) continue;
    if (closes[bx - 1] < lowerAt(m - 1) * 0.996) continue;
    const last = closes[n - 1];
    if (last < lowerAt(m) * 0.9) continue;

    const height = upperAt(m) - lowerAt(m);
    const target = last - height * 0.9;
    const downside = pctChange(last, target) * -1;
    if (downside < 1.5) continue;

    const conf = clamp(
      58 + Math.min(hi.r2, lo.r2) * 18 - daysSince * 1.1,
      55,
      88
    );
    const cand = {
      key: 'risingWedge',
      confidence: Math.round(conf),
      downsidePct: round(downside, 1),
      detail:
        'Yukarı eğimli ve daralan kamada alt bant (' +
        round(lowerAt(m), 2) +
        ') aşağı kırıldı; alış baskısı tükeniyor.'
    };
    if (!best || cand.confidence > best.confidence) best = cand;
  }
  return best;
}

/** Olum Kesisimi: SMA50'nin SMA200'un altina son 10 barda dusmesi. */
function detectDeathCross(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  if (n < 210) return null;
  const s50 = smaAt(closes, 50, n - 1);
  const s200 = smaAt(closes, 200, n - 1);
  const s50Prev = smaAt(closes, 50, n - 11);
  const s200Prev = smaAt(closes, 200, n - 11);
  if (s50 == null || s200 == null || s50Prev == null || s200Prev == null) return null;
  if (!(s50 < s200 && s50Prev >= s200Prev)) return null;
  const s50Earlier = smaAt(closes, 50, n - 16);
  if (s50Earlier != null && s50 >= s50Earlier) return null;

  const last = closes[n - 1];
  const low60 = minBetween(closes, n - 60, n - 1);
  const target = Math.min(low60, s200 * 0.92, last * 0.96);
  const downside = pctChange(last, target) * -1;
  return {
    key: 'deathCross',
    confidence: 62,
    downsidePct: round(Math.max(2, downside), 1),
    detail:
      '50 günlük ortalama (' +
      round(s50, 2) +
      '), 200 günlük ortalamanın (' +
      round(s200, 2) +
      ') altına son 10 işlem günü içinde düştü.'
  };
}

/** Yuvarlak Tepe: orta bolgede tepe + azalan ivme + destek kirilimi. */
function detectRoundingTop(ctx) {
  const closes = ctx.closes;
  const n = closes.length;
  if (n < 45) return null;
  let best = null;

  for (let bx = n - 1; bx >= Math.max(1, n - 10); bx--) {
    const daysSince = n - 1 - bx;
    const lookback = Math.min(95, bx - 2);
    if (lookback < 40) continue;
    const seg = closes.slice(bx - lookback, bx);
    const m = seg.length;

    let peak = -Infinity;
    let peakIdx = -1;
    for (let k = 5; k < m - 5; k++) {
      if (seg[k] > peak) {
        peak = seg[k];
        peakIdx = k;
      }
    }
    if (peakIdx < m * 0.3 || peakIdx > m * 0.7) continue;

    const leftRim = seg[0];
    const rightRim = seg[m - 1];
    const rim = Math.min(leftRim, rightRim);
    if (Math.abs(leftRim - rightRim) / Math.max(leftRim, rightRim) > 0.06) continue;
    const depth = (peak - rim) / peak;
    if (depth < 0.08) continue;

    const q = quadFit(seg);
    if (!q || q.a >= 0 || q.r2 < 0.45) continue;
    if (linRegValues(seg.slice(Math.floor(m * 0.75))).slope >= 0) continue;

    if (closes[bx] >= rim * 0.998) continue;
    if (closes[bx - 1] < rim * 0.995) continue;
    const last = closes[n - 1];
    if (last < rim * 0.9) continue;

    const target = rim - (peak - rim) * 0.5;
    const downside = pctChange(last, target) * -1;
    if (downside < 1.5) continue;

    const conf = clamp(
      56 + q.r2 * 20 + depth * 45 - daysSince * 1.1,
      55,
      88
    );
    const cand = {
      key: 'roundingTop',
      confidence: Math.round(conf),
      downsidePct: round(downside, 1),
      detail:
        'Ters U şeklinde %' +
        (depth * 100).toFixed(0) +
        ' derinlikte yuvarlak tepe oluştu; destek (' +
        round(rim, 2) +
        ') aşağı kırıldı.'
    };
    if (!best || cand.confidence > best.confidence) best = cand;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 *  Tarayici
 * ------------------------------------------------------------------ */

const DETECTORS = [
  detectDoubleBottom,
  detectInverseHeadShoulders,
  detectAscendingTriangle,
  detectCupAndHandle,
  detectBullFlag,
  detectFallingWedge,
  detectGoldenCross,
  detectRoundingBottom
];

const DETECTORS_BEARISH = [
  detectDoubleTop,
  detectHeadShoulders,
  detectDescendingTriangle,
  detectBearFlag,
  detectRisingWedge,
  detectDeathCross,
  detectRoundingTop
];

/** Her formasyonun literaturdeki tipik tamamlanma suresi (min-maks hafta). */
const TIMEFRAME_WEEKS = {
  doubleBottom: [8, 17],
  inverseHeadShoulders: [9, 22],
  ascendingTriangle: [3, 8],
  cupAndHandle: [4, 13],
  bullFlag: [1, 3],
  fallingWedge: [3, 10],
  goldenCross: [4, 13],
  roundingBottom: [8, 17],

  /* Dusus formasyonlari */
  doubleTop: [8, 17],
  headShoulders: [9, 22],
  descendingTriangle: [3, 8],
  bearFlag: [1, 3],
  risingWedge: [3, 10],
  deathCross: [4, 13],
  roundingTop: [8, 17]
};

/**
 * Somut tahmini zaman araligi uretir.
 * Ornek: "2-4 ay icinde (~ Nisan 2027 - Haziran 2027)"
 */
function etaLabel(patternKey, now) {
  const w = TIMEFRAME_WEEKS[patternKey];
  if (!w) return '';
  const fmt = (d) =>
    d.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });
  const from = new Date(now + w[0] * 7 * 24 * 3600 * 1000);
  const to = new Date(now + w[1] * 7 * 24 * 3600 * 1000);
  const human =
    w[1] <= 6
      ? w[0] + '-' + w[1] + ' hafta içinde'
      : Math.max(1, Math.round(w[0] / 4)) + '-' + Math.max(2, Math.round(w[1] / 4)) + ' ay içinde';
  return human + ' (~ ' + fmt(from) + ' - ' + fmt(to) + ')';
}

function closesFromPoints(points) {
  const closes = [];
  for (const p of points || []) {
    if (p && p.c != null && isFinite(p.c)) closes.push(p.c);
  }
  return closes;
}

/**
 * Bir kapanis serisindeki tum boga formasyonlarini tarar.
 * @param {{t:number,c:number,v?:number}[]} points
 */
function scanBullishPatterns(points) {
  const closes = closesFromPoints(points);
  if (closes.length < 60) return [];
  const ctx = { closes, points: points || [] };
  const found = [];
  for (const fn of DETECTORS) {
    try {
      const r = fn(ctx);
      if (r) found.push(r);
    } catch (_) {
      /* tek formasyon hatasi tum taramayi bozmasin */
    }
  }
  return found.sort((a, b) => b.confidence - a.confidence);
}

/** Bir kapanis serisindeki tum dusus formasyonlarini tarar. */
function scanBearishPatterns(points) {
  const closes = closesFromPoints(points);
  if (closes.length < 60) return [];
  const ctx = { closes, points: points || [] };
  const found = [];
  for (const fn of DETECTORS_BEARISH) {
    try {
      const r = fn(ctx);
      if (r) found.push(r);
    } catch (_) {
      /* tek formasyon hatasi tum taramayi bozmasin */
    }
  }
  return found.sort((a, b) => b.confidence - a.confidence);
}

module.exports = {
  PATTERN_LIBRARY,
  scanBullishPatterns,
  scanBearishPatterns,
  etaLabel,
  computeIndicators
};
