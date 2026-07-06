---
name: filter-pattern
description: 'Pick the right filter layout for the data shape — chip row (≤5 binary), sidebar facets (catalog/e-commerce ≥10), modal advanced-filter (complex queries), inline column-header filters (tables). Use when the brief is "filter the list", "narrow the table", or any surface with a filterable result set. Pairs with /dashboard-patterns and /data-table-design. Skip for single-axis sort (that''s a sort dropdown, not a filter).'
trigger: /filter-pattern
---

# Filter Pattern — match the layout to the data

## Overview

Filtering is a layout decision before it's a UX decision. Four patterns cover 95% of cases, and they're not interchangeable — a sidebar full of facets on a 5-filter table is overkill, a chip row on a 30-facet e-commerce catalog is unusable. Pick by the data shape, ship the convention, and your users will navigate without thinking.

This skill covers WHICH pattern. For the input controls themselves (selects, range sliders, checkboxes), pair with `/forms-craft`. For column-header filters in a table, pair with `/data-table-design`.

---

## Critical Constraints — read these first, every time

1. **Pick ONE pattern per surface.** Mixing a sidebar AND chip-row AND column-header filters on the same table is what bad enterprise software looks like. Pick the right one and commit.
2. **Active filter affordance is non-negotiable.** The user must see what's currently filtered at a glance — chip pills with × removers, or underlined sidebar items with counts, or the parent surface showing a count badge ("Filters (3)").
3. **"Clear all" link is mandatory once any filter is active.** Top-right of the filter region (or top-right of the sidebar). Single click, single confirmation if destructive, never buried in a menu.
4. **Filter counts on each option — show the number of results that match BEFORE the user clicks.** "In stock (1,247)" / "Out of stock (84)" — the count is the cheapest information you can give the user about whether the click is worth it.
5. **Filters update results LIVE (no Apply button) for ≤6 filters total. Add Apply only when filters are expensive (server-side faceted search >300ms).** The Apply button is a tax on every interaction; charge it only when round-trips hurt.
6. **Disabled filter options stay visible (not hidden) when they'd return zero results.** Hiding makes users think the filter is broken. Show the option, disable the click, grey it out, show "(0)".
7. **Mobile: collapse the filter sidebar into a full-screen drawer triggered by a "Filters (N)" button.** Sidebars don't work below 768px; a drawer does.

---

## Framework — four patterns by data shape

### 1. Chip row (≤5 binary filters, dashboards & inboxes)

A horizontal row of filter chips at the top of the list. Each chip is a binary toggle (active / inactive). Best when the user has 3–5 well-known dimensions to slice by.

**Use when:** dashboards (date range + status), inboxes (all / unread / starred), task lists (all / active / archived).

**Anatomy:**
```
[ Last 7 days ▾ ]   [ All status ▾ ]   [ Sort: Newest ▾ ]      Clear all
```

Chips are 32–36px tall, 12px horizontal padding, rounded `999px`. Active chip gets accent-tinted background + accent border.

### 2. Sidebar facets (catalog/e-commerce, ≥10 filters)

A vertical sidebar with grouped facets. Each group is a heading (Category, Price, Brand) with the options stacked below. Standard for e-commerce, asset libraries, document repositories.

**Use when:** product catalogs, image libraries, document search with many dimensions, anywhere the user wants to drill down.

**Anatomy:**
```
┌──────────────────┐
│ Filters     Clear│
├──────────────────┤
│ PRICE            │
│ □ Under $25 (84) │
│ □ $25–$50 (192)  │
│ ▣ $50–$100 (314) │
├──────────────────┤
│ CATEGORY         │
│ □ Headphones (47)│
│ ▣ Speakers (89)  │
├──────────────────┤
│ BRAND            │
│ [Search brands]  │
│ □ Sonos (24)     │
│ ▣ Apple (38)     │
└──────────────────┘
```

- Sidebar width: 240–280px desktop, full-screen drawer on mobile.
- Group spacing: 24px between groups, 16px padding inside.
- Each option: 28–32px row height, checkbox + label + count (count right-aligned, muted).
- Brand-style groups with 8+ options get a search-within-facet input.

### 3. Modal advanced-filter (complex queries, power users)

A modal with multiple field types (text, select, date range, multi-select) for building specific queries. Used as an "Advanced filters" escape hatch when the chip row or sidebar can't express the query.

**Use when:** CRM ("contacts where industry IS X AND last contacted >30 days AND deal value >$5k"), audit logs ("events of type X between dates Y and Z by user W"), data tools with arbitrary query needs.

**Anatomy:** modal at 600–720px wide, two-column field layout, Save view + Apply buttons at the bottom. Apply closes; "Save view" prompts for a name and stores the filter set.

### 4. Inline column-header filters (data tables)

Each sortable column header doubles as a filter trigger. Click a chevron beside the header → opens a popover with that column's filter (text, select, range, date picker).

**Use when:** dense data tables where the user already knows which column they want to filter by. NOT a primary pattern — usually paired with chip-row above for the binary slices.

**Anatomy:** a 14px filter icon appears in the header on hover; click opens a 240px popover anchored below the header. Active column-filters get a tinted background on the header.

---

## Rubric — filter audit checklist

1. Right pattern for the data shape? (Chip ≤5, sidebar ≥10, modal for complex, inline for tables.)
2. Active filters visible at a glance (chips with ×, or sidebar tick marks)?
3. "Clear all" present and one click away?
4. Each option shows a count (or "0" disabled)?
5. Results update live (≤6 filters) or behind an explicit Apply (complex)?
6. Disabled options stay visible, not hidden?
7. Mobile: filter sidebar collapses into a "Filters (N)" drawer button?
8. Filter state is shareable via URL? (For sidebar + chip-row patterns; users will copy the URL.)

---

## Concrete examples

### Example 1 — product catalog with sidebar facets

```html
<div class="catalog" data-cx-id="catalog">
  <aside class="filters" data-cx-id="filters">
    <header><h2>Filters</h2><button class="clear">Clear all</button></header>

    <section class="facet">
      <h3>Price</h3>
      <label><input type="checkbox" /> Under $25 <span class="count">84</span></label>
      <label><input type="checkbox" /> $25–$50 <span class="count">192</span></label>
      <label><input type="checkbox" checked /> $50–$100 <span class="count">314</span></label>
      <label><input type="checkbox" /> $100+ <span class="count">141</span></label>
    </section>

    <section class="facet">
      <h3>Category</h3>
      <label><input type="checkbox" /> Headphones <span class="count">47</span></label>
      <label><input type="checkbox" checked /> Speakers <span class="count">89</span></label>
      <label><input type="checkbox" /> Turntables <span class="count">12</span></label>
      <label class="is-disabled"><input type="checkbox" disabled /> Microphones <span class="count">0</span></label>
    </section>

    <section class="facet">
      <h3>Brand</h3>
      <input class="facet-search" type="search" placeholder="Search brands…" />
      <label><input type="checkbox" /> Sonos <span class="count">24</span></label>
      <label><input type="checkbox" checked /> Apple <span class="count">38</span></label>
      <label><input type="checkbox" /> Bose <span class="count">19</span></label>
    </section>

    <section class="facet">
      <h3>Availability</h3>
      <label><input type="checkbox" checked /> In stock <span class="count">1,247</span></label>
      <label><input type="checkbox" /> Pre-order <span class="count">14</span></label>
    </section>
  </aside>

  <main class="results">… product grid …</main>
</div>

<style>
  .catalog { display: grid; grid-template-columns: 260px 1fr; gap: 32px; }
  .filters header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 12px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
  .filters h2 { font: 600 14px var(--font-display); margin: 0; }
  .filters .clear { background: none; border: none; color: var(--accent); font: 500 13px var(--font-body); cursor: pointer; }
  .facet { padding: 16px 0; border-bottom: 1px solid var(--border); }
  .facet h3 { font: 600 12px var(--font-display); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 10px; }
  .facet label { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 14px; cursor: pointer; }
  .facet label.is-disabled { color: var(--muted); cursor: not-allowed; }
  .facet .count { margin-left: auto; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .facet-search { width: 100%; height: 32px; padding: 0 10px; font-size: 13px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; }

  @media (max-width: 900px) {
    .catalog { grid-template-columns: 1fr; }
    .filters { position: fixed; inset: 0; background: var(--surface); padding: 24px; z-index: 200; transform: translateX(-100%); transition: transform 220ms; }
    .filters.is-open { transform: translateX(0); }
  }
</style>
```

Active filters are visible at a glance (checkboxes filled). Each option carries a count. Disabled options ("Microphones (0)") stay visible but greyed. "Clear all" sits top-right. Below 900px the sidebar collapses to a drawer.

### Example 2 — dashboard with chip-row filters

```html
<header class="dash-head" data-cx-id="dash-head">
  <h1>Transactions</h1>
  <div class="chip-row">
    <button class="chip is-active">Last 7 days <span class="caret">▾</span></button>
    <button class="chip">All status <span class="caret">▾</span></button>
    <button class="chip is-active">My team <span class="caret">▾</span></button>
    <button class="chip-clear">Clear (2)</button>
  </div>
</header>

<style>
  .dash-head { display: flex; align-items: center; justify-content: space-between; padding: 24px 32px; border-bottom: 1px solid var(--border); }
  .dash-head h1 { font: 600 22px var(--font-display); margin: 0; }
  .chip-row { display: flex; align-items: center; gap: 8px; }
  .chip { height: 34px; padding: 0 14px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); font: 500 13px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  .chip:hover { background: var(--bg); }
  .chip.is-active { background: rgba(47,111,235,0.10); border-color: var(--accent); color: var(--accent); }
  .chip .caret { font-size: 9px; opacity: 0.7; }
  .chip-clear { background: none; border: none; color: var(--muted); font: 500 13px var(--font-body); cursor: pointer; padding: 0 4px; margin-left: 4px; }
  .chip-clear:hover { color: var(--fg); }
</style>
```

Three filters, two currently active (visible at a glance from the accent-tinted chips), "Clear (2)" links it home. The filters live above the table and update results live — no Apply button.

---

## Anti-patterns

- **Sidebar facets on a 4-filter dashboard.** Overkill. Use chip-row.
- **Chip-row on a 30-facet catalog.** Unusable. Use sidebar.
- **Hiding zero-result options.** Looks like the filter is broken. Show them disabled.
- **No count on each option.** User has to click to find out if it's worth it. Show counts.
- **"Apply filters" button on a 3-filter dashboard.** Tax on every interaction. Apply live.
- **No "Clear all" link.** Users can't reset; they reload the page. Always offer it.
- **Active-filter state shown only inside the menu.** User closes the menu, sees the unfiltered-looking surface, panics. Always surface active state outside the open menu (chip color, sidebar tick, parent badge count).
- **Filter state lost on page refresh.** Frustrating for any non-trivial query. Serialize to URL params (`?status=active&date=last7`).
- **Sidebar that doesn't collapse on mobile.** Eats the viewport, leaves no room for results. Drawer pattern below 900px.
- **Mixing sidebar + chip-row + column-header filters on the same surface.** Three competing patterns for one job. Pick one primary.
- **"Advanced filters" buried two clicks deep when the user uses them on every visit.** If the modal is the primary workflow, surface a "Saved views" dropdown so the user goes from query → result in one click, not three.
