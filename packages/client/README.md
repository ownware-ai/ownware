# @ownware/client

Talk to your Ownware agent from anywhere. The typed SDK over the gateway
wire contract (HTTP + SSE) — **zero dependencies**, works in Node and
the browser.

The server half is the [`ownware`](../ownware) package (`OwnwareGateway`, or just
`ownware serve`). This is the plug that connects to it.

## Five lines

```ts
import { OwnwareClient } from '@ownware/client'

const ownware = new OwnwareClient({ baseUrl: 'http://localhost:4000', token })
const { threadId } = await ownware.run({ profileId: 'assistant', prompt: 'hello' })
for await (const ev of ownware.streamReply(threadId)) {
  if (ev.type === 'delta') process.stdout.write(ev.text)
}
```

`token` is only needed when gateway auth is on (any non-loopback bind).
Read it from `<dataDir>/gateway-token`, or `gateway.token` in-process.

## The surface

| Method | Wire call | What it does |
|---|---|---|
| `run(input)` | `POST /api/v1/run` | Send a message. Returns `{ threadId, model, … }` immediately — stream the reply separately. |
| `streamReply(threadId, opts?)` | SSE `GET /threads/:id/agents/root/events` | ONE reply as `delta` → `done`/`error` events. Handles the run-termination rules and closes the socket itself. |
| `events(threadId, opts?)` | same SSE | The RAW event stream — tool calls, permission requests, usage, everything. Stays open until you stop reading. |
| `resume(threadId, { action })` | `POST /threads/:id/resume` | Answer a `permission.request` (`approve` / `deny` / …). |
| `abort(threadId)` | `POST /threads/:id/abort` | Stop a running agent. |
| `models()` | `GET /api/v1/models` | The catalog with live availability (`hasCredentials`). |
| `health()` | `GET /api/v1/health` | Liveness (the one unauthenticated route). |

Continue a conversation by passing the same `threadId` to the next
`run`. Reconnect a dropped stream by passing the highest `seq` you saw
as `{ since }` — events replay from there, nothing is lost.

## What it handles for you

- **SSE over `fetch`, not `EventSource`** — bearer auth needs headers;
  `EventSource` can't send them.
- **Run termination** — the root SSE never closes on its own; a reply is
  finished at a terminal `turn.end` (stop reason not `tool_use` /
  `pause_turn`) or on interrupt/error/shutdown. `streamReply` encodes
  that so you never hang on a finished run.
- **Resume cursors** — every event carries `seq`; `{ since }` resumes
  a dropped connection without replaying history.

## The wire contract

The endpoints and event vocabulary this SDK wraps are versioned next to
the code: [`spec/openapi.yaml`](./spec/openapi.yaml) (REST) and
[`spec/asyncapi.yaml`](./spec/asyncapi.yaml) (SSE events). Anything not
in the spec is internal and may change without notice.

Prefer no SDK at all? The contract is small enough to use raw — see
[`examples/custom-client/chat.mjs`](../../examples/custom-client/chat.mjs),
a complete client in ~100 lines of plain `fetch`.
