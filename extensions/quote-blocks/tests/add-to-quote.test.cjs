'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, defaultState, until, tick, PDP_HTML } = require('./helpers.cjs');

const SCRIPTS = ['dsg-add-to-quote.js'];
const open = async (page) => {
  const trigger = page.d.querySelector('[data-dsg-trigger]');
  trigger.click();
  await until(() => page.d.querySelector('.dsg-opt'), 'quote list');
  return trigger;
};
const key = (page, target, k, extra) =>
  target.dispatchEvent(new page.w.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra)));

test('opens popover, lists only DRAFT quotes, preselects the active quote', async () => {
  const page = await boot(PDP_HTML, SCRIPTS);
  const trigger = page.d.querySelector('[data-dsg-trigger]');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  await open(page);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  const pop = page.d.querySelector('[data-dsg-popover]');
  assert.equal(pop.hidden, false);
  assert.match(pop.textContent, /Add 2 × PA-935A to which quote\?/);
  const rows = [...pop.querySelectorAll('.dsg-opt')];
  assert.equal(rows.length, 3); // 2 drafts + "Start a new quote" (SUBMITTED q3 is not offered)
  assert.match(rows[0].textContent, /Lakeview Clinic/);
  assert.match(rows[0].textContent, /Q-10482 · PO 4471 · Draft · 6 items · \$3,912\.00/);
  assert.match(rows[1].textContent, /Q-10477 · no PO yet · Draft · 14 items · \$18,240\.50/);
  assert.equal(pop.querySelector('input[value=q1]').checked, true);
  assert.equal(page.d.activeElement.value, 'q1', 'focus moves into the popover');
  assert.equal(pop.querySelector('a.dsg-btn').getAttribute('href'), '/acct/quotes/q1');
  assert.ok(page.calls().includes('GET /apps/quotes/c/quotes'));
  assert.equal(page.state.calls[0].search, '?status=DRAFT&limit=100');
});

test('add line to an existing draft quote', async () => {
  const page = await boot(PDP_HTML, SCRIPTS);
  let event = null;
  page.d.addEventListener('dsg-quotes:active-changed', (e) => { event = e.detail; });
  await open(page);
  page.d.querySelector('input[value=q2]').click();
  page.d.querySelector('input[value=q2]').dispatchEvent(new page.w.Event('change', { bubbles: true }));
  assert.equal(page.d.querySelector('a.dsg-btn').getAttribute('href'), '/acct/quotes/q2');
  [...page.d.querySelectorAll('.dsg-btn--primary')].find((b) => b.textContent === 'Add to quote').click();
  await until(() => /Added to your quote/.test(page.d.querySelector('[data-dsg-popover]').textContent));

  const post = page.state.calls.find((c) => c.key === 'POST /apps/quotes/c/quotes/q2/lines');
  assert.deepEqual(post.body, { variantId: 'gid://shopify/ProductVariant/111', qty: 2 });
  const put = page.state.calls.find((c) => c.key === 'PUT /apps/quotes/c/active-quote');
  assert.deepEqual(put.body, { quoteId: 'q2' });
  assert.equal(page.state.calls.some((c) => c.key === 'POST /apps/quotes/c/quotes'), false, 'no new quote created');
  const pop = page.d.querySelector('[data-dsg-popover]');
  assert.match(pop.textContent, /Added to Q-10477/);
  assert.equal(pop.querySelector('a.dsg-btn--primary').getAttribute('href'), '/acct/quotes/q2');
  assert.equal(event.quoteId, 'q2');
});

test('uses the variant currently selected in the theme form', async () => {
  const page = await boot(PDP_HTML, SCRIPTS);
  page.d.querySelector('form [name=id]').value = '999';
  page.d.querySelector('form [name=quantity]').value = '5';
  await open(page);
  [...page.d.querySelectorAll('.dsg-btn--primary')].find((b) => b.textContent === 'Add to quote').click();
  await until(() => page.state.calls.some((c) => /lines$/.test(c.path)));
  assert.deepEqual(page.state.calls.find((c) => /lines$/.test(c.path)).body, { variantId: 'gid://shopify/ProductVariant/999', qty: 5 });
});

test('create a new quote with job name + PO, then add the line', async () => {
  const page = await boot(PDP_HTML, SCRIPTS);
  await open(page);
  const job = page.d.querySelector('input[aria-label="Job name"]');
  const po = page.d.querySelector('input[aria-label="PO number (optional)"]');
  job.focus(); // focusing the fields selects "Start a new quote"
  assert.equal(page.d.querySelector('input[value=new]').checked, true);
  job.value = 'Ridgeway Church'; job.dispatchEvent(new page.w.Event('input'));
  po.value = 'PO-77'; po.dispatchEvent(new page.w.Event('input'));
  [...page.d.querySelectorAll('.dsg-btn--primary')].find((b) => b.textContent === 'Add to quote').click();
  await until(() => /Added to your quote/.test(page.d.querySelector('[data-dsg-popover]').textContent));

  const create = page.state.calls.find((c) => c.key === 'POST /apps/quotes/c/quotes');
  assert.deepEqual(create.body, { title: 'Ridgeway Church', newJob: { name: 'Ridgeway Church', poNumber: 'PO-77' }, setActive: true, poNumber: 'PO-77' });
  const line = page.state.calls.find((c) => /\/lines$/.test(c.path));
  assert.equal(line.path, '/apps/quotes/c/quotes/q100/lines');
  assert.deepEqual(line.body, { variantId: 'gid://shopify/ProductVariant/111', qty: 2 });
  assert.match(page.d.querySelector('[data-dsg-popover]').textContent, /Q-100/);
});

test('new quote requires a job name and shows an accessible error', async () => {
  const state = defaultState();
  state.quotes = []; // no drafts: "Start a new quote" is preselected
  const page = await boot(PDP_HTML, SCRIPTS, state);
  await open(page);
  assert.equal(page.d.querySelector('input[value=new]').checked, true);
  [...page.d.querySelectorAll('.dsg-btn--primary')].find((b) => b.textContent === 'Add to quote').click();
  await tick(10);
  const err = page.d.querySelector('.dsg-error');
  assert.equal(err.getAttribute('role'), 'alert');
  assert.equal(err.hidden, false);
  assert.match(err.textContent, /job name/i);
  assert.equal(page.d.querySelector('input[aria-label="Job name"]').getAttribute('aria-invalid'), 'true');
  assert.equal(page.d.activeElement.getAttribute('aria-label'), 'Job name');
  assert.equal(page.state.calls.some((c) => c.method === 'POST'), false);
});

test('error state: API failure is shown, retry does not create a duplicate quote', async () => {
  const state = defaultState();
  state.quotes = [];
  state.fail.push({ match: /^POST .*\/lines$/, times: 1, status: 409, body: { code: 'NOT_EDITABLE', message: 'This quote is locked while sales reviews it.' } });
  const page = await boot(PDP_HTML, SCRIPTS, state);
  await open(page);
  const job = page.d.querySelector('input[aria-label="Job name"]');
  job.value = 'Retry job'; job.dispatchEvent(new page.w.Event('input'));
  const add = () => [...page.d.querySelectorAll('.dsg-btn--primary')].find((b) => b.textContent === 'Add to quote');
  add().click();
  await until(() => !page.d.querySelector('.dsg-error').hidden);
  assert.equal(page.d.querySelector('.dsg-error').textContent, 'This quote is locked while sales reviews it.');
  assert.equal(add().disabled, false, 'button re-enabled');
  add().click();
  await until(() => /Added to your quote/.test(page.d.querySelector('[data-dsg-popover]').textContent));
  assert.equal(page.state.calls.filter((c) => c.key === 'POST /apps/quotes/c/quotes').length, 1);
  assert.equal(page.state.calls.filter((c) => /\/lines$/.test(c.path)).length, 2);
});

test('error state: list load failure offers Try again', async () => {
  const state = defaultState();
  state.fail.push({ match: /^GET .*\/c\/quotes$/, times: 1, network: true });
  const page = await boot(PDP_HTML, SCRIPTS, state);
  page.d.querySelector('[data-dsg-trigger]').click();
  await until(() => page.d.querySelector('.dsg-error'));
  assert.match(page.d.querySelector('.dsg-error').textContent, /could not reach the server/i);
  [...page.d.querySelectorAll('button')].find((b) => b.textContent === 'Try again').click();
  await until(() => page.d.querySelector('.dsg-opt'));
});

test('logged-out state: 401 from the proxy shows a sign-in prompt', async () => {
  const state = defaultState();
  state.fail.push({ match: /^GET .*\/c\/quotes$/, status: 401, body: { code: 'UNAUTHENTICATED', message: 'Sign in' } });
  const page = await boot(PDP_HTML, SCRIPTS, state);
  page.d.querySelector('[data-dsg-trigger]').click();
  await until(() => /Sign in to request a quote/.test(page.d.querySelector('[data-dsg-popover]').textContent));
  const link = page.d.querySelector('[data-dsg-popover] a');
  assert.equal(link.getAttribute('href'), '/account/login?return_url=%2Fproducts%2Fpa-935a');
});

test('logged-out markup (no popover) is left alone by the script', async () => {
  const html = '<div class="dsg-quote" data-dsg-add-to-quote data-logged-in="false"><a class="dsg-btn" href="/account/login" data-dsg-signin><span>Sign in to request a quote</span></a></div>';
  const page = await boot(html, SCRIPTS);
  assert.equal(page.d.querySelector('a').textContent, 'Sign in to request a quote');
  assert.equal(page.state.calls.length, 0, 'no API calls when logged out');
});

test('accessibility: focus trap, Escape closes and restores focus, outside click closes', async () => {
  const page = await boot(PDP_HTML, SCRIPTS);
  const trigger = page.d.querySelector('[data-dsg-trigger]');
  trigger.focus();
  trigger.click();
  await until(() => page.d.querySelector('.dsg-opt'));
  const pop = page.d.querySelector('[data-dsg-popover]');
  assert.equal(pop.getAttribute('role'), 'dialog');
  assert.ok(pop.getAttribute('aria-labelledby'), 'dialog is labelled');
  assert.equal(pop.querySelector('[role=radiogroup]') !== null, true);

  const items = page.w.DSGQuotes.focusables(pop);
  const first = items[0], last = items[items.length - 1];
  last.focus();
  key(page, last, 'Tab');
  assert.equal(page.d.activeElement, first, 'Tab on last wraps to first');
  first.focus();
  key(page, first, 'Tab', { shiftKey: true });
  assert.equal(page.d.activeElement, last, 'Shift+Tab on first wraps to last');

  key(page, page.d.activeElement, 'Escape');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(pop.hidden, true);
  assert.equal(page.d.activeElement, trigger);

  trigger.click();
  await until(() => !pop.hidden);
  page.d.getElementById('after').dispatchEvent(new page.w.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(pop.hidden, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});
