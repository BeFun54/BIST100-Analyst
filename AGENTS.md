# BIST100 Analyst — agent instructions

## Repo at a glance
BIST100 canli takip: hisse listesi, mum grafikleri, haberler ve teknik formasyon taramasi.
Iki ayni islevdeki sunucu vardir: Node.js (`server.js`, primary) ve Python stdlib (`server.py`, fallback).
Hic npm bagimliligi yoktur (`package.json` scripts sadece `start`).

## Git
- Remote: `https://github.com/BeFun54/BIST100-Analyst.git`
- Branch: `main`
- Zaten izlenmeyenler (`.gitignore`): `__pycache__/`, `*.pyc`, `.env`, `.env.local`, `node_modules/`, `*.log`

## Commands
- Baslat (Node): `node server.js`  (port: `PORT` env degiskeni, default `3000`)
- Baslat (Python, Node yoksa): `py server.py`  (aynı port)
- Windows baslatıcı: `BIST100 Baslat.bat`  (sunucuyu acar ve http://localhost:3000'i tarayici acar)
- Test / lint / typecheck / formatter: **yok** (hiç yapılandırılmamış)

## Environment (gerekli)
- `.env` dosyasi olusturulmalidir (`.env.example`'den kopyala) ve otomatik yuklenir (`lib/env.js` ve `server.py` icindeki `_load_env_file`). Icerigi:
  - `AI_API_KEY` — NVIDIA NIM API anahtari (`nvapi-...`)
  - `AI_API_BASE` — API base URL (default: `https://integrate.api.nvidia.com/v1/chat/completions`)
  - `AI_MODEL` — model id (default: `nvidia/nemotron-3.5-super-vl-120b-a12b`)
- **`.env` (gercek anahtar) asla commit edilmez** (`.gitignore` ile kapsanmis). `.env.example` yalnizca yer tutucu icerir.
- Internet erisimi zorunludur: Yahoo Finance, Google Haberler RSS ve AI API'si cagrilir.

## Kod yapisi (tek kaynak / giris noktalari)
- `server.js` — Node HTTP sunucu, tek giris noktasi (`package.json` `main`). API rotalari `/api/` altinda, digerleri `public/` statik.
- `server.py` — Python karsiligi (ayni API, stdlib only). `data/bist100.js`'yi regex ile ayristirir.
- `lib/ai.js` — AI istemcisi (NVIDIA NIM / Nemotron; `.env` otomatik yuklenir).
- `lib/env.js` — bagimliliksiz `.env` yukleyici (Node).
- `lib/yahoo.js` — Yahoo Finance proxy (CORS engeline karsi sunucu tarafi istek).
- `lib/news.js` — Google Haberler RSS istemcisi.
- `lib/patterns.js` — Klasik boga formasyonu tespit motoru (hafiza, internetten cekilmez).
- `data/bist100.js` — **Tek kaynak**: BIST100 hisse listesi. Degisiklik buraya yapilir.
- `public/` — Frontend (`index.html`, `app.js`, `styles.css`).

## API rotalari (sunucu calisirken)
- `GET /api/overview` — Tum BIST100 icin ozet (60 sn onbellekli)
- `GET /api/formations` — Boga formasyonlari (15 dk onbellekli)
- `GET /api/ai-formations` — Formasyon + AI dogrulama (30 dk onbellekli)
- `GET /api/chart?symbol=X&range=1y` — Mum grafiği (5 dk onbellekli)
- `GET /api/news?q=...` — Google Haberler (10 dk onbellekli)
- `GET /api/ai-analysis` — Piyasa yorumu (10 dk onbellekli)
- `GET /api/ai-analysis-stock?symbol=X` — Tek hisse yorumu

## Notalar / gotcha'lar
- `README.md` bozuk / binary — icerigine guvenme.
- AI API: NVIDIA NIM (OpenAI uyumlu `/v1/chat/completions`). Eski Evren platformu ve terim kabul akisi kaldirildi.
- Python sunucu `__pycache__/` ureterek calisir — zaten gitignore'da.
- Formasyon taramasi icin gunluk kapanis serisi en az 60 nokta istemektedir (`scanBullishPatterns`).
- API anahtari `process.env.AI_API_KEY || 'DEV_ONLY_PLACEHOLDER'` fallback'i ile calisir; gercek analiz icin `.env` (otomatik yuklenir) gerekli.