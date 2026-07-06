---
name: forms-craft
description: 'The form bedrock — input layout, labels, validation timing, error states, button placement. Use for any form longer than one field that isn''t already covered by /auth-flow. Pairs with /auth-flow (sign-in / sign-up specifically) and /critique (form audit). Skip for one-field search inputs (see /search-design) and for the auth-flow trio specifically — that has its own dedicated skill.'
trigger: /forms-craft
---

# Forms Craft — the bedrock under every form

## Overview

Every product has forms. Every form looks subtly worse than it should because someone padded the inputs to 56px tall, slapped a placeholder where the label belongs, or shipped validation that fires on every keystroke. This skill is the canonical pattern: label above, input sized for thumb tap, validation on blur, errors specific, buttons placed by eye-flow.

Apply it to settings pages, profile editors, checkout, contact forms, billing forms, multi-step onboarding wizards — everything except the auth trio (`/auth-flow`) and search inputs (`/search-design`).

---

## Critical Constraints — read these first, every time

1. **Labels above the input, always. Never placeholder-as-label.** A label that disappears the moment the user types is a usability bug — they forget what they were typing, screen readers miss it, and validation has nothing to attach to. Label sits above, 14px, 6px gap to the input.
2. **Input height: 44px touch (mobile, consumer), 40px compact (desktop dashboards), 48px airy (single-form landing pages). Pick one, stick to it.** 44px is the iOS HIG touch-target floor; below that, thumb-tap accuracy collapses on phones.
3. **Input text size 16px, never smaller, on inputs the user types into.** iOS Safari auto-zooms any input <16px on focus — visually jarring and harder to recover from. 16px is the floor.
4. **Validate on blur for most fields, on submit for passwords, never on keystroke.** Live keystroke validation is hostile — the user is mid-typing and you're already telling them they're wrong. Wait for blur (or submit, for short fields).
5. **Errors inline, under the input, 13px, rose color, with specific copy.** "Email must include @" not "Invalid". Add a 1px rose border on the input itself + tint the input background a faint rose (`#fef2f2`). No shake animation — it wastes a frame and tells the user nothing.
6. **Required marker is a red asterisk AFTER the label text, not inside the input.** `Email *` — never `<input placeholder="Email *">`. The asterisk is part of the label semantically.
7. **Button placement: primary RIGHT in modals (right-handed reach), primary LEFT in full pages (eye flow from headline → button). Secondary always opposite the primary.** The two contexts have different fastest-path rules; honor both.

---

## Framework — the form anatomy

### The field stack (one logical unit)

A "field" is a five-part vertical stack:

```
1. Label (14px, 500 weight, margin-bottom 6px)
2. Helper text — optional, sits BETWEEN label and input (12px, muted, e.g. "We'll never share this")
3. Input (40 / 44 / 48px tall, 16px value text, 14px padding)
4. Error — inline, below input (13px, rose, with icon prefix)
5. Field gap (24px) before the next field
```

Helper text goes ABOVE the input so the user reads it before typing. Error goes BELOW because it's a response to typing.

### Validation timing

| Field type | When to validate |
|------------|------------------|
| Email | On blur (user leaves the field) |
| Password | On submit (live validation shame-spirals the user) |
| Required text | On blur |
| Number with range | On blur |
| Confirm password | On blur from the second field, not the first |
| Real-time search | Debounced 250ms — different surface, see `/search-design` |

NEVER validate on keystroke for user-text inputs. Auto-suggest is fine; "you have an error" while typing is hostile.

### Error message rules

- **Specific over generic.** "Email must include @" beats "Invalid email". "Must be 8+ characters — currently 5" beats "Password too short".
- **Action-oriented.** Tell the user what to DO, not just what's wrong.
- **No exclamation marks.** "Email must include @" not "Email must include @!". The rose color and icon already signal urgency.
- **Visible until the user fixes it.** Don't auto-clear on focus; the user is now looking at the input AND the error, fixing one with reference to the other.

### Button placement — the two contexts

**Inside a modal:** primary on the RIGHT, secondary on the LEFT.

```
[ Cancel ]              [ Save changes ]
```

Reason: modal close-via-escape lives top-right; primary action shares the right-edge. The user's eye lands right after reading the dialog.

**On a full-page form (settings, profile, checkout):** primary on the LEFT, secondary on the RIGHT or below as a text link.

```
[ Save changes ]    [ Cancel ]
```

Reason: the eye reads the form top-to-bottom-left-to-right; the primary action is the natural end-point of that flow, sitting under the last field on the left.

**Never show three buttons in a row.** "Save / Save and continue / Cancel" — pick two. The third is a dropdown next to the primary if it must exist.

---

## Rubric — form audit checklist

1. Is every input labeled with a `<label for="id">` above it?
2. Is the input value text 16px (no auto-zoom on iOS)?
3. Is the touch target ≥44px tall on mobile widths?
4. Does validation fire on blur or submit, never on keystroke?
5. Are error messages specific and action-oriented?
6. Does the input get both a rose border AND a tinted background on error?
7. Is the required marker (`*`) on the label, not in the placeholder?
8. Is the primary button placed correctly for its context (modal vs page)?
9. Is field gap a consistent value (24px)?

Any "no" is a fix.

---

## Concrete examples

### Example 1 — full sign-up form with error states

```html
<form class="form-stack" data-cx-id="signup-form" novalidate>
  <h1>Create your account</h1>

  <div class="field">
    <label for="full-name">Full name</label>
    <input id="full-name" name="name" type="text" autocomplete="name" required />
  </div>

  <div class="field has-error">
    <label for="email">Work email <span class="req">*</span></label>
    <p class="helper">We'll send your verification link here.</p>
    <input id="email" name="email" type="email" autocomplete="email" value="lena@stripe" aria-describedby="email-err" required />
    <div class="error" id="email-err"><span class="icon" aria-hidden="true">!</span>Email must include a domain (like @stripe.com).</div>
  </div>

  <div class="field has-error">
    <label for="password">Password <span class="req">*</span></label>
    <p class="helper">8+ characters with one number.</p>
    <input id="password" name="password" type="password" autocomplete="new-password" value="abc12" aria-describedby="pw-err" required />
    <div class="error" id="pw-err"><span class="icon" aria-hidden="true">!</span>Must be 8+ characters — currently 5.</div>
  </div>

  <div class="form-actions">
    <button type="submit" class="btn btn-primary">Create account</button>
    <a href="/sign-in.html" class="btn-link">I already have an account</a>
  </div>
</form>

<style>
  .form-stack { width: 100%; max-width: 440px; }
  .form-stack h1 { font: 600 24px/1.2 var(--font-display); letter-spacing: -0.01em; margin: 0 0 28px; }

  .field { margin-bottom: 24px; }
  .field label { display: block; font: 500 14px var(--font-body); margin-bottom: 6px; }
  .field .req { color: var(--bad); margin-left: 2px; }
  .field .helper { font-size: 12px; color: var(--muted); margin: 0 0 6px; }
  .field input {
    width: 100%; height: 44px; padding: 0 14px;
    font: 16px var(--font-body); color: var(--fg);
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  }
  .field input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(47,111,235,0.15); }
  .field.has-error input { border-color: var(--bad); background: #fef2f2; }
  .field .error {
    margin-top: 6px; font-size: 13px; color: var(--bad);
    display: flex; align-items: center; gap: 6px;
  }
  .field .error .icon {
    display: inline-grid; place-items: center; width: 14px; height: 14px;
    border-radius: 50%; background: var(--bad); color: white;
    font: 700 10px var(--font-body);
  }

  .form-actions { display: flex; align-items: center; gap: 16px; margin-top: 8px; }
  .btn-primary { height: 44px; padding: 0 20px; background: var(--accent); color: white; border: none; border-radius: 8px; font: 600 15px var(--font-body); cursor: pointer; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-link { font-size: 14px; color: var(--muted); text-decoration: none; }
  .btn-link:hover { color: var(--fg); text-decoration: underline; }
</style>
```

Note the discipline: every field is `label / helper / input / error` in that vertical order. 16px input text. 44px touch target. Errors specific and action-oriented ("currently 5", not "too short"). Required asterisk is on the label, rose-colored, with a 2px gap.

### Example 2 — settings page form with modal button placement contrast

A settings page form ships the primary button on the LEFT:

```html
<div class="form-actions">
  <button class="btn-primary">Save changes</button>
  <a href="./settings" class="btn-link">Cancel</a>
</div>
```

A confirmation modal ships the primary on the RIGHT:

```html
<footer class="modal-actions">
  <button class="btn-secondary">Cancel</button>
  <button class="btn-primary">Delete forever</button>
</footer>
<style>
  .modal-actions { display: flex; justify-content: flex-end; gap: 12px; padding: 16px 24px; border-top: 1px solid var(--border); }
  .btn-secondary { height: 40px; padding: 0 16px; background: transparent; color: var(--fg); border: 1px solid var(--border); border-radius: 8px; font: 500 14px var(--font-body); }
</style>
```

Same form, different context, different placement. The user finds the primary in <300ms either way because the layout matches what their eye expects.

---

## Anti-patterns

- **Placeholder-as-label.** `<input placeholder="Email">` with no label. Fails screen readers, fails recall, fails error attachment. Always a `<label>`.
- **Keystroke validation.** "Invalid email" appearing while the user is mid-typing. Hostile. Validate on blur.
- **Generic error copy.** "Invalid" / "Required" / "Error". Specific or it's noise.
- **16px+ font on the label, 14px on the input value.** Visually weird and triggers iOS zoom. Label 14px, value 16px.
- **A field gap that isn't 24px on some fields and 16px on others.** Inconsistent rhythm reads as careless. Pick one and stick to it.
- **Submit button at 32px tall.** Tap-target failure on mobile. Match input height (44px+).
- **"Save" button greyed out until the form is valid.** User clicks anyway, nothing happens, no feedback. Better: always-enabled button that triggers validation on click.
- **Required marker inside the input.** `<input placeholder="Email *">`. The asterisk belongs on the label.
- **Shake animation on error.** Cute, wastes a frame, tells the user nothing they can act on.
- **Confirm-password field on sign-up.** Replaced by show/hide toggle; doubling the field doubles abandonment. (See `/auth-flow` for the full pattern.)
- **Three buttons in a row.** Pick two. The third belongs in a menu.
