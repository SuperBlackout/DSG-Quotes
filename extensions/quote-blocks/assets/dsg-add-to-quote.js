/* DSG Quotes - "Add to Quote" block (PDP and collection card). Mockup screen 1. */
(function (root) {
  'use strict';
  var Q = root.DSGQuotes;
  if (!Q) return;
  var el = Q.el;

  function init(host) {
    var base = Q.data(host, 'base', Q.DEFAULT_BASE);
    var currency = Q.data(host, 'currency', 'USD');
    var myQuotesUrl = Q.data(host, 'my-quotes-url', '/account');
    var loginUrl = Q.data(host, 'login-url', '/account/login');
    var productTitle = Q.data(host, 'product-title', 'this item');
    var isCard = Q.data(host, 'context', 'pdp') === 'card';
    var trigger = host.querySelector('[data-dsg-trigger]');
    var pop = host.querySelector('[data-dsg-popover]');
    if (!trigger || !pop) return; // logged-out markup has no popover

    var titleId = Q.uid('dsg-pop-title');
    var s = { open: false, quotes: [], selected: null, job: '', po: '', busy: false, added: false, loaded: false };
    var release = null;
    var refs = {};

    function readVariant() {
      if (!isCard) {
        var f = root.document.querySelector('form[action*="/cart/add"] [name="id"]');
        if (f && f.value) return f.value;
        var m = /[?&]variant=(\d+)/.exec(root.location.search || '');
        if (m) return m[1];
      }
      return Q.data(host, 'variant-id', '');
    }
    function readQty() {
      if (isCard) return 1;
      var f = root.document.querySelector('form[action*="/cart/add"] [name="quantity"]');
      var n = f ? parseInt(f.value, 10) : 1;
      return n > 0 ? n : 1;
    }

    function setOpen(open) {
      s.open = open;
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      pop.hidden = !open;
      if (open) {
        release = Q.trapFocus(pop, function () { setOpen(false); trigger.focus(); });
        root.document.addEventListener('mousedown', outside, true);
        load();
      } else {
        if (release) release();
        release = null;
        root.document.removeEventListener('mousedown', outside, true);
      }
    }
    function outside(e) { if (!host.contains(e.target)) setOpen(false); }

    function showError(msg, focusEl) {
      if (!refs.error) return;
      refs.error.textContent = msg || '';
      refs.error.hidden = !msg;
      if (msg && focusEl) focusEl.focus();
    }
    function showStatus(msg) { if (refs.status) refs.status.textContent = msg || ''; }

    function signInPrompt() {
      pop.textContent = '';
      pop.appendChild(el('div', { class: 'dsg-pop__body' }, [
        el('strong', { id: titleId, text: 'Sign in to request a quote' }),
        el('p', { class: 'dsg-note', text: 'Quotes use your dealer pricing. Sign in to continue.' }),
        el('a', { class: 'dsg-btn dsg-btn--primary', href: loginUrl, text: 'Sign in' })
      ]));
      pop.setAttribute('aria-labelledby', titleId);
    }

    function load() {
      if (s.loaded && !s.added) return;
      s.added = false;
      pop.textContent = '';
      pop.setAttribute('aria-labelledby', titleId);
      pop.appendChild(el('div', { class: 'dsg-pop__body' }, [
        el('strong', { id: titleId, text: 'Loading your quotes…' }),
        el('div', { class: 'dsg-status', role: 'status', 'aria-live': 'polite' })
      ]));
      Promise.all([
        Q.api('GET', '/c/quotes?status=DRAFT&limit=100', undefined, base),
        Q.api('GET', '/c/active-quote', undefined, base).catch(function () { return { quoteId: null }; })
      ]).then(function (r) {
        s.quotes = (r[0].items || []).filter(function (q) { return q.status === 'DRAFT'; });
        var active = r[1] && r[1].quoteId;
        s.selected = s.quotes.some(function (q) { return q.id === active; }) ? active : (s.quotes[0] ? s.quotes[0].id : 'new');
        s.loaded = true;
        build();
        refs.first && refs.first.focus();
      }).catch(function (err) {
        if (Q.isAuthError(err)) return signInPrompt();
        pop.textContent = '';
        s.loaded = false;
        pop.appendChild(el('div', { class: 'dsg-pop__body' }, [
          el('strong', { id: titleId, text: 'Add to quote' }),
          el('div', { class: 'dsg-error', role: 'alert', text: err.message }),
          el('button', { type: 'button', class: 'dsg-btn dsg-btn--secondary', text: 'Try again', onclick: load })
        ]));
      });
    }

    function build() {
      var qty = readQty();
      var name = Q.uid('dsg-q');
      pop.textContent = '';
      var radios = {};
      var group = el('div', { class: 'dsg-list', role: 'radiogroup', 'aria-labelledby': titleId });

      s.quotes.forEach(function (q) {
        var input = el('input', { type: 'radio', name: name, value: q.id, checked: s.selected === q.id });
        input.addEventListener('change', function () { select(q.id); });
        radios[q.id] = input;
        group.appendChild(el('label', { class: 'dsg-opt' + (s.selected === q.id ? ' is-selected' : '') }, [
          input,
          el('span', { class: 'dsg-opt__main' }, [
            el('strong', { text: Q.quoteTitle(q) }),
            el('span', { class: 'dsg-opt__meta', text: Q.quoteMeta(q, currency) })
          ]),
          el('span', { class: 'dsg-pill', text: 'Draft' })
        ]));
      });

      var newRadio = el('input', { type: 'radio', name: name, value: 'new', checked: s.selected === 'new' });
      newRadio.addEventListener('change', function () { select('new'); });
      radios['new'] = newRadio;
      var jobId = Q.uid('dsg-job');
      var poId = Q.uid('dsg-po');
      var job = el('input', { id: jobId, type: 'text', 'aria-label': 'Job name', placeholder: 'Job name', value: s.job, autocomplete: 'off' });
      var po = el('input', { id: poId, type: 'text', 'aria-label': 'PO number (optional)', placeholder: 'PO # (optional)', value: s.po, autocomplete: 'off' });
      job.addEventListener('input', function () { s.job = job.value; job.removeAttribute('aria-invalid'); });
      po.addEventListener('input', function () { s.po = po.value; });
      [job, po].forEach(function (i) { i.addEventListener('focus', function () { if (s.selected !== 'new') { newRadio.checked = true; select('new'); } }); });
      group.appendChild(el('label', { class: 'dsg-opt dsg-opt--new' + (s.selected === 'new' ? ' is-selected' : '') }, [
        newRadio,
        el('span', { class: 'dsg-opt__main' }, [
          el('strong', { text: 'Start a new quote' }),
          el('span', { class: 'dsg-row' }, [job, po])
        ])
      ]));

      var status = el('div', { class: 'dsg-status', role: 'status', 'aria-live': 'polite' });
      var error = el('div', { class: 'dsg-error', role: 'alert', hidden: true });
      var view = el('a', { class: 'dsg-btn dsg-btn--secondary', href: Q.quotesUrl(myQuotesUrl, s.selected === 'new' ? null : s.selected), text: 'View quote' });
      var add = el('button', { type: 'button', class: 'dsg-btn dsg-btn--primary', text: 'Add to quote' });
      add.addEventListener('click', submit);
      var close = el('button', { type: 'button', class: 'dsg-close', 'aria-label': 'Close', text: '×' });
      close.addEventListener('click', function () { setOpen(false); trigger.focus(); });

      pop.appendChild(el('div', { class: 'dsg-pop__body' }, [
        el('div', { class: 'dsg-pop__head' }, [
          el('strong', { id: titleId, text: 'Add ' + qty + ' × ' + productTitle + ' to which quote?' }),
          close
        ]),
        group,
        el('p', { class: 'dsg-note', text: 'Submitted quotes are locked while sales reviews them. To add items, message your rep in the quote.' }),
        error,
        status,
        el('div', { class: 'dsg-actions' }, [view, add])
      ]));
      refs = { radios: radios, job: job, po: po, error: error, status: status, view: view, add: add, close: close, first: radios[s.selected] || close };
    }

    function select(id) {
      s.selected = id;
      showError('');
      Array.prototype.forEach.call(pop.querySelectorAll('.dsg-opt'), function (n) {
        n.classList.toggle('is-selected', !!n.querySelector('input[type=radio]:checked'));
      });
      refs.view.setAttribute('href', Q.quotesUrl(myQuotesUrl, id === 'new' ? null : id));
    }

    function submit() {
      if (s.busy) return;
      var variantId = readVariant();
      var qty = readQty();
      var target = s.selected;
      showError('');
      if (!variantId) return showError('Choose an option for this product first.');
      if (target === 'new' && !s.job.trim()) {
        refs.job.setAttribute('aria-invalid', 'true');
        return showError('Enter a job name to start a new quote.', refs.job);
      }
      s.busy = true;
      refs.add.disabled = true;
      refs.add.setAttribute('aria-busy', 'true');
      showStatus('Adding…');

      var step = target === 'new'
        ? Q.api('POST', '/c/quotes', Object.assign(
            { title: s.job.trim(), newJob: Object.assign({ name: s.job.trim() }, s.po.trim() ? { poNumber: s.po.trim() } : {}), setActive: true },
            s.po.trim() ? { poNumber: s.po.trim() } : {}), base)
          .then(function (q) {
            // keep the created draft selected so a retry after a failed line add never duplicates the quote
            s.quotes.unshift(q);
            s.selected = q.id;
            s.job = ''; s.po = '';
            return q;
          })
        : Promise.resolve(s.quotes.filter(function (q) { return q.id === target; })[0]);

      step.then(function (q) {
        return Q.api('POST', '/c/quotes/' + encodeURIComponent(q.id) + '/lines', { variantId: Q.gid(variantId), qty: qty }, base)
          .then(function (updated) { return { id: q.id, quote: updated || q }; });
      }).then(function (r) {
        var quote = r.quote;
        var done = target === 'new' ? Promise.resolve() : Q.api('PUT', '/c/active-quote', { quoteId: r.id }, base).catch(function () {});
        return done.then(function () { success(quote); });
      }).catch(function (err) {
        s.busy = false;
        refs.add.disabled = false;
        refs.add.removeAttribute('aria-busy');
        showStatus('');
        if (Q.isAuthError(err)) return signInPrompt();
        showError(err.message);
        if (s.selected !== 'new' && refs.radios[s.selected]) refs.radios[s.selected].checked = true;
      });
    }

    function success(quote) {
      s.busy = false;
      s.added = true;
      var label = (quote.displayNumber || 'Q-' + quote.number) + ' — ' + Q.quoteTitle(quote);
      Q.emitActive({ quoteId: quote.id, number: quote.number, title: quote.title, lineCount: quote.lineCount });
      pop.textContent = '';
      var view = el('a', { class: 'dsg-btn dsg-btn--primary', href: Q.quotesUrl(myQuotesUrl, quote.id), text: 'View quote' });
      var more = el('button', { type: 'button', class: 'dsg-btn dsg-btn--secondary', text: 'Keep shopping' });
      more.addEventListener('click', function () { setOpen(false); trigger.focus(); });
      pop.appendChild(el('div', { class: 'dsg-pop__body' }, [
        el('strong', { id: titleId, text: 'Added to your quote' }),
        el('p', { class: 'dsg-status', role: 'status', 'aria-live': 'polite', text: 'Added to ' + label + '.' }),
        el('div', { class: 'dsg-actions' }, [more, view])
      ]));
      view.focus();
    }

    trigger.addEventListener('click', function () { setOpen(!s.open); });
  }

  Q.initAddToQuote = init;
  Q.mount('[data-dsg-add-to-quote]', init);
})(typeof window !== 'undefined' ? window : this);
