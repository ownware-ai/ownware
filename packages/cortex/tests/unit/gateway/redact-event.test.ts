/**
 * Unit tests — tool-argument redaction (`gateway/redact-event.ts`).
 *
 * Two properties, in tension, and both are load-bearing:
 *
 *   1. A secret-shaped value the model passed into a tool never reaches
 *      a gateway store.
 *   2. Everything else survives byte-for-byte. Downstream clients render
 *      tool cards from these stores, and design clients may replay
 *      `writeFile` / `editFile` calls from `messages[].tools[].input`.
 *      A redactor that mangles ordinary file content is a
 *      product regression, not a security win.
 */

import { describe, it, expect } from 'vitest'
import type { LoomEvent } from '@ownware/loom'
import {
  redactEventForStorage,
  redactToolInput,
} from '../../../src/gateway/redact-event.js'

// A syntactically valid but non-issued key shape. Not a live credential.
const FAKE_ANTHROPIC_KEY = 'sk-ant-' + 'a'.repeat(28)
const FAKE_GITHUB_TOKEN = 'ghp_' + 'b'.repeat(36)

function toolCallStart(input: Record<string, unknown>): LoomEvent {
  return {
    type: 'tool.call.start',
    toolCallId: 'call_1',
    toolName: 'shell',
    input,
    turnIndex: 0,
  } as LoomEvent
}

// ---------------------------------------------------------------------------
// Property 1 — secrets do not survive
// ---------------------------------------------------------------------------

describe('redactEventForStorage() — secrets are removed', () => {
  it('redacts a key out of tool.call.start input', () => {
    const event = toolCallStart({ command: `curl -H "x: ${FAKE_ANTHROPIC_KEY}"` })
    const out = redactEventForStorage(event) as { input: Record<string, string> }

    expect(out.input['command']).toContain('[REDACTED:ANTHROPIC_KEY]')
    expect(JSON.stringify(out)).not.toContain(FAKE_ANTHROPIC_KEY)
  })

  it('redacts a key out of permission.request input', () => {
    // This is what the user sees in the approval card before deciding.
    const event = {
      type: 'permission.request',
      requestId: 'req_1',
      toolName: 'shell',
      input: { command: `export GH=${FAKE_GITHUB_TOKEN}` },
      reason: 'writes',
      turnIndex: 0,
    } as unknown as LoomEvent
    const out = redactEventForStorage(event) as { input: Record<string, string> }

    expect(out.input['command']).toContain('[REDACTED:GITHUB_TOKEN]')
    expect(JSON.stringify(out)).not.toContain(FAKE_GITHUB_TOKEN)
  })

  it('redacts nested and array-held values, at any depth', () => {
    const out = redactToolInput({
      headers: [{ name: 'authorization', value: `Bearer ${FAKE_GITHUB_TOKEN}` }],
      body: { nested: { deep: FAKE_ANTHROPIC_KEY } },
    })

    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain(FAKE_GITHUB_TOKEN)
    expect(serialized).not.toContain(FAKE_ANTHROPIC_KEY)
  })

  it('redacts a streamed args_delta chunk without breaking its JSON', () => {
    const event = {
      type: 'tool.call.args_delta',
      toolCallId: 'call_1',
      delta: `{"command":"echo ${FAKE_ANTHROPIC_KEY}"}`,
      turnIndex: 0,
    } as unknown as LoomEvent
    const out = redactEventForStorage(event) as { delta: string }

    expect(out.delta).not.toContain(FAKE_ANTHROPIC_KEY)
    expect(() => JSON.parse(out.delta)).not.toThrow()
  })

  it('is idempotent — redacting twice changes nothing further', () => {
    const once = redactEventForStorage(toolCallStart({ command: FAKE_ANTHROPIC_KEY }))
    const twice = redactEventForStorage(once)

    expect(twice).toBe(once)
  })
})

// ---------------------------------------------------------------------------
// Property 2 — everything else survives untouched
// ---------------------------------------------------------------------------

describe('redactEventForStorage() — ordinary arguments survive', () => {
  it('leaves a design HTML writeFile byte-identical', () => {
    // A design client may replay exactly this from messages[].tools[].input.
    // If the redactor touches it, the user's design renders with a redaction
    // marker inside ordinary content.
    const content = [
      '<!doctype html>',
      '<style>:root { --cx-violet: #7C5CFC; --cx-teal: #00D4AA; }</style>',
      '<main data-token="chart-primary" class="grid gap-4">',
      '  <h1>Quarterly report</h1>',
      '</main>',
      '<script>const API_BASE = "/api/v1"; fetch(API_BASE + "/threads")</script>',
    ].join('\n')

    const input = { file_path: '/tmp/design/index.html', content }
    const out = redactToolInput(input) as typeof input

    expect(out.content).toBe(content)
    expect(out).toBe(input) // returned by reference — nothing was rewritten
  })

  it('preserves non-string types exactly', () => {
    const input = {
      limit: 42,
      recursive: true,
      cursor: null,
      tags: ['a', 'b'],
      nested: { depth: 2 },
    }
    const out = redactToolInput(input)

    expect(out).toEqual(input)
    expect(out).toBe(input)
  })

  it('returns non-tool events by reference (the streaming hot path)', () => {
    const event = { type: 'text.delta', text: 'hello', turnIndex: 0 } as LoomEvent
    expect(redactEventForStorage(event)).toBe(event)
  })

  it('leaves a JSON result parseable, and schema-shaped', () => {
    // A downstream consumer JSON-parses and schema-validates the `connectors`
    // result. A redaction that broke the JSON could silently degrade that
    // consumer, so structure survival is the assertion that matters.
    const payload = {
      kind: 'connector_status',
      items: [{ slug: 'gmail', status: 'connected', token: FAKE_GITHUB_TOKEN }],
    }
    const event = {
      type: 'tool.call.end',
      toolCallId: 'call_1',
      toolName: 'connectors',
      result: JSON.stringify(payload),
      isError: false,
      durationMs: 1,
      turnIndex: 0,
    } as unknown as LoomEvent
    const out = redactEventForStorage(event) as { result: string }

    const reparsed = JSON.parse(out.result) as typeof payload
    expect(reparsed.kind).toBe('connector_status')
    expect(reparsed.items[0]!.slug).toBe('gmail')
    expect(reparsed.items[0]!.token).toContain('[REDACTED:GITHUB_TOKEN]')
    expect(out.result).not.toContain(FAKE_GITHUB_TOKEN)
  })

  it('redacts an ASSIGNMENT-shaped secret in a JSON result without corrupting it', () => {
    // The discriminating case for parse-then-redact vs. redact-the-string.
    // SECRET_ASSIGNMENT swallows the closing quote, so running the plain
    // sanitizer over this JSON yields
    //   {"log":"DB[REDACTED:SECRET_ASSIGNMENT],"ok":true}
    // which does not parse and could be hidden by a consumer's fallback.
    const payload = { log: 'DB_PASSWORD=hunter2xyz', ok: true }
    const event = {
      type: 'tool.call.end',
      toolCallId: 'call_1',
      toolName: 'mcp__deploy__logs',
      result: JSON.stringify(payload),
      isError: false,
      durationMs: 1,
      turnIndex: 0,
    } as unknown as LoomEvent
    const out = redactEventForStorage(event) as { result: string }

    const reparsed = JSON.parse(out.result) as typeof payload
    expect(reparsed.ok).toBe(true)
    expect(reparsed.log).toContain('[REDACTED:SECRET_ASSIGNMENT]')
    expect(out.result).not.toContain('hunter2xyz')
  })

  it('redacts a secret carried in result metadata', () => {
    // metadata never reaches the model but IS persisted and served.
    const event = {
      type: 'tool.call.end',
      toolCallId: 'call_1',
      toolName: 'webSearch',
      result: 'done',
      isError: false,
      durationMs: 1,
      turnIndex: 0,
      metadata: { results: [{ url: 'https://x.test', snippet: `key ${FAKE_ANTHROPIC_KEY}` }] },
    } as unknown as LoomEvent
    const out = redactEventForStorage(event) as {
      metadata: { results: Array<{ snippet: string }> }
    }

    expect(out.metadata.results[0]!.snippet).toContain('[REDACTED:ANTHROPIC_KEY]')
    expect(JSON.stringify(out)).not.toContain(FAKE_ANTHROPIC_KEY)
  })

  it('redacts a plain-text result', () => {
    const event = {
      type: 'tool.call.end',
      toolCallId: 'call_1',
      toolName: 'mcp__vault__read',
      result: `token is ${FAKE_ANTHROPIC_KEY}`,
      isError: false,
      durationMs: 1,
      turnIndex: 0,
    } as unknown as LoomEvent
    const out = redactEventForStorage(event) as { result: string }

    expect(out.result).toContain('[REDACTED:ANTHROPIC_KEY]')
    expect(out.result).not.toContain(FAKE_ANTHROPIC_KEY)
  })

  it('leaves a clean result byte-identical, formatting included', () => {
    // Pretty-printed JSON must not be silently reflowed by a round trip
    // through parse/stringify — the tool card renders this text.
    const pretty = JSON.stringify({ ok: true, items: [1, 2] }, null, 2)
    const event = {
      type: 'tool.call.end',
      toolCallId: 'call_1',
      toolName: 'connectors',
      result: pretty,
      isError: false,
      durationMs: 1,
      turnIndex: 0,
    } as unknown as LoomEvent

    expect(redactEventForStorage(event)).toBe(event)
    expect((event as unknown as { result: string }).result).toBe(pretty)
  })

  it('does not mangle base64 image data in result metadata', () => {
    // metadata carries images/audio. Base64 has no dots, so the JWT
    // pattern cannot fire on it, and SECRET_ASSIGNMENT needs a literal
    // `_KEY=`. Pinned as a regression guard because a redactor that ate
    // image payloads would be discovered only by eye, in the UI.
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const event = {
      type: 'tool.call.end',
      toolCallId: 'call_1',
      toolName: 'image_generate',
      result: 'generated',
      isError: false,
      durationMs: 1,
      turnIndex: 0,
      metadata: { image: { base64: b64, mime: 'image/png' } },
    } as unknown as LoomEvent
    const out = redactEventForStorage(event) as {
      metadata: { image: { base64: string } }
    }

    expect(out.metadata.image.base64).toBe(b64)
    expect(out).toBe(event)
  })

  it('does not hang on a cyclic input', () => {
    // Impossible from JSON.parse, but a hand-built cycle must degrade to
    // "left alone" rather than recursing until the gateway dies.
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic['self'] = cyclic

    expect(() => redactToolInput(cyclic)).not.toThrow()
  })
})
