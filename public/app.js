'use strict';

/* ==================================================================
 *  BIST100 Analist V2 - istemci mantigi
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

/** Varligin bagli oldugu guncel YUKSELIS formasyon sinyali (varsa). */
function currentPatternFor(symbol) {
  for (const r of state.patternResults) {
    if (r.symbol === symbol && r.direction !== 'bearish' && r.upsidePct != null) return r;
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

  const addBtn = el('button', 'expand-btn add-asset-btn', '➕ Varlıklarıma Ekle');
  addBtn.title = sym + ' hissesini portföyüme ekle';
  const addWrap = el('div', 'chart-add-wrap');
  addBtn.addEventListener('click', () => {
    const existing = addWrap.querySelector('.chart-add-form');
    if (existing) {
      existing.remove();
      addBtn.classList.remove('active');
      return;
    }
    addBtn.classList.add('active');
    const form = buildChartAddForm(sym, () => {
      form.remove();
      addBtn.classList.remove('active');
    });
    addWrap.appendChild(form);
  });

  controls.appendChild(rangeWrap);
  controls.appendChild(expand);
  controls.appendChild(addBtn);

  top.appendChild(meta);
  top.appendChild(controls);

  const chartWrap = el('div', 'chart-wrap');
  const loading = el('div', 'chart-loading', 'Grafik yukleniyor…');
  chartWrap.appendChild(loading);

  detail.appendChild(top);
  detail.appendChild(chartWrap);
  detail.appendChild(addWrap);
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

  const addWrap = document.getElementById('modalAddWrap');
  if (addWrap) {
    addWrap.innerHTML = '';
    const addBtn = el('button', 'btn btn-small add-asset-btn', '➕ Varlıklarıma Ekle');
    addBtn.title = sym + ' hissesini portföyüme ekle';
    addBtn.addEventListener('click', () => {
      const existing = addWrap.querySelector('.chart-add-form');
      if (existing) {
        existing.remove();
        addBtn.classList.remove('active');
        return;
      }
      addBtn.classList.add('active');
      const form = buildChartAddForm(sym, () => {
        form.remove();
        addBtn.classList.remove('active');
      });
      addWrap.appendChild(form);
    });
    addWrap.appendChild(addBtn);
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
  const addWrap = document.getElementById('modalAddWrap');
  if (addWrap) addWrap.innerHTML = '';
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

function goldRow(label, value, suffix, clsName, prefix) {
  const row = el('div', 'gold-row');
  row.appendChild(el('span', 'gold-label', label));
  const text =
    value != null ? (prefix || '') + fmtPrice(value) + (suffix || '') : '—';
  const v = el('span', 'gold-value ' + (clsName || ''), text);
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

    const ons = data.onsUsd != null ? data.onsUsd : data.ons;
    if (ons != null) {
      wrap.appendChild(goldRow('Ons Altin ($)', ons, '', '', '$'));
    } else {
      wrap.appendChild(goldRow('Ons Altin', data.onsTry, ' TL'));
    }

    const source =
      data.sourceLabel ||
      (data.source === 'yahoo' ? 'Yahoo Finance (yedek)' : 'Truncgil Finans');
    const note =
      data.source === 'yahoo'
        ? 'Yedek kaynak · Hesaplanan değerler'
        : 'Satış fiyatları';
    const time = data.sourceTime
      ? data.sourceTime
      : new Date(data.updatedAt).toLocaleTimeString('tr-TR');
    const stale = data.stale ? ' · Son bilinen veri' : '';
    wrap.appendChild(
      el(
        'div',
        'gold-sub',
        'Kaynak: ' +
          source +
          ' · ' +
          note +
          ' · Güncelleme: ' +
          time +
          stale
      )
    );
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
let patternRequestToken = 0;

function openPatternModal() {
  document.getElementById('patternModal').classList.remove('hidden');
  loadPatterns(state.patternDir);
}

function closePatternModal() {
  document.getElementById('patternModal').classList.add('hidden');
}

function showPatternAiNotice(kind, text, actionLabel, action) {
  const box = document.getElementById('patternAiNotice');
  if (!box) return;
  box.className = 'pattern-ai-notice ' + (kind || 'info');
  box.innerHTML = '';
  box.appendChild(el('span', 'pai-text', text));
  if (actionLabel && action) {
    const btn = el('button', 'btn btn-small', actionLabel);
    btn.type = 'button';
    btn.addEventListener('click', action);
    box.appendChild(btn);
  }
  box.style.display = 'flex';
}

function hidePatternAiNotice() {
  const box = document.getElementById('patternAiNotice');
  if (!box) return;
  box.style.display = 'none';
  box.innerHTML = '';
}

async function loadPatterns(dir, force) {
  const token = ++patternRequestToken;
  state.patternDir = dir;
  patternLoaded = true;
  const listEl = document.getElementById('patternList');
  const subEl = document.getElementById('patternSub');
  const sumEl = document.getElementById('patternAiSummary');
  if (sumEl) {
    sumEl.style.display = 'none';
    sumEl.innerHTML = '';
  }
  hidePatternAiNotice();
  updatePatternHeader(dir);
  listEl.innerHTML =
    '<div class="pattern-loading">📐 BIST100 hisseleri formasyonlarla karşılaştırılıyor… (10-20 sn)</div>';

  let base = null;
  try {
    // 1) Kural tabanli ham sonuclari hemen goster.
    base = await api('/api/formations?dir=' + encodeURIComponent(dir));
    if (token !== patternRequestToken) return;
    renderPatternList(base, base);

    // 2) AI anahtari yoksa kural tabanli sonuclar korunur; kullaniciya bilgi verilir.
    if (!state.aiConfig || !state.aiConfig.configured) {
      subEl.textContent = patternSubtitle(base, 'AI doğrulaması için API anahtarı gerekli');
      showPatternAiNotice(
        'warn',
        '🤖 Formasyonları haber ve gerçek fiyat serisiyle doğrulamak için API anahtarınızı girin.',
        '🔑 API Anahtarı Gir',
        () => openAiConfigModal(true)
      );
      return;
    }

    subEl.textContent = patternSubtitle(base, '🤖 AI doğrulaması yapılıyor…');
    showPatternAiNotice(
      'info',
      '🤖 AI formasyonları gerçek fiyat serisi ve göstergelerle doğruluyor… (30-120 sn)'
    );

    try {
      const aiData = await aiFetch(
        '/api/ai-formations?dir=' + encodeURIComponent(dir) + (force ? '&fresh=1' : '')
      );
      if (token !== patternRequestToken) return;
      hidePatternAiNotice();
      renderPatternList(aiData, base);

      const errParts = [];
      if (aiData.aiError) errParts.push(aiData.aiError);
      if (aiData.dir === 'all') {
        if (aiData.bullish && aiData.bullish.aiError) errParts.push(aiData.bullish.aiError);
        if (aiData.bearish && aiData.bearish.aiError) errParts.push(aiData.bearish.aiError);
      }
      if (errParts.length) {
        const noneValidated =
          aiData.aiValidated === false &&
          (!aiData.bullish || aiData.bullish.aiValidated === false) &&
          (!aiData.bearish || aiData.bearish.aiValidated === false);
        showPatternAiNotice(
          'warn',
          (noneValidated
            ? '⚠️ AI doğrulaması alınamadı; kural tabanlı sonuçlar gösteriliyor. '
            : '⚠️ AI doğrulaması kısmen alındı; doğrulanamayan adaylar kural tabanlı olarak korundu. ') +
            errParts[0],
          '↻ Tekrar Dene',
          () => loadPatterns(dir, true)
        );
      }
    } catch (e) {
      if (token !== patternRequestToken) return;
      if (e.code === 'ai_key_missing') {
        openAiConfigModal(true);
        return;
      }
      subEl.textContent = patternSubtitle(base, 'AI doğrulaması alınamadı');
      showPatternAiNotice(
        'warn',
        '⚠️ AI doğrulaması alınamadı; kural tabanlı sonuçlar gösteriliyor. ' + e.message,
        '↻ Tekrar Dene',
        () => loadPatterns(dir, true)
      );
    }
  } catch (e) {
    if (token !== patternRequestToken) return;
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
    const dirLabel = data.dir === 'bearish' ? 'düşüş sinyali' : 'yükseliş sinyali';
    let s = 'BIST100 · ' + (st.scanned || data.scanned || 0) + ' hisse tarandı · ' +
      (st.withData != null ? st.withData + ' hissede yeterli veri · ' : '') +
      (data.count != null ? data.count : (data.results || []).length) + ' ' + dirLabel;
    if (data.aiError) s += ' · AI doğrulaması alınamadı';
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
    (bStats.scanned || aStats.scanned || 0) + ' hisse tarandı · ' +
    (bull.count || 0) + ' yükseliş · ' + (bear.count || 0) + ' düşüş sinyali';

  // AI ozet banner (iki yon birlikte).
  if (sumEl) {
    if (bull.aiValidated || bear.aiValidated) {
      sumEl.style.display = 'flex';
      sumEl.innerHTML = '';
      sumEl.appendChild(el('span', 'ai-sum-title', '🤖 AI karşılaştırması'));
      const bSum = bull.aiSummary || {};
      const aSum = bear.aiSummary || {};
      sumEl.appendChild(
        el(
          'span',
          '',
          'Yükseliş: ' +
            (bSum.approved || 0) +
            ' onay / ' +
            (bSum.adjusted || 0) +
            ' düzeltme / ' +
            (bSum.rejected || 0) +
            ' red'
        )
      );
      sumEl.appendChild(
        el(
          'span',
          '',
          'Düşüş: ' +
            (aSum.approved || 0) +
            ' onay / ' +
            (aSum.adjusted || 0) +
            ' düzeltme / ' +
            (aSum.rejected || 0) +
            ' red'
        )
      );
      if (data.comparison) {
        const comp = el('div', 'ai-comparison', '💬 ' + data.comparison);
        comp.style.marginTop = '6px';
        comp.style.fontSize = '12.5px';
        sumEl.appendChild(comp);
      }
    } else {
      sumEl.style.display = 'none';
      sumEl.innerHTML = '';
    }
  }

  // AI doğrulaması olmayan adaylar da listede kalır (kural tabanlı sonuç kaybolmaz).
  const bullResults = bull.results || [];
  const bearResults = bear.results || [];

  state.patternResults = [...bullResults, ...bearResults];
  listEl.innerHTML = '';

  subEl.textContent =
    'BIST100 · ' +
    (bStats.scanned || 0) +
    ' hisse tarandı · ' +
    bullResults.length +
    ' yükseliş · ' +
    bearResults.length +
    ' düşüş sinyali' +
    (bull.aiValidated || bear.aiValidated ? ' · AI doğrulandı' : ' · Kural tabanlı');

  if (bullResults.length) {
    listEl.appendChild(
      el(
        'div',
        'pattern-section',
        '📈 Yükseliş Beklenen' +
          (bull.aiValidated ? ' · AI doğrulamalı' : ' · Kural Tabanlı') +
          ' (' +
          bullResults.length +
          ')'
      )
    );
    for (const r of bullResults) listEl.appendChild(patternCard(r));
  } else {
    listEl.appendChild(
      el('div', 'pattern-empty', '📈 Tamamlanmış yükseliş formasyonu bulunamadı.')
    );
  }

  if (bearResults.length) {
    listEl.appendChild(
      el(
        'div',
        'pattern-section',
        '📉 Düşüş Beklenen' +
          (bear.aiValidated ? ' · AI doğrulamalı' : ' · Kural Tabanlı') +
          ' (' +
          bearResults.length +
          ')'
      )
    );
    for (const r of bearResults) listEl.appendChild(patternCard(r));
  } else {
    listEl.appendChild(
      el('div', 'pattern-empty', '📉 Tamamlanmış düşüş formasyonu bulunamadı.')
    );
  }
}

/** Formasyon alt basligini uretir; aiState verilirse sonuna eklenir. */
function patternSubtitle(data, aiState) {
  const st = data.stats || {};
  let s;
  if (data.dir === 'all') {
    const bStats = (data.bullish && data.bullish.stats) || st;
    s =
      'BIST100 · ' +
      (bStats.scanned || data.scanned || 0) +
      ' hisse tarandı · ' +
      (bStats.withData != null ? bStats.withData + ' hissede yeterli veri · ' : '') +
      'çift yönlü tarama';
  } else {
    s = 'BIST100 · ' + (st.scanned || data.scanned || 0) + ' hisse tarandı · ' +
      (st.withData != null ? st.withData + ' hissede yeterli veri · ' : '') +
      (data.count != null ? data.count : (data.results || []).length) +
      (data.dir === 'bearish' ? ' düşüş sinyali' : ' yükseliş sinyali');
  }
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
  if (s.unvalidated) {
    box.appendChild(el('span', 'ai-sum-total', s.unvalidated + ' aday AI dışı bırakıldı'));
  }
  if (s.scanned != null) {
    box.appendChild(el('span', 'ai-sum-total', '(' + s.scanned + ' aday incelendi)'));
  }
  box.style.display = 'flex';
}

/** Kural-tabanli sonuclari AI ile dogrular ve arayuzu gunceller. */

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

/** Grafik ekranindan (ana liste veya buyutme) hizli varlik ekleme formu. */
function buildChartAddForm(sym, onDone) {
  const item = state.bySymbol[sym] || {};
  const form = el('form', 'chart-add-form');
  form.addEventListener('click', (e) => e.stopPropagation());

  const title = el(
    'span',
    'chart-add-title',
    sym + ' · ' + (item.name || '') + ' · Güncel: ' + fmtPrice(item.price) + ' ₺'
  );
  form.appendChild(title);

  const label = (text, input) => {
    const wrap = el('label', 'chart-add-label');
    wrap.appendChild(el('span', '', text));
    wrap.appendChild(input);
    return wrap;
  };

  const qtyInput = document.createElement('input');
  qtyInput.type = 'number';
  qtyInput.min = '0.000001';
  qtyInput.step = 'any';
  qtyInput.required = true;
  qtyInput.placeholder = 'örn. 100';
  form.appendChild(label('Adet', qtyInput));

  const priceInput = document.createElement('input');
  priceInput.type = 'number';
  priceInput.min = '0.01';
  priceInput.step = 'any';
  priceInput.required = true;
  if (item.price != null && isFinite(item.price)) priceInput.value = String(item.price);
  priceInput.title = 'Alış fiyatı (güncel fiyatla ön dolduruldu)';
  form.appendChild(label('Alış Fiyatı (₺)', priceInput));

  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.required = true;
  dateInput.value = new Date().toISOString().slice(0, 10);
  form.appendChild(label('Alış Tarihi', dateInput));

  const save = el('button', 'pc-add-save', 'Kaydet');
  save.type = 'submit';
  form.appendChild(save);

  const msg = el('span', 'pc-add-msg');
  form.appendChild(msg);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!qtyInput.value || !priceInput.value) return;
    const pattern = currentPatternFor(sym);
    addAsset({
      symbol: sym,
      qty: qtyInput.value,
      buyPrice: priceInput.value,
      buyDate: dateInput.value,
      pattern: pattern
        ? {
            patternName: pattern.patternName,
            upsidePct: pattern.upsidePct,
            eta: pattern.eta || pattern.timeframe || null
          }
        : null
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

const AI_CFG_KEY = 'bist100_ai_config';

const AI_PROVIDERS = {
  evren: {
    label: 'EVREN (SSB)',
    base: 'https://evren-llmapi.ssyz.org.tr/v1/chat/completions',
    model: 'auto',
    hint: 'evren_llm_...',
    models: [
      'auto',
      'glm-5.3',
      'deepseek-v4.1-flash',
      'mimo-v2.6-pro',
      'qwen3.8-flash-next',
      'gemma-4-31b',
      'qwen3-vl-30b'
    ]
  },
  nvidia: {
    label: 'NVIDIA NIM',
    base: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    hint: 'nvapi-...',
    models: [
      'nvidia/nemotron-3.5-super-vl-120b-a12b',
      'nvidia/llama-3.1-nemotron-70b-instruct'
    ]
  },
  openai: {
    label: 'OpenAI',
    base: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o',
    hint: 'sk-...',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini', 'o3-mini']
  },
  openrouter: {
    label: 'OpenRouter',
    base: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'openai/gpt-4o',
    hint: 'sk-or-...',
    models: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 'google/gemini-pro-1.5']
  },
  groq: {
    label: 'Groq',
    base: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.1-405b-instruct',
    hint: 'gsk_...',
    models: ['llama-3.1-405b-instruct', 'mixtral-8x7b-32768']
  },
  deepseek: {
    label: 'DeepSeek',
    base: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    hint: 'sk-...',
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  custom: {
    label: 'Özel',
    base: '',
    model: '',
    hint: 'API anahtarı',
    models: []
  }
};

function readLocalAiConfig() {
  try {
    const raw = localStorage.getItem(AI_CFG_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (!cfg || !cfg.apiKey) return null;
    return cfg;
  } catch (_) {
    return null;
  }
}

function saveLocalAiConfig(cfg) {
  localStorage.setItem(AI_CFG_KEY, JSON.stringify(cfg));
}

function clearLocalAiConfig() {
  localStorage.removeItem(AI_CFG_KEY);
}

function providerPreset(provider) {
  return AI_PROVIDERS[provider] || AI_PROVIDERS.custom;
}

function detectProviderFromKey(key, fallback) {
  const k = String(key || '').trim().toLowerCase();
  if (k.startsWith('evren_llm_')) return 'evren';
  if (k.startsWith('nvapi-')) return 'nvidia';
  if (k.startsWith('gsk_')) return 'groq';
  if (k.startsWith('sk-or-')) return 'openrouter';
  return fallback || 'evren';
}

/** AI isteklerine kullanici bazli anahtar basliklarini ekler. */
function aiHeaders(extra) {
  const headers = Object.assign({ Accept: 'application/json' }, extra || {});
  const cfg = state.aiConfig || {};
  if (cfg.apiKey) {
    headers['X-AI-Key'] = cfg.apiKey;
    if (cfg.apiBase) headers['X-AI-Base'] = cfg.apiBase;
    if (cfg.model) headers['X-AI-Model'] = cfg.model;
    if (cfg.provider) headers['X-AI-Provider'] = cfg.provider;
  }
  return headers;
}

async function aiFetch(path, options) {
  const opts = options || {};
  const res = await fetch(path, {
    ...opts,
    headers: aiHeaders(opts.headers)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.detail || err.error || 'Sunucu hatası (' + res.status + ')');
    e.code = err.code;
    e.status = res.status;
    throw e;
  }
  return res.json();
}

function updateApiKeyState() {
  const dot = document.getElementById('apiKeyDot');
  const btn = document.getElementById('apiKeyBtn');
  const cfg = state.aiConfig || {};
  if (dot) {
    dot.classList.toggle('on', !!cfg.configured);
    dot.classList.toggle('server', !!cfg.configured && cfg.source === 'server');
    dot.title = cfg.configured ? 'API anahtarı aktif' : 'API anahtarı girilmedi';
  }
  if (btn) {
    const provider = cfg.provider ? providerPreset(cfg.provider).label : '';
    btn.title = cfg.configured
      ? 'API anahtarı aktif' + (cfg.source === 'server' ? ' (sunucu varsayılanı)' : provider ? ' · ' + provider : '')
      : 'AI API anahtarı ayarları';
  }
}

/** AI yanitindaki basit Markdown'i guvenli HTML'e cevirir. */
function renderAiMarkdown(text) {
  if (!text) return '';
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let inList = false;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html += '<p>' + paragraph.join('<br>') + '</p>';
    paragraph = [];
  };
  const closeList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(4, heading[1].length + 2); // h3..h6
      html += '<h' + level + '>' + inline(heading[2]) + '</h' + level + '>';
      continue;
    }
    if (/^[-*•]\s+/.test(line)) {
      flushParagraph();
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += '<li>' + inline(line.replace(/^[-*•]\s+/, '')) + '</li>';
      continue;
    }
    closeList();
    paragraph.push(inline(line));
  }
  flushParagraph();
  closeList();
  return html;

  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
  }
}

function setAiContent(container, text) {
  if (!container) return;
  container.innerHTML = renderAiMarkdown(text);
  container.classList.add('ai-markdown');
}

function closeAIModal() {
  const modal = document.getElementById('aiModal');
  if (modal) modal.classList.add('hidden');
}

/* Formasyon kartindan direk bir hissenin AI analizini acar ve baslatir. */
async function openAIStockAnalysis(symbol) {
  const cfg = await loadAiConfig();
  if (!cfg || !cfg.configured) {
    const notice = document.getElementById('aiConfigNotice');
    if (notice) {
      notice.style.display = 'block';
      notice.textContent = 'AI analizi için önce API anahtarınızı girin.';
    }
    openAiConfigModal(true);
    return;
  }
  const modal = document.getElementById('aiModal');
  if (modal) modal.classList.remove('hidden');
  switchAITab('ai-stock');
  populateAIStockSelect();
  const sel = document.getElementById('aiStockSelect');
  if (sel) sel.value = symbol;
  const horizonSel = document.getElementById('aiHorizon');
  loadAIStock(symbol, horizonSel ? horizonSel.value : 'all');
  if (!state.aiMarketSummary) loadAIOverview();
}

const AI_MODEL_LABELS = {
  auto: 'auto — otomatik yönlendirme (önerilen)',
  'glm-5.3': 'glm-5.3 — Z.ai GLM (amiral model)',
  'deepseek-v4.1-flash': 'deepseek-v4.1-flash — DeepSeek (hızlı)',
  'deepseek-v4-flash': 'deepseek-v4-flash — DeepSeek',
  'mimo-v2.6-pro': 'mimo-v2.6-pro — Xiaomi (büyük bağlam)',
  'qwen3.8-flash-next': 'qwen3.8-flash-next — Qwen',
  'gemma-4-31b': 'gemma-4-31b — Google Gemma',
  'qwen3-vl-30b': 'qwen3-vl-30b — Qwen görsel',
  'nvidia/nemotron-3.5-super-vl-120b-a12b': 'Nemotron 3.5 Super 120B (NVIDIA)',
  'nvidia/llama-3.1-nemotron-70b-instruct': 'Nemotron 70B (NVIDIA)',
  'gpt-4o': 'GPT-4o (OpenAI)',
  'gpt-4o-mini': 'GPT-4o mini (OpenAI)',
  'gpt-4.1-mini': 'GPT-4.1 mini (OpenAI)',
  'o3-mini': 'o3-mini (OpenAI)',
  'deepseek-chat': 'deepseek-chat',
  'deepseek-reasoner': 'deepseek-reasoner'
};

function modelLabel(id) {
  return AI_MODEL_LABELS[id] || id;
}

async function loadAiConfig() {
  const local = readLocalAiConfig();
  if (local) {
    state.aiConfig = {
      ...local,
      configured: true,
      source: 'browser'
    };
    updateApiKeyState();
    return state.aiConfig;
  }

  try {
    const res = await fetch('/api/ai-config', {
      headers: { Accept: 'application/json' }
    });
    const cfg = res.ok ? await res.json() : {};
    state.aiConfig = {
      configured: !!cfg.configured,
      provider: cfg.provider || 'nvidia',
      apiKey: '',
      apiBase: cfg.apiBase || AI_PROVIDERS.nvidia.base,
      model: cfg.model || AI_PROVIDERS.nvidia.model,
      source: 'server'
    };
  } catch (_) {
    state.aiConfig = {
      configured: false,
      provider: 'evren',
      apiKey: '',
      apiBase: AI_PROVIDERS.evren.base,
      model: AI_PROVIDERS.evren.model,
      source: 'browser'
    };
  }
  updateApiKeyState();
  return state.aiConfig;
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
  if (elMsg) {
    elMsg.style.display = 'none';
    elMsg.textContent = '';
  }
}

function fillModelOptions(provider, currentModel) {
  const sel = document.getElementById('aiConfigModel');
  const custom = document.getElementById('aiConfigModelCustom');
  if (!sel) return;
  const preset = providerPreset(provider);
  const models = (preset.models || []).slice();
  const current = String(currentModel || '').trim();
  if (current && !models.includes(current)) models.unshift(current);

  sel.innerHTML = '';
  for (const id of models) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = modelLabel(id);
    sel.appendChild(opt);
  }
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = 'Özel model kimliği …';
  sel.appendChild(customOpt);

  if (custom) {
    if (current && !models.includes(current)) {
      sel.value = '__custom__';
      custom.value = current;
      custom.style.display = 'block';
    } else {
      sel.value = current || models[0] || '__custom__';
      custom.value = '';
      custom.style.display = sel.value === '__custom__' ? 'block' : 'none';
    }
  }
}

function applyProviderToForm(provider) {
  const preset = providerPreset(provider);
  const baseInput = document.getElementById('aiConfigBaseUrl');
  const keyInput = document.getElementById('aiConfigKey');
  const hint = document.getElementById('aiConfigKeyHint');
  if (baseInput && preset.base) baseInput.value = preset.base;
  if (keyInput) keyInput.placeholder = preset.hint + ' anahtarınızı girin';
  if (hint) hint.textContent = '(' + preset.hint + ')';
  fillModelOptions(provider, preset.model);
}

function openAiConfigModal(showNotice) {
  const modal = document.getElementById('aiConfigModal');
  if (modal) modal.classList.remove('hidden');
  clearAiConfigMessage();

  const cfg = state.aiConfig || {};
  // Anahtar yoksa onerilen saglayici EVREN'dir; sunucu varsayilani varsa onu koru.
  const provider = cfg.configured && AI_PROVIDERS[cfg.provider] ? cfg.provider : 'evren';
  const preset = providerPreset(provider);
  const effectiveBase = cfg.configured ? cfg.apiBase || preset.base : preset.base;
  const effectiveModel = cfg.configured ? cfg.model || preset.model : preset.model;

  const providerSel = document.getElementById('aiConfigProvider');
  if (providerSel) providerSel.value = provider;

  const keyInput = document.getElementById('aiConfigKey');
  if (keyInput) {
    const saved = readLocalAiConfig();
    keyInput.value = '';
    keyInput.type = 'password';
    keyInput.placeholder = saved
      ? 'Kayıtlı anahtar kullanılacak (değiştirmek için yazın)'
      : preset.hint + ' anahtarınızı girin';
  }
  const hint = document.getElementById('aiConfigKeyHint');
  if (hint) hint.textContent = '(' + preset.hint + ')';
  const toggle = document.getElementById('aiConfigKeyToggle');
  if (toggle) toggle.textContent = '👁️';

  const baseInput = document.getElementById('aiConfigBaseUrl');
  if (baseInput) baseInput.value = effectiveBase;
  fillModelOptions(provider, effectiveModel);

  const notice = document.getElementById('aiConfigNotice');
  if (notice) {
    notice.style.display = showNotice ? 'block' : 'none';
    if (showNotice) notice.textContent = 'API anahtarı girilmeden AI özellikleri kullanılamaz.';
  }
}

function closeAiConfigModal() {
  const modal = document.getElementById('aiConfigModal');
  if (modal) modal.classList.add('hidden');
}

function formAiConfig() {
  const providerSel = document.getElementById('aiConfigProvider');
  const provider = providerSel ? providerSel.value : 'evren';
  const keyInput = document.getElementById('aiConfigKey');
  const saved = readLocalAiConfig();
  const apiKey = keyInput && keyInput.value.trim()
    ? keyInput.value.trim()
    : saved
    ? saved.apiKey
    : '';
  const baseInput = document.getElementById('aiConfigBaseUrl');
  const apiBase = baseInput ? baseInput.value.trim() : '';
  const modelSel = document.getElementById('aiConfigModel');
  let model = modelSel ? modelSel.value : '';
  if (model === '__custom__') {
    const custom = document.getElementById('aiConfigModelCustom');
    model = custom ? custom.value.trim() : '';
  }
  return { provider, apiKey, apiBase, model };
}

function configHeaders(cfg) {
  const headers = { Accept: 'application/json' };
  if (cfg.apiKey) headers['X-AI-Key'] = cfg.apiKey;
  if (cfg.apiBase) headers['X-AI-Base'] = cfg.apiBase;
  if (cfg.model) headers['X-AI-Model'] = cfg.model;
  if (cfg.provider) headers['X-AI-Provider'] = cfg.provider;
  return headers;
}

async function testAiConfigFromForm() {
  const cfg = formAiConfig();
  if (!cfg.apiKey) {
    showAiConfigMessage('API anahtarı girilmesi zorunludur.', 'err');
    return;
  }
  if (!cfg.apiBase) {
    showAiConfigMessage('Sunucu adresi girilmesi zorunludur.', 'err');
    return;
  }
  if (!cfg.model) {
    showAiConfigMessage('Model seçilmelidir.', 'err');
    return;
  }

  const btn = document.getElementById('aiConfigTestBtn');
  const orig = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Test ediliyor…';
  }
  clearAiConfigMessage();
  try {
    const data = await (async () => {
      const res = await fetch('/api/ai-test', {
        method: 'POST',
        headers: { ...configHeaders(cfg), 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || err.error || 'Bağlantı testi başarısız');
      }
      return res.json();
    })();
    showAiConfigMessage(
      'Bağlantı başarılı · ' +
        providerPreset(data.provider || cfg.provider).label +
        ' · ' +
        (data.model || cfg.model) +
        (data.modelCount ? ' · ' + data.modelCount + ' model' : ''),
      'ok'
    );
  } catch (e) {
    showAiConfigMessage('Bağlantı hatası: ' + e.message, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }
}

async function fetchAiModelsFromForm() {
  const cfg = formAiConfig();
  if (!cfg.apiKey) {
    showAiConfigMessage('Model listesi için API anahtarı girin.', 'err');
    return;
  }
  const btn = document.getElementById('aiConfigFetchModels');
  const orig = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Getiriliyor…';
  }
  clearAiConfigMessage();
  try {
    const res = await fetch('/api/ai-models', { headers: configHeaders(cfg) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || data.error || 'Model listesi alınamadı');
    const models = data.models || [];
    const sel = document.getElementById('aiConfigModel');
    const custom = document.getElementById('aiConfigModelCustom');
    if (sel) {
      sel.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label || m.id;
        sel.appendChild(opt);
      }
      if (!models.length) {
        const opt = document.createElement('option');
        opt.value = cfg.model;
        opt.textContent = modelLabel(cfg.model);
        sel.appendChild(opt);
      }
      const customOpt = document.createElement('option');
      customOpt.value = '__custom__';
      customOpt.textContent = 'Özel model kimliği …';
      sel.appendChild(customOpt);
      sel.value = models.some((m) => m.id === cfg.model)
        ? cfg.model
        : models[0]
        ? models[0].id
        : '__custom__';
      if (custom) {
        custom.style.display = sel.value === '__custom__' ? 'block' : 'none';
        custom.value = sel.value === '__custom__' ? cfg.model : '';
      }
    }
    showAiConfigMessage(models.length + ' model bulundu.', 'ok');
  } catch (e) {
    showAiConfigMessage('Model listesi alınamadı: ' + e.message, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }
}

async function saveAiConfigFromForm() {
  const cfg = formAiConfig();
  if (!cfg.apiKey) {
    showAiConfigMessage('API anahtarı girilmesi zorunludur.', 'err');
    return;
  }
  if (!cfg.apiBase) {
    showAiConfigMessage('Sunucu adresi girilmesi zorunludur.', 'err');
    return;
  }
  if (!cfg.model) {
    showAiConfigMessage('Model seçilmelidir.', 'err');
    return;
  }

  saveLocalAiConfig(cfg);
  state.aiConfig = { ...cfg, configured: true, source: 'browser' };
  state.aiMarketSummary = null;
  state.aiStockSummaries = {};
  updateApiKeyState();

  showAiConfigMessage('Ayarlar bu tarayıcıya kaydedildi. Bağlantı test ediliyor…', 'ok');
  try {
    const res = await fetch('/api/ai-test', {
      method: 'POST',
      headers: { ...configHeaders(cfg), 'Content-Type': 'application/json' },
      body: '{}'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || data.error || 'Bağlantı testi başarısız');
    showAiConfigMessage(
      'Kaydedildi ve bağlantı başarılı · ' +
        providerPreset(data.provider || cfg.provider).label +
        ' · ' +
        (data.model || cfg.model),
      'ok'
    );
  } catch (e) {
    showAiConfigMessage('Kaydedildi ancak bağlantı hatası: ' + e.message, 'err');
  }

  // Acik AI pencerelerini tazele.
  const patternModal = document.getElementById('patternModal');
  if (patternModal && !patternModal.classList.contains('hidden')) {
    loadPatterns(state.patternDir);
  }
  const aiModal = document.getElementById('aiModal');
  if (aiModal && !aiModal.classList.contains('hidden')) {
    state.aiMarketSummary = null;
    loadAIOverview(true);
    const sel = document.getElementById('aiStockSelect');
    if (sel && sel.value) {
      const h = document.getElementById('aiHorizon');
      loadAIStock(sel.value, h ? h.value : 'all', true);
    }
  }
}

async function clearAiConfigFromForm() {
  clearLocalAiConfig();
  state.aiMarketSummary = null;
  state.aiStockSummaries = {};
  await loadAiConfig();
  clearAiConfigMessage();
  if (state.aiConfig.configured) {
    showAiConfigMessage('Tarayıcıdaki anahtar silindi; sunucu varsayılanı kullanılacak.', 'ok');
  } else {
    showAiConfigMessage('API anahtarı silindi. AI özellikleri için yeniden anahtar girin.', 'err');
  }
  const notice = document.getElementById('aiConfigNotice');
  if (notice && !state.aiConfig.configured) notice.style.display = 'block';
}

/* AI analizi acilmeden once: api key var mi? yoksa ayar ekranini acar. */
async function openAIModal() {
  await loadAiConfig();
  if (!state.aiConfig || !state.aiConfig.configured) {
    openAiConfigModal(true);
    return;
  }
  const modal = document.getElementById('aiModal');
  if (modal) modal.classList.remove('hidden');
  const content = document.getElementById('ai-market-content');
  if (!state.aiMarketSummary) {
    loadAIOverview();
  } else if (content && !content.innerHTML.trim()) {
    setAiContent(content, state.aiMarketSummary);
  }
  populateAIStockSelect();
}

let aiMarketToken = 0;
let aiStockToken = 0;

async function loadAIOverview(force) {
  const token = ++aiMarketToken;
  const content = document.getElementById('ai-market-content');
  const loading = document.querySelector('#ai-market .ai-loading');
  if (!state.aiConfig || !state.aiConfig.configured) {
    openAiConfigModal(true);
    return;
  }
  if (loading) {
    loading.style.display = 'block';
    loading.textContent = 'Piyasa analizi hazırlanıyor… (haberler ve formasyonlar inceleniyor)';
  }
  if (content) content.innerHTML = '';

  try {
    const data = await aiFetch('/api/ai-analysis' + (force ? '?fresh=1' : ''));
    if (token !== aiMarketToken) return;
    state.aiMarketSummary = data.summary || '';
    setAiContent(content, data.summary || 'AI analizi boş döndü.');
    const sub = document.getElementById('aiSub');
    if (sub && data.updatedAt) {
      sub.textContent =
        'Piyasa analizi · ' +
        new Date(data.updatedAt).toLocaleString('tr-TR') +
        (data.model ? ' · ' + data.model : '');
    }
  } catch (e) {
    if (token !== aiMarketToken) return;
    if (e.code === 'ai_key_missing') {
      openAiConfigModal(true);
      return;
    }
    if (content) {
      content.classList.remove('ai-markdown');
      content.textContent = 'AI piyasa analizi yüklenemedi: ' + e.message;
    }
  } finally {
    if (token === aiMarketToken && loading) loading.style.display = 'none';
  }
}

async function loadAIStock(symbol, horizon, force) {
  const token = ++aiStockToken;
  const content = document.getElementById('ai-stock-content');
  const loading = document.getElementById('aiStockLoading');
  if (!symbol) return;
  if (!state.aiConfig || !state.aiConfig.configured) {
    openAiConfigModal(true);
    return;
  }
  const horizonSel = document.getElementById('aiHorizon');
  const h = horizon || (horizonSel ? horizonSel.value : 'all') || 'all';
  const cacheKey = symbol + '|' + h;

  if (loading) {
    loading.style.display = 'block';
    loading.textContent = 'Hisse analizi hazırlanıyor… (haberler, formasyonlar ve göstergeler inceleniyor)';
  }
  if (content) content.innerHTML = '';

  if (!force && state.aiStockSummaries[cacheKey]) {
    setAiContent(content, state.aiStockSummaries[cacheKey]);
    if (loading) loading.style.display = 'none';
    return;
  }

  try {
    const data = await aiFetch(
      '/api/ai-analysis-stock?symbol=' +
        encodeURIComponent(symbol) +
        '&range=1y&horizon=' +
        encodeURIComponent(h) +
        (force ? '&fresh=1' : '')
    );
    if (token !== aiStockToken) return;
    state.aiStockSummaries[cacheKey] = data.summary || '';
    setAiContent(content, data.summary || 'AI analizi boş döndü.');
    const sub = document.getElementById('aiSub');
    if (sub && data.updatedAt) {
      sub.textContent =
        data.symbol +
        ' · ' +
        new Date(data.updatedAt).toLocaleString('tr-TR') +
        (data.model ? ' · ' + data.model : '');
    }
  } catch (e) {
    if (token !== aiStockToken) return;
    if (e.code === 'ai_key_missing') {
      openAiConfigModal(true);
      return;
    }
    if (content) {
      content.classList.remove('ai-markdown');
      content.textContent = 'AI hisse analizi yüklenemedi: ' + e.message;
    }
  } finally {
    if (token === aiStockToken && loading) loading.style.display = 'none';
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

async function init() {
  updateFavCount();

  // AI ayar durumunu kontrol et (once tarayicida kayitli anahtar, yoksa sunucu varsayilani)
  await loadAiConfig();

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
  document.getElementById('apiKeyBtn').addEventListener('click', () => {
    openAiConfigModal(!state.aiConfig.configured);
  });
  document.getElementById('aiConfigBtn').addEventListener('click', () => {
    openAiConfigModal(!state.aiConfig.configured);
  });

  // AI ayarlari modal
  document.getElementById('aiConfigClose').addEventListener('click', closeAiConfigModal);
  document.getElementById('aiConfigModal').addEventListener('click', (e) => {
    if (e.target.id === 'aiConfigModal') closeAiConfigModal();
  });

  // Sifre goster/gizle
  document.getElementById('aiConfigKeyToggle').addEventListener('click', function () {
    const inp = document.getElementById('aiConfigKey');
    if (inp.type === 'password') {
      inp.type = 'text';
      this.textContent = '🙈';
    } else {
      inp.type = 'password';
      this.textContent = '👁️';
    }
  });

  // Saglayici secimi: base URL ve model listesini guncelle
  document.getElementById('aiConfigProvider').addEventListener('change', function () {
    applyProviderToForm(this.value);
  });

  // Anahtar yapistirilinca saglayiciyi otomatik algila (EVREN / NVIDIA / Groq / OpenRouter)
  const aiKeyInput = document.getElementById('aiConfigKey');
  aiKeyInput.addEventListener('input', () => {
    const key = aiKeyInput.value.trim();
    if (!/^(evren_llm_|nvapi-|gsk_|sk-or-)/i.test(key)) return;
    const detected = detectProviderFromKey(key, null);
    const providerSel = document.getElementById('aiConfigProvider');
    if (detected && providerSel && providerSel.value !== detected) {
      providerSel.value = detected;
      applyProviderToForm(detected);
    }
  });

  // Model secimi: ozel model girisi
  document.getElementById('aiConfigModel').addEventListener('change', function () {
    const custom = document.getElementById('aiConfigModelCustom');
    if (!custom) return;
    if (this.value === '__custom__') {
      custom.style.display = 'block';
      custom.focus();
    } else {
      custom.style.display = 'none';
      custom.value = '';
    }
  });

  document.getElementById('aiConfigFetchModels').addEventListener('click', fetchAiModelsFromForm);
  document.getElementById('aiConfigTestBtn').addEventListener('click', testAiConfigFromForm);
  document.getElementById('aiConfigSaveBtn').addEventListener('click', saveAiConfigFromForm);
  document.getElementById('aiConfigClearBtn').addEventListener('click', clearAiConfigFromForm);

  // AI analizini yenile
  document.getElementById('aiRefreshBtn').addEventListener('click', () => {
    const activeTab = document.querySelector('.ai-tab.active');
    if (activeTab && activeTab.dataset.tab === 'ai-stock') {
      const sel = document.getElementById('aiStockSelect');
      const h = document.getElementById('aiHorizon');
      if (sel && sel.value) loadAIStock(sel.value, h ? h.value : 'all', true);
    } else {
      state.aiMarketSummary = null;
      loadAIOverview(true);
    }
  });

  // AI sekmeleri
  document.querySelectorAll('.ai-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      switchAITab(tab.dataset.tab);
      if (tab.dataset.tab === 'ai-stock') {
        const sel = document.getElementById('aiStockSelect');
        const h = document.getElementById('aiHorizon');
        if (sel && sel.value) loadAIStock(sel.value, h ? h.value : 'all');
      }
    });
  });

  // Hisse analiz butonu
  document.getElementById('aiAnalyzeStockBtn').addEventListener('click', () => {
    const sel = document.getElementById('aiStockSelect');
    const h = document.getElementById('aiHorizon');
    if (sel && sel.value) loadAIStock(sel.value, h ? h.value : 'all');
  });

  // Vade degisimi: secili hisse varsa yeni vadeyle analiz et
  document.getElementById('aiHorizon').addEventListener('change', () => {
    const sel = document.getElementById('aiStockSelect');
    const h = document.getElementById('aiHorizon');
    if (sel && sel.value) loadAIStock(sel.value, h ? h.value : 'all');
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

  // AI analizi yalnizca kullanici AI penceresini actiginda calisir (kota tasarrufu).

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
