---
name: interactive-artifact
description: 'Build a complex, stateful, multi-component artifact in one self-contained HTML file using React + Tailwind via CDN. Use ONLY when the brief needs state, multiple views, or 4+ interactive components (calculator, multi-step flow, configurator). For static landing pages, brand sheets, decks, and basic mocks, use the simpler /artifact instead — it is the default and 90% of work lives there. For surgical edits to an existing file, follow /artifact editing rules.'
trigger: /interactive-artifact
---

# Interactive Artifact — React + Tailwind in one file, no bundler

## Overview

`/artifact` is the default. It produces one HTML file with inline `<style>` + `:root` tokens + `data-cx-id` anchors, and it handles 90% of work — landing pages, brand sheets, mocks, dashboards-as-mockups, decks. **If the brief fits there, use it.** This skill exists for the other 10%: artifacts that genuinely need stateful React components and Tailwind utility composition in one file.

Escalate to this skill when at least TWO of these are true:
1. The artifact has 4+ interactive components (a calculator, a configurator, a multi-step form, a filterable table).
2. State needs to flow between components (a slider changes a chart that changes a price card).
3. The user explicitly asked for "interactive prototype" or "working version" not "mockup".
4. The component tree benefits from JSX composition (you'd be writing 10+ event listeners manually otherwise).

If only one is true, push back: "This still fits the simpler artifact pattern. Want me to use that?" Misuse of this skill is the most common way artifacts get bloated.

---

## Critical Constraints — read these first, every time

1. **Still one file.** Inline `<style>`, inline `<script>`. React via CDN, Tailwind via CDN, no bundler, no `npm install`. The whole file remains previewable in the canvas with zero build step.
2. **Pin CDN versions.** Never `@latest`. Use the exact versions in the boilerplate below. An unpinned CDN can break the preview on a Tuesday.
3. **`:root` tokens still rule.** Tailwind utilities are convenience; brand colors come from `:root` tokens consumed via Tailwind's arbitrary-value syntax (`bg-[var(--accent)]`) or via a `tailwind.config` block. Never hardcode `#2f6feb` in a `bg-blue-600` class — that's the moment the token system dies.
4. **`data-cx-id` on every top-level region.** Same rule as `/artifact`. Required for surgical edits later.
5. **One `<script type="text/babel">` block, not many.** Multiple Babel blocks each have their own scope; sharing state across blocks via `window.X = X` produces silent collisions. Keep all components in one block.
6. **No bare `const styles = {}` at top level.** Name style objects by component (`const calcStyles = {}`). The minute two component blocks reuse the name, the second silently overwrites the first.
7. **No `<script type="module">`.** Breaks Babel transpile.
8. **No `useEffect` that fetches from the network.** The preview runs offline. Inline the data.
9. **Keep individual files under ~1500 lines.** Above that, even React+Tailwind can't save the readability — split into separate artifacts linked by `<a href>`.
10. **For state, `useState` + `useReducer` only.** No Redux, no Zustand, no MobX, no Jotai. The whole point is one file.

---

## The boilerplate — paste this every time, don't improvise

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{Descriptive title}</title>

  <!-- Tailwind CDN — pinned -->
  <script src="https://cdn.tailwindcss.com/3.4.16"></script>

  <!-- React CDN — pinned -->
  <script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.development.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js"></script>

  <script>
    // Tailwind config — extends, never replaces, so the default scale survives
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            bg: 'var(--bg)',
            surface: 'var(--surface)',
            fg: 'var(--fg)',
            muted: 'var(--muted)',
            border: 'var(--border)',
            accent: 'var(--accent)',
            'accent-hover': 'var(--accent-hover)',
            'accent-fg': 'var(--accent-fg)',
            good: 'var(--good)',
            warn: 'var(--warn)',
            bad: 'var(--bad)',
          },
          borderRadius: {
            DEFAULT: 'var(--radius)',
            pill: 'var(--radius-pill)',
          },
          fontFamily: {
            display: 'var(--font-display)',
            body: 'var(--font-body)',
            mono: 'var(--font-mono)',
          },
        },
      },
    }
  </script>

  <style>
    /* 1. TOKENS — :root block, hex colors ONLY in here */
    :root {
      --bg: #fafafa;
      --surface: #ffffff;
      --fg: #111111;
      --muted: #6b6b6b;
      --border: #e5e5e5;
      --accent: #2f6feb;
      --accent-hover: #1f5fd6;
      --accent-fg: #ffffff;
      --good: #17a34a;
      --warn: #eab308;
      --bad: #dc2626;
      --radius: 8px;
      --radius-pill: 999px;
      --font-display: "Inter", -apple-system, system-ui, sans-serif;
      --font-body: "Inter", -apple-system, system-ui, sans-serif;
      --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
    }

    /* 2. RESETS / GLOBALS — Tailwind's preflight covers most; add only what Tailwind misses */
    body { background: var(--bg); color: var(--fg); font-family: var(--font-body); text-wrap: pretty; }
    h1, h2, h3, h4 { font-family: var(--font-display); letter-spacing: -0.01em; text-wrap: balance; }
  </style>
</head>
<body>
  <div id="root"></div>

  <script type="text/babel" data-presets="env,react">
    const { useState, useReducer, useMemo, useCallback } = React;

    // === Components live here ===

    function PriceBadge({ amount, currency }) {
      return (
        <span className="font-mono text-fg">
          {currency}{amount.toFixed(2)}
        </span>
      );
    }

    function App() {
      const [seats, setSeats] = useState(5);
      const price = useMemo(() => seats * 12, [seats]);

      return (
        <main className="min-h-screen px-8 py-16 max-w-5xl mx-auto" data-cx-id="root-main">
          <section data-cx-id="hero" className="mb-16">
            <h1 className="text-5xl mb-4">Configure your plan</h1>
            <p className="text-muted max-w-prose">Move the slider; the cost updates in real time.</p>
          </section>
          <section data-cx-id="configurator" className="rounded border border-border bg-surface p-8">
            <label className="block mb-4">
              <span className="text-sm text-muted">Seats</span>
              <input type="range" min="1" max="50" value={seats}
                onChange={(e) => setSeats(Number(e.target.value))}
                className="w-full mt-2 accent-accent" />
              <span className="block mt-2 text-lg font-semibold">{seats} seats</span>
            </label>
            <div className="mt-8 pt-6 border-t border-border flex items-baseline justify-between">
              <span className="text-muted">Monthly total</span>
              <PriceBadge amount={price} currency="$" />
            </div>
          </section>
        </main>
      );
    }

    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
  </script>
</body>
</html>
```

That structure is the skeleton. Drop your tokens in `:root`, drop your components in the Babel block, drop `data-cx-id` on every top-level region inside `<App>`.

---

## Patterns for the common shapes

### Multi-step form / wizard

Use `useReducer` for the step machine, not nested `useState`. The reducer's actions read as the user-facing steps (`'next'`, `'back'`, `'set-field'`), which makes the file readable.

```jsx
const initialForm = { step: 0, name: '', email: '', plan: 'starter' };
function formReducer(s, a) {
  switch (a.type) {
    case 'next': return { ...s, step: s.step + 1 };
    case 'back': return { ...s, step: Math.max(0, s.step - 1) };
    case 'set': return { ...s, [a.field]: a.value };
    default: return s;
  }
}
// inside App:
const [form, dispatch] = useReducer(formReducer, initialForm);
```

Render the step with a single ternary or a `STEPS[form.step]` lookup. Don't render five steps with `hidden` toggles — that bloats the DOM.

### Filterable / sortable table

Inline the data (an array of objects) at the top of the Babel block. Use `useMemo` to derive the filtered+sorted view. Render `<table>` with semantic HTML; Tailwind handles the chrome.

```jsx
const ROWS = [
  { id: 1, name: 'Acme Co', plan: 'Pro', mrr: 480 },
  { id: 2, name: 'Beta Inc', plan: 'Starter', mrr: 120 },
  // ...
];
function Table() {
  const [q, setQ] = useState('');
  const filtered = useMemo(() =>
    ROWS.filter(r => r.name.toLowerCase().includes(q.toLowerCase())),
    [q]);
  // ...
}
```

### Live chart

Draw inline `<svg>` from computed points. No Chart.js, no D3, no recharts. A `<polyline>` or `<path>` referencing `var(--accent)` for stroke covers 95% of cases. Tie the points to React state (a slider value, a filter) so the chart is genuinely interactive.

### Tabbed interface

A `useState` for the active tab + a small `TABS` array. Tailwind handles the visual state with `aria-selected:bg-accent` selectors or a conditional className.

---

## Concrete examples

### Example A — Pricing configurator (3 components, ~200 lines)

Brief: "Interactive pricing calculator: seats + add-ons + annual/monthly toggle, with a live total that animates."

Components:
1. `<SeatSlider>` — controlled `<input type="range">` from 1 to 100.
2. `<AddonGrid>` — a 3-card grid of toggleable add-ons; clicking flips a boolean in state.
3. `<BillingToggle>` — annual/monthly switch with a "save 20%" pill on annual.
4. `<TotalCard>` — sticky bottom card displaying the computed total, animated on change.

State flow: single `useReducer` holds `{ seats, addons: Set, billing }`. All components dispatch into it. `<TotalCard>` reads from it via `useMemo` to compute the total.

`data-cx-id` regions: `hero`, `seat-slider`, `addon-grid`, `billing-toggle`, `total-card`. Five anchors, edits surgical.

### Example B — Onboarding wizard (4 steps, ~350 lines)

Brief: "4-step onboarding: profile → workspace → invite teammates → first action. Multi-step UI with progress bar."

Components:
1. `<ProgressBar>` — top-of-page, shows step N of 4 with a filled segment per completed step.
2. `<StepProfile>` — name + role.
3. `<StepWorkspace>` — workspace name + URL slug (auto-derived from name).
4. `<StepInvite>` — comma-separated emails + skip option.
5. `<StepFirstAction>` — three big buttons for the first action.
6. `<NavRow>` — back / next buttons, always visible at the bottom of each step.

State flow: `useReducer` with `{ step, profile, workspace, invites, firstAction }`. The reducer guards step transitions (e.g. can't proceed from Profile until both name and role are filled).

`data-cx-id` regions: `progress-bar`, `step-profile`, `step-workspace`, `step-invite`, `step-first-action`, `nav-row`. Six anchors, predictable surgical edits.

---

## Editing existing interactive artifacts

Same rule as `/artifact`. The diff is small. Token tweaks change one line in `:root`. Component logic changes happen inside the one component's function body, leaving every other component untouched. Adding a new component splices the new JSX into the right region and adds a new `data-cx-id` for it.

**Never rewrite the whole `<script type="text/babel">` block to change one component.** That's the equivalent of rewriting the whole CSS to change one class. Surgical edits stay small even when the file is React.

---

## Anti-patterns

If you find yourself reaching for this skill for a static landing page, stop. Use `/artifact`. Static HTML + inline `<style>` is faster to write, faster to render, faster to edit. React buys you nothing on a static page.

If you find yourself with five `<script type="text/babel">` blocks "to keep components in separate scopes", stop. One block. The cost of cross-block coordination via `window.X = X` is higher than the cost of one big block.

If you find yourself importing `framer-motion`, `lodash`, `date-fns`, `chart.js`, or any other library via CDN, stop. The single-file rule is non-negotiable. Tailwind + React + Babel are the only three CDN deps. Everything else is hand-rolled.

If your Tailwind class strings have a hardcoded color (`bg-blue-600`, `text-gray-700`), stop. Either map to a token (`bg-accent`, `text-muted`) or hoist the rare arbitrary color to `:root` and reference it (`bg-[var(--…)]`). A loose `bg-blue-600` is the moment the brand system dies.

If you reach for `useEffect` to fetch data, stop. The preview runs offline; the fetch will fail silently and the artifact will look broken. Inline the data as a const array at the top of the Babel block.

If your file has crossed 1500 lines and you're still writing components, stop. Split the artifact: `index.html` is the home + one feature; `configurator.html` is the rest. Cross-link with `<a href>`. Two files of 800 lines each beat one of 1600.

If a junior asks "why React + Tailwind instead of vanilla?" and you can't name two of the four trigger conditions from the Overview, you reached for this skill too eagerly. Drop back to `/artifact` and ship the simpler version.
