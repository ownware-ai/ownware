// Build a single-file docs-site preview from weft's docs/ folder.
import { Marked } from 'marked'
import hljs from 'highlight.js'
import { readFileSync, writeFileSync, statSync, mkdirSync, rmSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

// Map our fence languages to highlight.js language ids. Anything not listed
// (directory trees, `text`) renders as plain escaped text — no false coloring.
const HL_LANG = { json: 'json', js: 'javascript', javascript: 'javascript', ts: 'typescript', typescript: 'typescript', bash: 'bash', sh: 'bash', shell: 'bash' }
const LANG_LABEL = { json: 'json', js: 'javascript', javascript: 'javascript', ts: 'typescript', typescript: 'typescript', bash: 'bash', sh: 'shell', shell: 'shell', md: 'markdown', markdown: 'markdown' }

const REPO = join(import.meta.dirname, '..')   // the repo root (website/ is a subfolder)
const GH_REPO = 'https://github.com/ownware-ai/ownware'
const GH_BLOB = `${GH_REPO}/blob/main`

// ── Page manifest (two products: Ownware + Engine) ───────────────────
const WEFT_GROUPS = [
  { title: 'Overview', pages: [{ id: 'index', file: 'docs/index.md', nav: 'Ownware' }] },
  {
    title: 'Getting started',
    pages: [
      { id: 'getting-started-quickstart', file: 'docs/getting-started/quickstart.md', nav: 'Quickstart' },
      { id: 'getting-started-installation', file: 'docs/getting-started/installation.md', nav: 'Installation' },
      { id: 'getting-started-thinking-in-ownware', file: 'docs/getting-started/thinking-in-ownware.md', nav: 'Thinking in Ownware' },
    ],
  },
  {
    title: 'Agents',
    pages: [
      { id: 'agents-overview', file: 'docs/agents/overview.md', nav: 'Agents & profiles' },
      { id: 'agents-profile-format', file: 'docs/agents/profile-format.md', nav: 'Profile format' },
      { id: 'agents-example-profiles', file: 'docs/agents/example-profiles.md', nav: 'Example profiles' },
      { id: 'agents-multi-agent', file: 'docs/agents/multi-agent.md', nav: 'Multi-agent teams' },
    ],
  },
  {
    title: 'Gateway',
    pages: [
      { id: 'gateway-overview', file: 'docs/gateway/overview.md', nav: 'Gateway' },
      { id: 'gateway-run-api', file: 'docs/gateway/run-api.md', nav: 'The run API' },
      { id: 'gateway-exposing', file: 'docs/gateway/exposing.md', nav: 'Exposing the gateway' },
    ],
  },
  {
    title: 'Capabilities',
    pages: [
      { id: 'tools-overview', file: 'docs/tools/overview.md', nav: 'Tools & connectors' },
      { id: 'models-overview', file: 'docs/models/overview.md', nav: 'Models' },
      { id: 'channels-overview', file: 'docs/channels/overview.md', nav: 'Channels' },
    ],
  },
  {
    title: 'Security & config',
    pages: [
      { id: 'security-overview', file: 'docs/security/overview.md', nav: 'Security overview' },
      { id: 'reference-configuration', file: 'docs/reference/configuration.md', nav: 'Configuration reference' },
    ],
  },
  {
    title: 'For AI agents',
    pages: [
      { id: 'llms-txt', file: 'docs/llms.txt', nav: 'llms.txt' },
      { id: 'agents-md', file: 'AGENTS.md', nav: 'AGENTS.md (repo root)' },
    ],
  },
]

const ENGINE_GROUPS = [
  { title: 'Overview', pages: [{ id: 'engine-overview', file: 'docs/engine/overview.md', nav: 'Engine' }] },
  {
    title: 'Get started',
    pages: [
      { id: 'engine-getting-started', file: 'docs/engine/getting-started.md', nav: 'Getting started' },
      { id: 'engine-call-patterns', file: 'docs/engine/call-patterns.md', nav: 'Call patterns' },
    ],
  },
  {
    title: 'Tools',
    pages: [
      { id: 'engine-built-in-tools', file: 'docs/engine/built-in-tools.md', nav: 'Built-in tools' },
      { id: 'engine-custom-tools', file: 'docs/engine/custom-tools.md', nav: 'Custom tools' },
      { id: 'engine-hooks', file: 'docs/engine/hooks.md', nav: 'Hooks' },
      { id: 'engine-mcp', file: 'docs/engine/mcp.md', nav: 'MCP' },
    ],
  },
  {
    title: 'Security',
    pages: [
      { id: 'engine-security', file: 'docs/engine/security.md', nav: 'Security (3 layers)' },
    ],
  },
  {
    title: 'Orchestration',
    pages: [
      { id: 'engine-multi-agent', file: 'docs/engine/multi-agent.md', nav: 'Multi-agent' },
      { id: 'engine-context', file: 'docs/engine/context.md', nav: 'Compaction & state' },
    ],
  },
  {
    title: 'Runtime',
    pages: [
      { id: 'engine-providers', file: 'docs/engine/providers.md', nav: 'Providers' },
      { id: 'engine-streaming', file: 'docs/engine/streaming.md', nav: 'Streaming events' },
      { id: 'engine-cli', file: 'docs/engine/cli.md', nav: 'CLI' },
    ],
  },
]

const PRODUCTS = [
  { id: 'ownware', label: 'Ownware', tagline: 'Build & serve your agent', home: 'index', groups: WEFT_GROUPS },
  { id: 'engine', label: 'Engine', tagline: 'The engine, in code', home: 'engine-overview', groups: ENGINE_GROUPS },
]
const PRODUCT_LABEL = Object.fromEntries(PRODUCTS.map((p) => [p.id, p.label]))

const ALL = PRODUCTS.flatMap((prod) => prod.groups.flatMap((g) => g.pages))
const pathToId = new Map(ALL.map((p) => [p.file, p.id]))
const groupOf = new Map()
const productOf = new Map()
for (const prod of PRODUCTS)
  for (const g of prod.groups)
    for (const p of g.pages) { groupOf.set(p.id, g.title); productOf.set(p.id, prod.id) }
const RAW = {} // pageId -> base64 raw markdown, for copy/download
const SEARCH = [] // { title, sub, url }

const OUTDIR = join(import.meta.dirname, 'dist')

// ── URL scheme: real per-page paths (multi-page static site) ─────────
function pathFor(page) {
  if (page.file.startsWith('docs/') && page.file.endsWith('.md')) {
    const p = page.file.slice(5, -3) // "agents/overview"
    return p === 'index' ? '' : p
  }
  return page.id // e.g. llms-txt, agents-md
}
function urlFor(page) { const p = pathFor(page); return p === '' ? '/' : `/${p}/` }
function outFileFor(page) { const p = pathFor(page); return p === '' ? 'index.html' : `${p}/index.html` }
const idToUrl = new Map(ALL.map((p) => [p.id, urlFor(p)]))

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const slugify = (s) =>
  s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-')

function normalize(path) {
  const parts = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

let currentPage = ''
let currentDir = ''
let toc = [] // { id, text } for h2 headings on the current page

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const info = lang || ''
      const language = info.split(/\s+/)[0] || 'text'
      const m = info.match(/title="([^"]+)"/)
      let nameHtml
      if (m) {
        const title = m[1]
        // If the caption starts with a real repo path (e.g. "profiles/x/agent.json
        // (excerpt)"), link that path to its source on GitHub.
        const pathPart = title.split(' (')[0].trim()
        let linked = false
        if (/[/.]/.test(pathPart)) {
          try {
            const kind = statSync(join(REPO, pathPart)).isDirectory() ? 'tree' : 'blob'
            const rest = title.slice(pathPart.length)
            nameHtml = `<a class="code-name code-src" href="${GH_REPO}/${kind}/main/${pathPart}" target="_blank" rel="noopener" title="View source on GitHub">${escapeHtml(pathPart)}</a><span class="code-name-rest">${escapeHtml(rest)}</span>`
            linked = true
          } catch {}
        }
        if (!linked) nameHtml = `<span class="code-name">${escapeHtml(title)}</span>`
      } else {
        const label = LANG_LABEL[language] || (language === 'text' ? '' : language)
        nameHtml = `<span class="code-name">${label}</span>`
      }
      const hlId = HL_LANG[language]
      const body = hlId
        ? hljs.highlight(text, { language: hlId, ignoreIllegals: true }).value
        : escapeHtml(text)
      const cap = `<figcaption><span class="code-dots" aria-hidden="true"></span>${nameHtml}<button class="code-copy" type="button" aria-label="Copy code">Copy</button></figcaption>`
      return `<figure class="code">${cap}<pre><code class="hljs lang-${language}">${body}</code></pre></figure>\n`
    },
    heading({ tokens, depth, text }) {
      const inner = this.parser.parseInline(tokens)
      // Reduce markdown link syntax [label](url) → label for the id + TOC text.
      const plain = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      const id = slugify(plain)
      if (depth === 2 || depth === 3) toc.push({ id, text: plain.replace(/[`*_]/g, ''), level: depth })
      return `<h${depth} id="${id}">${inner}</h${depth}>\n`
    },
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens)
      if (/^https?:\/\//.test(href)) {
        return `<a href="${href}" target="_blank" rel="noopener">${inner}</a>`
      }
      if (href.startsWith('#')) {
        return `<a href="${href}">${inner}</a>` // same-page anchor (slug)
      }
      const [path, anchor] = href.split('#')
      const resolved = normalize(join(currentDir, path))
      const id = pathToId.get(resolved)
      if (id) {
        return `<a href="${idToUrl.get(id)}${anchor ? '#' + anchor : ''}">${inner}</a>`
      }
      // A repo file/dir not in this preview → link to the actual path on
      // GitHub (blob for files, tree for dirs). Verify it exists so we never
      // ship a 404; if it doesn't resolve, fall back to an inert label.
      try {
        const kind = statSync(join(REPO, resolved)).isDirectory() ? 'tree' : 'blob'
        return `<a class="repo-link" href="${GH_REPO}/${kind}/main/${resolved}" target="_blank" rel="noopener" title="View on GitHub: ${escapeHtml(resolved)}">${inner}</a>`
      } catch {
        return `<span class="repo-ref" title="in the repository: ${escapeHtml(resolved)}">${inner}</span>`
      }
    },
  },
})

function renderPage(page) {
  currentPage = page.id
  currentDir = dirname(page.file)
  toc = []
  const rawFull = readFileSync(join(REPO, page.file), 'utf8')
  RAW[page.id] = Buffer.from(rawFull, 'utf8').toString('base64')
  let src = rawFull
  let typeBadge = ''
  let desc = ''
  const fm = src.match(/^---\n([\s\S]*?)\n---\n/)
  if (fm) {
    const t = fm[1].match(/^type:\s*(\w+)/m)
    if (t) typeBadge = t[1]
    const d = fm[1].match(/^description:\s*(.+?)\s*$/m)
    if (d) desc = d[1].replace(/^["']|["']$/g, '')
    src = src.slice(fm[0].length)
  }
  let html = marked.parse(src)
  html = html.replaceAll('<table>', '<div class="tablewrap"><table>').replaceAll('</table>', '</table></div>')
  html = html.replace(
    /<blockquote>\s*<p><strong>(Note|Tip|Warning|Prerequisites)<\/strong>/g,
    (m, kind) => `<blockquote class="co co-${kind.toLowerCase()}"><p><strong>${kind}</strong>`,
  )
  // Fold the dense "For AI agents:" recipe into a collapsible block so human
  // readers can skip it; the machine content stays intact when opened.
  html = html.replace(
    /<p><strong>For AI agents:<\/strong>([\s\S]*?)<\/p>/g,
    (m, body) =>
      `<details class="ai-block"><summary><span class="ai-ico" aria-hidden="true"></span>For AI agents<span class="ai-hint">condensed build recipe</span></summary><p>${body.trim()}</p></details>`,
  )
  const group = groupOf.get(page.id) || ''
  const product = productOf.get(page.id) || 'ownware'
  const url = urlFor(page)
  SEARCH.push({ title: page.nav, sub: `${PRODUCT_LABEL[product]} · ${group}`, url })
  for (const t of toc) SEARCH.push({ title: t.text, sub: `${PRODUCT_LABEL[product]} · ${page.nav}`, url: `${url}#${t.id}` })

  const badge = typeBadge ? `<span class="pagetype pagetype-${typeBadge}">${typeBadge}</span>` : ''
  const breadcrumb = `<nav class="crumb"><span class="crumb-prod">${escapeHtml(PRODUCT_LABEL[product])}</span><span class="crumb-sep">/</span><span>${escapeHtml(group)}</span><span class="crumb-sep">/</span><span class="crumb-here">${escapeHtml(page.nav)}</span></nav>`
  const actions =
    `<div class="page-actions">` +
    `<button class="pa" type="button" data-act="copy-page" data-raw="${RAW[page.id]}"><span class="pa-ico pa-copy"></span>Copy page</button>` +
    `<button class="pa" type="button" data-act="download-md" data-raw="${RAW[page.id]}" data-file="${page.file.split('/').pop()}"><span class="pa-ico pa-dl"></span>Download markdown</button>` +
    `<a class="pa" href="${GH_BLOB}/${page.file}" target="_blank" rel="noopener"><span class="pa-ico pa-gh"></span>View source</a>` +
    `</div>`
  const ghEdit = `<a class="edit-link" href="${GH_BLOB}/${page.file}" target="_blank" rel="noopener">Edit this page on GitHub →</a>`
  const srcNote = `<footer class="pagesrc">${ghEdit}<span class="pagesrc-file">source: <code>${page.file}</code></span></footer>`
  const tocHtml = toc.length
    ? `<aside class="toc"><h4>On this page</h4><nav>${toc
        .map((t) => `<a class="toc-l${t.level}" href="#${t.id}">${escapeHtml(t.text)}</a>`)
        .join('')}</nav></aside>`
    : '<aside class="toc"></aside>'
  const head = `<div class="page-head"><div class="page-head-row">${breadcrumb}${actions}</div>${badge}</div>`
  const main = `<main class="content"><div class="pagewrap"><article class="page">${head}${html}${srcNote}</article>${tocHtml}</div></main>`
  return { page, product, main, title: page.nav, desc }
}

// Render every page (populates SEARCH + RAW as a side effect).
const rendered = ALL.map(renderPage)

// ── shared assets ────────────────────────────────────────────────────
const tokens = readFileSync(join(import.meta.dirname, 'ow-tokens.css'), 'utf8')
const fonts = readFileSync(join(import.meta.dirname, 'ow-fonts.css'), 'utf8')
const css = readFileSync(join(import.meta.dirname, 'ow-style.css'), 'utf8')
const appjs = readFileSync(join(import.meta.dirname, 'ow-app.js'), 'utf8')

// The Ownware "O" mark — the perimeter you own, woven inside. Rendered in currentColor.
const OW_DEFS =
  '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
  '<clipPath id="ow-ring"><path d="M25,90 A70,70 0 1 1 165,90 A70,70 0 1 1 25,90 Z M61,90 A34,34 0 1 1 129,90 A34,34 0 1 1 61,90 Z" fill-rule="evenodd" clip-rule="evenodd"/></clipPath>' +
  '<g id="ow-weave"><rect x="25" y="20" width="60" height="140"/>' +
  [32, 46, 60, 74, 88, 102, 116, 130, 144].map((y) => `<rect x="83" y="${y}" width="90" height="7"/>`).join('') +
  '</g></defs></svg>'
const OW_MARK = '<svg class="mark" viewBox="15 10 160 160" aria-hidden="true"><g clip-path="url(#ow-ring)" fill="currentColor"><use href="#ow-weave"/></g></svg>'

// ── icons (inline, currentColor) ─────────────────────────────────────
const ICON_GH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.2-3.1-.12-.3-.52-1.48.11-3.08 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.5 3.17-1.18 3.17-1.18.63 1.6.23 2.78.11 3.08.75.81 1.2 1.84 1.2 3.1 0 4.43-2.7 5.4-5.26 5.69.41.36.78 1.05.78 2.12v3.14c0 .31.2.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z"/></svg>'
const ICON_SUN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
const ICON_MOON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/></svg>'
const ICON_SEARCH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>'

const homeUrl = (pid) => urlFor(ALL.find((p) => p.id === PRODUCTS.find((pr) => pr.id === pid).home))

// Product tabs → real links to each product's home page.
function topbarFor(activeProduct) {
  const tabs = PRODUCTS.map(
    (p) => `<a class="tb-tab${p.id === activeProduct ? ' active' : ''}" href="${homeUrl(p.id)}">${p.label}</a>`,
  ).join('')
  return (
    `<header class="topbar">` +
      `<div class="tb-left">` +
        `<a class="tb-brand" href="/">${OW_MARK}<span class="tb-name">Ownware</span><span class="tb-docs">Docs</span></a>` +
        `<div class="tb-tabs">${tabs}</div>` +
      `</div>` +
      `<button class="tb-search" id="searchbtn" type="button">${ICON_SEARCH}<span>Search docs…</span><kbd>/</kbd></button>` +
      `<div class="tb-right">` +
        `<a class="tb-icon" href="${GH_REPO}" target="_blank" rel="noopener" aria-label="GitHub repository">${ICON_GH}</a>` +
        `<button class="tb-icon tb-theme" id="themebtn" type="button" aria-label="Toggle theme"><span class="t-sun">${ICON_SUN}</span><span class="t-moon">${ICON_MOON}</span></button>` +
      `</div>` +
    `</header>`
  )
}

// Sidebars → real links; the active page + active product marked per page.
function sidebarsFor(activePageId, activeProduct) {
  return PRODUCTS.map((prod) => {
    const groups = prod.groups
      .map(
        (g) =>
          `<div class="navgroup"><h3>${g.title}</h3>${g.pages
            .map(
              (p) =>
                `<a class="navlink${p.id === activePageId ? ' active' : ''}" href="${urlFor(p)}">${p.nav}</a>`,
            )
            .join('')}</div>`,
      )
      .join('')
    return (
      `<nav class="sidebar" data-product="${prod.id}"${prod.id === activeProduct ? '' : ' hidden'}>` +
      `<div class="sb-head">${prod.tagline}</div>${groups}` +
      `<div class="sb-foot">Ownware · <code>docs.ownware.dev</code></div></nav>`
    )
  }).join('')
}

const searchOverlay =
  `<div class="search-modal" id="searchModal" hidden>` +
    `<div class="search-box">` +
      `<div class="search-in">${ICON_SEARCH}<input id="searchInput" type="text" placeholder="Search pages and sections…" autocomplete="off" spellcheck="false"><kbd>esc</kbd></div>` +
      `<div class="search-results" id="searchResults"></div>` +
    `</div>` +
  `</div>`

// theme-set-before-paint (avoids a flash of the wrong theme)
const THEME_BOOT = `<script>try{var t=localStorage.getItem('ownware-docs-theme');document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark')}catch(e){document.documentElement.setAttribute('data-theme','dark')}</script>`

function pageDoc(r) {
  const title = r.title === 'Ownware' ? 'Ownware Docs' : `${r.title} · Ownware Docs`
  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta charset="utf-8">` +
    `<title>${escapeHtml(title)}</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    (r.desc ? `<meta name="description" content="${escapeHtml(r.desc)}">` : '') +
    `<link rel="icon" href="/favicon.svg">` +
    `<link rel="stylesheet" href="/assets/theme.css">` +
    THEME_BOOT +
    `</head><body>` +
    OW_DEFS +
    topbarFor(r.product) +
    `<div class="shell"><button class="menubtn" id="menubtn" aria-label="Toggle navigation">Menu</button>` +
    sidebarsFor(r.page.id, r.product) +
    r.main +
    `</div>` +
    searchOverlay +
    `<script src="/assets/app.js" defer></script>` +
    `</body></html>`
  )
}

// ── write the site ───────────────────────────────────────────────────
rmSync(OUTDIR, { recursive: true, force: true })
mkdirSync(join(OUTDIR, 'assets'), { recursive: true })

writeFileSync(join(OUTDIR, 'assets', 'theme.css'), `${fonts}\n${tokens}\n${css}`)
writeFileSync(join(OUTDIR, 'assets', 'app.js'), `window.SEARCH=${JSON.stringify(SEARCH)};\n${appjs}`)

// favicon (the O mark, cobalt fill so it reads on any tab)
writeFileSync(
  join(OUTDIR, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="15 10 160 160"><defs><clipPath id="r"><path d="M25,90 A70,70 0 1 1 165,90 A70,70 0 1 1 25,90 Z M61,90 A34,34 0 1 1 129,90 A34,34 0 1 1 61,90 Z" fill-rule="evenodd" clip-rule="evenodd"/></clipPath></defs><g clip-path="url(#r)" fill="#93a9f9"><rect x="25" y="20" width="60" height="140"/>${[32, 46, 60, 74, 88, 102, 116, 130, 144].map((y) => `<rect x="83" y="${y}" width="90" height="7"/>`).join('')}</g></svg>`,
)

// publish llms.txt at the root for the AI-audience convention
try { copyFileSync(join(REPO, 'docs/llms.txt'), join(OUTDIR, 'llms.txt')) } catch {}

for (const r of rendered) {
  const out = join(OUTDIR, outFileFor(r.page))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, pageDoc(r))
}

console.log(`wrote ${rendered.length} pages → ${OUTDIR}`)
