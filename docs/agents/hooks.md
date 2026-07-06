---
title: Hooks — watch, guard, and approve your agent
description: Declare hooks in agent.json to audit every action, get notified, pause risky tool calls for a human decision, or run your own scripts — no code required.
type: how-to
---

# Hooks — watch, guard, and approve your agent

Hooks let a profile attach behavior to the moments of an agent's life — *when it starts, before and after every tool call, when it finishes, when it fails* — declared as plain JSON in `agent.json`. No code, and the hooks travel with the profile.

```json title="profiles/shop/agent.json"
{
  "name": "shop",
  "hooks": {
    "onToolCall": [
      { "action": "webhook", "url": "https://ops.example.com/audit" },
      { "action": "approve", "tools": ["send_*", "shell_execute"] }
    ],
    "onComplete": [{ "action": "save_json", "path": "runs/log.jsonl" }],
    "onError":    [{ "action": "log", "level": "error" }]
  }
}
```

That one block gives this agent: an audit webhook on **every** tool call, a **human approval pause** before anything matching `send_*` or `shell_execute` runs, a JSONL archive of every finished run (including aborted and failed ones), and error lines in the gateway log.

**For AI agents:** hooks live under the `hooks` key of `agent.json`. Buckets: `onStart` | `onToolCall` | `onToolEnd` | `onModelCall` | `onModelEnd` | `onComplete` | `onError`, each an array of `{ action, … }` with action ∈ `log` | `webhook` | `save_json` | `approve` | `command`. `approve` is valid only in `onToolCall` and takes optional `tools: [glob…]`. `webhook` needs `url` (https, or http for localhost only); `save_json` needs a `path` relative to the profile dir; `command` is rejected unless the operator sets `OWNWARE_ALLOW_COMMAND_HOOKS=1`. Malformed hooks fail profile assembly loudly — they never fail silently at runtime. Ready-made configs for common goals: [hooks-cookbook.md](hooks-cookbook.md).

## The five moments

| Bucket | Fires | Can it stop anything? |
|---|---|---|
| `onStart` | once, when a run begins (before the first model call) | no — informational |
| `onToolCall` | **before** each tool executes | **yes** — `approve` (deny) and `command` (exit ≠ 0) block the call |
| `onToolEnd` | after each tool that actually ran | no — the result already exists |
| `onModelCall` | before **each model call** (every attempt, incl. retries) | no — observe/inject only |
| `onModelEnd` | after each successful model response — carries per-call usage, cost, stop reason, tool-call count (the **metering** moment) | no |
| `onComplete` | when the run ends — **every** terminal state: normal end, abort, limits, error (the payload's `reason` says which) | no |
| `onError` | when the run fails unrecoverably (just before `onComplete`) | no |

An audit trail that skips aborted or failed runs is not an audit trail — `onComplete` deliberately fires for all of them.

## The five actions

### `log` — a line in the gateway log

```json
{ "action": "log", "level": "info" }
```

Writes a one-line, secret-safe summary (event, tool name, sizes — never full inputs or results). `level` ∈ `info` | `warn` | `error`.

### `webhook` — POST the event to your endpoint

```json
{ "action": "webhook", "url": "https://ops.example.com/audit" }
```

Sends this JSON body:

```json
{
  "v": 1,
  "ts": 1751234567890,
  "profile": "shop",
  "event": "tool.pre",
  "context": { "event": "tool.pre", "turnIndex": 2, "toolName": "send_email", "toolInput": { "…": "…" } }
}
```

Rules: the URL must be `https` (`http` is allowed only for localhost). Credential values in the vault are scrubbed from the body before it leaves the process. Webhooks are **observe-only by construction** — a slow or down endpoint is logged and the run continues; it can never block or crash the agent.

### `save_json` — append every event to a JSONL file

```json
{ "action": "save_json", "path": "runs/log.jsonl" }
```

Appends one JSON line (same shape as the webhook body) per event. The path must be **relative and stays inside the profile directory** — absolute paths and `../` escapes are rejected when the profile loads.

### `approve` — pause for a human decision

```json
{ "action": "approve", "tools": ["send_*", "shell_execute"] }
```

Only valid in `onToolCall`. When a matching tool call is about to run, **the run pauses** and the decision surfaces everywhere the thread is visible:

- **Web UI** — the standard permission card (approve / deny).
- **Terminal** (`chat.mjs`-style clients) — a `y/n` prompt.
- **Messaging channels** (Telegram, Slack, Discord, …) — the agent's channel sends *"Approval needed: the agent wants to run "send_refund". Reply "yes" to approve or "no" to deny."* — and the person's reply resolves it. A shop owner can approve a refund from their phone mid-conversation.

Behavior you can rely on:

- `tools` is a list of glob patterns (`send_*`); **omit it and every tool call pauses**.
- Nobody answers → the gateway's HITL timeout (`security.hitlTimeoutMs`, default 30 minutes) **denies**.
- Denied → the tool never runs, and the model is told *why* (it works around the denial instead of blindly retrying).
- No approval surface available at all (e.g. `ownware run` in a bare terminal pipeline) → **fail-closed deny** with an honest reason. A declared safety gate is never silently skipped.

### `command` — run your own script (operator opt-in)

```json
{ "action": "command", "command": "./hooks/check.sh" }
```

The standard shell-hook convention: the event context arrives as JSON on stdin; **exit 0 allows, any other exit code blocks** (in `onToolCall`); stdout that parses as JSON can return `{ "continue": false, "reason": "…" }` or `{ "additionalContext": "…" }` (injected into the model's next turn).

**Disabled by default.** A profile is a portable artifact — a downloaded profile must never mean shell execution on your machine. The *operator* (not the profile) opts in with `OWNWARE_ALLOW_COMMAND_HOOKS=1`. Without it, a profile declaring `command` hooks refuses to load, with a message saying exactly that.

## Which way should I do this?

| You want to… | Use |
|---|---|
| Audit / notify / archive / approve, shipped with the agent | **`agent.json` hooks** (this page) — declarative, portable, marketplace-safe |
| A hard security floor the model can never talk past (allowed dirs, zones, ask-before-dangerous) | **[Security: zones + permissions](../security/overview.md)** — hooks are steering and observability, zones are containment |
| Reject bad tool *input* by pattern (e.g. block a path prefix) | **`policies` (tool guards)** in [profile format](profile-format.md) |
| Arbitrary in-process logic while *embedding the engine* in your own app (mutate inputs, custom callbacks) | **engine hooks in code** — see [Engine hooks](../engine/hooks.md) |
| Act on a schedule instead of on lifecycle moments | **[Schedules](../gateway/overview.md)** |

Rule of thumb: if the behavior belongs to *the agent* (wherever it runs), put it in `agent.json`. If it belongs to *your host application*, put it in code at the engine layer. If it's a security guarantee, don't use hooks at all — use zones.

## How the model sees hook outcomes

Hooks don't just act — they teach. A blocking hook's reason, a command hook's output, and any `additionalContext` are injected into the model's next turn as system reminders. When your approve hook denies a refund, the agent reads *"The operator denied send_refund"* and changes course, instead of retrying into a wall.

## Operator controls

| Env var | Effect |
|---|---|
| `OWNWARE_DISABLE_HOOKS=1` | Kill switch — no declared hook runs (a warning is logged so it's never silent) |
| `OWNWARE_ALLOW_COMMAND_HOOKS=1` | Enable `command` actions (default off) |
| `OWNWARE_HOOK_WEBHOOK_ALLOWLIST=https://a/,https://b/` | Restrict webhook URLs to these prefixes — anything else fails at profile load |

These are operator policy, deliberately **outside** the profile: a downloaded profile cannot grant itself shell access or widen its own egress.

## Validation is loud

A malformed hook fails the profile at load time with a precise error — a webhook with a bad URL, an `approve` outside `onToolCall`, a `save_json` path escaping the profile directory, a `command` without opt-in. There is no mode where a declared hook silently doesn't fire; a safety layer that fails silently is worse than none.

## Recipes

```json title="Compliance: log every action to your SIEM, keep a local archive"
"hooks": {
  "onToolCall": [{ "action": "webhook", "url": "https://siem.example.com/ingest" }],
  "onComplete": [{ "action": "save_json", "path": "runs/audit.jsonl" }]
}
```

```json title="Ask me before anything leaves the building"
"hooks": {
  "onToolCall": [{ "action": "approve", "tools": ["send_*", "*_post", "shell_execute"] }]
}
```

```json title="Tell ops when a scheduled run fails"
"hooks": {
  "onError":    [{ "action": "webhook", "url": "https://hooks.pagerduty.example.com/…" }],
  "onComplete": [{ "action": "log" }]
}
```

## Next steps

- [Hooks cookbook](hooks-cookbook.md) — copy-paste recipes for the everyday jobs: approve-from-phone, finish notifications, audit files, per-client metering, failure paging, custom scripts.
- [Engine hooks](../engine/hooks.md) — the same system from code, for embedders (plus the programmatic tool interceptors).
- [Profile format](profile-format.md) — every `agent.json` field.
- [Security overview](../security/overview.md) — zones and permissions, the layers hooks compose with.
- [Channels](../channels/overview.md) — where the chat-reply approval lands.
