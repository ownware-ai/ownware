# Security Policy

Ownware's promise is **safe by default** — and unlike agent frameworks that treat
in-process controls as advisory heuristics, Ownware treats its security boundary
as *load-bearing*: the engine never sees plaintext credentials, only opaque
handles resolved inside the credential vault; tool calls are classified into
zones with combination rules enforced below the model; and an exposed gateway
refuses to boot without auth + TLS. **A path that lets plaintext cross that
line, or lets a tool escape its zone, is an in-scope vulnerability — not a
heuristic bypass.** Reports that show where the promise breaks are the most
valuable contribution there is.

The full trust model in one page: [docs/security/overview.md](docs/security/overview.md).

## Reporting a vulnerability

**Do NOT open a public issue for security vulnerabilities.**

- **GitHub:** private vulnerability reporting on this repository
  ("Security" tab → "Report a vulnerability") — preferred.
- **Email:** security@ownware.dev

### What to include

- A description and your severity assessment (Critical / High / Medium / Low).
- The affected component, ideally by file path and line range
  (e.g. `packages/cortex/src/gateway/middleware/auth.ts:40-65`).
- **Which guarantee below is broken** — one sentence naming the boundary crossed.
- A reproduction against `main` or the latest release, plus environment
  (`ownware` version, commit SHA, OS, Node version).
- Remediation advice if you have it.

Reports without a reproduction and a demonstrated boundary crossing are
deprioritized. Automated-scanner output is welcome only after you have
verified the finding yourself and can explain it — we prioritize vetted
reports from people who understand the issue.

### Response targets

- **Acknowledgment:** within 48 hours.
- **Initial assessment:** within 5 business days.
- **Fixes:** Critical and High findings are worked immediately and shipped as
  fast as a correct fix allows; Medium/Low land in the next release.
- **Coordinated disclosure:** 90 days from report or when a fix ships,
  whichever comes first. Reporters are credited in release notes unless they
  ask for anonymity. There is currently no paid bug bounty.

## What counts as a vulnerability (in scope, first-class)

Anything that breaks one of Ownware's standing guarantees:

- **A secret reaching plaintext** — an API key, vault content, channel token,
  or gateway token appearing in logs, the event stream, tool results, or the
  database. The engine and tools must only ever hold opaque handles.
- **The bind-safety invariant failing** — a non-loopback bind serving without
  auth + TLS, an insecure flag combination booting anyway, or the
  host-header (DNS-rebind) guard being bypassable on an exposed bind.
- **Zone or combination-rule bypass** — a tool call escaping its zone
  classification, or a multi-step combination executing when the rules say
  it must be blocked or held for approval.
- **Permission-gate bypass** — a gated action executing without the explicit
  approve, including scheduled (headless) runs escaping their safety level
  or a held draft executing before approval.
- **Vault compromise** — credential material readable at rest without the
  master key, or leaking across the vault boundary to the engine, a client,
  or a channel adapter.
- **Auth bypass on the gateway API** — any thread, credential, or admin
  surface reachable without authorization on an exposed deployment, or
  cross-profile data reachable through the API.
- **Fail-closed pairing bypass** — a personal-line channel answering an
  unapproved stranger.

Package-level detail: [`packages/loom/SECURITY.md`](packages/loom/SECURITY.md)
and [`packages/cortex/SECURITY.md`](packages/cortex/SECURITY.md).

## Out of scope (under this policy)

- **Prompt injection that stays inside the granted boundary.** Convincing the
  agent to do something its zones, tools, and permissions already allow is
  the agent doing granted work. Injection is in scope only when chained to a
  crossing above (a secret leaks, a zone is escaped, a gate is bypassed).
- **The operator's own machine and account.** Anyone who can already read the
  data directory, set the process environment, or run code as the operating
  user is inside the trust envelope; findings that require that access first
  are not boundary crossings.
- **Explicit operator overrides.** Deliberately weakened configurations do
  what they say; the invariant is that *unsafe combinations refuse to boot* —
  if you find a combination that boots anyway, that IS in scope.
- **Third-party profiles, tools, and connectors you install.** Review before
  install; they run with the access you grant them.

**Out of scope does not mean not worth reporting.** Hardening ideas,
defense-in-depth improvements, and sharp edges are welcome as regular issues
— they just don't go through the private channel and don't get advisories.

## Supported versions

Pre-1.0: only the latest release line receives security fixes.

## Running Ownware safely

The deployment checklist (binds, TLS, tokens, reverse proxies) lives in
[docs/gateway/exposing.md](docs/gateway/exposing.md), and the safe-by-default
posture — zones, the vault, permission gates, schedule safety levels,
channel pairing — in [docs/security/overview.md](docs/security/overview.md).
The short version: keep the gateway on loopback unless you need exposure
(the gateway forces auth + TLS the moment you leave it); add keys with
`ownware key add` rather than pasting them into configs; and review third-party
profiles before installing them.
