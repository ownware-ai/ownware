/**
 * <OwnwareStudio> — the shell around <OwnwareChat>.
 *
 * The ChatGPT-style layout, but for YOUR agents: a sidebar (brand · New chat ·
 * profile picker · conversations) with the SAME <OwnwareChat> in the center.
 * Pick a profile, start a chat, talk. Each conversation stays mounted so
 * switching between them preserves the thread (this session).
 *
 *   <OwnwareStudio baseUrl="http://localhost:4000" token={t} />
 *
 * Profiles are fetched from the gateway (GET /profiles); pass `profiles` to
 * override. Skinned by the same --ow-* tokens as the chat.
 */

import { useEffect, useId, useMemo, useState } from 'react'
import { OwnwareClient, type ProfileSummary } from '@ownware/client'
import type { ToolUIDescriptor } from '@ownware/ui'
import { OwnwareChat } from './OwnwareChat.js'
import type { AgentTransport } from '../useOwnwareAgent.js'
import { OW_STYLE_ID, ownwareChatCss, OW_STUDIO_STYLE_ID, ownwareStudioCss } from './styles.js'

export interface StudioProfile {
  readonly id: string
  readonly name?: string
}

export interface OwnwareStudioProps {
  readonly baseUrl?: string
  readonly token?: string
  /** Inject a transport (tests / demo). Passed to each chat; overrides baseUrl/token. */
  readonly client?: AgentTransport
  /** Override the profile list (else fetched from the gateway). */
  readonly profiles?: readonly StudioProfile[]
  readonly theme?: 'dark' | 'light'
  /** Descriptors for custom tools, passed to each chat. */
  readonly descriptors?: Readonly<Record<string, ToolUIDescriptor>>
  /** Sidebar wordmark. Default 'ownware'. */
  readonly brand?: string
}

interface Convo {
  readonly id: number
  readonly profileId: string
  readonly title: string
}

let convoSeq = 0

export function OwnwareStudio(props: OwnwareStudioProps) {
  const { theme = 'dark', brand = 'ownware' } = props
  useInjectStudioStyles()

  const client = useMemo(
    () => (props.baseUrl ? new OwnwareClient({ baseUrl: props.baseUrl, token: props.token }) : null),
    [props.baseUrl, props.token],
  )

  const [profiles, setProfiles] = useState<readonly StudioProfile[]>(props.profiles ?? [])
  const [selected, setSelected] = useState<string>(props.profiles?.[0]?.id ?? '')
  const [convos, setConvos] = useState<readonly Convo[]>([])
  const [active, setActive] = useState<number>(-1)

  // Fetch the profiles this gateway serves.
  useEffect(() => {
    if ((props.profiles && props.profiles.length) || !client) return
    let alive = true
    client
      .profiles()
      .then((ps: ProfileSummary[]) => {
        if (!alive) return
        const list = ps.map((p) => ({ id: p.id, name: p.name ?? p.id }))
        setProfiles(list)
        setSelected((s) => s || list[0]?.id || '')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [client, props.profiles])

  const startChat = (profileId: string) => {
    if (!profileId) return
    const name = profiles.find((p) => p.id === profileId)?.name ?? profileId
    const convo: Convo = { id: ++convoSeq, profileId, title: name }
    setConvos((cs) => [convo, ...cs])
    setActive(convo.id)
  }

  // Open the first chat once a profile is known.
  useEffect(() => {
    if (active === -1 && selected) startChat(selected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  return (
    <div className="ow-studio" data-ow-theme={theme}>
      <aside className="ow-side">
        <div className="ow-side-brand">
          <StudioMark />
          <b>{brand}</b>
        </div>
        <button className="ow-new" onClick={() => startChat(selected)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
          New chat
        </button>

        <div className="ow-side-label">Agent</div>
        <select className="ow-profile" value={selected} onChange={(e) => setSelected(e.target.value)}>
          {profiles.length === 0 && <option value="">(no profiles)</option>}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <div className="ow-side-label">Conversations</div>
        <div className="ow-convos">
          {convos.map((c) => (
            <button
              key={c.id}
              className={c.id === active ? 'ow-convo active' : 'ow-convo'}
              onClick={() => setActive(c.id)}
            >
              {c.title}
            </button>
          ))}
        </div>

        <div className="ow-side-foot">
          <b>Self-hosted</b> · keys stay in your vault
        </div>
      </aside>

      <main className="ow-main">
        {convos.map((c) => (
          <div key={c.id} className={c.id === active ? '' : 'ow-hidden'} style={{ flex: 1, minWidth: 0 }}>
            <OwnwareChat
              client={props.client}
              baseUrl={props.baseUrl}
              token={props.token}
              profileId={c.profileId}
              agentName={c.title}
              theme={theme}
              descriptors={props.descriptors}
            />
          </div>
        ))}
      </main>
    </div>
  )
}

function StudioMark() {
  const clip = `ows-${useId().replace(/:/g, '')}`
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

function useInjectStudioStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return
    for (const [id, css] of [
      [OW_STYLE_ID, ownwareChatCss],
      [OW_STUDIO_STYLE_ID, ownwareStudioCss],
    ] as const) {
      if (document.getElementById(id)) continue
      const el = document.createElement('style')
      el.id = id
      el.textContent = css
      document.head.appendChild(el)
    }
  }, [])
}
