# @ownware/ui — Repository Guidelines

Framework-agnostic, zero-runtime-dependency projection of the public Ownware
Gateway contract into renderable chat and evidence state.

## Boundaries

- Keep this package independent of React, Cortex and `@ownware/client`. Mirror
  only the minimal public structures required by the reducer and selectors.
- Events, snapshots and receipts are observations, not permission or effect
  authority. Never infer semantics from tool names, result prose, labels or run
  success.
- Unknown or malformed additive data must remain unavailable, unsupported or
  require resynchronization. It must never enable a mutation or become success.
- Tool UI descriptors are bounded presentation data only. Exact event or host
  descriptors win; an unfamiliar tool renders generically.

## Hydration and replay

- Durable `messages` replace the closed transcript. Preserve `parts` ordering;
  do not flatten a historical `text → tool → text` turn.
- Seed replay at `lastClosedTurnEndSeq`. Rebuild only the open tail from SSE and
  require hydration after a sequence gap or an unknown terminal variant.
- Reducers and selectors remain pure and deterministic: no I/O, clocks, random
  IDs or hidden mutable catalogues.

## Verification

Run `bun run build`, `bun run typecheck` and `bun run test` in this package.
Tests should include unfamiliar valid values, malformed records, replay gaps,
partial resources and adversarial examples that resemble supported semantics.
