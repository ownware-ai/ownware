/**
 * <OwnwareChat> — the drop-in chat.
 *
 * The whole studio chat, in one tag: header (agent · live dot · model),
 * streaming thread (user rows + assistant replies with a caret), tool cards,
 * the amber approval card, and the composer. Built on useOwnwareAgent();
 * skinned by design-system-v2 tokens (namespaced --ow-*, so it can't clash
 * with the host app — override any of them to white-label).
 *
 *   <div style={{ height: 560 }}>
 *     <OwnwareChat baseUrl="http://localhost:4000" token={t} profileId="lawyer" />
 *   </div>
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { describeToolCall } from '@ownware/ui'
import type { Message, PendingApproval, ToolCall, ToolUIDescriptor } from '@ownware/ui'
import { useOwnwareAgent, type AgentTransport } from '../useOwnwareAgent.js'
import { OW_STYLE_ID, ownwareChatCss } from './styles.js'

export interface OwnwareChatProps {
  readonly profileId: string
  readonly baseUrl?: string
  readonly token?: string
  readonly model?: string
  readonly threadId?: string
  /** Inject a transport (tests / custom). Overrides baseUrl/token. */
  readonly client?: AgentTransport
  /** Name shown in the header. */
  readonly agentName?: string
  /** Empty-state greeting. */
  readonly greeting?: string
  /** Composer placeholder. */
  readonly placeholder?: string
  /** 'dark' (default) | 'light'. */
  readonly theme?: 'dark' | 'light'
  /** Descriptors for custom tools (built-ins are known already). name → descriptor. */
  readonly descriptors?: Readonly<Record<string, ToolUIDescriptor>>
  readonly className?: string
  readonly style?: CSSProperties
}

export function OwnwareChat(props: OwnwareChatProps) {
  const {
    agentName = 'Agent',
    greeting = 'How can I help?',
    placeholder = 'Message the agent…',
    theme = 'dark',
  } = props
  useInjectStyles()

  const agent = useOwnwareAgent({
    profileId: props.profileId,
    baseUrl: props.baseUrl,
    token: props.token,
    model: props.model,
    threadId: props.threadId,
    client: props.client,
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [agent.messages, agent.pendingApproval, agent.streaming])

  return (
    <div
      className={props.className ? `ow-chat ${props.className}` : 'ow-chat'}
      data-ow-theme={theme}
      style={props.style}
    >
      <header className="ow-header">
        <OwnwareMark />
        <span className="ow-header-name">{agentName}</span>
        <div className="ow-header-meta">
          <span className={agent.streaming ? 'ow-live on' : 'ow-live'}>
            <span className="ow-dot" />
            {agent.streaming ? 'Live' : 'Ready'}
          </span>
          {agent.model && <span className="ow-model">{agent.model}</span>}
        </div>
      </header>

      <div className="ow-msgs" ref={scrollRef}>
        {agent.messages.length === 0 && (
          <div className="ow-empty">
            <OwnwareMark />
            <div>{greeting}</div>
          </div>
        )}
        {agent.messages.map((m) => (
          <MessageRow key={m.id} message={m} descriptors={props.descriptors} />
        ))}
        {agent.pendingApproval && (
          <ApprovalCard approval={agent.pendingApproval} onApprove={agent.approve} onDeny={agent.deny} />
        )}
        {agent.status === 'error' && agent.error && <div className="ow-error">⚠ {agent.error}</div>}
      </div>

      <Composer placeholder={placeholder} onSend={agent.send} />
    </div>
  )
}

// ── pieces ─────────────────────────────────────────────────────────────────

function MessageRow({ message, descriptors }: { message: Message; descriptors?: Readonly<Record<string, ToolUIDescriptor>> }) {
  const isUser = message.role === 'user'
  const showBubble = message.text.length > 0 || (message.streaming && !isUser)
  return (
    <div className={`ow-row ${message.role}`}>
      {!isUser && (
        <div className="ow-avatar">
          <OwnwareMark />
        </div>
      )}
      <div className="ow-body">
        {message.toolCalls.length > 0 && (
          <div className="ow-tools">
            {message.toolCalls.map((c) => (
              <ToolCard key={c.id} call={c} descriptor={descriptors?.[c.name]} />
            ))}
          </div>
        )}
        {showBubble && (
          <div className="ow-bubble">
            {message.text}
            {message.streaming && !isUser && <span className="ow-caret" aria-hidden="true" />}
          </div>
        )}
      </div>
    </div>
  )
}

function ToolCard({ call, descriptor }: { call: ToolCall; descriptor?: ToolUIDescriptor }) {
  const r = describeToolCall(call, descriptor)

  // Conversational tools (ask_user, agent_spawn, todo_write…) are a one-liner, not a card.
  if (r.conversational) {
    return (
      <div className="ow-tool-line">
        <span className="ow-tool-verb">{r.verb}</span>
        {r.primary && <span className="ow-tool-arg">{r.primary}</span>}
        <ToolStatus call={call} />
      </div>
    )
  }

  return (
    <div className="ow-tool">
      <div className="ow-tool-head">
        <span className="ow-tool-verb">{r.verb}</span>
        {r.primary && (
          <span className="ow-tool-arg" title={r.primary}>
            {shorten(r.primary)}
          </span>
        )}
        {r.openUrl && (
          <a className="ow-tool-open" href={r.openUrl} target="_blank" rel="noopener noreferrer">
            Open ↗
          </a>
        )}
        <ToolStatus call={call} />
      </div>
      {r.preview && (
        <details>
          <summary>Preview</summary>
          <ToolPreview text={r.preview.text} format={r.preview.format} />
        </details>
      )}
    </div>
  )
}

function ToolStatus({ call }: { call: ToolCall }) {
  return (
    <span className={`ow-tool-status ${call.status}`}>
      {call.status === 'running' && (
        <>
          <span className="ow-spin" />
          running
        </>
      )}
      {call.status === 'done' && <>✓ done{call.durationMs != null ? ` · ${fmtMs(call.durationMs)}` : ''}</>}
      {call.status === 'error' && <>✕ error</>}
    </span>
  )
}

function ToolPreview({ text, format }: { text: string; format: 'code' | 'diff' | 'markdown' | 'plain' | 'image-thumb' }) {
  const body = truncate(text, 4000)
  if (format === 'diff') {
    return (
      <div className="ow-tool-result">
        {body.split('\n').map((ln, i) => (
          <div key={i} className={ln.startsWith('+') ? 'ow-diff-add' : ln.startsWith('-') ? 'ow-diff-del' : undefined}>
            {ln || '​'}
          </div>
        ))}
      </div>
    )
  }
  return <div className="ow-tool-result">{body}</div>
}

function ApprovalCard({
  approval,
  onApprove,
  onDeny,
}: {
  approval: PendingApproval
  onApprove: () => void
  onDeny: () => void
}) {
  return (
    <div className="ow-approval">
      <div className="ow-approval-title">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M8 1.5l5.5 2v4c0 3.2-2.3 5.4-5.5 6.5-3.2-1.1-5.5-3.3-5.5-6.5v-4z" strokeLinejoin="round" />
        </svg>
        Approval needed — {approval.toolName}
      </div>
      <div className="ow-approval-reason">{approval.reason}</div>
      <div className="ow-approval-actions">
        <button className="ow-btn primary" onClick={onApprove}>
          Approve
        </button>
        <button className="ow-btn ghost" onClick={onDeny}>
          Deny
        </button>
      </div>
    </div>
  )
}

function Composer({ placeholder, onSend }: { placeholder: string; onSend: (t: string) => void }) {
  const [value, setValue] = useState('')
  const submit = () => {
    const t = value.trim()
    if (!t) return
    onSend(t)
    setValue('')
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }
  return (
    <div className="ow-composer">
      <textarea
        rows={1}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
      />
      <button className="ow-send" onClick={submit} disabled={value.trim().length === 0} aria-label="Send">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 13V3.5M4.5 7 8 3.5 11.5 7" />
        </svg>
      </button>
    </div>
  )
}

/** The Ownware mark — the O you own, woven from threads. Self-contained
 *  (its clip id is scoped per instance so multiple chats never collide). */
function OwnwareMark() {
  const clip = `owr-${useId().replace(/:/g, '')}`
  return (
    <svg className="ow-mark" viewBox="15 10 160 160" fill="none" aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <path
            d="M25,90 A70,70 0 1 1 165,90 A70,70 0 1 1 25,90 Z M61,90 A34,34 0 1 1 129,90 A34,34 0 1 1 61,90 Z"
            fillRule="evenodd"
            clipRule="evenodd"
          />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`} fill="currentColor">
        <rect x="25" y="20" width="60" height="140" />
        {[32, 46, 60, 74, 88, 102, 116, 130, 144].map((y) => (
          <rect key={y} x="83" y={y} width="90" height="7" />
        ))}
      </g>
    </svg>
  )
}

// ── helpers ──────────────────────────────────────────────────────────────────

function useInjectStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined' || document.getElementById(OW_STYLE_ID)) return
    const el = document.createElement('style')
    el.id = OW_STYLE_ID
    el.textContent = ownwareChatCss
    document.head.appendChild(el)
  }, [])
}

/** Keep the tail of a long path/command so the filename stays visible. */
function shorten(s: string): string {
  return s.length > 52 ? `…${s.slice(-50)}` : s
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
