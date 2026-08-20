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

`OwnwareChat` renders durable hydration plus live replies, ordered tool activity,
exact approval and sensitive-input requests, evidence, bounded reversal offers,
connection recovery, errors, and the composer. Use `theme="light"` or override
the namespaced `--ow-*` CSS variables to fit the host application.

Strict-CSP hosts can set `injectStyles={false}` and ship the exported
`ownwareChatCss` string through their normal build-time stylesheet pipeline.

Pass `threadId` to reopen a thread. The component hydrates durable history first,
then tails only an authoritatively correlated active run. It retains drafts and
pending decisions when a mutation fails and does not force-scroll a reader who
has moved away from the latest activity.

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

The hook exposes transcript and connection state, active thread/run identities,
capability support, evidence resources/projections, exact permission and
sensitive-input mutations, cancellation, reversal execution, hydration and
refresh controls. A custom sensitive-input UI must opt in with
`sensitiveInputMode: 'component-local'`, keep the value in its local controlled
field, and call `submitSensitiveInput` directly; never copy the value into shared
application or reducer state.

`OwnwareStudio` remains a small generic profile/conversation shell around the
same chat component. Product-specific workspace panes and routing belong in the
host application.

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
