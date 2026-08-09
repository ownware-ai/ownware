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
├── display/
│   ├── icon.svg
│   └── icon.png
├── skills/
│   └── create-document/
│       └── SKILL.md
├── references/
│   └── document-workflow.md
├── assets/
│   └── templates/
│       └── project-brief.md
├── schemas/
│   └── document-plan.schema.json
└── scripts/
    └── document_probe.py
```

`ownware-plugin.json` is strict: unknown fields, non-contained paths, duplicate task
identities, invalid semantic versions, and missing declared files are rejected.

```json
{
  "schemaVersion": 3,
  "id": "documents",
  "version": "1.0.0",
  "name": "Documents",
  "description": "Create and revise structured documents.",
  "display": {
    "category": "documents-files",
    "icon": "display/icon.svg",
    "composerIcon": "display/icon.png",
    "accent": "blue"
  },
  "tasks": [
    {
      "id": "create-document",
      "label": "Create a document",
      "description": "Plan, draft, and verify a structured document.",
      "skill": "skills/create-document",
      "references": ["references/document-workflow.md"],
      "resources": [
        {
          "kind": "script",
          "path": "scripts/document_probe.py",
          "description": "Inspect and verify the saved document."
        },
        {
          "kind": "template",
          "path": "assets/templates/project-brief.md",
          "description": "Reusable project brief outline."
        },
        {
          "kind": "schema",
          "path": "schemas/document-plan.schema.json",
          "description": "Machine-readable document planning contract."
        }
      ],
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
References and typed resources are verified with the package but enter the
conversation only when the agent invokes that task through the lazy `skill` tool.
The invocation identifies every declared resource by an immutable absolute path;
the ordinary agent tool policy still decides whether and how the agent may use it.

Schema versions 1 and 2 remain accepted for existing packages. Schema version 2
adds the required display block. Schema version 3 adds typed task resources and a
required composer icon. References must be Markdown below `references/`; scripts,
schemas, templates and other assets must be declared from their corresponding
package roots. The loader enforces per-resource byte limits, parseable JSON schema resources,
and combined invoked-content limits before any path reaches an agent.

The catalog icon must be a contained, passive SVG no larger than 32 KiB with a
`0 0 24 24` view box. Only a small geometry element and attribute allowlist is
accepted; scripts, animation, event handlers, text, embedded objects, external
references and CSS are rejected. The composer icon must be a non-interlaced,
8-bit RGB or RGBA PNG at exactly 256 by 256 pixels and no larger than 256 KiB.
Its chunks, checksums, decompressed row size and filters are verified. All display
and task files are included in the immutable package digest and copied into the
selected Ownware data directory during installation.

The owner-only task catalog projects the selected version's category, accent,
sanitized inline SVG and canonical composer PNG data URL. Schema-v1 packs return
`display: null`; schema-v2 packs return a null composer icon, preserving one stable
client contract across all supported package versions.

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
  background updates, historical per-run task-pack version receipts, or automatic
  install-time package script execution.
- Package digests prove byte equality, not publisher identity or task completion.
