// Ownware docs — client JS (multi-page static site).
// window.SEARCH is injected above this file at build time.

// ── theme toggle (persisted; boot script already set the initial theme) ──
var THEME_KEY = 'ownware-docs-theme'
var themebtn = document.getElementById('themebtn')
if (themebtn) themebtn.addEventListener('click', function () {
  var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
  var next = cur === 'light' ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', next)
  try { localStorage.setItem(THEME_KEY, next) } catch (e) {}
})

// ── mobile sidebar ───────────────────────────────────────────────────
var menubtn = document.getElementById('menubtn')
if (menubtn) menubtn.addEventListener('click', function () {
  var sb = document.querySelector('.sidebar:not([hidden])')
  if (sb) sb.classList.toggle('open')
})

// ── copy code / copy page / download markdown ────────────────────────
function flashText(el, msg) {
  var node = el.childNodes[el.childNodes.length - 1]
  var old = node.nodeValue
  node.nodeValue = msg; el.classList.add('done')
  setTimeout(function () { node.nodeValue = old; el.classList.remove('done') }, 1400)
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text)
  return new Promise(function (res) {
    var ta = document.createElement('textarea'); ta.value = text
    ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta)
    ta.select(); try { document.execCommand('copy') } catch (e) {}
    document.body.removeChild(ta); res()
  })
}
function decodeB64(b) { try { return decodeURIComponent(escape(atob(b))) } catch (e) { return atob(b) } }

document.addEventListener('click', function (e) {
  var codeBtn = e.target.closest ? e.target.closest('.code-copy') : null
  if (codeBtn) {
    var pre = codeBtn.closest('.code').querySelector('pre code')
    copyText(pre.innerText).then(function () {
      var o = codeBtn.textContent; codeBtn.textContent = 'Copied'; codeBtn.classList.add('done')
      setTimeout(function () { codeBtn.textContent = o; codeBtn.classList.remove('done') }, 1400)
    })
    return
  }
  var pa = e.target.closest ? e.target.closest('.pa') : null
  if (pa && pa.getAttribute('data-act') === 'copy-page') {
    copyText(decodeB64(pa.getAttribute('data-raw'))).then(function () { flashText(pa, 'Copied') })
    return
  }
  if (pa && pa.getAttribute('data-act') === 'download-md') {
    var blob = new Blob([decodeB64(pa.getAttribute('data-raw'))], { type: 'text/markdown' })
    var url = URL.createObjectURL(blob)
    var a = document.createElement('a'); a.href = url; a.download = pa.getAttribute('data-file')
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
    return
  }
})

// ── search (navigates to real page URLs) ─────────────────────────────
var modal = document.getElementById('searchModal')
var input = document.getElementById('searchInput')
var resultsEl = document.getElementById('searchResults')
var results = [], activeIdx = 0
function openSearch() { modal.hidden = false; input.value = ''; runSearch(''); input.focus() }
function closeSearch() { modal.hidden = true }
function runSearch(q) {
  q = q.trim().toLowerCase()
  var out = []
  for (var i = 0; i < SEARCH.length && out.length < 40; i++) {
    var r = SEARCH[i]
    if (!q || r.title.toLowerCase().indexOf(q) !== -1 || r.sub.toLowerCase().indexOf(q) !== -1) out.push(r)
  }
  results = out; activeIdx = 0; renderResults()
}
function renderResults() {
  if (!results.length) { resultsEl.innerHTML = '<div class="sr-empty">No matches</div>'; return }
  resultsEl.innerHTML = results.map(function (r, i) {
    return '<a class="sr' + (i === activeIdx ? ' on' : '') + '" href="' + r.url + '" data-i="' + i + '">' +
      '<span class="sr-l">' + r.title + '</span><span class="sr-s">' + r.sub + '</span></a>'
  }).join('')
}
function go(i) { if (results[i]) location.href = results[i].url }
var searchbtn = document.getElementById('searchbtn')
if (searchbtn) searchbtn.addEventListener('click', openSearch)
if (input) {
  input.addEventListener('input', function () { runSearch(input.value) })
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, results.length - 1); renderResults() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); renderResults() }
    else if (e.key === 'Enter') { e.preventDefault(); go(activeIdx) }
    else if (e.key === 'Escape') { closeSearch() }
  })
  resultsEl.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('.sr') : null
    if (a) { e.preventDefault(); go(parseInt(a.getAttribute('data-i'), 10)) }
  })
  modal.addEventListener('click', function (e) { if (e.target === modal) closeSearch() })
}
document.addEventListener('keydown', function (e) {
  if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && modal && modal.hidden) {
    if (document.activeElement && /input|textarea/i.test(document.activeElement.tagName)) return
    e.preventDefault(); openSearch()
  }
})
