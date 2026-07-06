# Contributing to Loom

Thank you for your interest in contributing to Loom.

## Getting Started

Loom lives in the [Ownware monorepo](https://github.com/ownware-ai/ownware)
(`packages/loom`). The workspace runner is **bun** (≥ 1.3), not npm/pnpm.

```bash
git clone https://github.com/ownware-ai/ownware.git
cd ownware
bun install
bun run build
cd packages/loom
bun run test
```

## Development

Run inside `packages/loom`:

```bash
bun run dev          # Watch mode (tsc --watch)
bun run build        # Full build
bun run test         # Run all tests
bun run test:unit    # Unit tests only
bun run test:e2e     # End-to-end tests (requires ANTHROPIC_API_KEY)
bun run typecheck    # Type check without emitting
bun run lint         # Lint with biome
```

## Before You Submit a PR

1. **Run the full check:** `bun run build && bun run typecheck && bun run test`
2. **Add tests** for any new functionality
3. **Update types** if you changed any public API
4. **No unnecessary dependencies** — Loom has 4 runtime deps. Keep it that way.
5. **No console.log** in library code — use the Logger from `observability/`

## How to Contribute

### Bug Reports

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Loom version, Node.js version, OS

### Feature Requests

Open a Discussion (not an issue) with:
- The problem you're trying to solve
- Your proposed solution
- Why this belongs in Loom (engine) vs Cortex (kernel)

### Pull Requests

1. Fork the repo
2. Create a branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Run: `bun run build && bun run test`
5. Commit with a descriptive message
6. Push and open a PR

#### PR Requirements

- **Title:** concise, starts with type (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`)
- **Description:** explain what and why, not how
- **Tests:** required for all new functionality
- **Breaking changes:** clearly documented in PR description
- **One concern per PR** — don't mix features with refactors

### AI-Assisted Contributions

PRs written with AI assistance (Claude, Copilot, etc.) are welcome. Please:
- Disclose that AI was used
- Review the generated code yourself
- Ensure tests pass
- Don't submit AI output without understanding it

## Architecture Guidelines

### What Goes in Loom vs Cortex

| Loom (engine) | Cortex (kernel) |
|---|---|
| The agent loop | Process management |
| Provider adapters | Profile loading |
| Tool execution | MCP server lifecycle |
| Compaction | Gateway (HTTP, SSE) |
| Message types | UI (web, TUI) |
| Security primitives | Security policy configuration |
| Streaming events | Event routing to consumers |

**Rule of thumb:** If it's about running ONE agent loop, it's Loom. If it's about managing MULTIPLE agents or connecting to the outside world, it's Cortex.

### Code Style

- TypeScript strict mode
- ESM modules (`.js` extensions in imports)
- `readonly` on all interface properties
- Discriminated unions for event types
- `async function*` generators for streaming
- No classes where functions suffice
- No external dependencies unless absolutely necessary

### Testing

- **Unit tests:** mock the provider, test logic in isolation
- **Integration tests:** real tools on real filesystem (temp dirs)
- **E2E tests:** real API calls (skipped without API key)
- Test files live next to source: `foo.ts` → `foo.test.ts` or in `__tests__/`

## Code of Conduct

Be respectful. Be constructive. Focus on the work.

We don't tolerate harassment, discrimination, or personal attacks. Violations result in permanent ban.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
