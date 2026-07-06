---
title: Profile format
description: The reference for an Ownware profile — the directory, every agent.json field, SOUL.md, memory, skills, custom tools, and helper subagents.
type: reference
---

# Profile format

A profile is a **directory of text files**. Editing the files IS building the agent — no SDK, no build step. This page is the reference for the fields you'll actually use: the directory layout, every everyday `agent.json` field with its default, and the companion files (`SOUL.md`, `AGENTS.md`, `skills/`, `tools/`, `helpers/`). A few UI/product-internal fields (`productId`, `locked`, and the `panes` layout block) are omitted here — they're set by the desktop app, not hand-edited.

```
profiles/my-agent/
├── agent.json          # Required — WHAT the agent can do (validated by ProfileSchema)
├── SOUL.md             # System prompt — WHO it is (identity, rules, persona)
├── AGENTS.md           # Memory — learned preferences, project context
├── skills/             # Skills — markdown how-tos it can invoke
│   └── summarize.md
├── tools/              # Custom tools — TypeScript/JavaScript files
│   └── my-tool.ts
└── helpers/            # Private subagents — nested profiles only this parent can spawn
    └── researcher/
        ├── agent.json
        └── SOUL.md
```

Only `agent.json` is required. Every field in it has a sensible default, so the minimum valid profile is:

```json title="profiles/my-agent/agent.json"
{ "name": "my-agent" }
```

Everything below is optional and defaulted. The schema is validated by `ProfileSchema` in [`@ownware/cortex`](../../packages/cortex/src/profile/schema.ts) — an invalid config fails loudly at load with a clear message.

---

## agent.json — identity

| Field | Type / values | Default | Meaning |
|---|---|---|---|
| `name` | string | **required** | Stable slug — used for registry lookup, thread binding, and subagent references. Don't rename it (orphans threads/forks); use `displayName` for display. |
| `displayName` | string | prettified `name` | Human-facing name shown in the UI. |
| `description` | string | — | One line shown in profile listings. |
| `version` | string | `"0.1.0"` | Profile version. |
| `tags` | string[] | `[]` | Free-form labels for search/filtering. |
| `kind` | `agent` \| `helper` \| `both` | `agent` | `agent` shows in the lobby and runs directly; `helper` is hidden and only invokable as a subagent; `both` does both. |
| `metadata` | object | `{}` | How the profile looks in the UI — see [Metadata](#agentjson--metadata). |

---

## agent.json — model

| Field | Type / values | Default | Meaning |
|---|---|---|---|
| `model` | `provider:model` string | `"anthropic:claude-sonnet-4-6"` | The main model. Any provider — `"openai:gpt-4o"`, `"google:gemini-2.5-flash"`, `"ollama:llama3.2"` (local, free). See [Models](../models/overview.md). |
| `smallFastModel` | `provider:model` string | — | Optional cheap model for side-tasks (thread titles, classification). A common pairing is Sonnet main + `"anthropic:claude-haiku-4-5"` here. |
| `temperature` | number 0–2 | provider default | Sampling temperature. |
| `maxTokens` | number | `16384` | Max output tokens per turn. |
| `maxTurns` | number | `100` | Max model calls in one run before it stops. |
| `thinking` | `{ enabled, budgetTokens }` | `{ enabled: false, budgetTokens: 10000 }` | Anthropic extended reasoning. `budgetTokens` ≥ 1024 and < `maxTokens`. Ignored by non-Anthropic providers. |
| `cache` | `{ ttl: "5m" \| "1h" }` | `{ ttl: "5m" }` | Prompt-cache TTL tier (Anthropic). `"1h"` survives long interactive pauses. |

---

## agent.json — tools

Controls **which tools exist**. Filtering, connectors, and custom tools all live under `tools`.

```json
"tools": {
  "preset": "full",
  "deny": ["shell_execute"],
  "allow": [],
  "custom": [{ "path": "tools/my-tool.ts" }],
  "mcp": {
    "github": { "transport": "stdio", "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-github"] }
  },
  "composio": { "toolkits": ["gmail", "slack"] }
}
```

| Field | Type / values | Default | Meaning |
|---|---|---|---|
| `preset` | `full` \| `coding` \| `readonly` \| `none` | `full` | The built-in tool set (below). |
| `allow` | glob[] | `[]` | Whitelist filter on top of the preset. |
| `deny` | glob[] | `[]` | Blacklist filter. **Deny always wins** over allow. |
| `custom` | `{ path, functions? }[]` | `[]` | Custom tool files — see [Custom tools](#custom-tools). |
| `mcp` | record of `{ transport, command?, args?, url?, env?, headers? }` | `{}` | MCP servers, keyed by name. `transport` is `stdio` \| `sse` \| `streamable_http` \| `websocket`. |
| `composio` | `{ toolkits: string[] }` | `{ toolkits: [] }` | Composio toolkit slugs (needs `COMPOSIO_API_KEY`). Unknown slugs surface a clear stub, not a silent drop. |

### Tool presets

| Preset | Tools included |
|---|---|
| `full` | **All** built-ins — filesystem, shell, web (search + fetch), browser, memory, sub-agent spawn, ask-user, tasks, media. |
| `coding` | Filesystem **+ shell** (readFile, writeFile, editFile, glob, grep, listFiles, **shell_execute**). |
| `readonly` | Read-only filesystem only (readFile, listFiles, glob, grep). |
| `none` | No built-in tools. |

> **`coding` includes `shell_execute`** — it is not filesystem-only. If you want files without a shell, use `readonly` (reads only) or `full` with `"deny": ["shell_execute"]`.

Connecting MCP, Composio, and custom tools is covered end-to-end in [Tools & connectors](../tools/overview.md).

### policies — input guards

`policies` is a separate top-level array that governs **which inputs a tool accepts** once it exists (distinct from `tools.deny`, which governs whether it exists at all). Today the one guard kind is `shell`:

```json
"policies": [
  {
    "kind": "shell",
    "tool": "shell_execute",
    "allowPrefixes": ["ls", "git status", "git diff"],
    "denyPatterns": ["^rm ", "^sudo "],
    "allowDangerous": false,
    "allowInjection": false
  }
]
```

The engine's shell-security floors (Level 1 irreversible, Level 4 exfiltration, Level 5 PII) are **always** enforced — a policy cannot opt out of them. See [Security overview](../security/overview.md).

---

## agent.json — system prompt

| Field | Type | Default | Meaning |
|---|---|---|---|
| `systemPrompt` | string | loaded from `SOUL.md` | Inline system prompt. Usually you write [`SOUL.md`](#soulmd) instead. |
| `criticalReminder` | string | — | A short string re-injected as a `<system-reminder>` on **every** user turn. Use sparingly for hard guarantees the model must never forget (e.g. a verifier pinning "end with VERDICT: PASS\|FAIL"). |

---

## agent.json — memory

Persistent memory loaded into context across conversations.

```json
"memory": { "enabled": true, "sources": ["AGENTS.md"], "autoLearn": true, "isolation": "shared" }
```

| Field | Type / values | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turn memory on/off. |
| `sources` | string[] | `["AGENTS.md"]` | Files whose contents persist into context — see [AGENTS.md](#agentsmd--memory). |
| `autoLearn` | boolean | `true` | Whether the agent may append learned facts back to memory. |
| `isolation` | `shared` \| `per_session` \| `per_thread` | `shared` | Scope of the memory store. |

---

## agent.json — skills, context, workspace

```json
"skills":  { "dirs": ["skills/"], "external": [] },
"context": { "git": true, "cwd": true, "datetime": true, "project": true },
"workspace": { "mode": "cwd", "isolation": "shared", "dirs": [] }
```

**`skills`** — where the agent's [skills](#skills) come from. `dirs` are folders inside the profile (default `["skills/"]`); `external` are additional skill sources.

**`context`** — granular system-prompt fragments, each individually toggleable:

| Flag | Adds | Default |
|---|---|---|
| `git` | Current branch + working-tree status | `false` |
| `os` | Platform, arch, Node version | `false` |
| `cwd` | Current working directory | `true` |
| `datetime` | ISO + human date | `true` |
| `project` | Project notes file | `false` |
| `modelInfo` | Model name + capabilities | `false` |
| `contextUsage` | Token-usage stats | `false` |

**`workspace`** — `mode` (`cwd` \| `managed` \| `temp`), `isolation` (`shared` \| `per_profile` \| `per_run`), and extra `dirs` the agent may work in.

---

## agent.json — security

Three layers: which security **level** applies, what **permission mode** does on sensitive actions, and **zone** classification. Full model in [Security overview](../security/overview.md).

```json
"security": {
  "level": "standard",
  "permissionMode": "ask",
  "sandbox": { "enabled": false, "provider": "local" },
  "zones": { "enabled": true, "combinationRules": "none" },
  "hitlTimeoutMs": 1800000
}
```

| Field | Type / values | Default | Meaning |
|---|---|---|---|
| `level` | `permissive` \| `standard` \| `strict` \| `paranoid` | `standard` | The safety rule set. |
| `permissionMode` | `auto` \| `ask` \| `deny` \| `allowlist` | `ask` | What happens on a sensitive action. |
| `sandbox` | `{ enabled, provider }` | `{ enabled: false, provider: "local" }` | Provider ∈ `local` \| `docker` \| `modal` \| `anthropic`. |
| `zones` | see below | `{ enabled: true, … }` | Zone-based classification of every tool call. |
| `hitlTimeoutMs` | number | `1800000` (30 min) | How long a permission prompt waits before auto-deny. |

**Security levels** — `level` picks a preset posture that tunes the zone thresholds, audit/sanitize flags, and output caps (it feeds `createZoneConfig()`; it is *not* a literal per-action approval matrix). From loosest to tightest:

| Level | Posture (intent) |
|---|---|
| `permissive` | Widest auto-allow; minimal prompting. For sandboxes/throwaway workspaces. |
| `standard` (default) | Balanced — everyday actions auto-run, riskier ones ask. |
| `strict` | Tighter thresholds — writes and shell tend to ask. For sensitive data. |
| `paranoid` | Tightest — ask early and often. For regulated/high-stakes work. |

Regardless of level, decisions are `allow` or `ask` (Ownware never auto-writes a `deny` rule), and the shell floors (L1 destructive / L4 exfiltration / L5 PII) always apply — even at `permissive`. For the exact mechanics see the [Security overview](../security/overview.md).

**`zones`** sub-fields: `enabled` (default `true`), `maxAutoZone` / `maxAskZone` (raise/lower the auto-allow and ask thresholds across the 7 zones `safe`→`never`; the 6 addressable ones run `safe`→`machine`, with `never` always blocked), `overrides` (`[{ tool, zone, reason? }]` to pin a tool to a zone), and `combinationRules` (`none` default, or `default-set` to enable the five cross-call exfiltration rules — appropriate for enterprise/legal/health profiles).

---

## agent.json — execution, browser, compaction, checkpoint, hooks

```json
"execution":  { "mode": "foreground", "timeout": "30m", "maxCostUsd": 5.0 },
"compaction": { "strategy": "summarize", "trigger": { "type": "fraction", "threshold": 0.8 } },
"checkpoint": { "store": "file" }
```

| Block | Key fields | Default | Meaning |
|---|---|---|---|
| `execution` | `mode` (`foreground`\|`background`), `timeout` (`"30m"`), `maxCostUsd` | fg / 30m / — | Run mode, wall-clock cap, optional hard cost ceiling. |
| `browser` | `autoLaunch` (`"auto"`\|`true`\|`false`), `headless`, `port`, `userDataDir`, … | `autoLaunch: "auto"` | Managed Chrome lifecycle; `"auto"` launches only if `browser_*` tools are present, so non-browsing profiles pay nothing. |
| `compaction` | `strategy` (`summarize`\|`truncate`\|`sliding_window`\|`hierarchical`), `trigger`, `retain`, `summaryModel` | summarize @ 0.8 | How context is compacted when it fills. |
| `checkpoint` | `store` (`memory`\|`file`\|`postgres`\|`none`), `dir`, `connectionString` | `memory` | Where session state persists. |
| `hooks` | `onStart`, `onToolCall`, `onToolEnd`, `onModelCall`, `onModelEnd`, `onComplete`, `onError` | `[]` each | Lifecycle hooks — see [the reference below](#hooks), the [guide](hooks.md), and the [cookbook](hooks-cookbook.md). |

### hooks

Attach behavior to the agent's lifecycle — audit, notify, archive, pause-for-approval, or run a script. Guide with recipes: [Hooks](hooks.md).

```json
"hooks": {
  "onToolCall": [
    { "action": "webhook", "url": "https://ops.example.com/audit" },
    { "action": "approve", "tools": ["send_*"] }
  ],
  "onComplete": [{ "action": "save_json", "path": "runs/log.jsonl" }],
  "onError":    [{ "action": "log", "level": "error" }]
}
```

**Buckets** (each an array of actions): `onStart` (run begins) · `onToolCall` (before each tool — the only bucket that can block) · `onToolEnd` (after each tool that ran) · `onModelCall` (before each model call; observe/inject only) · `onModelEnd` (after each model response — per-call usage/cost/stop-reason/tool-count, the metering moment) · `onComplete` (every terminal state: end/abort/limits/error, payload carries `reason`) · `onError` (unrecoverable failure).

**Actions:**

| `action` | Fields | Meaning |
|---|---|---|
| `log` | `level` (`info`\|`warn`\|`error`, default `info`) | Secret-safe summary line in the gateway log. |
| `webhook` | `url` (required; https, or http for localhost only) | POST `{ v, ts, profile, event, context }`. Observe-only — failures never block the run. Credential values are scrubbed from the body. |
| `save_json` | `path` (required; relative, confined to the profile dir) | Append one JSON line per event (JSONL). |
| `approve` | `tools` (glob[], optional — omit = every tool call) | **onToolCall only.** Pause the run for a human decision — web UI card, terminal y/n, or a chat-channel reply. Timeout (`security.hitlTimeoutMs`) or no available surface → deny, fail-closed. |
| `command` | `command` (required) | Run a script: context as JSON on stdin, exit 0 allows, non-zero blocks, stdout JSON may return `continue`/`reason`/`additionalContext`. **Requires operator opt-in `OWNWARE_ALLOW_COMMAND_HOOKS=1`** — a downloaded profile must never mean shell execution. |

Validation is loud: a malformed hook (bad URL, escaping path, `approve` outside `onToolCall`, `command` without opt-in) fails the profile at load — a declared hook never silently doesn't fire. Operator env vars: `OWNWARE_DISABLE_HOOKS=1` (kill switch), `OWNWARE_HOOK_WEBHOOK_ALLOWLIST=prefix,prefix` (restrict webhook egress).

---

## agent.json — subagents

The `subagents` array is the **security boundary**: a profile can only spawn what it declares here. Each entry is one of three kinds — an inline spec, a [private helper](#helpers--private-subagents), or a reference to **another registered profile**.

```json
"subagents": [
  { "name": "researcher", "description": "Finds sources, read-only", "model": "anthropic:claude-haiku-4-5",
    "tools": { "preset": "readonly" } },

  { "name": "auditor", "description": "Runs the security review", "profile": "ownware-security" }
]
```

| Field | Type | Meaning |
|---|---|---|
| `name` | string | How the parent refers to this subagent. |
| `description` | string | The lead reads this to decide when to delegate to it. |
| `profile` | string | **Point at another profile by name** — that whole profile runs as the subagent. Resolution: a matching `helpers/<name>/` dir wins first, otherwise the global registry. Referencing an unregistered profile fails loudly at resolve time. |
| `model` | string | Override the subagent's model. |
| `tools` | `{ preset?, allow, deny }` | Restrict the subagent's tools. |
| `systemPrompt` | string | Inline prompt for an inline subagent. |
| `grant` | `{ tools[], skills[] }` | Explicit pass-through from parent to child at spawn time. `tools` must exist in the parent's own set; granted `skills` are inlined into the child's prompt. Fails loudly on unknown names. |
| `avatar` | avatar object | Optional rich identity, same shape as a profile avatar. |

See [Multi-agent teams](multi-agent.md) for the coordination patterns.

---

## agent.json — metadata

Display-only fields (the profile editor writes to these too). Nothing here affects behavior.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `icon` | string | — | Fallback glyph (a character or emoji). |
| `color` | `violet`\|`teal`\|`rose`\|`slate`\|`mix` | `violet` | Fallback accent hue. |
| `category` | string | `"General"` | Grouping label (e.g. "Legal"). |
| `role` | string | — | One-line title under the name. |
| `avatar` | `{ bg, fg, accent, symbol }` | — | Rich avatar: background, symbol color, accent, and raw SVG inner markup drawn on a 64×64 canvas. Overrides icon/color. |
| `starters` | string[] (≤5) | — | Tappable sample prompts for the empty chat state. |
| `requiredSecrets` | `{ variableName, label, hint, usage, required }[]` | `[]` | Env-placed credentials the profile advertises up front so the UI can prompt for them before the first tool call fails. |

---

## SOUL.md

The system prompt, written as plain markdown — identity, rules, tone, hard constraints. The kernel combines it with the enabled `context` fragments (git, os, date…) to build the final prompt. If you set `systemPrompt` inline in `agent.json`, that is used instead.

```md title="profiles/my-agent/SOUL.md"
You are a concise, careful assistant for my project.
Prefer short answers. Never invent file contents — read the file first.
```

---

## AGENTS.md — memory

The agent's memory file. When `memory.sources` includes it (the default), its contents persist into context across conversations — learned preferences, project facts, corrections. With `memory.autoLearn: true`, the agent may append to it.

---

## skills

A **skill** is a reusable markdown how-to the agent can invoke — a repeatable workflow (a contract-review procedure, a commit routine) packaged as a file. Skills live in the folders listed by `skills.dirs` (default `skills/`).

Each skill is a markdown file with a YAML frontmatter header:

```md title="profiles/my-agent/skills/summarize.md"
---
name: summarize
description: Summarize a document into a one-page brief with citations
trigger: /summarize
allowedTools:
  - readFile
  - glob
  - grep
---

# Summarize Workflow

Follow these steps.

## Step 1: Read
Read the entire document before writing anything…
```

| Frontmatter field | Meaning |
|---|---|
| `name` | Unique skill name (defaults to the filename). |
| `description` | What it does (shown to the model so it knows when to use it). |
| `trigger` | A string prefix matched against user input (e.g. `/summarize`). Defaults to `/<name>`. |

> The profile skill loader reads exactly `name` / `description` / `trigger` today; `trigger` is always a literal string. (`allowedTools` and `triggerIsRegex` are not yet honored for profile skills — don't rely on them to sandbox a skill.) If a skill's YAML frontmatter is malformed, that skill is skipped with a `[ownware] Skipping skill …: invalid YAML frontmatter` warning — wrap a `description` containing a colon in single quotes.

Two layouts are supported: a flat `skills/<name>.md`, or a nested `skills/<slug>/SKILL.md` (the nested form can be toggled off with a `.disabled` marker file). When the trigger matches, the skill's full body is injected as the working instructions for that task. To add a skill, drop a new file in `skills/` — no config change needed. A skill can be passed down to a subagent via a subagent `grant.skills` entry, which inlines it into the child's prompt.

---

## Custom tools

A custom tool is your own logic in a TypeScript/JavaScript file inside the profile, referenced from `tools.custom`. Each file exports one or more tools built with `defineTool`:

```ts title="profiles/my-agent/tools/review.ts"
import { defineTool } from 'ownware'

export const codeReview = defineTool({
  name: 'code_review',
  description: 'Run a code review on a file',
  inputSchema: {
    type: 'object',
    properties: { file: { type: 'string', description: 'File to review' } },
    required: ['file'],
  },
  async execute(input) {
    return { content: 'Review complete', isError: false }
  },
})
```

Reference it in `agent.json` — `functions` is optional (omit to load every exported tool):

```json
"tools": { "custom": [{ "path": "tools/review.ts", "functions": ["codeReview"] }] }
```

The `path` must be **relative and stay inside the profile directory** — absolute paths and `..` traversal are rejected (a shared or AI-generated profile is untrusted input). Custom tools get no special trust: every security layer applies to them equally. Restart the gateway after adding one.

---

## helpers — private subagents

A `helpers/<name>/` subdirectory holds a **full nested profile** (its own `agent.json`, `SOUL.md`, `skills/`, custom tools — anything a top-level profile has). These are private to the parent: the global discovery walker never registers them, so only this parent can spawn them.

```
profiles/ownware-law/
├── agent.json          # declares subagents: [{ name: "researcher", … }]
├── SOUL.md
├── skills/
└── helpers/
    ├── researcher/
    │   ├── agent.json  # "kind": "helper"
    │   └── SOUL.md
    ├── analyst/
    ├── drafter/
    └── checker/
```

A helper profile typically sets `"kind": "helper"` (hidden from the lobby, only invokable as a subagent) and often runs a cheaper model:

```json title="profiles/ownware-law/helpers/researcher/agent.json (excerpt)"
{
  "name": "legal-researcher",
  "kind": "helper",
  "description": "Legal research specialist. Read-only, exhaustive. Runs on Haiku for speed.",
  "model": "anthropic:claude-haiku-4-5",
  "tools": { "preset": "full", "deny": ["writeFile"] }
}
```

### How a subagent resolves

When a parent spawns a subagent named in its `subagents[]`, the kernel looks it up in this order:

1. **`helpers/<name>/`** in the parent's own directory — a private helper wins first.
2. Else, if the subagent entry has a **`profile`** field — that name is looked up in the **global registry** (this is how one top-level profile becomes another's subagent).
3. Else — the inline `subagents[]` spec (`model`, `tools`, `systemPrompt`) is used directly.

So any of your profiles can serve as a subagent of another: declare it in the parent's `subagents[]` with `"profile": "<its-name>"`, or nest it under `helpers/` to keep it private. The `subagents[]` declaration is always required — a parent can never spawn something it didn't list.

---

## See also

- [Hooks](hooks.md) — the lifecycle-hook guide: all five actions with recipes, the approval flow, the trust model.
- [Example profiles](example-profiles.md) — the bundled profiles, read as worked examples.
- [Multi-agent teams](multi-agent.md) — coordinating subagents.
- [Tools & connectors](../tools/overview.md) — MCP, Composio, and custom tools in depth.
- [Security overview](../security/overview.md) — levels, zones, and permissions.
- [Models](../models/overview.md) — `provider:model` strings and the keyless path.
