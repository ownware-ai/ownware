/**
 * Event redaction — strip secret-shaped values out of tool-call
 * arguments AND results before ANY gateway store keeps a copy.
 *
 * ## Why this exists
 *
 * The engine historically sanitized the results of `shell` and `filesystem`
 * only, and nothing sanitized tool ARGUMENTS at all. So both directions
 * reached the stores verbatim: a `shell` command carrying
 * `export API_KEY=…`, an MCP call carrying a bearer token, a `writeFile`
 * writing a `.env`, and any token an MCP server handed back.
 *
 * The engine now sanitizes every result centrally, so this
 * module's job on the result side is a backstop. ARGUMENTS are still
 * this module's alone — nothing upstream touches them, because the model
 * must be able to actually call tools with the values it means.
 *
 * ## The three stores, and why redacting in one place is not enough
 *
 * A LoomEvent forks into three independent stores. They do NOT share a
 * write path, so each needs the redactor applied at its own choke point:
 *
 *   | Store                      | Single write path              | Served by                   |
 *   |----------------------------|--------------------------------|-----------------------------|
 *   | `agent_events` + EventBus  | `EventIngestor.ingest`         | SSE live-tail, `/debug/*`   |
 *   | `messages`                 | `SessionRunner.accumulateEvent`| `/hydrate`, `/messages`,    |
 *   |                            |                                | `/data/export`, md export   |
 *   | in-memory log              | `GatewayState.logEvent`        | `/debug/*`                  |
 *
 * `messages` is the one that matters most: retention prunes
 * `agent_events` for terminal threads, but `messages` is durable
 * forever (see `gateway/CLAUDE.md`).
 *
 * ## Values, not arguments
 *
 * We redact secret-shaped VALUES, never whole arguments. UI clients
 * render tool-call cards straight out of these stores, and design
 * surfaces replay `writeFile`/`editFile` calls out of
 * `messages[].tools[].input` to rebuild their canvas.
 * Blanking arguments would blank the UI and break that replay. A file
 * whose content genuinely contains a live API key SHOULD show
 * `[REDACTED:…]` — that is the correct outcome, not a regression.
 *
 * ## Streamed arguments
 *
 * `tool.call.args_delta` carries partial JSON, so it goes through
 * `sanitizeJsonFragment` (structure-preserving subset) rather than
 * `sanitizeOutput`. The four patterns that subset skips are applied at
 * the object level instead — at `tool.call.start.input`,
 * `permission.request.input`, and on the reassembled arguments once
 * `session-runner` has parsed them at `tool.call.end`.
 *
 * Pure and allocation-free on the common path: an event with nothing to
 * redact is returned BY REFERENCE, so `text.delta` streaming pays only a
 * switch statement.
 */

import type { LoomEvent } from '@ownware/loom'
import {
  sanitizeJsonFragment,
  sanitizeOutput,
  sanitizeToolResultText,
  redactSecretsDeep,
} from '@ownware/loom'

/**
 * Deep-walk a parsed tool-argument value, redacting secrets from every
 * string it contains.
 *
 * Returns the input BY REFERENCE when nothing changed, so callers can
 * skip rebuilding the enclosing object (and so an untouched value keeps
 * object identity for downstream `===` checks).
 *
 * Cycles are impossible for real input — these values come from
 * `JSON.parse` of provider output — but a `seen` set means a
 * hand-constructed cyclic value degrades to "left alone" instead of
 * hanging the gateway.
 */
export function redactToolInput(value: unknown): unknown {
  return redactSecretsDeep(value)
}

/**
 * Redact a tool-argument record, preserving its type.
 *
 * Thin typed wrapper over {@link redactToolInput} for the event fields
 * that are declared `Record<string, unknown>`.
 */
function redactRecord(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return redactToolInput(input) as Record<string, unknown>
}

/**
 * Redact a tool RESULT string — `sanitizeToolResultText` from loom.
 *
 * The engine already applies this to every result before the
 * model sees it, so by the time an event reaches a gateway store the
 * content is normally clean. Kept here as a defence-in-depth backstop:
 * events can be constructed by the gateway itself (not only relayed from
 * an engine execution), and a store that depends on an upstream caller
 * having done the right thing is the kind of guard that silently stops
 * guarding. Idempotent, so the second pass costs nothing.
 *
 * Results are not free text. UI clients parse several of them as JSON
 * and schema-validate the outcome — a client that parses the
 * `connectors` result may, on a parse failure, silently fall back to
 * "no typed result" — so a redaction that broke the JSON would quietly
 * degrade the UI with nothing in the logs.
 *
 * So: parse first when the content is JSON, redact the parsed VALUES
 * (full pattern set — structure is not at risk once parsed), and
 * re-serialize only when something actually changed. Non-JSON content
 * takes the plain sanitizer. Either way the string is returned by
 * reference when there was nothing to redact, so formatting is preserved
 * byte-for-byte in the overwhelmingly common case.
 */
const redactResultText = sanitizeToolResultText

/**
 * Redact an event before it is written to any gateway store.
 *
 * @security Apply this at every store's write path — see the table in
 * this module's header. Idempotent: redacting an already-redacted event
 * is a no-op, because `[REDACTED:TYPE]` matches no secret pattern.
 *
 * @param event - The event as emitted by the engine
 * @returns The event with secret-shaped argument values replaced, or the
 *          SAME event by reference when there was nothing to redact
 */
export function redactEventForStorage(event: LoomEvent): LoomEvent {
  switch (event.type) {
    case 'tool.call.start': {
      const input = redactRecord(event.input)
      return input === event.input ? event : { ...event, input }
    }

    case 'tool.call.args_delta': {
      // Partial JSON — structure-preserving subset only.
      const { sanitized } = sanitizeJsonFragment(event.delta)
      return sanitized === event.delta ? event : { ...event, delta: sanitized }
    }

    case 'tool.call.end': {
      // `result` is what the tool returned; `metadata` is the rich
      // side-channel (images, audio paths, search results) that never
      // reaches the model but IS persisted and served. Both are redacted.
      const result = redactResultText(event.result)
      const metadata =
        event.metadata === undefined ? undefined : redactRecord(event.metadata)

      if (result === event.result && metadata === event.metadata) return event
      return {
        ...event,
        result,
        ...(metadata === undefined ? {} : { metadata }),
      }
    }

    case 'security.block': {
      // The blocked command is written verbatim into a system message's
      // `tools[].input.command` by `session-runner`. A command is blocked
      // for being dangerous, which makes it MORE likely than average to
      // be carrying a credential — `curl -H "authorization: …"` against
      // a denied host is the archetype.
      if (event.command === undefined) return event
      const { sanitized } = sanitizeOutput(event.command)
      return sanitized === event.command ? event : { ...event, command: sanitized }
    }

    case 'permission.request': {
      // The permission card shows these arguments to the user before they
      // approve. A redacted value is still a decidable one: the user sees
      // WHICH tool wants to run with WHICH fields, just not the secret.
      const input = redactRecord(event.input)
      return input === event.input ? event : { ...event, input }
    }

    default:
      // Every other event type carries no tool arguments. Returned by
      // reference — this is the hot path (`text.delta` fires per token).
      return event
  }
}
