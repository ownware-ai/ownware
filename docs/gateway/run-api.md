---
title: The run API
description: Drive your agent from any language — start a run, stream its events, answer permission prompts.
type: reference
---

# The run API

Everything an Ownware client does uses four HTTP calls. This page documents them exactly as the reference client [`examples/custom-client/chat.mjs`](../../examples/custom-client/chat.mjs) uses them — plain `fetch`, no SDK. The examples use port **3011** (the `ownware serve` default); the `serve.mjs` demo in `examples/custom-client` overrides to 4000, so swap the port to match whatever your gateway printed at boot.

All requests carry:

```
Content-Type: application/json
Authorization: Bearer <token>       # ONLY when auth is on (any non-loopback bind).
                                     # On the localhost default, auth is off and this
                                     # header is ignored. Token = ownware.token / <dataDir>/gateway-token.
```

## Start a run — `POST /api/v1/run`

```bash
curl -X POST http://localhost:3011/api/v1/run \
  -H "Content-Type: application/json" \
  -d '{"profileId":"assistant","prompt":"hello"}'
```

| Body field | Required | Meaning |
|---|---|---|
| `profileId` | yes | Which profile answers (the `name` in its `agent.json`) |
| `prompt` | yes | The user message |
| `model` | no | Explicit model for this run (`provider:model` string) |
| `threadId` | no | Continue an existing conversation; omit to start a new thread |

The gateway resolves the configured model in this order: request `model` → the
existing thread's saved model → the install default (when configured) → the
profile default. Blank values do not hide the next choice. Request, thread, and
install choices are explicit: if one is unavailable or belongs to a different
runtime, the request fails before a new thread or run is created.

Only an unavailable profile default on the same execution runtime may be
replaced automatically by the keyless fallback. A winner owned by another
runtime always fails instead of crossing that boundary. The response's `model`
is always the model actually dispatched. When that differs from the configured
profile default, the response also contains:

```json
{
  "model": "ollama:llama3.2",
  "modelSubstitution": {
    "configuredModel": "openai:gpt-5.5",
    "effectiveModel": "ollama:llama3.2",
    "configuredSource": "profile",
    "reason": "profile_default_unavailable"
  }
}
```

This receipt proves the gateway's dispatch choice, not provider acceptance or
run completion. Retrying the exact request with the same `Idempotency-Key`
replays the same receipt. Reuse `threadId` on the next call to keep one
conversation.

## Stream the run — `GET /api/v1/threads/{threadId}/agents/root/events`

```
GET /api/v1/threads/{threadId}/agents/root/events?since=<seq>
Accept: text/event-stream
```

Server-sent events; each frame's `data:` line is one JSON event. Every event carries a `seq` number — remember the highest you've seen and pass it as `?since=` when you reconnect, so the stream resumes instead of replaying history.

The events are the engine's public vocabulary. The ones every client handles:

| `type` | Meaning | Useful fields |
|---|---|---|
| `text.delta` | Streamed assistant text | `text` |
| `tool.call.start` / `tool.call.end` | Tool call lifecycle | `toolName` |
| `permission.request` | Run paused, awaiting approval | `toolName` — answer via resume (below) |
| `turn.end` | One model call finished | `usage.costUsd` |
| `error` | Something failed | `code`, `message` |
| `session.end` | The run is finished — stop reading | |

The full vocabulary (thinking deltas, sub-agent spawns, compaction, security blocks, cache status…) is documented in [`@ownware/loom`](../../packages/loom)'s "Streaming events" section.

Alongside the engine events, the gateway wraps the stream in a few **envelope frames** — `event:` names your client should recognize and otherwise ignore:

| Envelope `event:` | Meaning |
|---|---|
| `stream.start` | The SSE connection is open and replay (if any) is beginning. |
| `stream.replay.complete` | Back-buffered events are done; you're now live. |
| `stream.shutdown` | The gateway is going away — carries `reason` and `retryAfterMs`; reconnect after that delay (passing your highest `seq` as `?since=`). |
| `done` | This SSE response is closing normally. |

Rule of thumb: **treat any unknown `event:` type as a no-op, and reconnect on `stream.shutdown`.**

## Answer a permission prompt — `POST /api/v1/threads/{threadId}/resume`

When you receive `permission.request`, the run is paused until you reply:

```bash
curl -X POST http://localhost:3011/api/v1/threads/$TID/resume \
  -H "Content-Type: application/json" \
  -d '{"action":"approve"}'        # or "deny"
```

## List usable models — `GET /api/v1/provider-hub/models?scope=connected`

Returns the canonical Provider Hub page. Each `items[]` row contains a `model`; prefer one with `model.availability.recommended`, then fall back to the first connected model. The same authority supplies model facts, applicable prices, API-key/custom/local/already-observed-Codex connection state and verification. Listing models does not start the optional Codex runtime. The deprecated `GET /api/v1/models` array remains only as a compatibility projection of this data.

## A complete client

[`examples/custom-client/chat.mjs`](../../examples/custom-client/chat.mjs) (~100 lines) is the reference client: start run → tail SSE → approve permissions → keep one thread. It uses nothing beyond this page, which means any language with HTTP + SSE can do the same.

## Next steps

- [Gateway overview](overview.md) — auth, TLS, where data lives.
- [Channels](../channels/overview.md) — ready-made clients for Telegram, Slack, and more.
