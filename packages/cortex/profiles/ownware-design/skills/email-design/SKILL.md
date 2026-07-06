---
name: email-design
description: 'HTML email design — single-column layout, table-based structure, inline styles, dark-mode rules, image fallbacks, plain-text alt. Use for transactional email (password reset, receipt, magic link), marketing email (newsletter, drip campaign), digest email (weekly summary). Pairs with /notification-design (in-app notifications) and /copy-refiner (subject line + preview pane copy). Skip for web pages — Outlook''s CSS support breaks every modern layout pattern.'
trigger: /email-design
---

# Email Design — HTML that survives Outlook, dark-mode, and image-blocking

## Overview

Email is not the web. Gmail strips `<style>` blocks at the top of long messages. Outlook 2007–2019 renders with Word's HTML engine — no flexbox, no grid, partial CSS3. Apple Mail and Gmail iOS auto-invert colours in dark mode; Outlook 365 ignores `prefers-color-scheme` entirely. Roughly 40% of email clients block remote images by default until the user clicks "Show images."

This skill encodes the six rules that survive that field. It pairs with `/notification-design` (in-app counterpart) and `/copy-refiner` (subject line + preheader text). Treat it as the email-only reset of every modern web pattern.

---

## Critical Constraints — read these first, every time

1. **Single column, 600px max width.** Outlook for Windows truncates anything wider in many configurations; some Lotus Notes installations cut off at 580px. 600px is the tested ceiling.
2. **Inline styles only.** Gmail's web client strips `<style>` blocks past a certain length (~10kb threshold) and on forwarding. Every CSS property goes on the element via `style="..."`. Use a CSS-inliner step in the build, or write inline by hand.
3. **Tables for layout.** Outlook 2007–2019 uses Word's HTML engine. No `display: flex`, no `display: grid`, no `position: absolute`. `<table>` with `cellpadding`, `cellspacing`, `border="0"` is the only universally rendered layout primitive.
4. **Every `<img>` has `alt`, `width`, `height`, and `style="display:block"`.** Image-blocking is on by default in Outlook desktop and in many corporate Gmail tenants. The `alt` is what the user reads when the image doesn't load; `display:block` kills the 4px gap under inline-block images.
5. **Dark-mode tested across Apple Mail, Gmail iOS, Outlook 365.** Use `@media (prefers-color-scheme: dark)` and per-Gmail-iOS the `[data-ogsc]` selector. Outlook 365 has its own colour inversion that you opt out of with `<meta name="color-scheme" content="light dark">`.
6. **Plain-text alternative is mandatory.** Some corporate clients render text/plain only. SES, SendGrid, Postmark, Resend all accept a `text` field alongside `html`. Skip it and you fail spam filters (multipart MIME with text/plain raises sender reputation).

---

## The six rules — concretely

### Rule 1 — Single column, 600px max

```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:#f4f4f4;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px; width:100%; background-color:#ffffff;">
        <!-- email body goes inside this 600-wide table -->
      </table>
    </td>
  </tr>
</table>
```

Outer table is full width on the viewport background; inner table is the 600px content column.

### Rule 2 — Inline styles

```html
<!-- wrong, Gmail strips this -->
<style>.btn { background: #2f6feb; color: #fff; }</style>
<a class="btn">Verify</a>

<!-- right -->
<a href="..." style="background-color:#2f6feb; color:#ffffff; padding:12px 24px;
   text-decoration:none; border-radius:6px; display:inline-block;
   font-family:-apple-system,sans-serif; font-size:14px; font-weight:600;">Verify</a>
```

### Rule 3 — Subject line ≤ 50 char, preheader ≤ 80 char

Subject is what the user sees in the inbox list. Preheader is the second line under it (the first 80 char of the email body).

```html
<!-- hidden preheader: visible in the inbox preview, invisible in the open email -->
<div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
  Click below to confirm your email and finish creating your account.
</div>
```

Right subject: "Confirm your email — 5 min" (33 char).
Wrong subject: "Welcome to Acme! Please take a moment to confirm your email address" (66 char, truncated in iPhone Mail at 41 char).

### Rule 4 — Image fallbacks

```html
<img src="https://acme.com/logo.png"
     alt="Acme" width="120" height="40"
     style="display:block; border:0; outline:none; text-decoration:none;
            -ms-interpolation-mode:bicubic;">
```

If the user has images off, they see "Acme" in their email-client text style. If they have images on, they see the logo. Either way the email is not a wall of red Xs.

### Rule 5 — Dark mode

```html
<head>
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <style>
    @media (prefers-color-scheme: dark) {
      .bg-page    { background-color: #0d1117 !important; }
      .bg-card    { background-color: #161b22 !important; }
      .text-fg    { color: #e6edf3 !important; }
      .text-muted { color: #8b949e !important; }
      .btn-primary { background-color: #58a6ff !important; color: #0d1117 !important; }
    }
    /* Gmail iOS has its own quirk */
    [data-ogsc] .text-fg { color: #e6edf3 !important; }
  </style>
</head>
```

Then add class names to elements alongside their inline light-mode styles: `<td class="bg-card" style="background-color:#ffffff;">`. The inline wins in light mode; the `@media` `!important` wins in dark.

### Rule 6 — Plain-text alt

```
Confirm your Acme account

Click the link below to confirm acme@example.com and finish signup:

https://acme.com/verify?token=abc123

This link expires in 24 hours. If you didn't sign up, ignore this email.

— The Acme team
```

Match the HTML version's content. Don't say "Click here" — the link must be the full URL because there's no anchor in plain text.

---

## Concrete examples

### Example 1 — a password reset email, full HTML

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Reset your Acme password</title>
  <style>
    @media (prefers-color-scheme: dark) {
      .bg-page { background-color:#0d1117 !important; }
      .bg-card { background-color:#161b22 !important; }
      .text-fg { color:#e6edf3 !important; }
      .text-muted { color:#8b949e !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; font-family:-apple-system,'Segoe UI',sans-serif;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
    Use this link in the next 60 minutes to reset your Acme password.
  </div>
  <table class="bg-page" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background-color:#f4f4f4;">
    <tr><td align="center" style="padding:32px 12px;">
      <table class="bg-card" role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px; width:100%; background-color:#ffffff; border-radius:8px;">
        <tr><td style="padding:32px 32px 0;">
          <img src="https://acme.com/logo.png" alt="Acme" width="96" height="32" style="display:block; border:0;">
        </td></tr>
        <tr><td style="padding:24px 32px 8px;">
          <h1 class="text-fg" style="margin:0; font-size:22px; line-height:1.3; color:#111111;">
            Reset your password
          </h1>
        </td></tr>
        <tr><td class="text-fg" style="padding:8px 32px 24px; font-size:15px; line-height:1.6; color:#333333;">
          Someone asked to reset the password for acme@example.com. If that was you, click below.
          The link expires in 60 minutes.
        </td></tr>
        <tr><td style="padding:0 32px 24px;">
          <a href="https://acme.com/reset?token=ABC123"
             style="display:inline-block; background-color:#2f6feb; color:#ffffff;
                    padding:12px 24px; text-decoration:none; border-radius:6px;
                    font-size:14px; font-weight:600;">Reset password</a>
        </td></tr>
        <tr><td class="text-muted" style="padding:0 32px 32px; font-size:13px; line-height:1.6; color:#6b6b6b;">
          If you didn't request this, ignore the email — your password won't change.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
```

Single column, 600px, tables for layout, inline styles, dark-mode override, hidden preheader, image with alt + dimensions.

### Example 2 — the plain-text alt for the same email

```
Reset your Acme password

Someone asked to reset the password for acme@example.com.
If that was you, open this link:

https://acme.com/reset?token=ABC123

The link expires in 60 minutes.

If you didn't request this, ignore this email — your password won't change.

— The Acme team
https://acme.com
```

Same content, same calls-to-action, fully readable in any text-only client.

---

## Anti-patterns

- **CSS grid or flexbox.** Stop. Outlook 2007–2019 renders both as inline-block at best, broken at worst. Tables.
- **Background images via CSS.** Stop. Outlook ignores `background-image` on most elements. Use a `bgcolor` attribute on `<td>` or VML for hero images.
- **Web fonts via `@import` or `<link>`.** Stop. Most clients block it. Use a system font stack: `-apple-system, 'Segoe UI', Roboto, sans-serif`. Specify the web font you wish you had at the front of the stack only if the email is iOS-only.
- **External stylesheet.** Stop. Inline everything. The link is stripped by most clients on the way in.
- **No plain-text alt.** Stop. Spam filters penalize html-only emails. Always multipart.
- **Subject line ≥ 50 char.** Stop. iPhone Mail truncates at 41 char in portrait. Front-load the value.
- **Forgetting the preheader.** Stop. The 80 char of preheader text after the subject is your second-best inbox real estate. Use it.
