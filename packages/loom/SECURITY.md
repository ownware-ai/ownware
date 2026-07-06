# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in the Ownware engine (`@ownware/loom`), please report it responsibly.

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

The Ownware engine (`@ownware/loom`) is an agent engine that executes LLM-generated tool calls. This creates inherent risk.

### Threat Model

**Primary threats:**
1. **Prompt injection** — malicious content in user documents/web pages causes the model to execute dangerous tool calls
2. **Command injection** — model generates shell commands with embedded attacks
3. **Data exfiltration** — model reads secrets and sends them to external services
4. **Path traversal** — model accesses files outside the workspace

### Built-in Protections

1. **Shell command validation** — dangerous commands (rm -rf, fork bombs, disk destruction) are blocked regardless of permission mode
2. **Output sanitization** — API keys, private keys, and credentials are redacted from tool results before being sent to the model
3. **Input sanitization** — prompt injection patterns and path traversal attempts are detected in tool inputs
4. **Permission system** — tools require explicit approval unless running in auto mode
5. **Workspace isolation** — file operations are restricted to the workspace directory

### Security Levels

The engine ships with configurable security presets:

| Level | Use case | Behavior |
|-------|----------|----------|
| `permissive` | Sandboxed environments | Minimal validation, assumes containment |
| `standard` | Development | Default protections, asks for dangerous ops |
| `strict` | Production | Blocks dangerous patterns, requires approval for writes |
| `paranoid` | Regulated industries | Maximum validation, full audit trail, deny by default |

### What the engine does NOT protect against

- **Model hallucination** — the model may generate incorrect code or commands
- **Sandbox escape** — if running in a container, container security is your responsibility
- **Network-level attacks** — the engine does not firewall outbound connections
- **Social engineering** — if a user intentionally runs in auto mode with no security, they accept the risk

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes (current) |

## Dependencies

The engine has minimal dependencies:
- `@anthropic-ai/sdk` — Anthropic API client
- `openai` — OpenAI API client
- `@google/generative-ai` — Google AI client
- `zod` — Schema validation

Dependencies are monitored via GitHub Dependabot alerts and a scheduled `bun audit`
workflow (`.github/workflows/audit.yml`); run `bun audit` locally before publishing a release.
