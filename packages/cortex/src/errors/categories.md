# Error Category Catalogue

> **The closed wire enum.** Every error crossing a package boundary
> (Loom→Cortex, Cortex→client) carries a `category` from this list.
> Renaming a value is a wire break; adding a new value is fine.
>
> Source of truth for the TS type: `categories.ts` in this folder.
> When you change one, change the other in the same commit.

---

## How to read this doc

For each category:

- **Trigger** — what produces it
- **Retryable** — does the framework auto-retry, or does the user have to act?
- **User action** — what the UI should suggest (becomes the `userAction` hint)
- **Examples** — concrete error sources we know about today

---

## Authentication & authorization

### `auth`

- **Trigger:** bad / missing / revoked API key on a provider call. OAuth refresh failed at the gateway level (not connector-scoped — see `connector_auth_expired` for those).
- **Retryable:** no — user must update their key.
- **User action:** `open-settings-brains` (renderer opens Settings → Brains).
- **Examples:** Loom `AuthenticationError` (HTTP 401), Loom `PermissionDeniedError` (HTTP 403 from provider).

### `connector_auth_expired`

- **Trigger:** a connector's stored OAuth/refresh token is no longer valid (expired, revoked, scope changed). Distinct from `auth` because the fix path is "reconnect this specific connector," not "edit a key."
- **Retryable:** no.
- **User action:** `reconnect-connector` (renderer shows the connector card with reconnect button).
- **Examples:** `ConnectorAuthExpiredError` from `cortex/src/connector/errors.ts`.

### `connector_not_configured`

- **Trigger:** an action ran against a connector that the user never set up.
- **Retryable:** no.
- **User action:** `setup-connector` (renderer shows the setup card).
- **Examples:** `ConnectorNotConfiguredError`.

---

## Throttling & overload

### `rate_limit`

- **Trigger:** provider returned 429 (with or without `Retry-After`).
- **Retryable:** yes — Loom's retry layer handles this transparently. By the time a user-facing event carries this category, the framework has already given up.
- **User action:** `wait-and-retry` (renderer shows "Try again in a moment" + an explicit retry button).
- **Examples:** Loom `RateLimitError`.

### `overload`

- **Trigger:** provider 5xx or Anthropic 529 (`OverloadedError`).
- **Retryable:** yes — Loom retries, but a persistent overload bubbles up.
- **User action:** `wait-and-retry`.
- **Examples:** Loom `ServiceUnavailableError`, `OverloadedError`.

### `connector_rate_limited`

- **Trigger:** vendor (Composio, Pipedream, etc.) returned 429 for a connector action.
- **Retryable:** yes.
- **User action:** `wait-and-retry`, with `retryAfterMs` if the vendor supplied one.
- **Examples:** `ConnectorRateLimitedError`.

---

## Request shape & content

### `context_window`

- **Trigger:** prompt exceeds the model's context window. Detected from a 400 + body match (`"prompt is too long"`, `"maximum context length"`, `"context_length_exceeded"`).
- **Retryable:** not as-is, but Loom's compaction layer may auto-retry after summarizing.
- **User action:** `try-shorter-or-bigger-model` (renderer suggests trimming the message or switching to a larger-context model).
- **Examples:** Loom `ContextWindowExceededError`.

### `content_policy`

- **Trigger:** provider refused on safety/policy grounds. Detected from body match (`"content_policy_violation"`, `"content filter"`, `"safety policy"`).
- **Retryable:** no.
- **User action:** `rephrase-or-cancel`.
- **Examples:** Loom `ContentPolicyError`.

### `invalid_request`

- **Trigger:** Zod validation failed at the gateway HTTP boundary, or provider returned 422 (`UnprocessableEntityError`).
- **Retryable:** no.
- **User action:** none (programmer error; show technical details so the user can copy them to a bug report).
- **Examples:** Gateway 422 envelope; Loom `UnprocessableEntityError`.

### `connector_validation`

- **Trigger:** a connector action's input failed validation (per-field errors).
- **Retryable:** no.
- **User action:** `fix-form-errors` (renderer surfaces `fieldErrors` next to inputs).
- **Examples:** `ConnectorValidationError`.

---

## Transport-level failures

### `network`

- **Trigger:** DNS resolution failed, connection refused/reset, fetch threw with no response. Detected by Node error code (`ECONNRESET`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_*`) or message substrings (`getaddrinfo`, `socket hang up`, `Failed to fetch`).
- **Retryable:** yes — Loom's retry layer covers transient network failures.
- **User action:** `check-connection`.
- **Examples:** undici fetch failures, gateway unreachable from renderer.

### `sqlite`

- **Trigger:** local DB failure. Detected by SQLite error code (`SQLITE_BUSY`, `SQLITE_LOCKED`, `SQLITE_IOERR`, `SQLITE_CANTOPEN`, `SQLITE_CORRUPT`).
- **Retryable:** yes for transient (`BUSY`/`LOCKED`), no for permanent (`CORRUPT`).
- **User action:** `restart-app` for transient; `contact-support` for corrupt.
- **Examples:** better-sqlite3 throws, cortex DB writes.

### `connector_vendor`

- **Trigger:** the connector vendor returned a non-shape-related 5xx (Notion is down, Slack returned 502).
- **Retryable:** yes.
- **User action:** `wait-and-retry`.
- **Examples:** `ConnectorVendorError` with `statusCode`.

---

## Tool execution

### `tool_timeout`

- **Trigger:** a tool's wall-clock exceeded its configured timeout.
- **Retryable:** yes (user can retry the turn).
- **User action:** `retry-or-increase-timeout`.
- **Examples:** Loom `ToolTimeoutError`.

### `tool_permission`

- **Trigger:** user denied a HITL prompt, or sandbox security policy refused the tool input.
- **Retryable:** no (intentional).
- **User action:** none — surface the denial inline, no action needed.
- **Examples:** Loom `ToolPermissionError`, ask-user "deny".

---

## Lifecycle

### `aborted`

- **Trigger:** AbortController fired — user clicked cancel, timeout reached, or system shutdown.
- **Retryable:** no (intentional).
- **User action:** none — this is **not** an error UI state. Renderers should not toast on this category; the chat just shows "Cancelled."
- **Examples:** Loom `AbortError`. A client's `AbortController.abort()` calls during teardown.

### `not_found`

- **Trigger:** gateway 404 — resource doesn't exist (thread, profile, connector).
- **Retryable:** no.
- **User action:** `go-back-or-refresh`.
- **Examples:** any `GET /api/v1/threads/:id` for a deleted thread.

### `config`

- **Trigger:** bad `agent.json`, missing required env var, invalid model name (`NotFoundError` from provider for a model string).
- **Retryable:** no.
- **User action:** `open-settings` (varies — settings panel for env, profile editor for agent.json).
- **Examples:** Loom `ConfigError`, Loom `NotFoundError` for missing model, cortex profile-loader validation failures.

---

## Fallback

### `unknown`

- **Trigger:** the classifier didn't match anything else after a full cause-graph walk.
- **Retryable:** **unknown** — UI should NOT auto-suggest retry.
- **User action:** `copy-details-for-support` (the bug-report path).
- **Treatment in code:** every `unknown` in production is a classifier gap. Telemetry-wise, count `unknown` occurrences over time; each new shape should produce a new clause in `classify.ts`. The goal is for `unknown` to trend toward zero as we learn the error shapes.

---

## Complete list (copy-paste for code review)

```
auth
connector_auth_expired
connector_not_configured
rate_limit
overload
connector_rate_limited
context_window
content_policy
invalid_request
connector_validation
network
sqlite
connector_vendor
tool_timeout
tool_permission
aborted
not_found
config
unknown
```

**19 values total.** Sorted in this doc by domain, sorted in `categories.ts` for stable wire order.

---

## Adding a new category — process

1. Add a value to `categories.ts`.
2. Add a section to this doc with all four fields (trigger, retryable, user action, examples).
3. Add an explicit clause in `classify.ts` that produces it.
4. Add at least one test fixture in `classify.test.ts`.
5. Add a renderer-side dispatch case in `<ErrorState>` (and `<Toast>` if user-actionable).
6. Append a dated line to the package's `CHANGELOG.md`.

**Never silently widen `unknown`.** If a new shape would otherwise land in `unknown`, add the clause first.
