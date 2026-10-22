/* DSG: routes every storefront "Add to Quote" button into the DSG Quotes module (app proxy /apps/quotes)
   instead of the old browser-only list. Loaded after dsg-global.js. */
(() => {
  'use strict';
  const BASE = '/apps/quotes';
  const loginUrl = () => '/account/login?return_url=' + encodeURIComponent(location.pathname + location.search);
  const gid = v => (String(v).indexOf('gid://') === 0 ? String(v) : 'gid://shopify/ProductVariant/' + v);
  const ui = () => window.DSGUI || {};

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(BASE + path, {
        method, credentials: 'same-origin',
        headers: Object.assign({ Accept: 'application/json' }, body === undefined ? {} : { 'Content-Type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) { const err = new Error('We could not reach the server. Check your connection and try again.'); err.status = 0; throw err; }
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
    if (!res.ok) { const err = new Error((data && data.message) || 'Something went wrong. Please try again.'); err.status = res.status; throw err; }
    return data;
  }

  /** Add lines to the dealer's active draft quote (creating one if needed). Returns the quote id. */
  async function addLines(lines) {
    const a = await api('GET', '/c/active-quote').catch(e => { if (e.status === 401) throw e; return { quoteId: null }; });
    let id = a && a.quoteId;
    if (!id) {
      const d = new Date();
      const name = 'Quote ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const q = await api('POST', '/c/quotes', { title: name, newJob: { name: name }, setActive: true });
      id = q.id;
    }
    for (const l of lines) await api('POST', '/c/quotes/' + encodeURIComponent(id) + '/lines', { variantId: gid(l.variantId), qty: l.qty || 1 });
    refreshCount();
    return id;
  }

  function handleError(err) {
    if (err && err.status === 401) { location.href = loginUrl(); return; }
    if (err && err.status === 403) { ui().toast && ui().toast('Company account needed', 'Quotes are available to approved dealer accounts. Contact DSG to get set up.'); return; }
    ui().toast && ui().toast('Could not add to quote', (err && err.message) || 'Please try again.');
  }

  const signedIn = () => !!(window.DSG && window.DSG.customer);

  async function refreshCount() {
    let n = 0;
    if (signedIn()) try { const a = await api('GET', '/c/active-quote'); n = (a && a.lineCount) || 0; } catch (e) { n = 0; }
    document.querySelectorAll('[data-quote-count]').forEach(b => { b.textContent = n; b.dataset.count = n; });
  }

  // Capture phase: runs before (and replaces) the theme's old localStorage handler.
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-add-quote]');
    if (!b) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (b.getAttribute('aria-busy') === 'true') return;
    if (!signedIn()) { location.href = loginUrl(); return; }
    const idEl = b.dataset.qtyFrom && document.getElementById(b.dataset.qtyFrom);
    const qty = Math.max(1, parseInt(idEl && idEl.value, 10) || 1);
    const html = b.innerHTML;
    b.setAttribute('aria-busy', 'true'); b.classList.add('is-loading');
    addLines([{ variantId: b.dataset.variantId, qty }]).then(() => {
      b.classList.remove('is-loading'); b.classList.add('is-success'); b.innerHTML = '✓ Added';
      setTimeout(() => { b.classList.remove('is-success'); b.innerHTML = html; }, 1400);
      ui().toast && ui().toast('Added to your quote: ' + qty + ' × ' + (b.dataset.title || ''), 'Add more, then submit it to sales from My Quotes.', { href: '/pages/quote', label: 'View my quotes' });
    }).catch(err => { b.classList.remove('is-loading'); handleError(err); })
      .finally(() => b.removeAttribute('aria-busy'));
  }, true);

  // Cart page "move to quote": wait for the quote write before the page navigates away to remove the cart line.
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-move-quote]');
    if (!b) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!signedIn()) { location.href = loginUrl(); return; }
    b.disabled = true;
    addLines([{ variantId: b.dataset.variantId, qty: +b.dataset.qty || 1 }]).then(() => {
      ui().toast && ui().toast('Moved to your quote', b.dataset.title || '');
      if (b.dataset.removeUrl) location.href = b.dataset.removeUrl; else b.disabled = false;
    }).catch(err => { b.disabled = false; handleError(err); });
  }, true);

  // Quick Order and anything else that calls DSGUI.addQuoteLines now writes to the real quote.
  const wire = () => {
    if (!window.DSGUI) return;
    window.DSGUI.addQuoteLines = lines => addLines((lines || []).filter(l => l && l.variantId)).catch(handleError);
    window.DSGUI.refreshQuote = refreshCount;
  };
  wire();
  document.addEventListener('DOMContentLoaded', () => { wire(); refreshCount(); });
  window.DSGQuoteBridge = { addLines, refreshCount, api };
})();
