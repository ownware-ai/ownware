---
name: error-messaging
description: 'Microcopy + visual rules for error messages — specific not generic, plain language not jargon, action-oriented not blame-oriented, with a real escape hatch. Use whenever an error UI is being designed: form validation, network failures, expired sessions, permission denials, server 500s, file rejections. Pairs with /copy-refiner (general copy rules) and /state-empty-loading-error (full error-state layout).'
trigger: /error-messaging
---

# Error Messaging — the difference between user-blame and product-helps

## Overview

A good error message answers three questions in under three seconds: *what happened*, *whose fault is it*, and *what do I do next*. "Something went wrong" answers zero of them. "Error code 4001" answers one. "That code expired — request a new one" answers all three.

This skill gives you the five rules, the severity ladder, the visual mapping, and a worked refinement of five common error scenarios. Use it any time an error string lands in a design. The bar is: every error a real user could see has been written deliberately. Not auto-generated from the exception class name.

---

## Critical Constraints — read these first, every time

1. **Specific not generic.** The error names the operation that failed. "Couldn't save your draft" beats "Save failed." "Email must include an @" beats "Invalid input."
2. **Plain language not jargon.** No "exception thrown", "null reference", "unauthorized 401", "validation failed", "EAGAIN", "ECONNREFUSED". The user is not the developer.
3. **Tell them what to do next.** Every error has an action verb. "Try again", "Pick a different password", "Sign in again", "Use a smaller file". A message with no next step is a wall.
4. **Don't blame the user.** "That code expired — request a new one" not "You entered an expired code." "We couldn't reach the server" not "Your network failed." Voice is product-helps-user, never user-broke-product.
5. **Provide an escape.** Even when the primary action is "retry", there's always a secondary path — contact support, view status, go back. The user never feels trapped.

These five compound. A great error message hits all five in under 30 words.

---

## Framework — the severity ladder (info / warn / error / critical)

Pick one per message. Different severities get different color, icon, and persistence.

| Severity | When | Color (token) | Icon | Persistence |
|----------|------|---------------|------|-------------|
| **Info** | Neutral status, low urgency | `--info` (blue) | info-circle | Auto-dismiss 4s, dismissible |
| **Warn** | Action allowed but risky; recoverable issue | `--warn` (amber) | triangle | Sticky until acknowledged |
| **Error** | Action failed but can be retried | `--bad` (red, soft) | x-circle | Sticky until retried or dismissed |
| **Critical** | Data loss imminent; security event; service down | `--bad` (red, full) | warning-octagon | Modal blocking, no auto-dismiss |

A 99% rule: most user-facing errors are **error**, not **critical**. Reserve critical for "your unsaved work will be lost", "your session was hijacked", "the system is down for everyone." Overusing critical is the boy-cry-wolf failure mode.

### Visual mapping

- **Info banner**: `--info-soft` background (8% blue), `--fg` text, `--info` icon. Inline near the relevant control.
- **Warn banner**: `--warn-soft` background, `--fg` text, `--warn` icon. Often inline; dismissible with `×`.
- **Error inline (form field)**: 12px red text below the field, no background. Field border becomes `--bad`. Icon optional.
- **Error toast**: bottom-right slide-in, `--surface` background with 4px `--bad` left border + icon. 8s persistence minimum.
- **Critical modal**: dim backdrop (rgba(0,0,0,0.5)), centered card, `--bad` icon at top, headline + body + primary destructive button + secondary safe button.

---

## Framework — the five-rule audit

For any error string, run it through:

1. **Specific?** Does it name the operation? (Replace "Failed" with "Couldn't upload `report.pdf`".)
2. **Plain?** Could a non-developer read it? (Replace "Auth token expired" with "You've been signed out.")
3. **Actionable?** Is there a verb the user can act on? (Add "Sign in again" if there isn't.)
4. **Blame-free?** Does it put the failure on the product, not the user? (Replace "You entered…" with "That… didn't match what we expected.")
5. **Escape?** Is there a secondary path if the primary doesn't work? (Add "Or contact support" / "Check status page".)

If any answer is no, rewrite. Five questions, thirty seconds.

---

## Concrete examples — five scenarios with WRONG and RIGHT

### Scenario 1 — Password mismatch on signup

WRONG:
```
Error: Passwords do not match.
```

Audit fails on actionable (vague), blame-free (implicit "you typed wrong"), escape (none).

RIGHT (inline beneath confirm field):
```
The two passwords don't match. Re-type the second one to confirm.
```

Why: names the cause specifically ("the two passwords"), action verb ("re-type"), no blame ("don't match" not "you mistyped"), no separate escape needed because the action IS the escape.

### Scenario 2 — Network timeout fetching dashboard

WRONG:
```
Network error. Please try again later.
```

Audit fails on specific (which network operation?), plain (passable), escape (none).

RIGHT (full error state):
```
[icon: x-circle, --bad]
Couldn't load your dashboard
We didn't hear back from the server. Your data is safe — this is a connection issue.

[Try again]   Check status →
```

Why: specific operation (dashboard load), explains cause without jargon, reassures (your data is safe), primary action, escape link.

### Scenario 3 — File too large on upload

WRONG:
```
File too big. Maximum size is 5242880 bytes.
```

Audit fails on plain (bytes), actionable (no suggestion).

RIGHT (toast or inline):
```
That file is 12 MB — our limit is 5 MB. Try compressing the PDF or splitting it into two uploads.
```

Why: specific numbers in human units, the comparison makes the constraint concrete, two concrete next actions.

### Scenario 4 — Expired magic-link / one-time code

WRONG:
```
Invalid code. Please re-enter.
```

Audit fails on blame-free (implies user typed wrong when the code was valid but expired), specific (code is "invalid" hides the actual cause).

RIGHT:
```
That code expired — they're only good for 10 minutes. Request a new one and we'll send it now.

[Send new code]   Contact support
```

Why: explicit cause (expired, not "invalid"), the time window teaches the rule, action verb, escape.

### Scenario 5 — Server 500 on save

WRONG:
```
500 Internal Server Error
```

Audit fails on ALL FIVE rules. Don't ship raw status codes.

RIGHT (toast, with retry preserving form state):
```
[icon: x-circle, --bad, 4px left border]
We couldn't save your changes — our system hit a snag on our end. Your draft is preserved; nothing was lost.

[Try saving again]   Report this →
```

Why: names operation (save), explains where the fault is (our end, not yours), reassures about data loss, primary action that preserves state, escape to a report flow.

---

## Concrete example — visual implementation

```html
<style>
  :root {
    --surface: #ffffff; --fg: #111111; --muted: #6b7280; --border: #e5e5e5;
    --bad: #dc2626; --bad-soft: rgba(220, 38, 38, 0.08);
    --warn: #d97706; --warn-soft: rgba(217, 119, 6, 0.10);
    --info: #2563eb; --info-soft: rgba(37, 99, 235, 0.08);
  }
  .toast { display: flex; gap: 12px; padding: 14px 16px 14px 14px; background: var(--surface); border: 1px solid var(--border); border-left-width: 4px; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.08); max-width: 420px; }
  .toast--error { border-left-color: var(--bad); }
  .toast--warn { border-left-color: var(--warn); }
  .toast--info { border-left-color: var(--info); }
  .toast .icon { flex-shrink: 0; width: 20px; height: 20px; margin-top: 1px; }
  .toast--error .icon { color: var(--bad); }
  .toast .title { font: 600 14px/1.3 system-ui; color: var(--fg); margin: 0 0 4px; }
  .toast .body { font: 13px/1.45 system-ui; color: var(--muted); margin: 0; }
  .toast .actions { display: flex; gap: 12px; margin-top: 10px; }
  .toast .btn-link { background: none; border: 0; padding: 0; font: 500 13px system-ui; color: var(--bad); cursor: pointer; }
  .toast .btn-text { background: none; border: 0; padding: 0; font: 500 13px system-ui; color: var(--muted); cursor: pointer; }
</style>
<div class="toast toast--error" role="alert" data-cx-id="toast-save-error">
  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/></svg>
  <div>
    <p class="title">We couldn't save your changes</p>
    <p class="body">Our system hit a snag on our end. Your draft is preserved; nothing was lost.</p>
    <div class="actions">
      <button class="btn-link">Try saving again</button>
      <button class="btn-text">Report this →</button>
    </div>
  </div>
</div>
```

Notice: 4px left border in `--bad`, icon in `--bad`, title in `--fg` (not red — the border carries semantic weight), body in `--muted`. Two actions: primary retry + escape link. No "OK", no "Dismiss" — the user dismisses by retrying or moving on.

---

## Anti-patterns

- **"Something went wrong."** Lazy default. Always replaceable. If you don't know what went wrong, you don't have an error UI — you have a logging gap.
- **Raw status codes / stack traces in user copy.** "401", "Bad Gateway", "ENOTFOUND". Translate them.
- **Blaming the user.** "You entered an invalid email." → "That email format wasn't recognized — emails look like name@example.com."
- **Walls (no action, no escape).** A red bar that just says "Failed" with no button. Add a retry or a back link.
- **"Please try again later" without telling them what later means.** 5 minutes? 5 hours? Be specific or remove the timeframe.
- **Apologizing twice.** "Sorry, we're sorry, an error occurred, we apologize." The product is helpful, not abject. State the fact, offer the action.
- **Validation errors that erase the field.** The user types 16 characters, you say "too short", you blow the field empty. Cardinal sin. Preserve input on validation failure.
- **Auto-dismissing critical errors.** A toast that vanishes after 4s when the user lost unsaved work. Critical persists until explicitly acknowledged.
- **Single-line error for a multi-step recovery.** If the fix is three steps, write three steps. Don't compress into one sentence the user will misread.
- **Using `--bad` for warnings.** Red for genuine errors only. Amber for warn. Red for "not configured yet" reads as broken.
