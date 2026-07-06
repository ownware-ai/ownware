---
name: accessibility-audit
description: '8-point a11y audit before ship — keyboard reach, focus visibility, ARIA labels, alt text, heading hierarchy, contrast, form labels, reduced motion. Each graded PASS / PARTIAL / FAIL with a one-line fix. Use after build, before declaring done, especially for artifacts with forms, navigation, custom dropdowns, modals. Pairs with /design-review-framework and /critique. Skip for static decks.'
trigger: /accessibility-audit
---

# Accessibility Audit — 8 points, PASS/PARTIAL/FAIL, one-line fixes

## Overview

Accessibility is not a separate concern from craft. It's the same craft, measured against people who navigate without a mouse, can't read low-contrast type, or have screen readers reading them the page. The audit is mechanical — run the eight checks, write the result. The fixes are usually one or two CSS rules or an ARIA attribute. The bar isn't "perfect"; it's "no blockers, partials documented, none of it is left to luck."

Run this AFTER `/critique` and BEFORE declaring an artifact done. For decks and static images, this skill mostly returns PASS-by-default — skip it. For anything with focus, click, form input, or screen-reader-readable content, run every check.

---

## Critical Constraints — read these first

1. **Grade every check PASS / PARTIAL / FAIL, with evidence.** "Keyboard: PASS — Tab cycles all 7 interactive elements in DOM order." Not "looks fine." Evidence means the specific element you tested.
2. **Any FAIL is a blocker.** Body text below 4.5:1 contrast, focus invisible, icon-only button with no `aria-label` — these block ship. Fix before handoff.
3. **PARTIAL is allowed but documented.** "Heading hierarchy: PARTIAL — h1 → h3 in sidebar (skipped h2); acceptable because sidebar is visually separate region." Document the reasoning.
4. **Test with the keyboard, not the mouse.** Open the artifact, click in the address bar, press Tab. Watch every focus stop. If your finger goes near the mouse, you're cheating the audit.
5. **Run real contrast math, not eyeball.** Use a tool or compute it. WCAG 2.1: 4.5:1 body, 3:1 large text (≥18pt or ≥14pt bold), 3:1 UI components and graphics.
6. **`alt=""` is correct for decorative images.** A logo in a footer is decorative; a hero photo carrying meaning is not. Don't blank-alt everything to "make it pass" — that's lying to screen readers.
7. **`prefers-reduced-motion` is not optional.** If the artifact has any animation longer than 200ms, the media query must exist.

---

## The 8-point audit

### 1. Keyboard reachability

**Question:** Can every interactive element be reached using only Tab (and Shift+Tab to reverse)? Does the order match the visual layout?

**Test:** Click the URL bar. Press Tab. Walk through every stop. Note any element that's clickable by mouse but unreachable by keyboard.

- **PASS** — Every interactive element receives focus on Tab. Order matches visual reading order (top-to-bottom, left-to-right for LTR languages).
- **PARTIAL** — All reachable but order is slightly off (e.g. a floating CTA receives focus after the footer).
- **FAIL** — Any interactive element unreachable by keyboard. Common cause: `<div onClick>` instead of `<button>`. Custom dropdowns that don't open on Enter.

**Common fixes:**
- Replace `<div onClick>` with `<button>`. Free a11y.
- Add `tabindex="0"` to a custom interactive element (rare; prefer semantic HTML).
- Fix tab order with DOM order — never with `tabindex="1"`, `tabindex="2"` (positive tabindex is a footgun).

### 2. Focus visibility

**Question:** When an element has focus, can you SEE that it has focus? Is the focus ring at least 3:1 contrast against its background?

**Test:** Tab into a button, a link, a form input. Look. Is there a visible ring, outline, or other affordance?

- **PASS** — Every focused element has a visible focus ring ≥2px, ≥3:1 contrast against adjacent surface, with `outline-offset` of at least 2px so it's not glued to the element edge.
- **PARTIAL** — Focus ring present but low-contrast (e.g. light blue on white background ~2:1) — visible only in good light.
- **FAIL** — `outline: none` with no replacement. Focus is invisible. Keyboard users are blind.

**Common fixes:**
```css
:focus-visible {
  outline: 2px solid var(--cx-accent);
  outline-offset: 2px;
  border-radius: 4px;  /* match the element's radius */
}
```

Never `:focus { outline: none }` without a `:focus-visible` replacement.

### 3. ARIA labels on icon-only buttons

**Question:** Every button that contains ONLY an icon has an `aria-label` describing what it does.

**Test:** Inspect every `<button>` that has no visible text. Read its `aria-label` (or its `aria-labelledby` target, or its `title`).

- **PASS** — Every icon-only button has `aria-label="Verb noun"` (e.g. `aria-label="Close dialog"`, `aria-label="Search"`, `aria-label="Open user menu"`).
- **PARTIAL** — Most have labels but one or two missing.
- **FAIL** — Icon-only buttons with no label. Screen reader reads "button" with nothing else; user has to guess.

**Common fixes:**
```html
<!-- before -->
<button class="icon-btn"><svg>...</svg></button>

<!-- after -->
<button class="icon-btn" aria-label="Close dialog">
  <svg aria-hidden="true">...</svg>
</button>
```

The icon SVG gets `aria-hidden="true"` because its meaning is now carried by the label.

### 4. `alt` text on every `<img>`

**Question:** Every `<img>` has an `alt` attribute. Decorative images get `alt=""` (empty, not missing). Meaningful images get descriptive alt text.

**Test:** Grep every `<img`. Confirm every one has `alt=`. Read the alt values aloud — do they describe what's in the image or do they say "image" / "graphic"?

- **PASS** — Every `<img>` has `alt`. Decorative ones are `alt=""`. Meaningful ones describe content in 5-15 words. No "image of…" or "picture of…" (screen readers already say "image").
- **PARTIAL** — Most have alt but one or two missing or generic ("photo", "logo").
- **FAIL** — Missing `alt` attributes. Screen reader reads the filename. User hears "hero-photo-final-v3-USE-THIS.jpg".

**Common fixes:**
```html
<!-- Decorative icon/logo: -->
<img src="/logo.svg" alt="" />

<!-- Meaningful: -->
<img src="/team.jpg" alt="Five engineers gathered around a whiteboard sketching a system diagram" />

<!-- Functional (image is the button): -->
<button><img src="/cart.svg" alt="View cart, 3 items" /></button>
```

### 5. Heading hierarchy

**Question:** The page has exactly one `<h1>`. `<h2>` follows `<h1>`. `<h3>` follows `<h2>`. No skipped levels (no `<h1>` → `<h3>`).

**Test:** Inspect the DOM. List every heading in order. Note skipped levels.

- **PASS** — Exactly one `<h1>`. No level skips. Document outline matches visual hierarchy.
- **PARTIAL** — One justified skip (e.g. an aside region has its own h1-equivalent that's actually an h3 because of region context) — acceptable if the region is visually + semantically separate.
- **FAIL** — Multiple `<h1>`s, OR `<h1>` jumps directly to `<h3>`/`<h4>`. Screen reader users navigate by headings; broken hierarchy is broken navigation.

**Common fixes:**
- Demote duplicate h1s. There's one main heading per page.
- Use CSS, not HTML levels, for visual size: `<h2 class="text-3xl">` if you want big-h2 styling without skipping to h1.

### 6. Color contrast

**Question:** Body text ≥4.5:1 against background. Large text (≥18pt or ≥14pt bold) ≥3:1. Graphics and UI components ≥3:1.

**Test:** Compute three pairs minimum: `--cx-fg` on `--cx-bg`, `--cx-accent-fg` on `--cx-accent`, `--cx-muted` on `--cx-surface`. Run the numbers through a calculator (WCAG luminance formula or APCA-aware tool).

- **PASS** — All three pairs meet AA. Body 4.5:1, CTA 4.5:1+, muted 4.5:1+.
- **PARTIAL** — Body and CTA pass; muted dips to 4.0-4.5:1 (legible but tight, especially for ≥40-year-old users).
- **FAIL** — Body text below 4.5:1. Common culprit: `--cx-muted: #9CA3AF` on `--cx-surface: #FFFFFF` = 3.0:1 (FAIL for body, PASS for large text only).

**Common fixes:**
- Darken `--cx-muted` by L 0.05-0.10 in OKLCH until contrast hits 4.5:1.
- Add an icon next to semantic colors (red error text + icon, not red alone).
- Never use color ALONE for state (Principle 21 in `/color-system`).

### 7. Form labels associated

**Question:** Every form input has a visible label, programmatically associated via `<label for="…">`, `aria-labelledby`, or wrapping the input inside the `<label>`. Placeholder text is NOT a substitute for a label.

**Test:** For every `<input>`, `<textarea>`, `<select>`: find its label. Check the association (label's `for` matches input's `id`).

- **PASS** — Every input has a visible, programmatically associated label.
- **PARTIAL** — All inputs have labels but one uses `aria-label` (invisible) when a visible label would be clearer.
- **FAIL** — Inputs labeled only by placeholder. The placeholder disappears when the user starts typing; now they have no idea what field they're in.

**Common fixes:**
```html
<!-- Standard: -->
<label for="email">Email address</label>
<input id="email" name="email" type="email" required />

<!-- Or wrapped: -->
<label>
  Email address
  <input name="email" type="email" required />
</label>

<!-- For icon-only inputs (e.g. search bar): -->
<label for="search" class="visually-hidden">Search</label>
<input id="search" type="search" placeholder="Search…" />
```

`.visually-hidden` is CSS that hides the label visually but keeps it for screen readers:
```css
.visually-hidden {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

### 8. Reduced motion respected

**Question:** Does any animation over 200ms have a `prefers-reduced-motion: reduce` fallback that disables or shortens it?

**Test:** Open the artifact in OS with "Reduce motion" enabled (macOS: System Preferences > Accessibility > Display). Watch for any animation that still plays at full duration.

- **PASS** — `@media (prefers-reduced-motion: reduce) { ... }` block exists, disables or shortens all animations >200ms, replaces parallax/scroll-jacking with static alternatives.
- **PARTIAL** — Media query exists but covers only some animations.
- **FAIL** — No media query. Users with vestibular disorders get nauseated; users who've explicitly opted out of motion get ignored.

**Common fixes:**
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

This is the nuclear option — disables everything. For motion that's load-bearing (loading spinner, focus-transition feedback), keep them but reduce duration to 0.01ms so they fire instantly without visible motion.

---

## Worked example — auditing a custom dropdown

The artifact: a custom dropdown for "Select organization" in a B2B SaaS dashboard header. Built with `<div>`s and click handlers. Looks beautiful.

Audit:

```
1. Keyboard reach        — FAIL.  Trigger is a <div>; Tab skips past it entirely. Mouse-only.
2. Focus visibility      — N/A    Element isn't focusable to begin with.
3. ARIA labels           — FAIL.  Trigger has no label. Options have no role.
4. Alt text              — PASS.  No <img>s in the dropdown.
5. Heading hierarchy     — PASS.  Dropdown contains no headings.
6. Color contrast        — PASS.  Trigger text #1F1F1F on #FFFFFF = 18.7:1. Option hover state #F3F3F3 contrast OK.
7. Form labels           — N/A    Not a form input.
8. Reduced motion        — PARTIAL. Dropdown open animation 200ms; no media query, but 200ms is on the edge.

Verdict: 2 FAIL. BLOCKER for ship.

Fixes:
- Replace <div class="trigger"> with <button class="trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="org-list">.
- Add aria-label="Select organization" to the button (or visible label above).
- Replace option <div>s with <li role="option">; wrap list in <ul role="listbox" id="org-list">.
- Implement keyboard handlers: ArrowDown to open + move focus, Enter to select, Esc to close.
- Add @media (prefers-reduced-motion: reduce) block to disable the 200ms open animation.

After fixes:
1. Keyboard reach        — PASS. Tab focuses trigger, ArrowDown opens, ArrowDown/Up moves through options, Enter selects, Esc closes.
2. Focus visibility      — PASS. Button focus ring 2px violet outline. Option focus ring 2px violet outline.
3. ARIA labels           — PASS. Trigger labeled. Listbox role + option roles set.
4–7. Unchanged.
8. Reduced motion        — PASS.

Ship.
```

---

## Concrete example — auditing a Ownware Modern Minimal hero

```html
<section class="hero" data-cx-id="hero">
  <h1>Move money like a developer.</h1>
  <p>The financial platform built for software people.</p>
  <a href="#cta" class="btn-primary">Start building</a>
  <button class="btn-icon"><svg><!-- play --></svg></button>
  <img src="/hero-illustration.svg" />
</section>
```

```
1. Keyboard reach        — PASS. <a> and both <button>s reachable via Tab.
2. Focus visibility      — FAIL. CSS has `*:focus { outline: none }` with no replacement.
3. ARIA labels           — FAIL. Icon-only play button has no aria-label.
4. Alt text              — FAIL. <img> has no alt attribute.
5. Heading hierarchy     — PASS. One <h1>, no skips.
6. Color contrast        — PASS. Body #1F1F1F on #FAFAFA = 14.2:1. Accent text on cobalt 7.1:1.
7. Form labels           — N/A. No form inputs in hero.
8. Reduced motion        — N/A. No animations defined.

Verdict: 3 FAIL. BLOCKER for ship.

Fixes:
- CSS: add `:focus-visible { outline: 2px solid var(--cx-accent); outline-offset: 2px; }`.
- HTML: `<button class="btn-icon" aria-label="Play product demo video">`.
- HTML: `<img src="/hero-illustration.svg" alt="" />` (decorative) OR `alt="A developer typing while terminal output streams behind them"` (meaningful).

Then re-run: 8/8 PASS or PARTIAL-documented. Ship.
```

---

## Anti-patterns

- **`outline: none` everywhere.** Removes focus visibility for keyboard users. Never use without a `:focus-visible` replacement.
- **`aria-label="button"` on every button.** Adds noise without information. Screen readers already announce "button"; the label should describe what the button DOES (`aria-label="Close dialog"`, not `aria-label="button"`).
- **`alt="image"` or `alt="logo"`.** Meaningless. Either describe the content (`alt="Stripe logo"`) or mark it decorative (`alt=""`).
- **Placeholder as label.** Placeholder disappears on type; user loses context. Always add a visible label.
- **Trusting eyeball contrast.** A `#6B7280` muted on `#FAFAFA` "looks fine" but might be 4.3:1 (FAIL). Run the math.
- **Adding `tabindex="1"` to "fix" tab order.** Positive tabindex creates a separate tab sequence that's almost always wrong. Fix DOM order instead.
- **`<div role="button">` instead of `<button>`.** Now you have to re-implement Enter and Space key handlers manually. Use `<button>`. Free a11y.
- **Skipping the reduced-motion check because "the animations are subtle".** Vestibular disorders aren't subjective. If `prefers-reduced-motion: reduce` exists in the OS, respect it.
- **Calling it done after one PASS.** All 8 must pass or have a documented PARTIAL. No quiet FAILs.
