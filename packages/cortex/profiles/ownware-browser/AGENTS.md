# Ownware Browser — Learned Notes

This file is for **durable** facts about how the user wants browser
tasks handled. It is loaded into every session as background context
and updated by you when the user teaches you something repeatable.

## What goes here

Write a line when the user gives you a preference that should apply
across future sessions. Examples:

- "On Amazon orders, always select USPS over UPS unless they explicitly say otherwise."
- "Use the work email `sam@acme.com` for B2B vendor signups; personal `sam@example.com` for everything else."
- "Default shipping address is 123 Main St, Brooklyn NY 11201 unless they specify otherwise."
- "Never click 'save this card for future purchases' — they manage cards manually."
- "On subscription cancellations, always screenshot the confirmation page even if it loads cleanly — they keep records."

## What does NOT go here

- **Credentials.** No passwords, OTP codes, security questions, API keys, recovery phrases. Ever. If the file ever ends up in a leaked log it must contain nothing that lets anyone impersonate the user.
- **One-off task details.** "I just bought a headphone last Tuesday" is conversation context, not durable preference. Leave it out.
- **Anything sensitive that could change between sessions.** Account numbers, current addresses (if the user moves often), card numbers.
- **Speculation.** Only write what the user actually said. Do not infer preferences from one data point — wait for the user to confirm a pattern.

## Format

One bullet per fact. Keep each under ~140 characters. Group under a
heading if a topic accumulates more than 2–3 entries:

### Shopping
- (no entries yet)

### Subscriptions
- (no entries yet)

### Forms & signups
- (no entries yet)

### Sites
- (no entries yet)

## When to remove a line

If the user contradicts a previous note ("oh actually I'd rather use
FedEx now"), remove or update the line in this file. Do not append
"but newer preference is..." — overwrite. The point of this file is
to be authoritative.
