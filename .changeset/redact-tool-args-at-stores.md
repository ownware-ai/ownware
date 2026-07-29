---
"@ownware/cortex": minor
"@ownware/loom": minor
---

Redact secret-shaped values out of tool-call arguments and results before any
gateway store keeps a copy: a new `redact-event` seam runs at both durable
write paths (`EventIngestor.ingest` for `agent_events`/SSE and
`SessionRunner.accumulateEvent` for the `messages` table), with a second pass
on reassembled streamed arguments at `tool.call.end`. The engine now
sanitizes every tool result centrally before the model sees it, the cross-zone
combination opt-in is fixed to actually take effect, the plaintext
`GET /providers/:provider/key` endpoint now requires an audit sink and records
every reveal, and the raw `/api/v1/debug/*` event routes are no longer
registered unless `OWNWARE_ENABLE_DEBUG_ROUTES=1` is set.
