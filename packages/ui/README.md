# `@ownware/ui`

Headless, framework-independent chat state for an Ownware gateway.

It turns the gateway's raw event stream into renderable state: messages,
streaming text, tool calls, approvals, model attribution, and honest error
states. It has no runtime dependencies and does not perform network requests.

## Install

```bash
npm install @ownware/ui @ownware/client
```

## Reduce a live event stream

```ts
import { OwnwareClient } from '@ownware/client'
import { chatReducer, initialChatState } from '@ownware/ui'

const client = new OwnwareClient({
  baseUrl: 'http://127.0.0.1:4000',
  token: process.env.OWNWARE_GATEWAY_TOKEN,
})

const run = await client.run({
  profileId: 'assistant',
  prompt: 'Summarize today’s work.',
})

let state = initialChatState()
for await (const event of client.events(run.runId ?? run.threadId)) {
  state = chatReducer(state, event)
  render(state)
}
```

`chatReducer` is defensive about unknown additive event types. Tool descriptors
control presentation only; unfamiliar tools render generically. Exact permission,
sensitive-input and reversal mutations still go through their run-scoped Gateway
routes.

For an existing thread, call `client.hydrateThread(threadId)` and pass the result
to `hydrateChatState()`. It loads the durable closed transcript, preserves the
ordered `parts` timeline and seeds replay at `lastClosedTurnEndSeq`; only the open
tail is rebuilt from SSE.

## Main exports

- `initialChatState()`
- `chatReducer(state, event)`
- `applyEvents(state, events)`
- `addUserMessage(state, text)`
- `hydrateChatState(state, hydration)`
- `describeToolCall(call, descriptor?)`
- evidence resource constructors and `select*` projections

There is no name-keyed descriptor catalogue. A tool's name is not evidence of
what it does, so a call without an exact `uiDescriptor` from its event renders
generically under its own name — no kind, primary field or open action.

See the [Ownware repository](https://github.com/ownware-ai/ownware) for the
gateway, client SDK, examples, and Apache-2.0 license.
