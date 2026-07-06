/**
 * Overlay script injected into the prototype iframe's srcDoc.
 *
 * Two responsibilities:
 *   1. Element selection — in `select` mode, hover outlines the
 *      element under the cursor; click pins it and posts a
 *      `cx:element-selected` message to the host. The host renders
 *      a chip on the composer; the next user message carries the
 *      selector + outerHTML so the agent can edit *that specific
 *      element* by name.
 *   2. Error reporting — `window.onerror` and `unhandledrejection`
 *      both post `cx:iframe-error` to the host so the client can show
 *      a useful failure state instead of a silently blank preview.
 *
 * Defence in depth — generated HTML may install its own click
 * handlers, call `removeEventListener`, freeze prototypes, or
 * navigate the iframe. We use `capture: true` listeners and re-
 * attach every 200ms (`addEventListener` is a no-op when the same
 * fn+capture is already registered). Navigation routes are stubbed
 * so a stray `location.reload()` doesn't blank the sandbox.
 *
 * Trust boundary — inbound messages are accepted only when
 * `ev.source === window.parent` AND `data.__cx === true`. Without
 * this guard, in-iframe scripts could synthesise host commands.
 *
 * Bundled as a string at build time — ESM modules can't expose a
 * script for `<script>` injection any other way. Importers MUST
 * embed this verbatim into a srcDoc HTML document near `</body>`;
 * do NOT eval it in the parent window.
 *
 * Ownware version of open-codesign's `overlay.ts:19-361` — same
 * defensive shape, our names (`__cx` magic, `cx:` types), with
 * `scrollIntoView` and `ELEMENT_RECTS` removed per
 * RESEARCH-canvas-bodies.md §2 (Reject and Defer respectively).
 * Mode is `default | select` (not open-codesign's `comment`).
 */

// Outline colors — hardcoded hex of `--cx-violet` and a darker
// pinned variant. The iframe is null-origin (sandboxed `allow-
// scripts`), so it cannot read CSS custom properties from the
// parent's `tokens.css`. This is the one place in the client
// codebase where hex literals are correct — a documented, explicit
// exception to the design-token rule.
const HOVER_OUTLINE = '2px solid #7C5CFC'
const PINNED_OUTLINE = '2.5px solid #5A3FD4'

export const CX_OVERLAY_SCRIPT = `(function() {
  'use strict';
  var hovered = null;
  var pinned = null;
  var warned = Object.create(null);
  function warnOnce(key, err) {
    if (warned[key]) return;
    warned[key] = true;
    try { console.warn('[cx-overlay] ' + key, err); } catch (_) { /* noop */ }
  }
  var currentMode = 'default';

  var HOVER_OUTLINE = ${JSON.stringify(HOVER_OUTLINE)};
  var PINNED_OUTLINE = ${JSON.stringify(PINNED_OUTLINE)};

  // ── cx:set-tokens live preview ─────────────────────────────────────
  // The Style drawer drives token edits over the bridge; we write each
  // as an inline custom property on <html> so it overrides the design's
  // own styles.css :root with no reload. We track exactly the vars we
  // set so cx:clear-tokens can remove only those, restoring styles.css
  // untouched (an abandoned drag must leave no residue).
  var appliedTokenVars = Object.create(null);
  function toVarName(key) {
    var k = String(key || '');
    return k.indexOf('--') === 0 ? k : '--' + k;
  }
  function applyTokens(tokens) {
    if (!tokens || typeof tokens !== 'object') return;
    var root = document.documentElement;
    if (!root || !root.style) return;
    var keys = Object.keys(tokens);
    for (var i = 0; i < keys.length; i++) {
      var value = tokens[keys[i]];
      // Defensive: the host guard (isCxSetTokens) already rejects
      // non-string values whole, but the overlay can't import it, so
      // skip anything non-string rather than coercing.
      if (typeof value !== 'string') continue;
      var name = toVarName(keys[i]);
      try { root.style.setProperty(name, value); appliedTokenVars[name] = true; }
      catch (err) { warnOnce('setProperty failed for ' + name, err); }
    }
  }
  function clearTokens() {
    var root = document.documentElement;
    if (!root || !root.style) return;
    var names = Object.keys(appliedTokenVars);
    for (var i = 0; i < names.length; i++) {
      try { root.style.removeProperty(names[i]); }
      catch (err) { warnOnce('removeProperty failed for ' + names[i], err); }
    }
    appliedTokenVars = Object.create(null);
  }

  function resolveBodyRelativePath(sel) {
    var parts = String(sel || '').slice(1).split('/');
    var current = document.body;
    if (!current || !parts.length) return null;
    for (var i = 0; i < parts.length; i++) {
      var match = /^([a-zA-Z][a-zA-Z0-9-]*)\\[(\\d+)\\]$/.exec(parts[i]);
      if (!match) return null;
      var tag = String(match[1]).toUpperCase();
      var targetIndex = Number(match[2]);
      if (!targetIndex || !current.children) return null;
      var seen = 0;
      var next = null;
      for (var j = 0; j < current.children.length; j++) {
        var child = current.children[j];
        if (child && child.tagName === tag) {
          seen++;
          if (seen === targetIndex) { next = child; break; }
        }
      }
      if (!next) return null;
      current = next;
    }
    return current;
  }

  function resolveSelector(sel) {
    if (!sel || typeof sel !== 'string') return null;
    try {
      var c = sel.charAt(0);
      if (c === '#' || c === '[' || c === '.') return document.querySelector(sel);
      if (c === '/') {
        var res = document.evaluate(sel, document, null, 9, null);
        if (res && res.singleNodeValue) return res.singleNodeValue;
        return resolveBodyRelativePath(sel);
      }
      return document.querySelector(sel);
    } catch (_) { return null; }
  }

  // ── Box-model overlay (Slice B11.2) ────────────────────────────
  //
  // On hover in select mode, paint a thin margin / padding ghost
  // around the element (Chrome-DevTools-style). One fixed-position
  // overlay div lives on document.body with three nested layers —
  // far cheaper than reflowing the element itself with extra outlines.
  //
  // The ghost is created lazily on first paint and reused. Hidden
  // (not removed) on mouseout so re-hover doesn't re-allocate.
  // pointer-events: none so it doesn't interfere with clicks.
  var ghostHost = null;
  var ghostMargin = null;
  var ghostPadding = null;
  var ghostInfo = null;

  function ensureGhost() {
    if (ghostHost && ghostHost.isConnected) return;
    try {
      ghostHost = document.createElement('div');
      ghostHost.id = '__cx_box_overlay';
      ghostHost.setAttribute('aria-hidden', 'true');
      ghostHost.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483646;display:none;';
      ghostMargin = document.createElement('div');
      ghostMargin.style.cssText = 'position:fixed;background:rgba(245,158,11,0.16);pointer-events:none;';
      ghostPadding = document.createElement('div');
      ghostPadding.style.cssText = 'position:fixed;background:rgba(0,212,170,0.14);pointer-events:none;';
      ghostInfo = document.createElement('div');
      ghostInfo.style.cssText = 'position:fixed;background:#0E0E0E;color:#FAF7EE;font:11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;padding:3px 6px;border-radius:3px;pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,0.25);white-space:nowrap;';
      ghostHost.appendChild(ghostMargin);
      ghostHost.appendChild(ghostPadding);
      ghostHost.appendChild(ghostInfo);
      document.body.appendChild(ghostHost);
    } catch (err) {
      warnOnce('ensureGhost failed', err);
      ghostHost = null;
    }
  }

  function hideGhost() {
    if (ghostHost) {
      try { ghostHost.style.display = 'none'; } catch (_) {}
    }
  }

  function px(value) {
    var n = parseFloat(value);
    return isFinite(n) ? n : 0;
  }

  function paintBoxModel(el) {
    if (!el || el.nodeType !== 1) { hideGhost(); return; }
    ensureGhost();
    if (!ghostHost) return;
    var rect, cs;
    try { rect = el.getBoundingClientRect(); } catch (_) { hideGhost(); return; }
    try { cs = window.getComputedStyle(el); } catch (_) { hideGhost(); return; }
    if (!rect || !cs) { hideGhost(); return; }

    var mt = px(cs.marginTop), mr = px(cs.marginRight), mb = px(cs.marginBottom), ml = px(cs.marginLeft);
    var pt = px(cs.paddingTop), pr = px(cs.paddingRight), pb = px(cs.paddingBottom), pl = px(cs.paddingLeft);

    // Margin box wraps the element from outside.
    try {
      ghostMargin.style.top = (rect.top - mt) + 'px';
      ghostMargin.style.left = (rect.left - ml) + 'px';
      ghostMargin.style.width = (rect.width + ml + mr) + 'px';
      ghostMargin.style.height = (rect.height + mt + mb) + 'px';
    } catch (_) {}

    // Padding-band rendered as four strips inside the element so the
    // content area shows through cleanly. We reuse ghostPadding for
    // the top strip and append three sibling strips on first paint.
    try {
      if (!ghostPadding.__strips) {
        var top = ghostPadding;
        top.style.cssText = 'position:fixed;background:rgba(0,212,170,0.14);pointer-events:none;';
        var right = top.cloneNode(false);
        var bottom = top.cloneNode(false);
        var left = top.cloneNode(false);
        ghostHost.appendChild(right);
        ghostHost.appendChild(bottom);
        ghostHost.appendChild(left);
        ghostPadding.__strips = { top: top, right: right, bottom: bottom, left: left };
      }
      var strips = ghostPadding.__strips;
      // Top strip: full width of element, height = paddingTop, at rect.top.
      strips.top.style.top = rect.top + 'px';
      strips.top.style.left = rect.left + 'px';
      strips.top.style.width = rect.width + 'px';
      strips.top.style.height = pt + 'px';
      // Bottom strip
      strips.bottom.style.top = (rect.top + rect.height - pb) + 'px';
      strips.bottom.style.left = rect.left + 'px';
      strips.bottom.style.width = rect.width + 'px';
      strips.bottom.style.height = pb + 'px';
      // Left strip: rect.left, rect.top + pt, paddingLeft wide, rect.height - pt - pb tall.
      strips.left.style.top = (rect.top + pt) + 'px';
      strips.left.style.left = rect.left + 'px';
      strips.left.style.width = pl + 'px';
      strips.left.style.height = Math.max(0, rect.height - pt - pb) + 'px';
      // Right strip
      strips.right.style.top = (rect.top + pt) + 'px';
      strips.right.style.left = (rect.left + rect.width - pr) + 'px';
      strips.right.style.width = pr + 'px';
      strips.right.style.height = Math.max(0, rect.height - pt - pb) + 'px';
    } catch (_) {}

    // Info tag — "tag · WxH · m TRBL · p TRBL". Positioned just
    // above the element when there's room; below when it would
    // clip the viewport top.
    try {
      var tag = el.tagName ? el.tagName.toLowerCase() : '?';
      var w = Math.round(rect.width), h = Math.round(rect.height);
      var marginStr = (mt === 0 && mr === 0 && mb === 0 && ml === 0) ? '' : ' · m ' + mt + ' ' + mr + ' ' + mb + ' ' + ml;
      var paddingStr = (pt === 0 && pr === 0 && pb === 0 && pl === 0) ? '' : ' · p ' + pt + ' ' + pr + ' ' + pb + ' ' + pl;
      ghostInfo.textContent = tag + ' · ' + w + '×' + h + marginStr + paddingStr;
      // Default: above the element with 6px gap.
      var infoTop = rect.top - 22;
      if (infoTop < 4) infoTop = rect.top + rect.height + 6;
      ghostInfo.style.top = infoTop + 'px';
      ghostInfo.style.left = Math.max(4, rect.left) + 'px';
    } catch (_) {}

    try { ghostHost.style.display = 'block'; } catch (_) {}
  }

  function clearHover() {
    if (hovered && hovered !== pinned) {
      try { hovered.style.outline = ''; } catch (_) {}
    }
    hovered = null;
    hideGhost();
  }

  function clearPinned() {
    if (pinned) {
      try { pinned.style.outline = ''; } catch (_) {}
    }
    pinned = null;
  }

  function pinElement(el) {
    if (!el || !el.style) return;
    if (pinned && pinned !== el) {
      try { pinned.style.outline = ''; } catch (_) {}
    }
    pinned = el;
    try { el.style.outline = PINNED_OUTLINE; } catch (_) {}
    // No scrollIntoView — Ownware-deliberate. Auto-scroll on pin is
    // surprising UX when the user picks an element from chat.
  }

  function buildSelector(el) {
    if (el.dataset && el.dataset.cxId) return '[data-cx-id="' + el.dataset.cxId + '"]';
    if (el.id) return '#' + el.id;
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      var idx = 1;
      var sib = el.previousElementSibling;
      while (sib) { if (sib.tagName === el.tagName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(el.tagName.toLowerCase() + '[' + idx + ']');
      el = el.parentElement;
    }
    return '/' + parts.join('/');
  }

  function onMouseOver(e) {
    if (currentMode !== 'select') return;
    if (hovered && hovered !== pinned) {
      try { hovered.style.outline = ''; } catch (_) {}
    }
    hovered = e.target;
    if (hovered && hovered !== pinned) {
      try { hovered.style.outline = HOVER_OUTLINE; } catch (_) {}
    }
    // Slice B11.2 — DevTools-style margin/padding ghost + info tag.
    // Only paints in select mode; cleared on mouseout via clearHover.
    if (hovered && hovered.nodeType === 1) {
      paintBoxModel(hovered);
    }
  }

  function onMouseOut() {
    if (currentMode !== 'select') return;
    clearHover();
  }

  // Collect the design tokens (--name) the element's matched CSS rules
  // reference, with each token's CURRENT value read from :root. This is
  // what lets the agent decide a colour change WITHOUT reading styles.css:
  // it already knows "this element uses --accent (#635bff)". Bounded + fully
  // defensive — a cross-origin or unreadable sheet is skipped, never thrown.
  function collectAppliedTokens(el) {
    var found = [];
    var seen = {};
    var rootStyle = null;
    try { rootStyle = getComputedStyle(document.documentElement); } catch (_) {}
    var sheets = document.styleSheets || [];
    for (var i = 0; i < sheets.length; i++) {
      var rules = null;
      try { rules = sheets[i].cssRules; } catch (_) { rules = null; } // cross-origin sheet
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var rule = rules[j];
        if (!rule || rule.type !== 1 || !rule.selectorText || !rule.style) continue;
        var ok = false;
        try { ok = el.matches(rule.selectorText); } catch (_) { ok = false; }
        if (!ok) continue;
        var cssText = '';
        try { cssText = rule.style.cssText || ''; } catch (_) { cssText = ''; }
        var re = /var\\(\\s*(--[A-Za-z0-9-]+)/g;
        var m;
        while ((m = re.exec(cssText)) !== null) {
          var name = m[1];
          if (seen[name]) continue;
          seen[name] = true;
          var val = '';
          if (rootStyle) { try { val = (rootStyle.getPropertyValue(name) || '').trim().slice(0, 80); } catch (_) {} }
          found.push({ name: name, value: val });
          if (found.length >= 12) return found;
        }
      }
    }
    return found;
  }

  function fireSelectFor(el) {
    var rect = el.getBoundingClientRect();
    var selector = buildSelector(el);
    pinElement(el);
    var parentHtml = '';
    try {
      if (el.parentElement && el.parentElement.outerHTML) {
        parentHtml = String(el.parentElement.outerHTML).slice(0, 600);
      }
    } catch (_) { /* parent inaccessible — leave blank */ }
    var tokens = [];
    try { tokens = collectAppliedTokens(el); } catch (_) { tokens = []; }
    try {
      window.parent.postMessage({
        __cx: true,
        type: 'cx:element-selected',
        selector: selector,
        tag: el.tagName.toLowerCase(),
        outerHTML: (el.outerHTML || '').slice(0, 800),
        parentOuterHTML: parentHtml,
        appliedTokens: tokens,
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
      }, '*');
    } catch (err) { warnOnce('postMessage cx:element-selected failed', err); }
  }

  function onClick(e) {
    if (currentMode === 'select') {
      e.preventDefault();
      e.stopPropagation();
      fireSelectFor(e.target);
      return;
    }
    // Slice B11 — Alt-click in interact mode = one-shot select. The
    // mode stays 'default' (interact) afterwards; the user gets a
    // chip without leaving interaction mode.
    if (e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      fireSelectFor(e.target);
      return;
    }
    // Default mode: block navigating anchors so the sandbox doesn't
    // blank itself. In-document hash jumps that resolve to an
    // existing element are allowed.
    var anchor = e.target;
    while (anchor && anchor.tagName !== 'A') anchor = anchor.parentElement;
    if (anchor && (anchor.href || anchor.getAttribute('href'))) {
      var href = anchor.getAttribute('href') || '';
      if (href.charAt(0) === '#' && href.length > 1) {
        var id = href.slice(1);
        var target = null;
        try { target = document.getElementById(id); } catch (_) {}
        if (target) return;
      }
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onParentMessage(ev) {
    if (!ev || ev.source !== window.parent) return;
    var data = ev.data;
    if (!data || data.__cx !== true) return;
    if (data.type === 'cx:set-mode') {
      var next = data.mode === 'select' ? 'select' : 'default';
      if (next === currentMode) return;
      currentMode = next;
      if (currentMode === 'default') {
        clearHover();
        clearPinned();
        hideGhost();
      }
      return;
    }
    if (data.type === 'cx:clear-pin') {
      clearPinned();
      return;
    }
    if (data.type === 'cx:pin-selector') {
      var sel = typeof data.selector === 'string' ? data.selector : '';
      var target = resolveSelector(sel);
      if (target) pinElement(target);
      return;
    }
    if (data.type === 'cx:set-tokens') {
      applyTokens(data.tokens);
      return;
    }
    if (data.type === 'cx:clear-tokens') {
      clearTokens();
      return;
    }
  }

  function onError(ev) {
    try {
      window.parent.postMessage({
        __cx: true,
        type: 'cx:iframe-error',
        kind: 'error',
        message: (ev && ev.message) ? String(ev.message) : 'Unknown iframe error',
        source: ev && ev.filename ? String(ev.filename) : undefined,
        lineno: ev && typeof ev.lineno === 'number' ? ev.lineno : undefined,
        colno: ev && typeof ev.colno === 'number' ? ev.colno : undefined,
        stack: ev && ev.error && ev.error.stack ? String(ev.error.stack) : undefined,
        timestamp: Date.now()
      }, '*');
    } catch (err) { warnOnce('postMessage cx:iframe-error (error) failed', err); }
  }

  function onRejection(ev) {
    try {
      var reason = ev && ev.reason;
      var msg = (reason && reason.message) ? String(reason.message) : String(reason);
      window.parent.postMessage({
        __cx: true,
        type: 'cx:iframe-error',
        kind: 'unhandledrejection',
        message: msg,
        stack: (reason && reason.stack) ? String(reason.stack) : undefined,
        timestamp: Date.now()
      }, '*');
    } catch (err) { warnOnce('postMessage cx:iframe-error (unhandledrejection) failed', err); }
  }

  var installs = [
    { evt: 'mouseover', fn: onMouseOver },
    { evt: 'mouseout', fn: onMouseOut },
    { evt: 'click', fn: onClick },
    { evt: 'submit', fn: function(e) { e.preventDefault(); } }
  ];
  function reattach() {
    for (var i = 0; i < installs.length; i++) {
      var spec = installs[i];
      try { document.removeEventListener(spec.evt, spec.fn, true); } catch (err) { warnOnce('removeEventListener failed for ' + spec.evt, err); }
      try { document.addEventListener(spec.evt, spec.fn, true); } catch (err) { warnOnce('addEventListener failed for ' + spec.evt, err); }
    }
    if (!window.__cx_err) {
      try { window.addEventListener('error', onError, true); window.__cx_err = true; } catch (err) { warnOnce('attach window error listener failed', err); }
    }
    if (!window.__cx_rej) {
      try { window.addEventListener('unhandledrejection', onRejection, true); window.__cx_rej = true; } catch (err) { warnOnce('attach unhandledrejection listener failed', err); }
    }
    if (!window.__cx_msg) {
      try { window.addEventListener('message', onParentMessage, false); window.__cx_msg = true; } catch (_) {}
    }
  }
  reattach();
  try {
    try { clearInterval(window.__cx_reattach_interval); } catch (_) {}
    window.__cx_reattach_interval = setInterval(reattach, 200);
    if (!window.__cx_reattach_unload) {
      window.__cx_reattach_unload = true;
      var stopReattach = function() {
        try { clearInterval(window.__cx_reattach_interval); } catch (_) {}
        window.__cx_reattach_interval = 0;
      };
      try { window.addEventListener('pagehide', stopReattach, false); } catch (_) {}
      try { window.addEventListener('beforeunload', stopReattach, false); } catch (_) {}
    }
  } catch (err) { try { console.warn('[cx-overlay] setInterval reattach failed:', err); } catch (_) {} }

  // Neutralise programmatic navigation — generated code might call
  // window.location = '/foo', location.assign(), or window.open().
  // None of those routes exist in the sandbox and they'd blank the
  // preview. No-op idempotently.
  try {
    if (!window.__cx_navguard) {
      window.__cx_navguard = true;
      var nopNav = function() { /* navigation suppressed in preview sandbox */ };
      try { window.open = function() { return null; }; } catch (_) {}
      try {
        var loc = window.location;
        try { loc.assign = nopNav; } catch (_) {}
        try { loc.replace = nopNav; } catch (_) {}
        try { loc.reload = nopNav; } catch (_) {}
      } catch (_) {}
    }
  } catch (err) { try { console.warn('[cx-overlay] navguard install failed:', err); } catch (_) {} }
})();`
