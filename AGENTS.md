# Ownware — Repository Guidelines (root / whole monorepo)

Guidance for working anywhere in the Ownware repo — for humans and AI tools alike.
This is the **top-level** guide: the whole-platform picture, the cross-cutting rules,
and where the per-package guides live. Each package also has its own `AGENTS.md` with
package-specific detail — read that too when you're inside a package.

> **Guide-file convention:** the canonical file is `AGENTS.md`; every `CLAUDE.md` is
> a symlink to its sibling `AGENTS.md`, so all coding agents (Claude Code, Codex,
> Cursor, Copilot) read the same guidance. **Edit `AGENTS.md` only**; when adding a
> new guide, add the sibling symlink (`ln -s AGENTS.md CLAUDE.md`).
> ⚠️ Not every `AGENTS.md` is a repo guide: files under `profiles/**` and
> `packages/cortex/profiles/**` are **product artifacts** — each agent profile's own
> instructions. Never treat those as coding guides or add symlinks there.
> `bun run check:guides` enforces all of this.

---

## Build WITH Ownware (as a dependency) — the 30-second contract

If you're an agent using Ownware as a library rather than working on this repo:

```ts
import { OwnwareGateway, defineTool } from 'ownware'
const ownware = new OwnwareGateway({ profilesDir: './profiles', port: 4000 })
await ownware.start()   // → ownware.port, ownware.token (Bearer auth)
```

- Minimal profile: `profiles/<id>/agent.json` = `{"name":"<id>"}`; optional `SOUL.md` system prompt.
- Wire contract: `POST /api/v1/run` `{"profileId","prompt","model"?,"threadId"?}` → `{threadId}`;
  SSE `GET /api/v1/threads/{threadId}/agents/root/events?since=<seq>`;
  `POST /api/v1/threads/{threadId}/resume` `{"action":"approve"|"deny"}`;
  `GET /api/v1/models` (filter `hasCredentials`).
- Keyless models: Ollama (`ollama:llama3.2`); cloud: one of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GOOGLE_API_KEY`/`OPENROUTER_API_KEY`.
- Docs index for agents: [`docs/llms.txt`](docs/llms.txt). Runnable reference: [`examples/quickstart/`](examples/quickstart).

Everything below is for working **on** Ownware itself.

---

## What Ownware is

**Ownware is the open, model-agnostic platform for building your own AI agent and putting
it everywhere you already are** — your site, your app, your shop, Slack, Telegram,
WhatsApp, scheduled every morning — self-hosted, on any model, safe by default.
Build the agent once (a text profile) → run it yourself (one process) → reach it
everywhere (one HTTP+SSE contract).

**Public brand is "Ownware" and only Ownware.** "Loom" and "Cortex" are internal package
names — they must never surface in public-facing code, docs, or UI. The umbrella
import is `ownware`; the public gateway class is `OwnwareGateway`.

---

## The layers (and the one rule that keeps them clean)

```
  CLIENTS   web widget · Slack/Telegram/WhatsApp (Shuttle) · your app · mobile · CLI
      │                     one wire contract (HTTP/2 + SSE)
      ▼
  @ownware/cortex   the KERNEL + GATEWAY — profile → running agent, and serves it
      │            (profiles, threads, connectors, credential vault, schedules, security boundary)
      ▼
  @ownware/loom     the ENGINE — the while(true) agent loop; streaming; tools; compaction
                 (no opinions: no default prompt, no baked-in tools, no baked-in safety)
```

**The one-way rule:** `client → cortex → loom`, never backwards. **Loom imports
nothing from Cortex; Cortex imports nothing from a UI client.** If a task pulls you
the wrong way across a layer, that's a signal the code belongs in a different package
— flag it, don't force it.

- **Loom runs agents. Cortex configures them.** (What agent to run = Cortex. How to
  run an agent = Loom.)
- **The security boundary lives in Cortex** — credentials, vault, zones, permissions,
  audit. Loom holds only opaque credential *handles*, never plaintext.

---

## Packages & layout (bun workspaces)

```
ownware/
├── packages/
│   ├── loom/       @ownware/loom   — the agent engine        (has its own CLAUDE.md)
│   ├── cortex/     @ownware/cortex — the kernel + gateway     (has its own CLAUDE.md;
│   │                              gateway/ and tests/framework/ have theirs too)
│   └── ownware/       ownware         — the umbrella package (one import for the quickstart surface)
├── adapters/
│   └── shuttle/    @ownware/shuttle — messaging channel adapters (Slack/Telegram/WhatsApp/Discord/SMS);
│                                   each is a CLIENT of the gateway wire contract, not in-core
├── profiles/       bundled marketplace agent profiles (law, finance, security, …)
├── examples/
│   ├── quickstart/     the runnable quickstart — CLI-driven (`ownware init` → `run` → `serve`); this IS the demo
│   └── custom-client/  drive the gateway from your own app over the raw HTTP+SSE wire (serve.mjs + chat.mjs)
├── scripts/        smoke canary, etc.
└── .catalyst/      the project's docs & work tracking (NOT shipped; see "Where knowledge lives")
```

**Workspace runner is `bun` (≥1.3), not npm/pnpm.** Node ≥ 22. Root commands:

```bash
bun install          # install the workspace
bun run build        # build loom → cortex → ownware → shuttle (in order)
bun run typecheck    # typecheck every package
bun run test         # run every package's suite
bun run smoke        # keyless first-run canary: boot + health + models
```

Per-package test lanes (run inside a package, via bun): `test:unit`, `test:integration`
(cortex), `test:e2e`, `test:security` (loom). E2E/LLM lanes are env-gated (need a
provider key); they self-skip without one.

Data lives in `~/.ownware/` (`OWNWARE_DATA_DIR` to override). `OWNWARE_*` env vars configure
host/port/TLS/auth. Native deps in the tree: `better-sqlite3`, `node-pty`, `sharp`,
`playwright`, `@vscode/ripgrep`.

---

## The guardrails (never break these — they ARE the moat)

1. **Never hold the customer's keys or become the data controller.** Operate compute
   at most; keys + prompt assembly live in the tenant's own runtime. The credential
   vault never stores plaintext; the engine holds only opaque handles. This line is
   the whole business — cross it once and Ownware is just another key-holder.
2. **Never log, leak, or store a secret in plaintext** — not in events, logs, tool
   results, or the DB. (Enforced in Cortex; assume every reviewer checks this.)
3. **Never paywall the security primitives.** Zones, combination rules, the vault,
   audit stay core and free. Security is the trust *closer*, never a paid tier.
4. **Tests must never touch the real `~/.ownware/`.** Always pass both `profilesDir` AND
   `dataDir` (temp dirs) to `OwnwareGateway` in tests, or use `createTestGateway()`.
   Polluting the user's real data dir (keys, profiles, MCP registry) is a bug.
5. **Ownware only, one brand.** Loom/Cortex never leak to public surfaces.
6. **The owner runs all git writes.** Do NOT run `git commit/push/add/stage/etc.`
   yourself — stage the work and let the owner commit. (`git init`-style scaffolding
   was the one exception; every real commit is the owner's.) Standing rule in all of
   tariq's repos.
7. **Keep the four surfaces separate:** messaging adapters (talk-to) ≠ embed adapters
   (integrate-into) ≠ design/dashboard (the face) ≠ developer API. Different things,
   different people.

---

## The lens for ALL work: customer-first, production-level

Everything we build ends up in a **real customer's hands, in production, on their
real business** — not a demo, not "we'll harden it later." Before building anything,
know: **who the customer is, how they use it in production (the messy real flow), and
what breaks *for them* if it's wrong.** "Done" = the real flow works end-to-end (not
just green unit tests), the unhappy path is handled, no secret leaks, nothing pollutes
the user's machine, and it degrades honestly. Full discipline (slice-by-slice boards,
a test plan per slice, `BUGS.md` ledgers) is in
[`.catalyst/work/CONVENTIONS.md`](.catalyst/work/CONVENTIONS.md).

---

## Where knowledge lives (so you read the right thing)

> `.catalyst/` is the owner's **private** planning tree (gitignored) — it is not
> present in public clones. Without it, the per-package guides and `docs/` are the
> complete knowledge base; the `.catalyst/` pointers below are owner-only.

- **How the code works / package rules** → the per-package `AGENTS.md`
  (`packages/loom/AGENTS.md`, `packages/cortex/AGENTS.md`,
  `packages/cortex/src/gateway/AGENTS.md`, the `tests/framework/AGENTS.md`s).
- **How to version, changelog, and publish to npm** → [`RELEASE.md`](RELEASE.md)
  (Changesets, fixed versioning across all 5 packages, ordered `bun publish`; the docs
  website deploys separately via Cloudflare Pages, never npm-versioned).
- **The vision, positioning, plan** → `.catalyst/story/` — start at
  `00-MASTER-PLAN.md`; the sequenced build order + OSS/paid boundary is
  `BUILD-PLAN.md`; the commercial-layer + gap analysis is `COMMERCIAL-LAYER-AND-GAPS.md`.
- **What we're doing now / did** → `.catalyst/work/` (`README.md` = active boards;
  `CONVENTIONS.md` = the work discipline).
- **Studies of other systems** → `.catalyst/learning/`.

> **Rule of thumb:** architecture docs and package `CLAUDE.md` describe *what
> currently is*; `.catalyst/work/` describes *what we're doing/did*; `.catalyst/story/`
> describes *where we're going*. Keep them in their lanes.

---

## PR / change checklist (repo-wide)

- [ ] `bun run build && bun run typecheck && bun run test` passes.
- [ ] Tests added for new behavior; a new file gets a corresponding test file.
- [ ] The real customer flow was actually driven, not just green units (see the lens).
- [ ] No secret can leak; no test touches real `~/.ownware`.
- [ ] Cross-layer imports respect the one-way rule (client → cortex → loom).
- [ ] Wire-contract types (events, `uiDescriptor`, gateway types) changed only
      additively, or the change was reviewed across all consumers.
- [ ] The relevant `AGENTS.md` updated if a module's responsibility changed.
- [ ] User-facing change? Add a changeset (`bun run changeset`) — see [`RELEASE.md`](RELEASE.md).
- [ ] Left the commit to the owner.
