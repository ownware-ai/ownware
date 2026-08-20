import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import {
  describeToolCall,
  selectReversal,
  selectToolEffect,
  type CapabilitySupport,
  type Message,
  type PendingApproval,
  type PendingSensitiveInput,
  type ReversalProjection,
  type SkillPlacementProjection,
  type ToolCall,
  type ToolEffectProjection,
  type ToolUIDescriptor,
} from '@ownware/ui'
import {
  useOwnwareAgent,
  type AgentTransport,
  type OwnwareAgent,
  type OwnwareAgentEvidence,
} from '../useOwnwareAgent.js'
import { OW_STYLE_ID, ownwareChatCss } from './styles.js'

export interface OwnwareChatProps {
  readonly profileId: string
  readonly baseUrl?: string
  readonly token?: string
  readonly model?: string
  readonly threadId?: string
  readonly workspaceId?: string
  readonly egressMode?: 'unrestricted' | 'local-only'
  readonly client?: AgentTransport
  readonly agentName?: string
  readonly greeting?: string
  readonly placeholder?: string
  readonly theme?: 'dark' | 'light'
  /** Compatibility presentation for streams without exact event descriptors. */
  readonly descriptors?: Readonly<Record<string, ToolUIDescriptor>>
  /** Disable only when the host ships `ownwareChatCss` through its own CSP-safe stylesheet. */
  readonly injectStyles?: boolean
  readonly className?: string
  readonly style?: CSSProperties
}

export function OwnwareChat(props: OwnwareChatProps) {
  const {
    agentName = 'Agent',
    greeting = 'How can I help?',
    placeholder = 'Message the agent…',
    theme = 'dark',
    injectStyles = true,
  } = props
  useInjectStyles(injectStyles)

  const agent = useOwnwareAgent({
    profileId: props.profileId,
    baseUrl: props.baseUrl,
    token: props.token,
    model: props.model,
    threadId: props.threadId,
    workspaceId: props.workspaceId,
    egressMode: props.egressMode,
    sensitiveInputMode: 'component-local',
    client: props.client,
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  const followTailRef = useRef(true)
  const [newActivity, setNewActivity] = useState(false)
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    if (followTailRef.current) {
      element.scrollTop = element.scrollHeight
      setNewActivity(false)
    } else {
      setNewActivity(true)
    }
  }, [
    agent.messages,
    agent.pendingApprovals,
    agent.pendingSensitiveInputs,
    agent.streaming,
  ])

  const scrollToLatest = () => {
    const element = scrollRef.current
    if (!element) return
    followTailRef.current = true
    element.scrollTop = element.scrollHeight
    setNewActivity(false)
  }

  const connectionLabel = connectionStatement(agent)
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
          <ConnectionStatus agent={agent} />
          {agent.model && <span className="ow-model">{agent.model}</span>}
        </div>
      </header>

      <span className="ow-sr-only" role="status" aria-live="polite">
        {connectionLabel}
      </span>
      <div
        className="ow-msgs"
        ref={scrollRef}
        role="log"
        aria-label={`${agentName} conversation`}
        aria-busy={agent.streaming || agent.hydrating}
        onScroll={(event) => {
          const element = event.currentTarget
          followTailRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
          if (followTailRef.current) setNewActivity(false)
        }}
      >
        {agent.messages.length === 0 && !agent.hydrating && (
          <div className="ow-empty">
            <OwnwareMark />
            <div>{greeting}</div>
          </div>
        )}
        {agent.hydrating && <div className="ow-loading">Loading conversation…</div>}
        {agent.messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            descriptors={props.descriptors}
            runId={agent.activeRunId}
            evidence={agent.evidence}
          />
        ))}

        <RunEvidenceSummary evidence={agent.evidence} runId={agent.activeRunId} />

        {agent.pendingApprovals.map(approval => (
          <PermissionDecision
            key={approval.requestId}
            approval={approval}
            support={agent.support.permissionDecision}
            busy={agent.busyActions.has(`permission:${approval.requestId}`)}
            error={agent.actionErrors[`permission:${approval.requestId}`]}
            onDecision={decision => agent.decidePermission(approval.requestId, decision)}
          />
        ))}

        {agent.pendingSensitiveInputs.map(request => (
          <SensitiveInputRequest
            key={request.requestId}
            request={request}
            submitSupport={agent.support.sensitiveInputSubmit}
            denySupport={agent.support.sensitiveInputDeny}
            busy={agent.busyActions.has(`sensitive:${request.requestId}`)}
            error={agent.actionErrors[`sensitive:${request.requestId}`]}
            onSubmit={value => agent.submitSensitiveInput(request.requestId, value)}
            onDeny={() => agent.denySensitiveInput(request.requestId)}
          />
        ))}

        <ReversalOffers agent={agent} />

        {agent.status === 'error' && agent.error && (
          <div className="ow-error" role="alert">{agent.error}</div>
        )}
      </div>

      {newActivity && (
        <button type="button" className="ow-new-activity" onClick={scrollToLatest}>
          New activity
        </button>
      )}
      <Composer
        placeholder={placeholder}
        busy={agent.sending}
        error={agent.actionErrors['send']}
        onSend={agent.send}
      />
    </div>
  )
}

export function ConnectionStatus({ agent }: { readonly agent: OwnwareAgent }) {
  const label = connectionStatement(agent)
  const active = agent.streaming || agent.connection.phase === 'live'
  return (
    <span className={active ? 'ow-live on' : 'ow-live'} aria-label={label}>
      <span className="ow-dot" aria-hidden="true" />
      {shortConnectionLabel(agent)}
    </span>
  )
}

function MessageRow({
  message,
  descriptors,
  runId,
  evidence,
}: {
  readonly message: Message
  readonly descriptors?: Readonly<Record<string, ToolUIDescriptor>>
  readonly runId?: string
  readonly evidence: OwnwareAgentEvidence
}) {
  const isUser = message.role === 'user'
  const showBubble = message.text.length > 0 || (message.streaming && !isUser)
  const ordered = message.parts !== undefined && message.parts.length > 0
  const toolCard = (call: ToolCall, key: string) => (
    <ToolCard
      key={key}
      call={call}
      descriptor={descriptors?.[call.name]}
      effect={runId ? selectToolEffect({
        capabilities: evidence.capabilities,
        receipts: evidence.effects,
        runId,
        toolCallId: call.id,
        toolLifecycle: call.status,
      }) : undefined}
    />
  )
  return (
    <article className={`ow-row ${message.role}`} aria-label={`${isUser ? 'You' : 'Agent'} message`}>
      {!isUser && (
        <div className="ow-avatar" aria-hidden="true">
          <OwnwareMark />
        </div>
      )}
      <div className="ow-body">
        {ordered ? (
          <>
            {message.parts!.map((part, index) => {
              if (part.kind === 'text') {
                return part.text.length > 0 ? (
                  <div className="ow-bubble" key={`text-${index}`}>
                    {part.text}
                    {message.streaming && index === message.parts!.length - 1 && !isUser && (
                      <span className="ow-caret" aria-hidden="true" />
                    )}
                  </div>
                ) : null
              }
              if (part.kind === 'thinking') {
                return part.text.length > 0 ? (
                  <details className="ow-thinking" key={`thinking-${index}`}>
                    <summary>Reasoning</summary>
                    <div>{part.text}</div>
                  </details>
                ) : null
              }
              if (part.kind === 'tool') {
                const call = message.toolCalls.find(item => item.id === part.toolCallId)
                return call ? (
                  <div className="ow-tools" key={`tool-${part.toolCallId}`}>
                    {toolCard(call, call.id)}
                  </div>
                ) : (
                  <div className="ow-history-gap" key={`tool-${part.toolCallId}`}>
                    Tool activity details are unavailable.
                  </div>
                )
              }
              return (
                <div className="ow-history-gap" key={`${part.kind}-${index}`}>
                  {part.kind === 'subagent'
                    ? 'Sub-agent activity recorded.'
                    : part.kind === 'permission'
                      ? 'Permission activity recorded.'
                      : 'Credential activity recorded.'}
                </div>
              )
            })}
            {!message.parts!.some(part => part.kind === 'text') && message.text.length > 0 && (
              <div className="ow-bubble">{message.text}</div>
            )}
            {message.streaming && !isUser && message.parts![message.parts!.length - 1]?.kind !== 'text' && (
              <div className="ow-bubble"><span className="ow-caret" aria-hidden="true" /></div>
            )}
          </>
        ) : (
          <>
            {message.toolCalls.length > 0 && (
              <div className="ow-tools">{message.toolCalls.map(call => toolCard(call, call.id))}</div>
            )}
            {message.thinking && (
              <details className="ow-thinking">
                <summary>Reasoning</summary>
                <div>{message.thinking}</div>
              </details>
            )}
            {showBubble && (
              <div className="ow-bubble">
                {message.text}
                {message.streaming && !isUser && <span className="ow-caret" aria-hidden="true" />}
              </div>
            )}
          </>
        )}
      </div>
    </article>
  )
}

function ToolCard({
  call,
  descriptor,
  effect,
}: {
  readonly call: ToolCall
  readonly descriptor?: ToolUIDescriptor
  readonly effect?: ToolEffectProjection
}) {
  const rendered = describeToolCall(call, descriptor)
  if (rendered.conversational) {
    return (
      <div className="ow-tool-line">
        <span className="ow-tool-verb">{rendered.verb}</span>
        {rendered.primary && <span className="ow-tool-arg">{rendered.primary}</span>}
        <ToolStatus call={call} />
        {effect && <ToolEvidenceStatus projection={effect} />}
      </div>
    )
  }

  return (
    <div className="ow-tool">
      <div className="ow-tool-head">
        <span className="ow-tool-verb">{rendered.verb}</span>
        {rendered.primary && (
          <span className="ow-tool-arg" title={rendered.primary}>{shorten(rendered.primary)}</span>
        )}
        {rendered.openUrl && (
          <a className="ow-tool-open" href={rendered.openUrl} target="_blank" rel="noopener noreferrer">
            Open <span aria-hidden="true">↗</span>
          </a>
        )}
        <ToolStatus call={call} />
      </div>
      {effect && <ToolEvidenceStatus projection={effect} />}
      {rendered.preview && (
        <details>
          <summary>Preview</summary>
          <ToolPreview text={rendered.preview.text} format={rendered.preview.format} />
        </details>
      )}
    </div>
  )
}

function ToolStatus({ call }: { readonly call: ToolCall }) {
  return (
    <span className={`ow-tool-status ${call.status}`}>
      {call.status === 'running' && (
        <><span className="ow-spin" aria-hidden="true" />tool running</>
      )}
      {call.status === 'done' && (
        <>tool finished{call.durationMs != null ? ` · ${fmtMs(call.durationMs)}` : ''}</>
      )}
      {call.status === 'error' && <>tool failed</>}
    </span>
  )
}

export function ToolEvidenceStatus({ projection }: { readonly projection: ToolEffectProjection }) {
  if (projection.state !== 'ready') return null
  return (
    <div className={`ow-tool-evidence ${projection.effect.state}`}>
      {projection.effect.statement}
    </div>
  )
}

function ToolPreview({
  text,
  format,
}: {
  readonly text: string
  readonly format: 'code' | 'diff' | 'markdown' | 'plain' | 'image-thumb'
}) {
  const body = truncate(text, 4_000)
  if (format === 'diff') {
    return (
      <div className="ow-tool-result">
        {body.split('\n').map((line, index) => (
          <div
            key={index}
            className={line.startsWith('+') ? 'ow-diff-add' : line.startsWith('-') ? 'ow-diff-del' : undefined}
          >
            {line || '​'}
          </div>
        ))}
      </div>
    )
  }
  return <div className="ow-tool-result">{body}</div>
}

export function RunEvidenceSummary({
  evidence,
  runId,
}: {
  readonly evidence: OwnwareAgentEvidence
  readonly runId?: string
}) {
  if (!runId) return null
  const consequence = evidence.consequence
  if (consequence.state !== 'ready') {
    return <div className="ow-evidence unavailable">Run evidence is {readableState(consequence.state)}.</div>
  }
  return (
    <section className="ow-evidence" aria-label="Run evidence">
      <div className="ow-evidence-title">Run evidence</div>
      <p>{consequence.statement}</p>
      {evidence.egress.state === 'ready' && <p>{evidence.egress.observationStatement}</p>}
      <SkillActivationEvidence projection={evidence.skillPlacement} />
    </section>
  )
}

export function SkillActivationEvidence({
  projection,
}: {
  readonly projection: SkillPlacementProjection
}) {
  return projection.state === 'ready' ? <p>{projection.statement}</p> : null
}

export function PermissionDecision({
  approval,
  support,
  busy,
  error,
  onDecision,
}: {
  readonly approval: PendingApproval
  readonly support: CapabilitySupport
  readonly busy: boolean
  readonly error?: string
  readonly onDecision: (decision: 'approve' | 'deny') => Promise<void>
}) {
  const titleId = useId()
  const reasonId = useId()
  const exact = Boolean(approval.operationHash && approval.intentRevision === 1)
  const enabled = exact && support.state === 'supported' && !busy
  return (
    <section
      className="ow-approval"
      aria-labelledby={titleId}
      aria-describedby={reasonId}
      aria-busy={busy}
    >
      <div className="ow-approval-title" id={titleId}>
        <ShieldIcon />
        Approval needed — {approval.toolName}
      </div>
      <div className="ow-approval-reason" id={reasonId}>{approval.reason}</div>
      {!exact && <div className="ow-action-note">This request lacks exact operation authority.</div>}
      {support.state !== 'supported' && (
        <div className="ow-action-note">Exact permission decisions are unavailable.</div>
      )}
      {error && <div className="ow-action-error" role="alert">{error}</div>}
      <div className="ow-approval-actions">
        <button type="button" className="ow-btn primary" disabled={!enabled} onClick={() => void onDecision('approve').catch(() => {})}>
          {busy ? 'Sending…' : 'Approve exact request'}
        </button>
        <button type="button" className="ow-btn ghost" disabled={!enabled} onClick={() => void onDecision('deny').catch(() => {})}>
          Deny
        </button>
      </div>
    </section>
  )
}

export function SensitiveInputRequest({
  request,
  submitSupport,
  denySupport,
  busy,
  error,
  onSubmit,
  onDeny,
}: {
  readonly request: PendingSensitiveInput
  readonly submitSupport: CapabilitySupport
  readonly denySupport: CapabilitySupport
  readonly busy: boolean
  readonly error?: string
  readonly onSubmit: (value: string) => Promise<void>
  readonly onDeny: () => Promise<void>
}) {
  const [value, setValue] = useState('')
  const labelId = useId()
  const usageId = useId()
  const canSubmit = submitSupport.state === 'supported' && value.length > 0 && !busy
  const canDeny = denySupport.state === 'supported' && !busy
  const submit = async () => {
    if (!canSubmit) return
    await onSubmit(value)
    setValue('')
  }
  const deny = async () => {
    if (!canDeny) return
    await onDeny()
    setValue('')
  }
  return (
    <section className="ow-sensitive" aria-labelledby={labelId} aria-describedby={usageId} aria-busy={busy}>
      <div className="ow-approval-title" id={labelId}><ShieldIcon />{request.label}</div>
      <div className="ow-approval-reason" id={usageId}>{request.usage}</div>
      <input
        type="password"
        name={`ownware-sensitive-${request.requestId}`}
        autoComplete="off"
        value={value}
        onChange={event => setValue(event.target.value)}
        disabled={busy || submitSupport.state !== 'supported'}
        aria-label={request.label}
      />
      <div className="ow-action-note">Sent through the dedicated one-use sensitive-input channel.</div>
      {error && <div className="ow-action-error" role="alert">{error}</div>}
      <div className="ow-approval-actions">
        <button type="button" className="ow-btn primary" disabled={!canSubmit} onClick={() => void submit().catch(() => {})}>
          {busy ? 'Sending…' : 'Submit securely'}
        </button>
        <button type="button" className="ow-btn ghost" disabled={!canDeny} onClick={() => void deny().catch(() => {})}>
          Deny
        </button>
      </div>
    </section>
  )
}

function ReversalOffers({ agent }: { readonly agent: OwnwareAgent }) {
  const [observedAt, setObservedAt] = useState<number | null>(null)
  useEffect(() => {
    const now = Date.now()
    setObservedAt(now)
    if (agent.evidence.reversalOffers.state !== 'ready') return
    const nextExpiry = agent.evidence.reversalOffers.value
      .filter(offer => offer.status === 'available' && offer.expiresAt !== null && offer.expiresAt > now)
      .map(offer => offer.expiresAt!)
      .sort((left, right) => left - right)[0]
    if (nextExpiry === undefined) return
    const timeout = setTimeout(() => setObservedAt(Date.now()), Math.min(2_147_483_647, nextExpiry - now + 1))
    return () => clearTimeout(timeout)
  }, [agent.evidence.reversalOffers])
  if (agent.evidence.reversalOffers.state !== 'ready') return null
  return (
    <>
      {agent.evidence.reversalOffers.value.map(offer => (
        <ReversalOfferAction
          key={offer.offerId}
          projection={selectReversal({
            capabilities: agent.evidence.capabilities,
            offers: agent.evidence.reversalOffers,
            receipts: agent.evidence.reversalReceipts,
            runId: agent.activeRunId ?? '',
            offerId: offer.offerId,
            now: observedAt ?? -1,
          })}
          busy={agent.busyActions.has(`reversal:${offer.offerId}`)}
          error={agent.actionErrors[`reversal:${offer.offerId}`]}
          onExecute={idempotencyKey => agent.executeReversal(offer.offerId, idempotencyKey)}
        />
      ))}
    </>
  )
}

export function ReversalOfferAction({
  projection,
  busy,
  error,
  onExecute,
}: {
  readonly projection: ReversalProjection
  readonly busy: boolean
  readonly error?: string
  readonly onExecute: (idempotencyKey: string) => Promise<void>
}) {
  if (projection.state !== 'ready' || !projection.offer || !projection.operationLabel) return null
  const enabled = projection.action.enabled && !busy
  return (
    <section className="ow-reversal" aria-busy={busy}>
      <div className="ow-evidence-title">{projection.operationLabel}</div>
      <p>{projection.operationStatement}</p>
      {error && <div className="ow-action-error" role="alert">{error}</div>}
      <button
        type="button"
        className="ow-btn ghost"
        disabled={!enabled}
        onClick={() => void onExecute(createIdempotencyKey()).catch(() => {})}
      >
        {busy ? 'Confirming…' : projection.operationLabel}
      </button>
      {!projection.action.enabled && (
        <div className="ow-action-note">Unavailable: {projection.action.reason.replaceAll('_', ' ')}</div>
      )}
    </section>
  )
}

function Composer({
  placeholder,
  busy,
  error,
  onSend,
}: {
  readonly placeholder: string
  readonly busy: boolean
  readonly error?: string
  readonly onSend: (text: string) => Promise<void>
}) {
  const [value, setValue] = useState('')
  const fieldId = useId()
  const submit = async () => {
    const text = value.trim()
    if (!text || busy) return
    try {
      await onSend(text)
      setValue('')
    } catch {
      // Keep the draft available for retry. The hook exposes content-free error copy.
    }
  }
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }
  return (
    <div className="ow-composer-wrap">
      {error && <div className="ow-composer-error" role="alert">{error}</div>}
      <div className="ow-composer">
        <label className="ow-sr-only" htmlFor={fieldId}>Message the agent</label>
        <textarea
          id={fieldId}
          name="message"
          autoComplete="off"
          rows={1}
          placeholder={placeholder}
          value={value}
          disabled={busy}
          aria-busy={busy}
          onChange={event => setValue(event.target.value)}
          onKeyDown={onKey}
        />
        <button
          type="button"
          className="ow-send"
          onClick={() => void submit()}
          disabled={busy || value.trim().length === 0}
          aria-label={busy ? 'Sending message' : 'Send message'}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 13V3.5M4.5 7 8 3.5 11.5 7" />
          </svg>
        </button>
      </div>
    </div>
  )
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8 1.5l5.5 2v4c0 3.2-2.3 5.4-5.5 6.5-3.2-1.1-5.5-3.3-5.5-6.5v-4z" strokeLinejoin="round" />
    </svg>
  )
}

function OwnwareMark() {
  const clip = `owr-${useId().replaceAll(':', '')}`
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
        {[32, 46, 60, 74, 88, 102, 116, 130, 144].map(y => (
          <rect key={y} x="83" y={y} width="90" height="7" />
        ))}
      </g>
    </svg>
  )
}

function useInjectStyles(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined' || document.getElementById(OW_STYLE_ID)) return
    const element = document.createElement('style')
    element.id = OW_STYLE_ID
    element.textContent = ownwareChatCss
    document.head.appendChild(element)
  }, [enabled])
}

function connectionStatement(agent: OwnwareAgent): string {
  if (agent.hydrating) return 'Loading conversation history.'
  if (agent.sending) return 'Starting run.'
  switch (agent.connection.phase) {
    case 'replaying': return 'Restoring recent activity.'
    case 'live': return agent.streaming ? 'Agent is responding.' : 'Live connection ready.'
    case 'reconnecting': return 'Connection interrupted; reconnecting.'
    case 'resync_required': return 'Activity is incomplete; restoring the thread.'
    case 'closed': return 'Run stream closed.'
    case 'idle': return 'Ready.'
  }
}

function shortConnectionLabel(agent: OwnwareAgent): string {
  if (agent.hydrating) return 'Loading'
  if (agent.sending) return 'Starting'
  if (agent.connection.phase === 'reconnecting') return 'Reconnecting'
  if (agent.connection.phase === 'resync_required') return 'Restoring'
  return agent.streaming ? 'Live' : 'Ready'
}

function readableState(state: string): string {
  return state.replaceAll('_', ' ')
}

function shorten(value: string): string {
  return value.length > 52 ? `…${value.slice(-50)}` : value
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value
}

function fmtMs(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`
}

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  throw new Error('secure_idempotency_identity_unavailable')
}
