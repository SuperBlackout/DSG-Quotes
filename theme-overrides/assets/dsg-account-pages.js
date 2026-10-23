/* DSG: "Statement" (/pages/statement) and "Account info" (/pages/account-info) on the storefront.
   Read-only. Talks to the DSG Quotes app proxy (/apps/quotes/a/v1/*), which Shopify signs with the signed-in customer.
   Company Location admins only; everyone else gets a clear message. Mount point on each Shopify page:
   <div data-dsg-account="statement"></div>  or  <div data-dsg-account="account-info"></div> */
(() => {
  'use strict';
  const root = document.querySelector('[data-dsg-account]');
  if (!root) return;
  const view = root.getAttribute('data-dsg-account');
  const BASE = '/apps/quotes/a/v1';

  const CSS = `
.da{max-width:1100px;margin:0 auto;padding:8px 0 40px;color:var(--text,#0e1d2b)}
.da h2{margin:28px 0 10px;font-size:1.15rem}
.da-muted{color:var(--muted,#5b6773);font-size:.88rem}
.da-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:14px 0}
.da-card{border:1px solid var(--line,#d9dee5);border-radius:10px;padding:14px 16px;background:#fff}
.da-card span{display:block;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#5b6773)}
.da-card strong{display:block;font-size:1.45rem;margin-top:4px}
.da-card[data-tone=bad] strong{color:#a32517}.da-card[data-tone=good] strong{color:#17703a}
.da-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin:14px 0}
.da-bar label{display:grid;gap:3px;font-size:.78rem;color:var(--muted,#5b6773)}
.da-bar input,.da-bar select{font:inherit;padding:8px 10px;border:1px solid var(--line,#d9dee5);border-radius:8px;background:#fff;color:inherit;min-height:40px}
.da-btn{font:inherit;font-weight:600;padding:9px 14px;min-height:40px;border-radius:8px;border:1px solid #2f6ea8;background:#2f6ea8;color:#fff;cursor:pointer}
.da-btn[data-v=ghost]{background:#fff;color:#2f6ea8}
.da-btn:disabled{opacity:.6;cursor:default}
.da-btn:focus-visible,.da-bar input:focus-visible,.da-bar select:focus-visible{outline:2px solid #2f6ea8;outline-offset:2px}
.da-table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line,#d9dee5);border-radius:10px;overflow:hidden}
.da-table th{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;text-align:left;color:var(--muted,#5b6773);padding:10px 12px;background:#f5f7fa}
.da-table td{padding:10px 12px;border-top:1px solid var(--line,#d9dee5);vertical-align:top}
.da-num{text-align:right;white-space:nowrap}
.da-tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.75rem;background:#eceff3;color:#3b4652}
.da-tag[data-s=overdue]{background:#fdf0ee;color:#a32517}.da-tag[data-s=paid]{background:#e8f6ec;color:#17703a}
.da-note{border:1px solid #c9dcef;background:#eef4fb;border-radius:10px;padding:14px 16px;margin:14px 0}
.da-note[data-tone=warn]{background:#fff6e0;border-color:#f0d9a0}.da-note[data-tone=bad]{background:#fdf0ee;border-color:#f1c4bf}
.da-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.da-box{border:1px solid var(--line,#d9dee5);border-radius:10px;padding:14px 16px;background:#fff}
.da-box h3{margin:0 0 6px;font-size:1rem}.da-box p{margin:4px 0}
@media (max-width:720px){
 .da-table thead{display:none}
 .da-table,.da-table tbody,.da-table tr,.da-table td{display:block;width:100%}
 .da-table tr{border-top:1px solid var(--line,#d9dee5);padding:8px 4px}
 .da-table td{border:0;padding:4px 10px;text-align:left}
 .da-table td[data-l]::before{content:attr(data-l);display:block;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#5b6773)}
 .da-num{text-align:left}
 .da-bar>*{flex:1 1 140px}
}`;
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (a, cur) => { const n = parseFloat(a); if (isNaN(n)) return '—'; try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(n); } catch (e) { return '$' + n.toFixed(2); } };
  const date = s => { if (!s) return '—'; const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00') : new Date(s); return isNaN(d) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
  const stamp = s => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const title = s => String(s || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const KIND = { invoice: 'Invoice', payment: 'Payment', credit_note: 'Credit note', sales_order: 'Sales order' };

  const wrap = html => { root.innerHTML = '<div class="da">' + html + '</div>'; };
  const note = (tone, head, body, extra) => '<div class="da-note" data-tone="' + tone + '"><strong>' + esc(head) + '</strong><p style="margin:6px 0 0">' + body + '</p>' + (extra || '') + '</div>';
  const fail = (status) => {
    if (status === 401) return wrap(note('warn', 'Sign in to see your account', 'Your statement is available to signed-in dealers.', '<p style="margin:10px 0 0"><a class="da-btn" style="display:inline-block;text-decoration:none" href="/account/login?return_url=' + encodeURIComponent(location.pathname) + '">Sign in</a></p>'));
    if (status === 403) return wrap(note('warn', 'Not available for this login', 'Statements and account details are shown to your company’s Location admin. Ask your admin, or contact your DSG rep to be added.'));
    if (status === 503) return wrap(note('info', 'Your statement is being prepared', 'It is loading from our accounting system. Try again in a minute.', '<p style="margin:10px 0 0"><button class="da-btn" data-v="ghost" data-retry>Try again</button></p>'));
    return wrap(note('bad', 'Something went wrong', 'Please try again, or call your DSG rep at (516) 249-8800.', '<p style="margin:10px 0 0"><button class="da-btn" data-v="ghost" data-retry>Try again</button></p>'));
  };

  async function api(path, opts) {
    let res;
    try { res = await fetch(BASE + path, Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }, opts || {})); }
    catch (e) { const err = new Error('network'); err.status = 0; throw err; }
    if (!res.ok) { const err = new Error('http'); err.status = res.status; throw err; }
    return res.json();
  }
  root.addEventListener('click', e => { if (e.target.closest('[data-retry]')) start(); });

  /* Open a single-use PDF link. The tab is opened first (inside the click) so popup blockers allow it. */
  async function openPdf(path, body, btn) {
    const label = btn.textContent; btn.disabled = true; btn.textContent = 'Preparing…';
    const w = window.open('about:blank', '_blank');
    try {
      const r = await api(path, { method: 'POST', body: JSON.stringify(body || {}) });
      if (w) w.location.href = r.url; else location.href = r.url;
    } catch (e) {
      if (w) w.close();
      btn.textContent = e.status === 429 ? 'Too many requests, wait a moment' : 'Could not prepare the PDF. Try again';
      setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 3500);
      return;
    }
    btn.textContent = label; btn.disabled = false;
  }

  /* ------------------------------------------------------------------ statement */
  const filters = { type: '', from: '', to: '', search: '' };
  let cursor = null, items = [], cur = 'USD';

  function rowHtml(it) {
    const open = it.kind === 'invoice' && parseFloat(it.balance) > 0;
    const overdue = open && it.dueDate && it.dueDate < new Date().toISOString().slice(0, 10);
    const sTag = overdue ? 'overdue' : (/paid/i.test(it.status) ? 'paid' : '');
    return '<tr><td data-l="Type">' + esc(KIND[it.kind] || it.kind) + '</td>'
      + '<td data-l="Number"><strong>' + esc(it.number) + '</strong>' + (it.reference ? '<span class="da-muted"> · ' + esc(it.reference) + '</span>' : '') + '</td>'
      + '<td data-l="Date">' + esc(date(it.date)) + '</td>'
      + '<td data-l="Due">' + esc(it.kind === 'invoice' ? date(it.dueDate) : '—') + '</td>'
      + '<td data-l="Status"><span class="da-tag" data-s="' + sTag + '">' + esc(overdue ? 'Overdue' : title(it.status)) + '</span></td>'
      + '<td class="da-num" data-l="Total">' + esc(money(it.total, cur)) + '</td>'
      + '<td class="da-num" data-l="Balance">' + esc(it.kind === 'payment' ? '—' : money(it.balance, cur)) + '</td>'
      + '<td class="da-num">' + (it.kind === 'invoice' && it.hasPdf ? '<button class="da-btn" data-v="ghost" data-pdf="' + esc(it.id) + '">PDF</button>' : '') + '</td></tr>';
  }
  function renderRows(more) {
    const body = root.querySelector('[data-rows]');
    if (!body) return;
    body.innerHTML = items.length ? items.map(rowHtml).join('') : '<tr><td colspan="8" class="da-muted" style="padding:22px;text-align:center">No activity matches these filters.</td></tr>';
    const m = root.querySelector('[data-more]'); if (m) { m.hidden = !cursor; m.disabled = false; m.textContent = 'Load more'; }
    void more;
  }
  async function loadActivity(append) {
    const q = new URLSearchParams();
    if (filters.type) q.set('type', filters.type);
    if (filters.from) q.set('from', filters.from);
    if (filters.to) q.set('to', filters.to);
    if (filters.search) q.set('search', filters.search);
    if (append && cursor) q.set('cursor', cursor);
    q.set('limit', '25');
    const page = await api('/statement/activity?' + q.toString());
    items = append ? items.concat(page.items) : page.items;
    cursor = page.nextCursor;
    renderRows(append);
  }

  async function statement() {
    wrap('<p class="da-muted">Loading your statement…</p>');
    let s;
    try { s = await api('/statement/summary'); } catch (e) { return fail(e.status); }
    cur = s.currency || 'USD';
    const over = parseFloat(s.overdue) > 0;
    wrap('<h2 style="margin-top:0">' + esc(s.customerName) + ' <span class="da-muted">· ' + esc(s.customerNumber) + '</span></h2>'
      + '<p class="da-muted">' + (s.paymentTerms ? 'Terms: ' + esc(s.paymentTerms) + ' · ' : '') + 'Figures as of ' + esc(stamp(s.asOf)) + (s.stale ? ' (refreshing)' : '') + '</p>'
      + '<div class="da-cards">'
      + '<div class="da-card"><span>Outstanding</span><strong>' + esc(money(s.outstanding, cur)) + '</strong></div>'
      + '<div class="da-card" data-tone="' + (over ? 'bad' : 'good') + '"><span>Overdue</span><strong>' + esc(money(s.overdue, cur)) + '</strong></div>'
      + '<div class="da-card"><span>Unused credits</span><strong>' + esc(money(s.unusedCredits, cur)) + '</strong></div>'
      + (s.creditLimit != null ? '<div class="da-card"><span>Credit limit</span><strong>' + esc(money(s.creditLimit, cur)) + '</strong></div>' : '')
      + '</div>'
      + '<div class="da-bar">'
      + '<button class="da-btn" data-stmt-pdf>Download statement (PDF)</button>'
      + '<a class="da-btn" data-v="ghost" style="text-decoration:none;display:inline-block" href="/pages/account-info">Account info</a></div>'
      + '<h2>Activity</h2>'
      + '<form class="da-bar" data-filters>'
      + '<label>Type<select name="type"><option value="">All</option><option value="invoice">Invoices</option><option value="payment">Payments</option><option value="credit_note">Credit notes</option><option value="sales_order">Sales orders</option></select></label>'
      + '<label>From<input type="date" name="from"></label><label>To<input type="date" name="to"></label>'
      + '<label>Search<input type="search" name="search" maxlength="60" placeholder="Number or reference"></label>'
      + '<button class="da-btn" type="submit">Apply</button></form>'
      + '<table class="da-table"><thead><tr><th>Type</th><th>Number</th><th>Date</th><th>Due</th><th>Status</th><th class="da-num">Total</th><th class="da-num">Balance</th><th></th></tr></thead><tbody data-rows></tbody></table>'
      + '<p style="text-align:center;margin:14px 0"><button class="da-btn" data-v="ghost" data-more hidden>Load more</button></p>');
    try { await loadActivity(false); } catch (e) { return fail(e.status); }

    root.querySelector('[data-filters]').addEventListener('submit', async ev => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      filters.type = f.get('type') || ''; filters.from = f.get('from') || ''; filters.to = f.get('to') || ''; filters.search = String(f.get('search') || '').trim();
      if (filters.from && filters.to && filters.from > filters.to) { const t = filters.from; filters.from = filters.to; filters.to = t; }
      try { await loadActivity(false); } catch (e) { fail(e.status); }
    });
    root.querySelector('[data-more]').addEventListener('click', async ev => {
      ev.target.disabled = true; ev.target.textContent = 'Loading…';
      try { await loadActivity(true); } catch (e) { fail(e.status); }
    });
    root.querySelector('[data-stmt-pdf]').addEventListener('click', ev => openPdf('/statement/pdf-link', { from: filters.from || undefined, to: filters.to || undefined }, ev.target));
    root.querySelector('[data-rows]').addEventListener('click', ev => {
      const b = ev.target.closest('[data-pdf]'); if (b) openPdf('/invoices/' + encodeURIComponent(b.getAttribute('data-pdf')) + '/pdf-link', {}, b);
    });
  }

  /* ------------------------------------------------------------------ account info */
  const addr = a => {
    if (!a) return '<p class="da-muted">None on file</p>';
    const l1 = [a.address1, a.address2].filter(Boolean).join(', ');
    const l2 = [a.city, [a.province, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return '<p>' + [l1, l2, a.country].filter(Boolean).map(esc).join('<br>') + '</p>' + (a.phone ? '<p class="da-muted">' + esc(a.phone) + '</p>' : '');
  };
  async function accountInfo() {
    wrap('<p class="da-muted">Loading your account…</p>');
    let a;
    try { a = await api('/account'); } catch (e) { return fail(e.status); }
    const cur = a.currency || 'USD';
    wrap('<h2 style="margin-top:0">' + esc(a.companyName) + ' <span class="da-muted">· ' + esc(a.customerNumber) + '</span></h2>'
      + '<div class="da-cards">'
      + '<div class="da-card"><span>Payment terms</span><strong style="font-size:1.1rem">' + esc(a.paymentTerms || '—') + '</strong></div>'
      + '<div class="da-card"><span>Credit limit</span><strong style="font-size:1.1rem">' + esc(a.creditLimit != null ? money(a.creditLimit, cur) : '—') + '</strong></div>'
      + '<div class="da-card"><span>Currency</span><strong style="font-size:1.1rem">' + esc(a.currency || '—') + '</strong></div></div>'
      + (a.zohoAsOf ? '<p class="da-muted">Terms and credit as of ' + esc(stamp(a.zohoAsOf)) + '</p>' : '')
      + '<p><a class="da-btn" data-v="ghost" style="text-decoration:none;display:inline-block" href="/pages/statement">View statement</a></p>'
      + '<h2>Locations</h2><div class="da-grid">'
      + (a.locations.length ? a.locations.map(l => '<div class="da-box"><h3>' + esc(l.name) + '</h3><p class="da-muted">Billing</p>' + addr(l.billingAddress) + '<p class="da-muted">Shipping</p>' + addr(l.shippingAddress) + '</div>').join('') : '<p class="da-muted">No locations on file.</p>')
      + '</div><h2>Contacts</h2>'
      + (a.contacts.length ? '<table class="da-table"><thead><tr><th>Name</th><th>Email</th><th>Title</th><th>Role</th></tr></thead><tbody>'
        + a.contacts.map(c => '<tr><td data-l="Name"><strong>' + esc(c.name || '—') + '</strong>' + (c.isMainContact ? ' <span class="da-tag">Main contact</span>' : '') + '</td><td data-l="Email">' + esc(c.email || '—') + '</td><td data-l="Title">' + esc(c.title || '—') + '</td><td data-l="Role">' + esc((c.roles || []).join(', ') || '—') + '</td></tr>').join('')
        + '</tbody></table>' : '<p class="da-muted">No contacts on file.</p>')
      + '<p class="da-muted" style="margin-top:18px">To change any of this, contact your DSG rep at (516) 249-8800.</p>');
  }

  function start() { return view === 'account-info' ? accountInfo() : statement(); }
  start();
})();
