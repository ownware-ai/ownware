/**
 * soul-validate — deterministic post-write gate for a generated SOUL.
 *
 * The builder's craft rubric (profiles/builder/SOUL.md) ends with a
 * self-check the *building model* is asked to honor. That is a weak steer:
 * the load-bearing reliability rules ("only promise what it has", "every
 * risky action has a guardrail") rest on the model grading itself. This
 * module promotes the checkable subset of that rubric into an ENFORCED
 * construct, run after `write_profile_file("soul")` writes a SOUL:
 *
 *   1. Banned-marketing lint        — a closed set of unambiguous tells.
 *   2. Capability-vs-claim          — every "I can do X" must map to a tool
 *                                     the agent ACTUALLY has, computed from
 *                                     the RESOLVED surface (preset → allow/deny
 *                                     → composio), not the raw preset.
 *   3. Autonomy / guardrail         — an `ask`-mode agent must state a
 *                                     guardrail; the SOUL's act-vs-ask posture
 *                                     must not contradict permissionMode.
 *
 * PRECISION-FIRST. A good SOUL must never falsely fail — a false reject
 * frustrates every build and is worse than the occasional missed overpromise
 * (the rubric self-check is still the first line of defense). So the banned
 * list holds only marketing words with negligible legitimate domain use, and
 * the capability patterns require a verb + its object in the same clause so
 * prose like "write release notes" or "read the pasted contract" never trips
 * the file/shell checks. Softer rubric guidance (altitude, voice, the milder
 * marketing tells like "mission"/"passionate") stays advisory in the builder
 * prompt — it is not hard-rejected here.
 */

import { resolvePresetTools, applyToolPolicy } from './tool-policy.js'

/** The `tools` block of a created agent.json, as written by create_profile. */
export interface SoulToolsConfig {
  readonly preset?: string
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  readonly composio?: { readonly toolkits?: readonly string[] }
  readonly mcp?: Record<string, unknown>
  readonly custom?: readonly unknown[]
}

export interface SoulValidationInput {
  /** The agent's tool config (from agent.json). Omit → capability checks skipped. */
  readonly tools?: SoulToolsConfig
  /** `security.permissionMode` — 'ask' | 'auto'. Drives the guardrail check. */
  readonly permissionMode?: string
}

export interface SoulValidationResult {
  readonly ok: boolean
  /** Human-readable, actionable reasons the SOUL was rejected (empty when ok). */
  readonly reasons: readonly string[]
}

// Marketing tells that are ~never legitimate domain vocabulary → HARD reject.
// Word-boundaried so substrings never false-match (e.g. "mission" inside
// "permission"). The milder rubric tells ("mission", "philosophy",
// "passionate", "core values") are intentionally NOT here — they can be real
// domain words and stay advisory in the builder prompt.
const BANNED_MARKETING: readonly { readonly re: RegExp; readonly label: string }[] = [
  { re: /\bswiss army knife\b/i, label: '"Swiss Army knife"' },
  { re: /\bseamless(ly)?\b/i, label: '"seamless"' },
  { re: /\bempower(s|ing|ed)?\b/i, label: '"empower"' },
  { re: /\bsupercharge(s|d|ing)?\b/i, label: '"supercharge"' },
  { re: /\bworld[- ]?class\b/i, label: '"world-class"' },
  { re: /\bbest[- ]?in[- ]?class\b/i, label: '"best-in-class"' },
  { re: /\bcutting[- ]?edge\b/i, label: '"cutting-edge"' },
  { re: /\bone[- ]?stop shop\b/i, label: '"one-stop shop"' },
  { re: /\bwe(?:'|’| a)?re excited to announce\b/i, label: '"we\'re excited to announce"' },
  { re: /\bi['’]?m your [a-z][a-z ]{2,30} specialist\b/i, label: 'the "I\'m your X specialist" tagline' },
]

type Capability = 'writeFiles' | 'shell' | 'web' | 'sendExternal'

interface CapRule {
  readonly re: RegExp
  readonly needs: Capability
  readonly claim: string
}

// Tight verb+object patterns. Each fires only when the SOUL clearly claims the
// capability; absence of the backing tool then rejects. "[^.\n]{0,N}" keeps the
// object in the same sentence so unrelated nearby words don't combine.
const CAP_RULES: readonly CapRule[] = [
  {
    re: /\b(edit|modify|change|patch|refactor|rewrite|write|update)\b[^.\n]{0,32}\b(files?|code|codebase|source code|the repo|repository|scripts?)\b/i,
    needs: 'writeFiles',
    claim: 'editing or writing files/code',
  },
  {
    re: /\bwrite\b[^.\n]{0,18}\b(to disk|files?)\b/i,
    needs: 'writeFiles',
    claim: 'writing files to disk',
  },
  {
    re: /\b(run|execute|invoke|kick off)\b[^.\n]{0,34}\b(tests?|the build|builds?|commands?|scripts?|a shell|the shell|shell commands?|npm|yarn|pnpm|bun|the test suite|type ?checks?|linters?|the linter|lint)\b/i,
    needs: 'shell',
    claim: 'running commands, tests, or builds',
  },
  {
    re: /(\brun\b[^.\n]{0,14}\bgit\b|\bgit (log|status|diff|fetch|clone|tag|commit|push|pull|merge|rebase)\b|`git\b)/i,
    needs: 'shell',
    claim: 'running git commands',
  },
  {
    re: /\b(search|browse|look up|google|crawl|fetch)\b[^.\n]{0,28}\b(the web|the internet|online|a url|web ?pages?|websites?|the open web)\b/i,
    needs: 'web',
    claim: 'searching or browsing the web',
  },
  {
    re: /\b(send|sends|sending|deliver|delivers|dispatch|fire off|shoot (?:off|over))\b[^.\n]{0,30}\b(emails?|e-?mails?|messages?|replies|a reply|slack messages?|a dm|texts?|the message)\b/i,
    needs: 'sendExternal',
    claim: 'sending email or messages externally',
  },
]

/** Resolve the agent's real capabilities from its tool config. */
function resolveCapabilities(tools: SoulToolsConfig | undefined): Record<Capability, boolean> {
  const base = resolvePresetTools(tools?.preset)
  const resolved = applyToolPolicy(base, tools?.allow ?? [], tools?.deny ?? [])
  const names = new Set(resolved.map((t) => t.name))
  const connectors = [
    ...(tools?.composio?.toolkits ?? []),
    ...Object.keys(tools?.mcp ?? {}),
  ].filter(Boolean)
  // A connector OR a custom tool can plausibly perform an external action; we
  // only reject "send" claims when there is NO such surface at all. We do not
  // try to match a specific connector to a specific verb — slugs were already
  // validated against the live catalog at propose time, and verb→connector
  // mapping is open-ended (false-reject risk). Conservative by design.
  const hasExternalActionSurface = connectors.length > 0 || (tools?.custom?.length ?? 0) > 0
  return {
    writeFiles: names.has('writeFile') || names.has('editFile'),
    shell: names.has('shell_execute'),
    web: names.has('web_search') || names.has('web_fetch'),
    sendExternal: hasExternalActionSurface,
  }
}

// The new rubric's Role line is literally "do X — not to Y", so negated
// capabilities ("not to edit code", "never publish", "rather than send") are
// common and must NOT count as claims. A claim counts only when a NON-negated
// match exists. We look at the short window immediately before the verb for a
// negation cue anchored right against it (optionally "… to <verb>").
const NEGATION_BEFORE =
  /(\bnot\b|\bnever\b|\bno\b|\bdon['’]?t\b|\bdoes\s?n['’]?t\b|\bwo\s?n['’]?t\b|\bcannot\b|\bca\s?n['’]?t\b|\brather than\b|\binstead of\b|\bwithout\b)\s*(to\s+)?$/i

/** True if the SOUL makes a NON-negated claim matching `re`. */
function claimsCapability(text: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  for (let m = g.exec(text); m !== null; m = g.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 18), m.index)
    if (!NEGATION_BEFORE.test(before)) return true
    if (m.index === g.lastIndex) g.lastIndex++ // guard against zero-width loops
  }
  return false
}

const CAP_HINT: Record<Capability, string> = {
  writeFiles: 'no file-write tool (preset has no writeFile/editFile)',
  shell: 'no shell tool in its resolved set (this preset has no shell, or shell_execute is denied — auto-autonomy agents cannot run shell)',
  web: 'no web tool (web_search/web_fetch not granted by this preset)',
  sendExternal: 'no connector or custom tool that can send anything',
}

/**
 * Validate a freshly-written SOUL against the agent's real config.
 * Returns `{ ok: true, reasons: [] }` when the SOUL is acceptable.
 */
export function validateSoul(soul: string, input: SoulValidationInput = {}): SoulValidationResult {
  const reasons: string[] = []
  const text = soul ?? ''

  // 1. Banned-marketing lint.
  const marketingHits = BANNED_MARKETING.filter((b) => b.re.test(text)).map((b) => b.label)
  if (marketingHits.length > 0) {
    reasons.push(
      `Marketing language found (${marketingHits.join(', ')}). Cut it — state plainly what the agent does.`,
    )
  }

  // 2. Capability-vs-claim over the RESOLVED tool surface.
  if (input.tools) {
    const cap = resolveCapabilities(input.tools)
    const seen = new Set<Capability>()
    for (const rule of CAP_RULES) {
      if (cap[rule.needs] || seen.has(rule.needs)) continue
      if (claimsCapability(text, rule.re)) {
        seen.add(rule.needs)
        reasons.push(
          `Overpromise: the SOUL claims ${rule.claim}, but this agent has ${CAP_HINT[rule.needs]}. ` +
            `Remove the claim (or give the agent the tool/connector). Only promise what it can actually do.`,
        )
      }
    }
  }

  // 3. Autonomy / guardrail. An ask-mode agent must state a guardrail so the
  //    user knows when it stops and asks. (auto agents are not required to.)
  const mode = input.permissionMode ?? 'ask'
  if (mode !== 'auto') {
    const hasGuardrail =
      /^#{1,4}\s*hard rules/im.test(text) ||
      /\bnever\b/i.test(text) ||
      /\bask(?:s|ing)?\b[^.\n]{0,24}\b(first|before|you|for approval|for confirmation)\b/i.test(text)
    if (!hasGuardrail) {
      reasons.push(
        'This agent asks before acting (autonomy "ask"), but the SOUL has no guardrail — ' +
          'add a "Hard rules" section (or explicit "never …" / "ask before …" lines) so it is clear when it stops and asks.',
      )
    }
  }

  return { ok: reasons.length === 0, reasons }
}
