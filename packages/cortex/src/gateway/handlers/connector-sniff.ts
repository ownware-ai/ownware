/**
 * Connector sniff handler — POST /api/v1/connectors/sniff
 *
 * Accepts arbitrary user input (URL, app name, local path) and
 * classifies it into a connector type with a suggested action.
 * Powers the "paste anything" field in the client's Add Tool modal.
 *
 * Classification tiers:
 *   1. URL → probe for MCP (SSE or StreamableHTTP)
 *   2. URL → match against known service domains
 *   3. Text → match against catalog names (fuzzy)
 *   4. Local path → check if executable exists
 *
 * Returns `{ type, confidence, suggestedAction, prefill }` so the
 * UI can either auto-act (high confidence) or show a disambiguation
 * picker (low confidence).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON, sendError, readBody } from '../router.js'
import type { ConnectorRegistry } from '../../connector/registry.js'

// ── Domain map ──────────────────────────────────────────────────────────

const DOMAIN_MAP: Record<string, { name: string; via: string }> = {
  'figma.com': { name: 'Figma', via: 'composio:figma' },
  'github.com': { name: 'GitHub', via: 'composio:github' },
  'gitlab.com': { name: 'GitLab', via: 'composio:gitlab' },
  'slack.com': { name: 'Slack', via: 'composio:slack' },
  'notion.so': { name: 'Notion', via: 'composio:notion' },
  'linear.app': { name: 'Linear', via: 'composio:linear' },
  'trello.com': { name: 'Trello', via: 'composio:trello' },
  'asana.com': { name: 'Asana', via: 'composio:asana' },
  'jira.atlassian.com': { name: 'Jira', via: 'composio:jira' },
  'discord.com': { name: 'Discord', via: 'composio:discord' },
  'spotify.com': { name: 'Spotify', via: 'composio:spotify' },
  'drive.google.com': { name: 'Google Drive', via: 'composio:google-drive' },
  'docs.google.com': { name: 'Google Docs', via: 'composio:google-docs' },
  'mail.google.com': { name: 'Gmail', via: 'composio:gmail' },
  'calendar.google.com': { name: 'Google Calendar', via: 'composio:google-calendar' },
}

// ── Types ──────────────────────────────────────────────────────────────

interface SniffResult {
  readonly type: 'mcp_sse' | 'mcp_http' | 'mcp_stdio' | 'known_service' | 'catalog_match' | 'local_executable' | 'unknown'
  readonly confidence: number
  readonly suggestedAction: 'register_custom_mcp' | 'connect_composio' | 'connect_mcp' | 'show_picker' | 'none'
  readonly name?: string
  readonly prefill?: Record<string, unknown>
  readonly matches?: Array<{ name: string; via: string; confidence: number }>
}

// ── Handler factory ────────────────────────────────────────────────────

export function createSniffHandler(registry: ConnectorRegistry) {
  return async function sniff(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const body = await readBody(req)
      const parsed = JSON.parse(body) as { input?: string }
      const input = (parsed.input ?? '').trim()

      if (input.length === 0) {
        sendError(res, 400, 'Missing "input" field')
        return
      }

      const result = await classify(input, registry)
      sendJSON(res, 200, result)
    } catch (err) {
      sendError(res, 400, 'Invalid request body')
    }
  }
}

// ── Classification engine ──────────────────────────────────────────────

async function classify(
  input: string,
  registry: ConnectorRegistry,
): Promise<SniffResult> {
  // 1. URL detection
  if (looksLikeUrl(input)) {
    const url = normalizeUrl(input)

    // Check domain map first
    const domainMatch = matchDomain(url)
    if (domainMatch != null) {
      return {
        type: 'known_service',
        confidence: 0.9,
        suggestedAction: 'connect_composio',
        name: domainMatch.name,
        prefill: { via: domainMatch.via },
      }
    }

    // Probe for MCP server
    const mcpProbe = await probeMCP(url)
    if (mcpProbe != null) {
      return mcpProbe
    }

    // Unknown URL — offer as custom MCP
    return {
      type: 'unknown',
      confidence: 0.3,
      suggestedAction: 'show_picker',
      prefill: { url: input },
      matches: [
        { name: 'Register as SSE MCP server', via: 'custom_mcp:sse', confidence: 0.4 },
        { name: 'Register as HTTP MCP server', via: 'custom_mcp:http', confidence: 0.4 },
      ],
    }
  }

  // 2. Local path detection
  if (looksLikePath(input)) {
    return {
      type: 'mcp_stdio',
      confidence: 0.7,
      suggestedAction: 'register_custom_mcp',
      prefill: { command: input, transport: 'stdio' },
    }
  }

  // 3. Name matching against catalog
  const catalogMatches = await searchCatalog(input, registry)
  if (catalogMatches.length === 1 && catalogMatches[0]!.confidence > 0.8) {
    const match = catalogMatches[0]!
    return {
      type: 'catalog_match',
      confidence: match.confidence,
      suggestedAction: match.via.startsWith('composio:') ? 'connect_composio' : 'connect_mcp',
      name: match.name,
      prefill: { via: match.via },
    }
  }

  if (catalogMatches.length > 0) {
    return {
      type: 'catalog_match',
      confidence: catalogMatches[0]!.confidence,
      suggestedAction: 'show_picker',
      matches: catalogMatches.slice(0, 5),
    }
  }

  return {
    type: 'unknown',
    confidence: 0,
    suggestedAction: 'none',
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function looksLikeUrl(input: string): boolean {
  return /^https?:\/\//i.test(input) || /^[a-z0-9-]+\.[a-z]{2,}/i.test(input)
}

function looksLikePath(input: string): boolean {
  return input.startsWith('/') || input.startsWith('~') || input.startsWith('./')
}

function normalizeUrl(input: string): string {
  if (!/^https?:\/\//i.test(input)) {
    return `https://${input}`
  }
  return input
}

function matchDomain(url: string): { name: string; via: string } | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')

    // Try exact match first, then parent domain
    if (DOMAIN_MAP[host] != null) return DOMAIN_MAP[host]!

    // Check if subdomain matches (e.g. "app.slack.com" → "slack.com")
    const parts = host.split('.')
    if (parts.length > 2) {
      const parent = parts.slice(-2).join('.')
      if (DOMAIN_MAP[parent] != null) return DOMAIN_MAP[parent]!
    }

    return null
  } catch {
    return null
  }
}

async function probeMCP(url: string): Promise<SniffResult | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => { controller.abort() }, 3000)

    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream, application/json' },
      signal: controller.signal,
    })

    clearTimeout(timeout)

    const contentType = response.headers.get('content-type') ?? ''

    if (contentType.includes('text/event-stream')) {
      return {
        type: 'mcp_sse',
        confidence: 0.95,
        suggestedAction: 'register_custom_mcp',
        prefill: { url, transport: 'sse' },
      }
    }

    if (contentType.includes('application/json')) {
      return {
        type: 'mcp_http',
        confidence: 0.8,
        suggestedAction: 'register_custom_mcp',
        prefill: { url, transport: 'http' },
      }
    }

    return null
  } catch {
    return null
  }
}

async function searchCatalog(
  query: string,
  registry: ConnectorRegistry,
): Promise<Array<{ name: string; via: string; confidence: number }>> {
  const q = query.toLowerCase()
  const connectors = await registry.list()
  const matches: Array<{ name: string; via: string; confidence: number }> = []

  for (const c of connectors) {
    if (c.source === 'builtin') continue

    const name = c.name.toLowerCase()
    const id = c.id.toLowerCase()

    if (name === q || id === q) {
      matches.push({ name: c.name, via: `${c.source}:${c.id}`, confidence: 1.0 })
    } else if (name.startsWith(q) || id.startsWith(q)) {
      matches.push({ name: c.name, via: `${c.source}:${c.id}`, confidence: 0.8 })
    } else if (name.includes(q) || id.includes(q)) {
      matches.push({ name: c.name, via: `${c.source}:${c.id}`, confidence: 0.5 })
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence)
}
