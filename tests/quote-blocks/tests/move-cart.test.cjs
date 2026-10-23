'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, defaultState, until, tick, CART_HTML, CHIP_HTML } = require('./helpers.cjs');

const SCRIPTS = ['dsg-move-cart.js'];
const btn = (page, text) => [...page.d.querySelectorAll('button')].find((b) => b.textContent === text);
const fill = (page, el, v) => { el.value = v; el.dispatchEvent(new page.w.Event('input', { bubbles: true })); };
const input = (page, label) => {
  const l = [...page.d.querySelectorAll('.dsg-field > label')].find((x) => x.textContent.replace(/\s*\*?\s*\((optional|required)\)\s*$/, '').replace(/\s*\*$/, '').trim() === label);
  return l.parentElement.querySelector('input,textarea,select');
};

test('renders the form from the mockup and summarizes the cart', async () => {
  const page = await boot(CART_HTML, SCRIPTS);
  await until(() => /26 items/.test(page.d.body.textContent));
  assert.match(page.d.body.textContent, /Need better pricing\? Move cart to a quote/);
  for (const l of ['Job or quote name', 'PO number', 'Needed by', 'Note to sales']) assert.ok(input(page, l), l);
  assert.equal(page.d.querySelector('.dsg-check input').checked, true, 'empty cart checked by default');
  assert.ok(btn(page, 'Save as draft') && btn(page, 'Send to sales'));
  assert.equal(page.d.querySelector('input[value=new]').checked, true);
});

test('move cart to a NEW quote as draft, then empty the cart only after the 2xx', async () => {
  const page = await boot(CART_HTML, SCRIPTS);
  await until(() => /26 items/.test(page.d.body.textContent));
  fill(page, input(page, 'Job or quote name'), 'Ridgeway Church — PA upgrade');
  fill(page, input(page, 'PO number'), '5512');
  fill(page, input(page, 'Needed by'), '2026-11-14');
  fill(page, input(page, 'Note to sales'), 'Competing bid');
  btn(page, 'Save as draft').click();
  await until(() => page.d.querySelector('.dsg-mc__done'));

  const order = page.calls();
  const fc = page.state.calls.find((c) => c.key === 'POST /apps/quotes/c/quotes/from-cart');
  assert.deepEqual(fc.body, {
    cartLines: [{ variantId: 'gid://shopify/ProductVariant/111', qty: 2 }, { variantId: 'gid://shopify/ProductVariant/222', qty: 24 }],
    target: { mode: 'new', title: 'Ridgeway Church — PA upgrade', newJob: { name: 'Ridgeway Church — PA upgrade', poNumber: '5512' }, poNumber: '5512', neededBy: '2026-11-14', notesToSales: 'Competing bid' },
    submit: false,
    emptyCart: true
  });
  assert.ok(order.indexOf('POST /cart/clear.js') > order.indexOf('POST /apps/quotes/c/quotes/from-cart'), 'cart cleared after the quote call');
  assert.deepEqual(page.state.cart.items, []);
  assert.match(page.d.body.textContent, /Draft saved/);
  assert.match(page.d.body.textContent, /Q-100/);
  assert.equal(page.d.querySelector('.dsg-mc__done a').getAttribute('href'), '/acct/quotes/q100');
  assert.ok(page.state.calls.find((c) => c.key === 'PUT /apps/quotes/c/active-quote'), 'drafts become the active quote');
});

test('Send to sales with an existing draft: header fields ride in the from-cart target, no PATCH, cart kept when unchecked', async () => {
  const page = await boot(CART_HTML, SCRIPTS);
  await until(() => /26 items/.test(page.d.body.textContent));
  page.d.querySelector('input[value=existing]').click();
  await until(() => page.d.querySelectorAll('select option').length === 2);
  const sel = input(page, 'Draft quote');
  assert.equal(sel.value, 'q1', 'active quote preselected');
  assert.match(sel.options[0].textContent, /Q-10482 · PO 4471/);
  sel.value = 'q2';
  fill(page, input(page, 'PO number'), 'PO-9');
  fill(page, input(page, 'Needed by'), '2026-12-01');
  fill(page, input(page, 'Note to sales'), 'Deliver to dock B');
  page.d.querySelector('.dsg-check input').click(); // uncheck
  btn(page, 'Send to sales').click();
  await until(() => page.d.querySelector('.dsg-mc__done'));

  const order = page.calls();
  assert.equal(order.some((k) => k.startsWith('PATCH ')), false, 'no PATCH-first workaround any more');
  const fc = page.state.calls.find((c) => c.key === 'POST /apps/quotes/c/quotes/from-cart');
  assert.deepEqual(fc.body.target, { mode: 'existing', quoteId: 'q2', poNumber: 'PO-9', neededBy: '2026-12-01', notesToSales: 'Deliver to dock B' });
  assert.equal(fc.body.submit, true);
  assert.equal(fc.body.emptyCart, false);
  assert.equal(order.includes('POST /cart/clear.js'), false);
  assert.equal(page.state.cart.items.length, 2);
  assert.match(page.d.body.textContent, /Sent to sales/);
  assert.equal(order.includes('PUT /apps/quotes/c/active-quote'), false, 'submitted quotes are not the add-to target');
});

test('existing draft with blank header fields sends none of them, so the draft note is not overwritten', async () => {
  const page = await boot(CART_HTML, SCRIPTS);
  await until(() => /26 items/.test(page.d.body.textContent));
  page.d.querySelector('input[value=existing]').click();
  await until(() => page.d.querySelectorAll('select option').length === 2);
  btn(page, 'Save as draft').click();
  await until(() => page.d.querySelector('.dsg-mc__done'));
  const fc = page.state.calls.find((c) => c.key === 'POST /apps/quotes/c/quotes/from-cart');
  assert.deepEqual(fc.body.target, { mode: 'existing', quoteId: 'q1' });
  assert.equal(page.state.quotes[0].notesToSales, 'Keep the existing note');
  assert.equal(page.calls().some((k) => k.startsWith('PATCH ')), false);
  assert.deepEqual(page.state.active, { quoteId: 'q1', number: 10482, title: 'Exam rooms', lineCount: 6 });
  assert.ok(page.calls().includes('PUT /apps/quotes/c/active-quote'), 'draft saved: chip follows via PUT active-quote');
});

test('draft list is requested with status=DRAFT&limit=100', async () => {
  const page = await boot(CART_HTML, SCRIPTS);
  await until(() => /26 items/.test(page.d.body.textContent));
  page.d.querySelector('input[value=existing]').click();
  await until(() => page.d.querySelectorAll('select option').length === 2);
  const list = page.state.calls.find((c) => c.key === 'GET /apps/quotes/c/quotes');
  assert.equal(list.search, '?status=DRAFT&limit=100');
});

test('emptyCart stays client-side: a non-2xx from-cart never clears the cart', async () => {
  const state = defaultState();
  state.fail.push({ match: /POST \/apps\/quotes\/c\/quotes\/from-cart/, status: 422, body: { code: 'VALIDATION_FAILED', message: 'Bad' } });
  const page = await boot(CART_HTML, SCRIPTS, state);
  await until(() => /26 items/.test(page.d.body.textContent));
  page.d.querySelector('input[value=existing]').click();
  await until(() => page.d.querySelectorAll('select option').length === 2);
  btn(page, 'Save as draft').click();
  await until(() => page.d.querySelector('.dsg-error:not([hidden])'));
  assert.equal(page.calls().includes('POST /cart/clear.js'), false);
  assert.equal(page.state.cart.items.length, 2);
});

test('error state: API rejects, cart is NOT cleared, form stays editable', async () => {
  const state = defaultState();
  state.fail.push({ match: /from-cart$/, times: 1, status: 422, body: { code: 'VALIDATION_FAILED', message: 'Variant 222 is not in your catalog.' } });
  const page = await boot(CART_HTML, SCRIPTS, state);
  await until(() => /26 items/.test(page.d.body.textContent));
  fill(page, input(page, 'Job or quote name'), 'Job A');
  btn(page, 'Save as draft').click();
  await until(() => !page.d.querySelector('.dsg-error').hidden);
  assert.equal(page.d.querySelector('.dsg-error').textContent, 'Variant 222 is not in your catalog.');
  assert.equal(page.calls().includes('POST /cart/clear.js'), false);
  assert.equal(page.state.cart.items.length, 2);
  assert.equal(btn(page, 'Save as draft').disabled, false);
  // retry succeeds
  btn(page, 'Save as draft').click();
  await until(() => page.d.querySelector('.dsg-mc__done'));
  assert.deepEqual(page.state.cart.items, []);
});

test('error state: quote saved but cart clear fails shows a warning', async () => {
  const state = defaultState();
  state.fail.push({ match: /clear\.js$/, status: 500, body: {} });
  const page = await boot(CART_HTML, SCRIPTS, state);
  await until(() => /26 items/.test(page.d.body.textContent));
  fill(page, input(page, 'Job or quote name'), 'Job B');
  btn(page, 'Save as draft').click();
  await until(() => page.d.querySelector('.dsg-mc__done'));
  assert.match(page.d.querySelector('.dsg-mc__done .dsg-error').textContent, /could not empty your cart/);
});

test('validation: job name required for a new quote; no network calls', async () => {
  const page = await boot(CART_HTML, SCRIPTS);
  await until(() => /26 items/.test(page.d.body.textContent));
  const before = page.state.calls.length;
  btn(page, 'Send to sales').click();
  await tick(10);
  const j = input(page, 'Job or quote name');
  assert.equal(j.getAttribute('aria-invalid'), 'true');
  assert.equal(page.d.activeElement, j);
  assert.match(page.d.querySelector('.dsg-field__error').textContent, /job name/i);
  assert.equal(page.state.calls.length, before);
});

test('empty cart disables both buttons', async () => {
  const state = defaultState();
  state.cart = { item_count: 0, items: [] };
  const page = await boot(CART_HTML, SCRIPTS, state);
  await until(() => /Your cart is empty/.test(page.d.body.textContent));
  assert.equal(btn(page, 'Save as draft').disabled, true);
  assert.equal(btn(page, 'Send to sales').disabled, true);
});

test('logged-out / expired session: 401 explains how to continue', async () => {
  const state = defaultState();
  state.fail.push({ match: /from-cart$/, status: 401, body: { code: 'UNAUTHENTICATED', message: 'Sign in' } });
  const page = await boot(CART_HTML, SCRIPTS, state);
  await until(() => /26 items/.test(page.d.body.textContent));
  fill(page, input(page, 'Job or quote name'), 'Job C');
  btn(page, 'Save as draft').click();
  await until(() => !page.d.querySelector('.dsg-error').hidden);
  assert.match(page.d.querySelector('.dsg-error').textContent, /Sign in again/);
  assert.equal(page.state.cart.items.length, 2);
});

test('active quote chip: shows target, hides when none, follows add-to-quote events', async () => {
  const page = await boot(CHIP_HTML, ['dsg-quote-chip.js']);
  const chip = page.d.querySelector('[data-dsg-chip]');
  await until(() => !chip.hidden);
  assert.equal(page.d.querySelector('[data-dsg-chip-text]').textContent, 'Exam rooms · Q-10482');
  assert.equal(page.d.querySelector('[data-dsg-chip-link]').getAttribute('href'), '/acct/quotes/q1');
  assert.match(page.d.querySelector('[data-dsg-chip-link]').getAttribute('aria-label'), /Adding to quote Exam rooms/);
  page.w.DSGQuotes.emitActive({ quoteId: 'q9', number: 9, title: 'Nine' });
  assert.equal(page.d.querySelector('[data-dsg-chip-text]').textContent, 'Nine · Q-9');

  const state = defaultState();
  state.active = { quoteId: null };
  const none = await boot(CHIP_HTML, ['dsg-quote-chip.js'], state);
  await tick(20);
  assert.equal(none.d.querySelector('[data-dsg-chip]').hidden, true);
});
