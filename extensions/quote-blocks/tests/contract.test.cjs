'use strict';
// Static checks: API usage matches docs/openapi.yaml, size budget, liquid <-> JS hooks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot, defaultState, until, PDP_HTML, CART_HTML, CHIP_HTML } = require('./helpers.cjs');

const EXT = path.join(__dirname, '..');
const spec = fs.readFileSync(path.join(EXT, '..', '..', 'docs', 'openapi.yaml'), 'utf8').split('\n');

function specRoutes() {
  const routes = [];
  let cur = null;
  for (const line of spec) {
    let m = /^  (\/c\/[^:\s]+):\s*$/.exec(line);
    if (m) { cur = { path: m[1], methods: new Set() }; routes.push(cur); continue; }
    if (/^  \S/.test(line)) cur = null;
    m = /^    (get|post|put|patch|delete):\s*$/.exec(line);
    if (m && cur) cur.methods.add(m[1].toUpperCase());
  }
  return routes;
}
function matchesSpec(routes, method, p) {
  const rel = p.replace(/^\/apps\/quotes/, '');
  return routes.some((r) => r.methods.has(method) && new RegExp('^' + r.path.replace(/\{[^}]+\}/g, '[^/]+') + '$').test(rel));
}

test('spec parser sees the routes we use', () => {
  const r = specRoutes();
  assert.ok(r.find((x) => x.path === '/c/quotes/from-cart' && x.methods.has('POST')));
  assert.ok(r.find((x) => x.path === '/c/active-quote' && x.methods.has('PUT')));
});

test('every proxy call made by all three blocks exists in docs/openapi.yaml and stays under /apps/quotes', async () => {
  const routes = specRoutes();
  const calls = [];
  const state = defaultState();

  const pdp = await boot(PDP_HTML, ['dsg-add-to-quote.js'], state);
  pdp.d.querySelector('[data-dsg-trigger]').click();
  await until(() => pdp.d.querySelector('.dsg-opt'));
  [...pdp.d.querySelectorAll('.dsg-btn--primary')].find((b) => b.textContent === 'Add to quote').click();
  await until(() => /Added to your quote/.test(pdp.d.body.textContent));
  pdp.d.querySelector('[data-dsg-trigger]').click(); // close the success view
  pdp.d.querySelector('[data-dsg-trigger]').click(); // reopen: list reloads
  await until(() => pdp.d.querySelector('.dsg-opt'));
  pdp.d.querySelector('input[value=new]').click();
  pdp.d.querySelector('input[value=new]').dispatchEvent(new pdp.w.Event('change', { bubbles: true }));
  const job = pdp.d.querySelector('input[aria-label="Job name"]');
  job.value = 'X'; job.dispatchEvent(new pdp.w.Event('input'));
  [...pdp.d.querySelectorAll('.dsg-btn--primary')].find((b) => b.textContent === 'Add to quote').click();
  await until(() => state.calls.filter((c) => c.method === 'POST' && /lines$/.test(c.path)).length === 2);

  const cart = await boot(CART_HTML, ['dsg-move-cart.js'], state);
  await until(() => /26 items/.test(cart.d.body.textContent));
  cart.d.querySelector('input[value=existing]').click();
  await until(() => cart.d.querySelectorAll('select option').length === 3);
  cart.d.querySelector('.dsg-field--half input').value = 'PO1';
  [...cart.d.querySelectorAll('button')].find((b) => b.textContent === 'Save as draft').click();
  await until(() => cart.d.querySelector('.dsg-mc__done'));

  const chip = await boot(CHIP_HTML, ['dsg-quote-chip.js'], state);
  await until(() => !chip.d.querySelector('[data-dsg-chip]').hidden);

  for (const c of state.calls) {
    if (c.path === '/cart.js' || c.path === '/cart/clear.js') continue; // theme's own Ajax API
    calls.push(c.key);
    assert.ok(c.path.startsWith('/apps/quotes/c/'), 'proxy path: ' + c.key);
    assert.ok(matchesSpec(routes, c.method, c.path), 'not in openapi.yaml: ' + c.key);
  }
  const used = new Set(calls.map((k) => k.replace(/q\d+/, ':id')));
  for (const want of ['GET /apps/quotes/c/quotes', 'GET /apps/quotes/c/active-quote', 'PUT /apps/quotes/c/active-quote',
    'POST /apps/quotes/c/quotes', 'POST /apps/quotes/c/:id/lines'.replace('c/:id', 'c/quotes/:id'), 'POST /apps/quotes/c/quotes/from-cart', 'PATCH /apps/quotes/c/quotes/:id']) {
    assert.ok(used.has(want), 'exercised: ' + want);
  }
});

test('no frameworks or external hosts: assets only touch same-origin paths', () => {
  for (const f of fs.readdirSync(path.join(EXT, 'assets'))) {
    const src = fs.readFileSync(path.join(EXT, 'assets', f), 'utf8');
    assert.equal(/https?:\/\//.test(src), false, f + ' references an absolute URL');
    assert.equal(/\b(import|require)\s*\(|\bimport\s+.*from\b/.test(src), false, f + ' uses modules');
  }
});

test('size budget: each block ships under 30 KB (core + block JS + CSS)', () => {
  const size = (f) => fs.statSync(path.join(EXT, 'assets', f)).size;
  const shared = size('dsg-quotes-core.js') + size('dsg-quotes.css');
  for (const f of ['dsg-add-to-quote.js', 'dsg-move-cart.js', 'dsg-quote-chip.js']) {
    const total = shared + size(f);
    assert.ok(total < 30 * 1024, f + ' bundle is ' + total + ' bytes');
  }
});

test('liquid blocks expose the hooks the scripts need and valid schemas', () => {
  const read = (f) => fs.readFileSync(path.join(EXT, f), 'utf8');
  const schema = (f) => JSON.parse(/\{% schema %\}([\s\S]*?)\{% endschema %\}/.exec(read(f))[1]);

  const pdp = read('blocks/add-to-quote.liquid');
  for (const hook of ['data-dsg-add-to-quote', 'data-dsg-trigger', 'data-dsg-popover', 'aria-expanded="false"', 'aria-controls', 'Sign in to request a quote', '{% if customer %}', 'dsg-add-to-quote.js']) {
    assert.ok(pdp.includes(hook), 'add-to-quote.liquid missing ' + hook);
  }
  assert.deepEqual(schema('blocks/add-to-quote.liquid').templates, ['product']);
  assert.ok(schema('blocks/add-to-quote.liquid').settings.some((s) => s.id === 'button_label'));

  const cart = read('blocks/move-cart-to-quote.liquid');
  assert.ok(cart.includes('data-dsg-move-cart') && cart.includes('Sign in to request a quote') && cart.includes('dsg-move-cart.js'));
  assert.deepEqual(schema('blocks/move-cart-to-quote.liquid').templates, ['cart']);

  const chip = read('blocks/active-quote-chip.liquid');
  for (const hook of ['data-dsg-chip', 'data-dsg-chip-link', 'data-dsg-chip-text', 'dsg-quote-chip.js']) assert.ok(chip.includes(hook), hook);
  assert.equal(schema('blocks/active-quote-chip.liquid').target, 'body');

  for (const f of ['blocks/add-to-quote.liquid', 'blocks/move-cart-to-quote.liquid', 'blocks/active-quote-chip.liquid']) {
    assert.ok(!/\/apps\/(?!quotes)/.test(read(f)), f + ' calls a non-quotes proxy');
  }
  assert.ok(read('snippets/quote-card-button.liquid').includes('data-context="card"'));
  assert.match(read('shopify.extension.toml'), /type = "theme"/);
});
