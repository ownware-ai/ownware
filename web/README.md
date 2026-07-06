# Ownware marketing site (`web/`)

The landing page served at **ownware.dev** (the apex). Sibling to
[`website/`](../website) — the **docs** site at `docs.ownware.dev`. They are two
separate Cloudflare Pages projects that share the v2 design system and the
self-hosted brand fonts.

| | This (`web/`) | `website/` |
|---|---|---|
| Serves | `ownware.dev` (landing) | `docs.ownware.dev` (docs) |
| Pages project | `ownware-site` | `ownware-docs` |
| Source | `landing.html` (one self-contained file) | `../docs/*.md` |

## Layout

- **`landing.html`** — the whole page: markup, styles (design tokens inlined
  from the v2 system), and the canvas effects (particle logo, kinetic weave,
  orbiting tools). No build framework, no external requests.
- **`build.mjs`** — wraps `landing.html` in a full HTML document, adds the
  `<head>` (meta, self-hosted fonts, early theme-init), writes `public/index.html`.
- **`public/`** — what Pages serves: `index.html`, `ow-fonts.css`
  (self-hosted Instrument Sans + IBM Plex Mono, base64), `favicon.svg`, `_headers`.

`ow-fonts.css` and `favicon.svg` are copied from `../website`; refresh them if
the docs site's versions change.

## Build

```bash
cd web
node build.mjs        # → public/index.html
npx --yes serve public   # preview at http://localhost:3000
```

## Deploy (Cloudflare Pages)

`ownware.dev` is already on Cloudflare, so DNS + HTTPS wire up automatically once
the custom domain is attached.

```bash
node build.mjs
npx wrangler pages deploy public --project-name=ownware-site
```

First deploy creates the project and returns a `*.pages.dev` preview URL. To put
it on the apex: **Cloudflare dashboard → Workers & Pages → ownware-site →
Custom domains → Set up a custom domain → `ownware.dev`** (and `www.ownware.dev`).

Or connect this repo to Pages once (Workers & Pages → Create → Pages → Connect to
Git) with **build command** `node build.mjs`, **output directory** `public`, and
**root directory** `web` — then every push to `main` redeploys.
