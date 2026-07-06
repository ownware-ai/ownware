/**
 * Perplexity-via-OpenRouter strategy.
 *
 * Calls Perplexity's Sonar models through OpenRouter's OpenAI-compatible
 * `chat/completions` endpoint. Returns one synthesized answer with the
 * web sources Perplexity cited inline.
 *
 * Why OpenRouter over direct Perplexity:
 *   - Ownware ships with `OPENROUTER_API_KEY` in `.env` already (it routes
 *     model traffic). Using the same key for search means zero extra setup
 *     for users who already have OpenRouter configured.
 *   - Direct Perplexity needs a separate `PERPLEXITY_API_KEY` and a paid
 *     subscription. A future strategy can add that path without touching
 *     this file.
 *
 * Endpoint: https://openrouter.ai/api/v1/chat/completions
 * Auth:     Authorization: Bearer <OPENROUTER_API_KEY>
 * Model:    perplexity/sonar (cheapest Sonar; OpenRouter exposes the
 *           perplexity/sonar-pro and perplexity/sonar-reasoning variants
 *           too — keep this strategy on the cheap default and let callers
 *           override later via config if needed).
 *
 * Response shape (verified against Perplexity OpenAPI docs, 2026-05-07):
 *   - `choices[0].message.content` — synthesized answer
 *   - `citations: string[]` — top-level URLs cited
 *   - Fallback for newer OpenRouter responses: per-message
 *     `annotations[]` of type `url_citation` with `url_citation.url`
 */

import type { SearchStrategy, SearchStrategyConfig, SearchStrategyResult } from './strategy.js'
import { normalizeMax, normalizeTimeout, sanitizeSnippet, withTimeout } from './strategy.js'

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'perplexity/sonar'
const HTTP_REFERER = 'https://cortex.os'
const X_TITLE = 'Cortex Web Search'

/**
 * Max chars for the synthesized answer snippet. Larger than the regular
 * `MAX_SNIPPET_LEN` (500) used by other strategies because the synth
 * answer IS the value of this provider — truncating to 500 throws away
 * most of what Perplexity is being paid to produce. Bounded to keep the
 * tool result inside the 30K `web_fetch`-style cap when combined with
 * citations.
 */
const ANSWER_MAX_CHARS = 2000

interface PerplexityAnnotation {
  readonly type?: string
  readonly url?: string
  readonly url_citation?: { readonly url?: string }
}

interface PerplexityChoice {
  readonly message?: {
    readonly content?: string
    readonly annotations?: readonly PerplexityAnnotation[]
  }
}

interface PerplexityResponse {
  readonly choices?: readonly PerplexityChoice[]
  readonly citations?: readonly string[]
}

export class PerplexityOpenRouterStrategy implements SearchStrategy {
  readonly id = 'perplexity-openrouter'
  readonly name = 'Perplexity (via OpenRouter)'

  async search(
    query: string,
    config: SearchStrategyConfig,
    signal: AbortSignal,
  ): Promise<SearchStrategyResult[]> {
    if (!config.apiKey) {
      throw new Error(
        'Perplexity-via-OpenRouter requires an API key (OPENROUTER_API_KEY).',
      )
    }

    const max = normalizeMax(config.maxResults)
    const timeoutMs = normalizeTimeout(config.timeoutMs)
    const { signal: linked, cleanup } = withTimeout(signal, timeoutMs)

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
          // OpenRouter uses these for attribution + abuse tracking. Both
          // are documented as recommended on every request.
          'HTTP-Referer': HTTP_REFERER,
          'X-Title': X_TITLE,
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages: [{ role: 'user', content: query }],
          // Bound the synth answer so we don't pay for tokens we'll
          // truncate. Roughly matches ANSWER_MAX_CHARS (4 chars/token).
          max_tokens: 600,
          temperature: 0.2,
        }),
        signal: linked,
      })

      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `OpenRouter rejected the API key (HTTP ${res.status}). Check OPENROUTER_API_KEY.`,
        )
      }
      if (res.status === 429) {
        throw new Error('OpenRouter rate limit reached (HTTP 429).')
      }
      if (res.status === 402) {
        throw new Error(
          'OpenRouter returned HTTP 402 — out of credits. Top up at openrouter.ai.',
        )
      }
      if (!res.ok) {
        throw new Error(`OpenRouter returned HTTP ${res.status}.`)
      }

      let json: PerplexityResponse
      try {
        json = (await res.json()) as PerplexityResponse
      } catch (e) {
        throw new Error(
          `OpenRouter returned malformed JSON: ${e instanceof Error ? e.message : String(e)}`,
        )
      }

      const answer = normalizeAnswer(json.choices?.[0]?.message?.content ?? '')
      const citations = extractCitations(json)

      // Empty answer AND no citations = no useful result. Per the
      // contract, return [] rather than throwing.
      if (!answer && citations.length === 0) {
        return []
      }

      return buildResults(answer, citations, max)
    } finally {
      cleanup()
    }
  }
}

/**
 * Strip HTML, decode common entities, collapse whitespace, truncate to
 * ANSWER_MAX_CHARS. Larger budget than `sanitizeSnippet` because this
 * is the synthesized answer, not a snippet excerpt.
 */
function normalizeAnswer(text: string): string {
  if (!text) return ''
  const decoded = text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return decoded.length > ANSWER_MAX_CHARS
    ? decoded.slice(0, ANSWER_MAX_CHARS - 1) + '…'
    : decoded
}

/**
 * Collect citation URLs from the response. Tries the documented
 * top-level `citations` array first, falls back to per-message
 * `annotations[].url_citation.url` (the newer OpenRouter shape).
 * De-duplicates while preserving first-seen order.
 */
function extractCitations(data: PerplexityResponse): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const url of data.citations ?? []) {
    if (typeof url === 'string' && url.length > 0 && !seen.has(url)) {
      seen.add(url)
      out.push(url)
    }
  }
  if (out.length > 0) return out

  for (const choice of data.choices ?? []) {
    for (const a of choice.message?.annotations ?? []) {
      if (a.type !== 'url_citation') continue
      const url = a.url_citation?.url ?? a.url
      if (typeof url === 'string' && url.length > 0 && !seen.has(url)) {
        seen.add(url)
        out.push(url)
      }
    }
  }
  return out
}

/**
 * Build the result list. First row is the synthesized answer (so the
 * agent sees the synthesis up front); subsequent rows are the citations
 * (so the agent can drill down via `web_fetch` if it wants the source).
 */
function buildResults(
  answer: string,
  citations: string[],
  max: number,
): SearchStrategyResult[] {
  const out: SearchStrategyResult[] = []

  if (answer) {
    out.push({
      title: 'Perplexity Sonar Answer',
      url: citations[0] ?? '',
      snippet: answer,
    })
  }

  for (const url of citations) {
    if (out.length >= max) break
    // Skip the first citation when we already used it as the answer's
    // url — avoids an immediate duplicate row.
    if (answer && url === citations[0]) continue
    out.push({
      title: hostnameOrUrl(url),
      url,
      snippet: sanitizeSnippet('Source cited in the synthesized answer above.'),
    })
  }

  return out.slice(0, max)
}

function hostnameOrUrl(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}
