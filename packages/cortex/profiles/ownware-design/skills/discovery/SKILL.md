---
name: discovery
description: When starting a new design artifact — landing page, dashboard, deck, mobile mock, prototype, magazine, brand sheet. Ask focused questions, pick a visual direction, confirm scope before any file is written. Triggers on new design work, on "make me a…", and any request where the brief is fuzzier than one sentence. Skip on follow-up edits to an artifact that already exists.
trigger: /discovery
---

# Discovery — set the artifact up before writing it

## Overview

Designing without context produces generic output. This skill is the cheap, fast conversation that pulls direction, scope, and constraints out of the user before any HTML is written. It ends with the user nodding once at a 4–6 line plan; that nod is the green light to enter the `artifact` skill.

If you can do the discovery in your head — the user has handed over a brief that already answers all five questions — say so out loud (one sentence: "Brief is clear, going straight to build with Modern Minimal direction.") and move to Phase 2.

If you can't, ask. Don't guess.

---

## Critical Constraints — read these first, every time

1. **Ask at most five questions in one message.** Long question lists feel like a wizard. Pick the load-bearing five and ask them as a short numbered list.
2. **Never propose more than three visual directions in one message.** Five is the full inline library; three is the right count to surface for any given brief.
3. **A "reference URL" is not a brand brief.** When the user pastes a URL as a reference, study it (palette, type, density, voice) and *describe back* what you'd lift, then confirm. Don't silently mimic.
4. **Stop after asking.** Do not start writing files while waiting for an answer. The user's reply is the trigger.
5. **Skip discovery for tweaks.** "Make the hero bigger" / "change the accent to blue" / "swap slide 3's chart" — those go straight to surgical edit, no questions.

---

## The five questions

Ask these (paraphrased to fit the request), in this order. Skip any the user has already answered.

1. **What is it?** Landing page, dashboard, deck, mobile mock, prototype, magazine, brand sheet, critique of an existing thing. One word.
2. **Who is it for?** One line on the audience — "B2B procurement leaders at mid-market SaaS companies", "consumer designers in their 20s evaluating tools", "investors at our seed round". This sets the voice and the polish budget.
3. **What's the direction?** A brand name ("Stripe-quality"), a design system ("Apple but warmer"), a feeling ("fintech credibility"), or a reference URL. The catalog is the primary source — call `list_design_systems` to find candidates. If the catalog has nothing close, or the user hasn't named anything, fall back to the inline directions below.
4. **What's in scope?** A finite section list. For a landing: hero + problem + solution + proof + CTA + footer (or a different list — but a list). For a deck: a numbered slide list. For a mock: a screen list. Push back on "and everything else."
5. **What fidelity?** Rough sketch / production-ready / somewhere between. Affects how much polish budget you spend per region.

If the user gives you three of five up front and is missing two, ask the missing two — don't re-ask the three they already answered.

---

## The inline fallback directions

These five are the **fallback** when the catalog tools don't surface a strong match, or when the user hasn't named a brand or feeling. The catalog (`list_design_systems` + `apply_design_system`) is always the primary path — try there first. The inline set below is hard-coded into this skill so the agent always has a working palette in context even on installs where the catalog is misconfigured or empty.

Each is a complete starter palette + type stack + density rule you can paste straight into `:root` and ship. When using the fallback, offer three (not all five) that match the brief best, then build to the one the user picks.

### 1. Editorial Monocle

Restrained editorial. White space heavy, narrow accent palette, considered typography. The "luxury magazine" feel — works for brand pages, premium SaaS, premium consumer, high-end retail.

```css
:root {
  --bg: #fafaf7;
  --surface: #ffffff;
  --fg: #1a1a1a;
  --muted: #6b6b6b;
  --border: #e8e6e0;
  --accent: #1a1a1a;        /* black-on-white restraint */
  --accent-fg: #ffffff;
  --good: #2f7d4a;
  --bad: #b53a2a;
  --radius: 4px;
  --radius-pill: 999px;
  --font-display: "Times New Roman", Georgia, "Iowan Old Style", serif;
  --font-body: -apple-system, system-ui, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
```

Density: generous. Side margins ≥ 5vw on desktop. Section padding 80–120px vertical.

### 2. Modern Minimal

Clean, product-oriented, "B2B credibility." Single-accent palette, Inter or system-ui, geometric, restrained shadows. The Linear / Stripe / Vercel zone — works for B2B SaaS, developer tools, fintech, ops dashboards.

```css
:root {
  --bg: #fafafa;
  --surface: #ffffff;
  --fg: #111111;
  --muted: #6b6b6b;
  --border: #e5e5e5;
  --accent: #2f6feb;       /* cobalt */
  --accent-hover: #1f5fd6;
  --accent-fg: #ffffff;
  --good: #17a34a;
  --warn: #eab308;
  --bad: #dc2626;
  --radius: 8px;
  --radius-pill: 999px;
  --font-display: "Inter", -apple-system, system-ui, sans-serif;
  --font-body: "Inter", -apple-system, system-ui, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
```

Density: medium. 16–24px component padding, 48–80px section padding.

### 3. Warm Soft

Approachable, friendly, "consumer comfort." Off-white background, warm neutral accent, generous radii, gentle shadows. Works for consumer apps, health, education, finance-for-humans.

```css
:root {
  --bg: #fdf9f3;
  --surface: #ffffff;
  --fg: #2a1f17;
  --muted: #7a6a5d;
  --border: #ebe3d8;
  --accent: #c96442;       /* warm terracotta */
  --accent-hover: #b15533;
  --accent-fg: #ffffff;
  --good: #2f7d4a;
  --bad: #b53a2a;
  --radius: 14px;
  --radius-pill: 999px;
  --font-display: "Fraunces", "Iowan Old Style", Georgia, serif;
  --font-body: "Inter", -apple-system, system-ui, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
```

Density: medium. Component padding 16–28px, generous rounding on cards.

### 4. Tech Utility

Dense, information-rich, "the agent works here." Dark or near-black surface, restrained accent, monospace numerals, tight density. Works for developer dashboards, ops tools, terminals, internal admin.

```css
:root {
  --bg: #0d1117;
  --surface: #161b22;
  --surface-2: #1f242c;
  --fg: #e6edf3;
  --muted: #8b949e;
  --border: #30363d;
  --accent: #58a6ff;       /* GitHub-ish blue */
  --accent-fg: #0d1117;
  --good: #3fb950;
  --warn: #d29922;
  --bad: #f85149;
  --radius: 6px;
  --radius-pill: 999px;
  --font-display: -apple-system, system-ui, "Helvetica Neue", sans-serif;
  --font-body: -apple-system, system-ui, "Helvetica Neue", sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
```

Density: high. Component padding 8–14px, tight line-height on tables (1.35).

### 5. Brutalist Experimental

Loud, opinionated, "the agency is making a statement." Heavy display type, hard color, no rounding or radical rounding, deliberate asymmetry. Works for creative agencies, fashion drops, music, art-led brands.

```css
:root {
  --bg: #f4f0e6;
  --surface: #f4f0e6;
  --fg: #0a0a0a;
  --muted: #4a4a4a;
  --border: #0a0a0a;
  --accent: #ff4d00;       /* hot orange */
  --accent-fg: #0a0a0a;
  --good: #006b3c;
  --bad: #c41e3a;
  --radius: 0px;           /* none, or radical 32px in one place */
  --radius-pill: 0px;
  --font-display: "Times New Roman", Georgia, serif;
  --font-body: -apple-system, system-ui, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, monospace;
}
```

Density: deliberate. Asymmetric gutters, oversized headings (80–160px on desktop), heavy borders (2–4px).

---

## How to present directions to a user

When the user has no direction in mind, present three (not all five) tailored to the brief, in plain English with one line each:

> "For a B2B procurement landing page I'd offer three directions:
>
> 1. **Modern Minimal** — clean, single-accent, "B2B credibility." Linear / Stripe zone.
> 2. **Editorial Monocle** — restrained, white space heavy, "premium consideration." Works if the buyer is senior.
> 3. **Tech Utility** — denser, near-black surface, "we serve the operators." Risky for marketing, great if the audience self-identifies as power users.
>
> Which one — or paste a reference URL and I'll match?"

Three is the right count. Five overwhelms.

---

## When the user pastes a reference URL

Read the page. Describe back the system you'd lift, in one short paragraph: dominant surface color, accent color, type pairing, density level, signature move (e.g. "single oversized hero number, narrow column body, monospace pulls"). Confirm the read with the user, then build.

Do not silently mimic. The describe-and-confirm step is the cheap moment for the user to redirect.

---

## When the user names a brand or named system

Three steps. In order. Stop after each — don't combine them into a single mega-call.

**Step 1 — call `list_design_systems({ search: "<brand>" })`** with the user's word as the search term ("linear", "stripe", "vercel", "warm", "minimal"). The tool returns lightweight summaries — id, name, category, swatches, one-line description — for every catalog entry whose id, name, or summary mentions the word.

**Step 2 — read the candidates and surface the right ones to the user.** Three outcomes:

1. **One obvious match.** Confirm in plain English: "Catalog has `linear-inspired` — restrained, single purple accent, geometric. Use that?" On user confirm, go to Step 3.
2. **Multiple candidates.** Surface up to three, one line each: "Catalog has `linear-inspired` (restrained, purple), `vercel-inspired` (also restrained, slightly warmer), and `notion-inspired` (closer to consumer-friendly). Which fits?" Then Step 3.
3. **No catalog match.** Fall back to the inline directions plus brand-derived token overrides — described under "When the catalog has nothing close" below. The agent does not invent a catalog entry; falling back is the honest move.

**Step 3 — call `apply_design_system({ id: "<chosen-id>" })`** once the user has picked. The tool returns the full `DESIGN.md` prose, the full `tokens.css`, and the pre-extracted `rootBlock` (the `:root { ... }` block ready to paste). Hand off to the `artifact` skill: paste the `rootBlock` verbatim into the artifact's first `<style>`, treat the `DESIGN.md` prose as authoritative for component decisions, and if `attribution` is present add a one-line HTML comment near the top of the artifact crediting the upstream.

**Do not call `apply_design_system` before the user has confirmed an id.** The tool result is heavy (full DESIGN.md + tokens), and a wrong call wastes context. List first, confirm, then apply.

## When the catalog has nothing close

If `list_design_systems` returns zero matches that fit the user's intent (catalog is empty, install is misconfigured, or the user is asking for a genuinely uncovered niche), drop to the inline fallback above. Map the user's brand or feeling onto one of the five inline directions, plus two or three token overrides:

> "Catalog has no Linear-ish entry yet, so I'd build Linear-ish off the Modern Minimal direction, but with: `--accent: #5e6ad2` (Linear purple), `--font-display: "Inter Display", "Inter", sans-serif`, slightly tighter density (`--radius: 6px`, component padding 12–20px). Good?"

This keeps the work moving on installs where the catalog is incomplete, and gives the user something to react to instead of an apology.

## When the catalog itself is misconfigured

`list_design_systems` returns `catalogConfigured: false` when the profile can't find a catalog directory (no `<profile-dir>/design-systems/` and no `OWNWARE_DESIGN_CATALOG_DIR` env var). When that happens:

1. Mention it once to the user, in one sentence — "Catalog isn't reachable from this install; I'll build with the inline directions and you can fix the catalog path when you have a minute."
2. Switch to inline fallback immediately. Don't keep retrying the tool.
3. Don't escalate further. The artifact still gets built; the catalog being absent is an install issue, not a design issue.

---

## After discovery — the handoff

End discovery with a 4–6 line plan the user can nod at:

> **Plan**
> - **Artifact:** Landing page, single self-contained HTML
> - **Direction:** Modern Minimal, Linear-style overrides (cobalt → purple, tighter density)
> - **Sections:** Hero, problem, solution, three-feature row, proof (logos + 2 testimonials), pricing CTA, footer
> - **Fidelity:** Production-ready
> - **First pass:** I'll write a structural draft with placeholder copy, then we tune.

Wait for the user's nod, then enter the `artifact` skill.
