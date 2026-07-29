# `@ownware/react`

React bindings and ready-made chat surfaces for an Ownware gateway.

## Install

```bash
npm install @ownware/react react
```

React 18 or newer is required.

## Drop-in chat

```tsx
import { OwnwareChat } from '@ownware/react'

export function AgentChat() {
  return (
    <div style={{ height: 560 }}>
      <OwnwareChat
        baseUrl="http://127.0.0.1:4000"
        token={window.OWNWARE_GATEWAY_TOKEN}
        profileId="assistant"
        agentName="Assistant"
      />
    </div>
  )
}
```

`OwnwareChat` renders messages, streaming replies, tool activity, approval
requests, errors, and the composer. Use `theme="light"` or override the
namespaced `--ow-*` CSS variables to fit the host application.

## Headless hook

```tsx
import { useOwnwareAgent } from '@ownware/react'

function CustomChat() {
  const agent = useOwnwareAgent({
    baseUrl: 'http://127.0.0.1:4000',
    profileId: 'assistant',
  })

  return (
    <>
      {agent.messages.map(message => (
        <p key={message.id}>{message.text}</p>
      ))}
      <button onClick={() => agent.send('Hello')}>Send</button>
    </>
  )
}
```

The hook exposes `messages`, `status`, `models`, `send`, `approve`, `deny`,
and `abort`. `OwnwareStudio` adds a profile picker and in-session conversation
sidebar around the same chat component.

See the [Ownware repository](https://github.com/ownware-ai/ownware) for the
gateway, client SDK, examples, and Apache-2.0 license.
