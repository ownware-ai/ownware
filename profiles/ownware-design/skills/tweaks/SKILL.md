---
name: tweaks
description: When the user wants to explore variations of an artifact (color, type scale, density, dark mode, layout) without spawning multiple files. Embeds a small floating Tweaks panel into the artifact with 3–6 controls that mutate the live preview. Uses marker comments around defaults so the user's selected values can be persisted as the new baseline.
trigger: /tweaks
---

# Tweaks — in-design knobs over multiplying files

## Overview

When the user is exploring direction ("try a few primary colors", "show me with denser cards", "what about a dark version"), the wrong move is to spawn five files. The right move is **one file with a floating Tweaks panel** exposing the 3–6 knobs that matter most for the current artifact. The user toggles live, lands on the version they like, and asks you to bake the values back in.

This skill is opt-in. Most simple artifacts don't need a Tweaks panel. Add one when the user is *exploring*, not when they have a clear direction already.

---

## Critical Constraints — read these first, every time

1. **Three to six controls. No more.** A panel with twelve controls becomes a configurator; the user reads it instead of looking at the design.
2. **Each control mutates a CSS variable on `:root`** via inline JS. Component CSS already references `var(--…)`, so the preview updates automatically. No re-renders, no React, no rebuilds.
3. **Wrap default values in marker comments.** When the user says "lock that in," you read the live state, write the new values back into the marker block, and the panel's defaults shift permanently.
4. **Tweaks panel is `position: fixed; bottom-right; z-index: high; opacity: 0.95`.** It should be unobtrusive but reachable. Add a collapse toggle.
5. **Persist tweak state to localStorage**, keyed to the artifact identifier, so a refresh doesn't reset the user's exploration.

---

## The control vocabulary

Pick from this list. Don't invent unless the artifact genuinely needs something the list doesn't cover.

| Control | What it does | CSS variable(s) it mutates |
|---|---|---|
| **Primary color** | Single accent | `--accent`, `--accent-hover`, `--accent-fg` |
| **Surface mode** | Light / dark toggle | `--bg`, `--surface`, `--fg`, `--muted`, `--border` |
| **Type scale** | Compact / default / generous | `--font-size-base`, line-heights |
| **Density** | Tight / default / loose | `--space-2`, `--space-3`, padding rules |
| **Radius** | Sharp / soft / pill-heavy | `--radius`, `--radius-pill` |
| **Display font** | Sans / serif / mono | `--font-display` |
| **Layout variant** | One-column / two-column / centered | a `data-layout="…"` attribute on `<body>` |

For a landing page, **Primary color + Density + Display font** is the right starter set.
For a dashboard, **Surface mode + Density + Primary color**.
For a deck, **Primary color + Display font + Surface mode**.

---

## The marker-comment convention

Defaults live in a tagged block at the top of the inline `<script>`:

```js
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "primaryColor": "#2f6feb",
  "density": "default",
  "displayFont": "Inter, system-ui, sans-serif"
}/*EDITMODE-END*/;
```

When the user says "lock that in" or "make these the defaults," you:

1. Read the user's current live state from localStorage (or from the panel's rendered values).
2. Edit between `/*EDITMODE-BEGIN*/` and `/*EDITMODE-END*/` to update the defaults.
3. Confirm: "Locked in. Primary now cobalt, density loose, display font Fraunces. Tweaks panel still available if you want to keep playing."

The marker comments make this surgical — a one-line edit, no scanning, no re-flow risk.

---

## The panel HTML and JS

Add this at the end of the body. Adapt the controls to the artifact:

```html
<div class="tweaks" id="tweaks" data-od-id="tweaks">
  <div class="tweaks-header">
    <span>Tweaks</span>
    <button class="tweaks-toggle" aria-label="Collapse">−</button>
  </div>
  <div class="tweaks-body">
    <label>
      Primary color
      <input type="color" data-tweak="primaryColor" />
    </label>
    <label>
      Density
      <select data-tweak="density">
        <option value="tight">Tight</option>
        <option value="default" selected>Default</option>
        <option value="loose">Loose</option>
      </select>
    </label>
    <label>
      Display font
      <select data-tweak="displayFont">
        <option value="Inter, system-ui, sans-serif">Inter</option>
        <option value="'Fraunces', Georgia, serif">Fraunces</option>
        <option value="'Times New Roman', Georgia, serif">Times</option>
      </select>
    </label>
  </div>
</div>

<style>
  .tweaks {
    position: fixed; bottom: 16px; right: 16px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.08);
    padding: 12px 14px; opacity: 0.96; z-index: 9999;
    font: 13px/1.4 var(--font-body); color: var(--fg);
    width: 220px;
  }
  .tweaks-header { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin-bottom: 8px; }
  .tweaks-toggle { background: transparent; border: 0; cursor: pointer; font-size: 16px; color: var(--muted); }
  .tweaks.collapsed .tweaks-body { display: none; }
  .tweaks label { display: block; margin: 8px 0; font-size: 12px; color: var(--muted); }
  .tweaks input, .tweaks select { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; margin-top: 4px; }
  @media print { .tweaks { display: none; } }
</style>

<script>
  (function () {
    const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
      "primaryColor": "#2f6feb",
      "density": "default",
      "displayFont": "Inter, system-ui, sans-serif"
    }/*EDITMODE-END*/;

    const KEY = 'tweaks:' + (document.title || 'artifact');
    const root = document.documentElement;
    const panel = document.getElementById('tweaks');
    const stored = JSON.parse(localStorage.getItem(KEY) || 'null') || {};
    const state = Object.assign({}, TWEAK_DEFAULTS, stored);

    function applyState() {
      root.style.setProperty('--accent', state.primaryColor);
      root.style.setProperty('--font-display', state.displayFont);
      root.setAttribute('data-density', state.density);
      localStorage.setItem(KEY, JSON.stringify(state));
    }
    function bind() {
      panel.querySelectorAll('[data-tweak]').forEach((el) => {
        const k = el.getAttribute('data-tweak');
        el.value = state[k];
        el.addEventListener('input', () => { state[k] = el.value; applyState(); });
        el.addEventListener('change', () => { state[k] = el.value; applyState(); });
      });
      panel.querySelector('.tweaks-toggle').addEventListener('click', () => {
        panel.classList.toggle('collapsed');
      });
    }

    bind();
    applyState();
  })();
</script>
```

`data-density="tight|default|loose"` on `<html>` lets component CSS branch:

```css
[data-density="tight"]  .card { padding: 12px 14px; }
[data-density="default"] .card { padding: 18px 20px; }
[data-density="loose"]   .card { padding: 28px 30px; }
```

---

## When NOT to add a Tweaks panel

- **The user has a clear direction.** Adding a Tweaks panel to a finished artifact wastes screen and signals indecision.
- **The artifact is a deck.** Decks rarely benefit from live tweaks — the user is going to ship the deck once, not configure it. Exception: a sales-deck template that gets reused across accounts with different brand colors.
- **There are fewer than three meaningful knobs.** A panel with one control is just a button; don't.
- **It's a critique deliverable.** A critique is an audit, not a playground.

---

## Baking tweaks back in (the most useful follow-up)

The flow the user almost always wants:

1. You ship the artifact with a Tweaks panel.
2. The user toggles for a minute, lands on a combination they like.
3. The user says "lock that in, drop the tweaks panel."
4. You read their live state, edit the `EDITMODE-BEGIN/END` block to make those the new defaults, and remove the panel (and its CSS and its script) from the file.

That handoff turns the exploration tool into a clean shippable artifact. Don't skip it — the panel is for the design phase, not the production phase.
