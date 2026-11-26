# BIST100 Analist V2

BIST100 hisselerini canlı olarak izleyebileceğiniz; klasik mum (candlestick)
grafikleri, son 7 günün haberleri, altın fiyatları, gelişmiş teknik formasyon
taraması ve **haber destekli yapay zeka analizlerini** tek ekranda birleştiren
web uygulaması.

## V2 yenilikleri

- **EVREN (SSB) başta olmak üzere** NVIDIA, OpenAI, OpenRouter, Groq ve DeepSeek
  destekli, kullanıcı bazlı API anahtarı yönetimi.
- EVREN kullanım şartlarının otomatik onayı, model listesinin hesaptan çekilmesi
  ve bağlantı testi.
- **Gelişmiş formasyon motoru**: trend, geometri, kırılım tazeliği ve ihlal
  kontrolleri; RSI/SMA/ATR bağlamı.
- Formasyonların haber ve fiyat serisiyle **AI doğrulaması**; onay, düzeltme,
  eleme ve iki yön karşılaştırması.
- Haberleri kullanarak **yakın (1-4 hafta) ve uzak (3-12 ay) vadeli** AI tahmini.
- Grafikten doğrudan **Varlıklarıma Ekle**.
- **Apple Liquid Glass** teması.
- Altın fiyatlarının hesaplanmadan **Truncgil Finans**’tan doğrudan çekilmesi.

## Öne çıkanlar

- **Tüm BIST100 hisseleri** alfabetik olarak listelenir; son fiyat, günlük ve
  haftalık değişim renkli gösterilir. Fiyatlar 60 saniyede bir yenilenir.
- **Hisseye tıklayınca** satır genişler; hacimli mum grafiği açılır.
  **5 Yıl / 1 Yıl / 6 Ay / 1 Ay / Bugün** aralıkları, `⛶ Büyüt` ve OHLC
  tooltip'i korunmuştur.
- **Grafikten doğrudan Varlıklarıma Ekle**: İster ana ekrandaki genişleyen
  grafikten ister büyütülmüş grafik penceresinden, güncel fiyat ve tarih ön
  doldurulmuş mini formla hisse portföye eklenebilir.
- **Bugünün Trendleri + Altın** aynı görünümde: haftanın en hareketli 8 hissesi
  sparkline'larla, hemen yanında **Truncgil Finans'tan doğrudan** Gram/Çeyrek/Tam
  (TL) ve Ons (USD) altın fiyatları.
- **Haberler** aynı sağ panelde: seçili hissenin son 1 haftası; hisse seçili
  değilse piyasa gündemi (Google Haberler).
- **Varlıklarım**: hisse, adet, alış fiyatı ve alış tarihi ile portföy kaydı;
  formasyon beklentisi, tahmini satış hedefi, kâr/zarar takibi (localStorage).
- **Gelişmiş formasyon motoru**: Çift Dip/Zirve, TOBO/OBO, Yükselen/Düşen
  Üçgen, Fincan-Kulp, Boğa/Ayı Bayrağı, Düşen/Yükselen Kama, Altın/Ölüm
  Kesişimi, Yuvarlak Dip/Tepe. Önceki trend, geometri, kırılım tazeliği ve
  formasyon ihlali kontrolleriyle hatalı sinyaller ayıklanır.
- **AI formasyon doğrulaması**: Kural tabanlı adaylar, gerçek fiyat serisi,
  RSI/SMA ve haber bağlamıyla yapay zekâ tarafından onaylanır, düzeltilir veya
  elenir. AI'ye ulaşılamazsa kural tabanlı sonuçlar kaybolmaz.
- **Haber destekli yakın/uzak vade analizi**: Piyasa ve tek hisse analizleri;
  haberlerin olası etkisi, teknik görünüm, **1-4 hafta** ve **3-12 ay** vadeli
  senaryolar, destek/direnç bantları ve riskler.
- **Çok kullanıcılı API anahtarı**: Her kullanıcı kendi anahtarını tarayıcısında
  saklar; sunucu anahtarı kalıcı olarak kaydetmez.
- **Apple Liquid Glass teması**: Buzlu cam paneller, ışık kırılmalı kenarlıklar
  ve dinamik ortam ışığı (yerleşim birebir korunmuştur).

## Altın fiyatları

- **Gram / Çeyrek / Tam altın**: [Truncgil Finans](https://finans.truncgil.com/today.json)
  JSON servisinden **doğrudan satış fiyatı** olarak alınır (TL).
- **Ons altın**: aynı kaynaktan **USD/ons** olarak alınır; TL'ye çevrilmez.
- Veri **60 saniye** önbelleklenir; kaynak saat bilgisi panelde gösterilir.
- Truncgil'e erişilemezse Yahoo Finance (`GC=F` + `TRY=X`) yedek hesaplaması
  devreye girer ve panelde **"Yedek kaynak · Hesaplanan değerler"** yazar.
- Fiyatlar bilgi amaçlıdır; kuyumcu alış/satış farkı ve yerel fiyatlar farklı
  olabilir.

## Hızlı başlangıç

İki sunucu da aynı API'yi sunar. Harici npm/pip bağımlılığı yoktur.

### Seçenek A — Node.js (18+, önerilen)

```bash
node server.js
```

### Seçenek B — Python (3.8+) — Node.js yoksa

```bash
py server.py
```

Ardından tarayıcıda:

```
http://localhost:3010
```

Windows kısayolu: `BIST100 Baslat.bat` (Node sunucusunu açar ve tarayıcıyı
başlatır).

> Varsayılan port **3010**'dur. 3000 portu başka bir uygulama tarafından
> kullanılıyorsa çakışmayı önlemek için bu port seçilmiştir. Farklı bir port
> için `PORT` ortam değişkenini kullanın (örn. PowerShell:
> `$env:PORT=8080; node server.js`).

## AI API anahtarı (EVREN / NVIDIA / diğer)

Uygulama içindeki **🔑 API Ayarları** penceresinden anahtar girilir. Anahtar
yalnızca tarayıcıda (`localStorage`) saklanır ve AI isteklerinde
`X-AI-Key` / `X-AI-Base` / `X-AI-Model` başlıklarıyla sunucuya iletilir.

### EVREN (T.C. SSB Milli Yapay Zeka Platformu) — önerilen

1. [evren.ssyz.org.tr](https://evren.ssyz.org.tr) adresine e-Devlet ile giriş
   yapın.
2. **API Anahtarları** sayfasından `evren_llm_...` biçiminde bir anahtar
   oluşturun.
3. Uygulamada **🔑 API Ayarları → Sağlayıcı: EVREN** seçin; anahtarı yapıştırın.
   Sunucu adresi otomatik olarak
   `https://evren-llmapi.ssyz.org.tr/v1/chat/completions` olur.
4. **Bağlantıyı Test Et** → **Kaydet & Etkinleştir**.

EVREN kullanım şartları ilk istekte otomatik onaylanır
(`/v1/terms/status` → `/v1/terms/accept`). Model listesi **↻ Modelleri Getir**
ile hesabınızdan çekilebilir (`auto`, `glm-5.3`, `deepseek-v4.1-flash`,
`mimo-v2.6-pro`, `qwen3.8-flash-next`, `gemma-4-31b`, `qwen3-vl-30b`).

### NVIDIA NIM / OpenAI / OpenRouter / Groq / DeepSeek

Sağlayıcıyı seçin; Base URL ve önerilen modeller otomatik dolar. İsterseniz
Model kutusunda **Özel model kimliği** ile farklı bir model girebilirsiniz.

### Sunucu varsayılanı (opsiyonel)

`.env` dosyası oluşturup sunucu geneli varsayılan anahtar tanımlayabilirsiniz.
Tarayıcıda kayıtlı anahtar yoksa bu varsayılan kullanılır:

```
AI_API_KEY=evren_llm_...
AI_API_BASE=https://evren-llmapi.ssyz.org.tr/v1/chat/completions
AI_MODEL=auto
```

> `.env` dosyası `.gitignore` ile hariç tutulur; gerçek anahtar commit edilmez.
> Çok kullanıcılı kullanımda `.env` yerine her kullanıcının kendi anahtarını
> arayüzden girmesi önerilir.

## API rotaları

| Endpoint | Açıklama | Önbellek |
| --- | --- | --- |
| `GET /api/overview` | Tüm BIST100 özet verisi | 60 sn |
| `GET /api/formations?dir=bullish\|bearish\|all` | Gelişmiş formasyon taraması | 15 dk |
| `GET /api/ai-formations?dir=...` | Formasyon + AI doğrulama/karşılaştırma | 30 dk (anahtar bazlı) |
| `GET /api/gold` | Gram/Çeyrek/Tam (TL) + Ons (USD) — Truncgil Finans | 60 sn |
| `GET /api/chart?symbol=X&range=1y` | Mum grafiği | 5 dk |
| `GET /api/news?symbol=X` | Google Haberler | 10 dk |
| `GET /api/ai-analysis` | Haber + formasyon destekli piyasa analizi | 10 dk (anahtar bazlı) |
| `GET /api/ai-analysis-stock?symbol=X&horizon=all` | Tek hisse, yakın/uzak vade | 10 dk (anahtar bazlı) |
| `GET /api/ai-models` | Hesaba tanımlı modeller | — |
| `GET /api/ai-config` | Sunucu varsayılan ayar durumu | — |
| `POST /api/ai-test` | Bağlantı testi | — |

AI rotaları anahtarı istek başlıklarından okur; `?fresh=1` önbelleği atlar.

## Proje yapısı

```
server.js            HTTP sunucusu + API proxy + önbellek (Node, birincil)
server.py            Aynı API'nin Python stdlib sürümü (yedek)
lib/env.js           Bağımlılıksız .env yükleyici
lib/ai.js            AI istemcisi (EVREN/NVIDIA/OpenAI uyumlu, terms akışı)
lib/yahoo.js         Yahoo Finance istemcisi
lib/gold.js          Altın kaynağı (Truncgil Finans + Yahoo yedek)
lib/news.js          Google Haberler RSS istemcisi
lib/patterns.js      Gelişmiş formasyon tespit motoru + göstergeler
data/bist100.js      BIST100 sembol listesi (tek kaynak)
public/index.html    Arayüz iskeleti
public/styles.css    Temel karanlık tema
public/glass.css     Apple Liquid Glass tema katmanı
public/app.js        İstemci mantığı + canvas mum grafiği + AI/portföy
```

## Veri kaynakları

- **Fiyat / grafik**: Yahoo Finance (BIST sembolleri `.IS` uzantılı).
- **Altın**: Truncgil Finans `today.json` (doğrudan gram/çeyrek/tam TL, ons USD);
  erişilemezse yedek olarak Yahoo Finance `GC=F` + `TRY=X` hesaplaması.
- **Haberler**: Google Haberler RSS (Türkçe, son 7 gün).
- **AI**: EVREN LLM API, NVIDIA NIM veya OpenAI uyumlu her sağlayıcı.

## Notlar

- Fiyatlar 15 dakika gecikmeli olabilir; Yahoo Finance verileri bilgi amaçlıdır.
- Bu uygulama **yatırım tavsiyesi değildir**. AI yorumları analiz amaçlıdır.
- Python yedek sunucusu temel özellikleri ve AI analizini sunar; gelişmiş
  formasyon taraması Node.js sunucusunda (`lib/patterns.js`) çalışır.
- BIST100 bileşimi değişebilir; `data/bist100.js` dosyasından güncellenir.
- AI API çağrıları için internet erişimi zorunludur.
- Uygulamayı başka kullanıcılara açarken **HTTPS** kullanın; API anahtarı AI
  isteklerinde başlık olarak taşınır ve sunucuda kalıcı saklanmaz.
