/**
 * connect_whatsapp (CC3) — the BYO WhatsApp Cloud API connect procedure.
 *
 * The self-hosting dev already stored their own Meta app's credentials
 * (`ownware channel add whatsapp --access-token … --phone-number-id …
 * [--app-secret … --verify-token …]`); this procedure turns that config
 * into a VERIFIED, webhook-registered connection, in the open:
 *
 *   0. check_number   — live credential probes (never save-and-hope):
 *                       GET the phone number (proves token+number), and,
 *                       when a wabaId is present, GET one template
 *                       (proves the WABA pairing). Chatwoot's
 *                       validate-on-save lesson.
 *   1. approve_connect— the consent gate: scope in, exclusions out,
 *                       decline leaves everything unchanged.
 *   2. register_webhook— POST /{waba}/subscribed_apps, then the SECOND
 *                       subscribed_apps call carrying the callback
 *                       override (Meta requires the two-step dance).
 *                       Points Meta at `<publicBaseUrl>/webhooks/whatsapp/
 *                       <channelId>` — the CC0 host.
 *   3. register_number— POST /{phone}/register with the dev's pin —
 *                       SKIPPED for coexistence (the phone app stays the
 *                       primary device) and for already-verified numbers;
 *                       failure is non-fatal (Chatwoot's lesson), stated
 *                       honestly in a work line.
 *   4. connection receipt — "connected · Not live": connection is not
 *                       permission; publish stays its own decision.
 *
 * Meta failures follow the curated transient set from the open-bsp study:
 * those defer and retry on the job's attempt budget; everything else fails
 * with a typed outcome code. Secrets stay inside step code — only safe
 * facts (display number, verified name) enter job state and receipts.
 */

import type { ChannelCredentialResolver } from './channel-credentials.js'
import {
  gateStepId,
  ProcedureStepError,
  TransientStepError,
  type ChannelProcedure,
  type ChannelProcedureContext,
} from './channel-procedures.js'

export const WHATSAPP_GRAPH_VERSION = 'v24.0'

/** Meta error codes that are transient by evidence (open-bsp production set). */
const TRANSIENT_META_CODES = new Set([
  1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056, 131057, 131064, 133004,
])

export class MetaGraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message)
    this.name = 'MetaGraphError'
  }
  get transient(): boolean {
    return this.code !== null && TRANSIENT_META_CODES.has(this.code)
  }
}

export interface WhatsAppPhoneInfo {
  readonly displayPhoneNumber: string
  readonly verifiedName: string | null
  readonly codeVerificationStatus: string | null
  readonly qualityRating: string | null
  readonly nameStatus: string | null
}

/** Minimal Graph client for the connect procedure. Injectable fetch. */
export class WhatsAppGraphApi {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string

  constructor(opts: { fetch?: typeof fetch; baseUrl?: string; version?: string } = {}) {
    this.fetchImpl = opts.fetch ?? fetch
    this.baseUrl = `${opts.baseUrl ?? 'https://graph.facebook.com'}/${opts.version ?? WHATSAPP_GRAPH_VERSION}`
  }

  async getPhoneNumber(phoneNumberId: string, accessToken: string): Promise<WhatsAppPhoneInfo> {
    const data = await this.request(
      'GET',
      `/${phoneNumberId}?fields=display_phone_number,verified_name,code_verification_status,quality_rating,name_status`,
      accessToken,
    )
    return {
      displayPhoneNumber: str(data['display_phone_number']) ?? phoneNumberId,
      verifiedName: str(data['verified_name']),
      codeVerificationStatus: str(data['code_verification_status']),
      qualityRating: str(data['quality_rating']),
      nameStatus: str(data['name_status']),
    }
  }

  /** Proves the token can manage the WABA (one-template probe). */
  async probeTemplates(wabaId: string, accessToken: string): Promise<void> {
    await this.request('GET', `/${wabaId}/message_templates?limit=1`, accessToken)
  }

  async subscribeApp(wabaId: string, accessToken: string): Promise<void> {
    await this.request('POST', `/${wabaId}/subscribed_apps`, accessToken)
  }

  /**
   * The callback override — MUST follow a plain subscribe (Meta's two-step
   * requirement, documented in both reference implementations).
   */
  async overrideCallback(
    wabaId: string,
    accessToken: string,
    callbackUrl: string,
    verifyToken: string,
  ): Promise<void> {
    await this.request('POST', `/${wabaId}/subscribed_apps`, accessToken, {
      override_callback_uri: callbackUrl,
      verify_token: verifyToken,
    })
  }

  async registerPhone(phoneNumberId: string, accessToken: string, pin: string): Promise<void> {
    await this.request('POST', `/${phoneNumberId}/register`, accessToken, {
      messaging_product: 'whatsapp',
      pin,
    })
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    accessToken: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch (error) {
      // Network failure: transient by definition.
      throw new MetaGraphError(0, 1, error instanceof Error ? error.message : 'network failure')
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const errorObj = (data['error'] ?? {}) as Record<string, unknown>
      const code = typeof errorObj['code'] === 'number' ? (errorObj['code'] as number) : null
      // Meta's error message is safe diagnostic text (never a credential).
      const message = str(errorObj['message']) ?? `Meta Graph API ${res.status}`
      throw new MetaGraphError(res.status, code, message)
    }
    return data
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export interface WhatsAppConnectDeps {
  readonly credentials: ChannelCredentialResolver
  /**
   * Public HTTPS base URL Meta calls back on (the tunnel/proxy in front of
   * the CC0 webhook host). Required — registering an unreachable callback
   * would be a lie.
   */
  readonly publicBaseUrl?: string
  readonly fetch?: typeof fetch
  readonly graphBaseUrl?: string
}

export const CONNECT_WHATSAPP_OPERATION = 'connect_whatsapp'

/**
 * Params (non-secret): `channelId` — the stored channel to connect;
 * `coexistence` — true when the number lives on the WhatsApp Business app
 * (skip Cloud registration; the phone stays the boss).
 */
export function createWhatsAppConnectProcedure(deps: WhatsAppConnectDeps): ChannelProcedure {
  const api = new WhatsAppGraphApi({
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.graphBaseUrl ? { baseUrl: deps.graphBaseUrl } : {}),
  })

  async function resolveCredentials(
    ctx: ChannelProcedureContext,
  ): Promise<Readonly<Record<string, string>>> {
    const channelId = str(ctx.params['channelId'])
    if (!channelId) throw new ProcedureStepError('channel_id_missing')
    const credentials = await deps.credentials.resolve(channelId)
    if (!credentials) throw new ProcedureStepError('channel_not_found')
    if (!credentials['accessToken'] || !credentials['phoneNumberId']) {
      throw new ProcedureStepError('channel_credentials_incomplete')
    }
    return credentials
  }

  function mapMetaFailure(error: unknown, permanentCode: string): never {
    if (error instanceof MetaGraphError) {
      if (error.transient) throw new TransientStepError(error.message)
      if (error.status === 401 || error.code === 190) {
        throw new ProcedureStepError('meta_token_invalid', error.message)
      }
      throw new ProcedureStepError(permanentCode, error.message)
    }
    throw error
  }

  return {
    operation: CONNECT_WHATSAPP_OPERATION,
    channelKind: 'whatsapp',
    steps: [
      {
        kind: 'work',
        name: 'check_number',
        run: async (ctx): Promise<void> => {
          if (!deps.publicBaseUrl) {
            throw new ProcedureStepError(
              'webhook_public_url_missing',
              'Set OWNWARE_WEBHOOK_PUBLIC_URL to the public HTTPS URL in front of the webhook host',
            )
          }
          const credentials = await resolveCredentials(ctx)
          let info: WhatsAppPhoneInfo
          try {
            info = await api.getPhoneNumber(
              credentials['phoneNumberId']!, credentials['accessToken']!,
            )
            if (credentials['wabaId']) {
              await api.probeTemplates(credentials['wabaId'], credentials['accessToken']!)
            }
          } catch (error) {
            mapMetaFailure(error, 'number_check_failed')
          }
          ctx.state['displayPhoneNumber'] = info.displayPhoneNumber
          ctx.state['verifiedName'] = info.verifiedName
          ctx.state['codeVerificationStatus'] = info.codeVerificationStatus
          ctx.state['nameStatus'] = info.nameStatus
          ctx.state['coexistence'] = ctx.params['coexistence'] === true
          ctx.workLine(
            'Checked the number',
            ctx.params['coexistence'] === true
              ? `${info.displayPhoneNumber} is on the WhatsApp Business app — it can link without moving anything`
              : `${info.displayPhoneNumber} verified with Meta`,
          )
        },
      },
      {
        kind: 'gate',
        name: 'approve_connect',
        gate: (ctx) => ({
          id: gateStepId(CONNECT_WHATSAPP_OPERATION, 'approve_connect'),
          title: `Connect ${str(ctx.state['displayPhoneNumber']) ?? 'this number'} to ${ctx.profileId}?`,
          included: [
            'Customers who message this number reach the agent — once you publish, not before',
            ...(ctx.state['coexistence'] === true
              ? ['Your WhatsApp Business app keeps working — same phone, same chats, you can always answer over the agent']
              : []),
            "The agent replies freely within 24 hours of a customer's message — after that, only pre-approved templates",
          ],
          excluded: [
            'It never messages anyone first — publishing does not announce anything',
            'Your personal WhatsApp is untouched — this is only the business number',
          ],
          onDecline: 'No WhatsApp yet. Nothing else changes.',
        }),
      },
      {
        kind: 'work',
        name: 'register_webhook',
        run: async (ctx): Promise<void> => {
          const credentials = await resolveCredentials(ctx)
          const wabaId = credentials['wabaId']
          const verifyToken = credentials['verifyToken']
          if (!wabaId || !verifyToken) {
            throw new ProcedureStepError(
              'webhook_registration_unconfigured',
              'Webhook registration needs wabaId and verifyToken credentials on the channel',
            )
          }
          const channelId = str(ctx.params['channelId'])!
          const callbackUrl =
            `${deps.publicBaseUrl!.replace(/\/+$/, '')}/webhooks/whatsapp/${channelId}`
          try {
            await api.subscribeApp(wabaId, credentials['accessToken']!)
            await api.overrideCallback(
              wabaId, credentials['accessToken']!, callbackUrl, verifyToken,
            )
          } catch (error) {
            mapMetaFailure(error, 'webhook_registration_failed')
          }
          ctx.state['callbackUrl'] = callbackUrl
          ctx.workLine('Webhook registered', `Meta will deliver messages to ${callbackUrl}`)
        },
      },
      {
        kind: 'work',
        name: 'register_number',
        run: async (ctx): Promise<void> => {
          if (ctx.state['coexistence'] === true) {
            ctx.workLine(
              'Registration skipped',
              'Coexistence: the WhatsApp Business app stays the primary device',
            )
            return
          }
          if (ctx.state['codeVerificationStatus'] === 'VERIFIED') {
            ctx.workLine('Number already registered', 'Meta reports it as verified')
            return
          }
          const credentials = await resolveCredentials(ctx)
          const pin = credentials['verificationPin']
          if (!pin) {
            // Non-fatal by evidence (Chatwoot): the number may already work.
            ctx.workLine(
              'Registration not attempted',
              'No verificationPin credential — add one and reconnect if sending fails',
            )
            return
          }
          try {
            await api.registerPhone(
              credentials['phoneNumberId']!, credentials['accessToken']!, pin,
            )
            ctx.workLine('Number registered', 'Cloud API registration completed')
          } catch (error) {
            if (error instanceof MetaGraphError && error.transient) {
              throw new TransientStepError(error.message)
            }
            // Permanent registration failure is stated, not fatal.
            ctx.workLine(
              'Registration failed — continuing',
              error instanceof MetaGraphError ? error.message : 'unknown registration error',
            )
          }
        },
      },
      {
        kind: 'work',
        name: 'record_connection',
        run: async (ctx): Promise<void> => {
          const displayNumber = str(ctx.state['displayPhoneNumber']) ?? 'the number'
          if (ctx.state['nameStatus'] && ctx.state['nameStatus'] !== 'APPROVED') {
            ctx.workLine(
              'Display name under review at Meta',
              'Usually minutes — customers may briefly see just the number. Nothing is blocked.',
            )
          }
          ctx.receipt({
            kind: 'connection',
            title: `WhatsApp connected — Not live`,
            body: {
              displayPhoneNumber: displayNumber,
              verifiedName: ctx.state['verifiedName'],
              coexistence: ctx.state['coexistence'] === true,
              callbackUrl: ctx.state['callbackUrl'],
              whatRemainedUnchanged:
                'Nothing reaches a real customer until you publish — that stays its own decision.',
              reversalRoute: 'Disconnect any time; coexistence numbers can also be unlinked from the phone.',
            },
          })
          ctx.workLine('WhatsApp connected — Not live', `${displayNumber} is ready to publish`)
        },
      },
    ],
  }
}
