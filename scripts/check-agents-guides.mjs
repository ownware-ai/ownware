#!/usr/bin/env node
// Agent-guide convention guard (governance board G8).
//
// Convention: repo coding guides are canonical in AGENTS.md; every CLAUDE.md
// is a symlink to its sibling AGENTS.md, so Claude Code, Codex, Cursor, and
// Copilot all read the same guidance. A real-file CLAUDE.md is drift — two
// guides that diverge silently (that exact bug existed at root before this
// guard: a 25-line AGENTS.md stub next to a 153-line CLAUDE.md).
//
// NOT every AGENTS.md is a repo guide: under profiles/** and
// packages/cortex/profiles/** they are PRODUCT ARTIFACTS (each agent
// profile's own instructions) and must NOT get CLAUDE.md symlinks.

import { readdirSync, lstatSync, readlinkSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".catalyst", "dist", "coverage"]);
// Product-artifact roots: AGENTS.md here is agent content, not a repo guide.
const ARTIFACT_ROOTS = ["profiles/", "packages/cortex/profiles/", "packages/cortex/tests/fixtures/"];

const failures = [];
const claudeFiles = [];
const agentGuides = [];

(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(root, abs);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (!SKIP_DIRS.has(entry.name)) walk(abs);
    } else if (entry.name === "CLAUDE.md") {
      claudeFiles.push(rel);
    } else if (entry.name === "AGENTS.md" && !ARTIFACT_ROOTS.some((p) => rel.startsWith(p))) {
      agentGuides.push(rel);
    }
  }
})(root);

// Rule 1: every CLAUDE.md is a relative symlink to a resolving sibling AGENTS.md.
for (const rel of claudeFiles) {
  const abs = join(root, rel);
  if (!lstatSync(abs).isSymbolicLink()) {
    failures.push(`${rel}: is a REAL FILE — must be a symlink to sibling AGENTS.md (edit AGENTS.md only)`);
    continue;
  }
  const target = readlinkSync(abs);
  if (target !== "AGENTS.md") {
    failures.push(`${rel}: symlink target is "${target}" — must be exactly "AGENTS.md" (relative, survives clone)`);
  } else if (!existsSync(join(dirname(abs), "AGENTS.md"))) {
    failures.push(`${rel}: symlink is broken — sibling AGENTS.md missing`);
  }
}

// Rule 2: every repo-guide AGENTS.md has its CLAUDE.md symlink sibling.
for (const rel of agentGuides) {
  const sibling = join(dirname(join(root, rel)), "CLAUDE.md");
  if (!existsSync(sibling) && !claudeFiles.includes(join(dirname(rel), "CLAUDE.md"))) {
    failures.push(`${rel}: repo guide has no CLAUDE.md symlink sibling (run: ln -s AGENTS.md CLAUDE.md)`);
  }
}

if (failures.length > 0) {
  console.error("Agent-guide check FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(
  `Agent-guide check OK — ${claudeFiles.length} CLAUDE.md symlinks valid; ${agentGuides.length} repo guides paired (profile artifacts exempt).`,
);
