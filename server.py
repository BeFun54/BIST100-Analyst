# -*- coding: utf-8 -*-
"""
BIST100 Analyst - Python ile yazilmis alternatif sunucu (sadece standart kutuphane).

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
PORT = int(os.environ.get("PORT", "3000"))


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
#  AI Analiz (NVIDIA NIM / DeepSeek)
# ------------------------------------------------------------------ #

AI_API_KEY = os.environ.get('AI_API_KEY', 'DEV_ONLY_PLACEHOLDER')
AI_API_BASE = os.environ.get('AI_API_BASE', 'https://evren-llmapi.ssyz.org.tr/v1/chat/completions')
AI_MODEL = 'deepseek-v4.1-flash'
TERMS_BASE = 'https://evren-llmapi.ssyz.org.tr/v1'
_terms_accepted = False


def http_post_json(url, body, timeout=90):
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + AI_API_KEY,
            'Accept': 'application/json',
            'User-Agent': 'BIST100-Analyst-Python/1.0'
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode('utf-8', 'replace')
            if resp.status < 200 or resp.status >= 300:
                raise RuntimeError('AI API hata kodu ' + str(resp.status) + ': ' + raw)
            return json.loads(raw)
    except urllib.error.HTTPError as he:
        body_err = he.read().decode('utf-8', 'replace')
        raise RuntimeError('AI API hata kodu ' + str(he.code) + ': ' + body_err)


def _extract_text(j):
    try:
        return j['choices'][0]['message']['content']
    except Exception:
        return 'AI yorumu olusturulamadi (gecersiz yanit).'


def accept_terms():
    global _terms_accepted
    if _terms_accepted:
        return
    try:
        import urllib.request
        import urllib.error
        req = urllib.request.Request(
            TERMS_BASE + '/terms/accept',
            data=json.dumps({'version': 1}).encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + AI_API_KEY,
                'Accept': 'application/json',
                'User-Agent': 'BIST100-Analyst-Python/1.0'
            },
            method='POST'
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp.read()
        except urllib.error.HTTPError:
            pass  # Zaten kabul edilmis olabilir
        _terms_accepted = True
    except Exception:
        _terms_accepted = True


def _build_stock_prompt(stock, candles, news_items, pattern):
    lines = []
    lines.append('Hisse: ' + stock['symbol'] + ' (' + stock['name'] + ')')
    lines.append('Son fiyat: ' + (str(stock.get('lastClose')) + ' TL' if stock.get('lastClose') is not None else '—'))
    lines.append('Gunluk degisim: ' + (str(stock.get('dailyPct')) + '%' if stock.get('dailyPct') is not None else '—'))
    lines.append('Haftalik degisim: ' + (str(stock.get('weeklyPct')) + '%' if stock.get('weeklyPct') is not None else '—'))
    lines.append('Hacim: ' + (str(stock.get('volume')) if stock.get('volume') is not None else '—'))
    if candles:
        last = candles[-1]
        lines.append('Son mum: A=' + str(last['o']) + ' H=' + str(last['h']) + ' L=' + str(last['l']) + ' C=' + str(last['c']))
        if len(candles) >= 5:
            c5 = [c['c'] for c in candles[-5:]]
            lines.append('Son 5 gun araligi: min=' + str(min(c5)) + ' max=' + str(max(c5)))
    if pattern:
        lines.append('Tespit edilen formasyon: ' + pattern.get('name', '') + ' (' + pattern.get('type', '') + ')')
        lines.append('Formasyon guvenilirligi: ' + str(pattern.get('reliability', '—')))
        lines.append('Formasyon detayi: ' + pattern.get('description', ''))
    if news_items:
        lines.append('Son haberler:')
        for n in news_items[:5]:
            lines.append('- ' + n.get('title', ''))
    lines.append('')
    lines.append('Lutfen yukaridaki verileri dikkate alarak ' + stock['symbol'] +
                 ' icin kisa, etkili ve Turkce bir teknik ve temel analiz yaz. ' +
                 'Fiyat eylemi, formasyon (varsa), haber etkisi ve risk notlarini icerir.')
    return '\n'.join(lines)


def _build_market_prompt(overview_items, news_items):
    lines = []
    lines.append('BIST100 Piyasa Genel Durumu:')
    lines.append('Toplam hisse sayisi: ' + str(len(overview_items)))
    up = sum(1 for s in overview_items if s.get('dailyPct') is not None and s['dailyPct'] > 0)
    down = sum(1 for s in overview_items if s.get('dailyPct') is not None and s['dailyPct'] < 0)
    flat = len(overview_items) - up - down
    lines.append('Yukselen: ' + str(up) + ' | Dusen: ' + str(down) + ' | Degismemis: ' + str(flat))
    sorted_items = sorted(
        [s for s in overview_items if s.get('dailyPct') is not None],
        key=lambda s: s['dailyPct'], reverse=True)
    top_gainers = [s['symbol'] + ' (%' + str(s['dailyPct']) + ')' for s in sorted_items[:5]]
    top_losers = [s['symbol'] + ' (%' + str(s['dailyPct']) + ')' for s in sorted_items[-5:]]
    lines.append('En cok yukselenler: ' + ', '.join(top_gainers))
    lines.append('En cok dusenler: ' + ', '.join(top_losers))
    if news_items:
        lines.append('Son piyasa haberleri:')
        for n in news_items[:5]:
            lines.append('- ' + n.get('title', ''))
    lines.append('')
    lines.append('Lutfen yukaridaki BIST100 genel gorusune dayanarak kisa, ' +
                 'Turkce bir piyasa yorumu yaz. Trend yonu, sektorgelismeleri, ' +
                 'risk faktorsu ve kisa vadeli beklemeleri icerir.')
    return '\n'.join(lines)


def ai_analyze_market(overview_items, news_items):
    accept_terms()
    prompt = _build_market_prompt(overview_items, news_items)
    j = http_post_json(AI_API_BASE, {
        'model': AI_MODEL,
        'messages': [
            {'role': 'system', 'content': 'Sen BIST100 (Borsa Istanbul) uzmani bir finansal analizci sun. Turkce, kesin, net ve objektif cevaplar ver. Yatirim tavsiyesi verme, sadece analiz ve yorum yap. Her yorumun sonunda "Bu bir yatirim tavsiyesi degildir." ibaresini ekle.'},
            {'role': 'user', 'content': prompt}
        ],
        'temperature': 0.4,
        'max_tokens': 900,
        'stream': False
    })
    summary = _extract_text(j)
    return {'updatedAt': int(time.time() * 1000), 'summary': summary}


def ai_analyze_stock(symbol, candles, news_items, pattern=None):
    accept_terms()
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

    j = http_post_json(AI_API_BASE, {
        'model': AI_MODEL,
        'messages': [
            {'role': 'system', 'content': 'Sen BIST100 (Borsa Istanbul) uzmani bir finansal analizci sun. Turkce, kesin, net ve objektif cevaplar ver. Yatirim tavsiyesi verme, sadece analiz ve yorum yap. Her yorumun sonunda "Bu bir yatirim tavsiyesi degildir." ibaresini ekle.'},
            {'role': 'user', 'content': prompt}
        ],
        'temperature': 0.4,
        'max_tokens': 700,
        'stream': False
    })
    return _extract_text(j)


class Handler(http.server.SimpleHTTPRequestHandler):
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

            if path == "/api/ai-analysis":
                try:
                    overview = build_overview()
                    market_news = get_news('BIST100 OR "Borsa Istanbul"', 7, 10)
                    result = ai_analyze_market(overview["items"], market_news)
                    return self._send_json(200, result)
                except Exception as e:
                    return self._send_json(502, {"error": "AI piyasa analizi alinamadi", "detail": str(e)})

            if path == "/api/ai-analysis-stock":
                symbol = (qs.get("symbol", [""])[0]).upper()
                stock = BY_SYMBOL.get(symbol)
                if not stock:
                    return self._send_json(400, {"error": "Bilinmeyen sembol"})
                rng = qs.get("range", ["1y"])[0]
                try:
                    chart_data = yahoo_chart(stock["yahoo"], rng)
                except Exception:
                    chart_data = {"candles": []}
                try:
                    stock_news = get_news('"' + stock["name"] + '" OR ' + stock["symbol"], 7, 5)
                except Exception:
                    stock_news = []
                try:
                    summary = ai_analyze_stock(symbol, chart_data.get("candles", []), stock_news)
                    return self._send_json(200, {
                        "symbol": stock["symbol"],
                        "name": stock["name"],
                        "summary": summary,
                        "updatedAt": int(time.time() * 1000)
                    })
                except Exception as e:
                    return self._send_json(502, {"error": "AI hisse analizi alinamadi", "detail": str(e)})

            return self._send_json(404, {"error": "Bulunamadi"})
        except Exception as e:
            return self._send_json(500, {"error": "Sunucu hatasi", "detail": str(e)})


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run():
    srv = ThreadingServer(("0.0.0.0", PORT), Handler)
    print("BIST100 Analyst (Python) calisiyor -> http://localhost:%d" % PORT)
    print("%d hisse yuklendi." % len(BIST100))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nKapatiliyor…")
        srv.shutdown()


if __name__ == "__main__":
    run()
