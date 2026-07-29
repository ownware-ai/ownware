import { createHmac } from 'node:crypto'

export interface CodexAccountRpc {
  request(method: string, params: unknown): Promise<unknown>
}

export type CodexAccountProtocolErrorCode =
  | 'unknown_account_shape'
  | 'invalid_login_response'
  | 'invalid_login_notification'
  | 'login_in_progress'
  | 'no_login_in_progress'
  | 'invalid_model_catalog'
  | 'duplicate_model'
  | 'model_pagination_cycle'
  | 'logout_unconfirmed'

export class CodexAccountProtocolError extends Error {
  public override readonly name = 'CodexAccountProtocolError'

  constructor(readonly code: CodexAccountProtocolErrorCode) {
    super(`Codex account protocol failed (${code}).`)
  }
}

export type CodexAccountUnavailableErrorCode =
  | 'account_signed_out'
  | 'unsupported_auth'
  | 'model_catalog_not_read'
  | 'model_unavailable'
  | 'account_identity_unavailable'
  | 'account_binding_key_invalid'

export class CodexAccountUnavailableError extends Error {
  public override readonly name = 'CodexAccountUnavailableError'

  constructor(readonly code: CodexAccountUnavailableErrorCode) {
    super(`Codex subscription is unavailable (${code}).`)
  }
}

interface Observation {
  readonly observedAt: string
  /** No provider-declared freshness window exists for this observation. */
  readonly validUntil: null
}

export type CodexAccountState =
  | {
      readonly state: 'unknown'
      readonly reason: 'not_read'
    }
  | ({
      readonly state: 'authenticated'
      readonly authMode: 'chatgpt'
      readonly plan: string
      readonly requiresOpenaiAuth: boolean
      readonly authority: 'account/read'
    } & Observation)
  | ({
      readonly state: 'signed_out'
      readonly requiresOpenaiAuth: boolean
      readonly authority: 'account/read'
    } & Observation)
  | ({
      readonly state: 'unsupported_auth'
      readonly authMode: 'apiKey' | 'amazonBedrock'
      readonly requiresOpenaiAuth: boolean
      readonly authority: 'account/read'
    } & Observation)

export type CodexLoginState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'pending'; readonly loginId: string }
  | { readonly phase: 'cancelling'; readonly loginId: string }
  | { readonly phase: 'succeeded' }
  | { readonly phase: 'cancelled' }
  | { readonly phase: 'failed'; readonly reason: 'provider_rejected' }

export type CodexLoginPresentation =
  | {
      readonly kind: 'browser'
      readonly loginId: string
      readonly url: string
    }
  | {
      readonly kind: 'device'
      readonly loginId: string
      readonly verificationUrl: string
      readonly userCode: string
    }

export interface CodexModel {
  readonly id: string
  readonly model: string
  readonly displayName: string
  readonly description: string
  readonly hidden: boolean
  readonly isDefault: boolean
  readonly defaultReasoningEffort: string
  /** Provider order is meaningful and is preserved. */
  readonly reasoningEfforts: readonly string[]
  readonly inputModalities: readonly string[]
  readonly serviceTiers: readonly string[]
  readonly defaultServiceTier: string | null
  readonly supportsPersonality: boolean
}

export interface CodexModelCatalog extends Observation {
  readonly authority: 'model/list'
  readonly models: readonly CodexModel[]
}

export interface CodexRateLimitWindow {
  readonly usedPercent: number
  readonly windowDurationMinutes: number | null
  readonly resetsAt: string | null
}

export interface CodexRateLimitBucket {
  readonly id: string | null
  readonly name: string | null
  readonly plan: string | null
  readonly primary: CodexRateLimitWindow | null
  readonly secondary: CodexRateLimitWindow | null
  readonly reachedType: string | null
  readonly spendControlReached: boolean | null
  readonly hasCredits: boolean | null
  readonly unlimitedCredits: boolean | null
  readonly spendRemainingPercent: number | null
  readonly spendResetsAt: string | null
}

type QuotaAuthority =
  | 'account/rateLimits/read'
  | 'account/rateLimits/updated'

export type CodexQuotaState =
  | ({
      readonly state: 'unknown'
      readonly reason:
        | 'not_read'
        | 'provider_stated_no_usable_limit'
        | 'unrecognized_provider_shape'
      readonly authority?: QuotaAuthority
      readonly validUntil: null
    } & Partial<Observation>)
  | ({
      readonly state: 'reported' | 'exhausted'
      readonly authority: QuotaAuthority
      /**
       * The provider supplies no defensible freshness interval. Consumers may
       * display the observation time but must not call this snapshot current.
       */
      readonly validUntil: null
      readonly buckets: readonly CodexRateLimitBucket[]
      readonly resetCreditsAvailable: number | null
      readonly resetCreditDetailsKnown: boolean | null
    } & Observation)

export interface CodexAccountNotification {
  readonly method: string
  readonly params: unknown
}

export type CodexAccountNotificationResult =
  | { readonly handled: false }
  | {
      readonly handled: true
      readonly status:
        | 'stale'
        | 'succeeded'
        | 'failed'
        | 'cancelled'
        | 'updated'
        | 'refresh_required'
    }

interface CodexAccountServiceOptions {
  readonly now?: () => number
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : null
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : undefined
}

function nullableBoolean(value: unknown): boolean | null | undefined {
  if (value === null) return null
  if (value === undefined) return undefined
  return typeof value === 'boolean' ? value : undefined
}

function nullableNonNegativeInteger(
  value: unknown,
): number | null | undefined {
  if (value === null) return null
  if (value === undefined) return undefined
  return Number.isInteger(value) && (value as number) >= 0
    ? value as number
    : undefined
}

function epochSeconds(value: number | null): string | null {
  if (value === null) return null
  const date = new Date(value * 1_000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8_192) return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function parseWindow(
  input: unknown,
  previous: CodexRateLimitWindow | null,
  sparse: boolean,
): { readonly ok: true; readonly value: CodexRateLimitWindow | null } | {
  readonly ok: false
} {
  if (input === undefined || (sparse && input === null)) {
    return { ok: true, value: previous }
  }
  if (input === null) return { ok: true, value: null }
  const record = asRecord(input)
  if (record == null) return { ok: false }

  const used = nullableNonNegativeInteger(record['usedPercent'])
  if (used === undefined && previous == null) return { ok: false }
  const duration = nullableNonNegativeInteger(record['windowDurationMins'])
  if (record['windowDurationMins'] !== undefined && duration === undefined) {
    return { ok: false }
  }
  const reset = nullableNonNegativeInteger(record['resetsAt'])
  if (record['resetsAt'] !== undefined && reset === undefined) return { ok: false }

  return {
    ok: true,
    value: {
      usedPercent: used ?? previous!.usedPercent,
      windowDurationMinutes: duration === undefined
        ? previous?.windowDurationMinutes ?? null
        : duration,
      resetsAt: reset === undefined
        ? previous?.resetsAt ?? null
        : epochSeconds(reset),
    },
  }
}

interface ParsedBucket {
  readonly ok: boolean
  readonly bucket?: CodexRateLimitBucket
  readonly meaningful?: boolean
}

function parseBucket(
  input: unknown,
  fallbackId: string | null,
  previous: CodexRateLimitBucket | null,
  sparse: boolean,
): ParsedBucket {
  const record = asRecord(input)
  if (record == null) return { ok: false }

  const primary = parseWindow(record['primary'], previous?.primary ?? null, sparse)
  const secondary = parseWindow(record['secondary'], previous?.secondary ?? null, sparse)
  if (!primary.ok || !secondary.ok) return { ok: false }

  const rawId = nullableString(record['limitId'])
  const rawName = nullableString(record['limitName'])
  const rawPlan = nullableString(record['planType'])
  const rawReached = nullableString(record['rateLimitReachedType'])
  const rawSpendReached = nullableBoolean(record['spendControlReached'])
  if (
    (record['limitId'] !== undefined && rawId === undefined) ||
    (record['limitName'] !== undefined && rawName === undefined) ||
    (record['planType'] !== undefined && rawPlan === undefined) ||
    (record['rateLimitReachedType'] !== undefined && rawReached === undefined) ||
    (record['spendControlReached'] !== undefined && rawSpendReached === undefined)
  ) return { ok: false }

  let hasCredits = previous?.hasCredits ?? null
  let unlimitedCredits = previous?.unlimitedCredits ?? null
  const credits = record['credits']
  if (!(sparse && credits === null) && credits !== undefined) {
    if (credits === null) {
      hasCredits = null
      unlimitedCredits = null
    } else {
      const creditRecord = asRecord(credits)
      if (
        creditRecord == null ||
        typeof creditRecord['hasCredits'] !== 'boolean' ||
        typeof creditRecord['unlimited'] !== 'boolean'
      ) return { ok: false }
      hasCredits = creditRecord['hasCredits']
      unlimitedCredits = creditRecord['unlimited']
    }
  }

  let spendRemainingPercent = previous?.spendRemainingPercent ?? null
  let spendResetsAt = previous?.spendResetsAt ?? null
  const limit = record['individualLimit']
  if (!(sparse && limit === null) && limit !== undefined) {
    if (limit === null) {
      spendRemainingPercent = null
      spendResetsAt = null
    } else {
      const limitRecord = asRecord(limit)
      const remaining = nullableNonNegativeInteger(limitRecord?.['remainingPercent'])
      const resets = nullableNonNegativeInteger(limitRecord?.['resetsAt'])
      if (
        limitRecord == null ||
        remaining === undefined ||
        remaining === null ||
        resets === undefined ||
        resets === null
      ) return { ok: false }
      spendRemainingPercent = remaining
      spendResetsAt = epochSeconds(resets)
    }
  }

  const value: CodexRateLimitBucket = {
    id: rawId === undefined
      ? previous?.id ?? fallbackId
      : sparse && rawId === null
        ? previous?.id ?? fallbackId
        : rawId,
    name: rawName === undefined || (sparse && rawName === null)
      ? previous?.name ?? null
      : rawName,
    plan: rawPlan === undefined || (sparse && rawPlan === null)
      ? previous?.plan ?? null
      : rawPlan,
    primary: primary.value,
    secondary: secondary.value,
    reachedType: rawReached === undefined || (sparse && rawReached === null)
      ? previous?.reachedType ?? null
      : rawReached,
    spendControlReached:
      rawSpendReached === undefined || (sparse && rawSpendReached === null)
        ? previous?.spendControlReached ?? null
        : rawSpendReached,
    hasCredits,
    unlimitedCredits,
    spendRemainingPercent,
    spendResetsAt,
  }

  const meaningful = (
    value.primary !== null ||
    value.secondary !== null ||
    value.reachedType !== null ||
    value.spendControlReached !== null ||
    value.hasCredits !== null ||
    value.spendRemainingPercent !== null
  )
  return { ok: true, bucket: value, meaningful }
}

function quotaState(
  authority: QuotaAuthority,
  observedAt: string,
  buckets: readonly CodexRateLimitBucket[],
  resetCreditsAvailable: number | null,
  resetCreditDetailsKnown: boolean | null,
): CodexQuotaState {
  const meaningful = buckets.filter((bucket) => (
    bucket.primary !== null ||
    bucket.secondary !== null ||
    bucket.reachedType !== null ||
    bucket.spendControlReached !== null ||
    bucket.hasCredits !== null ||
    bucket.spendRemainingPercent !== null
  ))
  if (meaningful.length === 0) {
    return {
      state: 'unknown',
      reason: 'provider_stated_no_usable_limit',
      authority,
      observedAt,
      validUntil: null,
    }
  }

  const exhausted = meaningful.some((bucket) => (
    bucket.reachedType !== null ||
    bucket.spendControlReached === true ||
    bucket.spendRemainingPercent === 0 ||
    (bucket.primary?.usedPercent ?? 0) >= 100 ||
    (bucket.secondary?.usedPercent ?? 0) >= 100
  ))
  return {
    state: exhausted ? 'exhausted' : 'reported',
    authority,
    observedAt,
    validUntil: null,
    buckets: meaningful,
    resetCreditsAvailable,
    resetCreditDetailsKnown,
  }
}

/**
 * Redacted view of Codex-owned authentication and subscription allowance.
 *
 * This class receives only app-server RPC responses. It never reads Codex's
 * auth file, stores tokens, or treats account metadata as proof that a model
 * request will succeed.
 */
export class CodexAccountService {
  /**
   * Kept only in process long enough to derive a caller-keyed binding. It is
   * never returned by a snapshot or written by this service.
   */
  private accountSubject: string | null = null
  private accountState: CodexAccountState = {
    state: 'unknown',
    reason: 'not_read',
  }
  private loginState: CodexLoginState = { phase: 'idle' }
  private catalog: CodexModelCatalog | undefined
  private quota: CodexQuotaState = {
    state: 'unknown',
    reason: 'not_read',
    validUntil: null,
  }
  private readonly now: () => number

  constructor(
    private readonly rpc: CodexAccountRpc,
    options: CodexAccountServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
  }

  accountSnapshot(): CodexAccountState {
    return this.accountState
  }

  loginSnapshot(): CodexLoginState {
    return this.loginState
  }

  modelSnapshot(): CodexModelCatalog | undefined {
    return this.catalog
  }

  quotaSnapshot(): CodexQuotaState {
    return this.quota
  }

  async readAccount(
    options: { readonly refreshToken?: boolean } = {},
  ): Promise<CodexAccountState> {
    const result = await this.rpc.request('account/read', {
      refreshToken: options.refreshToken ?? false,
    })
    // A provider response replaces the previous identity observation. If the
    // new shape cannot prove one, a later resume must not reuse stale proof.
    this.accountSubject = null
    const record = asRecord(result)
    if (
      record == null ||
      typeof record['requiresOpenaiAuth'] !== 'boolean'
    ) {
      throw new CodexAccountProtocolError('unknown_account_shape')
    }
    const observedAt = this.observedAt()
    const requiresOpenaiAuth = record['requiresOpenaiAuth']
    const rawAccount = record['account']
    if (rawAccount === null) {
      this.accountState = {
        state: 'signed_out',
        requiresOpenaiAuth,
        authority: 'account/read',
        observedAt,
        validUntil: null,
      }
      return this.accountState
    }

    const account = asRecord(rawAccount)
    const type = account?.['type']
    if (type === 'chatgpt') {
      const plan = nonEmptyString(account?.['planType'])
      const email = account?.['email']
      if (
        plan == null ||
        !(email === null || typeof email === 'string')
      ) {
        throw new CodexAccountProtocolError('unknown_account_shape')
      }
      this.accountState = {
        state: 'authenticated',
        authMode: 'chatgpt',
        plan,
        requiresOpenaiAuth,
        authority: 'account/read',
        observedAt,
        validUntil: null,
      }
      this.accountSubject = email
      return this.accountState
    }
    if (type === 'apiKey' || type === 'amazonBedrock') {
      this.accountState = {
        state: 'unsupported_auth',
        authMode: type,
        requiresOpenaiAuth,
        authority: 'account/read',
        observedAt,
        validUntil: null,
      }
      return this.accountState
    }
    throw new CodexAccountProtocolError('unknown_account_shape')
  }

  /**
   * Derive a non-reversible local account binding for restart/resume checks.
   *
   * The caller owns persistence of the random key. Neither the email nor the
   * key enters the returned thread metadata.
   */
  accountBinding(key: Uint8Array): string {
    if (key.byteLength < 32) {
      throw new CodexAccountUnavailableError('account_binding_key_invalid')
    }
    if (
      this.accountState.state !== 'authenticated'
      || this.accountSubject == null
      || this.accountSubject.length === 0
    ) {
      throw new CodexAccountUnavailableError('account_identity_unavailable')
    }
    const digest = createHmac('sha256', key)
      .update('ownware-codex-account-binding-v1\0')
      .update(this.accountSubject)
      .digest('hex')
    return `hmac-sha256:${digest}`
  }

  /**
   * Refresh through Codex immediately before a customer turn.
   *
   * This proves only that Codex currently reports managed ChatGPT auth; the
   * later model request remains the authority for whether that turn is served.
   */
  async authorizeTurnAttempt(): Promise<
    Extract<CodexAccountState, { readonly state: 'authenticated' }>
  > {
    const state = await this.readAccount({ refreshToken: true })
    if (state.state === 'signed_out') {
      throw new CodexAccountUnavailableError('account_signed_out')
    }
    if (state.state !== 'authenticated') {
      throw new CodexAccountUnavailableError('unsupported_auth')
    }
    return state
  }

  async startLogin(
    kind: 'browser' | 'device',
  ): Promise<CodexLoginPresentation> {
    if (
      this.loginState.phase === 'pending' ||
      this.loginState.phase === 'cancelling'
    ) {
      throw new CodexAccountProtocolError('login_in_progress')
    }
    const params = kind === 'browser'
      ? {
          type: 'chatgpt',
          useHostedLoginSuccessPage: true,
          appBrand: 'chatgpt',
        }
      : { type: 'chatgptDeviceCode' }
    const result = asRecord(await this.rpc.request('account/login/start', params))
    const loginId = nonEmptyString(result?.['loginId'])
    if (result == null || loginId == null) {
      throw new CodexAccountProtocolError('invalid_login_response')
    }

    if (kind === 'browser' && result['type'] === 'chatgpt') {
      const url = safeHttpsUrl(result['authUrl'])
      if (url == null) {
        throw new CodexAccountProtocolError('invalid_login_response')
      }
      this.loginState = { phase: 'pending', loginId }
      return { kind, loginId, url }
    }
    if (kind === 'device' && result['type'] === 'chatgptDeviceCode') {
      const verificationUrl = safeHttpsUrl(result['verificationUrl'])
      const userCode = nonEmptyString(result['userCode'])
      if (verificationUrl == null || userCode == null) {
        throw new CodexAccountProtocolError('invalid_login_response')
      }
      this.loginState = { phase: 'pending', loginId }
      return { kind, loginId, verificationUrl, userCode }
    }
    throw new CodexAccountProtocolError('invalid_login_response')
  }

  async cancelLogin(): Promise<void> {
    if (this.loginState.phase !== 'pending') {
      throw new CodexAccountProtocolError('no_login_in_progress')
    }
    const loginId = this.loginState.loginId
    await this.rpc.request('account/login/cancel', { loginId })
    this.loginState = { phase: 'cancelling', loginId }
  }

  observeNotification(
    notification: CodexAccountNotification,
  ): CodexAccountNotificationResult {
    if (notification.method === 'account/login/completed') {
      const params = asRecord(notification.params)
      const success = params?.['success']
      const loginId = params?.['loginId']
      if (
        params == null ||
        typeof success !== 'boolean' ||
        !(loginId === null || typeof loginId === 'string')
      ) {
        throw new CodexAccountProtocolError('invalid_login_notification')
      }
      if (
        (
          this.loginState.phase !== 'pending' &&
          this.loginState.phase !== 'cancelling'
        ) ||
        loginId !== this.loginState.loginId
      ) {
        return { handled: true, status: 'stale' }
      }
      if (success) {
        this.loginState = { phase: 'succeeded' }
        return { handled: true, status: 'succeeded' }
      }
      if (this.loginState.phase === 'cancelling') {
        this.loginState = { phase: 'cancelled' }
        return { handled: true, status: 'cancelled' }
      }
      // Provider error prose is deliberately discarded.
      this.loginState = { phase: 'failed', reason: 'provider_rejected' }
      return { handled: true, status: 'failed' }
    }

    if (notification.method === 'account/updated') {
      return { handled: true, status: 'refresh_required' }
    }

    if (notification.method === 'account/rateLimits/updated') {
      this.applyRateLimitUpdate(notification.params)
      return { handled: true, status: 'updated' }
    }

    return { handled: false }
  }

  async listModels(): Promise<CodexModelCatalog> {
    const models: CodexModel[] = []
    const ids = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined

    for (let page = 0; page < 100; page++) {
      const params: {
        includeHidden: false
        limit: 100
        cursor?: string
      } = { includeHidden: false, limit: 100 }
      if (cursor !== undefined) params.cursor = cursor
      const response = asRecord(await this.rpc.request('model/list', params))
      if (response == null || !Array.isArray(response['data'])) {
        throw new CodexAccountProtocolError('invalid_model_catalog')
      }
      for (const rawModel of response['data']) {
        const model = this.parseModel(rawModel)
        if (ids.has(model.id)) {
          throw new CodexAccountProtocolError('duplicate_model')
        }
        ids.add(model.id)
        models.push(model)
      }

      const next = response['nextCursor']
      if (next === null || next === undefined) {
        this.catalog = {
          authority: 'model/list',
          observedAt: this.observedAt(),
          validUntil: null,
          models,
        }
        return this.catalog
      }
      cursor = nonEmptyString(next) ?? undefined
      if (cursor === undefined) {
        throw new CodexAccountProtocolError('invalid_model_catalog')
      }
      if (cursors.has(cursor)) {
        throw new CodexAccountProtocolError('model_pagination_cycle')
      }
      cursors.add(cursor)
    }
    throw new CodexAccountProtocolError('model_pagination_cycle')
  }

  requireModel(modelId: string): CodexModel {
    if (this.catalog == null) {
      throw new CodexAccountUnavailableError('model_catalog_not_read')
    }
    const model = this.catalog.models.find((candidate) => (
      candidate.id === modelId || candidate.model === modelId
    ))
    if (model == null) {
      throw new CodexAccountUnavailableError('model_unavailable')
    }
    return model
  }

  async readRateLimits(): Promise<CodexQuotaState> {
    const response = asRecord(
      await this.rpc.request('account/rateLimits/read', {}),
    )
    const observedAt = this.observedAt()
    if (response == null || asRecord(response['rateLimits']) == null) {
      return this.setUnrecognizedQuota('account/rateLimits/read', observedAt)
    }

    const buckets: CodexRateLimitBucket[] = []
    const byId = asRecord(response['rateLimitsByLimitId'])
    if (byId != null && Object.keys(byId).length > 0) {
      for (const [id, raw] of Object.entries(byId)) {
        const parsed = parseBucket(raw, id, null, false)
        if (!parsed.ok || parsed.bucket == null) {
          return this.setUnrecognizedQuota('account/rateLimits/read', observedAt)
        }
        buckets.push(parsed.bucket)
      }
    } else {
      const parsed = parseBucket(response['rateLimits'], null, null, false)
      if (!parsed.ok || parsed.bucket == null) {
        return this.setUnrecognizedQuota('account/rateLimits/read', observedAt)
      }
      buckets.push(parsed.bucket)
    }

    let resetCreditsAvailable: number | null = null
    let resetCreditDetailsKnown: boolean | null = null
    const resetCredits = response['rateLimitResetCredits']
    if (resetCredits !== null && resetCredits !== undefined) {
      const resetRecord = asRecord(resetCredits)
      const count = nullableNonNegativeInteger(resetRecord?.['availableCount'])
      const details = resetRecord?.['credits']
      if (
        resetRecord == null ||
        count === undefined ||
        count === null ||
        !(details === null || Array.isArray(details))
      ) {
        return this.setUnrecognizedQuota('account/rateLimits/read', observedAt)
      }
      resetCreditsAvailable = count
      resetCreditDetailsKnown = Array.isArray(details)
    }

    this.quota = quotaState(
      'account/rateLimits/read',
      observedAt,
      buckets,
      resetCreditsAvailable,
      resetCreditDetailsKnown,
    )
    return this.quota
  }

  async logout(): Promise<CodexAccountState> {
    await this.rpc.request('account/logout', {})
    const observed = await this.readAccount({ refreshToken: false })
    if (observed.state !== 'signed_out') {
      throw new CodexAccountProtocolError('logout_unconfirmed')
    }
    return observed
  }

  private parseModel(input: unknown): CodexModel {
    const record = asRecord(input)
    const id = nonEmptyString(record?.['id'])
    const model = nonEmptyString(record?.['model'])
    const displayName = nonEmptyString(record?.['displayName'])
    const description = typeof record?.['description'] === 'string'
      ? record['description']
      : null
    const defaultReasoningEffort = nonEmptyString(
      record?.['defaultReasoningEffort'],
    )
    const efforts = record?.['supportedReasoningEfforts']
    if (
      record == null ||
      id == null ||
      model == null ||
      displayName == null ||
      description == null ||
      defaultReasoningEffort == null ||
      typeof record['hidden'] !== 'boolean' ||
      typeof record['isDefault'] !== 'boolean' ||
      !Array.isArray(efforts)
    ) {
      throw new CodexAccountProtocolError('invalid_model_catalog')
    }
    const reasoningEfforts = efforts.map((entry) => (
      nonEmptyString(asRecord(entry)?.['reasoningEffort'])
    ))
    if (reasoningEfforts.some((effort) => effort == null)) {
      throw new CodexAccountProtocolError('invalid_model_catalog')
    }

    const modalities = record['inputModalities'] ?? []
    const serviceTiers = record['serviceTiers'] ?? []
    if (!Array.isArray(modalities) || !Array.isArray(serviceTiers)) {
      throw new CodexAccountProtocolError('invalid_model_catalog')
    }
    const parsedModalities = modalities.map(nonEmptyString)
    const parsedTiers = serviceTiers.map((entry) => (
      nonEmptyString(asRecord(entry)?.['id'])
    ))
    if (
      parsedModalities.some((item) => item == null) ||
      parsedTiers.some((item) => item == null)
    ) {
      throw new CodexAccountProtocolError('invalid_model_catalog')
    }

    const defaultServiceTier = nullableString(record['defaultServiceTier'])
    if (
      record['defaultServiceTier'] !== undefined &&
      defaultServiceTier === undefined
    ) {
      throw new CodexAccountProtocolError('invalid_model_catalog')
    }

    return {
      id,
      model,
      displayName,
      description,
      hidden: record['hidden'],
      isDefault: record['isDefault'],
      defaultReasoningEffort,
      reasoningEfforts: reasoningEfforts as string[],
      inputModalities: parsedModalities as string[],
      serviceTiers: parsedTiers as string[],
      defaultServiceTier: defaultServiceTier ?? null,
      supportsPersonality: record['supportsPersonality'] === true,
    }
  }

  private applyRateLimitUpdate(params: unknown): void {
    const record = asRecord(params)
    const raw = record?.['rateLimits']
    const rawRecord = asRecord(raw)
    const observedAt = this.observedAt()
    if (record == null || rawRecord == null) {
      this.setUnrecognizedQuota('account/rateLimits/updated', observedAt)
      return
    }

    const priorBuckets = this.quota.state === 'reported' ||
      this.quota.state === 'exhausted'
      ? this.quota.buckets
      : []
    const requestedId = nullableString(rawRecord['limitId'])
    const previous = priorBuckets.find((bucket) => (
      requestedId == null || bucket.id === requestedId
    )) ?? null
    const parsed = parseBucket(raw, previous?.id ?? null, previous, true)
    if (!parsed.ok || parsed.bucket == null) {
      this.setUnrecognizedQuota('account/rateLimits/updated', observedAt)
      return
    }

    const buckets = previous == null
      ? [parsed.bucket]
      : priorBuckets.map((bucket) => (
          bucket === previous ? parsed.bucket! : bucket
        ))
    const resetCreditsAvailable = this.quota.state === 'reported' ||
      this.quota.state === 'exhausted'
      ? this.quota.resetCreditsAvailable
      : null
    const resetCreditDetailsKnown = this.quota.state === 'reported' ||
      this.quota.state === 'exhausted'
      ? this.quota.resetCreditDetailsKnown
      : null
    this.quota = quotaState(
      'account/rateLimits/updated',
      observedAt,
      buckets,
      resetCreditsAvailable,
      resetCreditDetailsKnown,
    )
  }

  private setUnrecognizedQuota(
    authority: QuotaAuthority,
    observedAt: string,
  ): CodexQuotaState {
    this.quota = {
      state: 'unknown',
      reason: 'unrecognized_provider_shape',
      authority,
      observedAt,
      validUntil: null,
    }
    return this.quota
  }

  private observedAt(): string {
    return new Date(this.now()).toISOString()
  }
}
