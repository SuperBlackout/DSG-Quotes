/* DSG Quotes - "Move cart to quote" block (cart template). Mockup screen 2. */
(function (root) {
  'use strict';
  var Q = root.DSGQuotes;
  if (!Q) return;
  var el = Q.el;

  function money(cents, cur) {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format((cents || 0) / 100); }
    catch (e) { return '$' + ((cents || 0) / 100).toFixed(2); }
  }

  function field(label, input, cls) {
    return el('label', { class: 'dsg-field' + (cls ? ' ' + cls : '') }, [label, input]);
  }

  function init(host) {
    var base = Q.data(host, 'base', Q.DEFAULT_BASE);
    var currency = Q.data(host, 'currency', 'USD');
    var myQuotesUrl = Q.data(host, 'my-quotes-url', '/account');
    var heading = Q.data(host, 'heading', 'Need better pricing? Move cart to a quote');
    var sub = Q.data(host, 'subheading', 'Sales reviews it and replies, usually same business day.');
    var mode = 'new';
    var drafts = null;
    var busy = false;
    var uid = Q.uid('dsg-mc');

    var modeName = uid + '-mode';
    var rNew = el('input', { type: 'radio', name: modeName, value: 'new', checked: true });
    var rExisting = el('input', { type: 'radio', name: modeName, value: 'existing' });
    var optNew = el('label', { class: 'dsg-seg is-selected' }, [rNew, 'New quote']);
    var optExisting = el('label', { class: 'dsg-seg' }, [rExisting, 'Add to a draft']);
    var segs = el('fieldset', { class: 'dsg-segs' }, [el('legend', { class: 'dsg-legend', text: 'Where should this cart go?' }), optNew, optExisting]);

    var jobId = uid + '-job';
    var job = el('input', { type: 'text', id: jobId, autocomplete: 'off', placeholder: 'e.g. Smith warehouse cameras', 'aria-required': 'true', 'aria-describedby': jobId + '-err' });
    var jobError = el('span', { class: 'dsg-field__error', id: jobId + '-err', hidden: true });
    var jobField = el('div', { class: 'dsg-field' }, [
      el('label', { for: jobId }, ['Job or quote name ', el('span', { class: 'dsg-req', 'aria-hidden': 'true', text: '*' }), el('span', { class: 'dsg-sr', text: ' (required)' })]),
      job, jobError
    ]);
    var select = el('select', { id: uid + '-draft', 'aria-label': 'Existing draft quote' });
    var selectField = el('div', { class: 'dsg-field' }, [el('label', { for: uid + '-draft', text: 'Draft quote' }), select]);
    selectField.hidden = true;
    var poId = uid + '-po';
    var po = el('input', { type: 'text', id: poId, autocomplete: 'off', placeholder: 'Your PO #' });
    var neededId = uid + '-needed';
    var needed = el('input', { type: 'date', id: neededId });
    var today = new Date();
    needed.setAttribute('min', today.getFullYear() + '-' + ('0' + (today.getMonth() + 1)).slice(-2) + '-' + ('0' + today.getDate()).slice(-2));
    var noteId = uid + '-note';
    var note = el('textarea', { id: noteId, rows: '3', placeholder: 'e.g. Competing bid, need delivery to the job site by Friday' });
    var empty = el('input', { type: 'checkbox', checked: true, id: uid + '-empty' });
    var itemsLine = el('div', { class: 'dsg-sum__items', 'aria-live': 'polite' });
    var totalLine = el('div', { class: 'dsg-sum__total' });
    var error = el('div', { class: 'dsg-error', role: 'alert', hidden: true });
    var status = el('div', { class: 'dsg-status', role: 'status', 'aria-live': 'polite' });
    var draftBtn = el('button', { type: 'button', class: 'dsg-btn dsg-btn--secondary', text: 'Save as draft' });
    var submitBtn = el('button', { type: 'button', class: 'dsg-btn dsg-btn--primary', text: 'Send to sales' });

    var steps = el('ol', { class: 'dsg-steps' }, [
      el('li', { text: 'Sales reviews your cart and prices the quote, usually the same business day.' }),
      el('li', { text: 'You get an email (or text) and can reply right on the quote.' }),
      el('li', { text: 'Accept it, then check out at the quoted prices.' })
    ]);

    var fields = el('div', { class: 'dsg-mc__fields' }, [
      segs, jobField, selectField,
      el('div', { class: 'dsg-row' }, [
        el('div', { class: 'dsg-field dsg-field--half' }, [el('label', { for: poId }, ['PO number ', el('span', { class: 'dsg-opt-label', text: '(optional)' })]), po]),
        el('div', { class: 'dsg-field dsg-field--half' }, [el('label', { for: neededId }, ['Needed by ', el('span', { class: 'dsg-opt-label', text: '(optional)' })]), needed])
      ]),
      el('div', { class: 'dsg-field' }, [el('label', { for: noteId }, ['Note to sales ', el('span', { class: 'dsg-opt-label', text: '(optional)' })]), note])
    ]);
    var side = el('aside', { class: 'dsg-mc__side', 'aria-label': 'Quote summary' }, [
      el('div', { class: 'dsg-sum' }, [el('div', { class: 'dsg-sum__label', text: 'Your cart' }), itemsLine, totalLine]),
      el('div', { class: 'dsg-next' }, [el('div', { class: 'dsg-sum__label', text: 'What happens next' }), steps]),
      el('label', { class: 'dsg-check' }, [empty, 'Clear my cart once it is moved']),
      error, status,
      el('div', { class: 'dsg-actions' }, [submitBtn, draftBtn]),
      el('p', { class: 'dsg-note', text: 'A draft stays private until you send it. You can edit it anytime in My quotes.' })
    ]);
    var form = el('div', { class: 'dsg-card dsg-mc__form' }, [
      el('div', { class: 'dsg-mc__head' }, [
        el('span', { class: 'dsg-mc__icon', 'aria-hidden': 'true' }),
        el('span', {}, [el('h2', { class: 'dsg-mc__title', text: heading }), el('span', { class: 'dsg-mc__sub', text: sub })])
      ]),
      el('div', { class: 'dsg-mc__grid' }, [fields, side])
    ]);
    host.textContent = '';
    host.appendChild(form);
    host.setAttribute('aria-label', 'Move cart to quote');

    function setBusy(b) {
      busy = b;
      [draftBtn, submitBtn].forEach(function (x) { x.disabled = b; });
      form.setAttribute('aria-busy', b ? 'true' : 'false');
    }
    function showError(msg, focusEl) {
      var inline = focusEl === job;
      error.textContent = inline ? '' : (msg || '');
      error.hidden = inline || !msg;
      jobError.textContent = inline ? (msg || '') : '';
      jobError.hidden = !(inline && msg);
      if (!msg) job.removeAttribute('aria-invalid');
      if (msg && focusEl) focusEl.focus();
    }

    function setMode(m) {
      mode = m;
      optNew.classList.toggle('is-selected', m === 'new');
      optExisting.classList.toggle('is-selected', m === 'existing');
      jobField.hidden = m !== 'new';
      selectField.hidden = m !== 'existing';
      showError('');
      if (m === 'existing' && !drafts) loadDrafts();
    }
    rNew.addEventListener('change', function () { setMode('new'); });
    rExisting.addEventListener('change', function () { setMode('existing'); });

    function loadDrafts() {
      select.textContent = '';
      select.appendChild(el('option', { value: '', text: 'Loading…' }));
      select.disabled = true;
      Q.api('GET', '/c/quotes?status=DRAFT&limit=100', undefined, base).then(function (r) {
        drafts = (r.items || []).filter(function (q) { return q.status === 'DRAFT'; });
        select.textContent = '';
        select.disabled = false;
        if (!drafts.length) {
          select.appendChild(el('option', { value: '', text: 'No draft quotes yet' }));
          select.disabled = true;
          showError('You have no draft quotes. Choose "New quote" instead.');
          return;
        }
        drafts.forEach(function (q) {
          select.appendChild(el('option', { value: q.id, text: Q.quoteTitle(q) + ' (' + Q.quoteMeta(q, currency) + ')' }));
        });
        Q.api('GET', '/c/active-quote', undefined, base).then(function (a) {
          if (a && a.quoteId && drafts.some(function (q) { return q.id === a.quoteId; })) select.value = a.quoteId;
        }).catch(function () {});
      }).catch(function (err) {
        drafts = null;
        select.textContent = '';
        select.appendChild(el('option', { value: '', text: 'Could not load quotes' }));
        showError(err.message);
      });
    }

    function readCart() {
      return Promise.resolve().then(function () {
        return root.fetch('/cart.js', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      }).then(function (res) {
        if (!res.ok) throw new Q.ApiError(res.status, 'CART', 'We could not read your cart. Refresh the page and try again.');
        return res.json();
      }, function () {
        throw new Q.ApiError(0, 'NETWORK', 'We could not read your cart. Check your connection and try again.');
      });
    }

    function refreshSummary() {
      return readCart().then(function (cart) {
        var n = cart.item_count || 0;
        itemsLine.textContent = n ? n + (n === 1 ? ' item' : ' items') + ' will be copied to the quote' : 'Your cart is empty';
        totalLine.textContent = n ? money(cart.total_price, cart.currency || currency) + ' at today\'s prices' : '';
        totalLine.hidden = !n;
        draftBtn.disabled = submitBtn.disabled = !n;
        return cart;
      }).catch(function () { return null; });
    }

    function go(submit) {
      if (busy) return;
      showError('');
      var existing = mode === 'existing';
      if (!existing && !job.value.trim()) {
        job.setAttribute('aria-invalid', 'true');
        return showError('Enter a job name for the new quote.', job);
      }
      if (existing && !select.value) return showError('Choose a draft quote to add to.', select);
      job.removeAttribute('aria-invalid');
      setBusy(true);
      status.textContent = submit ? 'Submitting to sales…' : 'Saving draft…';

      var shouldEmpty = empty.checked;
      var poV = po.value.trim();
      var neededV = needed.value;
      var noteV = note.value.trim();

      readCart().then(function (cart) {
        var lines = (cart.items || []).map(function (i) { return { variantId: Q.gid(i.variant_id), qty: i.quantity }; });
        if (!lines.length) throw new Q.ApiError(0, 'EMPTY_CART', 'Your cart is empty, so there is nothing to move.');
        var target;
        if (!existing) {
          target = { mode: 'new', title: job.value.trim(), newJob: Object.assign({ name: job.value.trim() }, poV ? { poNumber: poV } : {}) };
        } else {
          target = { mode: 'existing', quoteId: select.value };
        }
        // contract 0.2.0: both modes carry the optional header fields; on an existing draft the API
        // overwrites a field only when it is present, so an untouched note is never wiped.
        if (poV) target.poNumber = poV;
        if (neededV) target.neededBy = neededV;
        if (noteV) target.notesToSales = noteV;
        // emptyCart is informational only; the cart is cleared client-side after the 2xx below.
        return Q.api('POST', '/c/quotes/from-cart', { cartLines: lines, target: target, submit: !!submit, emptyCart: shouldEmpty }, base);
      }).then(function (quote) {
        var after = shouldEmpty
          ? root.fetch('/cart/clear.js', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } })
              .then(function (r) { return r.ok; }, function () { return false; })
          : Promise.resolve(true);
        return after.then(function (cleared) {
          var keep = submit ? Promise.resolve() : Q.api('PUT', '/c/active-quote', { quoteId: quote.id }, base).catch(function () {});
          return keep.then(function () { done(quote, submit, shouldEmpty, cleared); });
        });
      }).catch(function (err) {
        setBusy(false);
        status.textContent = '';
        if (Q.isAuthError(err)) {
          showError('Your session has expired. Sign in again to move your cart to a quote.');
          return;
        }
        showError(err.message);
        refreshSummary();
      });
    }

    function done(quote, submitted, emptied, cleared) {
      Q.emitActive(submitted ? {} : { quoteId: quote.id, number: quote.number, title: quote.title, lineCount: quote.lineCount });
      var label = (quote.displayNumber || 'Q-' + quote.number) + ' · ' + Q.quoteTitle(quote);
      var back = el('button', { type: 'button', class: 'dsg-btn dsg-btn--secondary', text: emptied && cleared ? 'Back to cart' : 'Refresh cart' });
      back.addEventListener('click', function () { root.location.reload(); });
      var view = el('a', { class: 'dsg-btn dsg-btn--primary', href: Q.quotesUrl(myQuotesUrl, quote.id), text: 'View quote' });
      var msg = submitted
        ? 'A rep will price it, usually the same business day. We will email you (and text, if you have turned texts on) when it is ready.'
        : 'It stays private until you send it. Open it anytime from My quotes to add items or send it to sales.';
      var warn = emptied && !cleared ? el('div', { class: 'dsg-error', role: 'alert', text: 'Your quote was saved, but we could not empty your cart. You can remove the items yourself.' }) : null;
      host.textContent = '';
      var card = el('div', { class: 'dsg-card dsg-mc__done' }, [
        el('span', { class: 'dsg-mc__check', 'aria-hidden': 'true', text: '✓' }),
        el('div', { class: 'dsg-mc__done-body' }, [
          el('h2', { class: 'dsg-mc__title', text: submitted ? 'Sent to sales' : 'Draft saved' }),
          el('p', { class: 'dsg-mc__label', text: label }),
          el('p', { class: 'dsg-status', role: 'status', 'aria-live': 'polite', text: msg }),
          warn,
          el('div', { class: 'dsg-actions' }, [view, back])
        ])
      ]);
      host.appendChild(card);
      view.focus();
    }

    draftBtn.addEventListener('click', function () { go(false); });
    submitBtn.addEventListener('click', function () { go(true); });
    job.addEventListener('input', function () { job.removeAttribute('aria-invalid'); });
    refreshSummary();
  }

  Q.initMoveCart = init;
  Q.mount('[data-dsg-move-cart]', init);
})(typeof window !== 'undefined' ? window : this);
