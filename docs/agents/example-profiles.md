---
title: Example profiles
description: The agents Ownware ships with — real profiles you can install, read, and copy as starting points for your own.
type: concept
---

# Example profiles

Ownware bundles a set of ready-made profiles. Some are **core** (built in); the rest are **marketplace** profiles — verified examples you install explicitly. Each is just a folder of text files, so the best way to learn the format is to read one. They ship from two places: the **core** profiles live in [`packages/cortex/profiles/`](../../packages/cortex/profiles), and the **marketplace** profiles in the repo-root [`profiles/`](../../profiles) — so `ls profiles/` shows the marketplace set, not the core ones.

Each card below shows the profile's real `agent.json` settings: its tool preset, security level, and — for the multi-agent ones — the specialist subagents it coordinates.

## Core profiles

`ownware` and `ownware-code` are the two general-purpose lobby agents. The other three are **private helpers** (`kind: helper`) that live inside a parent profile's `helpers/` folder — they're spawned by their parent, not run directly. The **Access** column is the *effective* tool set after the profile's allow/deny list (not just the raw preset):

| Profile | What it does | Effective access | Level |
|---|---|---|---|
| [`ownware`](../../packages/cortex/profiles/ownware) | The default general assistant — reads, writes, searches, remembers | `full` (all built-ins) | standard |
| [`ownware-code`](../../packages/cortex/profiles/ownware-code) | Coding partner — edits files, runs commands, reviews diffs | `full` (all built-ins) | standard |
| [`explore`](../../packages/cortex/profiles/ownware-security/helpers/explore) | Read-only code explorer (helper) — searches and traces without editing | `full` minus writes/shell/spawn (read-only in practice) | standard (zones off) |
| [`planner`](../../packages/cortex/profiles/ownware-code/helpers/planner) | Turns a goal into a step-by-step plan (helper) | `full` minus writes/shell/spawn | standard (zones off) |
| [`verifier`](../../packages/cortex/profiles/ownware-code/helpers/verifier) | Checks that a change did what it claims (helper) | `none` + `readFile, listFiles, glob, grep, shell_execute` (**runs shell**) | standard |

## Marketplace profiles

Installable, domain-specific agents. Each is a complete worked example of the profile format.

### Research — [`ownware-research`](../../profiles/ownware-research)

Read-only research specialist: searches, reads, analyzes, and reports with file-and-line citations. Never modifies anything.

```json title="profiles/ownware-research/agent.json (excerpt)"
{
  "name": "ownware-research",
  "model": "anthropic:claude-sonnet-4-6",
  "smallFastModel": "anthropic:claude-haiku-4-5",
  "tools": { "preset": "readonly", "deny": ["shell_execute"] },
  "security": { "level": "strict", "permissionMode": "ask" }
}
```

The pairing to notice: **`readonly` preset + `strict` security** is how you build an agent that physically cannot change your files, no matter what it's asked. Read [its SOUL.md](../../profiles/ownware-research/SOUL.md) to see how the personality reinforces the same boundary.

### Legal — [`ownware-law`](../../profiles/ownware-law)

A multi-agent legal desk. The lead coordinates four specialist subagents, and ships with reusable skills (`review-contract`, `draft-agreement`, `due-diligence`, `legal-memo`, …).

```json title="profiles/ownware-law/agent.json (excerpt)"
{
  "name": "ownware-law",
  "maxTurns": 100,
  "tools": { "preset": "full" },
  "skills": { "dirs": ["skills/"] },
  "subagents": [
    { "name": "researcher", "description": "Finds case law, statutes, precedent" },
    { "name": "analyst",    "description": "Deep-reads contracts; extracts terms & risks" },
    { "name": "drafter",    "description": "Writes contracts, memos, briefs" },
    { "name": "checker",    "description": "Scans against GDPR/HIPAA/SOC2/CCPA" }
  ]
}
```

This is the shape of a **team profile**: one lead, several named specialists, plus a `skills/` folder of repeatable workflows. See [Multi-agent teams](multi-agent.md) for how the coordination works.

### Finance — [`ownware-finance`](../../profiles/ownware-finance)

Senior finance analyst across banking, equity research, PE, wealth, and corp-fin. Builds DCFs, comps, and LBOs; drafts pitchbooks and IC memos. Six subagents: `filings-explorer`, `valuation-builder`, `earnings-reviewer`, `market-researcher`, `diligence-runner`, `deck-author`. Cites every figure to a primary source and refuses to fabricate numbers or give investment advice — the refusals live in its `SOUL.md`, not in code.

### Security — [`ownware-security`](../../profiles/ownware-security)

Authorized vulnerability-assessment agent with multi-agent orchestration. Uses the `full` preset because it needs to run scanners, coordinated by six subagents: `recon`, `vuln-hunter`, `validator`, `reporter`, `fixer`, `code-reviewer`.

### Marketing — [`ownware-marketing`](../../profiles/ownware-marketing)

Marketing operator across CRO, copy, SEO, paid, lifecycle, and analytics. Five subagents from `audience-researcher` to `asset-author`. Cites audience claims to a source and refuses fabricated testimonials or dark patterns.

### Design — [`ownware-design`](../../profiles/ownware-design)

A designer who codes: produces landing pages, dashboards, decks, and mobile mockups as HTML. Single-agent, `coding` preset — a good example of a focused profile with no subagents.

### Trading — [`ownware-trade-coach`](../../profiles/ownware-trade-coach)

Connects to your live broker, watches your fills, and guards against your worst habits. Runs at `strict` security with `permissionMode: ask` — anything that touches the account pauses for your approval.

## Reading list

The fastest way to internalize the format:

1. Start with `ownware-research` — the smallest complete profile.
2. Then `ownware-law` — see how subagents and skills are added.
3. Compare a `readonly`/`strict` profile against a `full`/`standard` one to feel how the [security levels](profile-format.md#security-levels) change behavior.

## Next steps

- [Profile format](profile-format.md) — every field these profiles use.
- [Multi-agent teams](multi-agent.md) — how the `subagents` array becomes a working team.
- [Tools & connectors](../tools/overview.md) — extend any of these with MCP, Composio, or custom tools.
