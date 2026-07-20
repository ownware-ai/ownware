# @ownware/cortex

The kernel and gateway of [Ownware](https://github.com/ownware-ai/ownware) — and the home of the `ownware` CLI. It takes agent profile directories and turns them into running [Loom](https://www.npmjs.com/package/@ownware/loom) sessions, then serves them over HTTP+SSE.

## What It Does

```
agent.json + SOUL.md + skills/
        │
        ▼
   loadProfile()     → validate, load markdown, discover skills
        │
        ▼
   assembleAgent()   → resolve provider, assemble tools, build prompt
        │
        ▼
   Loom Session      → ready to run
```

You define agents as **text files** — a JSON/YAML config, a markdown system prompt, optional skills and custom tools. Cortex validates, assembles, and hands off to [Loom](../loom/) for execution.

## Install

```bash
npm install @ownware/cortex
```

## Quick Start

```typescript
import { loadProfile, assembleAgent } from '@ownware/cortex'
import { Session } from '@ownware/loom'

// Load a profile from disk
const profile = await loadProfile('./profiles/coder')

// Assemble into Loom-ready config
const { config, tools, systemPrompt, provider } = await assembleAgent(profile)

// Create and run a session
const session = new Session({ config, provider, tools })
for await (const event of session.submitMessage('Fix the auth bug')) {
  if (event.type === 'text.delta') process.stdout.write(event.text)
}
```

## Command-line interface (`ownware`)

This package also ships the **`ownware` CLI** — the whole build → talk → serve → reach arc
from one command (no `serve.mjs`/`chat.mjs` glue):

```bash
ownware profile new sales           # build an agent (a folder of text)
ownware run sales "hello"            # talk to it in the terminal — no gateway needed
ownware key add anthropic           # save a provider key (encrypted vault)
ownware channel add slack --profile sales --bot-token xoxb-… --app-token xapp-…
ownware serve                       # gateway + channels, one process
```

| Group | Commands |
|---|---|
| Build agents | `ownware profile new · list · show · set · open · remove` (`ownware init` = `profile new assistant`) |
| Talk | `ownware run <profile> "<prompt>"` · `ownware <profile> "<prompt>"` |
| Serve | `ownware serve` |
| Keys | `ownware key add · list · remove` |
| Channels | `ownware channel add · list · remove · approve · handoff · delivery · start` |
| Schedules | `ownware schedule add · list · remove · runs` |

`ownware help` prints the full list. **Full reference:** [`docs/reference/cli.md`](../../docs/reference/cli.md).

## Profile Directory

```
my-agent/
├── agent.json          # Config — model, tools, security, execution
├── SOUL.md             # System prompt — identity, rules, persona
├── AGENTS.md           # Memory — learned preferences, project context
├── skills/             # Skills — markdown files with YAML frontmatter
│   └── summarize.md
└── tools/              # Custom tools — TypeScript/JavaScript files
    └── my-tool.ts
```

### Minimal agent.json

```json
{
  "name": "my-agent"
}
```

Everything else has sensible defaults. See the [profile format reference](../../docs/agents/profile-format.md) for all options.

### Full agent.json

```json
{
  "name": "coder",
  "description": "Senior engineering partner",
  "model": "anthropic:claude-sonnet-4-6",
  "temperature": 0.3,
  "maxTokens": 16384,
  "maxTurns": 50,
  "tools": {
    "preset": "full",
    "allow": [],
    "deny": ["shell_execute"],
    "custom": [{ "file": "./tools/review.ts" }],
    "mcpServers": [{
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }]
  },
  "context": {
    "git": true,
    "os": true,
    "cwd": true,
    "datetime": true,
    "project": true
  },
  "security": {
    "level": "standard",
    "permissionMode": "ask"
  },
  "execution": {
    "mode": "foreground",
    "timeout": "30m",
    "maxCostUsd": 5.0
  },
  "checkpoint": {
    "store": "file",
    "dir": ".ownware/checkpoints"
  }
}
```

## Profile Registry

Discover and manage multiple profiles:

```typescript
import { ProfileRegistry } from '@ownware/cortex'

const registry = new ProfileRegistry()
await registry.discover('./profiles')

// List all profiles (quick — no full load)
for (const { name, description, tags } of registry.list()) {
  console.log(`${name}: ${description} [${tags.join(', ')}]`)
}

// Load and assemble on demand
const profile = await registry.get('coder')
const agent = await assembleAgent(profile)
```

## Tool Presets

| Preset | Tools included |
|--------|---------------|
| `full` | All built-in tools (filesystem, shell, web, browser, memory, sub-agent, …) |
| `coding` | Filesystem **+ shell** (readFile, writeFile, editFile, glob, grep, listFiles, shell_execute) |
| `readonly` | Read-only filesystem (readFile, listFiles, glob, grep) |
| `none` | No tools |

Filter further with allow/deny globs:

```json
{
  "tools": {
    "preset": "full",
    "deny": ["shell.*"],
    "allow": ["readFile", "editFile"]
  }
}
```

Deny always wins over allow.

## Context Fragments

The system prompt is assembled from context fragments, each controlled by a flag:

| Flag | What it adds | Default |
|------|-------------|---------|
| `git` | Current branch + working tree status | true |
| `os` | Platform, architecture, Node version | true |
| `cwd` | Current working directory | true |
| `datetime` | ISO date + human-readable date | true |
| `project` | Contents of `.ownware/OWNWARE.md` | true |
| `modelInfo` | Model name and capabilities | false |
| `contextUsage` | Token usage stats | false |

## Custom Tools

Define tools as TypeScript files in your profile:

```typescript
// tools/review.ts
import { defineTool } from '@ownware/loom'

export const codeReview = defineTool({
  name: 'code_review',
  description: 'Run a code review on a file',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'File to review' },
    },
    required: ['file'],
  },
  async execute(input) {
    // Your logic here
    return { content: 'Review complete', isError: false }
  },
})
```

Reference in agent.json:

```json
{
  "tools": {
    "custom": [{ "file": "./tools/review.ts", "functions": ["codeReview"] }]
  }
}
```

## Security Levels

| Level | Description |
|-------|-------------|
| `permissive` | All tools allowed, no approval needed |
| `standard` | Built-in safety rules, ask for destructive actions |
| `strict` | Approval for all writes and shell commands |
| `paranoid` | Approval for everything, deny by default |

## API Reference

### Core Functions

```typescript
loadProfile(dirPath: string): Promise<LoadedProfile>
assembleAgent(profile: LoadedProfile): Promise<AssembledAgent>
```

### Profile Registry

```typescript
const registry = new ProfileRegistry()
registry.discover(rootDir): Promise<void>
registry.get(name): Promise<LoadedProfile>
registry.list(): Array<{ name, path, description, tags }>
registry.has(name): boolean
registry.reload(name): Promise<LoadedProfile>
registry.register(name, config, basePath?): void
```

### Utilities

```typescript
applyToolPolicy(tools, allow, deny): Tool[]
loadCustomTools(path, functions?, basePath): Promise<Tool[]>
resolveEnvVars(config, context?): Record<string, string>
parseTimeout(timeout): number  // "5m" → 300000
getGitContext(): Promise<string>
getOsContext(): string
getDateContext(): string
```

## Testing

```bash
npm test                    # All tests
npm run test:unit           # Unit only
npm run test:integration    # Integration (loads real profiles)
npm run typecheck           # Type check
```

## License

Apache 2.0
