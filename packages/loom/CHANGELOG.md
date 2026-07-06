# Changelog

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
