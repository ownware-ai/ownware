---
name: mobile-touch-design
description: 'Touch targets, gestures, safe-area insets, scroll-snap, fat-finger discipline — the patterns for mobile-first surfaces. Use when the brief is a mobile mock, a mobile web view, a PWA, or anything that will be used primarily on phone or tablet. Pairs with /platform-rules (cross-platform baselines) and /mobile-bottom-nav (the nav pattern itself). Skip for desktop-first surfaces — hover-driven UX has its own rules.'
trigger: /mobile-touch-design
---

# Mobile Touch Design — fingers, not pointers

## Overview

A mobile UI designed by someone who lives on a 32-inch monitor is a mobile UI that misses its tap targets, hides actions behind hover, and clips its bottom navigation under the home indicator. Touch is not "smaller mouse." Touch is a different input modality with different size floors, different gesture vocabulary, and different safe areas.

This skill is the recipe for shipping a mobile surface a human can actually use one-handed in landscape on a train. Pairs with `/platform-rules` (iOS vs Android baselines) and `/mobile-bottom-nav` (the nav-bar component). Skip for desktop-first work — hover is fine there.

---

## Critical Constraints — read these first, every time

1. **Touch target floor: 44pt iOS / 48dp Android / 44px web. NEVER under.** This is the Apple HIG and Google Material baseline. A 32px button is a 32px button on screen and a frustration in the hand.
2. **Visual size ≠ tap area.** Keep the visual control compact and clean; expand the hit-area via padding or invisible overlay. A 24px icon centered inside a 44px touch target is the right shape.
3. **Spacing between targets ≥ 8px.** Two 44px buttons touching each other read as one wide button. 8px minimum air; 12px is better.
4. **Hover doesn't exist.** Never rely on hover-to-reveal. A "hover to see actions" pattern works for zero of your mobile users. Move actions to long-press or to a visible affordance.
5. **Safe-area-inset on all four sides.** Top inset for notch + status bar. Bottom inset for home indicator. Left/right for round-corner phones in landscape. Use `env(safe-area-inset-*)`.
6. **Fat-finger rule: +8px around destructive actions.** Delete, archive, send — anything irreversible — gets 52px minimum hit area, not 44. The cost of a mis-tap is asymmetric.
7. **Gestures have a documented vocabulary.** Tap (primary), long-press (context menu), swipe (delete/archive in lists), pinch (zoom). Drag is for reordering. Anything else is a custom gesture and needs discovery — a first-run tooltip, an empty-state hint.

---

## Touch target sizes — exact numbers

| Platform     | Minimum target | Recommended | Source            |
| ------------ | -------------- | ----------- | ----------------- |
| iOS          | 44pt × 44pt    | 44pt × 44pt | Apple HIG         |
| Android      | 48dp × 48dp    | 48dp × 48dp | Material 3        |
| Web (mobile) | 44px × 44px    | 48px × 48px | WCAG 2.5.5 AAA    |
| Watch / TV   | 44pt+ (focus)  | 60pt+       | Apple HIG         |

In CSS terms: every interactive element gets `min-width: 44px; min-height: 44px;` as a floor. The visible shape can be smaller — wrap it in a padded hit-box.

---

## The hit-area expansion pattern

```html
<button class="icon-btn" aria-label="Archive">
  <svg width="20" height="20" viewBox="0 0 24 24"><!-- archive glyph --></svg>
</button>
```

```css
.icon-btn {
  display: grid; place-items: center;
  min-width: 44px; min-height: 44px;
  background: transparent; border: 0; padding: 0;
  color: var(--fg); cursor: pointer;
}
.icon-btn:active { background: var(--surface-2); border-radius: 8px; }
.icon-btn svg { width: 20px; height: 20px; }
```

The icon is 20px. The button is 44px. The tap lands on the button; the eye sees the icon. Both are happy.

---

## Gesture vocabulary

| Gesture     | Action                                         | When to use                          |
| ----------- | ---------------------------------------------- | ------------------------------------ |
| Tap         | Primary action                                 | Every interactive element            |
| Double-tap  | Zoom (in image viewers) or "like" (in feeds)   | Sparingly — discoverability is poor  |
| Long-press  | Context menu / multi-select entry              | Every list row                       |
| Swipe-left  | Reveal trailing actions (archive, delete)      | List rows in inbox-style UIs         |
| Swipe-right | Reveal leading actions (mark read, flag)       | Same                                 |
| Pinch       | Zoom (images, maps)                            | Detail views, never lists            |
| Drag        | Reorder                                        | Lists with explicit drag handles     |
| Pull-down   | Refresh                                        | Feeds and lists with server data     |

Document any gesture the user can't discover. A first-time tooltip or a one-time onboarding step is the right discovery path.

---

## Safe-area insets

iPhone X and later have a notch (or Dynamic Island) at the top and a home indicator at the bottom. In landscape, the rounded corners push content inward. Use `env()`:

```css
:root {
  --safe-top:    env(safe-area-inset-top);
  --safe-bottom: env(safe-area-inset-bottom);
  --safe-left:   env(safe-area-inset-left);
  --safe-right:  env(safe-area-inset-right);
}

body {
  padding-top:    var(--safe-top);
  padding-bottom: var(--safe-bottom);
  padding-left:   var(--safe-left);
  padding-right:  var(--safe-right);
}

.bottom-nav {
  position: fixed; bottom: 0; left: 0; right: 0;
  padding-bottom: var(--safe-bottom);   /* clears the home indicator */
}
```

And add the viewport meta to enable the inset:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

Without `viewport-fit=cover`, `env(safe-area-inset-*)` returns 0 and your bottom nav lands under the home indicator.

---

## Scroll-snap for paginated content

Carousels, story-feeds, full-screen photo viewers all want scroll-snap rather than custom JS pagination.

```css
.carousel {
  display: flex; overflow-x: auto;
  scroll-snap-type: x mandatory;
  scroll-behavior: smooth;
  -webkit-overflow-scrolling: touch;
}
.carousel > .card {
  flex: 0 0 100%;
  scroll-snap-align: start;
}
```

One CSS rule replaces 80 lines of touchmove handling. The browser handles momentum, snap targets, and scroll position restoration.

---

## Concrete examples

### Example 1 — a mobile photo gallery with tap, long-press, swipe-to-delete, pinch-zoom

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Photos</title>
  <style>
    :root {
      --bg:#000; --fg:#fff; --muted:#888; --surface:#1a1a1a; --accent:#0ea5e9;
      --safe-top:env(safe-area-inset-top); --safe-bottom:env(safe-area-inset-bottom);
    }
    *,*::before,*::after { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--fg);
           font:15px/1.5 -apple-system, system-ui, sans-serif;
           padding-top:var(--safe-top); padding-bottom:var(--safe-bottom); }

    header { padding: 12px 16px; display:flex; justify-content:space-between; align-items:center; }
    header h1 { margin:0; font-size:24px; }
    .icon-btn {
      min-width:44px; min-height:44px;
      display:grid; place-items:center; background:transparent; border:0; color:var(--fg);
    }

    .grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:2px; padding:0 2px; }
    .photo {
      position:relative; aspect-ratio:1/1; background:var(--surface);
      overflow:hidden;
    }
    .photo img { width:100%; height:100%; object-fit:cover; }

    /* swipe-to-delete row */
    .row {
      display:grid; grid-template-columns:100%;
      position:relative; min-height:64px;
      transition: transform 0.2s;
    }
    .row.swiped { transform: translateX(-88px); }
    .row .action {
      position:absolute; right:0; top:0; bottom:0; width:88px;
      background:#dc2626; color:#fff;
      display:grid; place-items:center; font-weight:600;
      min-height:44px;   /* fat-finger floor */
    }

    /* destructive: bigger hit area */
    .btn-delete {
      min-height:52px; min-width:52px; padding:8px 14px;
      background:#dc2626; color:#fff; border:0; border-radius:10px;
    }

    /* scroll-snap full-screen viewer */
    .viewer {
      position:fixed; inset:0; background:#000;
      display:flex; overflow-x:auto;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
    }
    .viewer > figure {
      flex: 0 0 100vw; scroll-snap-align:start;
      display:grid; place-items:center; margin:0;
    }
    .viewer img { max-width:100%; max-height:100%; touch-action: pinch-zoom; }
  </style>
</head>
<body>
  <header data-cx-id="header">
    <h1>Photos</h1>
    <button class="icon-btn" aria-label="Select">⊕</button>
  </header>

  <section class="grid" data-cx-id="grid">
    <div class="photo" data-action="open" data-long-press="select">
      <img src="..." alt="Beach, July 14">
    </div>
    <!-- … more cells, each with min 44px hit through the parent … -->
  </section>

  <script>
    // Long-press → enter selection mode
    let pressTimer;
    document.querySelectorAll('.photo').forEach(el => {
      el.addEventListener('touchstart', () => {
        pressTimer = setTimeout(() => el.dispatchEvent(new CustomEvent('longpress')), 500);
      });
      el.addEventListener('touchend',   () => clearTimeout(pressTimer));
      el.addEventListener('touchmove',  () => clearTimeout(pressTimer));
      el.addEventListener('longpress', () => document.body.classList.add('selecting'));
    });
  </script>
</body>
</html>
```

Header icon button is 44px square around a 20px glyph. Swipe rows reveal a 88px-wide red Delete with a 52px minimum height (destructive → fat-finger rule). Full-screen viewer uses scroll-snap for swipe-paging and `touch-action: pinch-zoom` for pinch. Long-press is wired with a 500ms timer + `touchmove` cancel.

### Example 2 — the safe-area test

```html
<style>
  body { padding-bottom: env(safe-area-inset-bottom); }
  .bottom-nav {
    position: fixed; bottom: 0; left: 0; right: 0;
    padding-bottom: max(env(safe-area-inset-bottom), 8px);
    /* max() means at minimum 8px even on devices without an inset (e.g. Android) */
    height: calc(56px + env(safe-area-inset-bottom));
  }
</style>
```

On an iPhone 15 Pro: the nav extends 34px below the visible row to clear the home indicator. On a Pixel 8: `env(safe-area-inset-bottom)` is 0, the `max()` gives 8px of padding regardless. One CSS expression, two platforms.

---

## Anti-patterns

- **32px or smaller tap targets.** Stop. 44px floor or 48px on Android. Visual size can be smaller; the tap area cannot.
- **Hover-to-reveal actions.** Stop. Hover doesn't fire on touch. The user will never find the action. Move it to long-press or a visible button.
- **Bottom nav without `safe-area-inset-bottom` padding.** Stop. On a notched phone, the nav lands under the home indicator and intercepts the home gesture. Pay the 34px tax.
- **Three buttons in 44px total width.** Stop. 8px between targets, minimum. Three 44px buttons need ≥ 148px (44 + 8 + 44 + 8 + 44).
- **Custom-coded swipe via touchmove with no scroll-snap.** Stop. CSS scroll-snap is built into every modern browser and handles momentum correctly. Reserve JS for cases CSS genuinely can't cover.
- **Long-press as the only path to a primary action.** Stop. Long-press is for context — secondary actions, multi-select entry. Primary action must be a visible tap target.
- **Forgetting `viewport-fit=cover`.** Stop. Without it, `env(safe-area-inset-*)` reports 0 on every device, and your safe-area code does nothing.
