# -*- coding: utf-8 -*-
"""
BIST100 Analist V2 - Python ile yazilmis alternatif sunucu (sadece standart kutuphane).

server.js ile birebir ayni API'yi sunar; Node.js kurulu olmayan ortamlarda
"py server.py" ile calistirilabilir.

API:
  GET /api/overview          -> tum BIST100 hisseleri icin anlik ozet
  GET /api/chart?symbol=&range=  -> mum grafigi (OHLC) verisi
  GET /api/news?symbol=|?q=  -> son 7 gunun haberleri (Google Haberler RSS)
  GET /*                     -> public/ altindaki statik dosyalar
"""

import http.server
import json
import os
import re
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from email.utils import parsedate_to_datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
BIST_FILE = os.path.join(BASE_DIR, "data", "bist100.js")


def _load_env_file(path=None):
    """Proje kokundeki .env dosyasini yukler (harici bagimlilik yok).

    Zaten tanimli ortam degiskenlerini EZMEZ; .env yoksa sessizce gecer.
    """
    if path is None:
        path = os.path.join(BASE_DIR, ".env")
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


_load_env_file()

PORT = int(os.environ.get("PORT", "3010"))


def _load_bist100():
    """data/bist100.js tek kaynak kabul edilir; ayristirilir."""
    with open(BIST_FILE, "r", encoding="utf-8") as f:
        src = f.read()
    rows = re.findall(r"\[\s*'([A-Z0-9]+)'\s*,\s*'([^']*)'\s*\]", src)
    return [{"symbol": s, "name": n, "yahoo": s + ".IS"} for s, n in rows]


BIST100 = _load_bist100()
BY_SYMBOL = {s["symbol"]: s for s in BIST100}


UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

RANGE_MAP = {
    "5y": ("5y", "1wk"),
    "1y": ("1y", "1d"),
    "6mo": ("6mo", "1d"),
    "1mo": ("1mo", "1d"),
    "1d": ("1d", "5m"),
}

_crumb_lock = threading.Lock()
_cookie = ""
_crumb = ""
_crumb_at = 0.0
CRUMB_TTL = 30 * 60


def http_get(url, headers=None, timeout=20):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as he:
        resp = he
    body = resp.read().decode("utf-8", "replace")
    return resp.status if hasattr(resp, "status") else resp.code, resp.headers, body


def ensure_crumb():
    global _cookie, _crumb, _crumb_at
    if _crumb and (time.time() - _crumb_at) < CRUMB_TTL:
        return _crumb
    with _crumb_lock:
        if _crumb and (time.time() - _crumb_at) < CRUMB_TTL:
            return _crumb
        try:
            status, headers, _ = http_get("https://fc.yahoo.com/", timeout=12)
            sc = headers.get_all("Set-Cookie") or []
            cookie = "; ".join(c.split(";")[0] for c in sc)
            _cookie = cookie
            status, headers, body = http_get(
                "https://query1.finance.yahoo.com/v1/test/getcrumb",
                headers={"User-Agent": UA, "Cookie": cookie}, timeout=12)
            body = body.strip()
            if status == 200 and body and len(body) < 40 and "<" not in body:
                _crumb = body
                _crumb_at = time.time()
        except Exception:
            pass
    return _crumb


def _auth_query():
    parts = []
    if _crumb:
        parts.append("crumb=" + urllib.parse.quote(_crumb))
    parts.append("corsDomain=finance.yahoo.com")
    parts.append("formatted=false")
    return "&".join(parts)


def _auth_headers():
    return {"User-Agent": UA, "Cookie": _cookie} if _cookie else {"User-Agent": UA}


# ------------------------------------------------------------------ #
#  Yardimcilar
# ------------------------------------------------------------------ #

def rnd(n, d=2):
    if n is None or not isinstance(n, (int, float)):
        return None
    try:
        import math
        if math.isnan(n) or math.isinf(n):
            return None
    except Exception:
        pass
    return round(n, d)


def pct_change(frm, to):
    if frm is None or to is None or frm == 0:
        return None
    return rnd((to - frm) / frm * 100, 2)


def close_ago(points, back):
    if not points:
        return None
    idx = len(points) - 1 - back
    if idx < 0:
        return points[0]["c"]
    return points[idx]["c"]


# ------------------------------------------------------------------ #
#  Yahoo uclari
# ------------------------------------------------------------------ #

SPARK_BATCH = 20   # Yahoo spark: en fazla 20 sembol
QUOTE_BATCH = 50   # Yahoo quote: makul parca boyutu


def _safe(fn):
    try:
        return fn()
    except Exception:
        return {}


def yahoo_spark(symbols, rng="1mo", interval="1d"):
    chunks = [symbols[i:i + SPARK_BATCH]
              for i in range(0, len(symbols), SPARK_BATCH)]
    out = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for part in ex.map(lambda c: _safe(lambda: _spark_once(c, rng, interval)),
                           chunks):
            if part:
                out.update(part)
    return out


def _spark_once(symbols, rng="1mo", interval="1d"):
    ensure_crumb()
    url = ("https://query1.finance.yahoo.com/v7/finance/spark?symbols="
           + ",".join(symbols) + "&range=" + rng + "&interval=" + interval
           + "&indicators=close&" + _auth_query())
    status, headers, body = http_get(url, headers=_auth_headers(), timeout=25)
    j = json.loads(body)
    out = {}
    for r in j.get("spark", {}).get("result", []):
        resp = (r.get("response") or [None])[0]
        if not resp:
            continue
        ts = resp.get("timestamp", [])
        closes = (((resp.get("indicators") or {}).get("quote") or [{}])[0]
                  .get("close")) or []
        points = []
        for t, c in zip(ts, closes):
            if c is not None:
                points.append({"t": t, "c": c})
        out[r.get("symbol")] = {"meta": resp.get("meta") or {}, "points": points}
    return out


def yahoo_quotes(symbols):
    chunks = [symbols[i:i + QUOTE_BATCH]
              for i in range(0, len(symbols), QUOTE_BATCH)]
    out = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for part in ex.map(lambda c: _safe(lambda: _quotes_once(c)), chunks):
            if part:
                out.update(part)
    return out


def _quotes_once(symbols):
    ensure_crumb()
    url = ("https://query1.finance.yahoo.com/v7/finance/quote?symbols="
           + ",".join(symbols) + "&" + _auth_query())
    status, headers, body = http_get(url, headers=_auth_headers(), timeout=25)
    j = json.loads(body)
    out = {}
    for q in j.get("quoteResponse", {}).get("result", []):
        out[q.get("symbol")] = q
    return out


def yahoo_chart(symbol, range_key):
    rng, interval = RANGE_MAP.get(range_key, RANGE_MAP["1y"])
    ensure_crumb()
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           + urllib.parse.quote(symbol) + "?range=" + rng + "&interval="
           + interval + "&includePrePost=false&events=div%2Csplit")
    status, headers, body = http_get(url, headers=_auth_headers(), timeout=25)
    j = json.loads(body)
    result = (j.get("chart", {}).get("result") or [None])[0]
    if not result:
        raise RuntimeError("Grafik verisi bulunamadi: " + symbol)
    ts = result.get("timestamp", [])
    q = (((result.get("indicators") or {}).get("quote") or [{}])[0])
    opens = q.get("open") or []
    highs = q.get("high") or []
    lows = q.get("low") or []
    closes = q.get("close") or []
    vols = q.get("volume") or []
    candles = []
    for i, t in enumerate(ts):
        o = opens[i] if i < len(opens) else None
        h = highs[i] if i < len(highs) else None
        l = lows[i] if i < len(lows) else None
        c = closes[i] if i < len(closes) else None
        if o is None or h is None or l is None or c is None:
            continue
        v = vols[i] if (i < len(vols) and vols[i] is not None) else 0
        candles.append({"t": t * 1000, "o": o, "h": h, "l": l, "c": c, "v": v})
    meta = result.get("meta") or {}
    return {
        "symbol": symbol,
        "range": range_key,
        "interval": interval,
        "currency": meta.get("currency", "TRY"),
        "previousClose": meta.get("chartPreviousClose") or meta.get("previousClose"),
        "candles": candles,
    }


# ------------------------------------------------------------------ #
#  Genel bakis (tum BIST100)
# ------------------------------------------------------------------ #

def build_overview():
    symbols = [s["yahoo"] for s in BIST100]
    try:
        spark = yahoo_spark(symbols, "1mo", "1d")
    except Exception:
        spark = {}
    try:
        quotes = yahoo_quotes(symbols)
    except Exception:
        quotes = {}

    items = []
    for st in BIST100:
        sp = spark.get(st["yahoo"])
        q = quotes.get(st["yahoo"], {}) or {}
        points = sp["points"] if sp else []
        meta = sp["meta"] if sp else {}

        last = points[-1]["c"] if points else None
        prev = close_ago(points, 1)

        price = q.get("regularMarketPrice")
        if price is None:
            price = meta.get("regularMarketPrice")
        if price is None:
            price = last

        if q.get("regularMarketChangePercent") is not None:
            change_pct = rnd(q.get("regularMarketChangePercent"), 2)
        else:
            change_pct = pct_change(prev, price)

        if q.get("regularMarketChange") is not None:
            change = rnd(q.get("regularMarketChange"), 2)
        elif price is not None and prev is not None:
            change = rnd(price - prev, 2)
        else:
            change = None

        week_base = close_ago(points, 5)
        month_base = close_ago(points, 21)

        items.append({
            "symbol": st["symbol"],
            "name": q.get("longName") or q.get("shortName") or st["name"],
            "price": rnd(price, 2),
            "change": change,
            "changePercent": change_pct,
            "weekChangePercent": pct_change(week_base, price),
            "monthChangePercent": pct_change(month_base, price),
            "volume": q.get("regularMarketVolume"),
            "marketCap": q.get("marketCap"),
            "dayHigh": q.get("regularMarketDayHigh", meta.get("regularMarketDayHigh")),
            "dayLow": q.get("regularMarketDayLow", meta.get("regularMarketDayLow")),
            "sparkline": [rnd(p["c"], 2) for p in points[-30:]],
        })

    return {"updatedAt": int(time.time() * 1000), "items": items}


# ------------------------------------------------------------------ #
#  Haberler (Google Haberler RSS)
# ------------------------------------------------------------------ #

_ENTITIES = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
    "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&hellip;": "\u2026",
    "&mdash;": "\u2014", "&ndash;": "\u2013", "&rsquo;": "\u2019",
    "&lsquo;": "\u2018", "&ldquo;": "\u201c", "&rdquo;": "\u201d",
}


def _decode(s):
    if not s:
        return ""
    s = re.sub(r"<!\[CDATA\[([\s\S]*?)\]\]>", r"\1", s)
    s = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), s)
    s = re.sub(r"&#x([0-9a-fA-F]+);", lambda m: chr(int(m.group(1), 16)), s)

    def repl(m):
        return _ENTITIES.get(m.group(0).lower(), m.group(0))

    s = re.sub(r"&[a-zA-Z#0-9]+;", repl, s)
    return re.sub(r"\s+", " ", s).strip()


def _tag(item, tag):
    m = re.search(r"<" + tag + r"[^>]*>([\s\S]*?)</" + tag + r">", item, re.I)
    return _decode(m.group(1)) if m else ""


def get_news(query, days=7, limit=24):
    url = ("https://news.google.com/rss/search?q=" + urllib.parse.quote(query)
           + "&hl=tr&gl=TR&ceid=TR:tr")
    status, headers, xml = http_get(url, timeout=20)

    items = []
    for raw in re.findall(r"<item[\s>][\s\S]*?</item>", xml, re.I):
        title = _tag(raw, "title")
        link = _tag(raw, "link")
        if not title or not link:
            continue
        pub = _tag(raw, "pubDate")
        iso = None
        if pub:
            try:
                iso = parsedate_to_datetime(pub).isoformat()
            except Exception:
                iso = None
        items.append({
            "title": title,
            "link": link,
            "source": _tag(raw, "source"),
            "publishedAt": iso,
            "summary": re.sub(r"<[^>]+>", "", _tag(raw, "description"))[:300],
        })

    cutoff = time.time() - days * 86400
    fresh = []
    for it in items:
        if not it["publishedAt"]:
            fresh.append(it)
            continue
        try:
            if parsedate_to_datetime(it["publishedAt"]).timestamp() >= cutoff:
                fresh.append(it)
        except Exception:
            fresh.append(it)

    return (fresh or items)[:limit]


# ------------------------------------------------------------------ #
#  Onbellek
# ------------------------------------------------------------------ #

_cache = {}
_cache_lock = threading.Lock()


def cache_get(key):
    with _cache_lock:
        hit = _cache.get(key)
    if not hit:
        return None
    if hit[0] < time.time():
        with _cache_lock:
            _cache.pop(key, None)
        return None
    return hit[1]


def cache_set(key, value, ttl):
    with _cache_lock:
        _cache[key] = (time.time() + ttl, value)
    return value


# ------------------------------------------------------------------ #
#  AI Analiz (EVREN / NVIDIA / OpenAI uyumlu)
# ------------------------------------------------------------------ #

import hashlib

AI_API_KEY = os.environ.get('AI_API_KEY', '')
AI_API_BASE = os.environ.get('AI_API_BASE', 'https://integrate.api.nvidia.com/v1/chat/completions')
AI_MODEL = os.environ.get('AI_MODEL', 'nvidia/nemotron-3.5-super-vl-120b-a12b')

DEFAULT_AI_BASE = 'https://integrate.api.nvidia.com/v1/chat/completions'
DEFAULT_AI_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b'
_terms_cache = {}
_terms_lock = threading.Lock()

ANALYST_SYSTEM = (
    'Sen BIST100 (Borsa Istanbul) uzmani, deneyimli bir finansal analistsin. '
    'Turkce, net, objektif ve veriye dayali yaz. Yatirim tavsiyesi verme; "al", "sat", '
    '"pozisyon ac/kapat" gibi ifadeler kullanma. Sadece analiz, olasi senaryo ve riskleri '
    'acikla. Uydurma veri veya haber ekleme; yalnizca sana verilen verileri kullan. '
    'Cevabin sonunda mutlaka "Bu bir yatirim tavsiyesi degildir." yaz.'
)


def normalize_chat_url(raw):
    base = (raw or '').strip().rstrip('/')
    if not base:
        return ''
    if not re.match(r'^https?://', base, re.I):
        base = 'https://' + base
    if re.search(r'/chat/completions$', base, re.I):
        return base
    if re.search(r'/v\d+(\.\d+)?$', base, re.I):
        return base + '/chat/completions'
    if re.search(r'/v\d+/', base, re.I):
        return base + '/chat/completions'
    return base + '/v1/chat/completions'


def models_url(raw):
    base = normalize_chat_url(raw)
    if not base:
        return ''
    m = re.match(r'^(https?://[^/]+)(.*)$', base, re.I)
    if not m:
        return base
    origin, path = m.group(1), m.group(2)
    path = re.sub(r'/chat/completions$', '', path, flags=re.I)
    vm = re.match(r'^(.*?/v\d+(?:\.\d+)?)(?:/.*)?$', path, re.I)
    if vm:
        path = vm.group(1)
    return origin + path + '/models'


def detect_provider(api_key, api_base):
    k = (api_key or '').lower()
    b = (api_base or '').lower()
    if k.startswith('evren_llm_') or 'evren-llmapi.ssyz.org.tr' in b:
        return 'evren'
    if k.startswith('nvapi-') or 'integrate.api.nvidia.com' in b:
        return 'nvidia'
    if k.startswith('gsk_') or 'groq.com' in b:
        return 'groq'
    if 'openrouter.ai' in b:
        return 'openrouter'
    if 'deepseek.com' in b:
        return 'deepseek'
    if 'api.openai.com' in b:
        return 'openai'
    return 'custom'


def default_model_for(provider):
    return {
        'evren': 'auto',
        'nvidia': DEFAULT_AI_MODEL,
        'openai': 'gpt-4o',
        'openrouter': 'openai/gpt-4o',
        'groq': 'llama-3.1-405b-instruct',
        'deepseek': 'deepseek-chat',
    }.get(provider, DEFAULT_AI_MODEL)


def _env_key():
    key = os.environ.get('AI_API_KEY', '')
    return '' if key == 'DEV_ONLY_PLACEHOLDER' else key


def resolve_ai_config(overrides=None):
    o = overrides or {}
    api_key = str(o.get('apiKey') or _env_key() or '').strip()
    raw_base = str(o.get('apiBase') or os.environ.get('AI_API_BASE') or '').strip().rstrip('/')
    provider = str(o.get('provider') or detect_provider(api_key, raw_base)).strip() or 'nvidia'
    if provider == 'custom' and not raw_base and not api_key:
        provider = 'nvidia'
    api_base = normalize_chat_url(raw_base or DEFAULT_AI_BASE)
    model = (str(o.get('model') or os.environ.get('AI_MODEL') or '').strip()
             or default_model_for(provider))
    is_evren = (provider == 'evren'
                or 'evren-llmapi.ssyz.org.tr' in api_base
                or api_key.lower().startswith('evren_llm_'))
    return {'api_key': api_key, 'api_base': api_base, 'model': model,
            'provider': provider, 'is_evren': is_evren}


def ai_config_from_request(headers, body=None):
    b = body or {}

    def hv(name):
        try:
            return (headers.get(name) or '').strip()
        except Exception:
            return ''

    return resolve_ai_config({
        'apiKey': b.get('apiKey') or hv('X-AI-Key'),
        'apiBase': b.get('apiBase') or hv('X-AI-Base'),
        'model': b.get('model') or hv('X-AI-Model'),
        'provider': b.get('provider') or hv('X-AI-Provider'),
    })


def ai_public_config():
    """Arayuze donen genel ayar durumu; API anahtari asla gosterilmez."""
    c = resolve_ai_config({})
    return {
        'configured': bool(c['api_key']),
        'provider': c['provider'],
        'apiBase': c['api_base'],
        'model': c['model'],
        'source': 'server',
    }


def ai_set_config(api_key, api_base=None, model=None):
    """Calisma aninda AI ayarlarini gunceller (sadece bu surec icin gecerli)."""
    global AI_API_KEY, AI_API_BASE, AI_MODEL
    if not api_key or not str(api_key).strip():
        raise ValueError('API anahtari bos olamaz')
    AI_API_KEY = str(api_key).strip()
    if api_base:
        AI_API_BASE = normalize_chat_url(str(api_base))
    if model:
        AI_MODEL = str(model).strip()
    os.environ['AI_API_KEY'] = AI_API_KEY
    os.environ['AI_API_BASE'] = AI_API_BASE
    os.environ['AI_MODEL'] = AI_MODEL
    return ai_public_config()


def _friendly_error(status, raw):
    text = (raw or '')[:600]
    try:
        j = json.loads(raw)
        err = j.get('error')
        if isinstance(err, dict):
            text = str(err.get('message') or err.get('code') or text)
        elif err:
            text = str(err)
        elif j.get('message') or j.get('detail'):
            text = str(j.get('message') or j.get('detail'))
    except Exception:
        pass
    if status == 401:
        return 'API anahtari gecersiz veya yetkisiz (HTTP 401). Anahtari kontrol edin.'
    if status == 402:
        return 'API kredisi/quotasi yetersiz (HTTP 402).'
    if status == 403 and 'terms' in text.lower():
        return 'EVREN kullanim sartlari onaylanmamis. Otomatik onay denendi ancak basarisiz oldu.'
    if status == 403:
        return 'Erisim reddedildi (HTTP 403): ' + text
    if status == 404:
        return 'Sunucu adresi veya model bulunamadi (HTTP 404). Base URL ve modeli kontrol edin.'
    if status == 429:
        return 'Kota/hiz siniri asildi (HTTP 429). Kisa bir sure sonra tekrar deneyin.'
    if status in (502, 503):
        return 'AI saglayicisi su anda yogun (HTTP ' + str(status) + '). Tekrar deneyin.'
    return 'AI API hatasi (HTTP ' + str(status) + '): ' + text


def http_json(method, url, body, cfg, timeout=120):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    headers = {'Accept': 'application/json',
               'User-Agent': 'BIST100-Analist-V2-Python/2.0'}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    if cfg.get('api_key'):
        headers['Authorization'] = 'Bearer ' + cfg['api_key']
        if cfg.get('is_evren'):
            headers['X-API-Key'] = cfg['api_key']
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode('utf-8', 'replace')
            status = resp.status
    except urllib.error.HTTPError as he:
        raw = he.read().decode('utf-8', 'replace')
        status = he.code
    except Exception as e:
        raise RuntimeError('AI sunucusuna baglanilamadi: ' + str(e))
    try:
        parsed = json.loads(raw)
    except Exception:
        parsed = None
    return status, parsed, raw


def ensure_evren_terms(cfg, force=False):
    if not cfg.get('is_evren') or not cfg.get('api_key'):
        return
    cache_key = hashlib.sha1(
        (cfg['api_key'] + '|' + cfg['api_base']).encode('utf-8')).hexdigest()
    with _terms_lock:
        if not force and cache_key in _terms_cache:
            return
    try:
        origin = re.match(r'^(https?://[^/]+)', cfg['api_base']).group(1)
    except Exception:
        origin = 'https://evren-llmapi.ssyz.org.tr'
    try:
        status, parsed, raw = http_json('GET', origin + '/v1/terms/status',
                                        None, cfg, timeout=20)
        version = 1
        accepted = False
        if isinstance(parsed, dict):
            version = int(parsed.get('current_version') or 1)
            accepted = parsed.get('accepted') is True
        if not accepted and 200 <= status < 300:
            st2, p2, raw2 = http_json('POST', origin + '/v1/terms/accept',
                                      {'version': version}, cfg, timeout=20)
            accepted = 200 <= st2 < 300
        if accepted:
            with _terms_lock:
                _terms_cache[cache_key] = time.time()
    except Exception:
        pass


def post_chat(cfg, payload, timeout=240, retries=1):
    if not cfg.get('api_key'):
        raise RuntimeError('AI API anahtari girilmedi.')
    ensure_evren_terms(cfg)
    attempt = 0
    forced = False
    while True:
        status, parsed, raw = http_json('POST', cfg['api_base'], payload, cfg,
                                        timeout=timeout)
        if 200 <= status < 300 and isinstance(parsed, dict):
            if parsed.get('error') and not parsed.get('choices'):
                raise RuntimeError(_friendly_error(status, raw))
            return parsed
        if status == 403 and cfg.get('is_evren') and not forced:
            ensure_evren_terms(cfg, force=True)
            forced = True
            continue
        if status in (429, 502, 503, 504) and attempt < retries:
            attempt += 1
            time.sleep(2.0 if status == 429 else 1.2)
            continue
        raise RuntimeError(_friendly_error(status, raw))


def ai_list_models(cfg):
    if not cfg.get('api_key'):
        raise RuntimeError('Model listesi icin API anahtari gerekli.')
    ensure_evren_terms(cfg)
    status, parsed, raw = http_json('GET', models_url(cfg['api_base']), None, cfg,
                                    timeout=30)
    if not (200 <= status < 300) or not isinstance(parsed, dict):
        raise RuntimeError(_friendly_error(status, raw))
    data = parsed.get('data') or parsed.get('models') or []
    models = []
    for item in data:
        if isinstance(item, str):
            mid = item
            task = 'chat'
        else:
            mid = item.get('id') or item.get('name')
            task = item.get('task') or 'chat'
        if not mid:
            continue
        if task and task not in ('chat', 'text'):
            continue
        models.append({'id': mid, 'label': mid, 'task': task})
    return {'models': models, 'provider': cfg['provider'],
            'apiBase': cfg['api_base'], 'model': cfg['model']}


def ai_test_connection(cfg=None):
    cfg = cfg or resolve_ai_config({})
    if not cfg.get('api_key'):
        raise RuntimeError('API anahtari girilmedi.')
    count = None
    try:
        count = len(ai_list_models(cfg).get('models') or [])
    except Exception:
        pass
    j = post_chat(cfg, {
        'model': cfg['model'],
        'messages': [{'role': 'user', 'content': 'Sadece "OK" yaz.'}],
        'temperature': 0,
        'max_tokens': 2048,
        'stream': False
    }, timeout=90)
    if not j.get('choices'):
        raise RuntimeError('AI sunucusu beklenen yaniti dondurmedi.')
    return {'ok': True, 'provider': cfg['provider'], 'apiBase': cfg['api_base'],
            'model': cfg['model'], 'modelCount': count}


def _extract_text(j):
    try:
        msg = j['choices'][0]['message']
    except Exception:
        return 'AI yorumu olusturulamadi (gecersiz yanit).'
    if msg.get('content'):
        return msg['content']
    if msg.get('reasoning_content') or msg.get('reasoning'):
        return msg.get('reasoning_content') or msg.get('reasoning')
    return 'AI yorumu olusturulamadi (bos yanit).'


def _sma(vals, n):
    if len(vals) < n:
        return None
    return sum(vals[-n:]) / n


def _rsi(vals, period=14):
    if len(vals) < period + 2:
        return None
    window = vals[-(period * 3 + 1):]
    gains, losses = [], []
    for i in range(1, len(window)):
        d = window[i] - window[i - 1]
        gains.append(max(d, 0))
        losses.append(max(-d, 0))
    if len(gains) < period:
        return None
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def _pct(a, b):
    if a in (None, 0) or b is None:
        return None
    return round((b - a) / a * 100, 2)


def _fmt_num(v, d=2):
    if v is None:
        return '—'
    try:
        return ('{:.%df}' % d).format(float(v))
    except Exception:
        return '—'


def _fmt_pct(v):
    if v is None:
        return '—'
    return ('+' if v > 0 else '') + _fmt_num(v) + '%'


def _news_lines(news_items, limit=10):
    lines = []
    for n in (news_items or [])[:limit]:
        date = 'tarih yok'
        if n.get('publishedAt'):
            date = str(n.get('publishedAt'))[:10]
        lines.append('- [' + date + '] '
                     + ((n.get('source') or '') + ': ' if n.get('source') else '')
                     + (n.get('title') or '')
                     + (' — ' + str(n.get('summary'))[:180] if n.get('summary') else ''))
    return lines or ['- Haber bulunamadi.']


def _build_stock_prompt(stock, candles, news_items, pattern=None):
    lines = []
    closes = [c['c'] for c in candles] if candles else []
    last = closes[-1] if closes else None
    lines.append('TARIH: ' + time.strftime('%d.%m.%Y'))
    lines.append('HISSE: ' + stock['symbol'] + ' (' + stock['name'] + ')')
    lines.append('Son fiyat: ' + _fmt_num(last) + ' TL')
    lines.append('Degisimler: gunluk ' + _fmt_pct(stock.get('dailyPct'))
                 + ' | haftalik ' + _fmt_pct(stock.get('weeklyPct')))
    if len(closes) > 21:
        lines.append('Aylik ' + _fmt_pct(_pct(closes[-22], last))
                     + ' | 3 aylik ' + _fmt_pct(_pct(closes[-64], last) if len(closes) > 64 else None))
    sma20, sma50, sma200 = _sma(closes, 20), _sma(closes, 50), _sma(closes, 200)
    rsi = _rsi(closes)
    lines.append('Gostergeler: SMA20 ' + _fmt_num(sma20) + ' | SMA50 ' + _fmt_num(sma50)
                 + ' | SMA200 ' + _fmt_num(sma200) + ' | RSI14 ' + _fmt_num(rsi, 1))
    if closes:
        hi, lo = max(closes), min(closes)
        lines.append('52h aralik: ' + _fmt_num(lo) + ' - ' + _fmt_num(hi))
        lines.append('Son 20 gunluk kapanis (eskiden yeniye): '
                     + ', '.join(_fmt_num(c) for c in closes[-20:]))
    if pattern:
        lines.append('Tespit edilen formasyon: ' + str(pattern.get('name', ''))
                     + ' (' + str(pattern.get('type', '')) + ')')
        lines.append('Formasyon detayi: ' + str(pattern.get('description', '')))
    lines.append('')
    lines.append('SON HABERLER (son 7 gun):')
    lines.extend(_news_lines(news_items, 8))
    lines.append('')
    lines.append(
        'GOREV: Haberleri fiyat verisiyle iliskilendir; her haberin olasi etkisini '
        '(pozitif/negatif/notr) ve nedenini acikla. Yaniti su basliklarla Markdown olarak ver:\n'
        '## 📌 Kisa Ozet\n'
        '## 📰 Haberler ve Olasi Etkileri\n'
        '## 📐 Teknik Gorunum ve Formasyonlar\n'
        '## 🎯 Yakin Vadeli Tahmin (1-4 Hafta)\n'
        '## 🔭 Uzak Vadeli Tahmin (3-12 Ay)\n'
        '## ⚠️ Riskler ve Senaryolar\n'
        'Yakin vade icin yon, hedef/destek fiyat bantlari ve tetikleyiciler; uzak vade icin '
        'trend projeksiyonu ve riskler ver. Kesin al/sat tavsiyesi verme.')
    return '\n'.join(lines)


def _build_market_prompt(overview_items, news_items, gold=None):
    lines = []
    lines.append('TARIH: ' + time.strftime('%d.%m.%Y'))
    lines.append('BIST100 PIYASA GENEL DURUMU')
    up = sum(1 for s in overview_items
             if s.get('changePercent') is not None and s['changePercent'] > 0)
    down = sum(1 for s in overview_items
               if s.get('changePercent') is not None and s['changePercent'] < 0)
    flat = len(overview_items) - up - down
    lines.append('Toplam hisse: ' + str(len(overview_items)) + ' | Yukselen: '
                 + str(up) + ' | Dusen: ' + str(down) + ' | Yatay: ' + str(flat))
    sorted_items = sorted(
        [s for s in overview_items if s.get('changePercent') is not None],
        key=lambda s: s['changePercent'], reverse=True)
    lines.append('Gunun en cok yukselenleri: ' + ', '.join(
        s['symbol'] + ' (' + _fmt_pct(s['changePercent']) + ')' for s in sorted_items[:6]))
    lines.append('Gunun en cok dusenleri: ' + ', '.join(
        s['symbol'] + ' (' + _fmt_pct(s['changePercent']) + ')' for s in sorted_items[-6:]))
    week = sorted([s for s in overview_items if s.get('weekChangePercent') is not None],
                  key=lambda s: s['weekChangePercent'], reverse=True)
    if week:
        lines.append('Haftanin liderleri: ' + ', '.join(
            s['symbol'] + ' (' + _fmt_pct(s['weekChangePercent']) + ')' for s in week[:5]))
        lines.append('Haftanin en cok dusenleri: ' + ', '.join(
            s['symbol'] + ' (' + _fmt_pct(s['weekChangePercent']) + ')' for s in week[-5:]))
    if gold:
        ons_usd = gold.get("onsUsd")
        ons_text = (
            ("$" + _fmt_num(ons_usd))
            if ons_usd is not None
            else (("TL " + _fmt_num(gold.get("onsTry"))) if gold.get("onsTry") is not None else "—")
        )
        lines.append(
            "Altin (" + (gold.get("sourceLabel") or "kaynak") + ", satis): gram "
            + _fmt_num(gold.get("gram")) + " TL | ceyrek "
            + _fmt_num(gold.get("ceyrek")) + " TL | tam "
            + _fmt_num(gold.get("tam")) + " TL | ons " + ons_text
            + " | USD/TRY " + _fmt_num(gold.get("usdTry"), 4)
        )
        ch = gold.get("changes") or {}
        if any(ch.get(k) is not None for k in ("gram", "ceyrek", "tam", "ons")):
            lines.append(
                "Altin gunluk degisim: gram " + _fmt_pct(ch.get("gram"))
                + " · ceyrek " + _fmt_pct(ch.get("ceyrek"))
                + " · tam " + _fmt_pct(ch.get("tam"))
                + " · ons " + _fmt_pct(ch.get("ons"))
            )
    lines.append('')
    lines.append('SON HABERLER (son 7 gun):')
    lines.extend(_news_lines(news_items, 12))
    lines.append('')
    lines.append(
        'GOREV: Fiyat hareketlerini ve haberleri birlikte degerlendir. Haberlerin piyasa '
        'uzerindeki olasi etkisini somut bicimde acikla. Yaniti su basliklarla Markdown olarak ver:\n'
        '## 📌 Piyasa Ozeti\n'
        '## 📰 Haber Akisi ve Etkisi\n'
        '## 📈 Yakin Vadeli Gorunum (1-4 Hafta)\n'
        '## 🔭 Uzak Vadeli Gorunum (3-12 Ay)\n'
        '## ⚠️ Riskler ve Senaryolar\n'
        'Somut rakamlar kullan; kesin al/sat tavsiyesi verme.')
    return '\n'.join(lines)


def ai_analyze_market(overview_items, news_items, cfg=None, gold=None):
    cfg = cfg or resolve_ai_config({})
    prompt = _build_market_prompt(overview_items, news_items, gold)
    j = post_chat(cfg, {
        'model': cfg['model'],
        'messages': [
            {'role': 'system', 'content': ANALYST_SYSTEM},
            {'role': 'user', 'content': prompt}
        ],
        'temperature': 0.35,
        'max_tokens': 8000,
        'stream': False
    })
    return {'updatedAt': int(time.time() * 1000), 'summary': _extract_text(j),
            'provider': cfg['provider'], 'model': cfg['model']}


def ai_analyze_stock(symbol, candles, news_items, pattern=None, cfg=None):
    cfg = cfg or resolve_ai_config({})
    st = BY_SYMBOL.get(symbol)
    if not st:
        raise ValueError('Bilinmeyen sembol: ' + symbol)

    last_close = None
    daily_pct = None
    weekly_pct = None
    volume = None
    if candles:
        last_close = candles[-1]['c']
        if len(candles) >= 2:
            daily_pct = rnd((candles[-1]['c'] - candles[-2]['c']) / candles[-2]['c'] * 100, 2)
        idx = max(0, len(candles) - 6)
        weekly_pct = rnd((candles[-1]['c'] - candles[idx]['c']) / candles[idx]['c'] * 100, 2)
        volume = candles[-1].get('v', 0)

    prompt = _build_stock_prompt({
        'symbol': st['symbol'],
        'name': st['name'],
        'lastClose': last_close,
        'dailyPct': daily_pct,
        'weeklyPct': weekly_pct,
        'volume': volume
    }, candles, news_items, pattern)

    j = post_chat(cfg, {
        'model': cfg['model'],
        'messages': [
            {'role': 'system', 'content': ANALYST_SYSTEM},
            {'role': 'user', 'content': prompt}
        ],
        'temperature': 0.35,
        'max_tokens': 8000,
        'stream': False
    })
    return _extract_text(j)


VALIDATION_SYSTEM = (
    'Sen BIST100 teknik analiz dogrulayicisisin. Sana kural tabanli tarama motorunun '
    'buldugu formasyon adaylari JSON olarak verilecek. Her adayi gercek fiyat serisine '
    '(recentCloses) ve gostergelere bakarak bagimsiz degerlendir. Kurallar: '
    '(1) hedef buyuklugu aylik %1-35 araliginda olmali; (2) fiyat yapisi desteklemiyorsa '
    '"reject"; (3) yapi var ama hedef/guven abartiliysa "adjust"; adjust kararinda '
    'adjustedUpsidePct orijinal upsidePct degerinden BUYUK OLMASIN, yalnizca dusur veya '
    'ayni birak; adjustedConfidence da orijinalden buyuk olmasin; (4) yapi netse "approve"; '
    '(5) benzer yapilara benzer skor ver. SADECE su semada JSON dondur: '
    '{"validations":[{"symbol":"SYMBOL","pattern":"PATTERN","verdict":"approve|adjust|reject",'
    '"adjustedUpsidePct":12.5,"adjustedConfidence":70,'
    '"comment":"kisa Turkce gerekce"}]}'
)


def validate_formations_ai(formations, cfg=None):
    """Kural-tabanli formasyon sonuclarini AI ile dogrular/torpuler."""
    if not formations:
        return []
    cfg = cfg or resolve_ai_config({})

    rows = []
    for f in formations[:20]:
        row = {
            'symbol': f.get('symbol'),
            'pattern': f.get('patternName') or f.get('pattern'),
            'type': f.get('type', ''),
            'direction': f.get('direction', 'bullish'),
            'lastPrice': f.get('lastClose'),
            'upsidePct': f.get('upsidePct'),
            'confidence': f.get('confidence'),
            'eta': f.get('eta', ''),
            'detail': (f.get('detail') or '')[:220],
        }
        c = f.get('context') or {}
        if c:
            row['recentCloses'] = c.get('series')
            row['rsi14'] = c.get('rsi14')
            row['trend'] = c.get('trend')
        rows.append(row)

    user_prompt = (
        'Formasyon adaylari (JSON; recentCloses = son 20 gunluk kapanis serisi):\n'
        + json.dumps(rows, ensure_ascii=False)
        + '\n\nHer adayi degerlendir. Yalnizca JSON dondur; aciklama ekleme.')

    j = post_chat(cfg, {
        'model': cfg['model'],
        'messages': [
            {'role': 'system', 'content': VALIDATION_SYSTEM},
            {'role': 'user', 'content': user_prompt}
        ],
        'temperature': 0.1,
        'max_tokens': 6000,
        'stream': False
    })
    raw = _extract_text(j)
    parsed = _parse_json_loose(raw)
    if parsed and isinstance(parsed.get('validations'), list):
        return parsed['validations']
    return []


def compare_directions(bullish, bearish, cfg=None):
    cfg = cfg or resolve_ai_config({})
    b_rows = [{'symbol': f.get('symbol'),
               'pattern': f.get('patternName') or f.get('pattern'),
               'expectedPct': f.get('upsidePct'),
               'confidence': f.get('confidence')} for f in (bullish or [])[:12]]
    a_rows = [{'symbol': f.get('symbol'),
               'pattern': f.get('patternName') or f.get('pattern'),
               'expectedPct': f.get('upsidePct'),
               'confidence': f.get('confidence')} for f in (bearish or [])[:12]]
    j = post_chat(cfg, {
        'model': cfg['model'],
        'messages': [
            {'role': 'system', 'content': (
                'Sen BIST100 teknik analistisin. Boga ve ayi formasyon adaylarini karsilastir. '
                'Turkce, 3-5 cumlelik kisa bir metin yaz. JSON veya markdown kullanma.')},
            {'role': 'user', 'content': (
                'Yukselis beklenen adaylar: ' + json.dumps(b_rows, ensure_ascii=False)
                + '\nDusus beklenen adaylar: ' + json.dumps(a_rows, ensure_ascii=False)
                + '\n\nIki yonu karsilastir ve kisa bir piyasa yorumu yaz.')}
        ],
        'temperature': 0.25,
        'max_tokens': 3000,
        'stream': False
    })
    return _extract_text(j)



def _parse_json_loose(text):
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r'```(?:json)?\s*([\s\S]*?)```', text, re.IGNORECASE)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    b = text.find('{')
    e = text.rfind('}')
    if b != -1 and e > b:
        try:
            return json.loads(text[b:e + 1])
        except Exception:
            pass
    return None


def merge_validations(base, validations, ai_error=None):
    """AI dogrulama sonuclarini formasyon listesine isler.

    AI'nin degerlendirmedigi adaylar listede korunur (kural tabanli sonuc kaybolmaz).
    """
    base_results = base.get("results", []) or []
    if not validations:
        out = dict(base)
        out["aiValidated"] = False
        out["aiError"] = ai_error or "AI dogrulamasi alinamadi."
        out["aiSummary"] = {
            "approved": 0, "adjusted": 0, "rejected": 0,
            "unvalidated": len(base_results), "scanned": len(base_results),
        }
        return out

    by_key = {}
    for v in validations:
        k = (str(v.get("symbol") or "").upper() + "|" + str(v.get("pattern") or ""))
        by_key[k] = v

    kept = []
    approved = 0
    adjusted = 0
    rejected = 0
    unvalidated = 0

    for f in base_results:
        key = (str(f.get("symbol") or "").upper() + "|" +
               str(f.get("patternName") or f.get("pattern") or ""))
        v = by_key.get(key)
        if not v:
            unvalidated += 1
            kept.append(f)
            continue
        verdict = str(v.get("verdict") or "").lower()
        if verdict == "reject":
            rejected += 1
            continue
        out = dict(f)
        out["aiVerdict"] = verdict or "approve"
        out["aiComment"] = v.get("comment") or ""
        if verdict == "adjust":
            adj_up = v.get("adjustedUpsidePct")
            adj_conf = v.get("adjustedConfidence")
            if adj_up is not None:
                try:
                    candidate = max(1.0, min(35.0, float(adj_up)))
                    if f.get("upsidePct") is not None:
                        candidate = min(candidate, float(f["upsidePct"]))
                    if f.get("upsidePct") is None or candidate != float(f["upsidePct"]):
                        out["origUpsidePct"] = f.get("upsidePct")
                        out["upsidePct"] = candidate
                except (TypeError, ValueError):
                    pass
            if adj_conf is not None:
                try:
                    candidate = max(10, min(95, int(round(float(adj_conf)))))
                    if f.get("confidence") is not None:
                        candidate = min(candidate, int(f["confidence"]))
                    if f.get("confidence") is None or candidate != int(f["confidence"]):
                        out["origConfidence"] = f.get("confidence")
                        out["confidence"] = candidate
                except (TypeError, ValueError):
                    pass
            adjusted += 1
        else:
            approved += 1
        kept.append(out)

    kept.sort(key=lambda r: (-(r.get("confidence") or 0), -(r.get("upsidePct") or 0)))

    return {
        "updatedAt": int(time.time() * 1000),
        "stats": base.get("stats"),
        "count": len(kept),
        "dir": base.get("dir"),
        "aiValidated": True,
        "aiError": ai_error,
        "aiSummary": {
            "approved": approved,
            "adjusted": adjusted,
            "rejected": rejected,
            "unvalidated": unvalidated,
            "scanned": len(base_results),
        },
        "results": kept,
    }


TRUNCGIL_URL = "https://finans.truncgil.com/today.json"
_last_gold_data = None


def _parse_tr_number(value):
    """'5.814,78' / '$3.568,37' / '%-2,60' -> float"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip().replace(" ", "").replace("$", "").replace("₺", "")
    s = s.replace("%", "")
    s = re.sub(r"TL", "", s, flags=re.I)
    if not s:
        return None
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    elif s.count(".") > 1:
        s = s.replace(".", "")
    try:
        return float(s)
    except Exception:
        return None


def _parse_tr_percent(value):
    n = _parse_tr_number(value)
    return rnd(n, 2) if n is not None else None


def _source_time(update_date):
    m = re.search(r"(\d{1,2}:\d{2}:\d{2})", str(update_date or ""))
    return m.group(1) if m else None


def fetch_truncgil_gold():
    status, headers, body = http_get(TRUNCGIL_URL, timeout=15)
    if status < 200 or status >= 300:
        raise RuntimeError("Truncgil HTTP " + str(status))
    j = json.loads(body)
    gram_obj = j.get("gram-altin") or {}
    ceyrek_obj = j.get("ceyrek-altin") or {}
    tam_obj = j.get("tam-altin") or {}
    ons_obj = j.get("ons") or {}
    usd_obj = j.get("USD") or {}

    gram = _parse_tr_number(gram_obj.get("Satış", gram_obj.get("Alış")))
    ceyrek = _parse_tr_number(ceyrek_obj.get("Satış", ceyrek_obj.get("Alış")))
    tam = _parse_tr_number(tam_obj.get("Satış", tam_obj.get("Alış")))
    ons_usd = _parse_tr_number(ons_obj.get("Satış", ons_obj.get("Alış")))
    usd_try = _parse_tr_number(usd_obj.get("Satış", usd_obj.get("Alış")))

    if not (gram and ceyrek and tam and gram > 0 and ceyrek > 0 and tam > 0):
        raise RuntimeError("Truncgil altin alanlari eksik")

    return {
        "gram": rnd(gram, 2),
        "ceyrek": rnd(ceyrek, 2),
        "tam": rnd(tam, 2),
        "onsUsd": rnd(ons_usd, 2) if ons_usd is not None else None,
        "onsTry": None,
        "usdTry": rnd(usd_try, 4) if usd_try is not None else None,
        "changes": {
            "gram": _parse_tr_percent(gram_obj.get("Değişim")),
            "ceyrek": _parse_tr_percent(ceyrek_obj.get("Değişim")),
            "tam": _parse_tr_percent(tam_obj.get("Değişim")),
            "ons": _parse_tr_percent(ons_obj.get("Değişim")),
            "usdTry": _parse_tr_percent(usd_obj.get("Değişim")),
        },
        "source": "truncgil",
        "sourceLabel": "Truncgil Finans",
        "sourceUpdatedAt": j.get("Update_Date"),
        "sourceTime": _source_time(j.get("Update_Date")),
        "updatedAt": int(time.time() * 1000),
        "stale": False,
    }


def _quote_or_last(symbol, quote):
    if quote and quote.get("regularMarketPrice") is not None:
        return quote.get("regularMarketPrice")
    try:
        ch = yahoo_chart(symbol, "1d")
        candles = ch.get("candles") or []
        if candles:
            return candles[-1]["c"]
    except Exception:
        pass
    return None


def fetch_yahoo_gold_fallback():
    quotes = yahoo_quotes(["GC=F", "TRY=X"])
    ons_raw = _quote_or_last("GC=F", quotes.get("GC=F") or {})
    usd_raw = _quote_or_last("TRY=X", quotes.get("TRY=X") or {})
    ons_usd = rnd(ons_raw, 2) if ons_raw is not None else None
    usd_try = rnd(usd_raw, 4) if usd_raw is not None else None

    ons_try = gram = ceyrek = tam = None
    if ons_usd is not None and usd_try is not None:
        ons_try = rnd(ons_usd * usd_try, 2)
        gram = rnd((ons_usd * usd_try) / 31.1034768, 2)
        ceyrek = rnd(gram * 1.75, 2)
        tam = rnd(gram * 7, 2)

    if gram is None or ceyrek is None or tam is None:
        raise RuntimeError("Yahoo altin verisi alinamadi")

    return {
        "gram": gram,
        "ceyrek": ceyrek,
        "tam": tam,
        "onsUsd": ons_usd,
        "onsTry": ons_try,
        "usdTry": usd_try,
        "changes": None,
        "source": "yahoo",
        "sourceLabel": "Yahoo Finance (yedek)",
        "sourceUpdatedAt": None,
        "sourceTime": None,
        "updatedAt": int(time.time() * 1000),
        "stale": False,
    }


def get_gold():
    global _last_gold_data
    try:
        data = fetch_truncgil_gold()
        _last_gold_data = data
        return data
    except Exception:
        pass
    try:
        data = fetch_yahoo_gold_fallback()
        _last_gold_data = data
        return data
    except Exception:
        pass
    if _last_gold_data:
        out = dict(_last_gold_data)
        out["stale"] = True
        return out
    raise RuntimeError("Altin verisi alinamadi")


def build_formations():
    """Kural-tabanli formasyon tarama (Python fallback - bos doner).

    Gercek formasyon tarama mantigi Node.js sunucuda (lib/patterns.js)
    bulunur. Python fallback sunucusu icin basit bir stup 제공 eder.
    """
    return {
        'updatedAt': int(time.time() * 1000),
        'stats': {'scanned': 0, 'withData': 0, 'tooShort': 0, 'perPattern': {}},
        'count': 0,
        'results': []
    }


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
    extensions_map.update({
        ".webmanifest": "application/manifest+json; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
    })

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if not path.startswith("/api/"):
            return super().do_GET()

        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/overview":
                data = cache_get("overview")
                if data is None:
                    data = cache_set("overview", build_overview(), 60)
                return self._send_json(200, data)

            if path == "/api/chart":
                symbol = (qs.get("symbol", [""])[0]).upper()
                rng = qs.get("range", ["1y"])[0]
                stock = BY_SYMBOL.get(symbol)
                if not stock:
                    return self._send_json(400, {"error": "Bilinmeyen sembol"})
                key = "chart:%s:%s" % (symbol, rng)
                data = cache_get(key)
                if data is None:
                    data = cache_set(key, yahoo_chart(stock["yahoo"], rng), 300)
                return self._send_json(200, data)

            if path == "/api/news":
                symbol = (qs.get("symbol", [""])[0]).upper()
                query = qs.get("q", [None])[0]
                stock = BY_SYMBOL.get(symbol)
                if not query:
                    if stock:
                        query = '"%s" OR %s' % (stock["name"], stock["symbol"])
                    else:
                        query = 'BIST100 OR "Borsa Istanbul"'
                key = "news:" + query
                data = cache_get(key)
                if data is None:
                    data = cache_set(key, get_news(query, 7, 24), 600)
                return self._send_json(200, {
                    "query": query,
                    "symbol": symbol or None,
                    "name": stock["name"] if stock else "Piyasa Genel",
                    "items": data,
                })

            if path == "/api/gold":
                data = cache_get("gold")
                if data is None:
                    try:
                        data = cache_set("gold", get_gold(), 60)
                    except Exception as e:
                        return self._send_json(502, {"error": "Altin verisi alinamadi", "detail": str(e)})
                return self._send_json(200, data)

            if path == "/api/formations":
                direction = qs.get("dir", ["bullish"])[0]
                base = build_formations()
                base["dir"] = direction
                if direction == "all":
                    empty = {"stats": base["stats"], "count": 0, "results": []}
                    return self._send_json(200, {
                        "updatedAt": int(time.time() * 1000),
                        "dir": "all",
                        "scanned": 0,
                        "bullish": dict(empty),
                        "bearish": dict(empty),
                    })
                return self._send_json(200, base)

            if path == "/api/ai-analysis":
                cfg = ai_config_from_request(self.headers)
                if not cfg["api_key"]:
                    return self._send_json(400, {
                        "error": "AI ozellikleri icin API anahtari gerekli",
                        "detail": "Sag ustteki API Ayarlari bolumunden anahtarinizi girin.",
                        "code": "ai_key_missing",
                    })
                try:
                    overview = build_overview()
                    market_news = get_news('BIST100 OR "Borsa Istanbul"', 7, 12)
                    result = ai_analyze_market(overview["items"], market_news, cfg)
                    return self._send_json(200, result)
                except Exception as e:
                    return self._send_json(502, {"error": "AI piyasa analizi alinamadi", "detail": str(e)})

            if path == "/api/ai-analysis-stock":
                symbol = (qs.get("symbol", [""])[0]).upper()
                stock = BY_SYMBOL.get(symbol)
                if not stock:
                    return self._send_json(400, {"error": "Bilinmeyen sembol"})
                cfg = ai_config_from_request(self.headers)
                if not cfg["api_key"]:
                    return self._send_json(400, {
                        "error": "AI ozellikleri icin API anahtari gerekli",
                        "detail": "Sag ustteki API Ayarlari bolumunden anahtarinizi girin.",
                        "code": "ai_key_missing",
                    })
                rng = qs.get("range", ["1y"])[0]
                try:
                    chart_data = yahoo_chart(stock["yahoo"], rng)
                except Exception:
                    chart_data = {"candles": []}
                try:
                    stock_news = get_news('"' + stock["name"] + '" OR ' + stock["symbol"], 7, 8)
                except Exception:
                    stock_news = []
                try:
                    summary = ai_analyze_stock(symbol, chart_data.get("candles", []),
                                               stock_news, cfg=cfg)
                    return self._send_json(200, {
                        "symbol": stock["symbol"],
                        "name": stock["name"],
                        "summary": summary,
                        "provider": cfg["provider"],
                        "model": cfg["model"],
                        "updatedAt": int(time.time() * 1000),
                    })
                except Exception as e:
                    return self._send_json(502, {"error": "AI hisse analizi alinamadi", "detail": str(e)})

            if path == "/api/ai-formations":
                cfg = ai_config_from_request(self.headers)
                if not cfg["api_key"]:
                    return self._send_json(400, {
                        "error": "AI ozellikleri icin API anahtari gerekli",
                        "detail": "Sag ustteki API Ayarlari bolumunden anahtarinizi girin.",
                        "code": "ai_key_missing",
                    })
                direction = qs.get("dir", ["bullish"])[0]
                try:
                    base = build_formations()
                    base["dir"] = direction
                    vals = validate_formations_ai(base.get("results", []), cfg)
                    result = merge_validations(base, vals)
                    if direction == "all":
                        empty = {"stats": base["stats"], "count": 0, "results": []}
                        return self._send_json(200, {
                            "updatedAt": int(time.time() * 1000),
                            "dir": "all",
                            "bullish": dict(empty),
                            "bearish": dict(empty),
                            "comparison": "",
                        })
                    return self._send_json(200, result)
                except Exception as e:
                    return self._send_json(502, {"error": "AI formasyon dogrulamasi alinamadi", "detail": str(e)})

            if path == "/api/ai-models":
                cfg = ai_config_from_request(self.headers)
                if not cfg["api_key"]:
                    return self._send_json(400, {
                        "error": "AI ozellikleri icin API anahtari gerekli",
                        "detail": "Sag ustteki API Ayarlari bolumunden anahtarinizi girin.",
                        "code": "ai_key_missing",
                    })
                try:
                    return self._send_json(200, ai_list_models(cfg))
                except Exception as e:
                    return self._send_json(502, {"error": "Model listesi alinamadi", "detail": str(e)})

            if path == "/api/ai-config":
                cfg = ai_config_from_request(self.headers)
                if cfg["api_key"]:
                    return self._send_json(200, {
                        "configured": True,
                        "provider": cfg["provider"],
                        "apiBase": cfg["api_base"],
                        "model": cfg["model"],
                        "source": "browser",
                    })
                return self._send_json(200, ai_public_config())

            return self._send_json(404, {"error": "Bulunamadi"})
        except Exception as e:
            return self._send_json(500, {"error": "Sunucu hatasi", "detail": str(e)})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if not path.startswith("/api/"):
            return self._send_json(404, {"error": "Bulunamadi"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            data = json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            return self._send_json(400, {"error": "Gecersiz istek gövdesi"})
        try:
            if path == "/api/ai-config":
                if self.client_address[0] not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
                    return self._send_json(403, {
                        "error": "Sunucu geneli AI ayari yalnizca yerel makineden degistirilebilir.",
                        "detail": "Kendi API anahtarinizi arayuzdeki API penceresinden girin.",
                    })
                cfg = ai_set_config(data.get("apiKey"), data.get("apiBase"), data.get("model"))
                return self._send_json(200, {"ok": True, "config": cfg})
            if path == "/api/ai-test":
                cfg = ai_config_from_request(self.headers, data)
                if not cfg["api_key"]:
                    return self._send_json(400, {
                        "error": "AI ozellikleri icin API anahtari gerekli",
                        "detail": "Sag ustteki API Ayarlari bolumunden anahtarinizi girin.",
                        "code": "ai_key_missing",
                    })
                result = ai_test_connection(cfg)
                return self._send_json(200, result)
            return self._send_json(404, {"error": "Bulunamadi"})
        except ValueError as ve:
            return self._send_json(400, {"error": str(ve)})
        except Exception as e:
            return self._send_json(502, {"error": "AI sunucusuna baglanilamadi", "detail": str(e)})


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run():
    srv = ThreadingServer(("0.0.0.0", PORT), Handler)
    print("BIST100 Analist V2 (Python) calisiyor -> http://localhost:%d" % PORT)
    print("%d hisse yuklendi." % len(BIST100))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nKapatiliyor…")
        srv.shutdown()


if __name__ == "__main__":
    run()
