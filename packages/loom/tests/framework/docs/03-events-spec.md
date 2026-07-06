# Event Types Specification

All 27 LoomEvent types and where they're tested.

## Session Lifecycle (2)

| Event | Fields | Tested In |
|-------|--------|-----------|
| `session.start` | sessionId, model, timestamp | 01-text-streaming |
| `session.end` | sessionId, reason, totalUsage, turnCount | 01-text-streaming |

## Turn Lifecycle (2)

| Event | Fields | Tested In |
|-------|--------|-----------|
| `turn.start` | turnIndex, timestamp | 01-text-streaming |
| `turn.end` | turnIndex, stopReason, usage | 01-text-streaming, 03-single-tool |

## Content Streaming (4)

| Event | Fields | Tested In |
|-------|--------|-----------|
| `text.delta` | text | 01-text-streaming, 02-multi-turn |
| `text.complete` | text | 01-text-streaming |
| `thinking.delta` | text | 05-thinking |
| `thinking.complete` | text | 05-thinking |

## Tool Lifecycle (4)

| Event | Fields | Tested In |
|-------|--------|-----------|
| `tool.call.start` | toolCallId, toolName, input | 03-single-tool, 04-multi-tool |
| `tool.call.args_delta` | toolCallId, delta | (provider streaming) |
| `tool.call.progress` | toolCallId, message | (streaming tools) |
| `tool.call.end` | toolCallId, toolName, result, isError, durationMs | 03-single-tool, 04-multi-tool |

## Permissions (2)

| Event | Fields | Tested In |
|-------|--------|-----------|
| `permission.request` | requestId, toolName, input, reason | 08-permission-approve, 09-permission-deny |
| `permission.response` | requestId, granted | 08-permission-approve, 09-permission-deny |

## Sub-agents (2)

| Event | Fields | Tested In |
|-------|--------|-----------|
| `agent.spawn` | agentId, profileName, parentAgentId | subagents/isolation |
| `agent.complete` | agentId, result, durationMs | subagents/isolation |

## Compaction (2)

| Event | Fields | Tested In |
|-------|--------|-----------|
| `compaction.start` | strategy, preTokenCount | 13-compaction |
| `compaction.end` | preTokenCount, postTokenCount | 13-compaction |

## Recovery (1)

| Event | Fields | Tested In |
|-------|--------|-----------|
| `recovery` | reason, attempt, detail | 12-error-recovery |

## Security (3)

| Event | Fields | Tested In |
|-------|--------|-----------|
| `security.block` | toolName, level, reason | 11-security-block |
| `security.redact` | toolName, redactedCount | (future) |
| `audit.entry` | toolName, decision | (future) |

## Checkpoint (1)

| Event | Fields | Tested In |
|-------|--------|-----------|
| `checkpoint.saved` | checkpointId | (future) |

## Error (1)

| Event | Fields | Tested In |
|-------|--------|-----------|
| `error` | code, message, recoverable | 12-error-recovery |

## StopReason Values

| Reason | When | Tested In |
|--------|------|-----------|
| `end_turn` | Model finished naturally | 01-text-streaming |
| `tool_use` | Model requested tools | 03-single-tool |
| `max_tokens` | Output limit hit | (future) |
| `max_turns` | Turn limit reached | (future) |
| `budget_exceeded` | Cost limit reached | (future) |
| `aborted` | User/system abort | subagents/isolation |
| `error` | Unrecoverable error | (future) |
