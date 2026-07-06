/**
 * Built-in Credential Tool — `request_credential`
 *
 * The ONE tool the agent calls to ask the user for a secret.
 *
 * **How it works**
 *
 *   1. The agent invokes `request_credential` with label, hint, usage, and
 *      placement. The value itself is NOT a parameter — the agent never
 *      knows it.
 *   2. The tool yields a `ToolProgress` with the `credentialRequest`
 *      marker. The loop (see `core/loop.ts`) intercepts that marker:
 *        - Emits a `credential.request` LoomEvent so SSE subscribers see
 *          the request in real time.
 *        - Awaits the session's `requestCredential` callback (Cortex wires
 *          this to its HITL + vault).
 *        - Emits a `credential.response` event with the resolved state.
 *        - Resumes the tool generator via `.next(handle)` so the tool's
 *          `yield` expression evaluates to `CredentialHandle | null`.
 *   3. The tool returns a JSON-shaped result that tells the model only
 *      `{ status: "stored" | "denied", credentialId, label }` — never a
 *      value.
 *
 * **Why it's a write-tool (isReadOnly = false)**
 *
 * Write tools run through `executeSingleToolGen` directly (see
 * `loop.ts:executeTools`). That generator path streams each yielded event
 * to the consumer immediately. Read-only tools are batched through
 * `executeSingleTool` which collects events into an array and releases
 * them only when the tool settles — which for a HITL call is AFTER the
 * user responded, breaking the whole point of the request/response event
 * pair. So despite `request_credential` not mutating local state,
 * `isReadOnly` MUST be false for correct streaming.
 *
 * Spec deviation flagged: the feature brief says `isReadOnly: true`. That
 * is incorrect for the current Loom contract; marking it true would hide
 * the `credential.request` event behind the user's eventual response.
 */

import { defineTool } from '../types.js'
import type { Tool, ToolContext, ToolProgress, ToolResult } from '../types.js'
import type { JsonSchemaProperty } from '../../provider/types.js'
import type {
  CredentialHandle,
  CredentialPlacement,
} from '../../credentials/types.js'

// ---------------------------------------------------------------------------
// Input schema — JSON Schema presented to the model
//
// Loom's JsonSchema type does not model `oneOf` / discriminated unions, so
// we describe placement as a single object with all possible shape fields
// and rely on runtime validation in execute() to enforce the variant
// invariants (e.g. env requires variableName, header requires name).
// ---------------------------------------------------------------------------

const PLACEMENT_SCHEMA: JsonSchemaProperty = {
  type: 'object',
  description:
    "How the credential will be used. Set `type` to one of 'env' | 'bearer' | 'header' | 'cookie' | 'body' | 'query' | 'basic', " +
    "then fill the corresponding shape field: " +
    "'env' needs variableName; 'header' and 'cookie' need name; 'body' needs fieldPath; 'query' needs paramName; " +
    "'basic' may optionally set usernameCredentialId (id of a previously-stored username credential); 'bearer' needs no extras. " +
    "Today only 'env' is actively wired to shell auto-injection; the other variants are recorded for labeling + future use.",
  properties: {
    type: {
      type: 'string',
      enum: ['env', 'bearer', 'header', 'cookie', 'body', 'query', 'basic'],
      description: 'Placement kind.',
    },
    variableName: {
      type: 'string',
      description: "For type='env': environment variable name (e.g. USER_JWT).",
    },
    name: {
      type: 'string',
      description: "For type='header' or 'cookie': the header/cookie name.",
    },
    fieldPath: {
      type: 'string',
      description: "For type='body': dotted JSON path to the field.",
    },
    paramName: {
      type: 'string',
      description: "For type='query': the query parameter name.",
    },
    usernameCredentialId: {
      type: 'string',
      description: "For type='basic': id of a previously-stored username credential.",
    },
  },
  required: ['type'],
}

const DESCRIPTION =
  "Request a secret credential (API key, JWT, password, token) from the user.\n" +
  "The value is stored securely and NEVER visible to you — you receive only a confirmation that it was stored.\n" +
  "\n" +
  "After storing, the credential is automatically injected as an environment variable into every shell command you run. Use $VARIABLE_NAME in your commands to reference it.\n" +
  "\n" +
  "Example flow:\n" +
  "  1. request_credential({ label: 'User JWT', placement: { type: 'env', variableName: 'USER_JWT' }, ... })\n" +
  "  2. User enters token in secure dialog\n" +
  "  3. You receive { status: 'stored' }\n" +
  "  4. shell_execute('curl -H \"Authorization: Bearer $USER_JWT\" http://localhost:3000/api')\n" +
  "  5. The token is injected automatically — you never see the actual value\n" +
  "\n" +
  "When calling:\n" +
  "- label: Short name the user sees (e.g., 'Admin JWT', 'Database URL')\n" +
  "- hint: Where to find it (e.g., 'DevTools > Application > localStorage > token')\n" +
  "- usage: What you'll use it for (e.g., 'Test auth bypass on /api/admin')\n" +
  "- placement: How it will be available. Use { type: 'env', variableName: 'YOUR_VAR_NAME' }\n" +
  "- isRequired: true if you cannot proceed without it\n" +
  "\n" +
  "If a shell command fails with 'variable not set' or similar, request the missing credential first, then retry the command."

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const requestCredential: Tool = defineTool({
  name: 'request_credential',
  description: DESCRIPTION,
  category: 'custom',
  // See the header comment — MUST be false for HITL event streaming.
  isReadOnly: false,
  requiresPermission: false,
  uiDescriptor: {
    kind: 'conversational',
    summary: { verb: 'Requested', primaryField: 'label' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: "Short name the user sees (e.g. 'Admin JWT').",
      },
      hint: {
        type: 'string',
        description: 'Where the user can find this value.',
      },
      usage: {
        type: 'string',
        description: "What you will use it for.",
      },
      placement: PLACEMENT_SCHEMA,
      isRequired: {
        type: 'boolean',
        description: 'True when you cannot proceed without the value.',
      },
    },
    required: ['label', 'hint', 'usage', 'placement', 'isRequired'],
  },

  async *execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): AsyncGenerator<ToolProgress, ToolResult> {
    // Input validation. We do this manually because Loom's Tool contract
    // uses JsonSchema (not Zod) — the provider-side schema offers
    // best-effort validation against the model, but the execute() must
    // still fail loudly on shape drift (bad model output, custom harness).
    const validated = validateInput(input)
    if ('error' in validated) {
      return { content: validated.error, isError: true }
    }

    const { label, hint, usage, placement, isRequired } = validated

    // Yield the HITL marker. The loop will:
    //   1. Emit credential.request
    //   2. Await the Cortex-wired requestCredential callback
    //   3. Emit credential.response
    //   4. Resume with .next(handle)
    //
    // If no credentials callback is wired (default deny) the loop resolves
    // with null — same as a user denial — and we return a denied result.
    const handle = (yield {
      message: `Requesting credential: ${label}`,
      credentialRequest: { label, hint, usage, placement, isRequired },
    }) as CredentialHandle | null | undefined

    if (handle == null) {
      return {
        content: JSON.stringify({ status: 'denied', label }),
        isError: false,
      }
    }

    return {
      content: JSON.stringify({
        status: 'stored',
        credentialId: handle.credentialId,
        label: handle.label,
        placement: handle.placement,
      }),
      isError: false,
    }
  },
})

export const credentialTools: Tool[] = [requestCredential]

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

interface ValidatedInput {
  readonly label: string
  readonly hint: string
  readonly usage: string
  readonly placement: CredentialPlacement
  readonly isRequired: boolean
}

function validateInput(input: Record<string, unknown>): ValidatedInput | { error: string } {
  const { label, hint, usage, placement, isRequired } = input as {
    label?: unknown
    hint?: unknown
    usage?: unknown
    placement?: unknown
    isRequired?: unknown
  }

  if (typeof label !== 'string' || label.length === 0) {
    return { error: "Invalid input: 'label' must be a non-empty string." }
  }
  if (typeof hint !== 'string') {
    return { error: "Invalid input: 'hint' must be a string." }
  }
  if (typeof usage !== 'string') {
    return { error: "Invalid input: 'usage' must be a string." }
  }
  if (typeof isRequired !== 'boolean') {
    return { error: "Invalid input: 'isRequired' must be a boolean." }
  }

  const placementResult = validatePlacement(placement)
  if ('error' in placementResult) return placementResult

  return {
    label,
    hint,
    usage,
    placement: placementResult.placement,
    isRequired,
  }
}

function validatePlacement(
  placement: unknown,
): { placement: CredentialPlacement } | { error: string } {
  if (placement === null || typeof placement !== 'object') {
    return { error: "Invalid input: 'placement' must be an object." }
  }
  const p = placement as Record<string, unknown>
  const type = p.type

  switch (type) {
    case 'env': {
      if (typeof p.variableName !== 'string' || p.variableName.length === 0) {
        return { error: "Invalid input: env placement requires 'variableName' (non-empty string)." }
      }
      // Shell-safe env var name: [A-Za-z_][A-Za-z0-9_]*. A malformed name
      // cannot be safely interpolated into a subprocess env — reject
      // early rather than letting bash silently fail.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.variableName)) {
        return {
          error:
            `Invalid input: env placement variableName '${p.variableName}' is not a valid ` +
            `POSIX environment variable name (must match /^[A-Za-z_][A-Za-z0-9_]*$/).`,
        }
      }
      return { placement: { type: 'env', variableName: p.variableName } }
    }
    case 'bearer':
      return { placement: { type: 'bearer' } }
    case 'header': {
      if (typeof p.name !== 'string' || p.name.length === 0) {
        return { error: "Invalid input: header placement requires 'name' (non-empty string)." }
      }
      return { placement: { type: 'header', name: p.name } }
    }
    case 'cookie': {
      if (typeof p.name !== 'string' || p.name.length === 0) {
        return { error: "Invalid input: cookie placement requires 'name' (non-empty string)." }
      }
      return { placement: { type: 'cookie', name: p.name } }
    }
    case 'body': {
      if (typeof p.fieldPath !== 'string' || p.fieldPath.length === 0) {
        return { error: "Invalid input: body placement requires 'fieldPath' (non-empty string)." }
      }
      return { placement: { type: 'body', fieldPath: p.fieldPath } }
    }
    case 'query': {
      if (typeof p.paramName !== 'string' || p.paramName.length === 0) {
        return { error: "Invalid input: query placement requires 'paramName' (non-empty string)." }
      }
      return { placement: { type: 'query', paramName: p.paramName } }
    }
    case 'basic': {
      if (p.usernameCredentialId !== undefined && typeof p.usernameCredentialId !== 'string') {
        return { error: "Invalid input: basic placement 'usernameCredentialId' must be a string when present." }
      }
      return p.usernameCredentialId !== undefined
        ? { placement: { type: 'basic', usernameCredentialId: p.usernameCredentialId } }
        : { placement: { type: 'basic' } }
    }
    default:
      return {
        error:
          `Invalid input: placement.type '${String(type)}' is not supported. ` +
          `Use one of: env, bearer, header, cookie, body, query, basic.`,
      }
  }
}
