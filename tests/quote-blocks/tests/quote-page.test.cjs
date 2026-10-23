'use strict';
// theme-overrides/assets/dsg-quotes-page.js: the /pages/quote list and ?id= detail view (jsdom, fake app proxy).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '../../../theme-overrides/assets/dsg-quotes-page.js'), 'utf8');

const quote = (over) => Object.assign({
  id: 'q1', number: 10482, displayNumber: 'Q-10482', title: 'Lakeview <b>Clinic</b>', status: 'QUOTE_READY', waitingOn: 'customer',
  currencyCode: 'USD', total: '1200.00', currentVersion: 2, lineCount: 1, poNumber: '4471',
  actions: { canAccept: true, canRequestChanges: true, canEditLines: false },
  lines: [{ id: 'l1', title: 'Amp <i>X</i>', sku: 'AMP-1', qty: 2, quotedPrice: '600.00', lineTotal: '1200.00' }],
  versions: [{ versionNo: 2, subtotal: '1200.00' }], messages: [],
}, over || {});

function boot({ search = '', routes }) {
  const dom = new JSDOM('<main><div data-mq></div></main>', { url: 'https://dsg.direct/pages/quote' + search, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  w.Element.prototype.scrollIntoView = () => {}; // not implemented in jsdom
  w.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    calls.push(method + ' ' + url);
    const handler = routes[method + ' ' + url];
    if (!handler) return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no route ' + method + ' ' + url }) };
    const out = typeof handler === 'function' ? handler(init) : handler;
    const status = out.__status || 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(out.__body !== undefined ? out.__body : out) };
  };
  w.eval(SRC);
  return { w, d: w.document, root: w.document.querySelector('[data-mq]'), calls };
}
const until = async (fn, label) => { for (let i = 0; i < 100; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); } throw new Error('timed out: ' + label); };

test('list view escapes quote titles and shows status', async () => {
  const p = boot({ routes: { 'GET /apps/quotes/c/quotes?limit=100': { items: [quote()] } } });
  await until(() => p.root.querySelector('.mq-link'), 'list row');
  assert.equal(p.root.querySelector('b'), null, 'title markup must not be rendered as HTML');
  assert.match(p.root.textContent, /Lakeview <b>Clinic<\/b>/);
  assert.match(p.root.querySelector('.mq-badge').textContent, /Ready for you/);
});

test('submit moves focus to the result message', async () => {
  const draft = quote({ status: 'DRAFT', actions: { canSubmit: true, canEditLines: false } });
  const sent = quote({ status: 'SUBMITTED', waitingOn: 'sales', actions: {} });
  const p = boot({ search: '?id=q1', routes: { 'GET /apps/quotes/c/quotes/q1': draft, 'POST /apps/quotes/c/quotes/q1/submit': sent } });
  const btn = await until(() => p.root.querySelector('[data-act="submit"]'), 'submit button');
  btn.click();
  const note = await until(() => p.root.querySelector('.mq-notice'), 'notice');
  assert.match(note.textContent, /Sent to DSG/);
  await until(() => p.d.activeElement === note, 'focus on notice');
});

test('buy without an invoice URL shows an error instead of navigating', async () => {
  const buyable = quote({ status: 'ACCEPTED', actions: { canBuy: true } });
  const p = boot({ search: '?id=q1', routes: { 'GET /apps/quotes/c/quotes/q1': buyable, 'POST /apps/quotes/c/quotes/q1/checkout': {} } });
  const btn = await until(() => p.root.querySelector('[data-act="buy"]'), 'buy button');
  btn.click();
  const err = await until(() => { const e = p.root.querySelector('[data-err]'); return e && !e.hidden && e.textContent ? e : null; }, 'error');
  assert.match(err.textContent, /could not start checkout/i);
  assert.equal(p.w.location.href, 'https://dsg.direct/pages/quote?id=q1');
  assert.equal(p.root.querySelector('[data-act="buy"]').disabled, false, 'button usable again');
});

test('failed quantity change redraws the saved quantity and shows the error', async () => {
  const editable = quote({ status: 'DRAFT', actions: { canEditLines: true, canSubmit: true } });
  const p = boot({ search: '?id=q1', routes: { 'GET /apps/quotes/c/quotes/q1': editable, 'PATCH /apps/quotes/c/quotes/q1/lines/l1': { __status: 422, __body: { message: 'Quantity too high' } } } });
  const input = await until(() => p.root.querySelector('[data-qty]'), 'qty input');
  input.value = '99';
  input.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await until(() => { const e = p.root.querySelector('[data-err]'); return e && !e.hidden && /Quantity too high/.test(e.textContent); }, 'error shown');
  assert.equal(p.root.querySelector('[data-qty]').value, '2', 'saved quantity is back');
});

test('a failed purchase on an expired quote offers "Ask for a new quote" only once', async () => {
  const buyable = quote({ status: 'ACCEPTED', actions: { canBuy: true } });
  const p = boot({ search: '?id=q1', routes: { 'GET /apps/quotes/c/quotes/q1': buyable, 'POST /apps/quotes/c/quotes/q1/checkout': { __status: 409, __body: { code: 'NOT_PURCHASABLE', message: 'This quote has expired.' } } } });
  const click = async () => { p.root.querySelector('[data-act="buy"]').click(); await until(() => /expired/.test(p.root.querySelector('[data-err]').textContent), 'error'); await until(() => !p.root.querySelector('[data-act="buy"]').disabled, 're-enabled'); };
  await until(() => p.root.querySelector('[data-act="buy"]'), 'buy button');
  await click(); await click();
  assert.equal(p.root.querySelectorAll('[data-act="duplicate"]').length, 1);
});
