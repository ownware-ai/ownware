# Ownware Design — skills

This folder holds the skill catalogue the Designer profile loads at
startup. Each subfolder is one skill: `SKILL.md` with YAML frontmatter
(`name`, `description`, `trigger`) followed by the skill body.

The catalogue is shipped as part of the Designer agent's system prompt
— every turn, the agent sees one line per skill summarizing what it
does and when to reach for it. Bodies are reserved for sub-agent grants
today; a proposed runtime fix will inject bodies into the parent
agent's prompt.

## Anchor skills

Five anchor skills were shipped before A4 and define the voice every
new skill matches:

- `artifact` — the canonical HTML artifact file shape.
- `discovery` — the early-conversation locking pass.
- `critique` — the 5-dimension self-audit run before declaring done.
- `deck` — slide-deck variant of `artifact`.
- `tweaks` — the runtime variation panel skill.

## Provenance of the 95 new skills

The 95 new skills (catalog = 5 anchor + 95 new = 100 total) split into
two distinct provenance buckets:

### Bucket A — Inspired by open-design (Apache-2.0): 65 skills, batches 1-12

A subset of the catalogue was inspired by patterns observed in
[open-design](https://github.com/nexu-io/open-design) (Apache License
2.0, January 2004). Slugs are renamed to Ownware-native forms; all
text in this folder is original to Ownware. We studied open-design's
structures — how it framed dimensions, the kinds of frameworks it
catalogued, the surface-specific affordances it documented — and
rebuilt under our own framing per RULES.md R7 ("study patterns, write
our own under our own names").

No `od-` / `OpenDesign` / `FileViewer` / `od:` namespace artifacts
appear in any of these skills. Where open-design's anchor convention
was `data-od-id`, we use `data-cx-id`. Where open-design surfaced
vendor-locked tooling (fal-*, runway-*, replicate-*, figma-*), we
either deferred (image / video / TTS skills wait on Slice 7.5) or
skipped entirely.

### Bucket B — Ownware net-new domain skills: 30 skills, batches 13-17

After the substantive open-design pool was exhausted (Batch 12), the
catalogue filled real Designer gaps with 30 net-new skills written
from domain knowledge — typography-system, layout-grids,
responsive-system, motion-system, whitespace-system, hierarchy-rules,
dark-mode-craft, icon-system, accessibility-audit, dashboard-patterns,
hero-patterns, pricing-tables, testimonial-design, data-table-design,
forms-craft, navigation-patterns, search-design, filter-pattern,
mobile-bottom-nav, state-empty-loading-error, error-messaging,
microinteractions, onboarding-flows, notification-design,
empty-state-craft, email-design, print-export, chat-ui-design,
mobile-touch-design, localization-rules. No upstream source; each
sub-agent wrote from domain knowledge against the anchor voice.

## Adding a new skill

1. Create a folder `<slug>/` under this directory.
2. Add `SKILL.md` with this frontmatter shape (cortex's loader is
   strict — verified at `packages/cortex/src/profile/loader.ts:301-308`):

   ```
   ---
   name: <slug>
   description: <one paragraph, ≤500 chars, includes when to use + when NOT to use, point at the adjacent skill if better-suited>
   trigger: /<slug>
   ---
   ```

   NO `triggers:` array (open-design's plural — silently ignored, smells
   of upstream). NO `od:` namespace block. NO any other top-level YAML key.

3. Body discipline (every skill — 5 sections in this order):

   - `# <Name> — <subtitle>` — H1 with a punchy tagline.
   - `## Overview` — 2-4 lines. WHAT + WHEN + the adjacent skill it does NOT replace.
   - `## Critical Constraints` / `## Framework` / `## Rubric` — numbered prescriptive list of SPECIFIC instructions, not vague principles.
   - `## Concrete examples` — minimum TWO real worked examples with actual values, code snippets, copy.
   - `## Anti-patterns` — "if reaching for X, stop. Do Y instead."

   Length: 80-200 lines body. Tighter beats looser. The anchor skills
   are 135-250 lines for reference.

4. Run the e2e sanity from repo root:

   ```bash
   cd packages/cortex && bunx vitest run tests/e2e/skills-fire.test.ts
   ```

   The first two specs (loader sanity + catalog rendering) run without
   an API key. The 4 LLM specs need `OPENROUTER_API_KEY` and cost
   ~$0.012 total against Haiku 4.5.
