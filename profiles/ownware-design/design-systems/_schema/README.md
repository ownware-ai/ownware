# Design-system catalog — folder contract

This directory is the **catalog** the `ownware-design` profile (and any other profile granted the `list_design_systems` / `apply_design_system` tools) reads at runtime. Each immediate subdirectory is one design system. The shape is fixed; the contract below is the source of truth for content authors and for the Cortex tool that scans this directory.

The runtime Zod schema lives in `@ownware/cortex` at `packages/cortex/src/connector/design-systems/manifest.schema.ts`. **That schema is the enforcement boundary.** This README documents the shape humans care about; the Zod schema is what fails the load if a manifest drifts.

---

## Folder shape

Every design-system folder ships exactly three files:

```
design-systems/<id>/
├── manifest.json        ← machine-readable catalog entry
├── DESIGN.md            ← prose: palette logic, type, density, when to use
└── tokens.css           ← :root { --… } block + minimal global resets
```

`<id>` is the folder name. It must be kebab-case (`modern-minimal`, `linear-inspired`), match `manifest.json.id` exactly, and be unique across the catalog. A folder with no `manifest.json` is ignored by the scanner — no exceptions.

No other files. A future `components.html` reference gallery may be added in v0.3; today the agent derives components from `DESIGN.md` + `tokens.css` directly.

---

## `manifest.json` — the wire contract

```ts
interface DesignSystemManifest {
  schemaVersion: 'ownware-design-system/v1'

  id: string                          // kebab-case, matches folder name
  name: string                        // display name, "Modern Minimal"
  category:
    | 'starter'
    | 'editorial'
    | 'minimal'
    | 'consumer'
    | 'tech'
    | 'experimental'
    | 'fintech'
    | 'data'
  surface: 'web' | 'mobile' | 'print' | 'deck'   // default 'web'
  summary: string                     // ≤ 140 chars, one line for marketplace cards
  swatches: string[]                  // 3–8 hex strings (e.g. "#2f6feb"), marketplace preview

  source:
    | { type: 'starter';   author: 'ownware' }
    | { type: 'imported';  upstream: string; license: string; modified: boolean }
    | { type: 'community'; contributor: string; license: string }

  files: {
    design: 'DESIGN.md'
    tokens: 'tokens.css'
  }
}
```

### Field-by-field

- **`schemaVersion`** — always the literal `"ownware-design-system/v1"`. Bumps to `v2` when the wire shape changes (breaking).
- **`id`** — `^[a-z0-9-]+$`. Must equal the folder name. The agent uses this when calling `apply_design_system({ id })`.
- **`name`** — display name. For brand-inspired entries, suffix `"-inspired"` (e.g. `"Linear-inspired"`) — see "Naming policy" below.
- **`category`** — primary placement on the marketplace grid. One of the eight values, no others. If your entry could fit two, pick the dominant one.
- **`surface`** — what the system is tuned for. Default `web`. Use `mobile` for systems with mobile-first density and ≥14px body; `print` for editorial-on-paper systems; `deck` for systems explicitly designed for 1920×1080 slides.
- **`summary`** — one line, ≤ 140 characters, lead with the feel + the canonical use case. "Clean, single-accent, B2B credibility" is better than "A nice clean design system for businesses."
- **`swatches`** — 3 to 8 hex colors used for the marketplace preview card. Order: background, surface, primary text, accent, then any others. Must be present in `tokens.css` `:root`.
- **`source`** — discriminated union; one of three shapes:
  - `starter` — authored from scratch by Ownware. No license metadata needed (covered by the marketplace repo's overall license).
  - `imported` — derived from an upstream open-source project. `upstream` is the upstream URL, `license` is the SPDX identifier (`Apache-2.0`, `MIT`, etc.), `modified` is `true` if we changed anything beyond folder layout (categorisation, summary text, token tuning, etc.). The `modified` flag is the Apache-2.0 §4(b) "prominent notice that you changed the files" marker.
  - `community` — contributed by a named external author. `contributor` is the credit string; `license` is the SPDX identifier they shipped under.

### Example: starter entry

```json
{
  "schemaVersion": "ownware-design-system/v1",
  "id": "modern-minimal",
  "name": "Modern Minimal",
  "category": "minimal",
  "surface": "web",
  "summary": "Clean, single-accent, B2B credibility. Linear / Stripe / Vercel zone.",
  "swatches": ["#fafafa", "#ffffff", "#111111", "#2f6feb", "#e5e5e5"],
  "source": { "type": "starter", "author": "ownware" },
  "files": { "design": "DESIGN.md", "tokens": "tokens.css" }
}
```

### Example: imported brand-inspired entry

```json
{
  "schemaVersion": "ownware-design-system/v1",
  "id": "linear-inspired",
  "name": "Linear-inspired",
  "category": "minimal",
  "surface": "web",
  "summary": "Restrained, single purple accent, geometric — dev-tool credibility.",
  "swatches": ["#fafafa", "#ffffff", "#0a0a0a", "#5e6ad2", "#e5e5e5"],
  "source": {
    "type": "imported",
    "upstream": "https://github.com/nexu-io/open-design",
    "license": "Apache-2.0",
    "modified": true
  },
  "files": { "design": "DESIGN.md", "tokens": "tokens.css" }
}
```

---

## `DESIGN.md` — the prose contract

The agent reads this file before writing an artifact. Five sections, in this order:

```markdown
# {Display name}

> Category: {category}
> {one-line summary, same as manifest.summary}

## 1. Visual theme & atmosphere
A paragraph or two. What does this design system feel like? Who is it for?
What's the signature move?

## 2. Color palette & roles
Bullets, with token name and the role each color plays.
- **Background** (`--bg`): used for...
- **Surface** (`--surface`): used for...
- **Accent** (`--accent`): used for...
- ...

## 3. Typography rules
- Font stack(s)
- Scale (px values for body / headings / display)
- Line heights and letter-spacing
- text-wrap rules (balance on headlines, pretty on body)

## 4. Spacing & density
- Section padding (desktop / mobile)
- Component padding (cards, buttons, inputs)
- Gutter widths

## 5. Signature moves & avoid list
- One paragraph: what this system does that others don't (the one decisive
  flourish per design).
- One short list: what NOT to do in this system (the slop tropes that
  break the vibe).
```

Keep it tight — most entries land at 60–120 lines. The agent doesn't need a marketing brochure; it needs decision-grade prose it can act on.

---

## `tokens.css` — the paste-ready contract

The file the agent literally pastes into the artifact's first `<style>` block. Shape:

```css
/* {Display name} — tokens.css
 * Reference: see ./DESIGN.md for rationale, role descriptions, signature moves.
 * Agents: paste the :root block verbatim into the artifact's first <style>
 * tag, then reference everything via var(--…) from then on.
 */

:root {
  /* surface ladder */
  --bg:        #...;
  --surface:   #...;
  --surface-2: #...;        /* optional, for layered cards */

  /* foreground ladder */
  --fg:        #...;
  --muted:     #...;
  --border:    #...;

  /* accent */
  --accent:        #...;
  --accent-hover:  #...;
  --accent-fg:     #...;

  /* semantic */
  --good: #...;
  --warn: #...;
  --bad:  #...;

  /* shape */
  --radius:      ...px;
  --radius-pill: ...px;

  /* typography */
  --font-display: "...", ...;
  --font-body:    "...", ...;
  --font-mono:    ui-monospace, ...;
}

/* optional minimal globals — only safe rules that work across every artifact */
*, *::before, *::after { box-sizing: border-box; }
```

**Rules:**

- The `:root` block is the only thing that **must** exist. Globals beyond `box-sizing` are optional and discouraged — they bleed into every artifact and can fight component CSS.
- Every token name from the "required ladder" above must exist; entries can add extra tokens (e.g. `--surface-2`, `--accent-soft`, `--shadow-sm`) but should not omit a required token. The Cortex scanner enforces this at load.
- No `@import`, no `url(...)` references. The file must paste cleanly into a `<style>` tag with no external dependencies.
- Comments are encouraged. The Apple-tokens-file convention of explaining non-obvious bindings (why this `--radius-pill` is 980px instead of 9999px, why this `--accent-hover` lifts instead of darkens) helps the agent reason about edits.

---

## Naming policy

### Folder ids

Kebab-case, descriptive, no brand verbatim. Examples:

- ✅ `modern-minimal`, `warm-soft`, `tech-utility`
- ✅ `linear-inspired`, `stripe-inspired` (brand-derived, suffix says so)
- ❌ `Modern_Minimal`, `ModernMinimal` (wrong case)
- ❌ `linear` (verbatim brand — see policy below)

### Brand-inspired display names

When an entry is derived from a recognisable brand's published surface, suffix the **display name** with `-inspired`:

- `id: "linear-inspired"`, `name: "Linear-inspired"`
- `id: "stripe-inspired"`, `name: "Stripe-inspired"`

This keeps two things honest:

1. **Trademark hygiene.** We are not Linear; we are not authorised by Linear; we are not claiming to reproduce Linear's product surface. We are shipping a design system *inspired by* their published external style.
2. **User intent.** When the user says "make it Linear-like," the agent can match on summary text and folder id and confirm with the user — the catalog grows on user intent without overclaiming authorship.

Catalog search (`list_design_systems({ search: "linear" })`) matches on `id`, `name`, and `summary`, so the suffix doesn't hurt discoverability.

### Starter names

Starter entries (Ownware-authored, no upstream) use neutral category-flavored names:

- ✅ `modern-minimal`, `editorial-monocle`, `warm-soft`, `tech-utility`, `brutalist-experimental`

Names should describe the feel, not a brand.

---

## Scanner behaviour (informative — defined in Cortex)

The Cortex `list_design_systems` / `apply_design_system` tools scan this directory:

1. Read every immediate subdirectory of `design-systems/`.
2. For each, load `manifest.json`. If missing or invalid (Zod fails), skip with a one-line warning.
3. For `list`, return manifest summary fields only (id, name, category, swatches, summary). Light, cheap, ~150 entries in a few hundred bytes.
4. For `apply({ id })`, additionally read `DESIGN.md` and `tokens.css`, pre-extract the `:root { ... }` block from `tokens.css`, and return everything in one tool result.
5. Both tools cache results for the lifetime of a Ownware session; the cache invalidates on file change (gateway SSE).

The scanner does **not** modify any catalog file. The catalog is read-only at runtime.

---

## Adding a new entry — the checklist

1. Pick a kebab-case `id` that doesn't collide with an existing folder.
2. `mkdir design-systems/<id>/`.
3. Write `manifest.json` matching the schema above.
4. Write `DESIGN.md` (60–120 lines, five sections in order).
5. Write `tokens.css` (the `:root` block + optional `box-sizing` global, that's it).
6. If `source.type === 'imported'` or `'community'`, ensure `NOTICE.md` at the repo root has a section covering this upstream / contributor.
7. Open a PR. CI runs Cortex's manifest validator across every folder; a Zod failure blocks the merge.

Adding 50 entries in one PR is fine. Each is independent.

---

## What does NOT go in this directory

- Code. This is content-only per the repo's top-level policy.
- Stylesheets that aren't `tokens.css`. Component libraries, framework presets, etc. — those belong in skills, not in the catalog.
- Per-folder README files. The `DESIGN.md` is the README; a duplicate is drift.
- Images. The marketplace surfaces use `swatches` for preview; if a future entry needs an illustrative image (mood board, screenshot of an artifact built with the system), that goes in a `previews/` subdir and is referenced from `DESIGN.md` — but defer that decision until v0.3 or later.
