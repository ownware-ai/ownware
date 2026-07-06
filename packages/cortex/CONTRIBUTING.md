# Contributing to Cortex Kernel

Thank you for your interest in contributing to the Cortex kernel.

## Getting Started

```bash
cd packages/cortex
npm install
npm run build
npm test
```

## Development

```bash
npm run dev          # Watch mode (tsc --watch)
npm run build        # Full build
npm test             # Run all tests
npm run test:unit    # Unit tests only
npm run test:integration  # Integration tests
npm run typecheck    # Type check without emitting
```

## Before You Submit a PR

1. **Run the full check:** `npm run build && npm run typecheck && npm test`
2. **Add tests** for any new functionality
3. **Update the schema docs** if you changed `schema.ts`
4. **Update CLAUDE.md** if you added a new module or changed responsibilities
5. **No unnecessary dependencies** — Cortex has 3 runtime deps (loom, zod, yaml). Keep it minimal.

## How to Contribute

### Bug Reports

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Package version, Node.js version, OS

### Feature Requests

Open a Discussion (not an issue) with:
- The problem you're trying to solve
- Your proposed solution
- Whether this belongs in Cortex (kernel) vs Loom (engine)

### Pull Requests

1. Fork the repo
2. Create a branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Run: `npm run build && npm test`
5. Commit with a descriptive message
6. Push and open a PR

#### PR Requirements

- **Title:** concise, starts with type (`feat:`, `fix:`, `docs:`, `test:`)
- **Description:** explain what and why
- **Tests:** required for all new functionality
- **One concern per PR** — don't mix features with refactors

### AI-Assisted Contributions

PRs written with AI assistance are welcome. Please:
- Disclose that AI was used
- Review the generated code yourself
- Ensure tests pass
- Don't submit AI output without understanding it

## Architecture Guidelines

### What Goes in Cortex vs Loom

| Cortex (this package) | Loom (engine) |
|---|---|
| Profile loading + validation | The agent loop |
| System prompt assembly | Provider adapters |
| Tool preset resolution | Tool execution |
| Context fragments (git, os) | Compaction |
| Security level selection | Message types |
| Checkpoint store creation | Streaming events |
| Gateway wire types | Security primitives |
| Custom tool loading | Retry logic |

**Rule:** If it's about WHAT agent to run, it's Cortex. If it's about HOW to run an agent, it's Loom.

### Code Style

- TypeScript strict mode
- ESM modules (`.js` extensions in imports)
- Zod validation at every boundary (agent.json, env vars, user input)
- Fail loudly — never silently degrade
- `readonly` on all interface properties

### Schema Changes

When modifying `schema.ts`:
1. Add the field with a sensible default
2. Update `tests/unit/schema.test.ts`
3. Update `docs/schema.md`
4. If it affects assembly, update `assembler.ts` + its tests

## Code of Conduct

Be respectful. Be constructive. Focus on the work.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
