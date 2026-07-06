---
name: mobile-bottom-nav
description: 'iOS + Android bottom-tab-bar design — height, safe-area-inset, label rules, active states, FAB-notch primary action, hide-on-scroll. Use when designing the persistent bottom navigation for a mobile app, a responsive PWA, or a mobile-first prototype. Skip for desktop nav (use /navigation-patterns), for in-page tabs (different control), or for sheet/modal navigation. Pairs with /mobile-touch-design for touch-target sizing.'
trigger: /mobile-bottom-nav
---

# Mobile Bottom Nav — iOS + Android tab-bar craft

## Overview

The bottom nav is the most-tapped surface on a mobile app. Get the height wrong by 4pt and it feels cramped; forget the safe-area inset and the iPhone home indicator eats the active row; pick 7 items and the user develops a "more" tab nobody finds. This skill encodes the boring rules so the agent produces a thumb-friendly bar on first pass.

If the brief is a desktop app or a marketing landing page, this skill doesn't apply — use the broader `/navigation-patterns` skill. Use this only when the design surface is a mobile app (native or PWA) and the nav is persistent across screens.

---

## Critical Constraints — read these first, every time

1. **Height is platform-specific.** iOS tab bar: 49pt collapsed, 83pt with home indicator inset. Android bottom nav: 56dp (Material 2) or 80dp (Material 3 with label-always). Don't average; pick the platform and hold it.
2. **Safe-area inset is non-negotiable on iOS.** `padding-bottom: env(safe-area-inset-bottom)` on the nav container. Without it, the home indicator overlaps the tap targets and the bottom 34pt of the bar is unusable on Face ID iPhones.
3. **3–5 items. 4 is the sweet spot. Never 6+.** Six items collapses to a "More" tab that nobody ever finds — log analytics on any product that shipped it. If you need more sections, the IA is wrong, not the nav.
4. **Labels always show on mobile.** Icon-only is a desktop pattern. Mobile users can't hover for tooltips; a wordless icon is a guessing game. Exception: ultra-dense pro apps (Figma mobile, Bloomberg) where every user has been trained.
5. **Active state needs TWO signals, not one.** Filled icon + accent color (most apps). Or icon + 2px top indicator (Material 3). Color alone fails for ~5% of users with red-green confusion.
6. **Tap target ≥ 44pt iOS / 48dp Android.** Including the label. Tall-tap-zone, not just the icon.

---

## Framework — the four decisions, in order

### Decision 1 — Item count (3, 4, or 5)

- **3 items**: simple consumer apps with one primary verb (Shazam, Calm, single-purpose tools). Generous spacing per item.
- **4 items**: the optimal default. Instagram (pre-2022), Spotify, X. Each tab has room to breathe; labels never truncate.
- **5 items**: the upper bound. Use only when each tab is genuinely distinct and high-traffic (Instagram now: Home, Search, Reels, Shop, Profile). Labels start to feel tight at small device widths.
- **6+ items**: NO. Refactor. Move secondary destinations into a profile menu, a sheet, or contextual entry points. The "More" tab is a graveyard.

### Decision 2 — Variant (standard / FAB-notch / floating)

- **Standard bar**: 5 equal tabs. The 95% case. Material 3 + iOS HIG default.
- **FAB-notch**: 4 tabs with a raised circular primary action in the center (Instagram +, X compose, Strava record). Use ONLY when there is exactly one dominant create/start action the product is built around. The FAB sits 24dp above the bar (Material) or as an inline raised tab (iOS) and uses the accent color at full saturation.
- **Floating pill**: detached rounded-corner bar (Apple Maps, Threads). 16pt margin from screen edge, 32–40pt height. Feels lighter; risks accessibility because it cuts content beneath. Use for content-rich apps where the bar's job is navigation, not constant interaction.

### Decision 3 — Active state move

Pick ONE and hold it system-wide:

- **iOS classic**: filled icon (was outline) + accent color on icon and label. Label color shifts from `--muted` to `--accent`.
- **Material 3 indicator**: 2dp accent-colored bar at top edge of the active tab + filled icon variant + bolder label weight. The bar is 24dp wide, centered on the icon, with 2dp radius.
- **Pill background**: a rounded `--accent-soft` (8% alpha of accent) pill behind the icon+label. Modern, less visual noise than a top indicator. Used by Google Material You apps.

### Decision 4 — Scroll behavior (always-visible vs hide-on-scroll)

- **Always-visible**: the default. The bar is the nav; nav doesn't disappear because the user scrolled. Apple's HIG bias.
- **Hide-on-scroll-down, show-on-scroll-up**: earns its keep ONLY when the screen is content-heavy and the user explicitly wants reading real estate (Medium, Apple News, in-feed scrolling). Implementation: `translateY(100%)` on scroll-down past 80px threshold, `translateY(0)` on any scroll-up. 200ms `ease-out`. Never hide on horizontal scroll, never hide when a sheet is open.

---

## Concrete examples

### Example 1 — Full 5-item standard bar with safe-area inset (CSS-only)

```html
<style>
  :root {
    --bg: #fafafa;
    --surface: #ffffff;
    --fg: #111111;
    --muted: #8b8b8b;
    --border: #e5e5e5;
    --accent: #2f6feb;
    --accent-soft: rgba(47, 111, 235, 0.10);
  }
  .bottom-nav {
    position: fixed; left: 0; right: 0; bottom: 0;
    display: grid; grid-template-columns: repeat(5, 1fr);
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding-bottom: env(safe-area-inset-bottom);
    height: calc(49pt + env(safe-area-inset-bottom));
    z-index: 50;
  }
  .tab {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 2px; padding: 6px 4px;
    color: var(--muted);
    font: 500 10px/1 -apple-system, system-ui, sans-serif;
    letter-spacing: 0.01em;
    text-decoration: none;
    min-height: 44pt;
  }
  .tab svg { width: 24px; height: 24px; stroke-width: 1.75; }
  .tab[aria-current="page"] { color: var(--accent); }
  .tab[aria-current="page"] svg { stroke-width: 2.25; fill: var(--accent-soft); }
</style>
<nav class="bottom-nav" data-cx-id="bottom-nav" role="navigation" aria-label="Primary">
  <a class="tab" aria-current="page" href="#home"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z"/></svg>Home</a>
  <a class="tab" href="#search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>Search</a>
  <a class="tab" href="#library"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>Library</a>
  <a class="tab" href="#alerts"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 8a6 6 0 1 1 12 0v5l2 3H4l2-3z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>Alerts</a>
  <a class="tab" href="#profile"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>Profile</a>
</nav>
```

Why it works: 49pt icon row + `env(safe-area-inset-bottom)` for the home indicator. Active tab uses filled background pill + accent color + thicker stroke — two signals, not one. `aria-current="page"` is the semantic anchor; CSS selects off it. `min-height: 44pt` per tap target.

### Example 2 — FAB-notch variant (Instagram compose pattern)

```html
<style>
  .bottom-nav.with-fab { grid-template-columns: 1fr 1fr 88px 1fr 1fr; position: relative; }
  .fab-tab { position: relative; display: flex; align-items: center; justify-content: center; }
  .fab-tab .fab {
    position: absolute; top: -22px; left: 50%; transform: translateX(-50%);
    width: 56px; height: 56px; border-radius: 28px;
    background: var(--accent); color: var(--accent-fg, #fff);
    display: grid; place-items: center;
    box-shadow: 0 8px 20px rgba(47, 111, 235, 0.32), 0 2px 4px rgba(0,0,0,0.08);
    border: 4px solid var(--surface);
  }
  .fab svg { width: 28px; height: 28px; stroke-width: 2.5; }
  @media (prefers-reduced-motion: no-preference) {
    .fab { transition: transform 120ms ease-out; }
    .fab:active { transform: translateX(-50%) scale(0.92); }
  }
</style>
<nav class="bottom-nav with-fab" data-cx-id="bottom-nav">
  <a class="tab" aria-current="page" href="#home">Home</a>
  <a class="tab" href="#discover">Discover</a>
  <div class="fab-tab"><a class="fab" href="#compose" aria-label="Compose"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14"/></svg></a></div>
  <a class="tab" href="#inbox">Inbox</a>
  <a class="tab" href="#profile">You</a>
</nav>
```

Why it works: the FAB lifts 22px above the bar — visually decoupled from nav, signals "this is the create action." 4px white border separates it from the bar surface. 120ms `ease-out` scale on press matches iOS button-press feel. The center column is wider (88px) so the FAB has airspace; the surrounding tab labels still fit.

---

## Anti-patterns

- **Forgetting `env(safe-area-inset-bottom)`.** The home indicator overlaps the bar; the last 34pt is unusable. Single most common bottom-nav bug.
- **6+ tabs collapsed into a "More".** The "More" tab is where features go to die. Refactor IA before refactoring the nav.
- **Icon-only on mobile.** Users can't hover for tooltips. The 12px of saved height is not worth the cognitive cost.
- **Active state by color alone.** ~5% of users can't distinguish red-green; some can't distinguish low-saturation accent from gray. Always pair color with weight, fill, or indicator.
- **Animating the active-tab transition with a slide.** The classic mistake: a 1990s-style slider that moves between tabs. Distracting; never seen in iOS HIG or Material 3 reference. Fade the indicator in 120ms, don't slide it.
- **Hide-on-scroll for navigation-heavy apps.** If the user's primary task is moving between tabs (e.g. a banking app), hiding the bar is hostile. Reserve hide-on-scroll for content-reading flows.
- **Floating-pill bar without a content padding-bottom.** Content scrolls behind the bar and the last item is invisible. Always add `padding-bottom: calc(56pt + env(safe-area-inset-bottom) + 16px)` to the scroll container.
- **Tab height < 44pt iOS / 48dp Android.** Apple's HIG and Material's minimum tap target; below it, the bar fails accessibility audit.
