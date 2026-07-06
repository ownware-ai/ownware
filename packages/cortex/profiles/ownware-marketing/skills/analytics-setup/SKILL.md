---
name: analytics-setup
description: When the user wants to design or audit event tracking and measurement — GA4, Mixpanel, Amplitude, PostHog, Segment. Returns the event taxonomy, properties, identity model, consent handling, and a verification plan. Also triggers on "event tracking", "set up GA4", "track signups", "instrument the app".
trigger: /analytics-setup
---

# Analytics Setup — taxonomy, identity, consent, verified

## Overview

You design a tracking implementation spec the engineering team can ship. The output is a named event taxonomy with property definitions, an identity model that doesn't double-count, a consent model that doesn't violate GDPR / CCPA, and a verification plan that catches breakage before it pollutes a quarter of data.

This is plumbing. Without it, every other skill (CRO, /ab-test, paid ads measurement) is reading noise.

---

## Critical Constraints — read these first, every time

1. **Event names are stable forever.** Once shipped, names become primary keys in dashboards, alerts, and historical data. Renaming is a multi-quarter migration. Get them right before the first event fires.
2. **One canonical name per event across the stack.** `signup_complete` is `signup_complete` in GA4, Mixpanel, the backend log, and the data warehouse. Aliasing across tools is where bad data is born.
3. **Identity model is mandatory.** Decide `anonymous_id` vs `user_id` aliasing rules upfront. Most analytics tools get this wrong silently — leading to retention math that's off by 2–3x.
4. **Consent gates non-essential tracking.** GDPR / CCPA: marketing analytics is non-essential. Without consent, no events fire — or fire to a consent-aware sink that throws them away. Server-side tracking does not exempt you from consent.
5. **Properties have stable types.** A property is always a string, always a number, always a boolean. Mixing types breaks dashboards.
6. **PII does not go in events.** Email, name, full IP, payment details — never as event properties. Use a hash or an internal user_id and join in a warehouse.
7. **Verification is mandatory.** Every event has a test plan. "We'll check the data later" is the path to a wasted quarter.

---

## Event taxonomy rules

1. **`object_action`** naming pattern. `signup_complete`, `pricing_viewed`, `trial_started`, `payment_failed`. Subject + verb, snake_case.
2. **Past tense for things that happened.** `signup_complete` (not `complete_signup`).
3. **No GA4 reserved event names.** `session_start`, `page_view`, `purchase` etc. are reserved — don't shadow them.
4. **Cap the taxonomy.** 20–50 named events covers most products. Hundreds of events = nobody knows what they mean.
5. **Group by funnel.** Acquisition (visit, signup_start, signup_complete) → Activation (first_value_event, key_milestone) → Retention (return_session, weekly_active_action) → Revenue (trial_started, payment_succeeded) → Referral (invite_sent).
6. **Properties on the event, not separate events.** `feature_used` with property `feature: 'export_csv'` beats a separate `export_csv_used` event.

---

## Identity model rules

- **Anonymous users:** `anonymous_id` (cookie or device ID).
- **Authenticated users:** `user_id` (your stable internal ID — never email).
- **Aliasing:** on signup_complete, alias the anonymous_id → user_id so pre-signup behaviour stitches to the user record.
- **Cross-device:** server-side identification when the user logs in on a new device — emit an alias event then.
- **Internal traffic:** filter via a server-side rule or a known internal_user property. Never publish dashboards with internal noise.

State exactly which tool does the aliasing and when — Mixpanel and Amplitude have different alias semantics; getting it wrong creates duplicate users.

---

## Consent model rules

- **Essential vs non-essential:** product analytics that powers core functionality might be essential (rare); marketing analytics is not.
- **Consent state stored:** in a first-party cookie + server record. Source-of-truth in the user record after signup.
- **No-consent path:** events do not fire OR fire to a consent-aware sink that drops them. Decide which.
- **Re-consent:** prompts when consent state expires (typical 12 months) or when categories change.
- **DSAR (deletion) compliance:** the user record + event history must be deletable on request. Plan this from day 1.

---

## Workflow

### Step 1 — Identify the stack and the gaps
- Which analytics tools are in play (GA4, Mixpanel, Amplitude, PostHog, Segment)?
- What's the current state — nothing, partial, broken?
- What decisions does this data need to support? (Funnel analysis, retention, revenue attribution, churn prediction.)

### Step 2 — Draft the event taxonomy
- The funnel: acquisition → activation → retention → revenue → referral.
- 5–10 events per stage typically.
- Each event: name, fired when, where (client / server), required properties, optional properties.

### Step 3 — Define the property schema
- Common properties on every event (timestamp, anonymous_id, user_id if known, page_url, consent_state).
- Event-specific properties with their types and value ranges.

### Step 4 — Define the identity model
- Anonymous vs user_id rules.
- Alias triggers.
- Internal-user filtering.

### Step 5 — Define the consent model
- Essential vs non-essential events.
- Storage, expiry, re-consent.
- Consent-aware sink behaviour.

### Step 6 — Define the verification plan
For each event, write a test:

- How to trigger it.
- Where to verify it (tool's live event stream, server logs).
- The expected payload shape.

### Step 7 — Define the dashboards / queries this enables
Don't over-design dashboards here; just note which 3–5 reports this taxonomy unlocks so the user can confirm it's worth the work.

### Step 8 — Hand off
Pass the spec to the engineering owner. Schedule a 1-week post-deploy verification.

---

## Output structure

```
# Analytics Setup Spec — <date>

## Stack
- Tools: <list>
- Current state: <one line>
- Decisions this data supports: <bullets>

## Event taxonomy

### Acquisition
| Event | Fired when | Source | Required props | Optional props |
|---|---|---|---|---|
| `visit` | Page loaded | Client | page_url, referrer, utm_* | screen_size |
| `signup_start` | Email entered on signup form | Client | source_page | invitation_id |
| `signup_complete` | Account created | Server | source_page, plan_tier | invitation_id, ref_code |

### Activation
| Event | ... |
| `first_value_event` | First time user does the activation action — define exactly | Server | feature, ms_to_event | |

### Retention
...

### Revenue
...

### Referral
...

## Property schema
- Common (every event): `event_id`, `anonymous_id`, `user_id` (if known), `consent_state`, `timestamp`, `page_url`
- Types: `event_id: string (UUID)`, `consent_state: enum (granted | denied | pending)`, ...

## Identity model
- Anonymous: cookie `_aid`, set on first visit.
- Authenticated: `user_id` from auth system.
- Alias rule: on `signup_complete`, server emits alias event mapping anonymous_id → user_id.
- Cross-device: on login from new device, server emits alias.
- Internal filter: `internal_user: true` property; dashboards exclude.

## Consent model
- Essential events: <list — usually none for marketing analytics>
- Non-essential: all events default to non-essential.
- Pre-consent behaviour: events queue locally, flush on `consent: granted`, drop on `consent: denied`.
- Storage: first-party cookie `_consent`, expiry 12 months.
- DSAR: `user_id` deletion cascades to event store within X days.

## Verification plan

| Event | Trigger | Verify in | Expected payload |
|---|---|---|---|
| `signup_complete` | Create account via UI | GA4 live event + Mixpanel live | `{user_id, source_page, plan_tier, timestamp}` |
| ... |

## Reports / dashboards this unlocks
- <three to five>

## Recommended next step
- Engineering ships the spec. Schedule the 1-week post-deploy verification on <date>.
```

---

## What you never do

- Never put PII in event properties.
- Never recommend an event taxonomy with hundreds of events.
- Never skip the identity model.
- Never recommend tracking that bypasses consent.
- Never rename a shipped event — design new ones if needed.
- Never approve "we'll verify it later." The verification plan ships with the spec.

---

## Worked example (abridged)

**User:** `/analytics-setup` — fresh GA4 + Mixpanel install for a B2B SaaS at signup-to-activation stage.

**You:**
1. Stack: GA4 (web), Mixpanel (product). Goal: understand signup → activation funnel.
2. Taxonomy: 14 events across acquisition / activation / retention. `signup_complete` and `first_value_event` named exactly.
3. Properties: common set + per-event set.
4. Identity: anonymous_id cookie → user_id alias on signup_complete (server-side via Segment, since both GA4 and Mixpanel are downstream).
5. Consent: non-essential default. Cookie-banner state stored.
6. Verification: per-event triggers, where to verify.
7. Reports unlocked: signup funnel, activation rate cohort, time-to-activation, paid-conversion attribution.

That's the shape.
