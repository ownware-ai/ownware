---
name: navigation-patterns
description: 'Primary / secondary / tertiary nav, mobile patterns, sticky header decisions. Four canonical patterns (top-bar, sidebar, hamburger, bottom-nav) and when to pick each. Use when the brief includes "design the nav", "build the header", or any app shell with >3 nav items. Pairs with /web-guidelines (marketing sites) and /forms-craft (auth shell that lives inside the nav). Skip for breadcrumbs only (those are a tertiary detail, not a nav pattern).'
trigger: /navigation-patterns
---

# Navigation Patterns — pick the right shell

## Overview

Navigation is the chassis of the product. Wrong chassis and every screen inside it fights the user. Right chassis and the user stops noticing the nav exists — which is the goal. This skill gives you the four canonical patterns, the decision rule for picking one, and the exact dimensions for each.

Four patterns, picked by surface type:

- **Top-bar horizontal** — marketing sites, single-app landing pages.
- **Sidebar fixed** — apps with 6+ primary destinations.
- **Hamburger** — mobile only, never desktop.
- **Bottom-nav** — mobile-app primary nav (3–5 items).

---

## Critical Constraints — read these first, every time

1. **Hamburger menus are MOBILE-ONLY.** A desktop hamburger menu hides discoverable destinations behind a click — the single biggest discoverability killer in nav design. On desktop, surface the items directly. Reserve hamburger for ≤768px viewports.
2. **Top-bar height: 72px desktop, 56px mobile.** Below 56px on mobile and the touch targets collapse. Above 72px on desktop and the nav eats hero-section real estate.
3. **Sidebar width: 240px expanded, 56–64px collapsed (icon-only).** Below 200px expanded, labels start to truncate. Above 280px and you're stealing canvas space.
4. **Active state is a LIFT (background + accent border-left), not just a text color change.** Color-only active states fail color-blind users and read as "hover" to most others. Add a 3px accent left border + a faint accent-tinted background.
5. **Sticky header decision: sticky on long-scroll pages (marketing, articles, blogs), NOT on dashboards.** Dashboards have fixed-viewport content; sticky nav is redundant and wastes 72px. Marketing pages benefit from sticky because the user scrolls deep and wants to come back to top-nav items.
6. **Mega-menus only when ≥8 destinations earn the depth.** A mega-menu with 4 items is a regular dropdown wearing a costume. Earn the depth or ship a dropdown.
7. **Bottom-nav: 3–5 items, never more.** Six items on a bottom-nav makes every item too narrow to tap reliably. The 5-item ceiling is from Apple and Google UX guidance for a reason.

---

## Framework — four patterns

### 1. Top-bar horizontal (marketing, single-app landing)

**Anatomy:** logo LEFT, primary nav CENTER-LEFT, utility/auth RIGHT.

```
[ Logo ]   Product · Pricing · Customers · Docs           [Sign in] [Get started]
```

**Dimensions:**
- Height: 72px desktop, 56px mobile
- Logo + nav padding: 24px left, 24px right (desktop)
- Nav-item gap: 28px (desktop), collapsed into hamburger ≤768px
- Background: `var(--surface)` with `border-bottom: 1px solid var(--border)`, or transparent over a colored hero
- Sticky behavior: `position: sticky; top: 0; z-index: 100;` + `backdrop-filter: blur(8px);` if the page scrolls under it

### 2. Sidebar fixed (apps with 6+ destinations)

**Anatomy:** logo top, primary nav as vertical list, secondary nav (settings, help) at bottom.

```
┌─────────────────┐
│ [Logo] Acme     │
├─────────────────┤
│ ◆ Dashboard    │  ← active row: 3px accent left border + tinted bg
│ ○ Customers    │
│ ○ Orders       │
│ ○ Reports      │
│ ○ Integrations │
├─────────────────┤
│ ○ Settings     │
│ ○ Help         │
│ [User avatar]   │
└─────────────────┘
```

**Dimensions:**
- Width: 240px expanded, 56px collapsed (icon-only)
- Row height: 40px standard, 36px compact
- Icon size: 18px, 12px gap to label
- Active row: `background: rgba(47,111,235,0.08); border-left: 3px solid var(--accent);` and label gets `color: var(--accent); font-weight: 600;`

### 3. Hamburger (mobile only)

**Anatomy:** logo LEFT, hamburger icon RIGHT (top-right is the convention; opposite the back button).

**Open state:** full-screen overlay or slide-in panel from the right. Items at 56px row height (touch target). Tapping an item closes the menu and navigates.

**Never on desktop.** Even on tablet, prefer the top-bar pattern unless you have ≥8 items.

### 4. Bottom-nav (mobile app primary)

**Anatomy:** 3–5 evenly-spaced items, icon + tiny label, fixed to viewport bottom.

```
┌──────┬──────┬──────┬──────┬──────┐
│ Home │ Find │  +   │ Bell │  Me  │
│  ◆   │  ○   │  ●   │  ○   │  ○   │   ← icons 24px
└──────┴──────┴──────┴──────┴──────┘
```

**Dimensions:**
- Height: 64px (including the iOS safe-area inset on iPhone)
- Icon: 24px, label 11px directly under (or no label if the icon is universal — home, search, bell)
- Active state: filled icon + accent color; inactive: outline icon + muted
- Center item (when present): elevated FAB-style primary action ("Compose", "Add", "Capture"), not a sibling tab

---

## Rubric — nav audit checklist

1. Right pattern for the surface? (Top-bar for marketing; sidebar for app; hamburger only on mobile; bottom-nav only on mobile-app primary.)
2. Logo + utility on opposite edges of the top-bar?
3. Active state uses lift (border + tint), not color alone?
4. Sticky behavior justified by content length?
5. Mega-menu (if present) earns the depth (≥8 destinations)?
6. Bottom-nav (if present) has ≤5 items?
7. Touch targets ≥44px tall on mobile?
8. Does the user know where they are at a glance? (Active state visible from across the room.)

---

## Concrete examples

### Example 1 — SaaS app with sidebar + top-bar utility

```html
<aside class="sidebar" data-cx-id="sidebar">
  <header class="sb-brand"><span class="logo">◆</span> Acme</header>
  <nav class="sb-nav">
    <a href="/dashboard" class="sb-item is-active">
      <span class="ic">◆</span>Dashboard
    </a>
    <a href="/customers" class="sb-item"><span class="ic">○</span>Customers</a>
    <a href="/orders" class="sb-item"><span class="ic">○</span>Orders</a>
    <a href="/reports" class="sb-item"><span class="ic">○</span>Reports</a>
    <a href="/integrations" class="sb-item"><span class="ic">○</span>Integrations</a>
  </nav>
  <footer class="sb-foot">
    <a href="/settings" class="sb-item"><span class="ic">⚙</span>Settings</a>
    <div class="sb-user"><span class="avatar">LP</span><div><div class="who">Lena Park</div><div class="email">lena@acme.co</div></div></div>
  </footer>
</aside>

<header class="topbar" data-cx-id="topbar">
  <div class="crumbs">Dashboard / Overview</div>
  <div class="util">
    <button class="icon-btn" aria-label="Search">⌕</button>
    <button class="icon-btn" aria-label="Notifications">🔔</button>
    <button class="btn-primary">New invoice</button>
  </div>
</header>

<style>
  .sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: 240px; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 16px 0; }
  .sb-brand { display: flex; align-items: center; gap: 8px; padding: 0 20px 16px; font: 600 15px var(--font-display); border-bottom: 1px solid var(--border); }
  .sb-nav { flex: 1; padding: 12px 8px; display: flex; flex-direction: column; gap: 2px; }
  .sb-item { display: flex; align-items: center; gap: 12px; padding: 9px 12px; height: 40px; border-radius: 6px; color: var(--fg); text-decoration: none; font: 500 14px var(--font-body); border-left: 3px solid transparent; margin-left: -3px; }
  .sb-item .ic { width: 18px; color: var(--muted); }
  .sb-item:hover { background: var(--bg); }
  .sb-item.is-active { background: rgba(47,111,235,0.08); border-left-color: var(--accent); color: var(--accent); font-weight: 600; }
  .sb-item.is-active .ic { color: var(--accent); }
  .sb-foot { padding: 12px 8px; border-top: 1px solid var(--border); }
  .sb-user { display: flex; align-items: center; gap: 10px; padding: 12px; margin-top: 4px; }
  .avatar { width: 32px; height: 32px; border-radius: 50%; background: var(--accent); color: white; display: grid; place-items: center; font-size: 13px; font-weight: 600; }
  .email { font-size: 12px; color: var(--muted); }

  .topbar { position: fixed; left: 240px; right: 0; top: 0; height: 64px; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 24px; z-index: 50; }
  .crumbs { font-size: 14px; color: var(--muted); }
  .util { display: flex; align-items: center; gap: 12px; }
  .icon-btn { width: 36px; height: 36px; border: 1px solid var(--border); background: var(--surface); border-radius: 8px; }

  @media (max-width: 900px) {
    .sidebar { transform: translateX(-100%); transition: transform 220ms; }
    .sidebar.is-open { transform: translateX(0); }
    .topbar { left: 0; }
  }
</style>
```

Active row gets a 3px accent left border, an 8%-tint background, and an accent-colored label — three signals so the active state is unmissable.

### Example 2 — marketing landing top-bar with mega-menu

```html
<header class="topnav" data-cx-id="topnav">
  <a class="brand" href="/">Acme</a>
  <nav class="primary">
    <button class="mega-toggle" aria-expanded="false">Product ▾</button>
    <a href="/pricing">Pricing</a>
    <a href="/customers">Customers</a>
    <a href="/docs">Docs</a>
  </nav>
  <div class="auth"><a class="btn-link" href="/sign-in">Sign in</a><a class="btn-primary" href="/sign-up">Get started</a></div>

  <div class="mega" hidden>
    <div><h4>Build</h4><a href="/editor">Editor</a><a href="/components">Components</a><a href="/themes">Themes</a></div>
    <div><h4>Run</h4><a href="/deploy">Deploy</a><a href="/scaling">Scaling</a><a href="/logs">Logs</a></div>
    <div><h4>Collaborate</h4><a href="/teams">Teams</a><a href="/reviews">Reviews</a><a href="/comments">Comments</a></div>
  </div>
</header>

<style>
  .topnav { position: sticky; top: 0; z-index: 100; height: 72px; display: flex; align-items: center; justify-content: space-between; padding: 0 5vw; background: rgba(255,255,255,0.85); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }
  .primary { display: flex; align-items: center; gap: 28px; }
  .primary a, .mega-toggle { font: 500 14px var(--font-body); color: var(--fg); text-decoration: none; background: none; border: none; cursor: pointer; }
  .mega { position: absolute; top: 72px; left: 0; right: 0; background: var(--surface); border-bottom: 1px solid var(--border); padding: 32px 5vw; display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; }
  .mega h4 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 0 0 12px; }
  .mega a { display: block; padding: 6px 0; }
  @media (max-width: 768px) { .primary { display: none; } /* swap in hamburger */ }
</style>
```

The mega-menu earns its depth with 9 destinations across 3 categories. With <8 items, this collapses to a regular dropdown.

---

## Anti-patterns

- **Hamburger on desktop.** Hides discoverable items. Use top-bar or sidebar.
- **Active state = text color change only.** Fails color-blind users and reads as hover. Add the lift.
- **Sidebar wider than 280px.** Eats canvas space the user paid for. 240px is the ceiling.
- **Bottom-nav with 6+ items.** Too narrow to tap. 5 is the ceiling.
- **Sticky nav on dashboards.** Wastes 72px on already-fixed-viewport content. Skip the sticky.
- **Mega-menu with 3 items.** Pretentious. Use a regular dropdown.
- **Logo in the center of the top-bar.** Reads as a brand-vanity move; pushes nav items to the edges and confuses scanning order. Logo LEFT.
- **Sign-in button bigger than the sign-up button.** Reverses the conversion priority. Sign-up gets the primary treatment; sign-in is a quiet text link.
- **Two competing primary CTAs in the top-bar.** "Get started" AND "Book a demo" at equal weight. Pick one primary; the other is a quiet secondary or sits inside a hero.
- **Truncating active-state label to fit in collapsed sidebar.** Collapsed sidebar should show icon-only with a tooltip on hover, not a truncated label.
