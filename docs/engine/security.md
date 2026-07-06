---
title: Security
description: Loom's three composable security layers — input guards, zones with combination rules, and human-in-the-loop permissions — and how to compose the posture you want.
type: concept
---

# Security

Loom has **no opinions** baked in. You compose the posture you want from three independent systems:

```
tools.allow / tools.deny          →  which tools EXIST
ToolGuard (compileToolPolicies)   →  which INPUTS those tools accept
Zones + permissions               →  auto-run vs ask vs never (at call time)
```

Each layer is optional and independent. Use one, two, or all three.

## Layer 1 — input guards

Declarative per-tool policies that reject bad **input** before the tool runs — no permission prompt, no LLM trust. The agent sees a normal `isError: true` result and adapts.

```ts
import { Loom, compileToolPolicies, wrapToolsWithGuards, shellTools } from '@ownware/loom'

const guards = compileToolPolicies([
  {
    kind: 'shell',
    tool: 'shell_execute',
    allowPrefixes: ['ls', 'git log', 'git status', 'git diff'],
    denyPatterns: ['^rm ', '^sudo ', 'git (push|reset|add|commit)'],
    allowDangerous: false,   // leave shell L2 closed (rm -rf, sudo, chmod 777)
    allowInjection: false,   // leave shell L3 closed ($( ) and backticks)
  },
])

const tools = wrapToolsWithGuards(shellTools, guards)
await Loom.run('sonnet', 'list files', { tools })
```

**Policy fields:**

| Field | Role |
|---|---|
| `tool` | Tool name or glob (`shell_execute`, `mcp__github__*`, `*`) |
| `kind` | `"shell"` (the guard kind today) |
| `allowPrefixes` | If non-empty, the command MUST start with one of these — whitelist |
| `denyPatterns` | Regex sources; any match → hard deny. Highest priority. |
| `allowDangerous` | Opens shell L2 (`rm -rf`, `sudo`, `chmod 777`) |
| `allowInjection` | Opens shell L3 (`$(...)`, backticks) |

**Enforcement order:** `denyPatterns` → `allowPrefixes` (if set) → shell L1/L2/L3/L4/L5. **L1 / L4 / L5 cannot be bypassed even with `allowDangerous: true`:** L1 = irreversible (`mkfs`, `reboot`, fork bombs), L4 = exfiltration (`curl | sh` from untrusted hosts), L5 = PII redaction in output.

On deny the agent receives:

```ts
{
  isError: true,
  content: 'Blocked by policy: command not in profile allowlist',
  metadata: { policy: 'deny', reason: '...', ruleId: 'shell:shell_execute:allowlist', tool: 'shell_execute' },
}
```

## Layer 2 — zones

Every tool call is classified into one of **7 zones** at call time. Your policy says which zones auto-allow, which ask, which are forbidden.

| Level | Zone | Examples |
|---:|---|---|
| 0 | **safe** | Read workspace, read-only commands, web search, save memory |
| 1 | **workspace** | Write / edit / delete in workspace, local git ops |
| 2 | **build** | Shell in workspace, package install, run tests |
| 3 | **network** | Fetch URLs, API calls, download packages |
| 4 | **external** | `git push`, create PR, deploy, send messages, MCP writes |
| 5 | **machine** | Read outside workspace, browser with auth, cloud CLI |
| 6 | **never** | `rm -rf /`, `sudo`, `.ssh` writes — always blocked |

```ts
import { ZoneManager, createZoneConfig, ZoneLevel } from '@ownware/loom'

// createZoneConfig(level, overrides?) — level is a SecurityLevel string
// ('permissive' | 'standard' | 'strict' | 'paranoid'); overrides tune thresholds.
const zones = new ZoneManager(createZoneConfig('standard', {
  maxAutoZone: ZoneLevel.BUILD,       // auto-allow up to "build"
  maxAskZone: ZoneLevel.EXTERNAL,     // ask the human for "network" / "external"
  // anything above "external" is denied outright
}))
```

**Combination rules** catch multi-step attacks a single-call check can't: *read a secret (`safe`) + then make a network call (`network`) within N turns → blocked.* Ships with `DEFAULT_COMBINATION_RULES`; extend or replace them.

## Layer 3 — permissions (human-in-the-loop)

When a zone decision is "ask", `HumanInTheLoop` pauses the loop, emits a `permission.request` event, and waits for your UI to answer.

```ts
import { HumanInTheLoop } from '@ownware/loom'

const hitl = new HumanInTheLoop({ timeoutMs: 60_000 }) // auto-deny after 60s (optional)

// Register a handler, then call respond(requestId, approved) with the decision.
hitl.onApprovalNeeded(async (req) => {
  const approved = await myUi.askUser(req.toolCall.name, req.reason)
  hitl.respond(req.requestId, approved)
})
```

Decisions can be remembered for the session (`SessionPermissionStore`), cached per tool, or always re-asked.

## Rule presets — fast start

Don't want to hand-build a posture? Start from a preset:

```ts
import {
  PermissionEvaluator,
  CODING_AGENT_RULES,      // dev tools; blocks destructive cmds; flags secrets
  ENTERPRISE_AGENT_RULES,  // legal/finance; strict shell; PII detection
  SANDBOX_AGENT_RULES,     // minimal; only blocks OS-level destruction
} from '@ownware/loom'

const evaluator = new PermissionEvaluator({ safetyRules: CODING_AGENT_RULES })
```

## Next steps

- [Custom tools](custom-tools.md) — every custom tool flows through these layers.
- [Streaming events](streaming.md) — `security.block` / `security.redact` / `permission.request` events.
- [Multi-agent](multi-agent.md) — sub-agents get isolated tools and their own posture.
