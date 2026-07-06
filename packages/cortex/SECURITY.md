# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in the Ownware kernel (`@ownware/cortex`), please report it responsibly.

**DO NOT** open a public issue for security vulnerabilities.

**Email:** security@ownware.dev

### What to include

- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Severity assessment (Critical / High / Medium / Low)
- Any proof-of-concept code

### Response timeline

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 5 business days
- **Fix timeline:** depends on severity
  - Critical: patch within 72 hours
  - High: patch within 1 week
  - Medium: patch within 2 weeks
  - Low: next scheduled release

## Security Architecture

The Ownware kernel (`@ownware/cortex`) loads agent profiles from disk and assembles them into running engine sessions. Security-sensitive operations include:

### Profile Loading

- **Config validation:** All `agent.json` fields are validated with Zod schemas. Invalid configs fail immediately — no silent degradation.
- **File path resolution:** Custom tool paths are validated to exist within the profile directory.
- **Environment variables:** `${VAR}` patterns in configs are resolved strictly — missing vars cause hard errors, not empty strings.

### Tool Assembly

- **Preset filtering:** Tool presets (full/coding/readonly/none) control the base set. Deny patterns always win over allow patterns.
- **Custom tool validation:** Dynamically imported tools are type-checked against the engine's Tool interface.
- **MCP server env:** Environment variables for MCP servers are validated before server launch.

### Security Levels

The kernel maps security levels to the engine's permission system:

| Level | Permission Mode | Rule Set | Use Case |
|-------|----------------|----------|----------|
| `permissive` | `auto` | None | Sandboxed environments |
| `standard` | `ask` | `CODING_AGENT_RULES` | Development |
| `strict` | `ask` | `ENTERPRISE_AGENT_RULES` | Production |
| `paranoid` | `deny` | `ENTERPRISE_AGENT_RULES` | Regulated industries |

### What This Package Does NOT Handle

- **Runtime tool execution security** — handled by the engine (shell validation, output redaction, workspace isolation)
- **Network security** — handled by the deployment environment
- **Model safety** — handled by the provider (Anthropic, OpenAI, Google)
- **Container isolation** — handled by the sandbox/backend layer

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes (current) |

## Dependencies

The kernel has minimal dependencies:
- `@ownware/loom` — The agent runtime engine
- `zod` — Schema validation
- `yaml` — YAML config parsing

Dependencies are monitored via GitHub Dependabot alerts and a scheduled `bun audit`
workflow (`.github/workflows/audit.yml`); run `bun audit` locally before publishing a release.
