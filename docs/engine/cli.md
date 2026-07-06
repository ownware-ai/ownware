---
title: CLI
description: Run a Loom agent straight from the terminal with npx @ownware/loom — models, tools, permission modes, and JSONL event output.
type: reference
---

# CLI

Loom ships a CLI for running an agent without writing a script.

```bash
npx @ownware/loom "What is 2+2?"
npx @ownware/loom --model openai:gpt-4o "Explain quantum computing"
npx @ownware/loom --tools "Read package.json and explain this project"
npx @ownware/loom --system "You are a poet" "Write a haiku about TypeScript"
npx @ownware/loom --tools --max-tokens 32000 "Fix the bug in src/index.ts"
npx @ownware/loom --json "Hello" | jq '.type'
```

## Flags

| Flag | Purpose |
|---|---|
| `-m, --model` | Model string. Default: **auto-selected** — the first provider with a key in your env, else local Ollama. |
| `-t, --tools` | Enable built-in tools (filesystem + shell). |
| `-s, --system` | Custom system prompt. |
| `--max-turns` | Max model calls (default: 50). |
| `--max-tokens` | Max output tokens per turn (default: 16384). |
| `--mode` | Permission mode (`ask` / `auto`). **Note:** parsed but not yet wired into the run — the CLI currently runs unattended regardless; use the library API for real permission control. |
| `-v, --verbose` | Show sessions, turns, permissions, compaction. |
| `--json` | Emit events as JSONL. |
| `-h, --help` | Show usage. |

`--json` streams the same [event vocabulary](streaming.md) as JSONL — pipe it into `jq` or any consumer to script on top of the agent.

## Next steps

- [Getting started](getting-started.md) — the library API behind the CLI.
- [Streaming events](streaming.md) — what `--json` emits.
