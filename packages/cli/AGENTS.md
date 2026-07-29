# @ownware/cli — Repository Guidelines

Guidance for working in the CLI package — for humans and AI tools alike.

## What this package is

`@ownware/cli` is the terminal client for Ownware — chat with your own
agent from the shell. It is a **thin client of the gateway wire contract**
and nothing else:

```
ownware-cli ──HTTP+SSE (@ownware/client)──▶ gateway (@ownware/cortex)
```

**The one law (from the CLI board):** the CLI is ALWAYS a client of the
gateway over `@ownware/client` — even when it boots the gateway itself
(in-process, loopback, ephemeral port), it talks to it over the wire.
No in-process calls into cortex besides constructing/starting
`OwnwareGateway`. This dogfoods the public wire contract daily and keeps
one transport for local and remote (`--base-url`).

Private design records live in the owner-only work tree and are not part of
the published package.

## Architecture (S1 — fallback renderer)

| File | Responsibility |
|---|---|
| `src/index.ts` | arg parsing, profile pick (prefers `ownware-code`), wiring, `main()` |
| `src/gateway.ts` | attach (`--base-url`) or boot in-process loopback gateway; profiles-dir resolution (local `./profiles` wins, cortex bundle as fallback) |
| `src/repl.ts` | the terminal side of the chat loop: readline prompt, raw-mode key wiring, `--resume` via `/hydrate` |
| `src/stream-run.ts` | one run's stream to terminal — approval cards → exact decision route, esc-cancel, reconnect `since=`; injectable `KeyChannel`/`askLine` so it's provable over the real wire |
| `src/render.ts` | **the testable heart** — one gateway event in, appended scrollback out; pure w.r.t. terminal (injected sink + style) |
| `src/style.ts` | plain ANSI styling; `NO_COLOR` + non-TTY collapse to identity |
| `src/theme.ts` | design-system tokens (carbon/bone/cobalt) as truecolor Style; cobalt is the single accent in the shared rendering contract |
| `src/markdown-ansi.ts` | streaming markdown → ANSI (bold/italic/code/headers/bullets/fences/tables/links), line-buffered — the transcript never shows raw `**` |
| `src/banner.ts` | the launch banner: ▌ ownware vX · profile · model · cwd · gateway |
| `src/session-store.ts` | `<dataDir>/cli/sessions.json` — last thread per (cwd, profile) |
| `src/gateway-log.ts` | routes the owned gateway's `console.*` to `<dataDir>/cli/gateway.log` — the transcript never carries log noise |
| `src/gateway-child.ts` | gateway runner spawned under `node` by the Bun TUI (cortex needs better-sqlite3, Node-only); one JSON handshake line, SIGTERM stops |
| `src/tui/shell.ts` | S2 OpenTUI split-footer shell (Bun+TTY only, `--simple` opts out): transcript = captured stdout → real scrollback; composed bottom = live group two-liner → pinned approval card → `❯` input → status line, dynamic footer height |
| `src/tui/collapse.ts` | the collapse law as a pure renderer (`CollapsingRenderer`): grouped rows suppressed → one settle line; lone-tool exception; errors never collapse; one-line thinking with `**Title**` parsing; live-group callback for the footer |

## Rules

- **Append-only scrollback.** The fallback renderer never repaints, never
  moves the cursor. Native scroll/copy/search must survive. (The OpenTUI
  shell in S2 composes only the bottom stack; the transcript stays
  append-only there too.)
- **Consume the RAW `client.events()` stream** — the normalized
  `streamReply()` drops tools/thinking/subagents. Run termination goes
  through the client's `interpretSseEvent` so every consumer agrees on
  "the reply is finished".
- **Unknown event types render nothing** (the wire grows additively);
  `--debug-events` surfaces them. Never crash on a malformed payload.
- **The prompt is never a dead end.** A failed run prints the honest
  error (provider-not-configured already carries the keyless/ollama
  instructions) and returns to the prompt.
- **Sanitized wire truth only.** The CLI renders what the gateway ships
  (`inputSummary`, "arguments withheld by the gateway"); it must never
  fetch or display unredacted surfaces. Denied tools render as
  strikethrough decisions, not errors.
- **Session state lives under the gateway's `dataDir`** so test isolation
  (temp dataDir) automatically isolates CLI state. Tests never touch the
  real `~/.ownware` (repo guardrail #4) — pass temp `profilesDir` AND
  `dataDir` to `ensureGateway`.
- Bin is `ownware-cli` until the owner decides whether it takes over the
  `ownware` bin (open question on the board).

## Testing

```bash
bun run test:unit          # renderer fold + arg parsing (no I/O)
bun run test:integration   # real gateway over the wire, temp dirs;
                           # ollama chat e2e self-skips without llama3.2
bun run journeys           # the experience harness — see below
bun run journeys:list      # what it can drive, and what each needs
```

The renderer is tested by folding recorded event streams through a
string sink with `PLAIN_STYLE` and asserting the exact transcript. Add a
recorded-stream test for every new event type you render.

### The journey harness (`e2e/`)

Unit and integration tests prove the machinery. They cannot prove the
**experience**, because every question that matters to a customer — is
this readable, is it obvious what to do next, does it look broken — is a
question about the *painted screen*, and the CLI's real screen only
exists behind a TTY. Piped stdio takes a different code path entirely.

So `e2e/` drives the REAL binary in a REAL pseudo-terminal and replays
the captured bytes through a terminal emulator to reconstruct the grid:

| File | Responsibility |
|---|---|
| `e2e/harness/pty.ts` | spawn the binary under a pty at a chosen size; type real key bytes; `waitForText` waits on the PAINTED grid, not the stream |
| `e2e/harness/screen.ts` | bytes → grid via `@xterm/headless`; per-cell colour; `isWrapped` from the terminal itself; hygiene flags |
| `e2e/harness/journey.ts` | isolation (temp dataDir as BOTH `--data-dir` and env; dead `OWNWARE_GATEWAY_PORT` so the probe can never latch onto a real running gateway), artifact capture, non-throwing checks |
| `e2e/journeys/*.ts` | one customer doing one real thing, each declaring `customer` and `badLooksLike` |
| `e2e/run.ts` | round runner → `e2e/artifacts/` + `SUMMARY.md` |

**Rules for this lane:**

- **Hygiene flags are signals, never verdicts.** They flag shapes that
  have historically meant "broken to a human". No flags does not mean
  the screen is good — that judgement needs a reader.
- **`ctx.check()` never throws.** One failed expectation must not hide
  the six after it.
- **Wrapping is read from the terminal**, not guessed from string
  length: once the grid exists the wrap already happened, so
  `line.length > cols` can never fire. Prose may wrap; a structural row
  (`▌ ❯ ● ◇ ✓ ⎿ …`) may not.
- **A timeout is a finding, not an error.** `PtyTimeout` carries the
  screen the customer was staring at when it gave up.
- **Guardrail #4 is verified at the effect**, not claimed: the round
  stamps the real `~/.ownware/ownware.db` before and after and fails
  loudly if it moved.
- Findings land in
  `.catalyst/work/active/ownware-cli-2026-07-26/FINDINGS.md` (the
  experience ledger) — `BUGS.md` stays for defects.

## PR guidelines

- New file ⇒ corresponding test file.
- Renderer changes must keep the append-only law and the malformed-payload
  no-crash test green.
- Wire-facing changes (new event consumed, new endpoint) must reference
  the contract in `@ownware/client` spec/ — never invent wire shapes here.
