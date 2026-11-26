# BIST100 Analist V2 — agent instructions

## Repo at a glance
BIST100 canli takip: hisse listesi, mum grafikleri, haberler, gelismis teknik
formasyon taramasi ve haber destekli AI analizi.
Iki ayni islevdeki sunucu vardir: Node.js (`server.js`, primary) ve Python
stdlib (`server.py`, fallback). Hic npm bagimliligi yoktur.

## Git
- Remote: `https://github.com/BeFun54/BIST100-Analyst.git`
- Branch: `main`
- Zaten izlenmeyenler (`.gitignore`): `__pycache__/`, `*.pyc`, `.env`, `.env.local`, `node_modules/`, `*.log`

## Commands
- Baslat (Node): `node server.js`  (port: `PORT` env degiskeni, default `3010`)
- Baslat (Python, Node yoksa): `py server.py`  (ayni port)
- Windows baslatici: `BIST100 Baslat.bat`  (Node sunucusunu acar ve tarayiciyi baslatir)
- Test / lint / typecheck / formatter: **yok**
- Hizli sozdizimi kontrolu: `node --check server.js`, `py -m py_compile server.py`

## Environment (opsiyonel)
- Anahtar oncelikli olarak **uygulama icinden** (`🔑 API Ayarlari`) girilir ve
  tarayicida (`localStorage: bist100_ai_config`) saklanir. AI isteklerinde
  `X-AI-Key`, `X-AI-Base`, `X-AI-Model`, `X-AI-Provider` basliklariyla sunucuya
  gonderilir; sunucu anahtari kalici saklamaz.
- Sunucu geneli varsayilan icin `.env` (otomatik yuklenir):
  - `AI_API_KEY` — EVREN (`evren_llm_...`) veya NVIDIA (`nvapi-...`) anahtari
  - `AI_API_BASE` — default: `https://integrate.api.nvidia.com/v1/chat/completions`
  - `AI_MODEL` — default: `nvidia/nemotron-3.5-super-vl-120b-a12b`
- **EVREN**: `https://evren-llmapi.ssyz.org.tr/v1/chat/completions`, model `auto`
  (veya `glm-5.3`, `deepseek-v4.1-flash`, `mimo-v2.6-pro`, `qwen3.8-flash-next`,
  `gemma-4-31b`, `qwen3-vl-30b`).
- EVREN'in zorunlu kullanim sartlari akisi `lib/ai.js` icinde otomatik yonetilir:
  `/v1/terms/status` -> `/v1/terms/accept`; 403 `terms_not_accepted` alinirsa
  bir kez onaylanip istek tekrarlanir.
- Reasoning modellerinde (`deepseek-v4.1-flash`, `glm-5.3`, nemotron vb.)
  `max_tokens` dusuk verilirse `message.content` bos kalir; analizlerde 8000,
  testte 2048 kullanilir. `extractText` reasoning fallback'i icerir.
- `.env` (gercek anahtar) asla commit edilmez. Internet erisimi zorunludur.

## Kod yapisi
- `server.js` — Node HTTP sunucu, tek giris noktasi. API rotalari `/api/` altinda.
- `server.py` — Python karsiligi (ayni API, stdlib only). Gelismis formasyon
  motoru yoktur; temel/AI ozellikleri sunar.
- `lib/ai.js` — AI istemcisi: saglayici algilama, EVREN terms akisi, per-request
  anahtar, model listesi, formasyon dogrulama, haber destekli promptlar.
- `lib/patterns.js` — v2 formasyon motoru: trend/geometri/ kirilim tazeligi
  kontrolleri, bayrak/kama duzeltmeleri, RSI/SMA/ATR gostergeleri.
- `lib/yahoo.js` — Yahoo Finance proxy. `lib/gold.js` — Altin kaynagi:
  Truncgil Finans `today.json` (dogrudan gram/ceyrek/tam TL, ons USD) +
  Yahoo `GC=F`/`TRY=X` yedek hesaplamasi.
  `lib/news.js` — Google Haberler RSS.
- `data/bist100.js` — **Tek kaynak**: BIST100 sembol listesi.
- `public/index.html` — Arayuz; `styles.css` temel tema, `glass.css` Apple
  Liquid Glass katmani (yerlesimi degistirmez).
- `public/app.js` — Istemci: liste/grafik/haber/portfoy, tarayici bazli API
  anahtari, AI pencereleri, grafikten varlik ekleme.

## API rotalari (sunucu calisirken)
- `GET /api/overview` — Tum BIST100 ozet (60 sn)
- `GET /api/formations?dir=bullish|bearish|all` — Formasyon taramasi (15 dk)
- `GET /api/gold` — Altin: Truncgil Finans dogrudan fiyatlar (60 sn)
- `GET /api/ai-formations?dir=...&fresh=1` — AI dogrulama/karsilastirma
  (30 dk, anahtar imzasina gore onbellek)
- `GET /api/chart?symbol=X&range=1y` — Mum grafigi (5 dk)
- `GET /api/news?symbol=X` — Google Haberler (10 dk)
- `GET /api/ai-analysis` — Piyasa analizi (10 dk, anahtar bazli)
- `GET /api/ai-analysis-stock?symbol=X&horizon=all|short|long` — Hisse analizi
- `GET /api/ai-models` — Hesaba tanimli modeller (`/v1/models`)
- `GET /api/ai-config` — Sunucu varsayilan ayar durumu (anahtar gizli)
- `POST /api/ai-test` — Baglanti testi (anahtar basliklardan veya govdeden)

## Notalar / gotcha'lar
- Formasyon taramasi icin gunluk kapanis serisi en az 60 nokta ister; Golden/Death
  Cross 210 nokta ister.
- AI anahtari yoksa `/api/ai-*` rotalari `400 {code:"ai_key_missing"}` doner;
  arayuz kural tabanli formasyon sonuclarini koruyup anahtar penceresini acar.
- AI yanitlari anahtar + base + model imzasina gore onbelleklenir; farkli
  kullanicilarin sonuclari karismaz. `fresh=1` onbellegi atlar.
- Grafikten varlik ekleme formu `buildChartAddForm` ile ana listede ve buyutme
  modalinda aynidir; alis fiyati guncel fiyatla on dolar.
- Tema `public/glass.css` icinde; yeni bilesen eklerken once buradaki cam
  degiskenlerini kullanin.
- Altin `/api/gold` 60 sn onbellekli; birincil kaynak Truncgil Finans
  `today.json`, yedek Yahoo `GC=F`/`TRY=X`. Ons degeri USD/ons'tur, TL'ye
  cevrilmez; panelde "$" ile gosterilir.
