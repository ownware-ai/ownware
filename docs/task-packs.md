# Task packs

A task pack is a versioned, immutable bundle of agent skills and their supporting
references or assets. Product UI should present the outcomes—such as **Create a
document**—rather than the package mechanism.

Ownware stores package bytes under its data directory and stores version identity,
scope decisions, trust source, and migration receipts in the selected SQLite or
PostgreSQL database. Top-level run agents receive only the task packs allowed for
their current global, workspace, and agent/profile scopes. Spawned helpers do not
inherit the root agent's lazy task registry; their existing explicit profile and
`grant.skills` rules remain authoritative.

## Package format

```text
documents/
├── ownware-plugin.json
├── skills/
│   └── create-document/
│       └── SKILL.md
├── references/
│   └── document-workflow.md
└── assets/
    └── project-brief-outline.md
```

`ownware-plugin.json` is strict: unknown fields, non-contained paths, duplicate task
identities, invalid semantic versions, and missing declared files are rejected.

```json
{
  "schemaVersion": 1,
  "id": "documents",
  "version": "1.0.0",
  "name": "Documents",
  "description": "Create and revise structured documents.",
  "tasks": [
    {
      "id": "create-document",
      "label": "Create a document",
      "description": "Plan, draft, and verify a structured document.",
      "skill": "skills/create-document",
      "references": ["references/document-workflow.md"],
      "examples": ["Create a project brief from these notes."]
    }
  ],
  "permissions": {
    "tools": ["readFile", "writeFile"],
    "network": []
  },
  "migrations": []
}
```

Each task points to one `SKILL.md`. The skill name must equal the task id.

```markdown
---
name: create-document
description: Create or revise a structured document from a supplied brief.
---

# Create a document

Clarify the audience, draft the artifact, save it, and reopen it for verification.
```

The manifest's permissions are declared requirements; they never grant an agent a
tool. The agent profile's normal tool and security policy remains authoritative.
References are verified with the package but enter the conversation only when the
agent invokes that task through the lazy `skill` tool.

## Supplying built-in packs

Programmatic hosts pass read-only source directories at boot:

```ts
const gateway = new OwnwareGateway({
  profilesDir: './profiles',
  builtinPluginDirs: ['./task-packs/documents'],
})
```

The gateway entry point and `ownware serve` also accept repeatable task-pack flags:

```bash
ownware serve --profiles ./profiles --task-pack ./task-packs/documents
```

Boot installs a new immutable version if needed. The first version receives a global
allow decision; later versions do not silently change the selected version.

## Listing and controlling tasks

`GET /api/v1/task-catalog` returns task-oriented entries and their current scope
decisions. With no query it resolves global policy. Add `workspaceId`, `agentId`,
or both to see the effective catalog for that exact context:

```text
GET /api/v1/task-catalog?workspaceId=workspace-123&agentId=writer
```

Each entry has `effectiveVersion`; it is `null` and `tasks` is empty when that
context is denied. Otherwise tasks come from that exact pinned version, never
from a newer merely installed version.

`PUT /api/v1/task-catalog/:taskPackId/scope` creates or updates one revisioned
decision:

```json
{
  "scopeKind": "workspace",
  "scopeId": "workspace-123",
  "decision": "allow",
  "version": "1.1.0",
  "expectedRevision": 2
}
```

Scope precedence is agent, then workspace, then global, but any applicable deny wins.
Selecting a newer installed version performs a controlled update; selecting an older
installed version is the rollback. Stale revisions return HTTP 409 so clients refresh
instead of overwriting another operator's change.

Task-pack control is install-owner-only. A delegated agent cannot mutate it even when
a delegation names the route operation.

## Current support envelope

- Supported: trusted local/built-in directories, immutable semantic versions,
  global/workspace/top-level-agent controls, lazy root-agent skills, SQLite and
  PostgreSQL.
- Not yet supported: remote marketplace ingestion, publisher signatures, automatic
  background updates, historical per-run task-pack version receipts, or arbitrary
  package script execution.
- Package digests prove byte equality, not publisher identity or task completion.
