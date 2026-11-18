/* かんたん株ポートフォリオ — PayPay証券メイン
 * 依存ライブラリなし。データはブラウザの localStorage にだけ保存します。
 */
(() => {
  'use strict';

  // ---------- 定数 ----------
  const STORE_KEY = 'kabu-portfolio-v1';
  const QUOTE_KEY = 'kabu-quotes-v1';
  const TAX_RATE = 0.20315; // 所得税15.315% + 住民税5%
  const TAXABLE = new Set(['tokutei', 'ippan']);
  const BROKER_LABEL = { paypay: 'PayPay証券', sbi: 'SBI証券' };
  const ACCOUNT_LABEL = {
    tokutei: '特定', ippan: '一般',
    nisa_growth: 'NISA成長', nisa_tsumitate: 'NISAつみたて',
  };
  const FREQ_LABEL = { daily: '毎日', weekly: '毎週', monthly: '毎月' };
  const PER_MONTH = { daily: 245 / 12, weekly: 52 / 12, monthly: 1 }; // 営業日≒年245日

  // ---------- 状態 ----------
  const defaultSettings = { refreshSec: 30, finnhubKey: '', proxy: '', scope: 'paypay', sort: 'value', simRate: 5, simYears: 10 };
  let state = load(STORE_KEY, { holdings: [], settings: { ...defaultSettings } });
  state.settings = { ...defaultSettings, ...(state.settings || {}) };
  if (!Array.isArray(state.holdings)) state.holdings = [];
  let quotes = load(QUOTE_KEY, {}); // { SYMBOL: {price, prev, currency, name, time, fetchedAt} }
  let lastPrices = {};
  let refreshTimer = null;
  let refreshing = false;
  let lastOkSource = null;

  // ---------- ユーティリティ ----------
  function load(key, fallback) {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; }
    catch { return fallback; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
  }
  function saveQuotes() {
    try { localStorage.setItem(QUOTE_KEY, JSON.stringify(quotes)); } catch {}
  }
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

  const yen = (v, { sign = false } = {}) => {
    if (v == null || !Number.isFinite(v)) return '—';
    const s = Math.round(Math.abs(v)).toLocaleString('ja-JP');
    const p = sign ? (v > 0.5 ? '+' : v < -0.5 ? '−' : '±') : (v < -0.5 ? '−' : '');
    return `${p}${s}円`;
  };
  const pct = (v) => {
    if (v == null || !Number.isFinite(v)) return '';
    const p = v > 0.00005 ? '+' : v < -0.00005 ? '−' : '±';
    return `${p}${Math.abs(v * 100).toFixed(2)}%`;
  };
  const cls = (v) => (v > 0.5 ? 'up' : v < -0.5 ? 'down' : '');
  const fmtPrice = (p, cur) => {
    if (!Number.isFinite(p)) return '—';
    if (cur === 'JPY') return p.toLocaleString('ja-JP', { maximumFractionDigits: 1 }) + '円';
    if (cur === 'USD') return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return p.toLocaleString() + ' ' + (cur || '');
  };
  const fmtQty = (q) => q.toLocaleString('ja-JP', { maximumFractionDigits: 6 });

  /** 4桁の証券コード(7203)や新コード(130A)は東証の .T を付ける */
  function normalizeSymbol(raw) {
    let s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    if (/^\d{3}[0-9A-Z]$/.test(s)) s += '.T';
    return s;
  }

  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), ms);
  }

  // ---------- 株価取得 ----------
  const yahooUrl = (sym, host = 'query1') =>
    `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d&includePrePost=false`;

  async function fetchJson(url, timeoutMs = 8000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      return JSON.parse(text);
    } finally { clearTimeout(t); }
  }

  function parseYahoo(j) {
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res || !res.meta) throw new Error((j && j.chart && j.chart.error && j.chart.error.description) || 'no data');
    const m = res.meta;
    // 終値系列の最後の値（regularMarketPriceが無い場合の保険）
    let last = m.regularMarketPrice;
    if (!Number.isFinite(last)) {
      const closes = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
      for (let i = closes.length - 1; i >= 0; i--) if (Number.isFinite(closes[i])) { last = closes[i]; break; }
    }
    const prev = Number.isFinite(m.previousClose) ? m.previousClose : m.chartPreviousClose;
    if (!Number.isFinite(last)) throw new Error('no price');
    return {
      price: last, prev: Number.isFinite(prev) ? prev : last,
      currency: m.currency || 'USD',
      name: m.longName || m.shortName || '',
      time: (m.regularMarketTime || 0) * 1000,
    };
  }

  /** 取得方法を順番に試す。成功した方法を覚えて次回から優先する */
  function sources(sym) {
    const s = state.settings;
    const list = [];
    if (s.proxy) list.push({ id: 'custom', url: s.proxy + encodeURIComponent(yahooUrl(sym)), parse: parseYahoo });
    if (s.finnhubKey && !/\.T$|=X$/.test(sym)) {
      list.push({
        id: 'finnhub',
        url: `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(s.finnhubKey)}`,
        parse: (j) => {
          if (!j || !Number.isFinite(j.c) || j.c === 0) throw new Error('no data');
          return { price: j.c, prev: j.pc || j.c, currency: 'USD', name: '', time: (j.t || 0) * 1000 };
        },
      });
    }
    list.push({ id: 'yahoo1', url: yahooUrl(sym, 'query1'), parse: parseYahoo });
    list.push({ id: 'yahoo2', url: yahooUrl(sym, 'query2'), parse: parseYahoo });
    list.push({ id: 'corsproxy', url: 'https://corsproxy.io/?url=' + encodeURIComponent(yahooUrl(sym)), parse: parseYahoo });
    list.push({ id: 'allorigins', url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(yahooUrl(sym)), parse: parseYahoo });
    list.push({ id: 'codetabs', url: 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(yahooUrl(sym)), parse: parseYahoo });
    if (lastOkSource) list.sort((a, b) => (b.id === lastOkSource) - (a.id === lastOkSource));
    return list;
  }

  async function fetchQuote(sym) {
    let lastErr;
    for (const src of sources(sym)) {
      try {
        const q = src.parse(await fetchJson(src.url));
        if (src.id !== 'finnhub') lastOkSource = src.id;
        return q;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('取得できませんでした');
  }

  /** 為替（外貨→円）。Yahooがダメなら日次レートのAPIで代用 */
  async function fetchFx(cur) {
    try {
      const q = await fetchQuote(`${cur}JPY=X`);
      return { ...q, currency: 'JPY' };
    } catch {
      const j = await fetchJson('https://open.er-api.com/v6/latest/' + encodeURIComponent(cur));
      const r = j && j.rates && j.rates.JPY;
      if (!Number.isFinite(r)) throw new Error('fx');
      return { price: r, prev: r, currency: 'JPY', name: `${cur}/JPY`, time: (j.time_last_update_unix || 0) * 1000 };
    }
  }

  async function pool(items, limit, fn) {
    const out = []; let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch((e) => e); }
    });
    await Promise.all(workers);
    return out;
  }

  async function refresh({ manual = false } = {}) {
    if (refreshing) return;
    const syms = [...new Set(state.holdings.filter((h) => h.type === 'stock' && h.symbol).map((h) => h.symbol))];
    if (!syms.length) { render(); return; }
    refreshing = true;
    $('#btn-refresh').classList.add('spinning');
    let failed = 0;
    try {
      await pool(syms, 4, async (sym) => {
        try {
          const q = await fetchQuote(sym);
          quotes[sym] = { ...q, fetchedAt: Date.now(), error: null };
        } catch (e) {
          failed++;
          quotes[sym] = { ...(quotes[sym] || {}), error: String(e.message || e) };
        }
      });
      const curs = [...new Set(syms.map((s) => quotes[s] && quotes[s].currency).filter((c) => c && c !== 'JPY'))];
      await pool(curs, 2, async (cur) => {
        try { quotes['FX:' + cur] = { ...(await fetchFx(cur)), fetchedAt: Date.now() }; }
        catch { failed++; }
      });
      saveQuotes();
      const dot = $('#live-dot');
      dot.className = 'dot ' + (failed === 0 ? 'live' : failed < syms.length ? 'live' : 'err');
      if (failed && manual) toast(`${failed}件の価格を取得できませんでした（前回の値を表示中）`);
      else if (manual) toast('最新の価格に更新しました');
    } finally {
      refreshing = false;
      $('#btn-refresh').classList.remove('spinning');
      render();
    }
  }

  function scheduleRefresh() {
    clearInterval(refreshTimer);
    const sec = num(state.settings.refreshSec);
    if (sec > 0) refreshTimer = setInterval(() => { if (!document.hidden) refresh(); }, sec * 1000);
  }

  // ---------- 計算 ----------
  function fxFor(cur) {
    if (!cur || cur === 'JPY') return { now: 1, prev: 1 };
    const f = quotes['FX:' + cur];
    if (!f || !Number.isFinite(f.price)) return null;
    return { now: f.price, prev: Number.isFinite(f.prev) ? f.prev : f.price };
  }

  function evaluate(h) {
    const cost = num(h.cost), qty = num(h.qty);
    const r = { h, cost, qty, value: null, prevValue: null, gain: null, gainPct: null, day: null, dayPct: null, q: null };
    if (h.type === 'fund') {
      if (num(h.nav) > 0) { r.value = qty * num(h.nav) / 10000; r.prevValue = r.value; }
    } else {
      const q = quotes[h.symbol];
      r.q = q || null;
      const fx = q && fxFor(q.currency);
      if (q && Number.isFinite(q.price) && fx) {
        r.value = qty * q.price * fx.now;
        r.prevValue = qty * q.prev * fx.prev;
      }
    }
    if (r.value != null) {
      r.gain = r.value - cost;
      r.gainPct = cost > 0 ? r.gain / cost : null;
      r.day = r.value - r.prevValue;
      r.dayPct = r.prevValue > 0 ? r.day / r.prevValue : null;
    }
    return r;
  }

  const inScope = (h) => state.settings.scope === 'all' || h.broker === state.settings.scope;

  function taxSummary(rows) {
    // 課税口座は「証券会社×口座種別」ごとに損益通算、NISAは非課税
    const groups = {};
    let nisaSaved = 0;
    for (const r of rows) {
      if (r.gain == null) continue;
      if (TAXABLE.has(r.h.account)) {
        const k = r.h.broker + ':' + r.h.account;
        groups[k] = (groups[k] || 0) + r.gain;
      } else if (r.gain > 0) {
        nisaSaved += r.gain * TAX_RATE;
      }
    }
    const base = Object.values(groups).reduce((a, g) => a + Math.max(0, g), 0);
    const tax = base * TAX_RATE;
    const totalGain = rows.reduce((a, r) => a + (r.gain || 0), 0);
    return { base, tax, net: totalGain - tax, nisaSaved };
  }

  function monthlyOf(h) {
    const t = h.tsumitate;
    return t && t.freq && num(t.amount) > 0 ? num(t.amount) * PER_MONTH[t.freq] : 0;
  }

  // ---------- 描画 ----------
  function render() {
    const all = state.holdings.map(evaluate);
    const rows = all.filter((r) => inScope(r.h));
    const scope = state.settings.scope;

    $('#scope-label').textContent = scope === 'all' ? '全口座' : BROKER_LABEL[scope];
    $$('.scope-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.scope === scope));

    // サマリー
    const valued = rows.filter((r) => r.value != null);
    const value = valued.reduce((a, r) => a + r.value, 0);
    const costAll = rows.reduce((a, r) => a + r.cost, 0);
    const costValued = valued.reduce((a, r) => a + r.cost, 0);
    const gain = value - costValued;
    const day = valued.reduce((a, r) => a + r.day, 0);
    const prev = valued.reduce((a, r) => a + r.prevValue, 0);
    $('#total-value').textContent = rows.length ? yen(value) : '0円';
    setDelta('#total-gain', gain, costValued > 0 ? gain / costValued : null, valued.length);
    setDelta('#total-day', day, prev > 0 ? day / prev : null, valued.length);
    $('#total-cost').textContent = yen(costAll);

    // 税
    const tx = taxSummary(rows);
    $('#tax-base').textContent = yen(tx.base);
    $('#tax-amount').textContent = yen(tx.tax);
    const net = $('#tax-net'); net.textContent = yen(tx.net, { sign: true }); net.className = 'v strong ' + cls(tx.net);
    $('#tax-saved').textContent = yen(tx.nisaSaved);

    renderHoldings(rows);
    renderAlloc(all, rows);
    renderTsumitate(rows, value);
    renderMarkets();

    const times = rows.map((r) => r.q && r.q.fetchedAt).filter(Boolean);
    $('#updated-at').textContent = times.length
      ? '更新 ' + new Date(Math.max(...times)).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : (rows.some((r) => r.h.type === 'stock') ? '価格を取得中…' : '—');
  }

  function setDelta(sel, v, p, ok) {
    const el = $(sel);
    if (!ok) { el.textContent = '—'; el.className = 'v'; return; }
    el.innerHTML = `${yen(v, { sign: true })}<br><span class="num">${pct(p)}</span>`;
    el.className = 'v ' + cls(v);
  }

  function renderHoldings(rows) {
    const box = $('#holdings');
    $('#empty').hidden = state.holdings.length > 0;
    const sort = state.settings.sort;
    const key = {
      value: (r) => -(r.value ?? r.cost),
      gainPct: (r) => -(r.gainPct ?? -Infinity),
      day: (r) => -(r.dayPct ?? -Infinity),
      name: (r) => displayName(r.h, r.q),
    }[sort] || ((r) => 0);
    const sorted = [...rows].sort((a, b) => {
      const ka = key(a), kb = key(b);
      return typeof ka === 'string' ? ka.localeCompare(kb, 'ja') : ka - kb;
    });
    if (state.holdings.length && !rows.length) {
      box.innerHTML = `<p class="empty">この口座の銘柄はありません。</p>`;
      return;
    }
    box.innerHTML = sorted.map((r) => {
      const h = r.h, q = r.q;
      const tags = [
        `<span class="tag ${h.broker}">${BROKER_LABEL[h.broker] || h.broker}</span>`,
        `<span class="tag ${h.account.startsWith('nisa') ? 'nisa' : ''}">${ACCOUNT_LABEL[h.account] || h.account}</span>`,
        h.tsumitate && h.tsumitate.freq ? `<span class="tag">積立 ${FREQ_LABEL[h.tsumitate.freq]}${yen(num(h.tsumitate.amount))}</span>` : '',
      ].join('');
      let priceHtml;
      if (h.type === 'fund') {
        priceHtml = `<div class="p">${num(h.nav) ? num(h.nav).toLocaleString('ja-JP') + '円' : '—'}</div><div class="c" style="color:var(--text-3)">基準価額(手入力)</div>`;
      } else if (q && Number.isFinite(q.price)) {
        const d = q.price - q.prev, dp = q.prev ? d / q.prev : 0;
        priceHtml = `<div class="p">${fmtPrice(q.price, q.currency)}</div><div class="c ${cls(d * 1000)}">${d >= 0 ? '+' : '−'}${fmtPrice(Math.abs(d), q.currency)} (${pct(dp)})</div>`;
      } else {
        priceHtml = `<div class="p">—</div><div class="c" style="color:var(--text-3)">取得中…</div>`;
      }
      const err = q && q.error && h.type === 'stock'
        ? `<div class="h-err">価格の取得に失敗${Number.isFinite(q.price) ? '（前回の値を表示中）' : ''}</div>` : '';
      return `
        <article class="h-item" data-id="${h.id}">
          <div class="h-top">
            <div style="min-width:0">
              <div class="h-name">${esc(displayName(h, q))}</div>
              <div class="h-meta">${h.type === 'stock' ? `<span>${esc(h.symbol)}</span>` : ''}${tags}</div>
            </div>
            <div class="h-price">${priceHtml}</div>
          </div>
          <div class="h-grid">
            <div><div class="k">評価額</div><div class="v">${yen(r.value)}</div></div>
            <div><div class="k">損益</div><div class="v ${cls(r.gain)}">${r.gain == null ? '—' : yen(r.gain, { sign: true }) + '<br>' + pct(r.gainPct)}</div></div>
            <div><div class="k">今日</div><div class="v ${cls(r.day)}">${r.day == null ? '—' : yen(r.day, { sign: true })}</div></div>
            <div><div class="k">${h.type === 'fund' ? '口数' : '数量'} / 投資額</div><div class="v" style="font-weight:500">${fmtQty(r.qty)}<br>${yen(r.cost)}</div></div>
          </div>
          ${err}
          <div class="h-actions">
            <button class="btn small" data-act="buy">＋ 買付を記録</button>
            <button class="btn small" data-act="edit">編集</button>
          </div>
        </article>`;
    }).join('');

    // 値が動いたらフラッシュ
    for (const r of rows) {
      if (!r.q || !Number.isFinite(r.q.price)) continue;
      const before = lastPrices[r.h.symbol];
      if (before != null && before !== r.q.price) {
        const el = box.querySelector(`[data-id="${r.h.id}"]`);
        if (el) el.classList.add(r.q.price > before ? 'flash-up' : 'flash-down');
      }
    }
    for (const r of rows) if (r.q && Number.isFinite(r.q.price)) lastPrices[r.h.symbol] = r.q.price;
  }

  function displayName(h, q) {
    return h.name || (q && q.name) || h.symbol || '（名称未設定）';
  }

  function renderAlloc(all, rows) {
    // 証券会社の比率（常に全口座で）
    const byBroker = { paypay: 0, sbi: 0 };
    for (const r of all) byBroker[r.h.broker] = (byBroker[r.h.broker] || 0) + (r.value ?? r.cost);
    const tot = byBroker.paypay + byBroker.sbi;
    const split = $('#broker-split');
    if (tot > 0) {
      const seg = (k) => byBroker[k] > 0
        ? `<span style="width:${(byBroker[k] / tot) * 100}%;background:var(--${k})" title="${BROKER_LABEL[k]} ${yen(byBroker[k])}（${((byBroker[k] / tot) * 100).toFixed(1)}%）"></span>` : '';
      split.innerHTML = `
        <div class="k">証券会社の割合（全口座）</div>
        <div class="split-bar" role="img" aria-label="PayPay証券 ${((byBroker.paypay / tot) * 100).toFixed(0)}%, SBI証券 ${((byBroker.sbi / tot) * 100).toFixed(0)}%">${seg('paypay')}${seg('sbi')}</div>
        <div class="legend">
          <span><i style="background:var(--paypay)"></i>PayPay証券 ${((byBroker.paypay / tot) * 100).toFixed(1)}%（${yen(byBroker.paypay)}）</span>
          <span><i style="background:var(--sbi)"></i>SBI証券 ${((byBroker.sbi / tot) * 100).toFixed(1)}%（${yen(byBroker.sbi)}）</span>
        </div>`;
    } else split.innerHTML = '';

    // 銘柄ごとの比率（表示中の口座）
    const items = rows.map((r) => ({ name: displayName(r.h, r.q), v: r.value ?? r.cost }))
      .filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
    const sum = items.reduce((a, x) => a + x.v, 0);
    const top = items.slice(0, 8);
    if (items.length > 8) top.push({ name: 'その他', v: items.slice(8).reduce((a, x) => a + x.v, 0) });
    const max = Math.max(...top.map((x) => x.v), 1);
    $('#alloc-bars').innerHTML = top.length
      ? `<div class="k">銘柄ごとの割合（${esc($('#scope-label').textContent)}）</div>` + top.map((x) => `
        <div class="alloc-row" title="${esc(x.name)}：${yen(x.v)}（${((x.v / sum) * 100).toFixed(1)}%）">
          <span class="lbl">${esc(x.name)}</span>
          <span class="track"><span class="fill" style="display:block;width:${(x.v / max) * 100}%"></span></span>
          <span class="pct">${((x.v / sum) * 100).toFixed(1)}%</span>
        </div>`).join('')
      : '';
    $('#alloc-card').hidden = !tot;
  }

  function renderTsumitate(rows, currentValue) {
    const list = rows.filter((r) => monthlyOf(r.h) > 0);
    const monthly = list.reduce((a, r) => a + monthlyOf(r.h), 0);
    $('#monthly-total').textContent = yen(monthly);
    $('#yearly-total').textContent = yen(monthly * 12);
    $('#tsumitate-list').innerHTML = list.length
      ? list.map((r) => `<li><span>${esc(displayName(r.h, r.q))}<br><span class="muted">${FREQ_LABEL[r.h.tsumitate.freq]} ${yen(num(r.h.tsumitate.amount))}</span></span><span class="num">月 ${yen(monthlyOf(r.h))}</span></li>`).join('')
      : `<li class="muted">積立設定のある銘柄はまだありません（銘柄の「編集」から設定できます）</li>`;

    const rate = num(state.settings.simRate) / 100;
    const years = Math.max(1, Math.round(num(state.settings.simYears)));
    const n = years * 12;
    const i = Math.pow(1 + rate, 1 / 12) - 1;
    const base = currentValue || 0;
    const fvBase = base * Math.pow(1 + rate, years);
    const fvMonthly = i === 0 ? monthly * n : monthly * ((Math.pow(1 + i, n) - 1) / i) * (1 + i);
    const costNow = rows.reduce((a, r) => a + r.cost, 0);
    $('#sim-principal').textContent = yen(costNow + monthly * n);
    $('#sim-future').textContent = yen(fvBase + fvMonthly);
  }

  function marketStatus(tz, sessions) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    const wd = get('weekday');
    const mins = (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10);
    if (wd === 'Sat' || wd === 'Sun') return null;
    return sessions.find(([s, e]) => mins >= s && mins < e) || null;
  }

  function renderMarkets() {
    const holdsUS = state.holdings.some((h) => h.type === 'stock' && !/\.T$/.test(h.symbol));
    const holdsJP = state.holdings.some((h) => h.type === 'stock' && /\.T$/.test(h.symbol));
    const out = [];
    if (holdsJP || !holdsUS) {
      const s = marketStatus('Asia/Tokyo', [[540, 690, '取引中'], [690, 750, '昼休み'], [750, 930, '取引中']]);
      out.push(`<span class="badge ${s && s[2] === '取引中' ? 'open' : 'closed'}">日本株 ${s ? s[2] : '取引時間外'}</span>`);
    }
    if (holdsUS || !holdsJP) {
      const s = marketStatus('America/New_York', [[240, 570, 'プレ'], [570, 960, '取引中'], [960, 1200, 'アフター']]);
      out.push(`<span class="badge ${s && s[2] === '取引中' ? 'open' : 'closed'}">米国株 ${s ? s[2] : '取引時間外'}</span>`);
    }
    $('#market-badges').innerHTML = out.join('');
  }

  // ---------- 銘柄ダイアログ ----------
  const dlgH = $('#dlg-holding');
  const formH = $('#form-holding');
  let editingId = null;

  function syncTypeVisibility() {
    const isFund = formH.type.value === 'fund';
    formH.classList.toggle('is-fund', isFund);
    formH.classList.toggle('is-stock', !isFund);
    formH.symbol.required = !isFund;
    formH.nav.required = isFund;
  }

  function openHolding(h) {
    editingId = h ? h.id : null;
    $('#dlg-holding-title').textContent = h ? '銘柄を編集' : '銘柄を追加';
    formH.reset();
    const v = h || { broker: state.settings.scope === 'sbi' ? 'sbi' : 'paypay', account: 'tokutei', type: 'stock' };
    formH.broker.value = v.broker;
    formH.account.value = v.account;
    formH.type.value = v.type;
    formH.symbol.value = (v.symbol || '').replace(/\.T$/, '');
    formH.name.value = v.name || '';
    formH.qty.value = v.qty ?? '';
    formH.cost.value = v.cost ?? '';
    formH.nav.value = v.nav ?? '';
    formH.freq.value = (v.tsumitate && v.tsumitate.freq) || '';
    formH.amount.value = (v.tsumitate && v.tsumitate.amount) || '';
    $('#btn-delete').hidden = !h;
    syncTypeVisibility();
    dlgH.showModal();
  }

  formH.type.addEventListener('change', syncTypeVisibility);
  formH.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = formH;
    const type = f.type.value;
    const h = {
      id: editingId || uid(),
      broker: f.broker.value,
      account: f.account.value,
      type,
      symbol: type === 'stock' ? normalizeSymbol(f.symbol.value) : '',
      name: f.name.value.trim(),
      qty: num(f.qty.value),
      cost: num(f.cost.value),
      nav: type === 'fund' ? num(f.nav.value) : 0,
      tsumitate: f.freq.value ? { freq: f.freq.value, amount: num(f.amount.value) } : null,
    };
    if (type === 'stock' && !h.symbol) { toast('ティッカー/証券コードを入れてください'); return; }
    const idx = state.holdings.findIndex((x) => x.id === h.id);
    if (idx >= 0) state.holdings[idx] = { ...state.holdings[idx], ...h };
    else state.holdings.push(h);
    save();
    dlgH.close();
    render();
    if (type === 'stock' && !quotes[h.symbol]) refresh();
  });
  $('#btn-delete').addEventListener('click', () => {
    if (!editingId) return;
    const h = state.holdings.find((x) => x.id === editingId);
    if (!confirm(`「${displayName(h, quotes[h.symbol])}」を削除しますか？`)) return;
    state.holdings = state.holdings.filter((x) => x.id !== editingId);
    save(); dlgH.close(); render();
  });

  // ---------- 買付ダイアログ ----------
  const dlgB = $('#dlg-buy');
  const formB = $('#form-buy');
  let buyingId = null;
  function openBuy(h) {
    buyingId = h.id;
    formB.reset();
    $('#buy-target').textContent = `${displayName(h, quotes[h.symbol])}（${BROKER_LABEL[h.broker]}）`;
    if (h.tsumitate && h.tsumitate.amount) formB.amount.value = h.tsumitate.amount;
    const q = quotes[h.symbol], fx = q && fxFor(q.currency);
    if (q && fx && h.tsumitate && h.tsumitate.amount) {
      formB.qty.placeholder = `目安: ${(h.tsumitate.amount / (q.price * fx.now)).toFixed(6)}`;
    }
    dlgB.showModal();
  }
  formB.addEventListener('submit', (e) => {
    e.preventDefault();
    const h = state.holdings.find((x) => x.id === buyingId);
    if (!h) return;
    h.qty = num(h.qty) + num(formB.qty.value);
    h.cost = num(h.cost) + num(formB.amount.value);
    save(); dlgB.close(); render();
    toast('買付を反映しました');
  });

  // ---------- 設定ダイアログ ----------
  const dlgS = $('#dlg-settings');
  const formS = $('#form-settings');
  $('#btn-settings').addEventListener('click', () => {
    formS.refreshSec.value = String(state.settings.refreshSec);
    formS.finnhubKey.value = state.settings.finnhubKey || '';
    formS.proxy.value = state.settings.proxy || '';
    dlgS.showModal();
  });
  formS.addEventListener('submit', (e) => {
    e.preventDefault();
    state.settings.refreshSec = num(formS.refreshSec.value);
    state.settings.finnhubKey = formS.finnhubKey.value.trim();
    state.settings.proxy = formS.proxy.value.trim();
    lastOkSource = null;
    save(); scheduleRefresh(); dlgS.close();
    refresh({ manual: true });
  });
  $('#btn-export').addEventListener('click', () => {
    const data = { app: 'kabu-portfolio', version: 1, exportedAt: new Date().toISOString(), holdings: state.holdings };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `portfolio-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data.holdings;
      if (!Array.isArray(list)) throw new Error();
      const clean = list.filter((h) => h && typeof h === 'object').map((h) => ({
        id: String(h.id || uid()),
        broker: h.broker === 'sbi' ? 'sbi' : 'paypay',
        account: ACCOUNT_LABEL[h.account] ? h.account : 'tokutei',
        type: h.type === 'fund' ? 'fund' : 'stock',
        symbol: h.type === 'fund' ? '' : normalizeSymbol(h.symbol),
        name: String(h.name || '').slice(0, 80),
        qty: num(h.qty), cost: num(h.cost), nav: num(h.nav),
        tsumitate: h.tsumitate && FREQ_LABEL[h.tsumitate.freq] ? { freq: h.tsumitate.freq, amount: num(h.tsumitate.amount) } : null,
      }));
      if (!confirm(`${clean.length}件の銘柄を読み込みます。今のデータは置き換わります。よろしいですか？`)) return;
      state.holdings = clean; save(); dlgS.close(); render(); refresh();
      toast('読み込みました');
    } catch { toast('ファイルを読み込めませんでした'); }
  });
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('すべての銘柄データを削除します。元に戻せません。よろしいですか？')) return;
    state.holdings = []; quotes = {}; save(); saveQuotes(); dlgS.close(); render();
  });

  // ---------- その他イベント ----------
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#btn-add').addEventListener('click', () => openHolding(null));
  $('#btn-refresh').addEventListener('click', () => refresh({ manual: true }));
  $('#holdings').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const h = state.holdings.find((x) => x.id === btn.closest('[data-id]').dataset.id);
    if (!h) return;
    if (btn.dataset.act === 'edit') openHolding(h);
    if (btn.dataset.act === 'buy') openBuy(h);
  });
  $$('.scope-tabs button').forEach((b) => b.addEventListener('click', () => {
    state.settings.scope = b.dataset.scope; save(); render();
  }));
  $('#sort-by').value = state.settings.sort;
  $('#sort-by').addEventListener('change', (e) => { state.settings.sort = e.target.value; save(); render(); });
  $('#sim-rate').value = state.settings.simRate;
  $('#sim-years').value = state.settings.simYears;
  ['#sim-rate', '#sim-years'].forEach((s) => $(s).addEventListener('input', () => {
    state.settings.simRate = num($('#sim-rate').value);
    state.settings.simYears = num($('#sim-years').value) || 1;
    save(); render();
  }));
  $('#btn-sample').addEventListener('click', () => {
    state.holdings = [
      { id: uid(), broker: 'paypay', account: 'nisa_growth', type: 'stock', symbol: 'VOO', name: 'S&P500 ETF (VOO)', qty: 0.85, cost: 70000, nav: 0, tsumitate: { freq: 'daily', amount: 1000 } },
      { id: uid(), broker: 'paypay', account: 'nisa_growth', type: 'stock', symbol: 'AAPL', name: 'アップル', qty: 1.2, cost: 40000, nav: 0, tsumitate: { freq: 'weekly', amount: 3000 } },
      { id: uid(), broker: 'paypay', account: 'tokutei', type: 'stock', symbol: 'NVDA', name: 'エヌビディア', qty: 2.5, cost: 50000, nav: 0, tsumitate: { freq: 'monthly', amount: 10000 } },
      { id: uid(), broker: 'paypay', account: 'tokutei', type: 'stock', symbol: '7203.T', name: 'トヨタ自動車', qty: 10, cost: 28000, nav: 0, tsumitate: null },
      { id: uid(), broker: 'sbi', account: 'nisa_tsumitate', type: 'fund', symbol: '', name: 'eMAXIS Slim 全世界株式', qty: 120000, cost: 300000, nav: 30000, tsumitate: null },
    ];
    save(); render(); refresh();
    toast('サンプルを入れました。編集・削除して自分の内容にしてください');
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(renderMarkets, 60 * 1000);

  // ---------- 起動 ----------
  render();
  refresh();
  scheduleRefresh();
})();
