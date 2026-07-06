// Ownware marketing site — build step.
// Wraps the self-contained landing fragment (landing.html) into a full HTML
// document in public/, linking the self-hosted brand fonts. No dependencies.
//
//   node build.mjs      →  writes public/index.html
//
// The fragment is the same artifact shape used for previews; here we add the
// <head> (meta, self-hosted fonts, early theme-init to avoid a flash) and the
// <html>/<body> shell. public/ is what Cloudflare Pages serves.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, 'landing.html'), 'utf8')

// The fragment is:  <title>…</title>\n\n<style>…</style>\n\n<markup>\n<script>…
// Split just after the first </style> — everything before it (title + style)
// belongs in <head>; everything after (markup + scripts) belongs in <body>.
const marker = '</style>'
const cut = src.indexOf(marker)
if (cut === -1) throw new Error('landing.html: no </style> found — unexpected shape')
const head = src.slice(0, cut + marker.length)
const body = src.slice(cut + marker.length)

const DESC = 'Ownware is the open kit for building your own AI agent — self-hosted, any model, alive in Slack, your website, your app, and scheduled every morning. You own all of it.'

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${DESC}">
<link rel="canonical" href="https://ownware.dev/">
<meta property="og:type" content="website">
<meta property="og:url" content="https://ownware.dev/">
<meta property="og:title" content="Ownware — build your agent once, alive everywhere">
<meta property="og:description" content="${DESC}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.svg">
<script>try{document.documentElement.dataset.theme=localStorage.getItem('ownware-theme')||'dark'}catch(e){}</script>
<link rel="stylesheet" href="/ow-fonts.css">
${head}
</head>
<body>
${body}
</body>
</html>
`

writeFileSync(join(here, 'public', 'index.html'), html)
console.log('✓ wrote public/index.html (' + (html.length / 1024).toFixed(1) + ' KB)')
