<!--
PR title: Conventional Commits — type(scope): user-facing description
  fix(gateway): non-loopback bind no longer boots without TLS
Types: feat, fix, docs, test, refactor, chore.
Scopes: engine, kernel, gateway, cli, client, channels, profiles, schedules, docs.
Describe the user-visible symptom, not the implementation:
  ✅ fix(channels): Slack replies dropped when thread has 100+ messages
  ❌ fix: add null check

Link context with a visible "Closes #<issue>" or "Related: #<issue>" line.
-->

## What Problem This Solves

<!-- The concrete user/operator problem. For fixes: "Fixes an issue where
<doing X> would <break Y> when <condition>." Name the affected surface
(CLI, gateway API, a channel, schedules…). Not the code-level cause. -->

## Why This Change Was Made

<!-- One or two sentences: the shipped solution, key design decisions,
boundaries/non-goals. No file-by-file narration. -->

## User Impact

<!-- What users/operators/developers can now do or expect. If there is no
user-visible impact, say so plainly. -->

## Evidence

<!-- The most useful proof this works: focused tests, terminal output, the
real flow driven end-to-end (e.g. `ownware serve` + the printed curl),
screenshots for UI, redacted logs. Reviewers read the code and CI — use
this to make validation easy, not to restate the diff. -->

## Checklist

- [ ] `bun run build && bun run typecheck && bun run test` passes
- [ ] New behavior has tests; a new file has a test file
- [ ] I drove the real flow once (not just green units)
- [ ] One topic only — no unrelated changes
- [ ] Respects the one-way rule (`client → cortex → loom`, never backwards)
- [ ] **No secret can reach plaintext** (logs, events, tool results, DB)
- [ ] **No test touches the real `~/.ownware/`** (temp `dataDir`+`profilesDir` / `createTestGateway()`)
- [ ] Docs/README updated if behavior changed — or N/A
- [ ] Wire-contract types changed additively only — or reviewed across consumers, or N/A
- [ ] AI-assisted? Disclosed above; I understand every changed line; I'll resolve my own review threads
