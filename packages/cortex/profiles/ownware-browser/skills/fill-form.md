---
name: fill-form
description: Fill a multi-field web form efficiently, handling autocomplete, date pickers, and address auto-fill correctly.
trigger: /fill-form
allowedTools:
  - browser_snapshot
  - browser_fill_form
  - browser_type
  - browser_click
  - browser_select
  - browser_press_key
  - browser_scroll
  - browser_wait
  - browser_evaluate
  - ask_user
---

# Fill a Web Form

The default browser-agent failure mode for forms is "type-into-each-field-one-at-a-time, snapshot-after-each, then sit confused when one field's auto-fill overwrote another." This skill is the right way.

## Step 1: Snapshot first

Before filling anything, make sure you have a fresh `browser_snapshot` showing all the form's fields with refs. Note:

- Field types (textbox, combobox, checkbox, radio, select).
- Required fields (the snapshot usually marks them with `[required]` or shows a `*` in the label text).
- Any field that looks like an autocomplete (combobox, listbox, datalist).
- The submit button's ref — but do NOT click it yet.

If the form is in a multi-step wizard, only the current step's fields matter for this call.

## Step 2: Batch-fill the simple fields

Use `browser_fill_form` with a single `fields` array for every field that's a plain textbox, checkbox, or `<select>`. One tool call, one settle, one returned snapshot.

```json
{
  "fields": [
    { "ref": "e5", "value": "Sam" },
    { "ref": "e6", "value": "Rivera" },
    { "ref": "e7", "value": "user@example.com" },
    { "ref": "e9", "value": "true", "type": "checkbox" },
    { "ref": "e11", "value": "US", "type": "select" }
  ]
}
```

For checkboxes, `value: "true"` checks, `value: "false"` unchecks.
For `<select>`, `value` is the option value (use `browser_select` with `label` if you only know the visible text).

## Step 3: Handle the special fields one at a time, AFTER the batch

These do not work with `browser_fill_form`:

- **Autocomplete / typeahead** (city, country, product search). Use `browser_type` with `slowly: true` and a delay so the JS handler registers each keystroke. Then call `browser_snapshot` to see the suggestion popup, and click the right option by ref.
- **Date pickers**. Try `browser_type` with the date as text first (`2026-05-19` or `05/19/2026`). If the snapshot shows the field rejected it (often visible as an inline error or the field clearing itself), open the picker by clicking the field icon and navigate the calendar UI.
- **OTP / security code fields**. Stop. Ask the user via `ask_user` — never invent codes.
- **CAPTCHA**. Stop. See the "destructive-action and challenges" section of `SOUL.md`.
- **Address auto-fill**. Fill the street first via `browser_fill_form`. The site often populates city/state/ZIP automatically. After the batch returns, snapshot, check whether city/state/ZIP were auto-filled — if they were, do nothing; if not, fill them in a second batch.

## Step 4: Validate before submit

The post-fill snapshot you got in the action result is your validation step. Skim it:

- Does the form still show all the values you set? (Some sites silently strip invalid characters.)
- Are there any inline error messages? (Look for `[alert]` or `[status]` nodes.)
- Did the `⚠ Console` or `⚠ Network failures` sections in the action result show anything? A 400 on a field-validation API call means the page rejected something.

If anything looks off, fix it before submitting.

## Step 5: Submit

- For checkout, login, or any irreversible action: **stop and ask the user** before clicking submit. See `confirm-destructive` skill.
- For normal forms (search, settings, filters): click the submit button by ref, then read the response snapshot.

## Common pitfalls

- **Submitting before validation completes.** Some forms run client-side validation asynchronously after blur. If the snapshot shows fields are still highlighted (e.g., `[textbox] [invalid]`), wait a turn — call `browser_wait` with `loadState: "networkidle"` and a short timeout, then snapshot.
- **Hidden fields.** Some forms have hidden CSRF tokens or trackers. You don't need to fill those. If a form rejects submission with "unauthorized" or "session expired," it's a server problem, not a missing-field problem.
- **Iframe forms.** Stripe / Adyen card inputs live in cross-origin iframes. The snapshot may not show them at all. If you don't see card fields where the page clearly has them, tell the user and ask whether they want to enter card details directly.
