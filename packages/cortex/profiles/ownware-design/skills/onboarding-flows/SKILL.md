---
name: onboarding-flows
description: 'First-run and activation flow patterns — dismissible modal tour, inline tooltips, checklist sidebar. Rules on activate-first-educate-second, skip-to-end, dismissibility. Use when designing a new user''s first session with a product or feature. Pairs with /state-empty-loading-error (empty-with-CTAs) and /forms-craft (signup forms). Skip for one-off feature announcements (use /release-notes).'
trigger: /onboarding-flows
---

# Onboarding Flows — first-run that earns its keep

## Overview

The default onboarding is a fullscreen modal with 6 slides, no dismiss button, and an animated mascot. Every user has been trained to hate it. The good onboarding is the one the user doesn't notice — the empty state has clear CTAs, the first action surfaces a one-time tooltip, the sidebar has a checklist that lives quietly until they need it.

Three rules govern every onboarding pattern: (1) activate first, educate second; (2) always dismissible; (3) skip-to-end always available. Break any of these and the onboarding becomes a hostage situation.

Use this skill at the moment of designing a first-run experience, a new-feature activation, or a "complete your profile" flow. Don't use it for in-app tutorials triggered later (that's contextual help, a different skill) or for re-engagement of dormant users (that's lifecycle marketing).

---

## Critical Constraints — read these first, every time

1. **Activate before educate.** The user signs up to DO something — let them do it first. Teach the second time they do it, or when they hit a wall. A 5-slide tour before any product interaction is the most common shipping failure.
2. **Every onboarding surface is dismissible.** "X" in the corner. "Skip" link. Esc to close. Outside-click on backdrop. Never a modal a user has to click through 5 slides to escape.
3. **Skip-to-end is always available.** Even on a 3-step required wizard, a "Skip — I'll set this up later" path is non-negotiable. The user who's already an expert at your product doesn't need the carousel.
4. **Default state must be sensible if onboarding is skipped.** If the user skips, the product still works. Don't gate features behind "complete onboarding" unless the feature literally can't run without the data collected.
5. **One thing per step.** A tooltip explains ONE thing. A checklist has ONE next action highlighted. A tour slide makes ONE point. Stacking 3 features into one tooltip is the same mistake as a 50-page setup wizard.
6. **Progress visible always.** Step 2 of 5, 60% done on checklist, "two minutes left." Time-blind onboarding feels longer than it is.

---

## Framework — the three onboarding patterns

### Pattern 1 — Modal tour (3–5 slides, dismissible)

When the product has a distinctly new metaphor that needs explaining BEFORE first use (rare). 3–5 slides max. Each slide has: one visual, one headline, one sentence of body, "Next" and "Skip tour" both visible.

Rules:
- **Always dismissible** with Esc, backdrop click, or visible "Skip tour" link.
- **Progress dots or numeric "2 of 5"** at the top.
- **Never autoplay forward.** The user advances; the tour doesn't move on its own.
- **Final slide ends with the first action**, not "Done." "Create your first project →" is the right CTA. "Get started" is filler.

### Pattern 2 — Inline tooltips (one at a time, anchored)

The most reliable pattern. The user lands on the product, the empty UI is already there, ONE tooltip points to the most important control with "Try this first" + a dismiss "Got it."

Rules:
- **One tooltip at a time.** Don't fire five at once.
- **Anchored to the actual UI** — a pointer or arrow connects tooltip to its target.
- **"Got it" dismisses for good.** Don't re-show a dismissed tooltip in the same session.
- **Triggered by surface, not by time.** The tooltip appears when the user lands on the relevant view, not on a 3-second timer.
- **No more than 3 tooltips across the whole first session.** More is contextual help, not onboarding.

### Pattern 3 — Checklist sidebar (5–7 tasks, persistent)

The pattern that works best for SaaS onboarding. A sidebar (or dismissible drawer) with 5–7 checkboxed tasks; completing each task advances the meter; the whole panel dismisses when ≥80% complete.

Rules:
- **5–7 tasks is the band.** Fewer feels trivial; more feels endless.
- **Tasks are concrete, not abstract.** "Create your first project" not "Learn about projects." "Invite a teammate" not "Set up your team."
- **Each task takes < 2 minutes.** If a task is longer, split it.
- **The checklist tracks real product completion**, not "watch this video." Check the box when the user actually does the thing.
- **Dismiss-when-complete OR dismiss-when-bored.** Auto-collapse at 80%, persistent dismiss button always available.
- **The checklist can re-open** from a "?" button in the header — useful for returning users who didn't finish the first time.

---

## Framework — the "activate first, educate second" decision tree

When deciding whether to onboard up-front or contextually:

1. **Can the user produce one piece of value in < 30 seconds without education?** YES → empty state with a clear CTA; skip the tour. Show the tooltip after their first action, not before.
2. **Is the metaphor genuinely novel (Figma's frames, Notion's blocks, Linear's cycles)?** YES → a 3-slide modal tour earns its keep. Otherwise NO — your product is more standard than your team thinks it is.
3. **Are there 3+ pieces of setup data that MUST be collected before any feature works (calendar app needing timezone, dashboard needing data source)?** YES → a required wizard with a skip-to-defaults option. Otherwise NO — collect data contextually as features need it.

---

## Concrete examples

### Example 1 — Checklist sidebar (the workhorse pattern)

```html
<style>
  :root {
    --bg: #fafafa; --surface: #ffffff; --fg: #111111; --muted: #6b7280; --border: #e5e5e5;
    --accent: #2f6feb; --accent-soft: rgba(47, 111, 235, 0.10); --good: #17a34a;
    --radius: 12px;
  }
  .onboarding { position: fixed; right: 24px; bottom: 24px; width: 360px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 12px 32px rgba(0,0,0,0.10); padding: 20px; }
  .onboarding header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .onboarding h3 { font: 600 14px/1.3 system-ui; margin: 0; color: var(--fg); }
  .onboarding .dismiss { background: none; border: 0; color: var(--muted); cursor: pointer; font-size: 18px; line-height: 1; padding: 4px; }
  .progress { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .progress-bar { flex: 1; height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width 300ms ease-out; }
  .progress-label { font: 500 12px system-ui; color: var(--muted); }
  .task { display: flex; align-items: center; gap: 10px; padding: 10px 8px; border-radius: 8px; cursor: pointer; text-decoration: none; color: var(--fg); }
  .task:hover { background: var(--accent-soft); }
  .task .check { width: 18px; height: 18px; border: 1.5px solid var(--border); border-radius: 50%; flex-shrink: 0; display: grid; place-items: center; }
  .task.done .check { background: var(--good); border-color: var(--good); }
  .task.done .check svg { display: block; }
  .task .check svg { display: none; width: 11px; height: 11px; }
  .task .label { font: 500 13px/1.3 system-ui; flex: 1; }
  .task.done .label { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--muted); }
  .task .arrow { color: var(--muted); font-size: 14px; }
</style>
<aside class="onboarding" data-cx-id="onboarding-checklist" aria-label="Getting started checklist">
  <header>
    <h3>Get set up in 5 minutes</h3>
    <button class="dismiss" aria-label="Dismiss">×</button>
  </header>
  <div class="progress">
    <div class="progress-bar"><div class="progress-fill" style="width: 40%"></div></div>
    <span class="progress-label">2 of 5</span>
  </div>
  <a class="task done" href="#"><span class="check"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="m5 12 5 5L20 7"/></svg></span><span class="label">Create your account</span></a>
  <a class="task done" href="#"><span class="check"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="m5 12 5 5L20 7"/></svg></span><span class="label">Create your first project</span></a>
  <a class="task" href="#"><span class="check"></span><span class="label">Invite a teammate</span><span class="arrow">→</span></a>
  <a class="task" href="#"><span class="check"></span><span class="label">Connect an integration</span><span class="arrow">→</span></a>
  <a class="task" href="#"><span class="check"></span><span class="label">Customize your workspace</span><span class="arrow">→</span></a>
</aside>
```

Why it works: dismissible at all times (the `×`), real progress (2 of 5 + bar at 40%), tasks are concrete verbs (create / invite / connect / customize), each task links to the actual feature in-product. When the user hits 4 of 5, the panel auto-collapses; the user opens it from the help menu to finish.

### Example 2 — Inline tooltip anchored to the primary action

```html
<style>
  .tooltip { position: absolute; bottom: calc(100% + 12px); left: 0; background: var(--fg); color: var(--bg); padding: 12px 14px; border-radius: 10px; max-width: 280px; font: 500 13px/1.4 system-ui; box-shadow: 0 8px 24px rgba(0,0,0,0.18); }
  .tooltip::after { content: ''; position: absolute; top: 100%; left: 24px; border: 8px solid transparent; border-top-color: var(--fg); }
  .tooltip .title { font-weight: 600; margin-bottom: 4px; display: block; }
  .tooltip .actions { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; }
  .tooltip .count { font-size: 11px; opacity: 0.6; }
  .tooltip button { background: var(--bg); color: var(--fg); border: 0; padding: 6px 10px; border-radius: 6px; font: 500 12px system-ui; cursor: pointer; }
</style>
<div style="position: relative; display: inline-block;">
  <button class="btn-primary">Create project</button>
  <div class="tooltip" role="dialog" data-cx-id="onboarding-tooltip-1">
    <span class="title">Start here</span>
    Projects hold all your work — tasks, files, conversations.
    <div class="actions">
      <span class="count">1 of 3</span>
      <button>Got it</button>
    </div>
  </div>
</div>
```

Why it works: anchored with a pointer triangle, one idea per tooltip, "Got it" dismisses for good, progress count tells the user the tour is finite.

---

## Anti-patterns

- **Modal tour with no skip.** Hostage onboarding. The single most common shipping mistake.
- **Autoplay carousel that advances on a timer.** Users read at different speeds. Let them advance.
- **A 12-slide tour.** Three to five. If you can't compress to five, the metaphor is too complex AND the tour won't save it.
- **Tooltips fired all at once.** Five tooltips on screen, all asking attention. User dismisses all five without reading.
- **Checklist with 12 tasks.** Endless. Trim to 5–7 high-value ones; the rest belong in docs.
- **"Watch this video" as a checklist item.** Doesn't track real completion. Replace with the actual action.
- **Modal that blocks the empty state.** User signs in, can't see the product, can only see the modal. Empty state is the educational surface — let it do its job.
- **Re-firing dismissed tooltips on next session.** If they said "Got it," respect it. Re-tour them and they uninstall.
- **Required wizard before any feature works.** Use defaults; collect data contextually as features need it. Required wizards are the only place trial-conversion goes to die.
- **Onboarding that doesn't update when the product changes.** A tooltip that points to a button that moved last quarter — read as "this product is unmaintained."
