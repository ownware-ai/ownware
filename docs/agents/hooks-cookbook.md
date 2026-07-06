---
title: Hooks cookbook — day-to-day recipes
description: Copy-paste hook recipes for everyday jobs — approve refunds from your phone, get pinged when a job finishes, keep an audit file, meter model spend per client, page yourself on failures.
type: how-to
---

# Hooks cookbook — day-to-day recipes

Every recipe below is a complete `hooks` block you can paste into `agent.json` today. Each answers one everyday job: *"I want my agent to ___."* The concepts behind them are in the [hooks guide](hooks.md); the exact field reference is in [profile format](profile-format.md#hooks).

**For AI agents:** these are all declarative `agent.json` `hooks` configs. Buckets: `onStart`, `onToolCall`, `onToolEnd`, `onModelCall`, `onModelEnd`, `onComplete`, `onError`. Actions: `log`, `webhook`, `save_json`, `approve` (onToolCall only), `command` (needs `OWNWARE_ALLOW_COMMAND_HOOKS=1`). Pick the recipe matching the user's goal and merge it into their profile's `hooks` key.

## Running a business on your agent

### "Ask me before it spends money or contacts anyone"

The agent drafts freely, but anything that *sends or spends* pauses until you reply **yes** or **no** — from the web UI, or right in the chat channel (Telegram/Slack/WhatsApp) if the agent runs on one.

```json
"hooks": {
  "onToolCall": [
    { "action": "approve", "tools": ["send_*", "*_post", "*refund*", "*payment*", "shell_execute"] }
  ]
}
```

What happens: the run pauses, you get *"Approval needed: the agent wants to run send_refund…"*, your "yes" resumes it, your "no" makes the agent explain and work around it. Nobody answers in 30 minutes → denied automatically.

### "Tell my phone when it finishes"

Point `onComplete` at any push-notification webhook (your Slack incoming webhook, an [ntfy](https://ntfy.sh) topic, your own endpoint):

```json
"hooks": {
  "onComplete": [{ "action": "webhook", "url": "https://ntfy.sh/my-agent-done" }]
}
```

What happens: one POST per finished run — **including aborted and failed runs**, with `context.reason` saying which (`end_turn`, `aborted`, `error`, …). Your endpoint decides what's worth buzzing about.

### "Keep a diary of everything it did today"

```json
"hooks": {
  "onToolCall": [{ "action": "save_json", "path": "runs/actions.jsonl" }],
  "onComplete": [{ "action": "save_json", "path": "runs/runs.jsonl" }]
}
```

What happens: two append-only JSONL files inside the profile folder — one line per tool call, one line per finished run. `grep`, `jq`, or open in anything. Great answer to "what did the agent actually do while I was out?"

### "Start locked down, loosen as I trust it"

Day one — everything pauses:

```json
"hooks": { "onToolCall": [{ "action": "approve" }] }
```

A week later — only the risky stuff pauses:

```json
"hooks": { "onToolCall": [{ "action": "approve", "tools": ["send_*", "shell_execute", "writeFile"] }] }
```

What happens: `approve` with no `tools` list pauses **every** tool call; adding globs narrows it. This is the practical trust ladder — you never have to choose between "fully autonomous" and "useless."

## Keeping evidence — compliance, clients, audits

### "Log every action to our compliance system"

```json
"hooks": {
  "onToolCall": [{ "action": "webhook", "url": "https://siem.example.com/ingest" }],
  "onComplete": [{ "action": "webhook", "url": "https://siem.example.com/ingest" }],
  "onError":    [{ "action": "webhook", "url": "https://siem.example.com/ingest" }]
}
```

What happens: every tool call, every terminal state, every failure — one POST each, `{ v, ts, profile, event, context }`. Credential values are scrubbed before the body leaves the process. Failed and aborted runs are included by design: an audit trail that skips them isn't one.

Operator hardening: pin egress with `OWNWARE_HOOK_WEBHOOK_ALLOWLIST=https://siem.example.com/` so no profile on this gateway can POST anywhere else.

### "A per-client audit file I can hand over"

Give each client their own profile, and each profile writes its own file:

```json
"hooks": {
  "onToolCall": [{ "action": "save_json", "path": "audit/2026.jsonl" }],
  "onComplete": [{ "action": "save_json", "path": "audit/2026.jsonl" }]
}
```

What happens: the file lives inside that client's profile directory — self-contained, portable, hand-overable. Paths are confined to the profile folder, so profiles can't write into each other.

## Watching cost and usage

### "Meter every model call — I bill clients per use"

`onModelEnd` fires after **each model call** with tokens, cost, stop reason, and how many tools the model requested:

```json
"hooks": {
  "onModelEnd": [{ "action": "webhook", "url": "https://billing.example.com/meter" }]
}
```

What happens: your metering endpoint receives `context: { model, turnIndex, stopReason, inputTokens, outputTokens, costUsd, toolCallCount }` per call. Sum `costUsd` per profile per month → invoice. This is the agency recipe: one gateway, one profile per client, one meter.

### "Show me what each call costs while I'm developing"

```json
"hooks": {
  "onModelEnd": [{ "action": "log" }]
}
```

What happens: one line per call in the gateway log — `model.post model=… stop=tool_use in=1204 out=87 cost=$0.0031 tools=1`. Watch a conversation's cost build in real time.

> A hard **ceiling** is not a hook job — set `"execution": { "maxCostUsd": 5.0 }` and the engine stops the run at the cap.

## When things go wrong

### "Page me on failures, quietly log the rest"

```json
"hooks": {
  "onError":    [{ "action": "webhook", "url": "https://events.pagerduty.com/…" }],
  "onComplete": [{ "action": "log" }]
}
```

What happens: unrecoverable failures POST to your pager with the provider's real error code + message; normal completions just get a log line. Pair with a [schedule](../gateway/overview.md) and your 6am agent can't fail silently.

### "Keep raw run archives so I can debug later"

```json
"hooks": {
  "onComplete": [{ "action": "save_json", "path": "debug/runs.jsonl" }],
  "onError":    [{ "action": "save_json", "path": "debug/errors.jsonl" }]
}
```

## Fresh context and custom logic

### "Run my own check before risky tools"

Your script decides — exit `0` allows, anything else blocks (with your stderr as the reason the model reads):

```json
"hooks": {
  "onToolCall": [{ "action": "command", "command": "./hooks/policy-check.sh" }]
}
```

```bash title="profiles/my-agent/hooks/policy-check.sh"
#!/usr/bin/env bash
ctx=$(cat)   # the event context, as JSON on stdin
tool=$(echo "$ctx" | jq -r .toolName)
if [ "$tool" = "send_email" ] && [ "$(date +%H)" -lt 9 ]; then
  echo "No outbound email before 9am." >&2
  exit 1
fi
exit 0
```

What happens: the standard shell-hook contract (same as git hooks). **Requires the operator to set `OWNWARE_ALLOW_COMMAND_HOOKS=1`** — a downloaded profile can never run shell on your machine by default.

### "Give the model fresh data before every call"

A `command` hook on `onModelCall` can inject context the model sees on that very request:

```json
"hooks": {
  "onModelCall": [{ "action": "command", "command": "./hooks/inject-inventory.sh" }]
}
```

```bash title="profiles/shop/hooks/inject-inventory.sh"
#!/usr/bin/env bash
stock=$(curl -s https://api.example.com/stock/count)
echo "{\"additionalContext\": \"Live inventory right now: ${stock} units.\"}"
```

What happens: the script's `additionalContext` is injected into the model's next request as a system reminder — live prices, stock counts, on-call rosters, anything. (Embedding the engine in code? An in-process `fn` hook does this without the shell opt-in — see [engine hooks](../engine/hooks.md).)

## Developing and debugging your agent

### "Show me every hook moment while I build"

```json
"hooks": {
  "onStart":    [{ "action": "log" }],
  "onToolCall": [{ "action": "log" }],
  "onToolEnd":  [{ "action": "log" }],
  "onModelEnd": [{ "action": "log" }],
  "onComplete": [{ "action": "log" }],
  "onError":    [{ "action": "log", "level": "error" }]
}
```

### "Inspect the exact webhook payloads locally"

`http://` is allowed for localhost, so point a hook at a local sink while developing:

```json
"hooks": { "onToolCall": [{ "action": "webhook", "url": "http://127.0.0.1:9999/hook" }] }
```

```bash
# a one-line sink
npx http-echo-server 9999   # or: python3 -m http.server, nc -l 9999, …
```

## When a hook is NOT the answer

| You want… | Use instead |
|---|---|
| A hard spend ceiling | `"execution": { "maxCostUsd": … }` — the engine stops the run |
| A tool to not exist at all | `"tools": { "deny": ["shell_execute"] }` |
| Rules about a tool's *inputs* (allowed commands, path prefixes) | [`policies` input guards](profile-format.md#policies--input-guards) |
| A security floor the model can't talk past | [zones + permissions](../security/overview.md) |
| Something to happen at 6am, not at a lifecycle moment | [schedules](../gateway/overview.md) |
| The agent to *remember* things | [memory](profile-format.md#agentjson--memory) |

Hooks are the agent's nervous system — observation, notification, approval, steering. Containment lives in the security layers.

## Next steps

- [Hooks guide](hooks.md) — how the moments, actions, and trust model work.
- [Profile format — hooks reference](profile-format.md#hooks) — every field.
- [Channels](../channels/overview.md) — where chat-reply approvals land.
