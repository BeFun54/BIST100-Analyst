# -*- coding: utf-8 -*-
"""
Klasik grafik formasyonlari bilgi tabani + tespit motoru (Python portu).

lib/patterns.js ile ayni kurallari uygular; sadece YUKSELIS (boga) sinyali
veren formasyonlar tespit edilir. Girdi: gunluk kapanis serisi [{t, c}].
"""

import datetime
import math
import time as _time

# ------------------------------------------------------------------ #
#  Formasyon bilgi tabani (hafiza)
# ------------------------------------------------------------------ #

PATTERN_LIBRARY = {
    'doubleBottom': {
        'name': 'Çift Dip', 'en': 'Double Bottom', 'type': 'dönüş (boğa)',
        'reliability': 'yüksek',
        'description': ('Fiyat iki kez aynı bölgeden dip yapar, aradaki direnç '
                        '(boyun çizgisi) aşılınca düşüş trendinin bittiği ve '
                        'yükselişin başladığı kabul edilir.'),
        'timeframe': 'yaklaşık 2-4 ay içinde',
        'psychology': ('İki kez denenen satış baskısı aynı seviyeyi kıramamış; '
                       'alıcılar bölgeyi savunuyor.')
    },
    'inverseHeadShoulders': {
        'name': 'Ters Omuz-Baş-Omuz', 'en': 'Inverse Head & Shoulders',
        'type': 'dönüş (boğa)', 'reliability': 'çok yüksek',
        'description': ('Üç dip oluşur; ortadaki (baş) en derindir. Boyun çizgisi '
                        'yukarı kırıldığında güçlü bir yükseliş dönüşü beklenir.'),
        'timeframe': 'yaklaşık 2-5 ay içinde',
        'psychology': ('Panik dibi (baş) sonrası iki kez daha derin dip denemesi '
                       'başarısız; trend gücü alıcıya geçmiş.')
    },
    'ascendingTriangle': {
        'name': 'Yükselen Üçgen', 'en': 'Ascending Triangle',
        'type': 'süreklilik (boğa)', 'reliability': 'yüksek',
        'description': ('Yatay bir direncin altında yükselen dipler oluşur. Alıcı '
                        'baskısı artar ve direnç yukarı kırıldığında sert yükseliş '
                        'beklenir.'),
        'timeframe': 'yaklaşık 3-8 hafta içinde',
        'psychology': ('Sabit direnci her seferinde daha yüksektenden alan alıcılar, '
                       'direnci kırma noktasına gelmiş.')
    },
    'cupAndHandle': {
        'name': 'Fincan Kulpu', 'en': 'Cup and Handle',
        'type': 'süreklilik (boğa)', 'reliability': 'yüksek',
        'description': ('Yuvarlak tabanlı bir düzeltme (fincan) sonrası kısa ve sığ '
                        'bir çekilme (kulup) gelir; kulbun üstü kırılınca önceki '
                        'zirveye ve ötesine hareket beklenir.'),
        'timeframe': 'yaklaşık 1-3 ay içinde',
        'psychology': ('Yavaş ve sağlıklı bir taban oluşumu; sonraki sığ çekilme '
                       'zayıf elden çıkışın tükendiğini gösterir.')
    },
    'bullFlag': {
        'name': 'Boğa Bayrağı', 'en': 'Bull Flag',
        'type': 'süreklilik (boğa)', 'reliability': 'yüksek',
        'description': ('Keskin bir yükseliş (direk) sonrası kısa, hafif eğimli ve dar '
                        'bir dinlenme (bayrak) olur; bayrağın üstünden çıkınca trend '
                        'genellikle benzer güçle sürer.'),
        'timeframe': 'yaklaşık 1-3 hafta içinde',
        'psychology': ('Güçlü hareket sonrası kâr satışları sınırlı kalmış; trendin '
                       'devamı için dinlenme tamamlanmış.')
    },
    'fallingWedge': {
        'name': 'Düşen Kama', 'en': 'Falling Wedge',
        'type': 'dönüş (boğa)', 'reliability': 'orta-yüksek',
        'description': ('Daralan ve aşağı eğimli iki trend kanalı içindeki hareket, '
                        'üst kanal yukarı kırıldığında genellikle yükselişle sonuçlanır.'),
        'timeframe': 'yaklaşık 3-10 hafta içinde',
        'psychology': ('Satış baskısı giderek zayıflıyor (düşüş ivmesi azalıyor); '
                       'denge alıcıya dönüyor.')
    },
    'goldenCross': {
        'name': 'Altın Kesişim', 'en': 'Golden Cross',
        'type': 'trend (boğa)', 'reliability': 'orta',
        'description': ('Kısa vadeli 50 günlük ortalama, uzun vadeli 200 günlük '
                        'ortalamanın yukarı keser; uzun vadeli boğa trendinin '
                        'başlangıcı olarak kabul edilir.'),
        'timeframe': 'yaklaşık 1-3 ay içinde',
        'psychology': ('Kısa vadeli alım gücü, uzun vadeli ortalamayı geçerek trend '
                       'dönüşünü istatistiksel olarak doğruluyor.')
    },
    'roundingBottom': {
        'name': 'Yuvarlak Dip', 'en': 'Rounding Bottom',
        'type': 'dönüş (boğa)', 'reliability': 'orta',
        'description': ('U şeklinde yavaş bir taban oluşumu; satışların kademeli '
                        'azalıp alımların kademeli artmasıyla dönüş uzun ve '
                        'istikrarlı bir yükselişe dönüşür.'),
        'timeframe': 'yaklaşık 2-4 ay içinde',
        'psychology': ('Kademeli fikir değişimi: korku yavaş yavaş iyimserliğe '
                       'dönüyor, trend kalıcı olma eğiliminde.')
    }
}


# ------------------------------------------------------------------ #
#  Yardimcilar
# ------------------------------------------------------------------ #

def _sma_at(values, n, end_index):
    if end_index + 1 < n:
        return None
    return sum(values[end_index - n + 1:end_index + 1]) / n


def _find_swings(values, w=5):
    """Yerel dip/zirve indeksleri (min, max) olarak doner."""
    mins = []
    maxs = []
    for i in range(w, len(values) - w):
        is_min = True
        is_max = True
        for j in range(i - w, i + w + 1):
            if j == i:
                continue
            if values[j] < values[i]:
                is_min = False
            if values[j] > values[i]:
                is_max = False
        if is_min:
            mins.append(i)
        if is_max:
            maxs.append(i)
    return mins, maxs


def _lin_reg_slope(values):
    n = len(values)
    if n < 2:
        return 0.0
    mx = (n - 1) / 2.0
    my = sum(values) / n
    num = 0.0
    den = 0.0
    for i in range(n):
        num += (i - mx) * (values[i] - my)
        den += (i - mx) * (i - mx)
    return 0.0 if den == 0 else num / den


# ------------------------------------------------------------------ #
#  Tespit fonksiyonlari (her biri obje ya da None doner)
# ------------------------------------------------------------------ #

def _detect_double_bottom(closes):
    """Cift Dip: iki yakin dip + boyun cizgisi kirilimi."""
    mins, _ = _find_swings(closes, 5)
    n = len(closes)
    for a in range(len(mins) - 1, 0, -1):
        for b in range(a - 1, -1, -1):
            i1 = mins[b]
            i2 = mins[a]
            gap = i2 - i1
            if gap < 6 or gap > 90:
                continue
            if i2 < n - 25:
                continue
            p1 = closes[i1]
            p2 = closes[i2]
            if abs(p1 - p2) / min(p1, p2) > 0.07:
                continue
            neck = max(closes[i1:i2 + 1])
            depth = (neck - min(p1, p2)) / neck
            if depth < 0.04:
                continue
            last = closes[n - 1]
            if last <= neck * 1.002:
                continue
            target = neck + (neck - min(p1, p2))
            upside = ((target - last) / last) * 100
            if upside <= 0:
                continue
            return {
                'key': 'doubleBottom',
                'confidence': int(round(min(92, 55 + depth * 120 + min(10, upside / 2)))),
                'upsidePct': round(upside, 1),
                'detail': ('İki dip ' + ('%.1f' % (((p2 - p1) / p1) * 100)) +
                           '% farkla aynı bölgede oluştu, boyun çizgisi (' +
                           ('%.2f' % neck) + ') yukarı kırıldı.')
            }
    return None


def _detect_inverse_head_shoulders(closes):
    """Ters Omuz-Bas-Omuz: uc dip, orta en derin, boyun kirilimi."""
    mins, _ = _find_swings(closes, 5)
    n = len(closes)
    for i in range(len(mins) - 1, 1, -1):
        iL = mins[i - 2]
        iH = mins[i - 1]
        iR = mins[i]
        if iR < n - 25:
            continue
        pL = closes[iL]
        pH = closes[iH]
        pR = closes[iR]
        if pH >= pL * 0.98 or pH >= pR * 0.98:
            continue
        if abs(pL - pR) / min(pL, pR) > 0.08:
            continue
        peak1 = max(closes[iL:iH + 1])
        peak2 = max(closes[iH:iR + 1])
        neck = (peak1 + peak2) / 2
        last = closes[n - 1]
        if last <= neck * 1.002:
            continue
        target = neck + (neck - pH)
        upside = ((target - last) / last) * 100
        if upside <= 0:
            continue
        return {
            'key': 'inverseHeadShoulders',
            'confidence': int(round(min(95, 60 + ((neck - pH) / neck) * 150))),
            'upsidePct': round(upside, 1),
            'detail': ('Baş dibi (' + ('%.2f' % pH) + ') omuzlardan belirgin derin, ' +
                       'boyun çizgisi (' + ('%.2f' % neck) + ') yukarı kırıldı.')
        }
    return None
