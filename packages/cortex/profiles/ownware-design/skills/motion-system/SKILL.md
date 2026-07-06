---
name: motion-system
description: 'Motion as DESIGN TOKENS — durations, easings, distance rules, reduced-motion fallbacks. The token layer that components reference. Use when building or auditing a system''s motion language, when interactions feel "the same speed for every action," or before writing any GSAP. Pairs with /motion-library (the GSAP code that consumes these tokens) and /scroll-motion (scroll-driven patterns). Skip when the brief is "no animation" — static is a valid choice; don''t build tokens you''ll never use.'
trigger: /motion-system
---

# Motion System — duration + easing + distance, as tokens

## Overview

Most artifacts ship with `transition: all 0.3s ease` and call it motion. That's not a system — that's one default applied to everything. A real motion system separates motion by *role*: hover feedback is faster than a modal entrance, which is faster than a dramatic reveal. Each role gets its own token. Components reference the tokens, not magic numbers.

This skill produces the token layer — durations and easings as CSS custom properties — that every component, transition, and (downstream) GSAP call consumes. `/motion-library` is the GSAP code; this skill is the vocabulary GSAP speaks.

Five roles. Five durations. Four eases. One reduced-motion override. That's the whole system.

---

## Critical Constraints

1. **Motion has a job.** Hover feedback confirms a target. State change marks a transition. Page enter sets the scene. Dramatic reveal pulls the eye. Ambient loop signals "alive." If you can't name the job, the motion shouldn't exist.
2. **Duration is shaped by role, not vibe.** Hover at 100ms feels snappy. The same 100ms on a modal-enter feels rushed. The same 100ms on a dramatic-reveal feels broken. Each role has a range.
3. **Easing is meaning, not decoration.** `ease-out` for arrivals (the eye follows to a settle). `ease-in` for departures (object leaving the screen accelerates away). `ease-in-out` for symmetric motion. Linear only for ambient infinite loops (spinners, breathing icons).
4. **Distance × easing × duration are linked.** A 4px hover lift at 500ms feels slow. A 24px modal-enter at 100ms feels rushed. Bigger distance needs more time AND a more pronounced ease curve.
5. **Reduced-motion is a per-role override, not a kill switch.** Hover feedback at `prefers-reduced-motion: reduce` becomes instant (`0ms`). Page-enter becomes a fade only. Ambient loops stop entirely. Don't ship one global `* { animation: none; transition: none; }` — it strips legitimate state-feedback the user needs.
6. **Tween transforms and opacity. Nothing else.** `transform` and `opacity` are GPU-composited. `width`, `height`, `top`, `left`, `margin` are layout-triggered and drop frames at 60fps. The token's `--cx-dur-snap: 100ms` is wasted if the component animates `width`.

---

## Framework — the five motion roles

### Role 1 — Hover feedback (80-120ms)

The "I'm targeting this" confirmation. Button hover, link underline, card lift. Duration 80-120ms; eases `ease-out`. Distance ≤ 4px on lifts; scale ≤ 1.02.

### Role 2 — State change (200-250ms)

Toggle on/off, accordion expand, sort order switch, tab swap. The element doesn't enter or exit — it changes property. Duration 200-250ms; eases `ease-in-out` (symmetric).

### Role 3 — Page / modal enter (300-400ms)

Modal appears, drawer slides in, page transitions. The element enters from off-canvas or appears from invisible. Duration 300-400ms; eases `ease-out` (arrival emphasis).

### Role 4 — Dramatic reveal (500-700ms)

The hero headline reveals on load. The pricing tier "shimmers" when the user lands. Used sparingly — once or twice per artifact. Duration 500-700ms; eases `expo.out` or `power3.out` (cinematic).

### Role 5 — Ambient loop (4-8s cycle)

Breathing icons, subtle background gradient drift, idle pulse on a CTA. Infinite cycle, 4-8 second loop, opacity OR transform — never both layered. Easing `linear` or `sine.inOut`.

---

## The token block

Paste this into `:root` once. Every component references these names.

```css
:root {
  /* ─── durations ─── */
  --cx-dur-snap:      100ms;   /* hover, focus, tap feedback */
  --cx-dur-state:     220ms;   /* toggle, accordion, sort change */
  --cx-dur-enter:     360ms;   /* modal, drawer, page enter */
  --cx-dur-dramatic:  600ms;   /* hero reveal, headline split */
  --cx-dur-loop:      6s;      /* ambient loops */

  /* ─── eases ─── */
  --cx-ease-snap:     cubic-bezier(0.4, 0, 0.2, 1);          /* standard ease-out — UI default */
  --cx-ease-natural:  cubic-bezier(0.23, 1, 0.32, 1);        /* ease-out-quart — confident arrival */
  --cx-ease-dramatic: cubic-bezier(0.19, 1, 0.22, 1);        /* ease-out-expo — cinematic */
  --cx-ease-spring:   cubic-bezier(0.34, 1.56, 0.64, 1);     /* slight overshoot — playful */
  --cx-ease-symmetric: cubic-bezier(0.45, 0, 0.55, 1);        /* ease-in-out — bidirectional */

  /* ─── distance rules (px tokens for transforms) ─── */
  --cx-lift-hover:    4px;     /* card hover y-shift */
  --cx-lift-press:    1px;     /* button press y-shift */
  --cx-slide-enter:   16px;    /* modal/drawer slide distance */
  --cx-rise-reveal:   24px;    /* hero headline rise */
}

/* ─── reduced-motion override ─── */
@media (prefers-reduced-motion: reduce) {
  :root {
    --cx-dur-snap:     0ms;     /* hover becomes instant */
    --cx-dur-state:    0ms;     /* state changes instant */
    --cx-dur-enter:    150ms;   /* enters become a quick fade */
    --cx-dur-dramatic: 0ms;     /* dramatic reveals skipped */
    /* loops killed via animation-name unset below */
  }
  .cx-loop, [data-cx-loop] { animation: none !important; }
}
```

---

## The four eases — meaning, not naming

| Token | Curve | Role | When |
|-------|-------|------|------|
| `--cx-ease-snap` | `cubic-bezier(0.4, 0, 0.2, 1)` | UI default | hover, focus, button feedback — the workhorse |
| `--cx-ease-natural` | `cubic-bezier(0.23, 1, 0.32, 1)` | Arrival | modal enter, page transition, drawer open |
| `--cx-ease-dramatic` | `cubic-bezier(0.19, 1, 0.22, 1)` | Cinematic | hero reveal, dramatic headline, big move |
| `--cx-ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Playful overshoot | chip pop, badge entry, "the thing arrived" — sparingly |
| `--cx-ease-symmetric` | `cubic-bezier(0.45, 0, 0.55, 1)` | Bidirectional | accordion (open AND close), toggle, sort swap |

Linear only for infinite ambient loops (spinners, breathing). Never for entrances — entrances accelerate from rest, which is `.out`.

---

## Concrete examples

### Example 1 — Token block in `:root` + component usage

```css
:root {
  /* ── motion tokens (paste-once block) ── */
  --cx-dur-snap:      100ms;
  --cx-dur-state:     220ms;
  --cx-dur-enter:     360ms;
  --cx-dur-dramatic:  600ms;
  --cx-dur-loop:      6s;

  --cx-ease-snap:     cubic-bezier(0.4, 0, 0.2, 1);
  --cx-ease-natural:  cubic-bezier(0.23, 1, 0.32, 1);
  --cx-ease-dramatic: cubic-bezier(0.19, 1, 0.22, 1);
  --cx-ease-symmetric: cubic-bezier(0.45, 0, 0.55, 1);

  --cx-lift-hover:  4px;
  --cx-lift-press:  1px;
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --cx-dur-snap: 0ms; --cx-dur-state: 0ms; --cx-dur-dramatic: 0ms;
    --cx-dur-enter: 150ms;
  }
}

/* ── components consume the tokens ── */

.btn-primary {
  transition:
    background var(--cx-dur-snap) var(--cx-ease-snap),
    transform  var(--cx-dur-snap) var(--cx-ease-snap);
}
.btn-primary:hover  { background: var(--accent-hover); transform: translateY(calc(var(--cx-lift-press) * -1)); }
.btn-primary:active { transform: translateY(var(--cx-lift-press)); }

.card {
  transition: transform var(--cx-dur-state) var(--cx-ease-natural), box-shadow var(--cx-dur-state) var(--cx-ease-natural);
}
.card:hover { transform: translateY(calc(var(--cx-lift-hover) * -1)); box-shadow: 0 8px 24px rgba(0,0,0,0.08); }

.modal {
  transition:
    opacity   var(--cx-dur-enter) var(--cx-ease-natural),
    transform var(--cx-dur-enter) var(--cx-ease-natural);
}
.modal[hidden]    { opacity: 0; transform: translateY(16px); }
.modal:not([hidden]) { opacity: 1; transform: translateY(0); }

.accordion-body {
  transition:
    max-height var(--cx-dur-state) var(--cx-ease-symmetric),
    opacity    var(--cx-dur-state) var(--cx-ease-symmetric);
}

@keyframes cx-breathe {
  0%, 100% { opacity: 0.7; }
  50%      { opacity: 1.0; }
}
.live-dot {
  animation: cx-breathe var(--cx-dur-loop) ease-in-out infinite;
}
```

Why it works: every transition pulls duration + easing from a token. Change `--cx-dur-state` from `220ms` to `180ms` once, and every state-change in the artifact gets snappier — globally, consistently. Reduced-motion overrides cascade the same way: durations go to `0ms` at the token level, every component snaps instant without touching component CSS.

### Example 2 — Mapping each token to a real component (the catalog)

```
Component                    →  Duration token        Easing token             Distance
─────────────────────────────────────────────────────────────────────────────────────────
button hover                 →  --cx-dur-snap         --cx-ease-snap           --cx-lift-press (1px)
button press                 →  --cx-dur-snap (50ms)  --cx-ease-snap           --cx-lift-press (1px, inverted)
link underline (in/out)      →  --cx-dur-snap         --cx-ease-snap           —
focus ring                   →  --cx-dur-snap         --cx-ease-snap           —
card hover lift              →  --cx-dur-state        --cx-ease-natural        --cx-lift-hover (4px)
tab switch                   →  --cx-dur-state        --cx-ease-symmetric      —
accordion expand/collapse    →  --cx-dur-state        --cx-ease-symmetric      —
toggle switch                →  --cx-dur-state        --cx-ease-natural        —
toast enter (top-right)      →  --cx-dur-enter        --cx-ease-natural        --cx-slide-enter (16px)
modal enter                  →  --cx-dur-enter        --cx-ease-natural        --cx-slide-enter (16px) + opacity
drawer slide-in              →  --cx-dur-enter        --cx-ease-natural        100% width slide
hero headline reveal         →  --cx-dur-dramatic     --cx-ease-dramatic       --cx-rise-reveal (24px) + opacity
stagger row entries          →  --cx-dur-enter        --cx-ease-natural        --cx-rise-reveal (24px), stagger 80ms
live-dot pulse               →  --cx-dur-loop         linear or sine.inOut     opacity 0.7 → 1.0
loading spinner              →  --cx-dur-loop         linear                   rotation 360°
ambient gradient drift       →  20s (override)        linear                   background-position
```

Use this as a reference card while writing components. Every row maps a UI moment to a token. No magic numbers.

---

## Anti-patterns

- **`transition: all 0.3s ease;` on every component.** Stop. "All" animates every property — including ones you didn't intend (color shift on theme change becomes a slow fade, `top`/`left` triggers layout). Specify properties. Pick durations per role.
- **One global duration for everything.** Stop. A 300ms hover feels sluggish. A 300ms hero reveal feels rushed. Five roles, five durations — that's the system.
- **Easing names without intent.** `transition: 0.3s ease-in;` on a button hover — wrong direction. `ease-in` accelerates over time; entrances should *decelerate* into rest. Use `--cx-ease-snap` (ease-out shape).
- **Spring overshoot on serious UI.** `--cx-ease-spring` is `cubic-bezier(0.34, 1.56, 0.64, 1)` — overshoot past the target. Lovely on a confetti pop or a badge entry. Awful on a modal that bobs into place. Reserve for explicit playful moments.
- **`prefers-reduced-motion: reduce { * { transition: none; animation: none; } }`.** Stop. That nukes legitimate UI feedback (focus rings, hover state). Override at the token level — reduce durations to 0ms for most, but keep enters as a 150ms fade. The user gets the affordance, not the spin.
- **Animating `width`, `height`, `top`, `left`.** Stop. Layout-triggered properties drop frames. Use `transform: scale()`, `transform: translateY()`, `transform: translateX()`. GPU-composited; 60fps stays cheap.
- **Loops faster than 4 seconds.** Stop. A 2-second pulse feels like a heartbeat in a panic state. Ambient = slow = barely perceptible. 4-8 seconds is the calm-alive range.
- **Stacking two transitions on the same property.** Stop. `.btn { transition: background 100ms; } .btn:hover { transition: background 300ms; }` — the second overrides the first and a 300ms hover-out feels slow. One source of truth for the property's transition.
