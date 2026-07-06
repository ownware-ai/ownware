# Ownware documentation site

The public docs site. A **small static generator** (`build-site.mjs`, ~one file,
deps: `marked` + `highlight.js`) that renders the markdown in
[`../docs`](../docs) into a multi-page website using the v2 design system
(Carbon/Bone/Cobalt, the "O" mark, Instrument Sans + IBM Plex Mono). Deploys to
**Cloudflare Pages** at **docs.ownware.dev**.

Chosen over an off-the-shelf framework so the site is pixel-for-pixel our own
design (the Ownware/Engine product switcher, code-in-the-carbon-well, page
actions, etc.) rather than a themed template.

## What it produces

- One real HTML page per doc at its own URL (`/agents/overview/`, `/engine/security/`, …)
- Shared cached assets: `assets/theme.css` (fonts + tokens + styles), `assets/app.js` (search + interactions)
- `favicon.svg` and `llms.txt` at the root
- Client-side search, dark/light toggle, Copy page / Download markdown, clickable GitHub source links

**Edit the docs in [`../docs`](../docs)** — this folder only styles + assembles them.

## Run locally

```bash
cd website
npm install
npm run build      # → dist/  (the static site)
npm run serve      # build + serve dist/ locally
```

## Deploy to Cloudflare

> **The one setting that matters: Root directory = `website`.** This is a bun
> **monorepo**. If Cloudflare's root directory is the repo root, it runs the
> whole-platform `bun run build` (building loom/cortex/… packages) and then
> `wrangler deploy` fails with *"run in the root of a workspace instead of
> targeting a specific project."* Pointing the root directory at `website/`
> makes it build **only the docs site**, and `wrangler.jsonc` here targets
> `./dist`.

1. Push the repo to GitHub. Private is fine. (The docs' "View source" links only
   resolve for visitors if the repo is public.)
2. Cloudflare dashboard → **Workers & Pages → Create** → **Import a repository**
   → pick the repo.
3. Build configuration:
   - **Root directory:** `website`   ← **required**
   - **Build command:** `npm run build`   (produces `dist/`)
   - **Deploy command:** `npx wrangler deploy`   (uses `wrangler.jsonc` → `./dist`)
   - **Environment variable:** `NODE_VERSION` = `20`
4. Deploy. Every push to `main` now rebuilds and redeploys.
5. Project → **Settings → Domains & Routes → Add** → `docs.ownware.dev`
   (ownware.dev is already on Cloudflare, so it wires DNS + HTTPS automatically).
6. Add `[Documentation](https://docs.ownware.dev)` to the repo README.

### Prefer Cloudflare Pages instead of Workers?

Same idea, no wrangler: Workers & Pages → **Create → Pages → Connect to Git**,
**Root directory** `website`, **Build command** `npm run build`, **Output
directory** `dist`, `NODE_VERSION=20`. The `wrangler.jsonc` is ignored by Pages.

## Notes

- Requires **Node ≥ 20.11** (uses `import.meta.dirname`).
- The design tokens live in `ow-tokens.css` (a copy of
  `.catalyst/design-system-v2/tokens.css`, kept here so the build is
  self-contained and doesn't depend on the non-shipped `.catalyst/` tree).
