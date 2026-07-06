---
name: auth-flow
description: Sign-in / sign-up / forgot-password screens as three linked HTML files. Mobile-friendly form layout, label-above-input discipline, inline error patterns, social-SSO row, switch-flow link copy. Use when the brief is "design the auth screens", "make a login flow", "sign-up page". Skip for OAuth provider buttons in isolation (no flow), and skip for the post-login dashboard (that's a separate artifact).
trigger: /auth-flow
---

# Auth Flow — three screens, one mental model

## Overview

Authentication is high-anxiety UI: the user is one mistake away from being locked out, and they know it. The discipline is to lower that anxiety with three pages that feel like one continuous flow — same brand, same input style, same error pattern, predictable switch links between them. This skill ships three linked HTML files (`sign-in.html`, `sign-up.html`, `forgot.html`), each self-contained, sharing the same `:root` tokens so a single token edit re-themes all three.

This skill teaches the DESIGN of the auth flow — input order, error pattern, switch-link copy, social-SSO placement. It does NOT teach OAuth implementation or backend wiring. That's product code, not a designer's surface.

---

## Critical Constraints — read these first, every time

1. **Three files, identical `:root` tokens.** `sign-in.html` is the canonical entry; `sign-up.html` and `forgot.html` are siblings. Each duplicates the full `:root` block — no shared external CSS. Editing the accent token in one file does NOT propagate; the agent must edit all three, or the user re-applies a token-swap and notices the drift.
2. **Labels above inputs, always.** Never placeholder-only ("email" inside the field that disappears when typed). Placeholder-only labels fail accessibility, fail recall ("what was I typing?"), and fail validation messaging. Pattern: `<label for="email">Email</label>` above `<input id="email">`.
3. **Touch targets minimum 44×44px on mobile.** Inputs at least 48px tall, buttons at least 48px tall. The 44px floor comes from Apple HIG and Google Material; below that, thumb-tap accuracy collapses.
4. **One primary CTA per screen, full-width on mobile.** Sign in → "Sign in" / "Continue". Sign up → "Create account". Forgot → "Send reset link". The CTA copy names the action; never "Submit".
5. **Errors inline, below the field, in `--bad` color with an icon.** Never modal alerts. Never a single top-of-form error banner that doesn't tell the user WHICH field. Each error sits directly below the field, paired with both color and an icon (color-blind users) and `aria-describedby` to the input.
6. **Switch-flow link below the CTA, never above.** "Don't have an account? **Sign up**" sits below the Sign-in button. "Already have an account? **Sign in**" sits below the Create-account button. Above-CTA placement competes with the primary action.
7. **Social SSO above the email/password fields OR clearly grouped below the CTA.** If you offer Google/Apple/GitHub, the convention is a row of buttons at the top, then a divider (`OR continue with email`), then the form. This matches user expectation; reversing it loses the social-first user 200ms of confusion.
8. **No password field on the sign-in page if you use magic-link auth.** Pick a flow and commit. Don't show the user three options (password, magic link, social) and let them pick — choice paralysis is real on the login screen.

---

## Per-screen design rules

### Sign-in screen

**Input set:**
- Email (type=`email`, autocomplete=`email username`)
- Password (type=`password`, autocomplete=`current-password`, with show/hide toggle)

**CTA copy:** "Sign in" or "Continue" (both work; "Continue" is softer)

**Switch-flow link below CTA:** "Don't have an account? **Sign up**"

**Secondary affordance, below password field:** "Forgot password?" as a small text link, right-aligned.

**Error states:**
- Wrong credentials → "That email and password don't match" — vague on purpose (never "wrong password" or "no account with that email" — leaks account existence to attackers).
- Account locked → "Too many attempts. Try again in 5 minutes or reset your password."

### Sign-up screen

**Input set:** (minimum viable, in this order)
- Full name (type=`text`, autocomplete=`name`) — OR — skip name and ask after first login. Defer is fine.
- Email (type=`email`, autocomplete=`email`)
- Password (type=`password`, autocomplete=`new-password`, with show/hide toggle AND a strength indicator)
- Optional: company name (only if B2B and only if it actually gates something downstream)

**Do NOT** ask for "confirm password" — the show/hide toggle replaces it and reduces friction.

**CTA copy:** "Create account" (never "Sign up" — too generic; "Create account" names the outcome)

**Switch-flow link below CTA:** "Already have an account? **Sign in**"

**Below the CTA, small caption:** "By creating an account, you agree to the [Terms] and [Privacy Policy]." — required for legal in most jurisdictions, never inside a checkbox the user must tick (a tick adds friction without changing the legal status of consent for most products).

**Error states:**
- Email already in use → "An account exists with that email — [Sign in instead]" (the bracketed text is a real link to sign-in).
- Weak password → strength meter (`weak / fair / strong`) plus the rule that triggered weak: "At least 8 characters" or "Add a number".

### Forgot-password screen

**Input set:**
- Email (type=`email`, autocomplete=`email`) — that's it. One field.

**CTA copy:** "Send reset link"

**Post-submit state:** show a success message in place of the form, NEVER navigate away — `"Check your inbox for a link to reset your password. If it doesn't arrive in 5 minutes, check spam or [try again]."` The "try again" link reopens the form.

**Switch-flow link below CTA:** "Remembered it? **Sign in**"

**Anti-leak rule:** never tell the user "no account found with that email." Always show the same success message regardless of whether the email exists. Otherwise you've built an email-validity oracle for attackers.

---

## File shape — paste-ready sign-in.html

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in — {Product}</title>
  <style>
    :root {
      --bg: #fafafa;
      --surface: #ffffff;
      --fg: #111111;
      --muted: #6b6b6b;
      --border: #e5e5e5;
      --border-focus: #2f6feb;
      --accent: #2f6feb;
      --accent-hover: #1f5fd6;
      --bad: #dc2626;
      --bad-soft: #fef2f2;
      --radius: 8px;
      --font-display: "Inter", -apple-system, system-ui, sans-serif;
      --font-body: "Inter", -apple-system, system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 var(--font-body); display: grid; place-items: center; min-height: 100vh; padding: 24px; }
    .card { width: 100%; max-width: 400px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 40px 32px; }
    .brand { font: 600 18px/1 var(--font-display); margin-bottom: 24px; }
    h1 { font: 600 24px/1.2 var(--font-display); margin: 0 0 8px; letter-spacing: -0.01em; }
    .sub { color: var(--muted); margin: 0 0 28px; font-size: 14px; }
    .sso { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }
    .sso button {
      height: 48px; border: 1px solid var(--border); background: var(--surface);
      border-radius: var(--radius); font: 500 14px var(--font-body);
      display: flex; align-items: center; justify-content: center; gap: 8px;
      cursor: pointer;
    }
    .sso button:hover { background: #f9f9f9; }
    .divider { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 13px; margin: 20px 0; }
    .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--border); }
    .field { margin-bottom: 16px; }
    .field label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
    .field input {
      width: 100%; height: 48px; padding: 0 14px;
      border: 1px solid var(--border); border-radius: var(--radius);
      font: 15px var(--font-body); color: var(--fg);
      background: var(--surface);
    }
    .field input:focus { outline: none; border-color: var(--border-focus); box-shadow: 0 0 0 3px rgba(47,111,235,0.15); }
    .field .pw-row { position: relative; }
    .field .pw-row button {
      position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
      background: none; border: none; color: var(--muted); cursor: pointer;
      font-size: 12px; padding: 6px;
    }
    .row-right { text-align: right; font-size: 13px; margin: -8px 0 20px; }
    .row-right a { color: var(--accent); text-decoration: none; }
    .error-msg { color: var(--bad); font-size: 13px; margin-top: 6px; display: flex; align-items: center; gap: 6px; }
    .error-msg::before { content: "!"; display: inline-grid; place-items: center; width: 14px; height: 14px; border-radius: 50%; background: var(--bad); color: white; font-size: 10px; font-weight: 700; }
    .field.has-error input { border-color: var(--bad); background: var(--bad-soft); }
    .cta {
      width: 100%; height: 48px; border: none; border-radius: var(--radius);
      background: var(--accent); color: white;
      font: 600 15px var(--font-body); cursor: pointer;
    }
    .cta:hover { background: var(--accent-hover); }
    .switch { text-align: center; color: var(--muted); font-size: 14px; margin-top: 20px; }
    .switch a { color: var(--accent); font-weight: 500; text-decoration: none; }
  </style>
</head>
<body>
  <main class="card" data-cx-id="card">
    <div class="brand">Acme</div>
    <h1>Sign in</h1>
    <p class="sub">Welcome back.</p>

    <div class="sso" data-cx-id="sso">
      <button type="button">Continue with Google</button>
      <button type="button">Continue with GitHub</button>
    </div>
    <div class="divider">OR</div>

    <form data-cx-id="form" novalidate>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" type="email" autocomplete="email username" required />
      </div>
      <div class="field has-error">
        <label for="password">Password</label>
        <div class="pw-row">
          <input id="password" type="password" autocomplete="current-password" required />
          <button type="button" aria-label="Show password">Show</button>
        </div>
        <div class="error-msg">That email and password don't match.</div>
      </div>
      <div class="row-right"><a href="forgot.html">Forgot password?</a></div>
      <button class="cta" type="submit">Sign in</button>
    </form>

    <p class="switch">Don't have an account? <a href="sign-up.html">Sign up</a></p>
  </main>
</body>
</html>
```

That's the sign-in. The sign-up file uses the same `:root` and component CSS, swaps the form to (name, email, password) and the CTA to `Create account`, adds the legal caption, swaps the switch-link to point at `sign-in.html`. The forgot file strips down to one email field, swaps the CTA to `Send reset link`, and ships a post-submit success state.

---

## Concrete examples

### Example 1 — three-file flow for a B2B SaaS

- **Direction:** Modern Minimal, cobalt accent `#2f6feb`.
- **sign-in.html:** email + password + show/hide, "Forgot password?" link, Google + GitHub SSO above the form, CTA "Sign in", switch-link "Don't have an account? Sign up".
- **sign-up.html:** full name + email + password (with strength meter), no "confirm password", Google + GitHub SSO above, CTA "Create account", legal caption below CTA, switch-link "Already have an account? Sign in".
- **forgot.html:** email field only, CTA "Send reset link", success state (`Check your inbox…`) replaces the form on submit, switch-link "Remembered it? Sign in".

All three share the same 400px-max card on a centered grid, same 48px-tall inputs, same plus-icon error pattern.

### Example 2 — consumer mobile-first flow, magic link only

For a consumer app deciding magic-link is the only auth, the sign-in collapses to one screen with one field (email), one CTA ("Email me a sign-in link"), and one post-submit state. No password field. No sign-up file at all — magic link with a new email auto-creates the account.

- **sign-in.html:** email field, CTA "Email me a sign-in link", small caption "We'll create an account if you don't have one yet — no password to remember." Switch-link removed entirely; there's no second flow.
- **forgot.html:** not needed; magic link IS the password reset.

Two screens collapse to one when the auth model allows it. Always question whether you need three screens before shipping three.

### Example 3 — error states in a sign-up form

```html
<div class="field has-error">
  <label for="email">Email</label>
  <input id="email" type="email" value="lena@stripe.com" />
  <div class="error-msg">An account exists with that email — <a href="sign-in.html">sign in instead</a>.</div>
</div>

<div class="field has-error">
  <label for="password">Password</label>
  <input id="password" type="password" value="abc123" />
  <div class="error-msg">At least 8 characters — currently 6.</div>
  <div class="strength" data-level="weak">Weak</div>
</div>
```

Each error sits below its field, in `--bad`, with an icon prefix (the `::before` plus-circle), and offers a path forward (link to sign-in, or a specific rule to fix). Never a generic `"Form has errors"` banner.

---

## Anti-patterns

- **Placeholder-only labels.** `<input placeholder="Email">` with no `<label>`. Fails screen readers, fails recall, fails error attachment. Always a label.
- **"Confirm password" field.** The show/hide toggle replaces it; doubling the field doubles abandonment. Cut.
- **Vague success message that doubles as login.** "Account created — welcome!" with no clear redirect. Always navigate to the post-login state explicitly OR show a one-button "Go to dashboard".
- **Telling the user which credential is wrong.** "Wrong password" leaks that the email exists. Always "That email and password don't match." Same for the forgot flow ("If an account exists, we sent a link.").
- **CAPTCHA on the sign-in form.** Friction tax on every legitimate user to slow a tiny minority of attackers. Use risk-based challenge (only on suspicious patterns) at the API layer; never on the form by default.
- **Hiding the password field on initial render.** "Click to reveal password." That's a UX innovation nobody asked for. Show the field, ship a show/hide toggle inside it.
- **Switch-flow link above the CTA.** Pulls the eye away from the primary action. Always below.
- **Errors as modal alerts (`alert('Wrong password')`).** Catastrophically wrong. Inline, in-context, in-color.
- **Three options on the sign-in screen (password / magic link / SSO) given equal weight.** Choice paralysis. Pick the canonical flow (usually SSO + password OR magic link), commit, ship a single hierarchy.
- **Tiny social SSO icons with no label.** A Google G icon alone — the user has to recognize and trust. Always "Continue with Google" with the icon + the brand name spelled out.
