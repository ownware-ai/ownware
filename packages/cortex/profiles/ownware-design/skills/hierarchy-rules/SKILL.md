---
name: hierarchy-rules
description: 'The visual-weight rules that make hierarchy actually land — one dominant element per surface, six levers ranked by leverage, three failure modes to avoid. Use when a layout feels "flat" or "everything competes," when /critique scores hierarchy ≤ 3, or before building a hero. Pairs with /typography-system (type as weight) and /critique (the audit rubric this skill answers to). Skip when the layout already has obvious primary→secondary→tertiary read order — don''t fix what isn''t broken.'
trigger: /hierarchy-rules
---

# Hierarchy Rules — six levers, one dominant per surface, three failure modes

## Overview

Hierarchy is the difference between a page where the eye lands in 3 seconds and a page where the eye bounces. Most "flat" artifacts aren't flat because the designer forgot hierarchy — they're flat because three or four elements all compete for primary attention. The fix isn't "more contrast everywhere." It's picking ONE dominant element per surface, ranking everything else as secondary, and using the right lever for the demotion.

This skill encodes the discipline: six levers (size, weight, color contrast, spacing, alignment, motion) ranked by leverage; the "primary read in 3 seconds" test; the "one dominant element per surface" rule; three named failure modes. Use it before building a hero, or when `/critique` scored hierarchy ≤ 3 and you need to find the fix.

Pair with `/typography-system` (where size and weight live as tokens) and `/critique` (the audit rubric that catches when hierarchy is broken).

---

## Critical Constraints

1. **One dominant element per surface.** A surface = a page, a section, a card, a modal. ONE thing must be primary. Two primaries = no primary; the eye picks neither and the visitor leaves.
2. **The 3-second test.** A fresh visitor lands on the surface. Within 3 seconds, can they answer: "what is this for?" If the answer is "I don't know — let me read everything," the hierarchy failed.
3. **Hierarchy levers are not equal.** Size + spacing carry the most leverage (you can feel them across the whole page). Color contrast and weight come next. Alignment and motion are tiebreakers, not foundations. Reach for the heavy levers first.
4. **Never rely on color alone.** Color-only hierarchy fails for: greyscale print, screenshot-to-blog usage, 8% of men with red-green colorblindness, OLED-burn-in dimming, dark/light mode swap. Pair color with size/weight/position.
5. **Demote, don't decorate.** When two elements compete, demote the secondary one — make it smaller, less bold, more muted. The fix is rarely "make the primary even bigger" (that just inflates the page). It's "make the competition smaller."
6. **The primary survives a thumb-blur.** Squint at the page until detail blurs. The primary element should still pop. If three blocks all stay equally visible at a squint, the hierarchy is broken.

---

## Framework — six levers ranked by leverage

### Lever 1 — Size (highest leverage)

The single most powerful hierarchy tool. A 64px headline next to 18px body is hierarchical at a glance. Make the primary 2-4× the next element by area.

| Surface type | Primary size | Secondary size | Body size |
|--------------|--------------|----------------|-----------|
| Marketing hero | 48-72px (h1) | 18-22px (subhead) | 16px |
| Editorial article | 48-64px (h1) | 24-28px (h2) | 18px |
| Dashboard | 24-28px (page title) | 18-20px (panel title) | 14-16px |
| Card | 18-22px (card title) | 14-16px (card body) | 12-14px (meta) |

### Lever 2 — Spacing (high leverage)

Whitespace isolates. An element with 80px of breathing room around it dominates an element packed into a 24px gap. Use space as the second strongest demotion: when you can't make the primary bigger, push the secondaries closer to other secondaries and isolate the primary.

Rule of thumb: the primary element gets 1.5-2× the spacing of secondaries. A hero h1 with 80px below it, followed by a subhead with 48px below the subhead, then the CTA with 32px to the next block.

### Lever 3 — Color contrast (mid leverage)

A 14:1 fg/bg ratio on the primary, 5:1 on secondaries, 3:1 on tertiary metadata. Color contrast pulls the eye toward the dense-ink element. Use it to demote: a muted gray label vanishes; a black headline arrests.

But: color carries semantic weight too (accent = "this is the action"). Don't let semantic color fight hierarchy — a violet CTA next to a black h1 are TWO primaries unless one is much bigger than the other.

### Lever 4 — Weight (mid leverage)

Font-weight 700 on the primary, 500 on subheads, 400 on body. Weight reads at a glance — bolder = more important. Avoid the trap of "everything bold" — when weight is uniform, weight stops being a hierarchy signal.

### Lever 5 — Alignment (low leverage, sets tone)

Centered = ceremonial, formal. Left-aligned = workmanlike, fast. Right-aligned = rare, reserved for numerals (price tables, financial figures).

Alignment doesn't *create* hierarchy — but it reinforces it. A centered h1 on a left-aligned page is the primary by virtue of being the only centered element.

### Lever 6 — Motion (lowest leverage, easiest to overuse)

A subtle motion on one element (the live-dot pulse, the CTA breathing, the hero headline reveal on load) draws the eye. But: motion is a finite resource. Three animated elements on the same page = none of them dominates.

Use motion as a hierarchy lever ONLY when one element should be the only thing animating. Otherwise, motion lives at the system level (transitions on hover) and doesn't participate in hierarchy.

---

## The "primary read in 3 seconds" rubric

Score the surface on three questions. Each scored 1-5.

1. **Single primary?** 5 = one element is obviously dominant. 3 = two elements compete weakly. 1 = three or more compete; nothing dominant.
2. **Secondary clear?** 5 = secondary elements are clearly secondary by size/weight/color/spacing. 3 = secondaries drift into the primary's visual weight. 1 = no demotion; everything is equal.
3. **Tertiary recedes?** 5 = metadata, labels, footnotes recede into `--muted`. 3 = tertiary content competes with secondaries. 1 = no muting; every word at full ink.

If any question scores ≤ 3, fix it. The fix is almost always: demote the competition, not inflate the primary.

---

## Three named failure modes

### Failure 1 — Competing primaries

Two or more elements at the same visual weight asking for attention. Common pattern: a 56px h1 next to a 56px hero image with a face. The eye doesn't know where to go.

**Fix:** demote one. If the image is the primary, drop the h1 to 32px and treat it as a subhead. If the headline is primary, treat the image as supporting (smaller, lower contrast, behind/beside the type).

### Failure 2 — Decorative-not-meaningful contrast

A bright accent color used everywhere — primary CTA, ribbon, badge, link, callout, decorative divider. By the time the visitor reaches the actual primary CTA, the accent has lost its signal value.

**Fix:** reserve the accent for ONE role per surface — the primary CTA, or the active state, or the brand callout. Use neutrals (border, muted text, surface) for everything else. The accent earns its signal value back when it's rare.

### Failure 3 — Hierarchy by color only

The primary is "the violet one." Take a screenshot in greyscale, and the primary disappears — it was carrying weight from color alone, with no support from size, weight, or spacing.

**Fix:** check the page in greyscale (`filter: grayscale(1)` in DevTools). If the primary still pops, the hierarchy is multi-lever and robust. If everything goes flat, the hierarchy was color-only — re-introduce size, weight, or spacing as the load-bearing lever.

---

## Concrete examples

### Example 1 — Landing page with ONE primary, one secondary, one tertiary

**The working version:**

```html
<section data-cx-id="hero" class="hero">
  <h1 class="hero-h1">Ship faster with Acme</h1>
  <p class="hero-sub">The deploy platform engineers actually like.</p>
  <div class="hero-actions">
    <a class="btn-primary" href="#start">Start free</a>
    <a class="link-tertiary" href="#demo">Watch a demo →</a>
  </div>
</section>
```

```css
.hero-h1 {
  font-size: 64px;        /* PRIMARY — size lever */
  font-weight: 700;       /*           weight lever */
  color: var(--fg);       /*           contrast lever (14:1) */
  line-height: 1.05;
  letter-spacing: -0.02em;
  margin-bottom: 24px;    /*           spacing lever — 80px below the block */
  max-width: 18ch;
}

.hero-sub {
  font-size: 18px;        /* SECONDARY — 3.5× smaller than h1 (clearly demoted) */
  font-weight: 400;
  color: var(--muted);    /*             contrast 5:1 (visibly demoted) */
  line-height: 1.5;
  max-width: 56ch;
  margin-bottom: 40px;
}

.btn-primary {
  font-size: 16px;
  font-weight: 500;
  padding: 14px 24px;
  background: var(--accent);  /* SECONDARY (action) — color earns it */
  color: var(--accent-fg);
  border-radius: 8px;
}

.link-tertiary {
  font-size: 16px;
  color: var(--muted);    /* TERTIARY — receded into muted */
  margin-left: 24px;
}
```

**Why it works:** h1 dominates by size (64px vs 18px sub vs 16px CTA = 4×, 4× respectively), by weight (700 vs 400), by contrast (14:1 vs 5:1), and by space (80px breathing room below). The CTA is secondary — important for action, demoted in visual weight (smaller than h1, same color-saturation but color is doing the semantic "act here" work). The "Watch a demo →" link is tertiary — same size as CTA but muted color and no background — clearly the lesser option.

**What would break it:**

- **Sub at 32px instead of 18px:** subhead competes with h1 size-wise. Fix: drop sub to 18px (which is what we have).
- **CTA in violet AND sub in violet:** two violet hits compete. Fix: keep CTA violet (semantic), sub in `--muted`.
- **"Watch a demo" styled as a button (border + padding):** two buttons read as two equally-weighted CTAs. Fix: make secondary action a text link, not a button. Linear / Stripe pattern.

### Example 2 — Dashboard with primary KPI dominating peer stats

Brief: an observability dashboard. The "Uptime 99.98%" stat is the primary; four peer stats are secondary; the timestamp is tertiary.

```html
<section data-cx-id="primary-kpi" class="primary-kpi">
  <p class="kpi-label">Uptime · last 30 days</p>
  <p class="kpi-value">99.98%</p>
  <p class="kpi-delta">+0.02% vs prior 30 days</p>
</section>

<section data-cx-id="peer-kpis" class="peer-kpis">
  <article class="peer-kpi">
    <p class="peer-label">P50 latency</p>
    <p class="peer-value">142ms</p>
  </article>
  <article class="peer-kpi">…</article>
  <article class="peer-kpi">…</article>
  <article class="peer-kpi">…</article>
</section>

<p class="updated">Updated 14:32 UTC</p>
```

```css
.primary-kpi {
  padding: 48px;
  margin-bottom: 32px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
}
.kpi-label { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 8px; }
.kpi-value { font-size: 80px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; color: var(--fg); font-variant-numeric: tabular-nums; }
.kpi-delta { font-size: 14px; color: var(--good); margin-top: 12px; }

.peer-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.peer-kpi { padding: 24px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
.peer-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.peer-value { font-size: 28px; font-weight: 600; letter-spacing: -0.01em; color: var(--fg); margin-top: 8px; font-variant-numeric: tabular-nums; }

.updated { font-size: 12px; color: var(--muted); }   /* tertiary — receded */
```

**Why it works:** 80px primary value vs 28px peer values = ~3× ratio. Primary card has 48px padding vs peer 24px — bigger physical footprint. Primary sits in its own row, isolated by 32px gap. The peer row is below, in a 4-up grid, signaling "these are siblings of each other, and all are subordinate to the primary above." Tertiary timestamp is 12px in `--muted` — recedes entirely.

**Greyscale test:** in greyscale, the primary still dominates by size + padding alone. Color is decorating, not load-bearing. Robust hierarchy.

---

## Anti-patterns

- **Three equal CTAs in a hero ("Start free", "Watch demo", "Contact sales").** Stop. The user can't pick. One primary CTA (the path you want them on). One secondary text link (the alt path). Cut the third or move it to the footer.
- **Inflating the primary instead of demoting the competition.** A 56px h1 doesn't pop next to a 56px hero image. The reflex is "bump h1 to 80px" — wrong. The fix is demote the image (smaller, less saturated, behind the type), keeping h1 at 56px. Inflation runs out of road; demotion is unbounded.
- **Using the accent color on five different roles in one section.** Headline accent, button accent, badge accent, divider accent, link accent — five hits on the same hue. By the time the visitor reaches the CTA, the accent has lost its meaning. Reserve the accent for one role at a time.
- **Hierarchy by italic, underline, or shadow alone.** Underline says "link." Italic says "emphasis." Shadow says "elevation." None of them say "primary." Use size + weight + spacing for hierarchy; reserve the small typographic moves for their established meanings.
- **Bold everything to make it look "designed."** When 60% of the page is bold, bold stops signaling importance. Keep bold for h1/h2 and primary CTA. Body is 400. Subhead is 500. h2 is 600. h1 is 700. The ramp earns the weight.
- **Animated everything to "feel premium."** A page where the hero h1 reveals, the cards stagger, the icons pulse, AND the CTA breathes is a page where motion no longer signals priority. Pick ONE element to be the moving thing. Hold the others still.
- **Centering everything.** Centered alignment is ceremonial; left-alignment is workmanlike. A whole page centered reads as a wedding invitation. Pick the few centered moments (hero, CTA, section labels) and let body content stay left-aligned.
- **Forgetting the greyscale check.** Stop. Before declaring hierarchy done, set `filter: grayscale(1)` on `body` in DevTools. If the primary disappears, hierarchy was color-only — re-introduce size, weight, or spacing as the load-bearing lever.
