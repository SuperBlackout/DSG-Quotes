/* DSG: "My quotes" on the storefront (/pages/quote). List view, and detail view at /pages/quote?id=<quoteId>.
   Talks to the DSG Quotes app proxy (/apps/quotes). Signed-in dealers only. */
(() => {
  'use strict';
  const root = document.querySelector('[data-mq]');
  if (!root) return;
  const BASE = '/apps/quotes';
  const quoteId = new URLSearchParams(location.search).get('id');
  const LABEL = { DRAFT: 'Draft', SUBMITTED: 'Sent to DSG', IN_REVIEW: 'In review', QUOTE_READY: 'Ready for you', CHANGES_REQUESTED: 'Changes requested', ACCEPTED: 'Accepted', ORDERED: 'Ordered', EXPIRED: 'Expired', DECLINED: 'Declined', WITHDRAWN: 'Withdrawn' };
  const WAIT = { customer: 'Waiting on you', sales: 'DSG is working on it', none: '' };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (a, cur) => { const n = parseFloat(a); if (isNaN(n)) return '—'; try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(n); } catch (e) { return '$' + n.toFixed(2); } };
  const date = s => { if (!s) return '—'; const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00') : new Date(s); return isNaN(d) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
  const when = s => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const num = q => q.displayNumber || (q.number ? 'Q-' + q.number : 'Quote');
  const badge = s => '<span class="mq-badge" data-s="' + esc(s) + '">' + esc(LABEL[s] || s) + '</span>';
  const toast = (t, b) => { if (window.DSGUI && window.DSGUI.toast) window.DSGUI.toast(t, b || ''); };

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(BASE + path, { method, credentials: 'same-origin', headers: Object.assign({ Accept: 'application/json' }, body === undefined ? {} : { 'Content-Type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { const err = new Error('We could not reach the server. Check your connection and try again.'); err.status = 0; throw err; }
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
    if (!res.ok) { const err = new Error((data && data.message) || 'Something went wrong. Please try again.'); err.status = res.status; err.code = data && data.code; err.details = data && data.details; throw err; }
    return data;
  }
  const loginRedirect = () => { location.href = '/account/login?return_url=' + encodeURIComponent(location.pathname + location.search); };
  const fatal = err => {
    if (err && err.status === 401) return loginRedirect();
    root.innerHTML = '<p role="alert" class="mq-error">' + esc(err && err.status === 403 ? 'Quotes are available to approved dealer accounts. Contact DSG to get set up.' : (err && err.message) || 'We could not load your quotes. Please try again.') + '</p><p><a class="btn btn--secondary btn--sm" href="' + esc(location.pathname) + '">Back to my quotes</a></p>';
  };

  /* ------------------------------------------------------------------ list */
  function renderList(items) {
    if (!items.length) { root.innerHTML = '<p>You have no quotes yet. Use “Add to Quote” on any product, or move your cart to a quote.</p>'; return; }
    let h = '<div class="mq-row mq-head"><span>Quote</span><span>Status</span><span>Items</span><span>Total</span><span>Expires</span></div>';
    items.forEach(q => {
      const po = (q.job && q.job.poNumber) || q.poNumber;
      h += '<a class="mq-row mq-link" href="?id=' + encodeURIComponent(q.id) + '"><span><strong>' + esc(num(q)) + '</strong> · ' + esc(q.title || '') + (po ? '<br><span class="t-small">PO ' + esc(po) + '</span>' : '') + '</span>'
        + '<span>' + badge(q.status) + (q.unreadCount ? ' <span class="mq-dot" title="New message"></span>' : '') + '<br><span class="t-small">' + esc(WAIT[q.waitingOn] || '') + '</span></span>'
        + '<span>' + esc(q.lineCount || 0) + '</span><span class="t-num">' + esc(money(q.total, q.currencyCode)) + '</span><span>' + esc(date(q.expiresAt)) + '</span></a>';
    });
    root.innerHTML = h;
  }
  function loadList() {
    root.innerHTML = '<p class="t-small" role="status">Loading your quotes…</p>';
    call('GET', '/c/quotes?limit=100').then(r => renderList((r && r.items) || [])).catch(fatal);
  }

  /* ---------------------------------------------------------------- detail */
  let Q = null;
  let notice = '';
  let busy = false;
  let confirming = null;

  function renderDetail() {
    const q = Q, a = q.actions || {}, cur = q.currencyCode;
    const ver = (q.versions && q.versions.length) ? q.versions[q.versions.length - 1] : null;
    const editable = !!a.canEditLines;
    let h = '<p><a href="' + esc(location.pathname) + '">← All quotes</a></p>';
    h += '<div class="mq-title"><h2>' + esc(num(q)) + ' · ' + esc(q.title || '') + '</h2><div>' + badge(q.status) + ' <span class="t-small">' + esc(WAIT[q.waitingOn] || '') + '</span></div></div>';
    if (notice) h += '<p class="mq-notice" role="status">' + notice + '</p>';
    h += '<p data-err class="mq-error" role="alert" hidden></p>';
    h += '<dl class="mq-meta"><div><dt>PO number</dt><dd>' + esc(q.poNumber || (q.job && q.job.poNumber) || '—') + '</dd></div><div><dt>Job</dt><dd>' + esc((q.job && q.job.name) || '—') + '</dd></div><div><dt>Needed by</dt><dd>' + esc(date(q.neededBy)) + '</dd></div><div><dt>Quote expires</dt><dd>' + esc(date(q.expiresAt)) + '</dd></div><div><dt>DSG rep</dt><dd>' + esc(q.assignedRepName || '—') + '</dd></div></dl>';

    h += '<div class="mq-lines"><div class="mq-line mq-head"><span>Item</span><span>Qty</span><span>Price</span><span>Total</span></div>';
    (q.lines || []).forEach(l => {
      h += '<div class="mq-line"><span class="mq-item">' + (l.imageUrl ? '<img src="' + esc(l.imageUrl) + '" alt="" width="48" height="48" loading="lazy">' : '') + '<span><strong>' + esc(l.title) + '</strong><br><span class="t-small">' + esc(l.sku || '') + '</span>' + (l.lineNote ? '<br><span class="t-small">' + esc(l.lineNote) + '</span>' : '') + '</span></span>'
        + '<span>' + (editable ? '<input class="input mq-qty" type="number" min="1" value="' + esc(l.qty) + '" data-qty="' + esc(l.id) + '" aria-label="Quantity for ' + esc(l.title) + '"> <button type="button" class="btn btn--tertiary btn--sm" data-act="remove" data-line="' + esc(l.id) + '">Remove</button>' : esc(l.qty)) + '</span>'
        + '<span class="t-num">' + esc(money(l.quotedPrice, cur)) + '</span><span class="t-num">' + esc(money(l.lineTotal, cur)) + '</span></div>';
    });
    if (!(q.lines || []).length) h += '<p class="t-small" style="padding:12px 0">No items on this quote yet. Add products from the store.</p>';
    h += '</div>';

    h += '<div class="mq-totals">';
    if (ver && q.status !== 'DRAFT') {
      h += '<div><span>Subtotal</span><span class="t-num">' + esc(money(ver.subtotal, cur)) + '</span></div>';
      if (parseFloat(ver.discountTotal) > 0) h += '<div><span>Discount</span><span class="t-num">−' + esc(money(ver.discountTotal, cur)) + '</span></div>';
      if (parseFloat(ver.freight) > 0) h += '<div><span>Freight</span><span class="t-num">' + esc(money(ver.freight, cur)) + '</span></div>';
      if (ver.taxEstimate) h += '<div><span>Tax (estimate)</span><span class="t-num">' + esc(money(ver.taxEstimate, cur)) + '</span></div>';
    }
    h += '<div class="mq-grand"><span>' + (q.status === 'DRAFT' ? 'Estimated total' : 'Total') + '</span><span class="t-num">' + esc(money(q.total, cur)) + '</span></div></div>';
    if (q.status === 'DRAFT') h += '<p class="t-small">Prices on a draft are estimates. A DSG rep sets the final price after you submit.</p>';
    if (ver && ver.repNote) h += '<div class="mq-repnote"><strong>Note from DSG</strong><br>' + esc(ver.repNote).replace(/\n/g, '<br>') + '</div>';

    if (a.canSubmit) {
      h += '<section class="mq-panel"><h3>Send to DSG</h3><div class="mq-form"><label>PO number<input class="input" data-f="po" value="' + esc(q.poNumber || (q.job && q.job.poNumber) || '') + '"></label><label>Needed by<input class="input" type="date" data-f="needed" value="' + esc(q.neededBy || '') + '"></label><label class="mq-wide">Note to sales<textarea class="input" rows="3" data-f="note" placeholder="Quantities, timing, ship-to, anything the rep should know">' + esc(q.notesToSales || '') + '</textarea></label></div><p><button type="button" class="btn btn--primary" data-act="submit">Submit to sales</button></p></section>';
    }
    let acts = '';
    if (a.canAccept) acts += '<button type="button" class="btn btn--primary" data-act="accept">Accept this quote</button>';
    if (a.canBuy) acts += '<button type="button" class="btn btn--primary" data-act="buy">Buy now</button>';
    if (a.canReopen) acts += '<button type="button" class="btn btn--secondary" data-act="reopen">Change before buying</button>';
    if (a.canWithdraw) acts += '<button type="button" class="btn btn--secondary" data-act="withdraw">' + (confirming === 'withdraw' ? 'Click again to withdraw' : 'Withdraw to edit') + '</button>';
    if (a.canDecline) acts += '<button type="button" class="btn btn--tertiary" data-act="decline">' + (confirming === 'decline' ? 'Click again to decline' : 'Decline') + '</button>';
    if (a.canDelete) acts += '<button type="button" class="btn btn--tertiary" data-act="delete">' + (confirming === 'delete' ? 'Click again to delete' : 'Delete draft') + '</button>';
    if (ver) acts += '<a class="btn btn--tertiary" href="' + BASE + '/c/quotes/' + encodeURIComponent(q.id) + '/pdf" target="_blank" rel="noopener">Download PDF</a>';
    if (acts) h += '<div class="mq-actions">' + acts + '</div>';
    if (a.canRequestChanges) h += '<section class="mq-panel"><h3>Need something different?</h3><textarea class="input" rows="3" data-f="changes" placeholder="Tell DSG what to change (quantities, price, products…)"></textarea><p><button type="button" class="btn btn--secondary" data-act="changes">Request changes</button></p></section>';

    h += '<section class="mq-panel"><h3>Conversation with DSG</h3><div class="mq-msgs">';
    (q.messages || []).forEach(m => {
      const mine = m.authorType === 'CUSTOMER';
      h += '<div class="mq-msg' + (mine ? ' mq-msg--me' : '') + '"><div class="t-small">' + esc(m.authorType === 'SYSTEM' ? 'DSG Quotes' : (m.authorName || (mine ? 'You' : 'DSG'))) + ' · ' + esc(when(m.createdAt)) + '</div><div>' + esc(m.body).replace(/\n/g, '<br>') + '</div></div>';
    });
    if (!(q.messages || []).length) h += '<p class="t-small">No messages yet.</p>';
    h += '</div><textarea class="input" rows="2" data-f="msg" placeholder="Write a message to your DSG rep"></textarea><p><button type="button" class="btn btn--secondary" data-act="message">Send message</button></p></section>';
    root.innerHTML = h;
  }

  function showErr(msg) { const e = root.querySelector('[data-err]'); if (e) { e.textContent = msg; e.hidden = !msg; if (msg) e.scrollIntoView({ block: 'nearest' }); } }
  const val = k => { const el = root.querySelector('[data-f="' + k + '"]'); return el ? el.value.trim() : ''; };

  async function run(btn, fn, doneMsg) {
    if (busy) return;
    busy = true; confirming = null;
    const label = btn && btn.textContent; if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    try {
      const out = await fn();
      if (out && out.lines) Q = out;
      notice = doneMsg || '';
      if (!out || !out.lines) await reload(); else renderDetail();
      if (doneMsg) toast(doneMsg);
    } catch (err) {
      if (err.status === 401) return loginRedirect();
      if (btn) { btn.disabled = false; btn.textContent = label; }
      if (err.code === 'VERSION_MISMATCH') { notice = 'DSG sent a newer version while you were looking. Please review it before accepting.'; await reload(); }
      else if (err.code === 'NOT_PURCHASABLE') showErr(err.message + ' You can ask for a new quote based on this one.'), root.querySelector('.mq-actions') && root.querySelector('.mq-actions').insertAdjacentHTML('beforeend', '<button type="button" class="btn btn--primary" data-act="duplicate">Ask for a new quote</button>');
      else showErr(err.message);
    } finally { busy = false; }
  }
  async function reload() { Q = await call('GET', '/c/quotes/' + encodeURIComponent(quoteId)); renderDetail(); }

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || !Q) return;
    const act = b.dataset.act, id = encodeURIComponent(Q.id);
    if ((act === 'withdraw' || act === 'decline' || act === 'delete') && confirming !== act) { confirming = act; renderDetail(); return; }
    if (act === 'remove') return run(b, () => call('DELETE', '/c/quotes/' + id + '/lines/' + encodeURIComponent(b.dataset.line)), 'Item removed');
    if (act === 'submit') {
      const body = {}; if (val('po')) body.poNumber = val('po'); if (val('needed')) body.neededBy = val('needed'); if (val('note')) body.notesToSales = val('note');
      return run(b, () => call('POST', '/c/quotes/' + id + '/submit', body), 'Sent to DSG. A rep will price it and reply here and by email.');
    }
    if (act === 'accept') return run(b, () => call('POST', '/c/quotes/' + id + '/accept', { versionNo: Q.currentVersion }), 'Accepted. You can now buy it.');
    if (act === 'buy') return run(b, async () => { const r = await call('POST', '/c/quotes/' + id + '/checkout'); location.href = r.invoiceUrl; return new Promise(() => {}); });
    if (act === 'reopen') return run(b, () => call('POST', '/c/quotes/' + id + '/reopen'), 'Sent back to DSG for changes.');
    if (act === 'withdraw') return run(b, () => call('POST', '/c/quotes/' + id + '/withdraw'), 'Withdrawn. You can edit it now.');
    if (act === 'decline') return run(b, () => call('POST', '/c/quotes/' + id + '/decline', {}), 'Quote declined.');
    if (act === 'delete') return run(b, async () => { await call('DELETE', '/c/quotes/' + id); location.href = location.pathname; return new Promise(() => {}); });
    if (act === 'duplicate') return run(b, async () => { const n = await call('POST', '/c/quotes/' + id + '/duplicate'); location.href = location.pathname + '?id=' + encodeURIComponent(n.id); return new Promise(() => {}); });
    if (act === 'changes') {
      if (!val('changes')) return showErr('Tell DSG what you would like changed.');
      return run(b, () => call('POST', '/c/quotes/' + id + '/request-changes', { message: val('changes') }), 'Sent. DSG will send you a new version.');
    }
    if (act === 'message') {
      if (!val('msg')) return showErr('Write a message first.');
      return run(b, () => call('POST', '/c/quotes/' + id + '/messages', { body: val('msg') }), 'Message sent');
    }
  });
  root.addEventListener('change', e => {
    const i = e.target.closest('[data-qty]'); if (!i || !Q) return;
    const qty = Math.max(1, parseInt(i.value, 10) || 1);
    run(null, () => call('PATCH', '/c/quotes/' + encodeURIComponent(Q.id) + '/lines/' + encodeURIComponent(i.dataset.qty), { qty }), 'Quantity updated');
  });

  if (quoteId) { root.innerHTML = '<p class="t-small" role="status">Loading quote…</p>'; reload().catch(fatal); } else loadList();
})();
