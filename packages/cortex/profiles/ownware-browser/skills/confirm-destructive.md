---
name: confirm-destructive
description: Pause before any irreversible web action (payment, refund, send, delete) and ask the user to confirm the exact details.
trigger: /confirm-destructive
allowedTools:
  - browser_snapshot
  - browser_screenshot
  - ask_user
---

# Confirm a Destructive Action

This is the most important skill in this profile. Get it right and the user trusts you with real tasks; get it wrong and you become an agent that costs them money or relationships.

## What counts as destructive

If undoing it requires customer support, an email to a vendor, a card reversal, or "you can't undo this," it's destructive. Concrete list:

- Submitting a payment, placing an order, completing a checkout, renewing a subscription.
- Refunding, returning, exchanging, cancelling an order.
- Sending an email, sending a DM, posting publicly (tweet, post, comment, review).
- Deleting an account, deleting a saved card, deleting a file, deleting a project, deleting a message.
- Changing a password, changing 2FA settings, rotating a security key, removing a recovery method.
- Changing the primary payment method, adding a new card, removing a card.
- Cancelling a subscription, downgrading a plan, removing a team member.
- Accepting a contract, signing a document, agreeing to new terms.
- Anything labeled "Final", "Confirm", "Place order", "Submit", "Send", "Delete", "Cancel forever".

If you're unsure whether something is destructive, ask. Better one extra confirmation than one wrong click.

## The pause point

The right moment to pause is **on the review/confirm page, NOT on the page where you fill the details.**

```
✗ Wrong:  cart → ASK USER → checkout form → review page → confirm
✓ Right:  cart → checkout form (fill) → review page → ASK USER → confirm
```

The user wants to confirm the *final state* — the total, the address, the items, the recipient. Confirming halfway through is useless; the form could still change.

So: navigate, fill, and arrive on the review screen with all the details visible in your latest snapshot. Then stop.

## Phrasing the confirmation

Quote the details verbatim from the snapshot. Do not paraphrase numbers, names, addresses, or recipients.

**Bad** (paraphrases, hides cost, vague):

> "I'm ready to place the order. Should I confirm?"

**Good** (specific, every detail user needs to decide):

```
ask_user({
  prompt: "Ready to place the order at sony.com:

  Items:
    1× Sony WH-1000XM6, color Midnight Black — $349.99
    1× 2-year accident protection — $39.99

  Subtotal:    $389.98
  Tax:         $33.36
  Shipping:    Free (standard, arrives May 23–24)
  Total:       $423.34

  Pay with:    Visa ending 4242
  Ship to:     Sam Rivera, 123 Main St, Brooklyn NY 11201
  Email:       user@example.com

  Confirm and place the order?",
  options: ["Place order", "Cancel", "Change something"]
})
```

If the user says "change something," ask what. Don't go change things yourself based on inference.

## Edge cases

- **Saving payment / address for next time**. The user didn't ask you to. If the page has a "save card for next time" checkbox, uncheck it unless the user explicitly said to save. Same for "remember address."

- **Marketing opt-ins.** Sites pre-check "subscribe to deals", "join our list", "follow us on Instagram." Uncheck all of those by default. The user can opt in themselves if they want.

- **Tip selections** (food delivery, ride-share). If the page defaults to a tip, surface it in your confirmation: "Includes 18% tip ($4.50). Change?" Don't silently ship a default tip.

- **Insurance / add-ons** (rental cars, flight changes, electronics). If the page pre-selected an add-on, surface it. "Includes Sony 2-year protection ($39.99). Keep?" Many sites pre-check these and rely on you not noticing.

- **Order timing.** If the page shows "delivers May 23" but the user said "I need it by Wednesday," call that out before confirming. Don't just place the order and let them discover the date.

## After the click

The post-confirmation snapshot will usually show a success page with an order number, confirmation code, or success message. Capture it:

- **The number** — order #, confirmation #, ticket ID. Quote it back to the user.
- **Where to find it later** — "visible at sony.com/account/orders," "confirmation will arrive at user@example.com within 5 minutes."
- **Anything pending** — "tracking number ships when the order is fulfilled, usually 1–2 days."
- **Any new state** — "you have until May 21 9pm to cancel for free."

If the post-confirmation snapshot shows an error instead of success (card declined, address rejected, item went out of stock between page-load and submit), the action **did not fire**. Tell the user exactly what the page said and ask what to do next.

## When to use a screenshot

The confirmation step is one of the few places `browser_screenshot` earns its cost. If the page renders a critical visual that the a11y snapshot can't capture — an order receipt PDF preview, a complex multi-item summary card — take one screenshot, include it with your `ask_user` call, and proceed only on explicit confirmation.

Otherwise the a11y snapshot text is enough.

## The litmus test

Before any click on a destructive button, ask yourself: "If this fires and was wrong, what would the user have to do to fix it?" If the answer is "call customer service" or "wait 3 business days for a refund" — confirm first. Always.
