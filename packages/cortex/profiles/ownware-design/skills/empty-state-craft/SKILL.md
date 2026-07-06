---
name: empty-state-craft
description: 'Design the five empty states — first-run, zero-data, cleared-filter, error-empty, end-of-feed — with honest copy and one way forward. Use when a screen renders without rows, when a filter matches nothing, when onboarding needs a first-run illustration, when an inbox is genuinely cleared. Pairs with /onboarding-flows and goes deeper than the loading/error half of /state-empty-loading-error. Skip for pure loading skeletons; skip for outright error pages — those have their own skills.'
trigger: /empty-state-craft
---

# Empty State Craft — five flavors of nothing, all with a way out

## Overview

Empty doesn't mean broken. Empty means the user just landed, or they over-filtered, or the API blinked, or they finished everything — four very different stories that deserve four different surfaces. The lazy default is one grey "No data" line shared across all four; the result is a UI that feels broken on day one and identical to a crash on day thirty.

This skill catalogues the five empty-state types, the anatomy each follows, and the voice rule that separates "cheerful guide" from "patronizing chatbot." It pairs with `/onboarding-flows` (first-run is a sub-problem of onboarding) and goes deeper than the empty half of `/state-empty-loading-error`.

---

## Critical Constraints — read these first, every time

1. **Five empty states, not one.** Map every nothing-screen to one of: (1) first-run, (2) zero-data after action, (3) cleared-filter, (4) error-empty, (5) end-of-feed. Each gets its own copy + its own action. A shared "No items" line is a bug.
2. **Headline ≤ 12 words. No question marks.** "Looks like nothing here yet?" reads like the UI is unsure. State the situation: "No contacts yet."
3. **Body ≤ 2 lines, plain language.** One line states the why. Optional second line names the next step.
4. **Every state has a way forward — except end-of-feed.** First-run gets a primary button. Zero-data gets "Add the first one." Cleared-filter gets "Clear filters." Error-empty gets "Retry." End-of-feed is the only state allowed to terminate without an action.
5. **Illustration small, not heroic.** 64–120px max. A full-bleed hero illustration on every empty list turns the app into a mascot showroom. Skip the illustration entirely if you don't have a real one — an icon is honest; stock-art is filler.
6. **Voice rule: cheerful, not patronizing.** "You haven't created any reports — yet!" is patronizing. "No reports yet. Create one to start." is cheerful. The exclamation mark and the "yet!" are the tells.
7. **Error-empty must name the category.** Per Ownware Principle 21 — `{ loading | error(category) | data }`. A fake-empty masking a network error is a lie. If the fetch failed, say "Couldn't load contacts — network error" with a Retry, not "No contacts yet."

---

## Anatomy — the five parts, in order

Every empty state is composed of the same five parts. Drop any that don't earn their place; never add a sixth.

1. **Icon or small illustration.** 64–120px. Above the headline. Optional but common for first-run.
2. **Headline.** 18–24px, sentence case (not Title Case, not ALL CAPS). ≤ 12 words. No question mark.
3. **Body.** 14–16px muted. 1–2 lines explaining the situation in the user's terms.
4. **Primary action.** Button labelled with a verb + object — "Add contact", "Import CSV", "Clear filters", "Retry". ≤ 3 words.
5. **Secondary link.** Optional. Text link to docs, examples, or import flow — "See sample data", "Learn how it works".

Center the stack. 480px max width. 64–96px vertical padding inside the empty container.

---

## The five states — what each one says

### 1. First-run (zero state on a brand-new account)

The user has never had data here. Tone: welcoming, set the expectation.

- Headline: "Your first contact lives here."
- Body: "Add someone manually or import from a CSV — it takes about 30 seconds."
- Primary: "Add contact"
- Secondary: "Import CSV →"

### 2. Zero-data (the user cleared everything, or never added anything to an existing account)

The user has had data here at some point, or expected to. Tone: neutral, prompt the next action.

- Headline: "No contacts yet."
- Body: "Add one manually or import from a CSV."
- Primary: "Add contact"

### 3. Cleared-filter (the filter matches nothing)

The user filtered too aggressively. Tone: helpful, name the filter as the cause.

- Headline: "No contacts match these filters."
- Body: "Try widening your search or clearing one filter at a time."
- Primary: "Clear filters"

### 4. Error-empty (the fetch failed and we're rendering nothing as a result)

The data exists; we couldn't load it. Tone: honest, name the category, give a Retry.

- Headline: "Couldn't load contacts."
- Body: "Network error — check your connection and try again." (Or "Permission denied", "Server error", etc. — name the category.)
- Primary: "Retry"

### 5. End-of-feed (the user has reached the bottom)

The user is at the end of a finite list — completed tasks, search results, archived items. Tone: closure, no nag.

- Headline: "That's everything."
- Body: optional, "You've reached the end of this list."
- Primary: NONE. End-of-feed is the one state without a call-to-action. A "Go back" link is fine; a button is too eager.

---

## Concrete examples

### Example 1 — a CRM with all five states wired up

```html
<style>
  .empty {
    display: grid; place-items: center; gap: 16px;
    padding: 96px 24px; max-width: 480px; margin: 0 auto;
    text-align: center;
  }
  .empty-icon { width: 80px; height: 80px; color: var(--muted); }
  .empty h2 { font-size: 22px; margin: 0; }
  .empty p { font-size: 15px; color: var(--muted); margin: 0; line-height: 1.55; }
  .empty .actions { display: flex; gap: 12px; margin-top: 8px; }
</style>

<!-- 1. First-run -->
<section class="empty" data-cx-id="empty-first-run">
  <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <circle cx="12" cy="8" r="3"/><path d="M5 20c0-4 3-6 7-6s7 2 7 6"/>
  </svg>
  <h2>Your first contact lives here.</h2>
  <p>Add someone manually or import from a CSV — it takes about 30 seconds.</p>
  <div class="actions">
    <button class="btn-primary">Add contact</button>
    <a href="#import">Import CSV →</a>
  </div>
</section>

<!-- 3. Cleared-filter -->
<section class="empty" data-cx-id="empty-filter">
  <h2>No contacts match these filters.</h2>
  <p>Try widening your search or clearing one filter at a time.</p>
  <button class="btn-primary">Clear filters</button>
</section>

<!-- 4. Error-empty -->
<section class="empty" data-cx-id="empty-error">
  <h2>Couldn't load contacts.</h2>
  <p>Network error — check your connection and try again.</p>
  <button class="btn-primary">Retry</button>
</section>

<!-- 5. End-of-feed -->
<section class="empty" data-cx-id="empty-end">
  <h2>That's everything.</h2>
  <p>You've reached the end of this list.</p>
</section>
```

Five separate templates, one shared layout, distinct copy per situation. The user always knows which kind of nothing they're looking at.

### Example 2 — copy rewrites, before/after

| Situation       | Lazy default (don't ship)            | Crafted (ship this)                                              |
| --------------- | ------------------------------------ | ---------------------------------------------------------------- |
| First-run inbox | "No messages."                       | "Your inbox is ready. Connect Gmail or paste a message to start."|
| Filtered to nothing | "Nothing here."                  | "No tasks match 'priority: P0 + assignee: me'. Clear filters."   |
| Fetch failed    | "No items."                          | "Couldn't load tasks — server error. Retry."                     |
| All tasks done  | "No tasks!"                          | "You're caught up. Nothing left for today."                      |
| End of search   | "No more results."                   | "That's all 47 results."                                         |

The lazy column treats every nothing the same; the crafted column tells the user which nothing they have.

---

## Anti-patterns

- **One shared "No data" component across all five states.** Stop. They're five different stories — give them five different surfaces.
- **Hero-sized illustrations on every empty list.** Stop. 64–120px is the ceiling for icons inside data grids. Hero illustrations belong on first-run only, and even there they're optional.
- **Question-mark headlines.** "Nothing here yet?" Stop. The UI is the source of truth; if it doesn't know, it shouldn't be asking the user.
- **"Yet!" with an exclamation mark.** Stop. The word "yet" is fine; the exclamation makes it cheerleader voice. "No reports yet. Create one to start." — no exclamation.
- **Error masquerading as empty.** "No contacts yet" when the API returned a 500 is a lie. Per Principle 21, classify the failure and render error state with a category, never silent empty.
- **End-of-feed with a button.** Stop. The end is the end; a "Load more" button on a finite list reads like the UI hasn't accepted the end exists.
- **Generic stock illustrations.** Three people holding hands around a magnifying glass is filler. Skip the illustration before shipping filler.
