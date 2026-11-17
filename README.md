# BIST100 Analyst

BIST100 hisselerini canli olarak izleyebileceginiz, klasik mum (candlestick)
grafikleri, son 7 gunun haberleri, altin fiyatlari ve yapay zeka destekli
teknik analizleri tek ekranda birlestiren web uygulamasi.

## Ozellikler

- **Tum BIST100 hisseleri** alfabetik olarak listelenir; her satirda son fiyat,
  gunluk ve haftalik degisim renkli olarak gosterilir.
- **Anlik guncelleme**: fiyatlar 60 saniyede bir otomatik yenilenir;
  `⟳` dugmesi ile manuel yenilenebilir.
- **Hisseye tiklayinca alan genisler** ve klasik mum grafigi (hacim dahil)
  acilir. **5 Yil / 1 Yil / 6 Ay / 1 Ay / Bugun** araliklarindan biri
  secilebilir. Grafik buyutulebilir (`⛶ Buyut`) ve uzerine gelince OHLC
  detaylari gorunur.
- **Sag panelde haberler**: secilen sirketin son 1 haftadaki gelismeleri;
  hicbir hisse secili degilse piyasa gundemi. Kaynak: Google Haberler.
- **Bugunun Trendleri**: son 1 haftada en cok hareket eden 8 hisse,
  mini sparkline grafikleriyle.
- **Favoriler**: yildiza tiklayarak favorilere ekleyin; `Favorilerim` dugmesiyle
  tek tikla sadece favorileri gorun (tarayici hafizasinda saklanir).
- **AI Analiz (NVIDIA NIM)**: tek hisse ve genel piyasa icin Turkce teknik ve
  temel analiz; kural-tabanli formasyon taramalarinin Nemotron modeli ile
  dogrulanmasi. AI sunucu adresi, modeli ve API anahtari tarayici uzerinden
  ayarlanabilir ve test edilebilir (`/api/ai-config`, `/api/ai-test`).

## Altin Fiyatlari (`/api/gold`) — Yeni

Sol panelin **Altin** kismininda guncecelik altin fiyatlari gosterilir:

- **Gram Altin**, **Ceyrek Altin**, **Tam Altin**, **Ons Altin** (TL cinsinden)
- Veri kaynagi: Yahoo Finance `GC=F` (ons/USD) ve `TRY=X` (USD/TRY)
- 1 ons = 31.1034768 gram ile hesaplanir; ceyrek = 1.75 g, tam = 7 g
- Yerel sarfiyat fiyatlarindan (haremaltin.com vb.) farkli olabilir;
  kesin alis/satis fasi degildir
- Sunucu tarafinda **5 dakika** onbelleklenir

API: `GET /api/gold` (5 dk onbellekli)

## Hizli baslangic

Iki secenek de ayni siteyi ve ayni API'yi sunar. Harici npm/pip bagimliligi
**yoktur**.

### Secenek A - Node.js (18+)

```bash
node server.js
```

### Secenek B - Python (3.8+) — Node.js yoksa

```powershell
py server.py
```

Ardindan tarayiciya:

```
http://localhost:3000
```

Farkli bir port icin:

```powershell
$env:PORT=8080; node server.js      # Node
$env:PORT=8080; py server.py        # Python
```

## AI / NVIDIA kurulumu

AI analiz ozelligini kullanmak icin bir NVIDIA NIM API anahtari gerekir:

1. [build.nvidia.com](https://build.nvidia.com) adresinden `nvapi-...` baslangicli
   bir API anahtari edinin.
2. Proje kokunden `.env.example` dosyasinin bir kopyasini olusturun:

```powershell
Copy-Item .env.example .env
```

3. `.env` dosyasini acip `AI_API_KEY` satirina gercek anahtarini yapistirin:

```
AI_API_KEY=nvapi-SIZIN_ANAHTARINIZ
AI_API_BASE=https://integrate.api.nvidia.com/v1/chat/completions
AI_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b
```

4. Sunucuyu baslatın. `.env` otomatik olarak yuklenir (`lib/env.js` Node icin,
   `_load_env_file()` Python icin).

> **Güvenlik:** `.env` dosyasi asla commit edilmez (`.gitignore` ile haric
> tutulur). GitHub'a sadece `.env.example` yer tutucu yuklenir.

## API rotalari (sunucu calisirken)

| Endpoint | Aciklama | Onbellek |
|---|---|---|
| `GET /api/overview` | Tum BIST100 ozet verisi | 60 sn |
| `GET /api/formations` | Boga (yukselis) formasyonlari | 15 dk |
| `GET /api/ai-formations` | Formasyon + AI dogrulama | 30 dk |
| `GET /api/gold` | Altin fiyati (gram/ceyrek/tam/ons) | 5 dk |
| `GET /api/chart?symbol=X&range=1y` | Mum grafiği | 5 dk |
| `GET /api/news?q=...` | Google Haberler | 10 dk |
| `GET /api/ai-analysis` | Piyasa yorumu | 10 dk |
| `GET /api/ai-analysis-stock?symbol=X` | Tek hisse yorumu | — |
| `GET /api/ai-config` | AI ayarlarini getir (genel) | — |
| `POST /api/ai-config` | AI ayarlarini kaydet (anahtar, base URL, model) | — |
| `POST /api/ai-test` | AI baglantisini test et | — |

## Ek / yenilenmis ozellikler

- **Altin takibi**: `GC=F` ve `TRY=X` üzerinden gram/ceyrek/tam/ons altin
  fiyatlari, sol panelde ayrı bir kartta.
- **Varliklarim (portfoy)**: `💼 Varlıklarım` butonuyla hisse, adet, alis
  fiyati ve tarih kaydedilebilir; veriler tarayici hafizasinda (localStorage)
  saklanir ve formasyon taramasi ile tahmini satis hedefi karsilastirilir.
- **Dusush formasyonlari**: Yukselis ile beraber dustugu icin de tarama
  yapilir; bullish ve bearish sonuclari yan yana ve AI karsilastirmasi ile
  sunulur.
- **Calisma aninda AI ayari**: API anahtari, base URL ve model secenegi
  tarayici uzerinden degistirilebilir ve `Bağlantıyı Test Et` ile dogrulanir.

## Veri kaynaklari

- **Fiyat / grafik verisi**: Yahoo Finance (BIST sembolleri `.IS` uzantisi ile).
- **Altin fiyati**: Yahoo Finance `GC=F` (altin ons/USD) + `TRY=X` (USD/TRY).
- **Haberler**: Google Haberler RSS (Turkce).
- **AI**: NVIDIA NIM (OpenAI uyumlu `/v1/chat/completions`),
  `nvidia/nemotron-3.5-super-vl-120b-a12b`.

Sunucu, tarayicinin yasadigi CORS kisitlamasini asmak icin Yahoo ve haber
uclarina proxy'lik yapar.

## Proje yapisi

```
server.js            HTTP sunucusu + API proxy + onbellek (Node)
server.py            Ayni sunucunun Python (standart kutuphane) surumu
lib/env.js           Bagimliliksiz .env yukleyici (Node)
lib/ai.js            AI istemcisi (NVIDIA NIM / Nemotron)
lib/yahoo.js         Yahoo Finance istemcisi (crumb/cerez, spark, quote, chart)
lib/news.js          Google Haberler RSS istemcisi
lib/patterns.js      Klasik formasyon tespit motoru (yukselis + dustug)
lib/patterns.py      Python karsiligi (formasyon motoru)
data/bist100.js      BIST100 sembol listesi (Turkce adlarla) - tek kaynak
public/index.html    Arayuz iskeleti
public/styles.css    Karanlik tema stilleri
public/app.js        Istemci mantigi + canvas mum grafigi + altin/varlik/ai-ayari
```

Her iki sunucu da `data/bist100.js` dosyasini tek kaynak olarak okur;
listesini guncellemek icin sadece o dosyayi degistirmeniz yeterlidir.

## Notlar ve uyari

- Anlik fiyatlar 15 dakika gecikmeli olabilir; Yahoo Finance'in sagladigi
  veriler bilgi amaclidir.
- Bu uygulama **yatirim tavsiyesi degildir**. AI yorumlari analiz amaclidir,
  al-sat tavsiyesi degildir.
- BIST100 bilesimi zaman zaman degisir; `data/bist100.js` dosyasindan
  guncellenebilir.
- AI API cagrilari icin internet erisimi zorunludur.