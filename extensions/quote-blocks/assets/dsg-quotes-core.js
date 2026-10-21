/* DSG Quotes - shared storefront helpers. Vanilla JS, no dependencies.
 * Talks only to the app proxy (/apps/quotes/*), see docs/openapi.yaml. */
(function (root) {
  'use strict';
  if (root.DSGQuotes) return;

  var DEFAULT_BASE = '/apps/quotes';
  var seq = 0;

  function ApiError(status, code, message, details) {
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.message = message;
    this.details = details || null;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  /** JSON call through the app proxy. Resolves with parsed JSON (null for 204). Rejects with ApiError. */
  function api(method, path, body, base) {
    var init = {
      method: method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return Promise.resolve()
      .then(function () { return root.fetch((base || DEFAULT_BASE) + path, init); })
      .catch(function () {
        throw new ApiError(0, 'NETWORK', 'We could not reach the server. Check your connection and try again.');
      })
      .then(function (res) {
        if (res.status === 204) return null;
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (res.ok) return data;
          var code = (data && data.code) || (res.status === 401 ? 'UNAUTHENTICATED' : res.status === 403 ? 'FORBIDDEN' : 'INTERNAL');
          var msg = (data && data.message) || 'Something went wrong. Please try again.';
          throw new ApiError(res.status, code, msg, data && data.details);
        });
      });
  }

  function isAuthError(err) {
    return !!err && (err.code === 'UNAUTHENTICATED' || err.status === 401);
  }

  /** Create an element. attrs: plain attributes, `text`, `class`, and on* handlers. */
  function el(tag, attrs, children) {
    var node = root.document.createElement(tag);
    var k;
    attrs = attrs || {};
    for (k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k) || attrs[k] === null || attrs[k] === undefined || attrs[k] === false) continue;
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'class') node.className = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? root.document.createTextNode(c) : c);
    });
    return node;
  }

  function uid(prefix) { seq += 1; return (prefix || 'dsg') + '-' + seq; }

  function gid(variantId) {
    var s = String(variantId || '');
    return s.indexOf('gid://') === 0 ? s : 'gid://shopify/ProductVariant/' + s;
  }

  function money(amount, currency) {
    var n = parseFloat(amount);
    if (isNaN(n)) return '';
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n);
    } catch (e) {
      return '$' + n.toFixed(2);
    }
  }

  var STATUS_LABEL = { DRAFT: 'Draft' };

  /** "Q-10482 · PO 4471 · Draft · 6 items · $3,912.00" */
  function quoteMeta(q, currency) {
    var po = q.job && q.job.poNumber ? 'PO ' + q.job.poNumber : (q.poNumber ? 'PO ' + q.poNumber : 'no PO yet');
    var n = q.lineCount || 0;
    return [
      q.displayNumber || (q.number ? 'Q-' + q.number : ''),
      po,
      STATUS_LABEL[q.status] || q.status,
      n + (n === 1 ? ' item' : ' items'),
      money(q.total, currency)
    ].filter(Boolean).join(' · ');
  }

  function quoteTitle(q) {
    return (q.job && q.job.name && q.title && q.title !== q.job.name) ? q.job.name + ' — ' + q.title : (q.title || (q.job && q.job.name) || 'Quote');
  }

  /** Link to My Quotes. `tpl` may contain {id}. */
  function quotesUrl(tpl, id) {
    tpl = tpl || '/account';
    if (id) return tpl.indexOf('{id}') > -1 ? tpl.replace('{id}', encodeURIComponent(id)) : tpl;
    return tpl.replace(/\/?\{id\}/, '');
  }

  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function focusables(container) {
    return Array.prototype.filter.call(container.querySelectorAll(FOCUSABLE), function (n) {
      return !n.hidden && !n.closest('[hidden]');
    });
  }

  /** Keep Tab inside `container` and call onEscape on Esc. Returns a release function. */
  function trapFocus(container, onEscape) {
    function onKey(e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.stopPropagation();
        e.preventDefault();
        onEscape();
        return;
      }
      if (e.key !== 'Tab') return;
      var items = focusables(container);
      if (!items.length) { e.preventDefault(); return; }
      var first = items[0];
      var last = items[items.length - 1];
      var active = root.document.activeElement;
      if (e.shiftKey && (active === first || !container.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !container.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
    container.addEventListener('keydown', onKey);
    return function release() { container.removeEventListener('keydown', onKey); };
  }

  /** Run `init(node)` once for every `selector` match now, and again after theme-editor reloads. */
  function mount(selector, init) {
    function scan() {
      Array.prototype.forEach.call(root.document.querySelectorAll(selector), function (node) {
        if (node.getAttribute('data-dsg-ready')) return;
        node.setAttribute('data-dsg-ready', '1');
        init(node);
      });
    }
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', scan);
    else scan();
    root.document.addEventListener('shopify:section:load', scan);
    root.document.addEventListener('shopify:block:select', scan);
  }

  function data(node, name, fallback) {
    var v = node.getAttribute('data-' + name);
    return v === null || v === '' ? fallback : v;
  }

  function emitActive(detail) {
    root.document.dispatchEvent(new root.CustomEvent('dsg-quotes:active-changed', { detail: detail || {} }));
  }

  root.DSGQuotes = {
    ApiError: ApiError,
    api: api,
    isAuthError: isAuthError,
    el: el,
    uid: uid,
    gid: gid,
    money: money,
    quoteMeta: quoteMeta,
    quoteTitle: quoteTitle,
    quotesUrl: quotesUrl,
    trapFocus: trapFocus,
    focusables: focusables,
    mount: mount,
    data: data,
    emitActive: emitActive,
    DEFAULT_BASE: DEFAULT_BASE
  };
})(typeof window !== 'undefined' ? window : this);
