# Ownware Vision

**Most agents you've met are *someone else's*. Ownware lets you build *your own* — for
anything.** The magic of a personal AI agent — living in your channels, texting you
every morning, doing real work — but owned by you: your brand, your model, your
infrastructure, your rules. For your business, or your life.

The whole idea in one motion:

> **Build the agent once** (a text profile) → **run it yourself** (one process)
> → **reach it everywhere** (one HTTP + SSE contract).

An agent for your support desk, one for your shop, one for your own day — same
kit, different text. Most agent projects give you *their* agent; Ownware is the open kit
for building and shipping yours.

Project overview and setup: [`README.md`](README.md)
Contribution guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
Security policy: [`SECURITY.md`](SECURITY.md)

---

## Why Ownware is different

Ownware sits in a middle that nothing else fills:

- **Personal-assistant apps** are *products* — you use *their*
  agent. You can't rebrand it, embed it, or ship it to your own customers.
- **Frameworks** (LangChain, LangGraph, CrewAI) hand you a box of parts — you build the
  loop yourself and own its quality, months from a production agent.
- **Lab SDKs** (Claude Agent SDK, OpenAI Agents SDK) are excellent harnesses — but
  locked to one company's models, and still just libraries: no backend, no UI, no
  deployment story.

Ownware is the platform in the gap: **a real agent runtime — the same class of machine as
Claude Code** (streaming, parallel tool orchestration, sub-agents, pluggable
compaction, MCP), **model-agnostic and yours to self-host**, wrapped in a kernel that
turns a folder of text into a live, reachable agent with tools, memory, schedules, and
a gateway any client can talk to. You don't assemble the loop and own its bugs — you
inherit a good one and point it at any model.

## Where we're heading

Every business — and every person — will run its own agent: built in minutes, embedded
in its own product or life, owned entirely by them. Ownware aims to be the open layer
underneath all of them: the way you ship *your* agent, not rent someone else's.

The agent is a brain, not a chat window. Chat is one of its faces. The same agent
reaches the world through four kinds of surface, kept deliberately separate:

- **Messaging channels** — Slack, Telegram, WhatsApp, Discord: doorways to talk to the
  agent where you already are.
- **Embeds** — the agent installed *inside* a site, app, or shop, handling that
  business's customers as part of the product.
- **The face** — a fully themeable chat UI, so the agent looks like *their* product,
  never like ours.
- **The developer surface** — a small SDK and one wire contract, so anything custom is
  a few lines, not a rewrite.

Adding a new place is a few steps, not a fork — every surface is just another client of
the same contract. That's the point of the architecture, and the bar every change is
measured against.

## The promises

These are load-bearing. They don't change with a pricing page.

1. **Your keys never leave your runtime.** Ownware never holds your provider credentials
   and never becomes your data controller. Self-hosting is not a demo tier — it is the
   product.
2. **The security primitives are core and free.** The credential vault, permission
   zones, combination rules, and audit trail are never paywalled and never weakened by
   default.
3. **Any model, no lock-in.** Hosted providers or local models — switching is
   configuration, not a rewrite.
4. **One contract.** Every surface — bundled or community-built — speaks the same wire
   contract. No privileged internal APIs.

## Current focus

Priority right now:

- Security and safe defaults (safe-by-default networking, honest failure modes)
- First-run smoothness — from install to a live, answering agent in minutes, no API key
  required to start
- Stability and bug fixes across the bundled channels

Next:

- A themeable web chat kit and drop-in widget
- More messaging channels — and an adapter kit so the community can add any channel
  without touching core
- Embed adapters, so a business installs its agent into its own shop or site from that
  platform's store
- A no-code path from "describe the agent" to "it's live"

## Contribution rules

- One PR = one topic. Don't bundle unrelated fixes or features.
- Very large PRs are reviewed only in exceptional circumstances; split them.
- Don't open large batches of tiny PRs at once — each PR has review cost.
- New capability should live at the lightest layer that can express it:
  a profile → a CLI verb → a channel adapter → a connector → engine core
  (last resort). The default answer for integrations is a profile or an
  adapter, not core.

## What we will not merge (for now)

- Anything that requires Ownware — the server or the company — to hold end-user provider
  keys or become the data controller.
- Anything that moves a security primitive behind a paywall, or a convenience wrapper
  that hides a security decision (binding, auth, key handling) from the operator.
- Bundled channel adapters that duplicate an existing channel without a clear capability
  or security gap — ship it as an adapter package first; broadly used ones get promoted.
- Niche integrations in core when a profile or adapter can express them.
- Heavy orchestration frameworks (manager-of-managers, nested planner trees) as a
  default architecture.

This list is a roadmap guardrail, not a law of physics. Strong user demand and strong
technical rationale can change it.

## Security

Ownware treats its in-process security boundary as real: the engine never sees plaintext
credentials — only opaque handles resolved inside the credential vault — and exposed
deployments refuse to boot without auth. Reports that cross that boundary are
first-class vulnerabilities, not heuristic bypasses. The full trust model and reporting
process live in [`SECURITY.md`](SECURITY.md).
