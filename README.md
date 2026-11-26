# BIST100 Analist V2

BIST100 hisselerini canlı olarak izleyebileceğiniz; klasik mum (candlestick)
grafikleri, son 7 günün haberleri, altın fiyatları, gelişmiş teknik formasyon
taraması ve **haber destekli yapay zeka analizlerini** tek ekranda birleştiren
web uygulaması.

## V2 yenilikleri

- **OpenAI uyumlu çoklu sağlayıcı desteği**: NVIDIA NIM, OpenAI, OpenRouter,
  Groq, DeepSeek, EVREN (SSB) ve özel adresler; kullanıcı bazlı API anahtarı.
- Sağlayıcı seçildiğinde Base URL ve model listesinin otomatik dolması,
  hesaptaki modellerin çekilmesi ve bağlantı testi. Sağlayıcıya özel kullanım
  şartları (ör. EVREN) otomatik yönetilir.
- **Gelişmiş formasyon motoru**: trend, geometri, kırılım tazeliği ve ihlal
  kontrolleri; RSI/SMA/ATR bağlamı.
- Formasyonların haber ve fiyat serisiyle **AI doğrulaması**; onay, düzeltme,
  eleme ve iki yön karşılaştırması.
- Haberleri kullanarak **yakın (1-4 hafta) ve uzak (3-12 ay) vadeli** AI tahmini.
- Grafikten doğrudan **Varlıklarıma Ekle**.
- **Glassmorphism** teması.
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
- **Çoklu sağlayıcı + çok kullanıcılı API anahtarı**: OpenAI uyumlu tüm
  sağlayıcılar (NVIDIA NIM, OpenAI, OpenRouter, Groq, DeepSeek, EVREN ve özel
  adresler); her kullanıcı kendi anahtarını tarayıcısında saklar.
- **Glassmorphism teması**: Buzlu cam paneller, ışık kırılmalı kenarlıklar
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

## AI API anahtarı (OpenAI uyumlu sağlayıcılar)

Uygulama, **OpenAI uyumlu `/v1/chat/completions` API'si sunan tüm sağlayıcılarla**
çalışır. Anahtar uygulama içindeki **🔑 API** penceresinden girilir; yalnızca
tarayıcıda (`localStorage`) saklanır ve AI isteklerinde `X-AI-Key` /
`X-AI-Base` / `X-AI-Model` başlıklarıyla sunucuya iletilir. Sunucu anahtarı
kalıcı olarak kaydetmez.

### Desteklenen sağlayıcılar

| Sağlayıcı | Base URL | Anahtar örneği |
| --- | --- | --- |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1/chat/completions` | `nvapi-...` |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `sk-...` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | `sk-or-...` |
| Groq | `https://api.groq.com/openai/v1/chat/completions` | `gsk_...` |
| DeepSeek | `https://api.deepseek.com/chat/completions` | `sk-...` |
| EVREN (SSB) | `https://evren-llmapi.ssyz.org.tr/v1/chat/completions` | `evren_llm_...` |
| Özel / Diğer | OpenAI uyumlu adres | — |

Sağlayıcı seçildiğinde Base URL ve önerilen modeller otomatik dolar.
**↻ Modelleri Getir** ile hesabınıza tanımlı modelleri çekebilir, **Özel model
kimliği** ile farklı bir model girebilirsiniz. **Bağlantıyı Test Et** →
**Kaydet & Etkinleştir** adımlarıyla ayarı doğrulayabilirsiniz.

> **EVREN (SSB) notu:** [evren.ssyz.org.tr](https://evren.ssyz.org.tr) üzerinden
> e-Devlet ile `evren_llm_...` anahtarı oluşturulabilir. Kullanım şartları ilk
> istekte otomatik onaylanır; modeller **↻ Modelleri Getir** ile çekilir.
> EVREN, desteklenen sağlayıcılardan yalnızca biridir.

### Sunucu varsayılanı (opsiyonel)

`.env` dosyası oluşturup sunucu geneli varsayılan anahtar tanımlayabilirsiniz.
Tarayıcıda kayıtlı anahtar yoksa bu varsayılan kullanılır:

```
AI_API_KEY=...
AI_API_BASE=https://integrate.api.nvidia.com/v1/chat/completions
AI_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b
```

> EVREN örneği: `AI_API_BASE=https://evren-llmapi.ssyz.org.tr/v1/chat/completions`,
> `AI_MODEL=auto`. Aynı yöntem OpenAI uyumlu diğer sağlayıcılarda da geçerlidir.
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
lib/ai.js            AI istemcisi (OpenAI uyumlu tüm sağlayıcılar; terms akışı)
lib/yahoo.js         Yahoo Finance istemcisi
lib/gold.js          Altın kaynağı (Truncgil Finans + Yahoo yedek)
lib/news.js          Google Haberler RSS istemcisi
lib/patterns.js      Gelişmiş formasyon tespit motoru + göstergeler
data/bist100.js      BIST100 sembol listesi (tek kaynak)
public/index.html    Arayüz iskeleti
public/styles.css    Temel karanlık tema
public/glass.css     Glassmorphism tema katmanı
public/app.js        İstemci mantığı + canvas mum grafiği + AI/portföy
```

## Veri kaynakları

- **Fiyat / grafik**: Yahoo Finance (BIST sembolleri `.IS` uzantılı).
- **Altın**: Truncgil Finans `today.json` (doğrudan gram/çeyrek/tam TL, ons USD);
  erişilemezse yedek olarak Yahoo Finance `GC=F` + `TRY=X` hesaplaması.
- **Haberler**: Google Haberler RSS (Türkçe, son 7 gün).
- **AI**: OpenAI uyumlu her sağlayıcı (NVIDIA NIM, OpenAI, OpenRouter, Groq,
  DeepSeek, EVREN/SSB ve özel adresler).

## Notlar

- Fiyatlar 15 dakika gecikmeli olabilir; Yahoo Finance verileri bilgi amaçlıdır.
- Bu uygulama **yatırım tavsiyesi değildir**. AI yorumları analiz amaçlıdır.
- Python yedek sunucusu temel özellikleri ve AI analizini sunar; gelişmiş
  formasyon taraması Node.js sunucusunda (`lib/patterns.js`) çalışır.
- BIST100 bileşimi değişebilir; `data/bist100.js` dosyasından güncellenir.
- AI API çağrıları için internet erişimi zorunludur.
- Uygulamayı başka kullanıcılara açarken **HTTPS** kullanın; API anahtarı AI
  isteklerinde başlık olarak taşınır ve sunucuda kalıcı saklanmaz.
