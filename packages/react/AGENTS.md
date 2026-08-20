# @ownware/react — Repository Guidelines

React bindings and reusable host UI built on `@ownware/client` and
`@ownware/ui`. This package owns accessible interaction and transport
lifecycle; it does not own Gateway policy or effect truth.

## Boundaries

- Keep the dependency direction `react → ui/client`. Do not import Cortex or
  duplicate its permission, egress, effect, skill or reversal policy.
- Negotiate capabilities before exact actions. Correlate permission,
  sensitive-input, cancellation and reversal mutations by the public run and
  request/offer identities; never fall back to a broader legacy mutation.
- Sensitive plaintext may exist only in the dedicated local input component
  long enough to call the sensitive-input method. Never place it in the shared
  reducer, hook state, events, errors, logs or evidence resources.
- Reconnect with the last accepted cursor. Hydrate after gaps, slow-consumer
  shutdowns and unknown terminal variants. Durable history comes from thread
  hydration, not reconstructed event guesses.
- Product-specific shells and workbenches live outside this package. Reusable
  components expose public state and honest generic fallbacks.

## Interface quality

- Preserve keyboard access, visible focus, labels, live status, 44px action
  targets, 16px form text, reduced motion and user-controlled scroll position.
- Do not clear drafts or pending decisions until the authoritative mutation
  succeeds. Render unavailable and partial evidence explicitly.

## Verification

Build `@ownware/ui` first, then run `bun run build`, `bun run typecheck` and
`bun run test` here. Cover hydration/reconnect, failed mutations, sensitive
canaries, partial pagination and accessible interaction states.
