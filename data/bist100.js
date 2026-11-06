'use strict';

/**
 * BIST100 hisse listesi.
 *
 * Her kayit: { symbol, name }
 *  - symbol : Yahoo Finance sembolu (BIST icin ".IS" eki ile)
 *  - name   : Turkce sirket adi (arama, haber ve gruplama icin)
 *
 * Not: BIST100 endeksinde yer alan hisseler zaman zaman degisir.
 * Liste tek bir yerden guncellenebilsin diye burada tutuluyor.
 */

const LIST = [
  ['AEFES', 'Anadolu Efes'],
  ['AGHOL', 'Anadolu Grubu Holding'],
  ['AHGAZ', 'Ahlatci Dogal Gaz'],
  ['AKBNK', 'Akbank'],
  ['AKCNS', 'Akcansa Cimento'],
  ['AKFGY', 'Akfen GYO'],
  ['AKSA', 'Aksa Akrilik'],
  ['AKSEN', 'Aksa Enerji'],
  ['AKSGY', 'Akis GYO'],
  ['ALARK', 'Alarko Holding'],
  ['ALBRK', 'Albaraka Turk'],
  ['ALFAS', 'Alfa Solar Enerji'],
  ['ANSGR', 'Anadolu Sigorta'],
  ['ARCLK', 'Arcelik'],
  ['ASELS', 'Aselsan'],
  ['ASTOR', 'Astor Enerji'],
  ['ASUZU', 'Anadolu Isuzu'],
  ['AYDEM', 'Aydem Yenilenebilir Enerji'],
  ['AYEN', 'Ayen Enerji'],
  ['AYGAZ', 'Aygaz'],
  ['BAGFS', 'Bagfas'],
  ['BRISA', 'Brisa'],
  ['BRSAN', 'Borusan Birlesik Boru'],
  ['BTCIM', 'Baticim'],
  ['BUCIM', 'Bursa Cimento'],
  ['CANTE', 'Can2 Termik'],
  ['CCOLA', 'Coca-Cola Icecek'],
  ['CIMSA', 'Cimsa'],
  ['CLEBI', 'Celebi Hava Servisi'],
  ['CWENE', 'CW Enerji'],
  ['DOAS', 'Dogus Otomotiv'],
  ['DOHOL', 'Dogan Holding'],
  ['EBEBK', 'E-Bebek'],
  ['ECILC', 'Eczacibasi Ilac'],
  ['EGEEN', 'Ege Endustri'],
  ['EKGYO', 'Emlak Konut GYO'],
  ['ENERY', 'Enerya Enerji'],
  ['ENJSA', 'Enerjisa Enerji'],
  ['ENKAI', 'Enka Insaat'],
  ['EREGL', 'Eregli Demir ve Celik'],
  ['EUPWR', 'Europower Enerji'],
  ['FROTO', 'Ford Otosan'],
  ['GARAN', 'Garanti BBVA'],
  ['GESAN', 'Girisim Elektrik'],
  ['GUBRF', 'Gubre Fabrikalari'],
  ['GWIND', 'Galata Wind Enerji'],
  ['HALKB', 'Halkbank'],
  ['HEKTS', 'Hektas'],
  ['ISCTR', 'Is Bankasi (C)'],
  ['ISDMR', 'Iskenderun Demir Celik'],
  ['ISFIN', 'Is Finansal Kiralama'],
  ['ISGYO', 'Is GYO'],
  ['ISMEN', 'Is Yatirim Menkul Degerler'],
  ['KARSN', 'Karsan Otomotiv'],
  ['KCAER', 'Kocaer Celik'],
  ['KCHOL', 'Koc Holding'],
  ['KONTR', 'Kontrolmatik Teknoloji'],
  ['KORDS', 'Kordsa Teknik Tekstil'],
  ['KRDMD', 'Kardemir (D)'],
  ['MAGEN', 'Margun Enerji'],
  ['MAVI', 'Mavi Giyim'],
  ['MGROS', 'Migros'],
  ['MIATK', 'Mia Teknoloji'],
  ['MPARK', 'Medical Park'],
  ['NATEN', 'Naturel Yenilenebilir Enerji'],
  ['ODAS', 'Odas Elektrik'],
  ['OTKAR', 'Otokar'],
  ['OYAKC', 'Oyak Cimento'],
  ['PETKM', 'Petkim'],
  ['PGSUS', 'Pegasus'],
  ['SAHOL', 'Sabanci Holding'],
  ['SASA', 'Sasa Polyester'],
  ['SDTTR', 'SDT Uzay ve Savunma'],
  ['SELEC', 'Selcuk Ecza Deposu'],
  ['SISE', 'Sisecam'],
  ['SKBNK', 'Sekerbank'],
  ['SMRTG', 'Smart Gunes Enerjisi'],
  ['SOKM', 'Sok Marketler'],
  ['TABGD', 'Tab Gida'],
  ['TAVHL', 'TAV Havalimanlari'],
  ['TCELL', 'Turkcell'],
  ['TEZOL', 'Tezol Kagit'],
  ['THYAO', 'Turk Hava Yollari'],
  ['TKFEN', 'Tekfen Holding'],
  ['TMSN', 'Tumosan Motor'],
  ['TOASO', 'Tofas'],
  ['TRGYO', 'Torunlar GYO'],
  ['TSKB', 'Turkiye Sinai Kalkinma Bankasi'],
  ['TTKOM', 'Turk Telekom'],
  ['TTRAK', 'Turk Traktor'],
  ['TUPRS', 'Tupras'],
  ['TUKAS', 'Tukas Gida'],
  ['TURSG', 'Turkiye Sigorta'],
  ['ULKER', 'Ulker Biskuvi'],
  ['VAKBN', 'Vakifbank'],
  ['VESBE', 'Vestel Beyaz Esya'],
  ['VESTL', 'Vestel'],
  ['YATAS', 'Yatas Yatak'],
  ['YKBNK', 'Yapi Kredi'],
  ['ZOREN', 'Zorlu Enerji']
];

const BIST100 = LIST.map(([symbol, name]) => ({
  symbol,
  name,
  yahoo: symbol + '.IS'
}));

const bySymbol = Object.create(null);
for (const s of BIST100) bySymbol[s.symbol] = s;

module.exports = { BIST100, bySymbol };
