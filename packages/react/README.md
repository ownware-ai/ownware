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

## ChatGPT connection

Use the standalone owner-side connection surface anywhere account setup belongs
in your product. It uses the typed `@ownware/client` methods and does not couple
subscription management to a chat session.

```tsx
import { OwnwareClient } from '@ownware/client'
import { ChatGPTConnection } from '@ownware/react'

const client = new OwnwareClient({
  baseUrl: 'http://127.0.0.1:4000',
  token: window.OWNWARE_GATEWAY_TOKEN,
})

export function ModelAccess() {
  return <ChatGPTConnection client={client} theme="light" />
}
```

The component supports browser and device-code login, cancellation, logout,
redacted status and exact managed-account model discovery. It presents the
Codex-managed and direct ChatGPT routes separately and never silently switches
between them. The managed route is experimental because the upstream app-server
interface is not supported for production; the direct route remains visibly
disabled until its separate acceptance work is complete.

See the [Ownware repository](https://github.com/ownware-ai/ownware) for the
gateway, client SDK, examples, and Apache-2.0 license.
