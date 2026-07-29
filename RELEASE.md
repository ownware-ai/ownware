# Releasing Ownware

How versions, changelogs, and npm publishing work in this repo — and how the
docs website deploys separately. This is the canonical process; follow it for
every release.

## TL;DR

```bash
# 1. While developing — record every meaningful change:
bun run changeset                 # pick patch/minor/major + write a one-line summary

# 2. When ready to cut a release:
bun run release:version           # consumes pending changesets + regenerates CHANGELOGs
git add -A && git commit -m "Release vX.Y.Z" && git push

# 3. Publish to npm (all public packages, right order, one command):
bun run release:publish           # or release:dry-run to rehearse

# 4. Confirm it's live:
npm i -g ownware && ownware --version
```

The website (Cloudflare) is **not** part of this — see [The docs website](#the-docs-website-separate-lifecycle).

---

## Versioning strategy: semver, a fixed core plus independent clients

The five published packages — `ownware`, `@ownware/loom`, `@ownware/cortex`,
`@ownware/client`, `@ownware/shuttle` — are **version-locked**: they always share
one version number and are released together, even if only one changed. They're a
tightly-coupled kit; a user who has `ownware@0.3.0` should get `@ownware/cortex@0.3.0`.
This is configured as a `fixed` group in `.changeset/config.json`.

The public client-surface packages — `@ownware/ui`, `@ownware/react`, and
`@ownware/cli` — version independently. They depend on the fixed core but do
not force a core release for a renderer-only or terminal-only change.

We follow [semantic versioning](https://semver.org):

| Bump | When | Example |
|---|---|---|
| **patch** | Bug fix, docs, internal change — no API change | `0.1.0 → 0.1.1` |
| **minor** | New feature, backwards-compatible | `0.1.0 → 0.2.0` |
| **major** | Breaking change to a public API | `0.1.0 → 1.0.0` |

Pre-1.0 (where we are now), treat **minor** as "could break something" — that's the
semver convention while `0.x`.

## How the version number is picked — you don't hand-edit it

This is the part people get wrong by bumping `package.json` by hand. **You never
edit version numbers manually.** Instead:

1. With each change, you run `bun run changeset` and declare the *bump type*
   (patch/minor/major) and a human summary. This writes a small markdown file into
   `.changeset/` that you commit alongside your code.
2. At release time, `bun run release:version` reads **all** pending changeset
   files, takes the **highest** bump for the five-package fixed core, computes
   independent bumps for the client-surface packages, and updates affected
   manifests. The changeset files are consumed (deleted) in the process.

So the version is *derived* from the changes, automatically. This is how Astro,
Remix, Emotion, and most modern npm monorepos work.

## How the changelog is generated — automatically, before publish

You don't write `CHANGELOG.md` by hand either. Each changeset's summary line *is* a
changelog entry. When you run `bun run release:version`, Changesets:

- groups the pending changesets,
- writes/updates **`CHANGELOG.md` in each affected package** with the new version
  heading and the bullet points from the changesets,
- and does it **before** you publish, as a normal git commit you review.

So the sequence is: *changesets accumulate → `release:version` turns them into
version bumps + changelog entries → you commit → you publish the already-changelogged
packages.* The changelog is never a separate manual step at publish time.

> The root `CHANGELOG.md` is a hand-curated human summary of headline changes; the
> per-package `CHANGELOG.md` files are the Changesets-generated detail. (Optional
> upgrade: switch the `changelog` generator in `.changeset/config.json` to
> `@changesets/changelog-github` for auto-linked PR/author references — needs a
> `GITHUB_TOKEN`.)

## Publishing — one ordered pass, not package-by-package by hand

You do **not** `cd` into each package and publish it manually. `bun run release:publish`
runs `scripts/publish-packages.mjs`, which publishes every public package **in
dependency order**:

```
loom ────────────────→ cortex ──→ ownware ──→ cli
client ──→ react
   │      ↑
   ├────→ shuttle
   └────────────────────────────→ cli
ui ─────→ react ────────────────→ cli
```

(each package's internal deps are already on npm before it publishes). It uses
**`bun publish`**, not `npm publish` — because `bun` rewrites the `workspace:*`
dependency ranges to the concrete version (for example `0.4.0`), while `npm publish` would ship
the literal `workspace:*` and break every install. This is verified: `bun run
release:dry-run` packs all eight and shows exactly what would ship, publishing nothing.

The dependency-free `@ownware/ui` package intentionally publishes first. On its
first publication, that verifies the account can create packages in the
`@ownware` scope before any existing package version is changed.

Publishing is **irreversible** — a published version can never be overwritten (only
superseded by a higher one). Always `release:dry-run` first if unsure.

Stable versions publish under npm's `latest` tag. Versions containing a
prerelease suffix such as `0.4.0-beta.0` publish under `next`, so an experimental
release cannot silently replace the default installation.

## First publication of a new package

A package may first reach npm at a version later than `0.1.0`; its committed
manifest and changelog remain authoritative. Commit a clean versioned tree, run
the dry-run, then use the same ordered `release:publish` command. Never publish a
workspace package by hand.

## Pre-publish checklist (every release)

- [ ] `git status` clean — you publish the working tree's built `dist/`, so commit first.
- [ ] `bun run build && bun run typecheck && bun run test && bun run smoke` all green.
- [ ] `npm whoami` shows your account, and it has `read-write` access to an
      existing scoped package (`npm access list collaborators @ownware/cortex`).
      For first-time scoped names, also confirm org membership; a restricted
      token may forbid `npm org ls ownware` even when package writes are allowed.
- [ ] First-time package names (`@ownware/ui`, `@ownware/react`, `@ownware/cli`)
      are available to that account.
- [ ] `bun run release:dry-run` looks right (correct files, concrete dep versions).
- [ ] Then `bun run release:publish`, then `npm i -g ownware && ownware --version`.

## Automated releases (set up — how the big projects do it)

The [Changesets GitHub Action](https://github.com/changesets/action) is wired up in
[`.github/workflows/release.yml`](.github/workflows/release.yml).

**Right now the workflow is set to a MANUAL trigger (`workflow_dispatch`)** so nothing
publishes before you intend it to. Run it from **Actions → Release → Run workflow**:
- with pending changesets → it opens/updates a **"Version Packages" PR** (no publish);
- with none → it publishes any not-yet-published versions to npm.

**After you've published the first `0.1.0`** and want fully-automatic releases, edit
`release.yml` and swap the trigger to `push: { branches: [main] }`. That's safe once
`0.1.0` is out because `scripts/publish-packages.mjs` **skips versions already on npm** —
so a normal push publishes nothing, and only a merged Version-Packages PR (which bumps to a
new, unpublished version) actually triggers a publish. That's the hands-off flow:

1. You merge PRs to `main`, each carrying its changeset(s).
2. The workflow keeps a **"Version Packages" PR** up to date.
3. Merging that PR publishes the new version to npm. No local commands.

**One-time setup — add the `NPM_TOKEN` secret:**
1. npmjs.com → your avatar → **Access Tokens** → **Generate New Token** → **Automation**
   (works with 2FA in CI). The account must be a member of the `ownware` org.
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret** →
   name it `NPM_TOKEN`, paste the token.

That's the only thing the workflow needs from you; `GITHUB_TOKEN` is provided automatically.

> The workflow publishes correctly (via our `bun publish` script), but it does **not** yet
> auto-create GitHub Releases/tags (our custom publish script doesn't emit the machine-
> readable lines the action parses for that). The npm publish is what matters; GitHub
> Releases can be added later if you want them.

The **manual** flow above still works anytime (`bun run release:publish` locally) — useful
for the first `0.1.0` and as a fallback.

---

## The docs website (separate lifecycle)

The `website/` folder (`ownware-docs-site`) is a **Cloudflare Pages** site — **not**
an npm package. It's `private: true`, it's **not** in the root workspaces, and it is
**never** versioned or published to npm. It has its own `bun.lock` and deploys on its
own cadence:

```bash
cd website
bun run build                                                   # → website/dist
npx wrangler pages deploy dist --project-name=ownware-docs       # deploy
```

Or connect the GitHub repo to Cloudflare Pages once, and every push to `main` auto-builds
and deploys `website/dist` — no manual command.

**Its "version" is just the git commit that's deployed** — continuous deployment, not
semver. If you want the site to *display* the current package version (e.g. "v0.1.0" in
the footer), it can read it from `packages/ownware/package.json` at build time in
`build-site.mjs` — but that's a display value, not a release artifact.

So, two independent lifecycles:

| | npm packages | docs website |
|---|---|---|
| Versioned (semver)? | **Yes** — fixed, shared | No — deployed commit |
| Released how? | `bun run release:publish` | `wrangler pages deploy` / auto on push |
| Changelog? | Per-package, Changesets-generated | n/a (git history) |
| Cadence | Deliberate, tagged releases | Continuous |
