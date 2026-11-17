'use strict';

/* ==================================================================
 *  BIST100 Analyst - istemci mantigi
 *  - Anlik fiyat listesi (alfabetik)
 *  - Genisleyen satirlarda klasik mum grafigi (5y/1y/6mo/1mo/bugun)
 *  - Bugunun trendleri (haftalik en hareketliler)
 *  - Sag panelde son 7 gunun haberleri
 *  - Favoriler (localStorage)
 * ================================================================== */

const RANGES = [
  { key: '5y', label: '5 Yil' },
  { key: '1y', label: '1 Yil' },
  { key: '6mo', label: '6 Ay' },
  { key: '1mo', label: '1 Ay' },
  { key: '1d', label: 'Bugun' }
];

const FAV_KEY = 'bist100_favorites';
const ASSET_KEY = 'bist100_assets';

const state = {
  items: [],
  bySymbol: {},
  favorites: new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')),
  assets: JSON.parse(localStorage.getItem(ASSET_KEY) || '[]'),
  patternResults: [], // son formasyon taramasi sonuclari (varlik beklentisi icin)
  patternDir: 'bullish', // 'bullish' | 'bearish' | 'all'
  aiConfig: { configured: false, apiBase: '', model: '' }, // /api/ai-config'den gelen ayar durumu
  openSymbol: null,
  range: '1y',
  favOnly: false,
  search: '',
  chartCache: new Map(),
  updatedAt: null,
  aiMarketSummary: null,
  aiStockSummaries: {}
};

/* ------------------------- bicimlendirme ------------------------- */

const nf2 = new Intl.NumberFormat('tr-TR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const nf0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });

function fmtPrice(v) {
  if (v == null || !isFinite(v)) return '—';
  return nf2.format(v);
}
function fmtPct(v) {
  if (v == null || !isFinite(v)) return '—';
  const s = (v > 0 ? '+' : '') + nf2.format(v) + '%';
  return s;
}
function fmtSigned(v) {
  if (v == null || !isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + nf2.format(v);
}
function fmtVolume(v) {
  if (v == null) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + ' mr';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + ' mn';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + ' bn';
  return String(v);
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('tr-TR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}
function fmtRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const diff = Date.now() - d.getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'az once';
  if (h < 24) return h + ' saat once';
  const day = Math.floor(h / 24);
  return day + ' gun once';
}

function cls(v) {
  if (v == null || !isFinite(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}

/* ------------------------- favoriler ------------------------- */

function saveFavs() {
  localStorage.setItem(FAV_KEY, JSON.stringify([...state.favorites]));
  updateFavCount();
}
function isFav(sym) {
  return state.favorites.has(sym);
}
function toggleFav(sym) {
  if (state.favorites.has(sym)) state.favorites.delete(sym);
  else state.favorites.add(sym);
  saveFavs();
  const star = document.querySelector(
    '.stock-row[data-symbol="' + sym + '"] .fav-star'
  );
  if (star) star.classList.toggle('on', isFav(sym));
  if (state.favOnly) applyFilter();
}
function updateFavCount() {
  const el = document.getElementById('favCount');
  if (el) el.textContent = String(state.favorites.size);
}

/* ==================================================================
 *  Varliklarim (portfoy) - localStorage
 *  Her varlik: { id, symbol, qty, buyPrice, buyDate, patternName,
 *               upsidePct, eta }  (son iki alan formasyon eklemesinde dolar)
 * ================================================================== */

function saveAssets() {
  localStorage.setItem(ASSET_KEY, JSON.stringify(state.assets));
  updateAssetCount();
  renderAssets();
}

function updateAssetCount() {
  const elBtn = document.getElementById('assetCount');
  if (elBtn) elBtn.textContent = String(state.assets.length);
}

/** Varligin bagli oldugu guncel formasyon sinyali (varsa). */
function currentPatternFor(symbol) {
  for (const r of state.patternResults) {
    if (r.symbol === symbol) return r;
  }
  return null;
}

/** Varligin formasyon beklentisi: once varliga kaydedilen, yoksa guncel tarama. */
function assetExpectation(a) {
  if (a.upsidePct != null) {
    return { upsidePct: a.upsidePct, patternName: a.patternName || 'Formasyon', eta: a.eta || '' };
  }
  const r = currentPatternFor(a.symbol);
  if (r) return { upsidePct: r.upsidePct, patternName: r.patternName, eta: r.eta || '' };
  return null;
}

/** Tahmini satis (hedef) fiyati: alis + formasyon beklentisi %'si. */
function assetTarget(a) {
  const exp = assetExpectation(a);
  if (!exp || !exp.upsidePct || !a.buyPrice) return null;
  return a.buyPrice * (1 + exp.upsidePct / 100);
}

function addAsset(opts) {
  state.assets.push({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    symbol: opts.symbol,
    qty: Number(opts.qty),
    buyPrice: Number(opts.buyPrice),
    buyDate: opts.buyDate || new Date().toISOString().slice(0, 10),
    patternName: opts.pattern ? opts.pattern.patternName : null,
    upsidePct: opts.pattern ? opts.pattern.upsidePct : null,
    eta: opts.pattern ? opts.pattern.eta || null : null
  });
  saveAssets();
}

function removeAsset(id) {
  state.assets = state.assets.filter((a) => a.id !== id);
  saveAssets();
}

function openAssetsModal() {
  document.getElementById('assetsModal').classList.remove('hidden');
  populateAssetSymbolSelect();
  renderAssets();
}

function closeAssetsModal() {
  document.getElementById('assetsModal').classList.add('hidden');
}

function populateAssetSymbolSelect() {
  const sel = document.getElementById('assetSymbol');
  if (!sel || sel.options.length) return;
  for (const it of state.items) {
    const opt = document.createElement('option');
    opt.value = it.symbol;
    opt.textContent = it.symbol + ' · ' + (it.name || '');
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    const it = state.bySymbol[sel.value];
    const priceInput = document.getElementById('assetPrice');
    if (it && it.price != null && !priceInput.value) {
      priceInput.value = String(it.price);
    }
  });
}

function renderAssets() {
  const listEl = document.getElementById('assetsList');
  const sumEl = document.getElementById('assetsSummary');
  if (!listEl) return;

  if (!state.assets.length) {
    listEl.innerHTML =
      '<div class="assets-empty">Henüz varlık eklemediniz.<br>' +
      '<span class="muted">Aşağıdaki formdan veya Formasyon Analizi ekranından ekleyebilirsiniz.</span></div>';
    sumEl.innerHTML = '';
    return;
  }

  let totalCost = 0;
  let totalValue = 0;
  listEl.innerHTML = '';

  const head = el('div', 'asset-row asset-head');
  ['Hisse', 'Adet', 'Alış', 'Anlık', 'Değer', 'K/Z', 'Formasyon Beklentisi', 'Tahmini Satış', ''].forEach((h) =>
    head.appendChild(el('span', '', h))
  );
  listEl.appendChild(head);

  for (const a of state.assets) {
    const item = state.bySymbol[a.symbol];
    const cur = item ? item.price : null;
    const cost = a.qty * a.buyPrice;
    const value = cur != null ? a.qty * cur : null;
    const pl = value != null ? value - cost : null;
    const plPct = value != null && cost > 0 ? ((value - cost) / cost) * 100 : null;

    totalCost += cost;
    if (value != null) totalValue += value;

    const exp = assetExpectation(a);
    const target = assetTarget(a);
    const progress =
      target && cur != null ? Math.max(0, Math.min(100, ((cur - a.buyPrice) / (target - a.buyPrice)) * 100)) : null;

    const row = el('div', 'asset-row');

    const symCell = el('div', 'asset-sym');
    symCell.appendChild(el('span', 'asset-symbol', a.symbol));
    symCell.appendChild(
      el('span', 'asset-sub', fmtDate(a.buyDate) + (item ? ' · ' + (item.name || '') : ''))
    );
    row.appendChild(symCell);

    row.appendChild(el('span', 'col-num', nf2.format(a.qty)));
    row.appendChild(el('span', 'col-num', fmtPrice(a.buyPrice) + ' ₺'));
    row.appendChild(el('span', 'col-num', fmtPrice(cur) + ' ₺'));
    row.appendChild(el('span', 'col-num', value != null ? nf2.format(value) + ' ₺' : '—'));

    const plCell = el('span', 'col-num asset-pl ' + cls(plPct));
    plCell.innerHTML =
      (pl != null ? (pl > 0 ? '+' : '') + nf2.format(pl) + ' ₺' : '—') +
      (plPct != null ? '<small> (' + fmtPct(plPct) + ')</small>' : '');
    row.appendChild(plCell);

    const expCell = el('span', 'col-num asset-exp');
    expCell.innerHTML = exp
      ? '<b class="up">%' + nf2.format(exp.upsidePct) + '</b><small>' +
        (exp.patternName || '') + (exp.eta ? ' · ' + exp.eta : '') + '</small>'
      : '<small>—</small>';
    row.appendChild(expCell);

    const tgtCell = el('span', 'col-num asset-target');
    tgtCell.innerHTML = target
      ? '<b>' + fmtPrice(target) + ' ₺</b>' +
        (progress != null ? '<small>hedefin %' + nf0.format(progress) + 'i</small>' : '')
      : '<small>—</small>';
    row.appendChild(tgtCell);

    const del = el('button', 'asset-del', '✕');
    del.title = 'Varlığı sil';
    del.addEventListener('click', () => removeAsset(a.id));
    row.appendChild(del);

    listEl.appendChild(row);
  }

  const totalPl = totalValue - totalCost;
  sumEl.innerHTML =
    '<span>Toplam Maliyet: <b>' + nf2.format(totalCost) + ' ₺</b></span>' +
    '<span>Güncel Değer: <b>' + nf2.format(totalValue) + ' ₺</b></span>' +
    '<span>Kar/Zarar: <b class="' + cls(totalPl) + '">' +
    (totalPl > 0 ? '+' : '') + nf2.format(totalPl) + ' ₺ (' +
    fmtPct(totalCost > 0 ? (totalPl / totalCost) * 100 : null) + ')</b></span>';
}

async function api(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).detail || '';
    } catch (e) {}
    throw new Error('API ' + res.status + (detail ? ': ' + detail : ''));
  }
  return res.json();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* ==================================================================
 *  Klasik mum grafigi (canvas, bagimliliksiz)
 * ================================================================== */

const UP = '#1fd286';
const DOWN = '#ff5c6c';
const GRID = '#232c3a';
const TEXT = '#8a97a8';

class CandleChart {
  constructor(container) {
    this.container = container;
    this.candles = [];
    this.currency = 'TRY';
    this.hover = -1;

    this.canvas = el('canvas');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.tooltip = el('div', 'chart-tooltip');
    this.tooltip.style.display = 'none';
    container.appendChild(this.tooltip);

    this._onMove = this._onMove.bind(this);
    this._onLeave = this._onLeave.bind(this);
    this.canvas.addEventListener('mousemove', this._onMove);
    this.canvas.addEventListener('mouseleave', this._onLeave);

    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.draw());
      this._ro.observe(container);
    }
    window.addEventListener('resize', () => this.draw());
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    this.canvas.removeEventListener('mousemove', this._onMove);
    this.canvas.removeEventListener('mouseleave', this._onLeave);
    this.container.innerHTML = '';
  }

  setData(payload) {
    this.candles = (payload && payload.candles) || [];
    this.currency = (payload && payload.currency) || 'TRY';
    this.hover = -1;
    this.draw();
  }

  _layout() {
    const w = this.container.clientWidth || 600;
    const h = this.container.clientHeight || 300;
    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const padR = 58;
    const padL = 8;
    const padT = 12;
    const padB = 24;
    const priceH = Math.max(40, (h - padT - padB) * 0.76);
    const volTop = padT + priceH + 8;
    const volH = Math.max(20, h - padB - volTop - 6);

    return { w, h, padL, padR, padT, padB, priceH, volTop, volH };
  }

  draw() {
    const ctx = this.ctx;
    const L = this._layout();
    const { w, h, padL, padR, padT, padB, priceH, volTop, volH } = L;

    ctx.clearRect(0, 0, w, h);

    const n = this.candles.length;
    if (!n) {
      ctx.fillStyle = TEXT;
      ctx.font = '13px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Veri yok', w / 2, h / 2);
      return;
    }

    const plotL = padL;
    const plotR = w - padR;
    const plotW = plotR - plotL;

    let min = Infinity;
    let max = -Infinity;
    let vmax = 0;
    for (const c of this.candles) {
      if (c.l < min) min = c.l;
      if (c.h > max) max = c.h;
      if (c.v > vmax) vmax = c.v;
    }
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.06;
    min -= pad;
    max += pad;

    const yOf = (v) => padT + priceH - ((v - min) / (max - min)) * priceH;
    const vyOf = (v) => volTop + volH - (vmax ? (v / vmax) * volH : 0);

    const step = plotW / n;
    const cw = Math.max(1, Math.min(step * 0.7, 18));

    // Yatay izgara + fiyat etiketleri (sagda)
    ctx.strokeStyle = GRID;
    ctx.fillStyle = TEXT;
    ctx.lineWidth = 1;
    ctx.font = '11px Segoe UI, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const gridLines = 5;
    for (let i = 0; i <= gridLines; i++) {
      const val = max - ((max - min) / gridLines) * i;
      const y = Math.round(yOf(val)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(plotL, y);
      ctx.lineTo(plotR, y);
      ctx.stroke();
      ctx.fillText(fmtPrice(val), plotR + 6, y);
    }

    // Mumlar + hacim
    for (let i = 0; i < n; i++) {
      const c = this.candles[i];
      const cx = plotL + i * step + step / 2;
      const up = c.c >= c.o;
      const color = up ? UP : DOWN;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;

      ctx.beginPath();
      ctx.moveTo(cx, yOf(c.h));
      ctx.lineTo(cx, yOf(c.l));
      ctx.stroke();

      const yo = yOf(c.o);
      const yc = yOf(c.c);
      const top = Math.min(yo, yc);
      const bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(cx - cw / 2, top, cw, bh);

      if (vmax > 0) {
        const vh = (c.v / vmax) * volH;
        ctx.globalAlpha = 0.45;
        ctx.fillRect(cx - cw / 2, volTop + volH - vh, cw, vh);
        ctx.globalAlpha = 1;
      }
    }

    // Tarih etiketleri (altta)
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelCount = Math.max(2, Math.min(6, Math.floor(plotW / 90)));
    for (let i = 0; i <= labelCount; i++) {
      const idx = Math.round((n - 1) * (i / labelCount));
      const c = this.candles[idx];
      const cx = plotL + idx * step + step / 2;
      const d = new Date(c.t);
      const lbl =
        n > 120
          ? d.toLocaleDateString('tr-TR', { month: 'short', year: '2-digit' })
          : d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
      ctx.fillText(
        lbl,
        Math.min(Math.max(cx, padL + 18), plotR - 12),
        h - padB + 6
      );
    }

    // Crosshair
    if (this.hover >= 0 && this.hover < n) {
      const c = this.candles[this.hover];
      const cx = plotL + this.hover * step + step / 2;
      ctx.strokeStyle = '#5a6b85';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, padT);
      ctx.lineTo(cx, volTop + volH);
      ctx.stroke();
      ctx.setLineDash([]);

      const yc = yOf(c.c);
      ctx.beginPath();
      ctx.moveTo(plotL, yc);
      ctx.lineTo(plotR, yc);
      ctx.stroke();

      const pct = c.o ? ((c.c - c.o) / c.o) * 100 : 0;
      const d = new Date(c.t);
      this.tooltip.innerHTML =
        '<div class="tt-date">' + fmtDate(d.toISOString()) + '</div>' +
        'A: ' + fmtPrice(c.o) + '  Y: ' + fmtPrice(c.h) + '<br>' +
        'D: ' + fmtPrice(c.l) + '  K: ' + fmtPrice(c.c) + '<br>' +
        '<span class="' + (pct >= 0 ? 'up' : 'down') + '">' +
        (pct >= 0 ? '+' : '') + nf2.format(pct) + '%</span>  ·  Hacim ' +
        fmtVolume(c.v);
      this.tooltip.style.display = 'block';
      const tw = this.tooltip.offsetWidth;
      let tx = cx + 14;
      if (tx + tw > w) tx = cx - tw - 14;
      this.tooltip.style.left = Math.max(4, tx) + 'px';
      this.tooltip.style.top = Math.max(4, padT + 6) + 'px';
    } else {
      this.tooltip.style.display = 'none';
    }
  }

  _onMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const L = this._layout();
    const plotW = L.w - L.padR - L.padL;
    const n = this.candles.length;
    if (!n) return;
    const step = plotW / n;
    const idx = Math.floor((x - L.padL) / step);
    this.hover = idx >= 0 && idx < n ? idx : -1;
    this.draw();
  }

  _onLeave() {
    this.hover = -1;
    this.draw();
  }
}

/* ------------------------- sparkline (trend karti) ------------------------- */

function drawSparkline(canvas, values, positive) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 160;
  const h = canvas.clientHeight || 34;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!values || values.length < 2) return;
  let min = Math.min.apply(null, values);
  let max = Math.max.apply(null, values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const step = w / (values.length - 1);
  const yOf = (v) => h - 3 - ((v - min) / (max - min)) * (h - 6);

  const color = positive ? UP : DOWN;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = i * step;
    const y = yOf(v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = positive ? 'rgba(31,210,134,.12)' : 'rgba(255,92,108,.12)';
  ctx.fill();
}

/* ==================================================================
 *  Veri yukleme
 * ================================================================== */

state.rowEls = {};

async function loadOverview() {
  const statusEl = document.getElementById('lastUpdate');
  statusEl.textContent = 'Veriler yenileniyor…';
  try {
    const data = await api('/api/overview');
    state.items = data.items || [];
    state.bySymbol = {};
    for (const it of state.items) state.bySymbol[it.symbol] = it;
    state.updatedAt = data.updatedAt;

    if (!Object.keys(state.rowEls).length) renderList();
    else updateListNumbers();

    populateAssetSymbolSelect();
    renderTrends();
    renderGold(); // guncel altin fiyati
    renderAssets(); // varlik penceresi aciksa guncel fiyatlarla tazele
    statusEl.innerHTML =
      '<span class="ok">● Canli</span> · Guncelleme: ' +
      new Date(state.updatedAt).toLocaleTimeString('tr-TR');
  } catch (e) {
    statusEl.innerHTML =
      '<span class="err">● Baglanti hatasi</span> · ' + e.message;
  }
}

/* ==================================================================
 *  Hisse listesi
 * ================================================================== */

function renderList() {
  const wrap = document.getElementById('stockList');
  wrap.innerHTML = '';
  state.rowEls = {};

  const items = state.items
    .slice()
    .sort((a, b) => a.symbol.localeCompare(b.symbol, 'tr'));

  for (const item of items) {
    const row = buildRow(item);
    state.rowEls[item.symbol] = row;
    wrap.appendChild(row);
  }
  applyFilter();
}

function buildRow(item) {
  const row = el('div', 'stock-row');
  row.dataset.symbol = item.symbol;

  const summary = el('div', 'stock-summary');

  const main = el('div', 's-main');
  const star = el('button', 'fav-star' + (isFav(item.symbol) ? ' on' : ''), '★');
  star.title = 'Favorilere ekle / cikar';
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFav(item.symbol);
  });

  const sym = el('span', 's-sym', item.symbol);
  const name = el('span', 's-name', item.name);
  main.appendChild(star);
  main.appendChild(sym);
  main.appendChild(name);

  const price = el('span', 'num');
  const chg = el('span', 'pct');
  const wk = el('span', 'pct');

  summary.appendChild(main);
  summary.appendChild(price);
  summary.appendChild(chg);
  summary.appendChild(wk);

  summary.addEventListener('click', () => toggleDetail(row));

  row.appendChild(summary);
  row._price = price;
  row._chg = chg;
  row._wk = wk;
  updateRowValues(row, item);
  return row;
}

function updateRowValues(row, item) {
  row._price.textContent = fmtPrice(item.price);
  row._chg.textContent = fmtPct(item.changePercent);
  row._chg.className = 'pct ' + cls(item.changePercent);
  row._wk.textContent = fmtPct(item.weekChangePercent);
  row._wk.className = 'pct ' + cls(item.weekChangePercent);
}

function updateListNumbers() {
  for (const sym in state.rowEls) {
    const item = state.bySymbol[sym];
    if (item) updateRowValues(state.rowEls[sym], item);
  }
}

function applyFilter() {
  const q = state.search.trim().toLocaleLowerCase('tr');
  let visible = 0;
  for (const sym in state.rowEls) {
    const row = state.rowEls[sym];
    const item = state.bySymbol[sym];
    if (!item) continue;
    let show = true;
    if (state.favOnly && !isFav(sym)) show = false;
    if (show && q) {
      show =
        sym.toLocaleLowerCase('tr').includes(q) ||
        (item.name || '').toLocaleLowerCase('tr').includes(q);
    }
    row.classList.toggle('hidden', !show);
    if (show) visible++;
  }
  const countEl = document.getElementById('listCount');
  if (countEl)
    countEl.textContent =
      visible + (state.favOnly ? ' favori hisse' : ' hisse');
}

/* ==================================================================
 *  Genisleyen detay + grafik
 * ================================================================== */

function closeDetail() {
  if (state.openSymbol && state.rowEls[state.openSymbol]) {
    const row = state.rowEls[state.openSymbol];
    row.classList.remove('open');
    const d = row.querySelector('.stock-detail');
    if (d) {
      if (d._chart) d._chart.destroy();
      d.remove();
    }
  }
  state.openSymbol = null;
}

function toggleDetail(row) {
  const sym = row.dataset.symbol;
  if (state.openSymbol === sym) {
    closeDetail();
    loadNews(null);
    return;
  }
  closeDetail();

  state.openSymbol = sym;
  row.classList.add('open');

  const detail = buildDetail(sym);
  row.appendChild(detail);

  loadChartInto(detail.querySelector('.chart-wrap'), sym, state.range, detail);
  loadNews(sym);

  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function buildDetail(sym) {
  const item = state.bySymbol[sym];
  const detail = el('div', 'stock-detail');

  const top = el('div', 'detail-top');

  const meta = el('div', 'detail-meta');
  meta.innerHTML =
    '<span>Fiyat: <b>' + fmtPrice(item.price) + '</b></span>' +
    '<span>Gunluk: <b class="' + cls(item.changePercent) + '">' +
    fmtPct(item.changePercent) + '</b></span>' +
    '<span>Haftalik: <b class="' + cls(item.weekChangePercent) + '">' +
    fmtPct(item.weekChangePercent) + '</b></span>' +
    '<span>Aylik: <b class="' + cls(item.monthChangePercent) + '">' +
    fmtPct(item.monthChangePercent) + '</b></span>' +
    '<span>Hacim: <b>' + fmtVolume(item.volume) + '</b></span>';

  const controls = el('div', 'range-buttons');

  const rangeWrap = el('div', 'range-buttons');
  for (const r of RANGES) {
    const b = el(
      'button',
      'range-btn' + (r.key === state.range ? ' active' : ''),
      r.label
    );
    b.dataset.range = r.key;
    b.addEventListener('click', () => {
      state.range = r.key;
      detail
        .querySelectorAll('.range-btn')
        .forEach((x) => x.classList.toggle('active', x.dataset.range === r.key));
      loadChartInto(detail.querySelector('.chart-wrap'), sym, r.key, detail);
    });
    rangeWrap.appendChild(b);
  }

  const expand = el('button', 'expand-btn', '⛶ Buyut');
  expand.addEventListener('click', () => openModal(sym));

  controls.appendChild(rangeWrap);
  controls.appendChild(expand);

  top.appendChild(meta);
  top.appendChild(controls);

  const chartWrap = el('div', 'chart-wrap');
  const loading = el('div', 'chart-loading', 'Grafik yukleniyor…');
  chartWrap.appendChild(loading);

  detail.appendChild(top);
  detail.appendChild(chartWrap);
  detail.dataset.symbol = sym;
  return detail;
}

async function loadChartInto(wrapEl, sym, range, detail) {
  const key = sym + ':' + range;
  const overlay =
    wrapEl.querySelector('.chart-loading') ||
    wrapEl.querySelector('.chart-error');
  if (overlay) {
    overlay.className = 'chart-loading';
    overlay.textContent = 'Grafik yukleniyor…';
  }

  try {
    let payload = state.chartCache.get(key);
    if (!payload) {
      payload = await api(
        '/api/chart?symbol=' + encodeURIComponent(sym) + '&range=' + range
      );
      state.chartCache.set(key, payload);
    }
    const ov = wrapEl.querySelector('.chart-loading, .chart-error');
    if (ov) ov.remove();
    if (detail && detail._chart) detail._chart.destroy();
    const chart = new CandleChart(wrapEl);
    chart.setData(payload);
    if (detail) detail._chart = chart;
    if (state.modalChart && state.modalSymbol === sym) {
      state.modalChart.setData(payload);
    }
  } catch (e) {
    const ov = wrapEl.querySelector('.chart-loading, .chart-error');
    if (ov) {
      ov.className = 'chart-error';
      ov.textContent = 'Grafik alinamadi: ' + e.message;
    } else {
      wrapEl.appendChild(
        el('div', 'chart-error', 'Grafik alinamadi: ' + e.message)
      );
    }
  }
}

/* ------------------------- buyutme (modal) ------------------------- */

function openModal(sym) {
  const item = state.bySymbol[sym];
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent =
    sym + ' · ' + (item ? item.name : '');
  document.getElementById('modalPrice').innerHTML = item
    ? fmtPrice(item.price) +
      '  <span class="' + cls(item.changePercent) + '">' +
      fmtPct(item.changePercent) + '</span>'
    : '';
  modal.classList.remove('hidden');

  const wrap = document.getElementById('modalChartWrap');
  wrap.innerHTML = '';
  const chartWrap = el('div', 'chart-wrap');
  const loading = el('div', 'chart-loading', 'Grafik yukleniyor…');
  chartWrap.appendChild(loading);
  wrap.appendChild(chartWrap);

  state.modalSymbol = sym;
  if (state.modalChart) {
    state.modalChart.destroy();
    state.modalChart = null;
  }

  const key = sym + ':' + state.range;
  const cached = state.chartCache.get(key);
  const chart = new CandleChart(chartWrap);
  state.modalChart = chart;
  if (cached) {
    loading.remove();
    chart.setData(cached);
  } else {
    api('/api/chart?symbol=' + encodeURIComponent(sym) + '&range=' + state.range)
      .then((payload) => {
        state.chartCache.set(key, payload);
        loading.remove();
        chart.setData(payload);
      })
      .catch((e) => {
        loading.className = 'chart-error';
        loading.textContent = 'Grafik alinamadi: ' + e.message;
      });
  }
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
  if (state.modalChart) {
    state.modalChart.destroy();
    state.modalChart = null;
  }
  state.modalSymbol = null;
  document.getElementById('modalChartWrap').innerHTML = '';
}

/* ==================================================================
 *  Bugunun trendleri (son 1 haftanin en hareketli hisseleri)
 * ================================================================== */

function renderTrends() {
  const wrap = document.getElementById('trends');
  const movers = state.items
    .filter((it) => it.weekChangePercent != null)
    .sort(
      (a, b) =>
        Math.abs(b.weekChangePercent) - Math.abs(a.weekChangePercent)
    )
    .slice(0, 8);

  if (!movers.length) {
    wrap.innerHTML = '<div class="news-empty">Trend verisi yok</div>';
    return;
  }

  wrap.innerHTML = '';
  for (const it of movers) {
    const card = el('div', 'trend-card');
    card.dataset.symbol = it.symbol;

    card.appendChild(el('div', 't-sym', it.symbol));
    card.appendChild(el('div', 't-name', it.name));

    const row = el('div', 't-row');
    row.appendChild(el('span', 'muted', 'Haftalik'));
    row.appendChild(
      el('span', 't-pct ' + cls(it.weekChangePercent), fmtPct(it.weekChangePercent))
    );
    card.appendChild(row);

    const row2 = el('div', 't-row');
    row2.appendChild(el('span', 'muted', 'Bugun'));
    const daily = el('span', cls(it.changePercent), fmtPct(it.changePercent));
    row2.appendChild(daily);
    card.appendChild(row2);

    const canvas = el('canvas');
    card.appendChild(canvas);

    card.addEventListener('click', () => {
      const rowEl = state.rowEls[it.symbol];
      if (state.favOnly || state.search) {
        state.favOnly = false;
        state.search = '';
        document.getElementById('search').value = '';
        document.getElementById('favFilterBtn').classList.remove('active');
        applyFilter();
      }
      document
        .getElementById('stockList')
        .scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (rowEl) toggleDetail(rowEl);
    });

    wrap.appendChild(card);
    // sparkline cizimi (yerlesim sonrasi)
    requestAnimationFrame(() =>
      drawSparkline(canvas, it.sparkline, (it.weekChangePercent || 0) >= 0)
    );
  }
}

/* ==================================================================
 *  Altin fiyati (GC=F)
 * ================================================================== */

function goldRow(label, value, suffix, clsName) {
  const row = el('div', 'gold-row');
  row.appendChild(el('span', 'gold-label', label));
  const v = el('span', 'gold-value ' + (clsName || ''), value != null ? fmtPrice(value) + (suffix || '') : '—');
  row.appendChild(v);
  return row;
}

async function renderGold() {
  const wrap = document.getElementById('gold-content');
  try {
    const data = await api('/api/gold');
    wrap.innerHTML = '';
    wrap.appendChild(goldRow('Gram Altin', data.gram, ' TL'));
    wrap.appendChild(goldRow('Ceyrek Altin', data.ceyrek, ' TL'));
    wrap.appendChild(goldRow('Tam Altin', data.tam, ' TL'));
    wrap.appendChild(goldRow('Ons Altin', data.ons, ' TL'));
    wrap.appendChild(el('div', 'gold-sub',
      'Kaynak: haremaltin.com  ·  Guncelleme: ' +
      new Date(data.updatedAt).toLocaleTimeString('tr-TR')));
  } catch (e) {
    wrap.innerHTML = '<div class="gold-error">Altin verisi yuklenemedi</div>';
  }
}

/* ==================================================================
 *  Haberler (sag panel, son 7 gun)
 * ================================================================== */

async function loadNews(symbol) {
  const listEl = document.getElementById('newsList');
  const titleEl = document.getElementById('newsTitle');
  const subEl = document.getElementById('newsSub');

  listEl.innerHTML = '<div class="news-loading">Haberler yukleniyor…</div>';
  const qs = symbol ? '?symbol=' + encodeURIComponent(symbol) : '?q=BIST100';
  try {
    const data = await api('/api/news' + qs);
    titleEl.textContent = symbol ? '📰 ' + symbol + ' Haberleri' : '📰 Piyasa Haberleri';
    subEl.textContent = (data.name || '') + ' · son 7 gun';

    if (!data.items || !data.items.length) {
      listEl.innerHTML =
        '<div class="news-empty">Son 7 gunde haber bulunamadi.</div>';
      return;
    }
    listEl.innerHTML = '';
    for (const n of data.items) {
      const a = el('a', 'news-item');
      a.href = n.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';

      a.appendChild(el('div', 'n-title', n.title));

      const meta = el('div', 'n-meta');
      if (n.source) meta.appendChild(el('span', 'n-source', n.source));
      meta.appendChild(el('span', '', fmtRelative(n.publishedAt)));
      a.appendChild(meta);

      listEl.appendChild(a);
    }
  } catch (e) {
    listEl.innerHTML =
      '<div class="news-empty">Haberler alinamadi: ' + e.message + '</div>';
  }
}

/* ==================================================================
 *  Formasyon analizi (boga / yukselis sinyalleri)
 * ================================================================== */

let patternLoaded = false;
let patternAiToken = 0;

function openPatternModal() {
  document.getElementById('patternModal').classList.remove('hidden');
  loadPatterns(state.patternDir);
}

function closePatternModal() {
  document.getElementById('patternModal').classList.add('hidden');
}

async function loadPatterns(dir) {
  state.patternDir = dir;
  patternLoaded = true;
  const listEl = document.getElementById('patternList');
  const subEl = document.getElementById('patternSub');
  const sumEl = document.getElementById('patternAiSummary');
  if (sumEl) { sumEl.style.display = 'none'; sumEl.innerHTML = ''; }
  updatePatternHeader(dir);
  listEl.innerHTML = '<div class="pattern-loading">📐 BIST100 hisseleri formasyonlarla karşılaştırılıyor… (10-20 sn)</div>';
  try {
    // 1) Kural-tabanli ham sonuclari hemen goster.
    const base = await api('/api/formations?dir=' + encodeURIComponent(dir));
    renderPatternList(base, null);
    subEl.textContent = patternSubtitle(base, '🤖 AI doğrulaması yapılıyor…');
    // 2) AI ile dogrula / karsilastir ve guncelle.
    const aiData = await api('/api/ai-formations?dir=' + encodeURIComponent(dir));
    renderPatternList(aiData, base);
  } catch (e) {
    patternLoaded = false;
    if (/API 404/.test(e.message)) {
      listEl.innerHTML =
        '<div class="pattern-loading">⚠️ Sunucu eski sürümde çalışıyor (rota bulunamadı).<br>' +
        '<span class="muted">Terminalde Ctrl+C ile durdurup "npm start" ile yeniden başlatın.</span></div>';
    } else {
      listEl.innerHTML =
        '<div class="pattern-loading">Tarama başarısız: ' + e.message + '</div>';
    }
  }
}

/** Modul basligini ve aciklamasini secili yona gore gunceller. */
function updatePatternHeader(dir) {
  const title = document.getElementById('patternTitle');
  const legend = document.getElementById('patternLegend');
  if (title) {
    if (dir === 'bullish') title.textContent = '📐 Yükseliş Formasyonları';
    else if (dir === 'bearish') title.textContent = '📐 Düşüş Formasyonları';
    else title.textContent = '📐 Formasyon Karşılaştırması (Yükseliş vs Düşüş)';
  }
  if (legend) {
    if (dir === 'bullish') {
      legend.innerHTML = 'Klasik teknik analiz formasyonlarıyla taranır. Sadece <b>artış beklenen</b> (boğa) sinyalleri listelenir. Sonuçlar <b>🤖 yapay zeka</b> tarafından doğrulanır, düzeltilir veya elenir. Yatırım tavsiyesi değildir.';
    } else if (dir === 'bearish') {
      legend.innerHTML = 'Klasik teknik analiz formasyonlarıyla taranır. Sadece <b>düşüş beklenen</b> (ayış) sinyalleri listelenir. Sonuçlar <b>🤖 yapay zeka</b> tarafından doğrulanır, düzeltilir veya elenir. Yatırım tavsiyesi değildir.';
    } else {
      legend.innerHTML = 'Hem <b>artış</b> (boğa) hem <b>düşüş</b> (ayış) beklenen formasyonlar yan yana listelenir. Altaki AI karşılaştırma özeti iki yönü karşılaştırır. Yatırım tavsiyesi değildir.';
    }
  }
}

/**
 * Formasyon listesini cizer.
 * data: /api/ai-formations (veya /api/formations) cavabi.
 * base: ham /api/formations cavabi (sub basligi icin).
 */
function renderPatternList(data, base) {
  const listEl = document.getElementById('patternList');
  const subEl = document.getElementById('patternSub');
  const sumEl = document.getElementById('patternAiSummary');
  if (!data || !listEl) return;

  // Tek yon (bullish / bearish): klasik tek liste davranisi.
  if (data.dir !== 'all') {
    state.patternResults = data.results || [];
    const st = data.stats || {};
    let s = 'BIST100 · ' + (st.scanned || data.scanned || 0) + ' hisse tarandı · ' +
      (st.withData != null ? st.withData + ' hissede yeterli veri · ' : '') +
      data.count + ' sinyal';
    if (data.dir === 'bearish') s = s.replace('sinyal', 'düşüş sinyali');
    subEl.textContent = s;
    if (sumEl) { sumEl.style.display = 'none'; sumEl.innerHTML = ''; }

    listEl.innerHTML = '';
    if (!data.results || !data.results.length) {
      const emptyMsg = data.dir === 'bearish'
        ? '📉 Şu anda düşüş beklenen hisse yok.<br><span class="muted">Tarama tamamlandı; onaylı kırılımlı düşüş sinyali bulunamadı.</span>'
        : '📉 Şu anda artış beklenen hisse yok.<br><span class="muted">Tarama tamamlandı; onaylı kırılımlı yükseliş sinyali bulunamadı.</span>';
      listEl.innerHTML = '<div class="pattern-loading">' + emptyMsg + '</div>';
      return;
    }
    listEl.innerHTML = '';
    for (const r of data.results) listEl.appendChild(patternCard(r));
    showAiSummary(data);
    return;
  }

  // data.dir === 'all': iki yon yan yana + AI karsilastirma.
  const bull = data.bullish || {};
  const bear = data.bearish || {};
  const bStats = bull.stats || {};
  const aStats = bear.stats || {};
  subEl.textContent = 'BIST100 · ' +
    ((bStats.scanned || 0) + (aStats.scanned || 0)) + ' hisse tarandı · ' +
    (bull.count || 0) + ' yükseliş · ' + (bear.count || 0) + ' düşüş sinyali';

  // AI ozet banner (ikisini birlestir).
  if (sumEl) {
    sumEl.style.display = 'flex';
    sumEl.innerHTML = '';
    sumEl.appendChild(el('span', 'ai-sum-title', '🤖 AI karşılaştırması'));
    const bSum = bull.aiSummary || {}; const aSum = bear.aiSummary || {};
    sumEl.appendChild(el('span', '', 'Yükseliş: ' + (bSum.approved || 0) + ' onay / ' + (bSum.rejected || 0) + ' red'));
    sumEl.appendChild(el('span', '', 'Düşüş: ' + (aSum.approved || 0) + ' onay / ' + (aSum.rejected || 0) + ' red'));
    if (data.comparison) {
      const comp = el('div', 'ai-comparison', '💬 ' + data.comparison);
      comp.style.marginTop = '6px';
      comp.style.fontSize = '12.5px';
      comp.style.color = '#c4b5fd';
      sumEl.appendChild(comp);
    }
  }

  state.patternResults = [...(bull.results || []), ...(bear.results || [])];
  listEl.innerHTML = '';

  if (bull.results && bull.results.length) {
    listEl.appendChild(el('div', 'pattern-section', '📈 Yükseliş Beklenen (' + bull.count + ')'));
    for (const r of bull.results) listEl.appendChild(patternCard(r));
  } else {
    listEl.appendChild(el('div', 'pattern-empty', '📈 Yükseliş sinyali bulunamadı.'));
  }

  if (bear.results && bear.results.length) {
    listEl.appendChild(el('div', 'pattern-section', '📉 Düşüş Beklenen (' + bear.count + ')'));
    for (const r of bear.results) listEl.appendChild(patternCard(r));
  } else {
    listEl.appendChild(el('div', 'pattern-empty', '📉 Düşüş sinyali bulunamadı.'));
  }
}

/** Formasyon alt basligini uretir; aiState verilirse sonuna eklenir. */
function patternSubtitle(data, aiState) {
  const st = data.stats || {};
  let s = 'BIST100 · ' + (st.scanned || data.scanned || 0) + ' hisse tarandı · ' +
    (st.withData != null ? st.withData + ' hissede yeterli veri · ' : '') +
    (data.count != null ? data.count : (data.results || []).length) + ' yükseliş sinyali';
  if (aiState) s += ' · ' + aiState;
  return s;
}

/** AI dogrulama ozet banner'ini gunceller. */
function showAiSummary(data) {
  const box = document.getElementById('patternAiSummary');
  if (!box) return;
  const s = data.aiSummary;
  if (!data.aiValidated || !s) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '';
  box.appendChild(el('span', 'ai-sum-title', '🤖 Yapay zeka doğrulaması'));
  box.appendChild(el('span', 'ai-sum-ok', '✓ ' + s.approved + ' onaylandı'));
  box.appendChild(el('span', 'ai-sum-fix', '✎ ' + s.adjusted + ' düzeltildi'));
  box.appendChild(el('span', 'ai-sum-rej', '✕ ' + s.rejected + ' elendi'));
  if (s.scanned != null) {
    box.appendChild(el('span', 'ai-sum-total', '(' + s.scanned + ' aday incelendi)'));
  }
  box.style.display = 'flex';
}

/** Kural-tabanli sonuclari AI ile dogrular ve arayuzu gunceller. */
async function aiReviewPatterns(base) {
  const token = ++patternAiToken;
  const listEl = document.getElementById('patternList');
  const subEl = document.getElementById('patternSub');
  if (subEl) subEl.textContent = patternSubtitle(base, '🤖 AI doğrulaması yapılıyor…');
  if (listEl) {
    listEl.insertBefore(
      el('div', 'pattern-ai-note',
        '🤖 Yapay zeka formasyonları gerçek fiyat serisine göre gözden geçiriyor… (15-30 sn)'),
      listEl.firstChild
    );
  }
  try {
    const data = await api('/api/ai-formations');
    if (token !== patternAiToken) return;
    state.patternResults = data.results || [];
    if (subEl) subEl.textContent = patternSubtitle(data, '🤖 AI doğrulandı');
    showAiSummary(data);
    listEl.innerHTML = '';
    if (!data.results || !data.results.length) {
      listEl.innerHTML =
        '<div class="pattern-loading">📉 AI doğrulaması sonrası geçerli yükseliş formasyonu kalmadı.</div>';
      return;
    }
    for (const r of data.results) listEl.appendChild(patternCard(r));
  } catch (e) {
    if (token !== patternAiToken) return;
    if (subEl) subEl.textContent =
      patternSubtitle(base, '⚠️ AI doğrulaması alınamadı: ' + e.message);
  }
}

function patternCard(r) {
  const card = el('div', 'pattern-card');
  card.dataset.symbol = r.symbol;
  const isBearish = r.direction === 'bearish';
  card.classList.add(isBearish ? 'pattern-bearish' : 'pattern-bullish');

  const head = el('div', 'pc-head');
  const symWrap = el('div', 'pc-sym');
  symWrap.appendChild(el('span', 'pc-symbol', r.symbol));
  symWrap.appendChild(el('span', 'pc-name', r.name));
  head.appendChild(symWrap);
  const sign = isBearish ? '−' : '+';
  const pctEl = el('span', 'pc-upside', sign + r.upsidePct + '%');
  pctEl.style.color = isBearish ? 'var(--down)' : 'var(--up)';
  head.appendChild(pctEl);
  card.appendChild(head);

  const verb = isBearish ? 'düşeceğini düşünüyorum.' : 'artacağını düşünüyorum.';
  const verdict = el('div', 'pc-verdict',
    r.patternName + ' formasyonundan faydalanarak ' + r.symbol +
    ' hissesinin ' + verb
  );
  verdict.style.color = isBearish ? 'var(--down)' : 'var(--up)';
  card.appendChild(verdict);

  card.appendChild(el('div', 'pc-detail', r.detail));
  card.appendChild(el('div', 'pc-desc', r.description));

  // AI dogrulama rozeti ve gerekcesi
  if (r.aiVerdict) {
    const labels = { approve: '🤖 AI onayladı', adjust: '🤖 AI düzeltti' };
    card.appendChild(el('span', 'pc-ai-badge pc-ai-' + r.aiVerdict,
      labels[r.aiVerdict] || '🤖 AI'));
    if (r.aiComment) {
      card.appendChild(el('div', 'pc-ai-comment', '🤖 ' + r.aiComment));
    }
  }

  const meta = el('div', 'pc-meta');
  meta.appendChild(el('span', '', 'Fiyat: ' + fmtPrice(r.lastClose) + ' ₺'));
  meta.appendChild(el('span', '', 'Güven: %' + r.confidence));
  meta.appendChild(el('span', '', r.type + ' · Güvenilirlik: ' + r.reliability));
  meta.appendChild(el('span', 'pc-eta',
    '⏳ Tahmini hareket zamanı: ' + (r.eta || r.timeframe || 'belirsiz')));
  card.appendChild(meta);

  if (r.origUpsidePct != null || r.origConfidence != null) {
    const parts = [];
    if (r.origUpsidePct != null) parts.push('hedef %' + r.origUpsidePct + ' → %' + r.upsidePct);
    if (r.origConfidence != null) parts.push('güven %' + r.origConfidence + ' → %' + r.confidence);
    card.appendChild(el('div', 'pc-ai-note', '🤖 AI düzeltmesi: ' + parts.join(' · ')));
  }

  const bar = el('div', 'pc-conf-bar');
  const fill = el('div', 'pc-conf-fill');
  fill.style.width = Math.min(100, r.confidence) + '%';
  bar.appendChild(fill);
  card.appendChild(bar);

  // "Varliklarima ekle" butonu + mini form
  const addBtn = el('button', 'pc-add-btn', '➕ Varlıklarıma Ekle');
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = card.querySelector('.pc-add-form');
    if (existing) {
      existing.remove();
      addBtn.classList.remove('active');
      return;
    }
    addBtn.classList.add('active');
    const form = buildPatternAddForm(r, () => {
      form.remove();
      addBtn.classList.remove('active');
    });
    card.appendChild(form);
  });
  card.appendChild(addBtn);

  // "Varliklarima ekle" yaninda: secili hissenin AI analizini direkt baslatir
  const aiBtn = el('button', 'pc-ai-btn', '🤖 AI Analiz');
  aiBtn.title = r.symbol + ' hissesine AI analiz baslat';
  aiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = card.querySelector('.pc-add-form');
    if (existing) {
      existing.remove();
      addBtn.classList.remove('active');
    }
    addBtn.classList.remove('active');
    openAIStockAnalysis(r.symbol);
  });
  card.appendChild(aiBtn);

  card.addEventListener('click', () => {
    closePatternModal();
    openModal(r.symbol);
  });
  return card;
}

/** Formasyon kartindan varlik ekleme mini formu uretir. */
function buildPatternAddForm(r, onDone) {
  const form = el('form', 'pc-add-form');
  form.addEventListener('click', (e) => e.stopPropagation());

  form.appendChild(el('span', 'pc-add-title',
    r.symbol + ' · ' + r.patternName + ' · ' + r.lastClose + ' ₺'));

  const qtyInput = el('input');
  qtyInput.type = 'number';
  qtyInput.min = '0.000001';
  qtyInput.step = 'any';
  qtyInput.required = true;
  qtyInput.placeholder = 'Adet (örn. 100)';
  form.appendChild(qtyInput);

  const priceInput = el('input');
  priceInput.type = 'number';
  priceInput.min = '0.01';
  priceInput.step = 'any';
  priceInput.required = true;
  priceInput.value = r.lastClose;
  priceInput.title = 'Alış fiyatı (formasyon fiyatı ile öndolduruldu)';
  form.appendChild(priceInput);

  const dateInput = el('input');
  dateInput.type = 'date';
  dateInput.required = true;
  dateInput.value = new Date().toISOString().slice(0, 10);
  form.appendChild(dateInput);

  const save = el('button', 'pc-add-save', 'Kaydet');
  form.appendChild(save);

  const msg = el('span', 'pc-add-msg');
  form.appendChild(msg);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!qtyInput.value || !priceInput.value) return;
    addAsset({
      symbol: r.symbol,
      qty: qtyInput.value,
      buyPrice: priceInput.value,
      buyDate: dateInput.value,
      pattern: {
        patternName: r.patternName,
        upsidePct: r.upsidePct,
        eta: r.eta || r.timeframe || null
      }
    });
    msg.textContent = '✓ Eklendi';
    msg.classList.add('ok');
    setTimeout(onDone, 900);
  });

  return form;
}

/* ==================================================================
 *  AI Analiz
 * ================================================================== */

function openAIModal() {
  const modal = document.getElementById('aiModal');
  if (modal) modal.classList.remove('hidden');
  if (!state.aiMarketSummary) loadAIOverview();
  populateAIStockSelect();
}

function closeAIModal() {
  const modal = document.getElementById('aiModal');
  if (modal) modal.classList.add('hidden');
}

/* Formasyon kartindan direk bir hissenin AI analizini acar ve baslatir. */
async function openAIStockAnalysis(symbol) {
  const cfg = await loadAiConfig();
  if (!cfg || !cfg.configured) {
    openAiConfigModal();
    return;
  }
  const modal = document.getElementById('aiModal');
  if (modal) modal.classList.remove('hidden');
  switchAITab('ai-stock');
  populateAIStockSelect();
  const sel = document.getElementById('aiStockSelect');
  if (sel) sel.value = symbol;
  loadAIStock(symbol);
  if (!state.aiMarketSummary) loadAIOverview();
}

/* ==================================================================
 *  AI ayarlari (api key, base url, model) - sunucu ile iletisim
 * ================================================================== */

async function loadAiConfig() {
  try {
    const res = await fetch('/api/ai-config', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Sunucu hatasi (kodu ' + res.status + ')');
    state.aiConfig = await res.json();
  } catch (e) {
    state.aiConfig = { configured: false, apiBase: '', model: '', error: e.message };
  }
  return state.aiConfig;
}

async function saveAiConfig(payload) {
  const res = await fetch('/api/ai-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Sunucu hatasi (kodu ' + res.status + ')');
  }
  return res.json();
}

async function testAiConnection() {
  const res = await fetch('/api/ai-test', { method: 'POST', headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || err.error || 'Baglanti testi basarisiz');
  }
  return res.json();
}

function showAiConfigMessage(text, kind) {
  const elMsg = document.getElementById('aiConfigMessage');
  if (!elMsg) return;
  elMsg.textContent = text;
  elMsg.className = 'ai-config-message ' + (kind === 'ok' ? 'ok' : 'err');
  elMsg.style.display = 'block';
}
function clearAiConfigMessage() {
  const elMsg = document.getElementById('aiConfigMessage');
  if (elMsg) { elMsg.style.display = 'none'; elMsg.textContent = ''; }
}

function openAiConfigModal() {
  const modal = document.getElementById('aiConfigModal');
  const notice = document.getElementById('aiConfigNotice');
  if (modal) modal.classList.remove('hidden');
  clearAiConfigMessage();
  const cfg = state.aiConfig || {};
  const keyInput = document.getElementById('aiConfigKey');
  if (keyInput) keyInput.value = '';
  const baseInput = document.getElementById('aiConfigBaseUrl');
  if (baseInput) baseInput.value = cfg.apiBase || 'https://integrate.api.nvidia.com/v1/chat/completions';
  const preset = document.getElementById('aiConfigBasePreset');
  if (preset) {
    preset.value = cfg.apiBase || 'https://integrate.api.nvidia.com/v1/chat/completions';
    if ([...preset.options].every((o) => o.value !== preset.value)) preset.value = '__custom__';
  }
  const modelSel = document.getElementById('aiConfigModel');
  if (modelSel) {
    modelSel.value = cfg.model || 'nvidia/nemotron-3.5-super-vl-120b-a12b';
    if ([...modelSel.options].every((o) => o.value !== modelSel.value)) modelSel.value = '__custom__';
  }
  const modelCustom = document.getElementById('aiConfigModelCustom');
  if (modelCustom) {
    if (modelSel && modelSel.value === '__custom__') {
      modelCustom.disabled = false;
      modelCustom.value = cfg.model || '';
    } else { modelCustom.disabled = true; modelCustom.value = ''; }
  }
  if (notice) notice.style.display = 'none';
}

function closeAiConfigModal() {
  const modal = document.getElementById('aiConfigModal');
  if (modal) modal.classList.add('hidden');
}

/* AI analizi acilmeden once: api key var mi? yoksa ayar ekranini acar. */
async function openAIModal() {
  await loadAiConfig();
  if (!state.aiConfig || !state.aiConfig.configured) {
    const notice = document.getElementById('aiConfigNotice');
    if (notice) {
      notice.style.display = 'block';
      notice.textContent = 'Api key girilmeden AI ozellikleri kullanilamaz.';
    }
    openAiConfigModal();
    return;
  }
  const modal = document.getElementById('aiModal');
  if (modal) modal.classList.remove('hidden');
  if (!state.aiMarketSummary) loadAIOverview();
  populateAIStockSelect();
}

async function loadAIOverview() {
  const content = document.getElementById('ai-market-content');
  const loading = document.querySelector('#ai-market .ai-loading');
  if (content) content.innerHTML = '';
  if (loading) loading.style.display = 'block';

  try {
    const res = await fetch('/api/ai-analysis');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Sunucu hatasi (kodu ' + res.status + ')');
    }
    const data = await res.json();
    state.aiMarketSummary = data.summary;
    if (content) content.textContent = data.summary || 'AI analizi bos dondurdu.';
  } catch (e) {
    if (content) content.textContent = 'AI piyasa analizi yuklenemedi: ' + e.message;
  } finally {
    if (loading) loading.style.display = 'none';
  }
}

async function loadAIStock(symbol) {
  const content = document.getElementById('ai-stock-content');
  const loading = document.getElementById('aiStockLoading');
  if (content) content.innerHTML = '';
  if (loading) loading.style.display = 'block';

  // Cache kontrolu
  if (state.aiStockSummaries[symbol]) {
    if (content) content.textContent = state.aiStockSummaries[symbol];
    if (loading) loading.style.display = 'none';
    return;
  }

  try {
    const res = await fetch('/api/ai-analysis-stock?symbol=' + encodeURIComponent(symbol) + '&range=1y');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Sunucu hatasi (kodu ' + res.status + ')');
    }
    const data = await res.json();
    state.aiStockSummaries[symbol] = data.summary || 'AI analizi bos dondurdu.';
    if (content) content.textContent = state.aiStockSummaries[symbol];
  } catch (e) {
    if (content) content.textContent = 'AI hisse analizi yuklenemedi: ' + e.message;
  } finally {
    if (loading) loading.style.display = 'none';
  }
}

function populateAIStockSelect() {
  const select = document.getElementById('aiStockSelect');
  if (!select) return;
  select.innerHTML = '<option value="">-- Hisse secin --</option>';
  for (const s of state.items) {
    const opt = document.createElement('option');
    opt.value = s.symbol;
    opt.textContent = s.symbol + ' - ' + s.name;
    select.appendChild(opt);
  }
}

function switchAITab(tabId) {
  document.querySelectorAll('.ai-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tabId);
  });
  document.querySelectorAll('.ai-tab-panel').forEach((p) => {
    p.classList.toggle('active', p.id === tabId);
  });
}

/* ==================================================================
 *  Baslatma
 * ================================================================== */

function init() {
  updateFavCount();

  // AI ayar durumunu kontrol et (api key / sunucu baglanti durumu)
  loadAiConfig();

  const search = document.getElementById('search');
  search.addEventListener('input', () => {
    state.search = search.value;
    applyFilter();
  });

  const favBtn = document.getElementById('favFilterBtn');
  favBtn.addEventListener('click', () => {
    state.favOnly = !state.favOnly;
    favBtn.classList.toggle('active', state.favOnly);
    applyFilter();
  });

  document.getElementById('refreshBtn').addEventListener('click', () => {
    state.chartCache.clear();
    loadOverview();
    loadNews(state.openSymbol || null);
  });

  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });
  document.getElementById('patternBtn').addEventListener('click', openPatternModal);
  document.getElementById('patternClose').addEventListener('click', closePatternModal);
  // Formasyon yonu toggle butonlari (yukselis / dusus / karsilastirma)
  document.querySelectorAll('.pt-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.pt-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      loadPatterns(btn.dataset.dir);
    });
  });
  document.getElementById('patternModal').addEventListener('click', (e) => {
    if (e.target.id === 'patternModal') closePatternModal();
  });

  // Varliklarim
  updateAssetCount();
  document.getElementById('assetsBtn').addEventListener('click', openAssetsModal);
  document.getElementById('assetsClose').addEventListener('click', closeAssetsModal);
  document.getElementById('assetsModal').addEventListener('click', (e) => {
    if (e.target.id === 'assetsModal') closeAssetsModal();
  });
  document.getElementById('assetAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const sym = document.getElementById('assetSymbol').value;
    const qty = document.getElementById('assetQty').value;
    const price = document.getElementById('assetPrice').value;
    const date = document.getElementById('assetDate').value;
    if (!sym || !qty || !price) return;
    addAsset({ symbol: sym, qty, buyPrice: price, buyDate: date });
    e.target.reset();
  });

  // AI Analiz butonu
  document.getElementById('aiBtn').addEventListener('click', openAIModal);
  document.getElementById('aiClose').addEventListener('click', closeAIModal);
  document.getElementById('aiModal').addEventListener('click', (e) => {
    if (e.target.id === 'aiModal') closeAIModal();
  });
  document.getElementById('aiConfigBtn').addEventListener('click', openAiConfigModal);

  // AI ayarlari modal
  document.getElementById('aiConfigClose').addEventListener('click', closeAiConfigModal);
  document.getElementById('aiConfigModal').addEventListener('click', (e) => {
    if (e.target.id === 'aiConfigModal') closeAiConfigModal();
  });

  // Sifre gostern/gizleyen buton
  document.getElementById('aiConfigKeyToggle').addEventListener('click', function () {
    const inp = document.getElementById('aiConfigKey');
    if (inp.type === 'password') { inp.type = 'text'; this.textContent = '🙈'; }
    else { inp.type = 'password'; this.textContent = '👁️'; }
  });

  // Base URL preset secimi
  document.getElementById('aiConfigBasePreset').addEventListener('change', function () {
    const urlInput = document.getElementById('aiConfigBaseUrl');
    if (this.value === '__custom__') {
      urlInput.disabled = false;
      urlInput.focus();
    } else {
      urlInput.value = this.value;
      urlInput.disabled = false;
    }
  });

  // Model secimi: secilmeli model ise ozel inputu ac
  document.getElementById('aiConfigModel').addEventListener('change', function () {
    const custom = document.getElementById('aiConfigModelCustom');
    if (this.value === '__custom__') { custom.disabled = false; custom.focus(); }
    else { custom.disabled = true; custom.value = ''; }
  });

  // Baglanti testi
  document.getElementById('aiConfigTestBtn').addEventListener('click', async () => {
    const btn = document.getElementById('aiConfigTestBtn');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Test ediliyor…';
    clearAiConfigMessage();
    try {
      await testAiConnection();
      showAiConfigMessage('AI sunucusuna baglanti basarili.', 'ok');
    } catch (e) {
      showAiConfigMessage('Baglanti hatasi: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });

  // Kaydet & etkinlestir
  document.getElementById('aiConfigSaveBtn').addEventListener('click', async () => {
    const key = document.getElementById('aiConfigKey').value.trim();
    const preset = document.getElementById('aiConfigBasePreset');
    let base = document.getElementById('aiConfigBaseUrl').value.trim();
    const modelSel = document.getElementById('aiConfigModel');
    let model = modelSel.value;
    if (model === '__custom__') model = document.getElementById('aiConfigModelCustom').value.trim();
    if (!key) { showAiConfigMessage('API anahtari girilmesi zorunludur.', 'err'); return; }
    if (!base) { showAiConfigMessage('Sunucu adresi girilmesi zorunludur.', 'err'); return; }
    if (preset.value !== '__custom__') base = preset.value;
    if (!model) { showAiConfigMessage('Model secilmelidir.', 'err'); return; }

    const btn = document.getElementById('aiConfigSaveBtn');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Kaydediliyor…';
    clearAiConfigMessage();
    try {
      await saveAiConfig({ apiKey: key, apiBase: base, model: model });
      await loadAiConfig();
      showAiConfigMessage('Ayarlar kaydedildi. Baglanti test ediliyor…', 'ok');
      try {
        await testAiConnection();
        showAiConfigMessage('AI sunucusuna baglanti basarili. AI analiz artik kullanilabilir.', 'ok');
      } catch (e) {
        showAiConfigMessage('Kaydedildi ama baglanti hatasi: ' + e.message, 'err');
      }
    } catch (e) {
      showAiConfigMessage('Kayit basarisiz: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });

  // AI sekmeleri
  document.querySelectorAll('.ai-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      switchAITab(tab.dataset.tab);
      if (tab.dataset.tab === 'ai-stock') {
        const sel = document.getElementById('aiStockSelect');
        if (sel && sel.value) loadAIStock(sel.value);
      }
    });
  });

  // Hisse analiz butonu
  document.getElementById('aiAnalyzeStockBtn').addEventListener('click', () => {
    const sel = document.getElementById('aiStockSelect');
    if (sel && sel.value) loadAIStock(sel.value);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      closePatternModal();
      closeAssetsModal();
      closeAIModal();
      closeAiConfigModal();
    }
  });

  loadOverview();
  loadNews(null);

  // Sayfa yuklendiginde/yenilendiginde otomatik AI piyasa analizi (arkaplan)
  // Sadece API anahtari girilmisse calistirilir.
  if (state.aiConfig && state.aiConfig.configured) loadAIOverview();

  // Anlik guncelleme: her 60 saniyede bir fiyatlari yenile
  setInterval(() => {
    loadOverview();
    document.getElementById('autoRefreshInfo').textContent =
      'Otomatik yenileme: 60 sn';
  }, 60 * 1000);
  document.getElementById('autoRefreshInfo').textContent =
    'Otomatik yenileme: 60 sn';
}

document.addEventListener('DOMContentLoaded', init);
