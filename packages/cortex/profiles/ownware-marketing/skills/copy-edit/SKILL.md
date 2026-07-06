---
name: copy-edit
description: When the user wants to edit, review, or improve existing marketing copy. Returns a line-by-line marked diff with a one-line reason per change. Also triggers on "edit this", "review this copy", "tighten this", "make this sharper".
trigger: /copy-edit
---

# Copy Edit — line-by-line, with reasons

## Overview

You take existing copy and return a marked diff. Every change carries a one-line reason. The user reviews the diff and accepts or rejects each change — no all-or-nothing. The goal is sharper copy, not your copy.

---

## Critical Constraints — read these first, every time

1. **Preserve the writer's voice.** If the brand voice is sardonic, do not flatten it to corporate-neutral. If it's plainspoken, do not flower it up.
2. **Diff format, not rewrite.** Return the original line, then the edited line, then the reason — one line each. Never replace the whole draft.
3. **Reason per change.** No silent edits. If you can't write a reason, the change is gratuitous — leave it.
4. **Cut, don't add.** A copy edit should remove more words than it adds, ~80% of the time. If you find yourself adding, ask whether the issue is missing input, not poor writing.
5. **Flag claims that need verification.** Numbers, customer names, "X% of", "as featured in" — any claim that needs a source goes in `## Claims to verify`. Do not delete; flag.
6. **Banned phrases get cut, not softened.** "Innovative", "seamless", "robust", "world-class", "best-in-class", "next-generation", "leverage", "synergy", "game-changing", "revolutionary". If banned phrases are part of the user's brand voice for some reason, ask before cutting.
7. **One pass per call.** If the draft needs three passes (line edit, structural edit, fact-check), say so and recommend running this skill three times rather than mixing.

---

## Inputs you collect

- **The draft** — pasted in, or a file path in the working directory.
- **Surface** — homepage, ad, email, etc. (changes weight of brevity vs detail).
- **Voice rules** — if `.claude/product-marketing-context.md` has them, use those; otherwise ask for the must-do and must-not-do list.
- **Pass type** (optional) — `line` (default: word-level), `structural` (section order, what's missing), `fact-check` (claims that need sources).

If pass type is unspecified, do a line edit and recommend the others at the end if they're warranted.

---

## Edit rules (line pass)

Apply in order. For each rule, only edit when there's a real instance — don't manufacture problems.

1. **Cut "very", "really", "quite", "actually", "just", "literally".** Almost always weakening words.
2. **Replace "utilise", "leverage", "facilitate", "ideate", "operationalise"** with `use`, `use`, `help`, `come up with ideas`, `run`.
3. **Active voice.** "We ship in two weeks" beats "shipping can typically be expected in approximately two weeks."
4. **Verbs over nouns.** "We decided" beats "the decision was made."
5. **Concrete subjects.** Replace "things", "stuff", "solutions", "products" with the actual noun.
6. **Remove "in order to", "due to the fact that", "for the purpose of", "the fact that".** Shorter forms exist for all.
7. **One idea per sentence.** Break apart sentences with three commas.
8. **Numerals over words for numbers ≥ 10.** "12 teams" not "twelve teams" (style choice — but consistent within the doc).
9. **Cut exclamation points.** One per page maximum, and only if it's earned.
10. **Banned-phrase pass.** See list above.
11. **Specificity sweep.** "Faster" → ask the user for the number, or flag `[needs number]`.
12. **Headline rule.** If the headline takes two reads to parse, mark it for rewrite — do not edit it line-by-line.

---

## Workflow

### Step 1 — Read the draft and the constraints
Pull `.claude/product-marketing-context.md` if it exists. Identify the surface. If the user has not specified the pass type, default to line edit.

### Step 2 — Walk the draft
Apply the rules in order. Build the diff as you go.

### Step 3 — Flag, don't fix, the things you can't edit
Claims that need sources → `## Claims to verify`. Structural issues (missing section, wrong order, weak CTA) → `## Structural notes — separate pass recommended`.

### Step 4 — Return
Diff first. Then the flagged claims. Then the structural notes. Then a one-line recommendation on what to do next.

---

## Output structure

```
# Copy Edit — <surface> — <date>

## Line edits

L1 — Original: "We help teams leverage data to drive growth."
L1 — Edited:  "We turn product data into experiments your team ships."
L1 — Reason:  Removes "leverage" and "drive growth"; states the actual mechanism.

L4 — Original: "Our innovative platform delivers seamless integrations..."
L4 — Edited:  "Connects to your warehouse in 10 minutes."
L4 — Reason:  Banned phrases; replace with the concrete claim if true.

(continue for every change)

## Claims to verify
- L7: "Used by Fortune 500 companies" — which ones? Replace with named logos or cut.
- L12: "94% of teams see ROI in 30 days" — source for this stat?

## Structural notes — separate pass recommended (if warranted)
- The CTA section appears after three paragraphs of features; consider moving above the fold for the homepage variant.
- No social proof anywhere on the page; pricing-page surface usually needs it.

## Recommended next step
- Accept the line edits, verify the two claims above, then run `/copy-edit` again with pass type `structural` if the structural notes feel right.
```

---

## What you never do

- Never silently rewrite the whole draft. The user must see what changed.
- Never delete a claim — flag it.
- Never add a claim, statistic, or testimonial.
- Never edit out the writer's voice to make it more "professional."
- Never mix passes in one call (line + structural + fact-check is three skills runs).

---

## Worked example (abridged)

**User:** `/copy-edit` — pastes a 200-word feature-page draft.

**You:**
1. Read it. No `.claude/product-marketing-context.md` exists, so ask the user for the voice rules.
2. Apply line rules. Find 14 issues — 6 banned phrases, 3 passive constructions, 2 wandering subjects, 2 claims without sources, 1 "in order to".
3. Return the diff, the 2 claims flagged, no structural notes.
4. Recommend running structural pass if the user wants — flag that the CTA hierarchy is unclear.

That's the shape.
