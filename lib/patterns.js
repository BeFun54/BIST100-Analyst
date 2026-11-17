'use strict';

/**
 * Klasik grafik formasyonlari bilgi tabani + tespit motoru.
 *
 * Bu modul, formasyon tanimlarini "hafiza" olarak tutar; her calistirmada
 * internetten formasyon bilgisi cekilmez. Tanimlar klasik teknik analiz
 * literaturunden (Edwards & Magee, Bulkowski) derlenmistir.
 *
 * Sadece YUKSELIS (boga) sinyali veren formasyonlar tespit edilir.
 * Girdi: gunluk kapanis serisi [{t, c}] (kronolojik sirali).
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
      'Sabit direnci her seferinde daha yüksektenden alan alıcılar, direnci kırma noktasına gelmiş.'
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
    name: 'Ayak Bayrağı',
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
 *  Yardimcilar
 * ------------------------------------------------------------------ */

function smaAt(values, n, endIndex) {
  if (endIndex + 1 < n) return null;
  let sum = 0;
  for (let i = endIndex - n + 1; i <= endIndex; i++) sum += values[i];
  return sum / n;
}

/** Yerel dip/zirve indeksleri (±w penceresinde ekstremum). */
function findSwings(values, w = 5) {
  const mins = [];
  const maxs = [];
  for (let i = w; i < values.length - w; i++) {
    let isMin = true;
    let isMax = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (values[j] < values[i]) isMin = false;
      if (values[j] > values[i]) isMax = false;
    }
    if (isMin) mins.push(i);
    if (isMax) maxs.push(i);
  }
  return { mins, maxs };
}

function linRegSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (values[i] - my);
    den += (i - mx) * (i - mx);
  }
  return den === 0 ? 0 : num / den;
}

/* ------------------------------------------------------------------ *
 *  Tespit fonksiyonlari (her biri bos-olmayan obje ya da null doner)
 * ------------------------------------------------------------------ */

/** Cift Dip: iki yakin dip + boyun cizgisi kirilimi. */
function detectDoubleBottom(closes) {
  const { mins } = findSwings(closes, 5);
  const n = closes.length;
  for (let a = mins.length - 1; a >= 1; a--) {
    for (let b = a - 1; b >= 0; b--) {
      const i1 = mins[b];
      const i2 = mins[a];
      const gap = i2 - i1;
      if (gap < 6 || gap > 90) continue;
      if (i2 < n - 25) continue; // ikinci dip yakın zamanda olusmali
      const p1 = closes[i1];
      const p2 = closes[i2];
      if (Math.abs(p1 - p2) / Math.min(p1, p2) > 0.07) continue;
      let neck = -Infinity;
      for (let k = i1; k <= i2; k++) neck = Math.max(neck, closes[k]);
      const depth = (neck - Math.min(p1, p2)) / neck;
      if (depth < 0.04) continue;
      const last = closes[n - 1];
      if (last <= neck * 1.002) continue; // kirilim yok
      const target = neck + (neck - Math.min(p1, p2));
      const upside = ((target - last) / last) * 100;
      if (upside <= 0) continue;
      return {
        key: 'doubleBottom',
        confidence: Math.round(Math.min(92, 55 + depth * 120 + Math.min(10, upside / 2))),
        upsidePct: Math.round(upside * 10) / 10,
        detail:
          'İki dip ' + (((p2 - p1) / p1) * 100).toFixed(1) + '% farkla aynı bölgede oluştu, ' +
          'boyun çizgisi (' + neck.toFixed(2) + ') yukarı kırıldı.'
      };
    }
  }
  return null;
}

/** Ters Omuz-Bas-Omuz: uc dip, orta en derin, boyun kirilimi. */
function detectInverseHeadShoulders(closes) {
  const { mins } = findSwings(closes, 5);
  const n = closes.length;
  for (let i = mins.length - 1; i >= 2; i--) {
    const iL = mins[i - 2];
    const iH = mins[i - 1];
    const iR = mins[i];
    if (iR < n - 25) continue; // sag omuz yakin zamanda olusmali
    const pL = closes[iL];
    const pH = closes[iH];
    const pR = closes[iR];
    if (pH >= pL * 0.98 || pH >= pR * 0.98) continue;
    if (Math.abs(pL - pR) / Math.min(pL, pR) > 0.08) continue;
    let peak1 = -Infinity;
    for (let k = iL; k <= iH; k++) peak1 = Math.max(peak1, closes[k]);
    let peak2 = -Infinity;
    for (let k = iH; k <= iR; k++) peak2 = Math.max(peak2, closes[k]);
    const neck = (peak1 + peak2) / 2;
    const last = closes[n - 1];
    if (last <= neck * 1.002) continue;
    const target = neck + (neck - pH);
    const upside = ((target - last) / last) * 100;
    if (upside <= 0) continue;
    return {
      key: 'inverseHeadShoulders',
      confidence: Math.round(Math.min(95, 60 + ((neck - pH) / neck) * 150)),
      upsidePct: Math.round(upside * 10) / 10,
      detail:
        'Baş dibi (' + pH.toFixed(2) + ') omuzlardan belirgin derin, boyun çizgisi (' +
        neck.toFixed(2) + ') yukarı kırıldı.'
    };
  }
  return null;
}

/** Yukselen Ucgen: yatay direnc altinda yukselen dipler + kirilim. */
function detectAscendingTriangle(closes) {
  const n = closes.length;
  const lookback = Math.min(60, Math.floor(n * 0.6));
  const seg = closes.slice(n - lookback);
  const { maxs, mins } = findSwings(seg, 4);
  if (maxs.length < 2 || mins.length < 2) return null;
  const tops = maxs.slice(-3).map((i) => seg[i]);
  const tMax = Math.max.apply(null, tops);
  const tMin = Math.min.apply(null, tops);
  if ((tMax - tMin) / tMin > 0.05) return null;
  const lowVals = mins.filter((i) => i > maxs[0]).map((i) => seg[i]).slice(-4);
  if (lowVals.length < 2) return null;
  if (lowVals[lowVals.length - 1] <= lowVals[0] * 1.005) return null;
  const last = closes[n - 1];
  if (last <= tMax * 1.002) return null;
  const target = tMax + (tMax - lowVals[0]);
  const upside = ((target - last) / last) * 100;
  if (upside <= 0) return null;
  return {
    key: 'ascendingTriangle',
    confidence: 70,
    upsidePct: Math.round(upside * 10) / 10,
    detail:
      'Yatay direnç (' + tMax.toFixed(2) + ') altında dipler yükseldi ve direnç yukarı kırıldı.'
  };
}

/** Fincan Kulpu: yuvarlak taban + sig kulup + kulup ustunden cikis. */
function detectCupAndHandle(closes) {
  const n = closes.length;
  const cupLen = Math.min(90, n - 10);
  if (cupLen < 40) return null;
  const seg = closes.slice(n - cupLen);
  const m = seg.length;
  const rim = Math.max(seg[0], seg[m - 1]);
  let trough = Infinity;
  for (let k = Math.floor(m * 0.3); k < Math.floor(m * 0.8); k++) {
    trough = Math.min(trough, seg[k]);
  }
  const depth = (rim - trough) / rim;
  if (depth < 0.1 || depth > 0.5) return null;
  if (seg[m - 1] < seg[0] * 0.93) return null;
  const handle = seg.slice(-12);
  const handleLow = Math.min.apply(null, handle);
  if ((seg[m - 1] - handleLow) / seg[m - 1] > depth * 0.5) return null;
  if (handleLow <= trough) return null;
  const last = closes[n - 1];
  if (last < handleLow + (seg[m - 1] - handleLow) * 0.5) return null;
  const target = rim + (rim - trough) * 0.5;
  const upside = ((target - last) / last) * 100;
  if (upside <= 1) return null;
  return {
    key: 'cupAndHandle',
    confidence: 72,
    upsidePct: Math.round(upside * 10) / 10,
    detail:
      'Fincan tabanı ' + (depth * 100).toFixed(0) + '% derinlikte, sığ kulup tamamlandı ve ' +
      'kulüp üstü kırılıyor.'
  };
}

/** Boga Bayragi: keskin direk + dar, asagi egimli dinlenme + ust kirilim. */
function detectBullFlag(closes) {
  const n = closes.length;
  if (n < 30) return null;
  const poleLen = 8;
  const flagLen = 12;
  const pole = closes.slice(n - flagLen - poleLen, n - flagLen);
  const poleGain = (pole[pole.length - 1] - pole[0]) / pole[0];
  if (poleGain < 0.08) return null;
  const flag = closes.slice(n - flagLen);
  const fHigh = Math.max.apply(null, flag);
  const fLow = Math.min.apply(null, flag);
  if ((fHigh - fLow) / pole[pole.length - 1] > 0.45) return null;
  if (linRegSlope(flag) > 0) return null;
  const last = closes[n - 1];
  if (last < fLow + (fHigh - fLow) * 0.5) return null;
  const target = closes[n - flagLen] * (1 + poleGain);
  const upside = ((target - last) / last) * 100;
  if (upside <= 2) return null;
  return {
    key: 'bullFlag',
    confidence: 74,
    upsidePct: Math.round(upside * 10) / 10,
    detail:
      '%' + (poleGain * 100).toFixed(0) + ' luk güçlü direk sonrası dar ve sakin bayrak ' +
      'formasyonu tamamlandı.'
  };
}

/** Dusen Kama: daralan, asagi egimli kanal + ust bant kirilimi. */
function detectFallingWedge(closes) {
  const n = closes.length;
  const lookback = Math.min(50, n - 5);
  const seg = closes.slice(n - lookback);
  const { maxs, mins } = findSwings(seg, 4);
  if (maxs.length < 2 || mins.length < 2) return null;
  const hiSlope = linRegSlope(maxs.map((i) => seg[i]));
  const loSlope = linRegSlope(mins.map((i) => seg[i]));
  if (hiSlope >= 0 || loSlope >= 0) return null;
  if (Math.abs(loSlope) >= Math.abs(hiSlope)) return null; // ust bant daha dik dusmeli (daralma)
  const upperNow = hiSlope * (seg.length - 1) + seg[maxs[0]];
  const last = closes[n - 1];
  if (last <= upperNow) return null;
  const target = seg[0];
  const upside = ((target - last) / last) * 100;
  if (upside <= 1) return null;
  return {
    key: 'fallingWedge',
    confidence: 66,
    upsidePct: Math.round(upside * 10) / 10,
    detail: 'Aşağı eğimli ve daralan kamada üst bant yukarı kırıldı; satış baskısı tükeniyor.'
  };
}

/** Altin Kesisim: SMA50'nin SMA200'u yukari kesmesi. */
function detectGoldenCross(closes) {
  const n = closes.length;
  if (n < 210) return null;
  const s50 = smaAt(closes, 50, n - 1);
  const s200 = smaAt(closes, 200, n - 1);
  const s50Prev = smaAt(closes, 50, n - 11);
  const s200Prev = smaAt(closes, 200, n - 11);
  if (s50 == null || s200 == null || s50Prev == null || s200Prev == null) return null;
  if (!(s50 > s200 && s50Prev <= s200Prev)) return null; // son ~20 barda kesmis olmali
  const last = closes[n - 1];
  const upside = ((s200 * 1.1 - last) / last) * 100;
  return {
    key: 'goldenCross',
    confidence: 62,
    upsidePct: Math.max(2, Math.round(upside * 10) / 10),
    detail:
      '50 günlük ortalama (' + s50.toFixed(2) + '), 200 günlük ortalamayı (' +
      s200.toFixed(2) + ') yukarı kesti.'
  };
}

/** Yuvarlak Dip: ortada taban olan U sekli + yukselen ivme. */
function detectRoundingBottom(closes) {
  const n = closes.length;
  const lookback = Math.min(70, n - 5);
  if (lookback < 40) return null;
  const seg = closes.slice(n - lookback);
  const m = seg.length;
  let trough = Infinity;
  let troughIdx = -1;
  for (let k = 5; k < m - 5; k++) {
    if (seg[k] < trough) {
      trough = seg[k];
      troughIdx = k;
    }
  }
  if (troughIdx < m * 0.3 || troughIdx > m * 0.7) return null;
  const rim = Math.max(seg[0], seg[m - 1]);
  const depth = (rim - trough) / rim;
  if (depth < 0.1) return null;
  const q = seg.slice(Math.floor(m * 0.75));
  if (linRegSlope(q) <= 0) return null;
  const last = closes[n - 1];
  const upside = ((rim - last) / last) * 100 + 3;
  if (upside <= 2) return null;
  return {
    key: 'roundingBottom',
    confidence: 60,
    upsidePct: Math.round(upside * 10) / 10,
    detail:
      'U şeklinde ' + (depth * 100).toFixed(0) + '% derinlikte yuvarlak dip oluşumu tamamlandı, ' +
      'fiyat rime doğru ivmeleniyor.'
  };
}

/** Ayak Bayragi: keskin dusus diregi + dar, yukari egimli dinlenme + alt kirilim. */
function detectBearFlag(closes) {
  const n = closes.length;
  if (n < 30) return null;
  const poleLen = 8;
  const flagLen = 12;
  const pole = closes.slice(n - flagLen - poleLen, n - flagLen);
  const poleLoss = (pole[0] - pole[pole.length - 1]) / pole[0];
  if (poleLoss < 0.08) return null;
  const flag = closes.slice(n - flagLen);
  const fHigh = Math.max.apply(null, flag);
  const fLow = Math.min.apply(null, flag);
  if ((fHigh - fLow) / pole[pole.length - 1] > 0.45) return null;
  if (linRegSlope(flag) < 0) return null;
  const last = closes[n - 1];
  if (last > fHigh - (fHigh - fLow) * 0.5) return null;
  const target = closes[n - flagLen] * (1 - poleLoss);
  const downside = ((last - target) / last) * 100;
  if (downside <= 2) return null;
  return {
    key: 'bearFlag',
    confidence: 74,
    downsidePct: Math.round(downside * 10) / 10,
    detail:
      '%' + (poleLoss * 100).toFixed(0) + ' luk guculu dusus sonrasi dar ve sakin bayrak ' +
      'formasyonu tamamlandi.'
  };
}

/** Yukselen Kama: daralan, yukari egimli kanal + alt bant kirilimi asagi. */
function detectRisingWedge(closes) {
  const n = closes.length;
  const lookback = Math.min(50, n - 5);
  const seg = closes.slice(n - lookback);
  const { maxs, mins } = findSwings(seg, 4);
  if (maxs.length < 2 || mins.length < 2) return null;
  const hiSlope = linRegSlope(maxs.map((i) => seg[i]));
  const loSlope = linRegSlope(mins.map((i) => seg[i]));
  if (hiSlope <= 0 || loSlope <= 0) return null;
  if (Math.abs(hiSlope) >= Math.abs(loSlope)) return null;
  const lowerNow = loSlope * (seg.length - 1) + seg[mins[0]];
  const last = closes[n - 1];
  if (last >= lowerNow) return null;
  const target = seg[0];
  const downside = ((last - target) / last) * 100;
  if (downside <= 1) return null;
  return {
    key: 'risingWedge',
    confidence: 66,
    downsidePct: Math.round(downside * 10) / 10,
    detail: 'Yukari egimli ve daralan kamada alt bant asagi kirildi; alis baskisi tukeniyor.'
  };
}

/** Olum Kesisimi: SMA50'nin SMA200'nin altina dusmesi. */
function detectDeathCross(closes) {
  const n = closes.length;
  if (n < 210) return null;
  const s50 = smaAt(closes, 50, n - 1);
  const s200 = smaAt(closes, 200, n - 1);
  const s50Prev = smaAt(closes, 50, n - 11);
  const s200Prev = smaAt(closes, 200, n - 11);
  if (s50 == null || s200 == null || s50Prev == null || s200Prev == null) return null;
  if (!(s50 < s200 && s50Prev >= s200Prev)) return null;
  const last = closes[n - 1];
  const downside = ((last - s200 * 0.9) / last) * 100;
  return {
    key: 'deathCross',
    confidence: 62,
    downsidePct: Math.max(2, Math.round(downside * 10) / 10),
    detail:
      '50 gunluk ortalama (' + s50.toFixed(2) + '), 200 gunluk ortalamanin (' +
      s200.toFixed(2) + ') altina dustu.'
  };
}

/** Yuvarlak Tepe: ortada tepe olan ters U sekli + asagi yavaslasi. */
function detectRoundingTop(closes) {
  const n = closes.length;
  const lookback = Math.min(70, n - 5);
  if (lookback < 40) return null;
  const seg = closes.slice(n - lookback);
  const m = seg.length;
  let peak = -Infinity;
  let peakIdx = -1;
  for (let k = 5; k < m - 5; k++) {
    if (seg[k] > peak) {
      peak = seg[k];
      peakIdx = k;
    }
  }
  if (peakIdx < m * 0.3 || peakIdx > m * 0.7) return null;
  const rim = Math.min(seg[0], seg[m - 1]);
  const depth = (peak - rim) / peak;
  if (depth < 0.1) return null;
  const q = seg.slice(Math.floor(m * 0.75));
  if (linRegSlope(q) >= 0) return null;
  const last = closes[n - 1];
  const downside = ((last - rim) / last) * 100 + 3;
  if (downside <= 2) return null;
  return {
    key: 'roundingTop',
    confidence: 60,
    downsidePct: Math.round(downside * 10) / 10,
    detail:
      'Ters U seklinde ' + (depth * 100).toFixed(0) + '% derinlikte yuvarlak tepe olustu, ' +
      'fiyat tabana dogru yavasliyor.'
  };
}

/** Cift Zirve: iki yakin zirve + boyun cizgisi asagi kirilimi. */
function detectDoubleTop(closes) {
  const { maxs } = findSwings(closes, 5);
  const n = closes.length;
  for (let a = maxs.length - 1; a >= 1; a--) {
    for (let b = a - 1; b >= 0; b--) {
      const i1 = maxs[b];
      const i2 = maxs[a];
      const gap = i2 - i1;
      if (gap < 6 || gap > 90) continue;
      if (i2 < n - 25) continue;
      const p1 = closes[i1];
      const p2 = closes[i2];
      if (Math.abs(p1 - p2) / Math.min(p1, p2) > 0.07) continue;
      let neck = Infinity;
      for (let k = i1; k <= i2; k++) neck = Math.min(neck, closes[k]);
      const depth = (Math.max(p1, p2) - neck) / Math.max(p1, p2);
      if (depth < 0.04) continue;
      const last = closes[n - 1];
      if (last >= neck * 0.998) continue;
      const target = neck - (Math.max(p1, p2) - neck);
      const downside = ((last - target) / last) * 100;
      if (downside <= 0) continue;
      return {
        key: 'doubleTop',
        confidence: Math.round(Math.min(92, 55 + depth * 120 + Math.min(10, downside / 2))),
        downsidePct: Math.round(downside * 10) / 10,
        detail:
          'Iki zirve ' + (((p2 - p1) / p1) * 100).toFixed(1) + '% farkla ayni bolgede olustu, ' +
          'boyun cizgisi (' + neck.toFixed(2) + ') asagi kirildi.'
      };
    }
  }
  return null;
}

/** Omuz-Bas-Omuz: uc tepe, orta en yuksek, boyun kirilimi asagi. */
function detectHeadShoulders(closes) {
  const { maxs } = findSwings(closes, 5);
  const n = closes.length;
  for (let i = maxs.length - 1; i >= 2; i--) {
    const iL = maxs[i - 2];
    const iH = maxs[i - 1];
    const iR = maxs[i];
    if (iR < n - 25) continue;
    const pL = closes[iL];
    const pH = closes[iH];
    const pR = closes[iR];
    if (pH <= pL * 1.02 || pH <= pR * 1.02) continue;
    if (Math.abs(pL - pR) / Math.min(pL, pR) > 0.08) continue;
    let trough1 = Infinity;
    for (let k = iL; k <= iH; k++) trough1 = Math.min(trough1, closes[k]);
    let trough2 = Infinity;
    for (let k = iH; k <= iR; k++) trough2 = Math.min(trough2, closes[k]);
    const neck = (trough1 + trough2) / 2;
    const last = closes[n - 1];
    if (last >= neck * 0.998) continue;
    const target = neck - (pH - neck);
    const downside = ((last - target) / last) * 100;
    if (downside <= 0) continue;
    return {
      key: 'headShoulders',
      confidence: Math.round(Math.min(95, 60 + ((pH - neck) / neck) * 150)),
      downsidePct: Math.round(downside * 10) / 10,
      detail:
        'Bas zirvesi (' + pH.toFixed(2) + ') omuzlardan belirgin yuksek, boyun cizgisi (' +
        neck.toFixed(2) + ') asagi kirildi.'
    };
  }
  return null;
}

/** Dusen Ucgen: yatay destek uzerinde dusen tepeler + destek kirilimi asagi. */
function detectDescendingTriangle(closes) {
  const n = closes.length;
  const lookback = Math.min(60, Math.floor(n * 0.6));
  const seg = closes.slice(n - lookback);
  const { maxs, mins } = findSwings(seg, 4);
  if (maxs.length < 2 || mins.length < 2) return null;
  const bottoms = mins.slice(-3).map((i) => seg[i]);
  const bMax = Math.max.apply(null, bottoms);
  const bMin = Math.min.apply(null, bottoms);
  if ((bMax - bMin) / bMin > 0.05) return null;
  const highVals = maxs.filter((i) => i > mins[0]).map((i) => seg[i]).slice(-4);
  if (highVals.length < 2) return null;
  if (highVals[highVals.length - 1] >= highVals[0] * 0.995) return null;
  const last = closes[n - 1];
  if (last >= bMin * 0.998) return null;
  const target = bMin - (bMax - bMin);
  const downside = ((last - target) / last) * 100;
  if (downside <= 0) return null;
  return {
    key: 'descendingTriangle',
    confidence: 70,
    downsidePct: Math.round(downside * 10) / 10,
    detail:
      'Yatay destek (' + bMin.toFixed(2) + ') altinda tepeler asagi egildi ve destek asagi kirildi.'
  };
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

/**
 * Bir kapanis serisindeki tum boga formasyonlarini tarar.
 * @param {{t:number,c:number}[]} points
 */
function scanBullishPatterns(points) {
  const closes = points.map((p) => p.c).filter((c) => c != null && isFinite(c));
  if (closes.length < 60) return [];
  const found = [];
  for (const fn of DETECTORS) {
    try {
      const r = fn(closes);
      if (r) found.push(r);
    } catch (_) {
      /* tek formasyon hatasi tum taramayi bozmasin */
    }
  }
  return found.sort((a, b) => b.confidence - a.confidence);
}

/** Bir kapanis serisindeki tum dusus formasyonlarini tarar. */
function scanBearishPatterns(points) {
  const closes = points.map((p) => p.c).filter((c) => c != null && isFinite(c));
  if (closes.length < 60) return [];
  const found = [];
  for (const fn of DETECTORS_BEARISH) {
    try {
      const r = fn(closes);
      if (r) found.push(r);
    } catch (_) {
      /* tek formasyon hatasi tum taramayi bozmasin */
    }
  }
  return found.sort((a, b) => b.confidence - a.confidence);
}

module.exports = { PATTERN_LIBRARY, scanBullishPatterns, scanBearishPatterns, etaLabel };
