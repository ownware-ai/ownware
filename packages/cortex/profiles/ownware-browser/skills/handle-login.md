---
name: handle-login
description: Recognize when a site requires authentication and hand control back to the user instead of guessing credentials.
trigger: /handle-login
allowedTools:
  - browser_snapshot
  - browser_tab_list
  - ask_user
---

# Handle a Login Wall

You will land on login pages. You will **never** type credentials yourself. This skill is the script for what to do instead.

## Step 1: Recognize the login wall

You're on a login wall when the snapshot shows ANY of:

- URL contains `/login`, `/signin`, `/sign-in`, `/auth`, `/sso`, `/oauth`.
- Heading text like "Sign in", "Log in", "Welcome back", "Continue with Google/Apple/Microsoft".
- Two adjacent textboxes labeled (or placeheld) "Email" / "Password", "Username" / "Password", "Phone number".
- An iframe whose URL is `accounts.google.com`, `appleid.apple.com`, `login.microsoftonline.com`, `auth0.com`, etc.
- A redirect chain where the original URL silently became one of the above.

Subtle case: you were doing something inside an app (e.g., editing a setting) and the action triggered a re-auth ("we need to confirm it's you"). The snapshot will show the same login form pattern inside a modal.

## Step 2: Stop. Do not interact with the form.

Do **not**:

- Type into the email or password fields.
- Paste anything from your context that looks like an email address.
- Click "Sign in with Google" / "Sign in with Apple" — those flows trigger OS-level passkeys or popups you can't drive.
- Click "Forgot password?" — that emails the user; only the user should decide whether to do that.
- Refresh the page hoping it goes away.
- Switch to incognito / clear cookies / open a new tab.

## Step 3: Ask the user

Use `ask_user`. Be specific about what site is asking for what.

```
ask_user({
  prompt: "tide.co asks me to sign in to view your invoices. I can't authenticate for you. Options:
  
    1. You sign in now — just click into the browser tab and complete the login. I'll wait. Reply 'done' when you're back.
    2. Skip this task — I'll stop here and you can come back later.
    3. Switch sites — if you'd rather use a different banking provider, tell me which.
  
  What would you like?",
  options: ["I'll sign in", "Skip task", "Switch sites"]
})
```

## Step 4: After the user takes over

Once the user signs in (or says they're done), take a fresh `browser_snapshot`. You should see the post-login page they intended. If you still see the login form:

- Maybe the user didn't actually log in — ask again.
- Maybe there's a multi-step flow (2FA, email confirmation) — ask the user where they are in it.
- Maybe credentials were rejected — quote the error message from the snapshot back to the user verbatim.

Then continue the original task as if the login never happened — but skip any "remember me" / "stay signed in" / "trust this device" checkboxes unless the user explicitly told you to enable them. Persistent sessions are the user's choice.

## SSO / passkey / app-confirmation flows

These often need actions outside the browser tab — approving on a phone, tapping a security key, completing a CAPTCHA. The pattern is the same: tell the user what the page is asking for, hand control back, wait. Do not try to drive the popup, the OS dialog, or the phone push notification.

## Why this matters

A wrong agent here is worse than a stuck agent. Sites flag automated login attempts — if you guess and fail, the user's account can get suspended, locked, or flagged for "suspicious activity." That's harder to recover from than restarting the task with a logged-in browser.

If the user is using Ownware with a persistent Chrome profile (B7 — userDataDir), the next session will likely have the cookies and not hit the login wall at all. So the cost of "ask once" is small, and it pays off forever.
