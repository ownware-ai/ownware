---
name: data-table-design
description: 'Sortable, filterable data tables — density modes, sticky headers, row hover, selection, pagination vs infinite scroll. Use when the brief includes a transactions list, a users table, an admin index, an audit log, or any tabular surface with >5 columns. Pairs with /dashboard-patterns (tables inside dashboards) and /filter-pattern (above-table filters). Skip for two-column key/value displays (those are definition lists, not tables).'
trigger: /data-table-design
---

# Data Table Design — density and discipline

## Overview

A data table is the most-used yet most-abused component in any product. The default HTML `<table>` is dense and ugly; the average designer pads it into uselessness and loses 60% of the screen. The discipline is to pick density by use case, align by data type, and make sorting/sticky-headers/selection feel like one coherent system — not three add-ons.

This skill is for transactional surfaces (rows users will scan, sort, filter, and act on). For dashboard summary cards see `/dashboard-patterns`; for above-the-table filters see `/filter-pattern`.

---

## Critical Constraints — read these first, every time

1. **Pick a density mode and stick to it.** Compact 32px row / standard 44px row / comfortable 56px row. Compact for traders, ops, admin tools. Standard for B2B SaaS lists. Comfortable for consumer-facing tables (rare). Never mix densities in one table.
2. **Left-align text, right-align numerics.** Names, statuses, descriptions left. Amounts, counts, percentages, dates (when ISO-ish) right. The numeric right-edge alignment is non-negotiable for scannability — eyes compare numbers by their rightmost digit.
3. **Tabular numerals on every numeric column.** `font-variant-numeric: tabular-nums;` on amount cells. Proportional numerals create a wavy column edge; tabular fixes the digit width so columns scan cleanly.
4. **Sticky header for any table >10 rows visible.** `position: sticky; top: 0; z-index: 2; background: var(--surface);` — and remember the background, or content scrolls through the header.
5. **Row hover is a subtle background lift, never a border change.** Border changes cause a 1px reflow that visibly shifts the row. Background-color change is free.
6. **Sort indicator is a caret beside the sortable column header, not a separate icon column.** Click the header to sort; the caret indicates direction. Never a stand-alone "sort" button.
7. **Paginated for transactional, infinite-scroll for browsing.** Tables where users need to go to "row 4,287 again" must paginate. Tables where users scan for vibes (search results, social feeds) can infinite-scroll. Mixing the two confuses everyone.

---

## Framework — anatomy of a real data table

### Density mode picker (pick ONE)

| Mode | Row height | Use case | Padding (vertical) |
|------|-----------|----------|--------------------|
| Compact | 32px | Trading, ops, admin dashboards, audit logs | 6px |
| Standard | 44px | B2B SaaS lists, CRM, support queues | 12px |
| Comfortable | 56px | Consumer-facing, accessibility-first | 18px |

Offer a density toggle (icon button: ☰ / ≡ / ☴) on tables users live in for hours. Skip the toggle on tables they visit briefly.

### Column rules

- **Text columns** — left-align, ellipsis on overflow (`text-overflow: ellipsis; white-space: nowrap; overflow: hidden;`). Add `title` attribute so the full string shows on hover.
- **Numeric columns** — right-align, `font-variant-numeric: tabular-nums;`, `font-feature-settings: 'tnum';`.
- **Date columns** — right-align if ISO format, left-align if relative ("2h ago"). Pick one format per table.
- **Status columns** — left-align, a small pill (`Active`, `Failed`, `Pending`) with semantic color, not a colored cell background.
- **Action column** — right-most, fixed width (~48px per icon), icons only with `title` tooltips, never text buttons in every row.

### Sticky header pattern

```css
.table-wrap { max-height: 600px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
thead th {
  position: sticky; top: 0; z-index: 2;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  /* a tiny shadow below the sticky header so the boundary is visible during scroll */
  box-shadow: 0 1px 0 var(--border);
}
```

### Row hover, selection, and selected-row state

- **Hover** — `tbody tr:hover { background: var(--surface-2); cursor: pointer; }` (cursor only if the row is clickable; never if it's not).
- **Selection** — first column is a checkbox column (40px wide); header checkbox toggles all-visible.
- **Selected row** — `tbody tr[aria-selected="true"] { background: rgba(47,111,235,0.08); }` — a 8% tint of the accent. Never a full accent fill; it overwhelms the row content.

### Pagination vs infinite scroll

- **Pagination** — bottom-right, `< 1 2 3 4 5 >` plus `Showing 1–20 of 487`. Use for transactional tables and any table where the user might say "row 47".
- **Infinite scroll** — only for browse-style lists. Always show a footer count once loaded ("Loaded 200 of ~1,200"). Always provide a "back to top" button after 3 screens scrolled.

---

## Rubric — table audit checklist

1. Is the density mode appropriate for the use case? (Don't ship "comfortable" on an ops table.)
2. Are numerics right-aligned with tabular-nums?
3. Does the header stay visible during scroll?
4. Is the sort indicator on the header, not a separate column?
5. Is row hover a background-only change?
6. Does the selected-row tint use accent at ≤10% opacity?
7. Is there a pagination footer with "Showing N of M"?
8. Does the action column use icons-with-tooltips, not text buttons per row?

Any "no" is a fix. Most "no"s fix in 2–10 lines of CSS.

---

## Concrete examples

### Example 1 — six-column transactions table, standard density, sticky header, sortable

```html
<section data-cx-id="transactions">
  <header class="table-head">
    <h2>Transactions</h2>
    <div class="density-toggle" role="group" aria-label="Density">
      <button data-density="compact" title="Compact">≡</button>
      <button data-density="standard" aria-pressed="true" title="Standard">☰</button>
      <button data-density="comfortable" title="Comfortable">☴</button>
    </div>
  </header>

  <div class="table-wrap">
    <table class="data-table" data-density="standard">
      <thead>
        <tr>
          <th class="col-check"><input type="checkbox" aria-label="Select all" /></th>
          <th class="sortable">Date <span class="caret">▼</span></th>
          <th>Description</th>
          <th>Customer</th>
          <th>Status</th>
          <th class="num sortable">Amount</th>
          <th class="col-actions" aria-label="Actions"></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><input type="checkbox" aria-label="Select row" /></td>
          <td class="num">2026-05-24</td>
          <td>Pro plan — monthly</td>
          <td>Lena Park</td>
          <td><span class="pill ok">Paid</span></td>
          <td class="num">$49.00</td>
          <td class="col-actions"><button title="Refund">↶</button><button title="Open">→</button></td>
        </tr>
        <tr aria-selected="true">
          <td><input type="checkbox" aria-label="Select row" checked /></td>
          <td class="num">2026-05-23</td>
          <td>Team plan — annual</td>
          <td>Plaid</td>
          <td><span class="pill warn">Pending</span></td>
          <td class="num">$2,388.00</td>
          <td class="col-actions"><button title="Refund">↶</button><button title="Open">→</button></td>
        </tr>
        <tr>
          <td><input type="checkbox" aria-label="Select row" /></td>
          <td class="num">2026-05-23</td>
          <td>Pro plan — monthly</td>
          <td>Marco Silva</td>
          <td><span class="pill bad">Failed</span></td>
          <td class="num">$49.00</td>
          <td class="col-actions"><button title="Retry">↻</button><button title="Open">→</button></td>
        </tr>
      </tbody>
    </table>
  </div>

  <footer class="table-foot">
    <span class="count">Showing 1–20 of 487</span>
    <nav class="pager"><button>‹</button><button aria-current="page">1</button><button>2</button><button>3</button><button>›</button></nav>
  </footer>
</section>

<style>
  .table-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .density-toggle button { width: 32px; height: 32px; border: 1px solid var(--border); background: var(--surface); }
  .density-toggle button[aria-pressed="true"] { background: var(--fg); color: var(--bg); }

  .table-wrap { max-height: 600px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
  .data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .data-table th, .data-table td { padding: 12px 14px; border-bottom: 1px solid var(--border); text-align: left; }
  .data-table[data-density="compact"] th, .data-table[data-density="compact"] td { padding: 6px 12px; font-size: 13px; }
  .data-table[data-density="comfortable"] th, .data-table[data-density="comfortable"] td { padding: 18px 16px; }
  .data-table thead th { position: sticky; top: 0; z-index: 2; background: var(--surface); font-weight: 600; color: var(--muted); border-bottom: 1px solid var(--border); box-shadow: 0 1px 0 var(--border); }
  .data-table th.num, .data-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .data-table th.sortable { cursor: pointer; user-select: none; }
  .data-table th.sortable .caret { color: var(--muted); margin-left: 4px; }
  .data-table tbody tr:hover { background: var(--bg); cursor: pointer; }
  .data-table tbody tr[aria-selected="true"] { background: rgba(47,111,235,0.08); }
  .col-check, .col-actions { width: 40px; }
  .col-actions { text-align: right; }
  .col-actions button { width: 28px; height: 28px; border: 1px solid transparent; background: transparent; color: var(--muted); border-radius: 6px; }
  .col-actions button:hover { background: var(--border); color: var(--fg); }
  .pill { padding: 3px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; }
  .pill.ok { background: rgba(23,163,74,0.12); color: var(--good); }
  .pill.warn { background: rgba(234,179,8,0.15); color: #a67200; }
  .pill.bad { background: rgba(220,38,38,0.10); color: var(--bad); }
  .table-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; font-size: 13px; color: var(--muted); }
  .pager button { width: 30px; height: 30px; border: 1px solid var(--border); background: var(--surface); }
  .pager button[aria-current="page"] { background: var(--fg); color: var(--bg); }
</style>
```

Standard density. Sticky header with a 1px shadow boundary. Tabular numerals on Date and Amount. Status pills (not full-row tinted). Selected row at 8% accent. Pagination footer with explicit count.

### Example 2 — compact density for an ops audit log

For an audit log surface, swap `data-density="standard"` → `data-density="compact"`. Row height drops to 32px, font-size to 13px, padding to 6px 12px. The same six-column table now fits ~25 rows in a 600px viewport instead of 14, which is the whole point of an audit log.

---

## Anti-patterns

- **Mixing left/right alignment on numerics.** "Amount" left-aligned next to "Customer" left-aligned is unscannable. Right-align every numeric column.
- **Proportional numerals.** Default browser rendering gives uneven column edges. `font-variant-numeric: tabular-nums;` everywhere.
- **Sticky header without a background.** The body content scrolls behind the header text. Always set `background: var(--surface)` on sticky `th`.
- **Full-row accent fill on selection.** Drowns the content. 8% tint maximum.
- **Border change on row hover.** Causes a 1px reflow; the eye sees it as the row "jumping". Background change only.
- **Text buttons in every row.** Bloats the action column. Icons with `title` tooltips.
- **One-size-fits-all density.** Compact for traders, comfortable for grandparents — pick by use case.
- **Pagination AND infinite-scroll on the same table.** Pick one. Hybrid surfaces confuse the back button and the count display.
- **Sort indicator in its own column.** Wastes width and decouples the action from its target. The indicator lives on the header.
- **No "showing N of M" count on a paginated table.** Users can't tell where they are in the dataset. Always show the count.
