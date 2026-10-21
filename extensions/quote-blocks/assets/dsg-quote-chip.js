/* DSG Quotes - "Adding to quote" header chip (app embed). Mockup screen 1 header. */
(function (root) {
  'use strict';
  var Q = root.DSGQuotes;
  if (!Q) return;
  var el = Q.el;

  function init(host) {
    var base = Q.data(host, 'base', Q.DEFAULT_BASE);
    var myQuotesUrl = Q.data(host, 'my-quotes-url', '/account');
    var mountSel = Q.data(host, 'mount-selector', '');
    var link = host.querySelector('[data-dsg-chip-link]');
    var text = host.querySelector('[data-dsg-chip-text]');
    if (!link || !text) return;

    if (mountSel) {
      var target = root.document.querySelector(mountSel);
      if (target) { target.appendChild(host); host.classList.add('dsg-chip--inline'); }
    }

    function show(a) {
      if (!a || !a.quoteId) { host.hidden = true; return; }
      var num = a.number ? 'Q-' + a.number : '';
      text.textContent = [a.title, num].filter(Boolean).join(' · ');
      link.setAttribute('href', Q.quotesUrl(myQuotesUrl, a.quoteId));
      link.setAttribute('aria-label', 'Adding to quote ' + text.textContent + '. Open quote.');
      host.hidden = false;
    }
    function refresh() {
      return Q.api('GET', '/c/active-quote', undefined, base).then(show).catch(function () { host.hidden = true; });
    }

    root.document.addEventListener('dsg-quotes:active-changed', function (e) {
      var d = e.detail || {};
      if (d.quoteId) show(d); else refresh();
    });
    refresh();
  }

  Q.initChip = init;
  Q.mount('[data-dsg-chip]', init);
})(typeof window !== 'undefined' ? window : this);
