# Contributing to Ownware

Thanks for your interest in making Ownware better. This file covers the
whole monorepo; `packages/loom` and `packages/cortex` each have their
own `CONTRIBUTING.md` with package-specific detail.

**What helps most right now, in order:** bug fixes with reproductions ·
security hardening · first-run/onboarding friction reports · docs fixes ·
channel adapters (as packages) · profiles. New core features are the
*least* likely contribution to merge — see the placement gate below.

## Before you start: search first

Search open **and closed** issues/PRs for your topic before writing code —
the duplicate check at review time fires *after* you've done the work:

```bash
gh search issues --repo ownware-ai/ownware --state all "your topic"
gh search prs    --repo ownware-ai/ownware --state all "your topic"
```

For anything non-trivial, open (or claim) an issue first so others don't
start the same thing. Tiny fixes can go straight to PR.

## Where does this live? (read before adding anything)

Ownware stays lean at the core and expansive at the edges. New capability
belongs at the **lightest layer that can express it** — pick the highest
rung that solves the problem:

1. **A profile** — instructions, personality, tool selection, security
   posture. Most "the agent should do X" ideas are profiles.
2. **A CLI verb or flag** — operator convenience over existing behavior.
3. **A channel adapter** — a new place to talk to the agent. Adapters are
   *clients* of the wire contract; they live in their own package and
   don't touch core. Broadly-used community adapters can get promoted.
4. **A connector** — a new credentialed integration surface in the kernel.
5. **An engine change** — the loop, tools, zones, streaming. **Last
   resort**, highest bar: every engine surface is carried by every agent.

If your idea needs a rung you can't reach from outside core, open an
issue proposing the *seam* (the extension point), not just the feature —
extending the generic surface beats hardcoding one integration.

This isn't a quality bar — it's a coupling-and-maintenance decision. A
niche integration rejected from core with a pointer to "ship it as a
profile/adapter" is still a valued contribution.

## Getting started

Requires [bun](https://bun.com) ≥ 1.3 and Node ≥ 22.

```bash
git clone https://github.com/ownware-ai/ownware.git
cd ownware
bun install
bun run build        # every package, dependency order
bun run test
```

> The workspace runner is **bun** — not npm, not pnpm.

## Development commands

```bash
bun run build        # build every package, dependency order
bun run typecheck    # typecheck every package
bun run test         # every package's suite
bun run smoke        # keyless first-run canary: boot + health + models
bun run ownware <verb>  # run the ownware CLI from the repo (init / serve / key / channel …)
bun run check:licenses    # license consistency guard
bun run check:codeowners  # CODEOWNERS security-review guard
```

> A few hundred tests are **live-provider / network lanes** and are *skipped* (not failed)
> unless the relevant key is set — e.g. `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`. Seeing
> `↓ skipped` for those on a plain `bun run test` is expected; set the keys to exercise them.

Per-package lanes (run inside a package): `test:unit`, `test:integration`
(cortex), `test:e2e`, `test:security` (loom). E2E/LLM lanes are
env-gated — they self-skip without a provider key.

## The layout (and the one rule)

```
packages/loom      the ENGINE — the agent loop; no opinions, no cortex imports
packages/cortex    the KERNEL + GATEWAY — profiles, vault, schedules, security boundary
packages/client    the SDK — zero-dep client over the wire contract
packages/ownware      the umbrella — one import for the quickstart surface
adapters/shuttle   messaging channels — thin CLIENTS of the gateway, not plugins
profiles/          bundled agent profiles
```

**The one-way rule:** `client → cortex → loom`, never backwards. If your
change pulls an import the wrong way across a layer, the code probably
belongs in a different package — open an issue and ask rather than
forcing it.

## Hard rules (PRs that break these will be declined)

1. **No secret ever lands in plaintext** — not in logs, events, tool
   results, or the DB. The credential vault stores ciphertext; the
   engine sees opaque handles only.
2. **Tests never touch the real `~/.ownware/`.** Always pass both
   `profilesDir` AND `dataDir` (temp dirs) to `OwnwareGateway` in tests,
   or use `createTestGateway()`.
3. **Security primitives stay core and free** — zones, combination
   rules, the vault, audit are never gated.
4. **Wire-contract types change additively only** (gateway events,
   `uiDescriptor`, `@ownware/client` types) — or the change is reviewed
   across all consumers first.
5. **Security-owned paths are restricted review surfaces.** Files listed
   in [`.github/CODEOWNERS`](.github/CODEOWNERS) (vault, zones, auth,
   bind safety, lockfiles, CI) require the security owner's review —
   don't sweep them into unrelated refactors or opportunistic cleanup.

## Submitting a PR

- **One topic per PR.** Don't mix a bug fix with a refactor with a
  feature. Refactor-only PRs are not accepted unless a maintainer asked
  for the refactor as part of concrete work.
- **Commits:** Conventional Commits — `fix(gateway): …`,
  `feat(channels): …`, `docs: …`. Scopes: `engine`, `kernel`, `gateway`,
  `cli`, `client`, `channels`, `profiles`, `schedules`, `docs`.
- **The PR body is the durable record.** Fill in the template's four
  sections (*What Problem This Solves / Why This Change Was Made / User
  Impact / Evidence*) and keep them current — when a reviewer asks for
  more, edit the description rather than piling on comments.
- Before requesting review:
  1. `bun run build && bun run typecheck && bun run test` passes.
  2. New behavior comes with tests; a new file gets a test file.
  3. Drive the real flow once (e.g. `bun run ownware serve` + the printed
     curl) — green units alone don't prove the customer path.
  4. Update the relevant `README.md`/docs if behavior changed.
- Keep fork PRs takeover-ready: leave **"Allow edits by maintainers"**
  enabled so urgent fixes can land without a round-trip.

## AI-assisted contributions

AI-written PRs are first-class here — Ownware is an agent platform; we'd be
hypocrites otherwise. We just want transparency:

- **Say so** in the PR description (tool + rough level of assistance).
- **Understand your diff.** You must be able to explain every changed
  line; "the model wrote it" is not an answer in review.
- **Own your review threads.** If a bot or reviewer comments and your
  agent addresses it, resolve/reply yourself — don't leave threads for
  maintainers to clean up.
- Session logs/prompts are welcome in the Evidence section — they speed
  up review.

The same transparency bar applies in reverse to security reports — see
[SECURITY.md](SECURITY.md): scanner output without your own verified
understanding will be deprioritized.

## Reporting bugs & proposing features

- **Bugs** → [issue form](https://github.com/ownware-ai/ownware/issues/new/choose)
  with reproduction steps.
- **Features** → the feature form asks *where it lives* first (profile /
  adapter / connector / core — see the placement gate above).
- **Questions & ideas** → GitHub Discussions, not the issue tracker.
- **Security vulnerabilities** → **never** a public issue; see
  [SECURITY.md](SECURITY.md).

## Conduct & license

Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md). By contributing, you agree that
your contributions are licensed under the
[Apache License 2.0](LICENSE) — no CLA, no paperwork.
