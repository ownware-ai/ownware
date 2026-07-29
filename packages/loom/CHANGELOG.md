# Changelog

## 0.4.0

### Minor Changes

- 00d263f: Keep configured safety rules and host permission checks authoritative when `permissionMode` is `auto`; the mode now supplies only the default decision.
- cfe469c: Add a manually wired OpenAI Responses transport for Ownware-native agent loops.
  It translates text, images, custom function calls/results, streaming terminal
  snapshots, refusals, usage, cancellation, and route-provided credentials while
  failing visibly for request and event shapes outside its declared envelope.

  Add the Ownware kernel's strict experimental direct-route constructor over the existing
  OAuth credential boundary. Subscription allowance remains distinct from
  metered API pricing through turn events, session totals, metrics and
  checkpoint restore.

- cfe469c: Redact secret-shaped values out of tool-call arguments and results before any
  gateway store keeps a copy: a new `redact-event` seam runs at both durable
  write paths (`EventIngestor.ingest` for `agent_events`/SSE and
  `SessionRunner.accumulateEvent` for the `messages` table), with a second pass
  on reassembled streamed arguments at `tool.call.end`. The engine now
  sanitizes every tool result centrally before the model sees it, the cross-zone
  combination opt-in is fixed to actually take effect, the plaintext
  `GET /providers/:provider/key` endpoint now requires an audit sink and records
  every reveal, and the raw `/api/v1/debug/*` event routes are no longer
  registered unless `OWNWARE_ENABLE_DEBUG_ROUTES=1` is set.

## 0.3.0

## 0.2.0

All notable changes to Loom will be documented in this file.

## Unreleased

### Added

- Core agent loop with while(true) pattern for streaming tool execution
- Multi-provider support: Anthropic, OpenAI, Google
- 24 streaming event types (discriminated union)
- Built-in tools: readFile, writeFile, editFile, listFiles, glob, grep, shell.execute
- Tool orchestration: parallel reads, serial writes
- 4 compaction strategies: summarize, truncate, sliding window, hierarchical
- Permission system with modes (auto, ask, deny, allowlist)
- Session memory for permission decisions
- Sub-agent spawning with isolation (spawn, fork, inline modes)
- Multi-agent coordination (fan-out, pipeline, map-reduce)
- Checkpoint stores: memory, file (JSONL), PostgreSQL
- Prompt builder with fragment slots and cache control
- Memory system (AGENTS.md loading, correction memory, session recall)
- Skills system (SKILL.md loading, matching)
- MCP client with stdio transport
- Profile loader with validation
- Backend abstraction with zone-based routing
- Security: shell command validation, output sanitization, input sanitization, audit logging
- CLI runner: `npx loom "prompt"`
- Streaming tool argument parser (partial JSON)
- Retry with exponential backoff and model fallback
