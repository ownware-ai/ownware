---
title: Security overview
description: Ownware's safe-by-default posture in one page — zones, combination rules, the credential vault, bind safety, permission gates, and unattended-run safety.
type: concept
---

# Security overview

Ownware's promise is **safe by default**: a fresh `ownware serve` cannot leak a
secret, cannot be reached unauthenticated from another machine, and will not
let an agent take a dangerous action silently. Every layer below is core and
free — security is never a paid tier.

**For AI agents:** enforcement lives in `packages/loom/src/security` +
`packages/loom/src/permissions` (zones, rules, HITL), and
`packages/cortex/src/connector/credentials` + `packages/cortex/src/gateway`
(vault, bind safety, auth). The model can never override these — they run
below the model.

## The layers, bottom-up

Security sits *below* the model — an agent cannot talk its way past it:

1. **Tool policy** (`agent.json`) — which tools exist at all: `preset`,
   `allow`, `deny` globs. A tool that isn't handed to the run cannot be
   called, prompted, or jailbroken into existence.
2. **Input guards** — declarative per-tool rules that reject bad inputs
   before execution.
3. **Zones** — every tool call is classified at call time into 7 levels
   (`safe` → `workspace` → `build` → `network` → `external` → `machine` →
   `never`). **Combination rules** catch multi-step attacks a single-call
   check can't see — e.g. *read a secret file, then make a network call* is
   blocked as a pair even when each call alone would pass.
4. **Permission gates (HITL)** — when a zone says "ask", the run pauses and
   emits `permission.request` on the event stream; it resumes only on an
   explicit `approve`/`deny` (`POST /api/v1/threads/:threadId/resume`). The
   approval flow is part of the public wire contract, so every client —
   terminal, widget, Slack — can render it.
5. **Audit** — security decisions are recorded; a blocked call is an event
   (`security.block`), never a silent drop.

## Credentials: the engine never holds a secret

Provider keys and connector credentials live in an **encrypted vault**
(`ownware key add …`, AES-encrypted at rest under `<dataDir>`, master key from
the OS keychain or `OWNWARE_MASTER_KEY`). The engine and tools only ever see
**opaque handles** — plaintext never enters events, logs, tool results, or
the DB. SSE payloads are visible in browser DevTools; that is exactly why
credential values never ride on an event.

**Headless / container installs (be honest about this):** with no desktop
keychain and no `OWNWARE_MASTER_KEY` set, the master key is generated once and
written to a key file under `<dataDir>` (mode `0600`), next to the vault. The
vault is still encrypted, but at-rest protection then reduces to filesystem
permissions — so on a server, set `OWNWARE_MASTER_KEY` from your secrets
manager (or rely on disk encryption) rather than leaving the key on disk.

Channel tokens (Slack bot tokens etc.) live in a separate AES-256-GCM store
(`<dataDir>/channels`, 0600) — the channel runner is a *client* of the
gateway and never touches the model-credential vault.

## Bind safety: no unsafe exposure boots

Loopback is the trusted first-contact default. The moment the bind leaves
loopback, the gateway **forces auth + TLS** — and refuses to boot if you
explicitly try to disable either. There is no unauthenticated LAN bind.
Details and the deploy checklist: [Exposing the gateway](../gateway/exposing.md).

## Unattended runs (schedules)

A scheduled run is headless — nobody is there to click "approve" — so it
runs under a per-schedule **safety level** enforced as tool access at
assembly, not as a prompt:

- `read-only` — only read tools are handed to the run.
- `draft-approval` (default) — write/send actions are **held as drafts**
  for your approval instead of executing.
- `full-access` — every tool; you opted in explicitly.

A held action is never executed until approved; a failed run is recorded as
failed, never a fake success.

## A downloaded profile can't run code by default

Profiles are shareable text, so a profile's `command` hooks (which run shell
commands at lifecycle points) are **off unless you opt in** with
`OWNWARE_ALLOW_COMMAND_HOOKS=1`. Installing someone else's profile therefore
can't execute arbitrary code on your machine; webhook hooks are HTTPS +
allowlist, and `OWNWARE_DISABLE_HOOKS=1` is a global kill switch. See
[Hooks](../agents/hooks.md).

## Channels don't talk to strangers

Personal-line channels default to **fail-closed pairing**: an unknown DM
gets a one-time code (rate-limited), and the agent answers only after
`ownware channel approve` redeems it.

## Reporting

Found a way past any of this? That's the most valuable contribution there
is — see [SECURITY.md](../../SECURITY.md) (private reporting, response
timelines).
