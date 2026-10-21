'use strict';
// Test harness: jsdom + an in-memory stub of the app proxy (/apps/quotes/c/*) and the theme's cart endpoints.
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ASSETS = path.join(__dirname, '..', 'assets');
const read = (f) => fs.readFileSync(path.join(ASSETS, f), 'utf8');

function quote(over) {
  return Object.assign({
    id: 'q1', number: 10482, displayNumber: 'Q-10482', title: 'Exam rooms', status: 'DRAFT', waitingOn: 'none',
    job: { id: 'j1', name: 'Lakeview Clinic', poNumber: '4471' }, currentVersion: 0, lineCount: 6, total: '3912.00',
    updatedAt: '2026-10-01T00:00:00Z', ownerName: 'Dana', actions: {}, lines: [], versions: [], messages: []
  }, over || {});
}

function defaultState() {
  return {
    quotes: [
      quote(),
      quote({ id: 'q2', number: 10477, displayNumber: 'Q-10477', title: 'Auditorium', job: { id: 'j2', name: 'Harbor Middle School', poNumber: null }, lineCount: 14, total: '18240.50' }),
      quote({ id: 'q3', number: 10400, displayNumber: 'Q-10400', title: 'Old', status: 'SUBMITTED' })
    ],
    active: { quoteId: 'q1', number: 10482, title: 'Exam rooms', lineCount: 6 },
    cart: { item_count: 26, items: [{ variant_id: 111, quantity: 2 }, { variant_id: 222, quantity: 24 }] },
    calls: [],
    fail: [], // { match: /regex on "METHOD path"/, status, body, times }
    nextId: 100
  };
}

function res(status, body) {
  const text = body === undefined || body === null ? '' : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => body };
}

function makeServer(state) {
  async function handle(url, init) {
    init = init || {};
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url, 'https://dsg.test');
    const p = u.pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const key = method + ' ' + p;
    state.calls.push({ method, path: p, search: u.search, body, key });

    for (const f of state.fail) {
      if (f.times !== 0 && f.match.test(key)) {
        if (f.times) f.times -= 1;
        if (f.network) throw new TypeError('Failed to fetch');
        return res(f.status, f.body);
      }
    }

    if (key === 'GET /cart.js') return res(200, state.cart);
    if (key === 'POST /cart/clear.js') { state.cart = { item_count: 0, items: [] }; return res(200, state.cart); }

    if (!p.startsWith('/apps/quotes/c/')) return res(404, { code: 'NOT_FOUND', message: 'unexpected path ' + p });
    const r = p.slice('/apps/quotes'.length);
    let m;
    if (method === 'GET' && r === '/c/quotes') {
      const st = u.searchParams.get('status');
      return res(200, { items: state.quotes.filter((q) => !st || q.status === st), nextCursor: null });
    }
    if (method === 'GET' && r === '/c/active-quote') return res(200, state.active || { quoteId: null });
    if (method === 'PUT' && r === '/c/active-quote') {
      const q = state.quotes.find((x) => x.id === body.quoteId);
      state.active = q ? { quoteId: q.id, number: q.number, title: q.title, lineCount: q.lineCount } : { quoteId: null };
      return res(200, state.active);
    }
    if (method === 'POST' && r === '/c/quotes') {
      const n = state.nextId++;
      const q = quote({ id: 'q' + n, number: n, displayNumber: 'Q-' + n, title: body.title, job: { id: 'jn', name: body.newJob.name, poNumber: body.newJob.poNumber || null }, lineCount: 0, total: '0.00' });
      state.quotes.unshift(q);
      return res(201, q);
    }
    if (method === 'POST' && r === '/c/quotes/from-cart') {
      let q;
      if (body.target.mode === 'new') {
        const n = state.nextId++;
        q = quote({ id: 'q' + n, number: n, displayNumber: 'Q-' + n, title: body.target.title, status: body.submit ? 'SUBMITTED' : 'DRAFT', job: { id: 'jn', name: body.target.newJob.name, poNumber: null } });
        state.quotes.unshift(q);
      } else {
        q = state.quotes.find((x) => x.id === body.target.quoteId);
        if (!q) return res(404, { code: 'NOT_FOUND', message: 'Quote not found' });
        if (body.submit) q.status = 'SUBMITTED';
      }
      return res(201, q);
    }
    if ((m = /^\/c\/quotes\/([^/]+)\/lines$/.exec(r)) && method === 'POST') {
      const q = state.quotes.find((x) => x.id === m[1]);
      if (!q) return res(404, { code: 'NOT_FOUND', message: 'Quote not found' });
      q.lineCount += 1;
      return res(201, q);
    }
    if ((m = /^\/c\/quotes\/([^/]+)$/.exec(r)) && method === 'PATCH') {
      const q = state.quotes.find((x) => x.id === m[1]);
      if (!q) return res(404, { code: 'NOT_FOUND', message: 'Quote not found' });
      Object.assign(q, body);
      return res(200, q);
    }
    return res(404, { code: 'NOT_FOUND', message: 'no stub for ' + key });
  }
  return handle;
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
async function until(fn, label) {
  for (let i = 0; i < 100; i++) {
    const v = fn();
    if (v) return v;
    await tick(5);
  }
  throw new Error('timed out waiting for ' + (label || fn.toString()));
}

/** Boot a page. `scripts`: asset files to run after core. */
async function boot(html, scripts, state) {
  state = state || defaultState();
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', {
    url: 'https://dsg.test/products/pa-935a', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  const handler = makeServer(state);
  w.fetch = (url, init) => handler(url, init);
  w.eval(read('dsg-quotes-core.js'));
  scripts.forEach((s) => w.eval(read(s)));
  await tick(5);
  return { dom, w, d: w.document, state, calls: () => state.calls.map((c) => c.key) };
}

const ICON = '<svg aria-hidden="true"></svg>';

/** Same markup the add-to-quote.liquid renders for a logged-in customer. */
const PDP_HTML = `
<form action="/cart/add"><input name="id" value="111"><input name="quantity" value="2"></form>
<button id="before">before</button>
<div class="dsg-quote" data-dsg-add-to-quote data-context="pdp" data-logged-in="true" data-variant-id="111"
  data-product-title="PA-935A" data-currency="USD" data-login-url="/account/login?return_url=%2Fproducts%2Fpa-935a"
  data-my-quotes-url="/acct/quotes/{id}" data-base="/apps/quotes">
  <button type="button" class="dsg-btn" data-dsg-trigger aria-expanded="false" aria-haspopup="dialog" aria-controls="pop1">${ICON}<span>Add to Quote</span></button>
  <div class="dsg-pop" id="pop1" role="dialog" aria-label="Choose a quote" data-dsg-popover hidden></div>
</div>
<button id="after">after</button>`;

const CART_HTML = `<div class="dsg-mc" role="region" data-dsg-move-cart data-logged-in="true" data-currency="USD"
  data-my-quotes-url="/acct/quotes/{id}" data-base="/apps/quotes"></div>`;

const CHIP_HTML = `<div class="dsg-chip" data-dsg-chip data-base="/apps/quotes" data-my-quotes-url="/acct/quotes/{id}" hidden>
  <a href="/account" data-dsg-chip-link><span class="dsg-chip__lbl"><small>Adding to quote</small><strong data-dsg-chip-text></strong></span></a></div>`;

module.exports = { boot, defaultState, quote, tick, until, PDP_HTML, CART_HTML, CHIP_HTML, ASSETS, read };
