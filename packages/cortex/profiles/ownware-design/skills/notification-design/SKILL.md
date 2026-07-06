---
name: notification-design
description: 'Cross-channel notification design — in-app (toast / badge / banner), push (system / sticky / silent), email (transactional / digest / marketing). Rules for priority, copy length, frequency cap, fan-out. Use when designing how a product event reaches a user across multiple surfaces. Pairs with /email-design (full email craft) and /microinteractions (toast slide pattern).'
trigger: /notification-design
---

# Notification Design — fan-out without burning the user

## Overview

Most products treat notifications as a single decision ("send a push") instead of a design system spanning three channels and three priorities. The result: every event arrives as both a banner and an email and a push, the user mutes everything, and the channel that actually mattered (the billing failure) gets lost in the noise.

This skill is the framework for deciding WHICH channel(s) carry an event, WHAT priority, WHAT the copy is per channel (push is 40 characters; email subject is 50; in-app has no length limit but earns brevity anyway), and HOW often (frequency cap by channel).

Use this when designing any product event that needs to reach a user — billing alerts, mentions, scheduled exports finishing, deploys, security events. Don't use it for marketing campaigns (that's lifecycle marketing) or for system status pages (different surface entirely).

---

## Critical Constraints — read these first, every time

1. **No channel by default.** Every event explicitly opts in to channels — never "fan out to everything because it's important." The user's attention is finite; respect it.
2. **Copy is channel-specific.** Push headline ≤ 40 chars. Push body ≤ 60 chars. Email subject ≤ 50 chars. In-app banner headline ≤ 8 words. Reuse one string across all four = bad copy in three of them.
3. **Frequency cap per channel per day.** Push: max 3/day per user. Email: max 1 transactional digest/day (excluding hard alerts). In-app: no daily cap but no more than one banner visible at once.
4. **Critical events ALWAYS land in at least two channels.** Billing failure that costs the user money: in-app banner + push + email. A single channel can fail (push permission denied, email in spam) — redundancy is for events the user cannot afford to miss.
5. **Standard and low priority pick ONE channel.** A new mention in a doc is a badge dot, not a push. A weekly stats summary is an email digest, not three notifications.
6. **Every notification has a deep link.** Tapping it lands the user on the relevant object — not the app's home screen. Push and email both carry URLs back into the product.

---

## Framework — the taxonomy (channels × priorities × actions)

### Three channels

- **In-app**: toast (4s ephemeral), badge (count on icon), banner (sticky strip at top of screen). Cost-free; only visible when app is open.
- **Push**: system notification on lock screen / notification center. Standard (default), sticky (won't dismiss until tapped — reserve for critical), silent (data-only, no UI — for triggering background sync). Cost: user attention + permission grant.
- **Email**: transactional (one event = one email, immediate), digest (rollup of N events, scheduled), marketing (broadcast, separate consent). Cost: inbox real estate, spam-folder risk.

### Three priorities

| Priority | Description | Default channel mix | Frequency cap |
|----------|-------------|---------------------|---------------|
| **Critical** | Action required; money or security at stake | In-app banner + Push (sticky) + Email (transactional) | No cap — but events must genuinely be critical |
| **Standard** | Worth knowing today | Badge dot + Email digest (next morning) | Push optional; cap 3 push/day |
| **Low** | Worth knowing eventually | Badge dot only OR weekly digest | No push, no toast |

### Two action types

- **Read-only**: the notification is information ("Your export finished"). Tap takes the user to view it.
- **Decision-required**: the notification asks for a response ("Approve $1,200 spend?"). Tap opens an action surface with primary + dismiss buttons. Critical decision-required notifications carry rich actions inline where the channel supports it (push: 2 button actions; email: 1 primary CTA).

---

## Framework — copy rules per channel

### Push

- **Headline ≤ 40 characters.** Truncates on lock screen otherwise.
- **Body ≤ 60 characters.** Two-line preview on iOS / Android.
- **Lead with the noun, not the verb.** "Stripe payment failed" beats "We couldn't process your payment." The user scans for the relevant noun.
- **Never end with a period in the headline.** Wastes a character; the headline is a label, not a sentence.

### Email subject + preheader

- **Subject ≤ 50 characters.** Gmail truncates around 60 desktop / 35 mobile.
- **Preheader ≤ 90 characters.** This is the gray text after the subject in the inbox list. Write it deliberately — it's the second-most-read line.
- **No "RE:" or "FW:" tricks.** Reads as spam.
- **No emoji unless brand-consistent.** A status-page email with a 🎉 is wrong.

### In-app

- **Banner headline ≤ 8 words.** "Your weekly export is ready" — 5 words.
- **Toast body ≤ 12 words.** "Saved. Your changes are live across all 3 environments." — 9 words.
- **Always pair with action.** Even an info toast has a way to dismiss or view the related item.

---

## Concrete examples

### Example 1 — Billing failure fanned out across channels

**Event**: monthly Stripe charge failed for a Pro-tier user. Money at stake. Critical priority.

**Fan-out**:

1. **In-app banner** (renders on next session, persists until resolved or dismissed)
```html
<div class="banner banner--critical" data-cx-id="billing-failed-banner" role="alert">
  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16v.01"/></svg>
  <div class="copy">
    <strong>Your December payment didn't go through.</strong>
    Your subscription stays active until Dec 14 — update your card to avoid losing access.
  </div>
  <a class="btn-primary" href="/billing">Update card</a>
</div>
```

2. **Push notification** (sticky, immediate)
```
Title (38 chars): Acme payment failed — action needed
Body  (57 chars): Your December charge didn't go through. Update by Dec 14.
Deep link: acme://settings/billing
Actions:  [Update card]  [Remind tomorrow]
```

3. **Email transactional** (immediate, separate from any digest)
```
Subject (44 chars):  Your Acme payment didn't go through
Preheader (84 chars): Your December charge failed. Your account stays active until Dec 14 — update your card to keep it.

Body:
Hi Sam,
Your December $29 payment for Acme Pro didn't go through. Your card may be expired or have a hold.

Your subscription stays active until December 14. Update your card by then to keep your account.

[Update card]

If your card looks fine, the issue may be with your bank — sometimes they flag recurring international charges. Try again or contact us at help@acme.co.

— The Acme team
```

Why it works across channels: same event, three different framings. Push leads with the noun ("payment failed — action needed") because lock-screen reading is fast. Email gives more context because the user is now in inbox-mode. In-app banner shows ONLY when the user is in the product, with the most prominent CTA because they're already engaged.

### Example 2 — New comment on a doc (standard priority, single channel)

**Event**: a teammate left a comment on a doc the user owns.

**Fan-out** (correct):

- **Badge dot** on the app icon and the doc's row in the sidebar.
- **Email rollup** included in tomorrow's daily digest (or not at all if the user opens the doc today — debounce the email if the badge was consumed).

**Fan-out** (wrong, the over-notify trap):

- ~~Push to the user's phone~~
- ~~Email immediately~~
- ~~Toast in-app~~
- ~~Banner in the doc~~

Why the wrong version is wrong: one comment is not worth a phone vibration. The user trains themselves to ignore the channel. Then when a critical event arrives, they ignore that too.

---

## Framework — the frequency cap policy

Per user, per channel, per 24 hours:

- **Push**: ≤ 3 per day. The 4th push gets demoted to badge-only or queued into the morning digest.
- **Email transactional**: each critical event sends its own email immediately. Standard events roll up into ONE daily digest at the user's chosen morning time (default 8am local).
- **Email digest**: one per day max. Never split into multiple digests.
- **In-app banner**: only one critical banner visible at a time; if two events trigger simultaneously, queue them with newest on top, older accessible via "1 more →".
- **Toast**: deduplicate identical toasts within 10 seconds (don't fire "Saved" three times because the user hit Cmd+S three times — fire it once and update the relative time).

When the cap is hit: don't drop the event. Demote the channel. A capped push becomes a digest entry. A capped digest entry rolls into a weekly summary. Never silent-drop.

---

## Anti-patterns

- **Fan-out to all channels by default.** "It's important so I'll send everywhere" is how every notification becomes background noise. Pick the channels that fit the priority.
- **Same copy across all channels.** A 12-word in-app banner copy-pasted into a push subject is truncated to "Your weekly export is read…" on the lock screen.
- **Critical events on one channel only.** Push permission denied + email in spam = the user misses their billing failure. Critical needs redundancy.
- **No frequency cap.** A chatty product fires 47 pushes the first week and the user disables notifications globally.
- **Notifications without deep links.** The user taps a push that says "Comment on Spec Doc" and lands on the app home screen, not the doc. They lose the comment.
- **Marketing inside transactional emails.** A billing-failure email with a "Try our new Analytics feature!" footer reads as gross. Transactional is sacred.
- **Emoji-as-icon in critical paths.** A 🔥 in a "Your data is at risk" email looks like a phishing attempt.
- **Stuck banners with no dismiss.** A "Welcome back!" banner that the user can't close on a B2B dashboard reads as broken. Banners always dismiss (× icon) unless their condition is unresolved (then they reappear next session).
- **Notifying the actor.** The user who left the comment doesn't need a push saying "You left a comment." Filter out self-events before fan-out.
- **Digests longer than 7 items.** A 30-item digest is unread; the user scans the subject and archives. Cap digest entries at 7; surface "and 14 more →" link.
- **Push permission prompt on first session.** The OS dialog appears before the user knows what kind of notifications they'd get. Ask in-context after the user has done a meaningful action (created their first project, etc.) with a soft prompt explaining what they'll receive.
