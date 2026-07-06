---
name: state-empty-loading-error
description: 'The three async states every data-fetching surface must ship — loading (skeleton/spinner/progress), error (specific message + retry + escape), empty (icon + headline + context + primary action). Use when designing any panel, list, chart, or screen that depends on async data. Skip for pure-static marketing pages. Pairs with /forms-craft (form-level errors) and /error-messaging (microcopy rules).'
trigger: /state-empty-loading-error
---

# State: Empty / Loading / Error — design all three before ship

## Overview

The single biggest reason "the demo worked" but "the user said it's broken" is that only the data-loaded state was designed. The other three — loading, error, empty — got placeholder spinners and "Something went wrong." Every async surface has FOUR states. Ship four, not one.

Use this skill at the moment a panel, list, dashboard tile, chart, or table is being designed. Confirm what the loaded state looks like, then design loading / error / empty to the same level of craft. Never let a surface ship with one state and three placeholders.

---

## Critical Constraints — read these first, every time

1. **Every async surface ships four states.** Loaded, loading, error, empty. Not three. Not one. If you can't design all four, the surface isn't ready.
2. **Loading-state choice depends on duration, not vibe.** 0–200ms no indicator at all (the eye won't process it). 200ms–1s spinner OR skeleton. 1–10s progress bar with percent if knowable, skeleton if not. 10s+ progress bar + estimated time remaining + cancel affordance.
3. **Skeletons match the LOADED layout, not generic gray bars.** Boxes where boxes will land, lines where lines will land, the same gutters. A row of three generic stripes is not a skeleton — it's a placeholder pretending to be one.
4. **Error states need three things: specific message, retry action, escape hatch.** Never just "Something went wrong." Specific = which operation failed. Retry = a button that actually retries (preserving any form state). Escape = a link to support or a different path.
5. **Empty states are NOT errors.** An empty state means "no data exists yet, which is fine." It has an icon, a headline, 1–2 lines of context, and the primary action that creates the first datum. See `/empty-state-craft` (Batch 17) for the deeper rules.
6. **The four states must share spatial frame.** The container size, padding, and border don't shift between states. The user's eye should land in the same place for the loaded result, the loader, the error, the empty.

---

## Framework — the loading-state ladder by duration

| Duration | Indicator | Why |
|----------|-----------|-----|
| 0–200ms | None | Below human-perception threshold; flashing a spinner reads as a glitch |
| 200ms–1s | Spinner (24px) OR shimmer | The user just notices; one signal is enough |
| 1s–3s | Skeleton matching layout | The user is now paying attention; show them the shape of what's coming |
| 3s–10s | Skeleton + subtle status text | "Indexing 12,400 rows…" — gives the wait a story |
| 10s+ | Progress bar + estimated time + cancel | Long enough that the user needs to know whether to wait or leave |

A generic spinning circle for >2 seconds reads as "the app is broken." If you don't know the exact duration ahead of time, default to skeleton — it always works for indeterminate loads.

### Skeleton craft rules

1. **Same layout.** If the loaded state has a 64×64 avatar + two text rows + a 40px row of pills, the skeleton has a 64×64 rounded square + two stripe rows (heights matching the type sizes) + a 40px row of pill stripes. Boxes-to-boxes.
2. **Animate the gradient sweep.** Don't pulse opacity — that reads as throbbing. A left-to-right `linear-gradient` shimmer animating at 1.2s loop, with the gradient running from `--surface-2` → `--surface-3` → `--surface-2`. Stop the animation when `prefers-reduced-motion: reduce`.
3. **Match the number of items if known.** A list-of-5 skeleton has 5 rows. A list-of-N (unknown) skeleton has 3–4 — enough to imply "list", not so many it overflows.
4. **Don't skeleton the entire screen.** Skeleton the data region. The chrome (header, nav, sidebar) stays solid — it's not loading. Skeleton-everything reads as a 90s page-refresh.

---

## Framework — the error-state recipe

```
[icon: warning, 32px, --bad color, 60% opacity]
[H3, 16px semibold: "Couldn't load your projects"]
[body, 14px --muted: "The server didn't respond in time. Your data is safe; this is a connection issue."]
[primary button: "Try again"  (re-runs the exact same fetch, preserves any form state above)]
[link: "Contact support" or "Check status →"]
```

Rules:

- **Specific message.** "Couldn't load your projects" beats "Something went wrong." The user knows what operation was attempted.
- **Cause, when known.** Network timeout vs auth failure vs server error are three different recoveries. If you can detect which, say which. If you can't, say "connection issue" not "error".
- **Retry preserves state.** If the user typed into a form, retry doesn't blow the form away. The retry re-runs the fetch with the same inputs.
- **Escape hatch.** A status page link, a support link, OR a "go back" path. The user never feels trapped.
- **No stack traces in user-facing copy.** Stack traces go to the log; the user sees the explanation.

---

## Concrete examples

### Example 1 — Chart panel rendered in all four states (CSS-only)

```html
<style>
  :root {
    --bg: #fafafa; --surface: #ffffff; --surface-2: #f3f3f3; --surface-3: #ececec;
    --fg: #111111; --muted: #6b7280; --border: #e5e5e5;
    --accent: #2f6feb; --bad: #dc2626; --good: #17a34a;
    --radius: 10px;
  }
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; min-height: 280px; display: flex; flex-direction: column; gap: 12px; }
  .panel h3 { margin: 0; font: 600 14px/1.2 system-ui; color: var(--fg); }
  .panel-body { flex: 1; display: flex; flex-direction: column; gap: 10px; }

  /* SKELETON — matching the chart layout: title row + 5 bars */
  @keyframes shimmer { from { background-position: -200% 0; } to { background-position: 200% 0; } }
  .skel { background: linear-gradient(90deg, var(--surface-2), var(--surface-3), var(--surface-2)); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; border-radius: 4px; }
  @media (prefers-reduced-motion: reduce) { .skel { animation: none; background: var(--surface-2); } }
  .skel-bar-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; align-items: end; height: 180px; }
  .skel-bar { width: 100%; }

  /* ERROR */
  .state-center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 10px; padding: 24px; }
  .state-center .icon { width: 32px; height: 32px; }
  .state-center .title { font: 600 15px/1.3 system-ui; color: var(--fg); }
  .state-center .body { font: 14px/1.4 system-ui; color: var(--muted); max-width: 36ch; }
  .state-center .actions { display: flex; gap: 12px; margin-top: 4px; }
  .btn-primary { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 8px 14px; font: 500 13px system-ui; cursor: pointer; }
  .btn-secondary { background: transparent; color: var(--accent); border: 0; padding: 8px 0; font: 500 13px system-ui; cursor: pointer; }
</style>

<!-- 1. LOADED -->
<section class="panel" data-cx-id="panel-loaded">
  <h3>Weekly revenue</h3>
  <div class="panel-body">
    <svg viewBox="0 0 500 180" preserveAspectRatio="none">
      <polyline fill="none" stroke="var(--accent)" stroke-width="2" points="0,140 100,120 200,90 300,100 400,60 500,40"/>
    </svg>
  </div>
</section>

<!-- 2. LOADING (skeleton matching layout) -->
<section class="panel" data-cx-id="panel-loading" aria-busy="true">
  <div class="skel" style="width: 140px; height: 16px;"></div>
  <div class="panel-body">
    <div class="skel-bar-row">
      <div class="skel skel-bar" style="height: 60%"></div>
      <div class="skel skel-bar" style="height: 80%"></div>
      <div class="skel skel-bar" style="height: 50%"></div>
      <div class="skel skel-bar" style="height: 70%"></div>
      <div class="skel skel-bar" style="height: 90%"></div>
    </div>
  </div>
</section>

<!-- 3. ERROR -->
<section class="panel" data-cx-id="panel-error" role="alert">
  <h3>Weekly revenue</h3>
  <div class="state-center">
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="var(--bad)" stroke-width="1.75"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16v.01"/></svg>
    <div class="title">Couldn't load this chart</div>
    <div class="body">The data service didn't respond in time. Your numbers are safe; this is a connection hiccup.</div>
    <div class="actions">
      <button class="btn-primary">Try again</button>
      <a class="btn-secondary" href="#status">Check status →</a>
    </div>
  </div>
</section>

<!-- 4. EMPTY -->
<section class="panel" data-cx-id="panel-empty">
  <h3>Weekly revenue</h3>
  <div class="state-center">
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.5"><path d="M3 17l5-6 4 3 5-7 4 5"/><path d="M3 21h18"/></svg>
    <div class="title">No revenue logged yet</div>
    <div class="body">Once your first invoice is paid, you'll see weekly trends here.</div>
    <div class="actions">
      <button class="btn-primary">Create invoice</button>
    </div>
  </div>
</section>
```

All four panels share the same `min-height: 280px`, same border, same padding. The user's eye doesn't move; only the content inside changes.

### Example 2 — List skeleton matching a row of 5 items

```html
<style>
  .item-row { display: grid; grid-template-columns: 40px 1fr 80px; gap: 12px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--border); }
  .skel-circle { width: 40px; height: 40px; border-radius: 50%; }
  .skel-line { height: 12px; border-radius: 4px; }
</style>
<ul class="item-list" data-cx-id="item-list-loading" aria-busy="true" style="list-style: none; padding: 0; margin: 0;">
  <!-- 5 rows, matching the loaded layout: avatar + two-line text + price -->
  <li class="item-row">
    <div class="skel skel-circle"></div>
    <div>
      <div class="skel skel-line" style="width: 60%; margin-bottom: 8px;"></div>
      <div class="skel skel-line" style="width: 40%;"></div>
    </div>
    <div class="skel skel-line" style="width: 60px; height: 16px;"></div>
  </li>
  <!-- repeat 4 more rows -->
</ul>
```

Notice: the skeleton has the exact same grid layout as the loaded list. When the data lands, the avatar appears where the circle was, the title appears where the long line was, the price appears where the small line was. Zero layout shift. Zero "the page jumped."

---

## Anti-patterns

- **"Loading…" text with no shape.** The user has no idea what's coming. Skeleton or spinner-with-context beats text alone.
- **Generic three-stripe skeleton on every surface.** That's a placeholder, not a skeleton. A skeleton commits to the layout.
- **Pulsing-opacity skeleton.** Reads as throbbing; worse than no animation. Shimmer-sweep or static `--surface-2`.
- **"Something went wrong."** The single most unhelpful error string in software. Replace with the operation name + the cause + a retry.
- **Errors with no retry.** A red banner that just says "Failed" is not an error state; it's a wall.
- **Empty states styled like errors.** Empty is fine, error is not. Empty uses `--muted` icon + warm tone; error uses `--bad` icon + neutral tone.
- **Loading state with different padding from loaded state.** Causes the surface to "pop" by 12px when the data lands. Match padding, match border, match height.
- **Spinning a circle for 30 seconds.** The user already left. Anything >10s needs a progress bar + estimate + cancel.
- **Auto-retry forever.** A retry loop with no exit eats battery and confuses the user — they think their tap did nothing because the same spinner keeps spinning. Cap at 2 automatic retries, then surface the manual error state.
