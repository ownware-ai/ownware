# Testing Framework — Overview

## What Is This?

The Cortex Testing Framework is a production-grade test suite that validates
the entire Cortex gateway — from HTTP endpoints to SSE streaming to database
persistence — using real infrastructure and real LLM API calls.

## Why Does This Exist?

Cortex is an Agent Operating System. A desktop UI client will make
hundreds of API calls across 80+ endpoints. If any endpoint returns an
unexpected shape, a missing field, or a wrong status code, the UI breaks
in ways that look like frontend bugs but are actually backend bugs.

This framework eliminates that entire category of bugs by testing every
endpoint, every response field, every user flow, and every edge case
BEFORE the frontend is built.

## The Three Layers

```
┌─────────────────────────────────────────────────────────────┐
│                                                              │
│   LAYER 3: STRESS TESTS                                     │
│   Concurrency, rate limits, large payloads, crash recovery   │
│   "Does it break under pressure?"                            │
│                                                              │
│   ┌──────────────────────────────────────────────────────┐  │
│   │                                                       │  │
│   │  LAYER 2: JOURNEY TESTS                               │  │
│   │  Full user flows: onboarding → profile → workspace    │  │
│   │  → run → dashboard → settings → session               │  │
│   │  "Does the full sequence work?"                       │  │
│   │                                                       │  │
│   │  ┌──────────────────────────────────────────────┐    │  │
│   │  │                                               │    │  │
│   │  │  LAYER 1: CONTRACT TESTS                      │    │  │
│   │  │  Every endpoint, every field, every type      │    │  │
│   │  │  "Does the API return what types.ts says?"    │    │  │
│   │  │                                               │    │  │
│   │  └──────────────────────────────────────────────┘    │  │
│   │                                                       │  │
│   └──────────────────────────────────────────────────────┘  │
│                                                              │
│   ┌──────────────────────────────────────────────────────┐  │
│   │  SHARED HARNESS                                       │  │
│   │  Real gateway + typed client + SSE parser + schemas   │  │
│   └──────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## How It Connects to Client Screens

Every client screen maps to specific tests:

| Client Screen | Contract Tests | Journey Tests |
|---------------|---------------|---------------|
| Splash / Onboarding | onboarding.contract | 01-onboarding |
| Home / Dashboard | dashboard.contract | 08-dashboard-accuracy |
| Profiles | profiles.contract | 02-profile-lifecycle |
| Tools / MCP | mcp.contract | 02-profile (MCP attach) |
| Workspace | workspaces.contract | 03-workspace-flow |
| Chat | run.contract, threads.contract | 04-single-run, 05-multi-turn, 06-tools |
| Settings | settings.contract, providers.contract | 10-settings-persistence |
| Command Palette | search (in threads.contract) | 09-search-and-export |
| Crash Recovery | session.contract | 11-session-recovery |

## Execution Strategy

```
CI Pipeline:
  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
  │  Contracts   │ ──► │  Journeys   │ ──► │   Stress    │
  │  (~5 sec)    │     │  (~60 sec)  │     │  (~30 sec)  │
  │  No API key  │     │  API key    │     │  API key    │
  └─────────────┘     └─────────────┘     └─────────────┘

  Contracts fail? → Stop. Fix the response shape.
  Journeys fail?  → Stop. Fix the state flow.
  Stress fail?    → Log. Fix before production.
```

## Key Design Decisions

1. **No mocks.** Every test hits a real SQLite database and (where needed)
   a real Anthropic API. Mocks hide the bugs we're trying to find.

2. **Isolated per file.** Each test file gets its own temp directory,
   its own database, its own gateway instance. No shared state.

3. **Typed everything.** The API client returns typed responses.
   The SSE parser returns typed events. Zod validates at runtime.

4. **Fixture recording.** Every test run can optionally save its
   responses to `fixtures/`. Frontend teams use these for offline
   development.

5. **Progressive.** Contracts run fast (no API key). Journeys need
   an API key. Stress tests are optional for local dev.
