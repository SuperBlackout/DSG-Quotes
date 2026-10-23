/* DSG: "Quote notifications" on the storefront (/pages/quote?tab=notifications). Same settings as the customer-account
   page (GET/PUT /apps/quotes/c/notification-prefs), reachable from the account menu. Signed-in dealers only. */
(() => {
  'use strict';
  const root = document.querySelector('[data-mq]');
  if (!root || new URLSearchParams(location.search).get('tab') !== 'notifications') return;
  const BASE = '/apps/quotes';
  // Verbatim: this is the wording recorded with the opt-in (A2P 10DLC campaign). Change only together with the campaign and extensions/my-quotes/src/lib/consent.ts.
  const CONSENT = 'I agree to receive quote alerts by text from DSG Distributors. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.';
  const EVENTS = [
    ['QUOTE_RECEIVED', 'Quote received', 'Confirmation after you submit a quote', true],
    ['QUOTE_READY', 'Quote ready', 'Sales sent new or revised pricing to review', true],
    ['NEW_MESSAGE', 'New message', 'A message or question from sales. Messages within 5 minutes are bundled into one alert', true],
    ['EXPIRING', 'Expiring soon', 'Reminder 3 days before held prices lapse', true],
    ['ORDERED', 'Ordered', 'Order confirmation after you buy from a quote', true],
    ['ACCEPTED', 'Accepted', 'Confirmation when a quote is accepted', true],
    ['WEEKLY_SUMMARY', 'Weekly summary', 'Open quotes digest, Mondays 8:00 AM', false]
  ];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const toE164 = v => { const t = String(v || '').trim(), d = t.replace(/\D/g, ''); if (!t) return null; if (t[0] === '+') return d.length >= 8 && d.length <= 15 ? '+' + d : null; if (d.length === 10) return '+1' + d; if (d.length === 11 && d[0] === '1') return '+' + d; return null; };
  const pretty = e => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e || ''); return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : (e || ''); };
  const hh = v => { const [h, m] = v.split(':').map(Number); return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM'); };
  const TIMES = []; for (let h = 0; h < 24; h++) for (const m of ['00', '30']) TIMES.push(String(h).padStart(2, '0') + ':' + m);
  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; } catch (e) { return 'America/New_York'; } };

  const style = document.createElement('style');
  style.textContent = `
.mn{display:grid;gap:20px}.mn h3{margin:0 0 4px}.mn p{margin:0}
.mn-card{border:1px solid var(--line,#d9dee5);border-radius:10px;padding:18px;display:grid;gap:12px;background:#fff}
.mn-grid{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:20px;align-items:start}
.mn-ev{display:grid;grid-template-columns:minmax(0,1fr) 4.5rem 4.5rem;gap:8px 12px;align-items:center}
.mn-ev .h{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#5b6773);font-weight:600}
.mn-ev .row{display:contents}.mn-ev .row>*{padding-top:10px;border-top:1px solid var(--line,#d9dee5)}
.mn-ev small,.mn small{color:var(--muted,#5b6773)}
.mn-ev input[type=checkbox],.mn-consent input{width:20px;height:20px}
.mn-f{display:grid;gap:4px;font-weight:600;font-size:.9rem}.mn-f .input{font-weight:400}
.mn-consent{display:flex;gap:10px;align-items:flex-start;background:#f3f5f8;border-radius:8px;padding:12px;font-size:.9rem}
.mn-err{color:#b3261e;font-size:.85rem;font-weight:600}
.mn-banner{border-radius:8px;padding:12px 14px}.mn-banner.ok{background:#e8f6ec;color:#14532d}.mn-banner.bad{background:#fdecea;color:#7f1d1d}
.mn-w{display:flex;justify-content:space-between;gap:10px;align-items:center;background:#f3f5f8;border-radius:8px;padding:10px 12px}
.mn-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.mn-tabs{display:flex;gap:6px;margin:0 0 16px;border-bottom:1px solid var(--line,#d9dee5)}
.mn-tabs a{padding:10px 14px;text-decoration:none;color:inherit;border-bottom:3px solid transparent;font-weight:600}
.mn-tabs a[aria-current=page]{border-color:#2f6ea8;color:#2f6ea8}
@media(max-width:820px){.mn-grid{grid-template-columns:1fr}.mn-row2{grid-template-columns:1fr}.mn-ev{grid-template-columns:minmax(0,1fr) 3.5rem 3.5rem}}`;
  document.head.appendChild(style);

  async function call(method, path, body) {
    let res;
    try { res = await fetch(BASE + path, { method, credentials: 'same-origin', headers: Object.assign({ Accept: 'application/json' }, body === undefined ? {} : { 'Content-Type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { const er = new Error('We could not reach the server. Check your connection and try again.'); er.status = 0; throw er; }
    const t = await res.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { /* not json */ }
    if (!res.ok) { const er = new Error((d && d.message) || 'Something went wrong. Please try again.'); er.status = res.status; throw er; }
    return d;
  }
  const fatal = err => {
    if (err && err.status === 401) { location.href = '/account/login?return_url=' + encodeURIComponent(location.pathname + location.search); return; }
    root.innerHTML = '<p class="mq-error" role="alert">' + esc(err && err.status === 403 ? 'Notification settings are available to approved dealer accounts. Contact DSG to get set up.' : (err && err.message) || 'We could not load your settings.') + '</p>';
  };

  let P = null, jobs = [], draft = { name: '', role: '', email: '', scope: 'all', email_on: true, sms_on: false }, errors = {}, banner = null, saving = false, touchedWatcher = false;

  const scopeOpts = sel => '<option value="all"' + (sel === 'all' ? ' selected' : '') + '>All quotes</option>' + jobs.map(j => '<option value="' + esc(j.id) + '"' + (sel === j.id ? ' selected' : '') + '>Job: ' + esc(j.name) + '</option>').join('')
    + (sel !== 'all' && !jobs.some(j => j.id === sel) ? '<option value="' + esc(sel) + '" selected>A specific job</option>' : '');
  const scopeLabel = s => s === 'all' ? 'All quotes' : ((jobs.find(j => j.id === s) || {}).name ? 'Job: ' + jobs.find(j => j.id === s).name : 'A specific job');
  const timeOpts = sel => TIMES.concat(TIMES.includes(sel) ? [] : [sel]).map(t => '<option value="' + t + '"' + (t === sel ? ' selected' : '') + '>' + hh(t) + '</option>').join('');

  function render() {
    const smsAny = EVENTS.some(e => e[3] && P.events[e[0]].sms);
    let h = '<div class="mn">';
    if (banner) h += '<div class="mn-banner ' + banner.k + '" role="' + (banner.k === 'ok' ? 'status' : 'alert') + '">' + esc(banner.t) + '</div>';
    h += '<p class="t-small">Choose what you hear about and how. Replying to any alert email or text posts straight into that quote’s conversation.</p><div class="mn-grid"><div style="display:grid;gap:20px">';
    h += '<section class="mn-card"><h3>When should we alert you?</h3><div class="mn-ev"><span class="h">Event</span><span class="h">Email</span><span class="h">Text</span>';
    EVENTS.forEach(([k, t, d, sms]) => {
      h += '<div class="row"><span><strong>' + t + '</strong><br><small>' + d + '</small></span><span><input type="checkbox" data-ev="' + k + '" data-ch="email" aria-label="Email: ' + t + '"' + (P.events[k].email ? ' checked' : '') + '></span><span>' + (sms ? '<input type="checkbox" data-ev="' + k + '" data-ch="sms" aria-label="Text: ' + t + '"' + (P.events[k].sms ? ' checked' : '') + '>' : '<small aria-hidden="true">—</small>') + '</span></div>';
    });
    h += '</div></section>';

    h += '<section class="mn-card"><div><h3>Also notify</h3><small>Teammates who follow your quotes get the alerts you choose for them, for all quotes or one job. They can read and reply, not accept. Texts to a teammate also need their own opt-in.</small></div>';
    if (!P.watchers.length) h += '<small>No one added yet.</small>';
    P.watchers.forEach((w, i) => {
      h += '<div class="mn-w"><span><strong>' + esc(w.name || w.email) + '</strong><br><small>' + esc((w.name ? w.email + ' · ' : '') + (w.role ? w.role + ' · ' : '') + scopeLabel(w.scope) + ' · ' + [w.channels.email ? 'Email' : '', w.channels.sms ? 'Text' : ''].filter(Boolean).join(' + ')) + '</small></span><button type="button" class="btn btn--tertiary btn--sm" data-rm="' + i + '" aria-label="Remove ' + esc(w.email) + '">Remove</button></div>';
    });
    if (errors.watchers) h += '<div class="mn-err">' + esc(errors.watchers) + '</div>';
    h += '<hr style="border:0;border-top:1px solid var(--line,#d9dee5);width:100%"><strong>Add a teammate</strong><div class="mn-row2"><label class="mn-f">Name<input class="input" data-d="name" placeholder="Sam Lee" value="' + esc(draft.name) + '"></label><label class="mn-f">Role<input class="input" data-d="role" placeholder="Project manager" value="' + esc(draft.role) + '"></label></div>'
      + '<label class="mn-f">Email<input class="input" data-d="email" type="email" placeholder="sam@example.com" value="' + esc(draft.email) + '"></label>' + (touchedWatcher && errors.draft ? '<div class="mn-err">' + esc(errors.draft) + '</div>' : '')
      + '<label class="mn-f">Follows<select class="input" data-d="scope">' + scopeOpts(draft.scope) + '</select></label>'
      + '<div style="display:flex;gap:16px"><label><input type="checkbox" data-dc="email_on"' + (draft.email_on ? ' checked' : '') + '> Email</label><label><input type="checkbox" data-dc="sms_on"' + (draft.sms_on ? ' checked' : '') + '> Text</label></div>'
      + '<div><button type="button" class="btn btn--secondary btn--sm" data-add>+ Add person</button></div></section></div>';

    h += '<div style="display:grid;gap:20px"><section class="mn-card"><h3>Where to reach you</h3>'
      + '<label class="mn-f">Email<input class="input" data-p="email" type="email" value="' + esc(P.email) + '"></label>' + (errors.email ? '<div class="mn-err">' + esc(errors.email) + '</div>' : '')
      + '<label class="mn-f">Mobile for texts<input class="input" data-p="phoneRaw" type="tel" autocomplete="tel" value="' + esc(P.phoneRaw) + '"></label>' + (errors.phone ? '<div class="mn-err">' + esc(errors.phone) + '</div>' : '')
      + '<label class="mn-consent"><input type="checkbox" data-p="smsOptIn"' + (P.smsOptIn ? ' checked' : '') + '><span>' + esc(CONSENT) + '<br><small><a href="/policies/terms-of-service" target="_blank" rel="noopener">Terms</a> · <a href="/policies/privacy-policy" target="_blank" rel="noopener">Privacy</a></small></span></label>'
      + (errors.smsOptIn ? '<div class="mn-err">' + esc(errors.smsOptIn) + '</div>' : '')
      + (P.smsOptInAt && P.smsOptIn ? '<small style="color:#14532d">✓ Number confirmed ' + esc(new Date(P.smsOptInAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) + '</small>' : '')
      + (!P.smsOptIn && smsAny ? '<small style="color:#6b4a00">Texts stay off until you agree above.</small>' : '') + '</section>'
      + '<section class="mn-card"><h3>Quiet hours for texts</h3><label><input type="checkbox" data-p="quiet"' + (P.quiet ? ' checked' : '') + '> Quiet hours</label>'
      + (P.quiet ? '<div class="mn-row2"><label class="mn-f">From<select class="input" data-p="quietStart">' + timeOpts(P.quietStart) + '</select></label><label class="mn-f">Until<select class="input" data-p="quietEnd">' + timeOpts(P.quietEnd) + '</select></label></div>' : '')
      + '<small>Texts during quiet hours wait until morning. Email still arrives.</small></section>'
      + '<button type="button" class="btn btn--primary" data-save' + (saving ? ' disabled' : '') + '>' + (saving ? 'Saving…' : 'Save settings') + '</button></div></div></div>';
    root.innerHTML = h;
  }

  function fromServer(p) {
    const events = {}; EVENTS.forEach(([k, , , sms]) => { const c = (p.events || {})[k] || {}; events[k] = { email: !!c.email, sms: sms ? !!c.sms : false }; });
    return { events, email: p.email || '', phoneRaw: pretty(p.phone), smsOptIn: !!p.smsOptIn, smsOptInAt: p.smsOptInAt || null, quiet: !!(p.quietStart && p.quietEnd), quietStart: p.quietStart || '19:00', quietEnd: p.quietEnd || '07:00', timezone: p.timezone || tz(),
      watchers: (p.watchers || []).map(w => ({ email: w.email, name: w.name || '', role: w.role || '', scope: w.scope || 'all', channels: { email: !!(w.channels && w.channels.email), sms: !!(w.channels && w.channels.sms) } })) };
  }
  const watcherKey = w => w.email.trim().toLowerCase() + '|' + w.scope;
  function validate() {
    const e = {};
    if (!EMAIL_RE.test(P.email.trim())) e.email = 'Enter a valid email address.';
    const smsAny = EVENTS.some(x => x[3] && P.events[x[0]].sms);
    if ((P.smsOptIn || smsAny) && !toE164(P.phoneRaw)) e.phone = 'Enter a valid mobile number to get texts.';
    if (smsAny && !P.smsOptIn) e.smsOptIn = 'Agree to the text message terms to turn on texts.';
    const seen = new Set(); P.watchers.forEach(w => { const k = watcherKey(w); if (seen.has(k)) e.watchers = w.email + ' is listed twice for the same scope.'; seen.add(k); });
    return e;
  }
  function draftError() {
    if (!EMAIL_RE.test(draft.email.trim())) return '“' + draft.email + '” is not a valid email address.';
    if (!draft.email_on && !draft.sms_on) return 'Pick email or text for ' + draft.email + '.';
    if (P.watchers.some(w => watcherKey(w) === watcherKey({ email: draft.email, scope: draft.scope }))) return draft.email.trim() + ' is already listed for that scope.';
    return null;
  }
  async function save() {
    errors = validate(); banner = null;
    if (Object.keys(errors).length) { banner = { k: 'bad', t: 'Fix the highlighted fields and save again.' }; return render(); }
    saving = true; render();
    const events = {}; EVENTS.forEach(([k]) => { events[k] = { email: P.events[k].email, sms: P.events[k].sms }; });
    const body = { events, email: P.email.trim(), phone: toE164(P.phoneRaw), smsOptIn: P.smsOptIn, quietStart: P.quiet ? P.quietStart : null, quietEnd: P.quiet ? P.quietEnd : null, timezone: P.timezone,
      watchers: P.watchers.map(w => { const o = { email: w.email.trim(), scope: w.scope || 'all', channels: w.channels }; if (w.name.trim()) o.name = w.name.trim(); if (w.role.trim()) o.role = w.role.trim(); return o; }) };
    if (P.smsOptIn) body.smsConsentText = CONSENT;
    try { P = fromServer(await call('PUT', '/c/notification-prefs', body)); banner = { k: 'ok', t: 'Settings saved.' }; if (window.DSGUI && window.DSGUI.toast) window.DSGUI.toast('Settings saved'); }
    catch (err) { if (err.status === 401) return fatal(err); banner = { k: 'bad', t: err.message }; }
    saving = false; render(); root.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  root.addEventListener('change', e => {
    const t = e.target;
    if (!P) return;
    if (t.dataset.ev) { P.events[t.dataset.ev][t.dataset.ch] = t.checked; banner = null; return render(); }
    if (t.dataset.dc) { draft[t.dataset.dc] = t.checked; return; }
    if (t.dataset.d) { draft[t.dataset.d] = t.value; return; }
    if (t.dataset.p) { const k = t.dataset.p; P[k] = t.type === 'checkbox' ? t.checked : t.value; if (k === 'quiet' || k === 'smsOptIn') { errors = Object.assign({}, errors, { smsOptIn: undefined }); render(); } }
  });
  root.addEventListener('input', e => { const t = e.target; if (!P) return; if (t.dataset.d && t.type !== 'checkbox') draft[t.dataset.d] = t.value; else if (t.dataset.p && t.type !== 'checkbox' && t.tagName !== 'SELECT') P[t.dataset.p] = t.value; });
  root.addEventListener('click', e => {
    if (e.target.closest('[data-save]')) return save();
    if (e.target.closest('[data-add]')) { touchedWatcher = true; errors.draft = draftError(); if (errors.draft) return render(); P.watchers.push({ email: draft.email.trim(), name: draft.name.trim(), role: draft.role.trim(), scope: draft.scope, channels: { email: draft.email_on, sms: draft.sms_on } }); draft = { name: '', role: '', email: '', scope: 'all', email_on: true, sms_on: false }; touchedWatcher = false; errors.draft = null; banner = { k: 'ok', t: 'Person added. Save settings to keep the change.' }; return render(); }
    const rm = e.target.closest('[data-rm]'); if (rm) { P.watchers.splice(+rm.dataset.rm, 1); banner = { k: 'ok', t: 'Person removed. Save settings to keep the change.' }; render(); }
  });

  async function loadJobs() {
    const m = new Map(); let cursor;
    for (let i = 0; i < 10; i++) { const r = await call('GET', '/c/quotes?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')); (r.items || []).forEach(q => { if (q.job && !m.has(q.job.id)) m.set(q.job.id, { id: q.job.id, name: q.job.name }); }); if (!r.nextCursor) break; cursor = r.nextCursor; }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  root.innerHTML = '<p class="t-small" role="status">Loading your settings…</p>';
  Promise.all([call('GET', '/c/notification-prefs'), loadJobs().catch(() => [])]).then(([p, j]) => { P = fromServer(p); jobs = j; render(); }).catch(fatal);
})();
