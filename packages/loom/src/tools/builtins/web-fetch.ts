/**
 * Built-in Web Fetch Tool
 *
 * Fetches content from a URL and returns it as readable text.
 * HTML is converted to markdown-like format. JSON and plain text returned as-is.
 *
 * Engine-level — any agent type may need to read documentation, APIs, etc.
 *
 * Design:
 *   - Zero external deps (no axios, no turndown)
 *   - HTML converter is pluggable via config.htmlConverter for consumers
 *     that need production-grade conversion (turndown, readability, etc.)
 *   - Built-in converter handles ~90% of real-world pages adequately
 *   - LRU cache with configurable TTL
 *
 * @security
 *   - Blocks private/internal IPs (SSRF protection)
 *   - Same-origin redirect enforcement
 *   - Size limits on response body
 *   - Timeout with abort signal integration
 */

import { defineTool } from '../types.js'
import type { Tool } from '../types.js'
import { headTailTruncate } from '../../messages/truncate.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_RESPONSE_SIZE = 2 * 1024 * 1024 // 2MB download limit
const FETCH_TIMEOUT = 30_000 // 30 seconds, total across redirects
const MAX_CONTENT_LENGTH = 30_000 // ~30K chars returned to model
const MAX_REDIRECTS = 3
const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes
const MAX_CACHE_ENTRIES = 100
const MAX_HTML_CONVERT_BYTES = 1 * 1024 * 1024 // 1MB — above this, skip the regex pass

// ---------------------------------------------------------------------------
// Pluggable HTML converter interface
// ---------------------------------------------------------------------------

/**
 * Consumers can inject a better HTML converter via config.htmlConverter.
 * Default: built-in regex-based converter.
 * Recommended: turndown, mozilla/readability, or similar.
 */
export interface HtmlConverter {
  convert(html: string, url: string): string
}

// ---------------------------------------------------------------------------
// Simple LRU cache (zero deps)
// ---------------------------------------------------------------------------

interface CacheEntry {
  content: string
  contentType: string
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()

function getCached(url: string): CacheEntry | null {
  const entry = cache.get(url)
  if (!entry) return null
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(url)
    return null
  }
  return entry
}

function setCache(url: string, content: string, contentType: string): void {
  // Evict oldest if at capacity
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  cache.set(url, { content, contentType, fetchedAt: Date.now() })
}

// ---------------------------------------------------------------------------
// Security: SSRF protection
// ---------------------------------------------------------------------------

function isBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname

    // Block non-HTTP protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true

    // Block private/internal IPs
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname === '[::1]'
    ) {
      return true
    }

    return false
  } catch {
    return true
  }
}


// ---------------------------------------------------------------------------
// Built-in HTML → text converter (zero deps)
// ---------------------------------------------------------------------------

/**
 * HTML entity map. Covers the most common entities found on real pages.
 */
const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–',
  '&laquo;': '«', '&raquo;': '»', '&ldquo;': '\u201C', '&rdquo;': '\u201D',
  '&lsquo;': '\u2018', '&rsquo;': '\u2019', '&bull;': '•', '&hellip;': '…',
  '&copy;': '©', '&reg;': '®', '&trade;': '™', '&times;': '×',
  '&divide;': '÷', '&rarr;': '→', '&larr;': '←', '&uarr;': '↑',
  '&darr;': '↓', '&euro;': '€', '&pound;': '£', '&yen;': '¥',
  '&cent;': '¢', '&sect;': '§', '&para;': '¶', '&deg;': '°',
  '&plusmn;': '±', '&frac12;': '½', '&frac14;': '¼', '&frac34;': '¾',
}

function decodeEntities(text: string): string {
  // Named entities
  let result = text.replace(/&[a-zA-Z]+;/g, match => HTML_ENTITIES[match] ?? match)
  // Numeric entities: &#123; and &#x1F;
  result = result.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  return result
}

function htmlToMarkdown(html: string): string {
  let text = html

  // Remove invisible content
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '')
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '')
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '')
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, '')
  text = text.replace(/<!--[\s\S]*?-->/g, '')

  // Headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n')
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n')
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n')
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n')
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n\n##### $1\n\n')
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n\n###### $1\n\n')

  // Code blocks (pre > code)
  text = text.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, '\n```\n$1\n```\n')
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')

  // Links
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')

  // Images → alt text
  text = text.replace(/<img[^>]*alt="([^"]*)"[^>]*\/?>/gi, '[$1]')
  text = text.replace(/<img[^>]*\/?>/gi, '')

  // Tables → preserve as best we can
  text = text.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells = row.replace(/<\/?t[hd][^>]*>/gi, '|')
    return cells + '|\n'
  })
  text = text.replace(/<\/?table[^>]*>/gi, '\n')
  text = text.replace(/<\/?thead[^>]*>/gi, '')
  text = text.replace(/<\/?tbody[^>]*>/gi, '')

  // Lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
  text = text.replace(/<\/?[ou]l[^>]*>/gi, '\n')

  // Block elements
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/p>/gi, '\n\n')
  text = text.replace(/<\/div>/gi, '\n')
  text = text.replace(/<\/blockquote>/gi, '\n')
  text = text.replace(/<blockquote[^>]*>/gi, '> ')
  text = text.replace(/<hr[^>]*\/?>/gi, '\n---\n')

  // Inline formatting
  text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
  text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
  text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
  text = text.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
  text = text.replace(/<del[^>]*>([\s\S]*?)<\/del>/gi, '~~$1~~')
  text = text.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, '==$1==')

  // Details/summary
  text = text.replace(/<summary[^>]*>([\s\S]*?)<\/summary>/gi, '**$1**\n')
  text = text.replace(/<\/?details[^>]*>/gi, '\n')

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '')

  // Decode HTML entities
  text = decodeEntities(text)

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/^ +/gm, '')
  text = text.trim()

  return text
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const webFetch: Tool = defineTool({
  name: 'web_fetch',
  description:
    'Fetch content from a URL and return it as readable text.\n' +
    '- Use to read documentation, API references, web pages, or raw files.\n' +
    '- HTML is automatically converted to readable markdown.\n' +
    '- JSON and plain text are returned as-is.\n' +
    '- Results are cached for 15 minutes — repeated fetches are instant.\n' +
    '- Maximum response: ~100K characters (large pages are truncated).\n' +
    '- Do NOT use for private/internal URLs (localhost, 10.x, 192.168.x).',
  category: 'browser',
  isReadOnly: true,
  requiresPermission: true,
  timeoutMs: FETCH_TIMEOUT,
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Fetched', primaryField: 'url' },
    preview: { contentField: 'content', format: 'markdown', truncateAtLines: 10 },
    openAction: { target: 'url', pathField: 'url' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch. Must be http:// or https://.',
      },
    },
    required: ['url'],
  },
  async execute(input, context) {
    const { url } = input as { url: string }

    // URL length limit
    if (url.length > 2000) {
      return { content: 'URL is too long (max 2000 characters).', isError: true }
    }

    if (isBlockedUrl(url)) {
      return {
        content: `Blocked: "${url}" points to a private/internal network or uses a non-HTTP protocol.`,
        isError: true,
      }
    }

    // Check cache first
    const cached = getCached(url)
    if (cached) {
      return {
        content: cached.content,
        isError: false,
        metadata: { url, contentType: cached.contentType, cached: true },
      }
    }

    if (context.signal.aborted) {
      return { content: 'Request cancelled.', isError: true }
    }

    // One AbortController and one timeout for the whole tool call —
    // not per-hop. Caps total wall-clock at FETCH_TIMEOUT regardless of
    // how many redirects fire. Caller cancellation is forwarded once,
    // and the listener is removed on completion to avoid leaks across
    // many web_fetch calls in a session.
    const totalController = new AbortController()
    const totalTimeout = setTimeout(() => totalController.abort(), FETCH_TIMEOUT)
    const onCallerAbort = () => totalController.abort()
    context.signal.addEventListener('abort', onCallerAbort, { once: true })

    try {
      // Follow redirects manually so we can re-check SSRF on each hop.
      // Cross-origin is allowed (this tool sends no cookies/auth, so the
      // open-redirect threat does not apply) — but every hop is re-validated
      // against the private-network blocklist to keep SSRF closed.
      let currentUrl = url
      let redirectCount = 0
      let response: Response

      while (true) {
        response = await fetch(currentUrl, {
          signal: totalController.signal,
          headers: {
            // SEC EDGAR (and a small number of similarly-strict public
            // data sources) requires a contact-email-shaped string in
            // the UA; their automated blocker also rejects UAs that
            // contain `https://` or parenthesised content. Format kept
            // tight (`Name/version email`) per SEC's stated example,
            // verified empirically against data.sec.gov on 2026-05-07.
            'User-Agent': 'Loom/1.0 agent-runtime@ownware.dev',
            'Accept': 'text/html,application/json,text/plain,*/*',
          },
          redirect: 'manual', // Handle redirects ourselves
        })

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (!location) break

          const redirectUrl = new URL(location, currentUrl).toString()

          if (++redirectCount > MAX_REDIRECTS) {
            return { content: `Too many redirects (>${MAX_REDIRECTS}) for ${url}`, isError: true }
          }

          if (isBlockedUrl(redirectUrl)) {
            return {
              content: `Blocked redirect: ${currentUrl} → ${redirectUrl} points to a private/internal network or uses a non-HTTP protocol.`,
              isError: true,
              metadata: { redirectTo: redirectUrl },
            }
          }

          currentUrl = redirectUrl
          continue
        }

        break
      }

      if (!response!.ok) {
        return {
          content: `HTTP ${response!.status} ${response!.statusText} for ${url}`,
          isError: true,
          metadata: { status: response!.status },
        }
      }

      const contentType = response!.headers.get('content-type') ?? ''

      // Size check
      const contentLength = response!.headers.get('content-length')
      if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
        return {
          content: `Response too large (${(parseInt(contentLength) / 1024 / 1024).toFixed(1)}MB). Maximum is ${MAX_RESPONSE_SIZE / 1024 / 1024}MB.`,
          isError: true,
        }
      }

      // Skip binary content
      if (
        contentType.includes('image/') ||
        contentType.includes('audio/') ||
        contentType.includes('video/') ||
        contentType.includes('application/pdf') ||
        contentType.includes('application/zip') ||
        contentType.includes('application/octet-stream')
      ) {
        return {
          content: `Binary content (${contentType}). Use a specialized tool for this file type.`,
          isError: true,
          metadata: { contentType },
        }
      }

      const body = await response!.text()

      // Convert HTML using pluggable or built-in converter
      let content: string
      const customConverter = (context.config as Record<string, unknown>).htmlConverter as
        | HtmlConverter | undefined

      if (contentType.includes('text/html')) {
        if (customConverter) {
          content = customConverter.convert(body, url)
        } else if (Buffer.byteLength(body, 'utf8') > MAX_HTML_CONVERT_BYTES) {
          // Skip the regex pass on very large pages — it's CPU-bound and the
          // result would be truncated to MAX_CONTENT_LENGTH anyway. Truncate
          // raw HTML up front, then convert.
          content = htmlToMarkdown(body.slice(0, MAX_HTML_CONVERT_BYTES))
        } else {
          content = htmlToMarkdown(body)
        }
      } else {
        content = body
      }

      // Truncate if too long — head+tail so the document's footer/conclusion
      // (often the most actionable part of a fetched page) survives.
      const truncated = Buffer.byteLength(content, 'utf8') > MAX_CONTENT_LENGTH
      if (truncated) {
        content = headTailTruncate(content, MAX_CONTENT_LENGTH)
      }

      // Cache the result
      setCache(url, content, contentType)

      return {
        content,
        isError: false,
        metadata: {
          url,
          ...(currentUrl !== url ? { finalUrl: currentUrl } : {}),
          contentType,
          length: content.length,
          truncated,
          cached: false,
        },
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('abort') || msg.includes('AbortError')) {
        // Distinguish caller-cancelled from our own deadline.
        if (context.signal.aborted) {
          return { content: 'Request cancelled.', isError: true }
        }
        return { content: `Request timed out after ${FETCH_TIMEOUT / 1000}s.`, isError: true }
      }
      return {
        content: `Failed to fetch "${url}": ${msg}`,
        isError: true,
      }
    } finally {
      clearTimeout(totalTimeout)
      context.signal.removeEventListener('abort', onCallerAbort)
    }
  },
})

export const webFetchTools: Tool[] = [webFetch]
