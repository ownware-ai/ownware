---
name: search-design
description: 'Search-as-you-type, results layout, no-match state, recent-search affordance, keyboard navigation. Use for any search surface — header search, command palette, in-app filter-by-keyword. Pairs with /forms-craft (the input) and /dashboard-patterns (search inside the app shell). Skip for filter chips that aren''t free-text (see /filter-pattern) and for full-page search-results pages (a separate exercise).'
trigger: /search-design
---

# Search Design — typed input, ranked results, predictable keys

## Overview

Search is the one input the user trusts implicitly: if it doesn't return what they expect, they leave. The discipline is to debounce smartly (250ms), show recent searches on focus, render results in a predictable layout (icon + title + snippet + meta), handle the no-match state with an actual suggestion, and ship keyboard navigation (↑/↓/Enter/Esc) so power users never need to touch the mouse.

This skill is about the search COMPONENT — input + dropdown OR input + full-page results. For full-page result-list design (with pagination, filters, faceting), pair with `/data-table-design` and `/filter-pattern`.

---

## Critical Constraints — read these first, every time

1. **Debounce 250ms, minimum 2 characters before firing the query.** 250ms balances "feels live" against "doesn't hammer the API on every keystroke". 2-char minimum kills the noise from single-letter queries that match everything.
2. **Search input height matches the form bedrock — 40px compact / 44px standard.** It is a form input. Same rules apply (see `/forms-craft`).
3. **Place search consistently: top-right in apps, sticky-or-hero in marketing.** Users learn one location per product. Moving it across screens is a discoverability bug.
4. **Results dropdown OR full-page results — pick by use case, never both.** Dropdown for command-palette-style + quick-jump (Linear, Spotlight, Notion). Full-page for content discovery (Google, e-commerce). A hybrid where the dropdown ALSO has a "see all results" link is fine; mixing both as the primary UX is confusing.
5. **Every result row has the same anatomy: icon (16–20px), title (14–15px), snippet (13px muted, 1 line), meta (12px muted, right-aligned).** Drift on row anatomy reads as drift on data quality.
6. **No-match state shows ALL of: the query that failed, a suggestion or correction, and recent-searches as fallback.** "No results for crm" alone is a dead-end. "No results for crm. Did you mean CRM? · Recent: customers, orders, billing." gives the user three escape hatches.
7. **Keyboard nav is non-negotiable: ↑/↓ traverse, Enter selects, Esc closes, ⌘K or / opens.** Power users will not use the mouse. If your search doesn't ship arrow-key support, half your audience hates it silently.

---

## Framework — the search component anatomy

### The input

- Placeholder: "Search…" (default) or descriptive ("Search customers, orders, or invoices"). Never empty.
- Icon: magnifying glass LEFT inside the input (12px from left edge, 16px size).
- Clear-button (×): appears RIGHT inside the input when there's a value. Click clears + refocuses input. Esc also clears.
- Keyboard hint: `⌘K` or `/` rendered as a kbd-pill RIGHT inside the input (visible when not focused, hidden when typing).

### Search-as-you-type

```js
let timer;
input.addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(timer);
  if (q.length < 2) { renderRecent(); return; }
  timer = setTimeout(() => runQuery(q), 250);
});
```

250ms debounce. 2-char minimum. Below the minimum, render recent-searches as the fallback view.

### Results dropdown anatomy

```
┌──────────────────────────────────────────┐
│ Search "rea_"                          × │
├──────────────────────────────────────────┤
│ PAGES                                    │
│ ◆ Reports — Q3 dashboard          /pages │   ← row 40-44px
│ ◆ Reading list — saved articles   /docs  │
├──────────────────────────────────────────┤
│ PEOPLE                                   │
│ ○ Rebecca Park — Head of CX       Lena   │
│ ○ Reagan Silva — Designer         Marco  │
├──────────────────────────────────────────┤
│ ↑↓ to navigate · Enter to open · Esc     │
└──────────────────────────────────────────┘
```

- Group results by type (Pages, People, Docs, Settings). Section header is 12px uppercase muted.
- Row anatomy: `icon · title · snippet · meta` — 40–44px tall, 12px horizontal padding.
- Highlight the matched substring inside titles with `<mark>` (rendered as accent-tinted background, not yellow).
- Active row (keyboard-focused or hovered): `background: var(--bg); border-left: 3px solid var(--accent);`.
- Footer with keyboard hints at the bottom — 32px tall, 12px text, muted.

### No-match state

```
┌──────────────────────────────────────────┐
│ Search "crmm"                          × │
├──────────────────────────────────────────┤
│  No results for "crmm".                  │
│  Did you mean CRM?                       │
│                                          │
│  RECENT                                  │
│ ○ customers                              │
│ ○ orders                                 │
│ ○ billing                                │
└──────────────────────────────────────────┘
```

Three escape hatches in one view: the failed query echoed back, a suggestion (if your search has spell-correct), and recent-searches as a quick recovery.

### Recent searches (the empty-state-on-focus pattern)

When the user focuses the input but hasn't typed yet:

```
┌──────────────────────────────────────────┐
│ RECENT                                   │
│ ○ Lena Park                              │
│ ○ Q3 dashboard                           │
│ ○ refunds                                │
│ ──────────────                           │
│ SUGGESTIONS                              │
│ ○ Today's transactions                   │
│ ○ Failed payments                        │
└──────────────────────────────────────────┘
```

Stored in localStorage (last 5 unique queries) + a curated "suggestions" list for first-time users.

### Keyboard navigation map

| Key | Action |
|-----|--------|
| `⌘K` or `/` | Open search from anywhere in the app |
| `↑` / `↓` | Move active row |
| `Enter` | Open active row |
| `Esc` | Close dropdown / clear if empty |
| `Tab` | Move out of search (to next focusable element) |

---

## Rubric — search audit checklist

1. Is the debounce 200–300ms (not 0, not 1000)?
2. Is the 2-char minimum enforced?
3. Are results grouped by type with a section header?
4. Is row anatomy consistent (icon · title · snippet · meta)?
5. Is the matched substring highlighted inside titles?
6. Does the no-match state show the query echoed back AND an escape hatch?
7. Does the empty-on-focus state show recent searches?
8. Do ↑/↓/Enter/Esc all work?
9. Is `⌘K` (or `/`) registered globally?
10. Is the search input in the same place on every screen?

---

## Concrete examples

### Example 1 — header search with inline dropdown (three result types)

```html
<div class="search" data-cx-id="search">
  <span class="ic" aria-hidden="true">⌕</span>
  <input id="q" type="search" placeholder="Search pages, people, docs…" autocomplete="off" />
  <kbd class="hint">⌘K</kbd>

  <div class="results" role="listbox" hidden>
    <div class="group">
      <header>PAGES</header>
      <button class="row is-active" role="option">
        <span class="ic">◆</span>
        <div class="text"><div class="title">Q3 <mark>rea</mark>dout — board deck</div><div class="snip">Last edited 2h ago</div></div>
        <span class="meta">/decks</span>
      </button>
      <button class="row" role="option">
        <span class="ic">◆</span>
        <div class="text"><div class="title"><mark>Rea</mark>ding list</div><div class="snip">Saved articles · 18 items</div></div>
        <span class="meta">/docs</span>
      </button>
    </div>
    <div class="group">
      <header>PEOPLE</header>
      <button class="row" role="option">
        <span class="ic avatar">RP</span>
        <div class="text"><div class="title"><mark>Rea</mark>gan Park</div><div class="snip">Head of CX · Ramp</div></div>
        <span class="meta">@reagan</span>
      </button>
    </div>
    <div class="group">
      <header>DOCS</header>
      <button class="row" role="option">
        <span class="ic">📄</span>
        <div class="text"><div class="title">How to <mark>rea</mark>ssign a ticket</div><div class="snip">Support runbook · updated May 2026</div></div>
        <span class="meta">/help</span>
      </button>
    </div>
    <footer class="kb">↑↓ navigate · Enter open · Esc close</footer>
  </div>
</div>

<style>
  .search { position: relative; width: 100%; max-width: 480px; }
  .search input { width: 100%; height: 40px; padding: 0 70px 0 38px; font-size: 15px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
  .search input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(47,111,235,0.15); }
  .search .ic { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--muted); }
  .search .hint { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); font: 500 11px var(--font-mono); padding: 3px 6px; border: 1px solid var(--border); border-radius: 4px; color: var(--muted); }
  .search input:focus ~ .hint { display: none; }

  .results { position: absolute; top: 48px; left: 0; right: 0; max-height: 520px; overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.08); z-index: 200; }
  .group header { font: 600 11px var(--font-body); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); padding: 12px 16px 6px; }
  .row { display: grid; grid-template-columns: 24px 1fr auto; gap: 12px; align-items: center; width: 100%; padding: 8px 16px; border: none; background: transparent; text-align: left; cursor: pointer; border-left: 3px solid transparent; margin-left: -3px; }
  .row:hover, .row.is-active { background: var(--bg); border-left-color: var(--accent); }
  .row .ic { color: var(--muted); }
  .row .ic.avatar { background: var(--accent); color: white; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font: 600 11px var(--font-body); }
  .row .title { font-size: 14px; font-weight: 500; color: var(--fg); }
  .row .title mark { background: rgba(47,111,235,0.18); color: inherit; padding: 0 2px; border-radius: 3px; }
  .row .snip { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .row .meta { font-size: 12px; color: var(--muted); font-family: var(--font-mono); }
  .kb { padding: 10px 16px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--border); background: var(--bg); }
</style>
```

Three groups (Pages, People, Docs), consistent row anatomy across all three, `<mark>` highlighting on the matched substring, active row with the accent left-border lift, keyboard hint footer at the bottom.

### Example 2 — no-match state with three escape hatches

```html
<div class="results" role="listbox">
  <div class="empty">
    <p>No results for <strong>"crmm"</strong>.</p>
    <p class="suggest">Did you mean <a href="#" class="link">CRM</a>?</p>
  </div>
  <div class="group">
    <header>RECENT</header>
    <button class="row"><span class="ic">⏱</span><div class="text"><div class="title">customers</div></div></button>
    <button class="row"><span class="ic">⏱</span><div class="text"><div class="title">orders</div></div></button>
    <button class="row"><span class="ic">⏱</span><div class="text"><div class="title">billing</div></div></button>
  </div>
</div>

<style>
  .empty { padding: 24px 16px 12px; }
  .empty p { margin: 0 0 8px; font-size: 14px; }
  .empty .suggest { color: var(--muted); }
  .empty .link { color: var(--accent); text-decoration: none; }
  .empty .link:hover { text-decoration: underline; }
</style>
```

The failed query is echoed back (`"crmm"`), the suggestion is one click away (`CRM`), and recent searches give the user a third recovery path. Never a blank "no results" wall.

---

## Anti-patterns

- **No debounce.** Fires a request on every keystroke. Hammers the API, makes results flicker.
- **0-char or 1-char queries.** Returns everything, scrolls forever. Enforce ≥2.
- **All results in one unsorted list.** Mixes pages with people with docs and the user can't scan. Group by type.
- **Yellow `<mark>` highlight.** Browser default is yellow; clashes with every modern palette. Style it to accent-tinted at 18% opacity.
- **No keyboard navigation.** Power users will rage-quit. ↑/↓/Enter/Esc are required.
- **No-match state that says only "No results."** Dead-end. Echo the query, suggest a correction, fall back to recent searches.
- **Search input in a different place per screen.** Header on the home, sidebar on the dashboard, modal on settings. Pick one location and ship it everywhere.
- **Search results that auto-navigate on first match.** Hostile — the user wanted to see options. Never auto-navigate; Enter selects.
- **Clear-button on the LEFT of the input.** Convention is RIGHT (after the value). Reversing it slows the user.
- **Recent-searches stored server-side without a "clear" option.** Privacy footgun. Always offer a way to clear; localStorage is fine for most products.
