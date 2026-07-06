---
name: init
description: Analyze a codebase and create (or improve) an AGENTS.md file documenting the architecture, build/test commands, and conventions a future agent would need to be productive immediately.
trigger: /init
allowedTools:
  - shell_execute
  - readFile
  - writeFile
  - editFile
  - glob
  - grep
  - agent_spawn
---

# Initialize agent docs for this codebase

Your job is to produce an `AGENTS.md` (or improve the existing one) that gives a future agent the minimum it needs to be productive in this repo without asking questions.

## What goes in AGENTS.md

Two things, no more:

1. **How to work in this repo** — the commands that get used most: install, build, run, test, lint, type-check. Include the command for running a *single* test, not just the whole suite. If there's a dev server, how to start it. If there's a migration step, where it lives.
2. **The architecture that takes more than one file to figure out** — module boundaries, dependency direction, where the core abstractions live, how data flows. The big picture, not every directory.

If the repo has a `README.md`, a `CONTRIBUTING.md`, a `package.json` script section, Cursor rules (`.cursor/rules/`, `.cursorrules`), or Copilot instructions (`.github/copilot-instructions.md`) — read them and pull the load-bearing parts into AGENTS.md. Don't duplicate; reference where useful.

## What does NOT go in AGENTS.md

- Generic engineering advice ("write tests for new code", "use descriptive names", "handle errors").
- File trees or component lists that anyone can produce by running `ls`.
- Speculation. If you couldn't verify a "common task" or a "tip" by reading actual source, don't invent it.
- Security platitudes. The agent already has a security posture; don't restate it.
- Sections for the sake of having sections. If you have nothing concrete for "Performance" or "Testing tips," omit it.

## Process

1. **Survey first.** Run `ls`, read the top of `README.md`, `package.json`, `pyproject.toml`, `Cargo.toml`, or whatever the repo uses. Spawn an `explore` subagent in parallel to map the directory tree and surface the major modules.
2. **Pick the load-bearing files** — the ones a new contributor MUST read. Usually 3–8 files. Read them.
3. **Find the commands that actually work** — check the `scripts` section of `package.json`, the `[tool.poetry.scripts]` of `pyproject.toml`, the `Makefile`, or the CI workflow. Don't guess `npm test`; verify it's defined.
4. **Identify what's non-obvious** — patterns that took you reading more than one file to understand. Those are the things worth documenting; everything else is discoverable.
5. **Check for an existing AGENTS.md or CLAUDE.md.** If one exists, **propose improvements rather than overwriting wholesale.** Show the user the diff before writing.
6. **Write or update.** Keep it tight — a good AGENTS.md is closer to 60 lines than 300.

## Format

```md
# AGENTS.md

[One-paragraph summary of what this repo is.]

## Build / test / run

- Install: `<command>`
- Build: `<command>`
- Test (all): `<command>`
- Test (single): `<command>`
- Lint / typecheck: `<command>`
- Run dev server: `<command>` (if applicable)

## Architecture

[2–5 paragraphs covering module boundaries, dependency direction, and the
patterns a contributor needs to know. Reference specific files with
`path/to/file.ts` so they can navigate.]

## Conventions

[Repo-specific rules: ESM vs CJS, linter rules that aren't in config,
naming conventions, where tests live relative to source, anything else
that's enforced by humans not tooling.]
```

Adapt the section names if the repo's nature calls for it (a library has different needs than an app). But resist adding sections you don't have content for.

## When done

- Show the user the resulting file (or the diff if you updated an existing one).
- Don't claim the doc is comprehensive. Claim only what you verified.
- If you found things that probably belong in AGENTS.md but you couldn't confirm them by reading source, list them as questions at the bottom of your response — not in the file.
