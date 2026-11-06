'use strict';

/**
 * Haber istemcisi.
 * Google Haberler RSS akisini kullanir (API anahtari gerektirmez, guvenilir).
 * Sonuclar son 7 gune filtrelenir.
 */

const https = require('https');
const http = require('http');

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/rss+xml,application/xml,text/xml,*/*',
  'Accept-Language': 'tr-TR,tr;q=0.9'
};

function fetchText(targetUrl, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const lib = targetUrl.startsWith('http://') ? http : https;
    const req = lib.get(targetUrl, { headers: UA }, (res) => {
      if (
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        res.resume();
        const next = new URL(res.headers.location, targetUrl).toString();
        fetchText(next, timeout).then(
          (r) => done(resolve, r),
          (e) => done(reject, e)
        );
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => done(resolve, data));
      res.on('error', (e) => done(reject, e));
    });
    req.on('error', (e) => done(reject, e));
    req.setTimeout(timeout, () => req.destroy(new Error('haber zaman asimi')));
  });
}

/* ------------------------------------------------------------------ *
 *  Kucuk, bagimliliksiz RSS ayristirici
 * ------------------------------------------------------------------ */

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&hellip;': '…',
  '&mdash;': '—', '&ndash;': '–', '&rsquo;': '’', '&lsquo;': '‘',
  '&ldquo;': '“', '&rdquo;': '”'
};

function decode(str) {
  if (!str) return '';
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    )
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m] || m)
    .replace(/\s+/g, ' ')
    .trim();
}

function tagText(item, tag) {
  const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = item.match(re);
  return m ? decode(m[1]) : '';
}

function parseItems(xml) {
  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[0];
    const title = tagText(raw, 'title');
    const link = tagText(raw, 'link');
    const pubDate = tagText(raw, 'pubDate');
    const source = tagText(raw, 'source');
    const description = tagText(raw, 'description');
    if (!title || !link) continue;
    items.push({
      title,
      link,
      source: source || '',
      publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
      summary: description.replace(/<[^>]+>/g, '').slice(0, 300)
    });
  }
  return items;
}

function googleNewsUrl(query) {
  return (
    'https://news.google.com/rss/search?q=' +
    encodeURIComponent(query) +
    '&hl=tr&gl=TR&ceid=TR:tr'
  );
}

/**
 * @param {string} query  arama ifadesi (sirket adi veya trend)
 * @param {object} opts   { days: 7, limit: 25 }
 */
async function getNews(query, opts = {}) {
  const days = opts.days || 7;
  const limit = opts.limit || 25;
  const xml = await fetchText(googleNewsUrl(query));
  const items = parseItems(xml);

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const fresh = items.filter((it) => {
    if (!it.publishedAt) return true;
    return new Date(it.publishedAt).getTime() >= cutoff;
  });

  return (fresh.length ? fresh : items).slice(0, limit);
}

module.exports = { getNews, _parseItems: parseItems };
