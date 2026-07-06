#!/usr/bin/env node
// License drift guard (governance board G0).
//
// Asserts the license story stays coherent across the workspace:
//   1. Root LICENSE is Apache-2.0 and NOTICE exists.
//   2. Every workspace package.json declares license "Apache-2.0".
//   3. Every publishable (non-private) package ships a LICENSE file
//      byte-identical to the root LICENSE.
//
// An enterprise legal team greps for exactly this consistency; a mismatch
// (one MIT field, one stale LICENSE copy) is an adoption blocker. Run via
// `bun run check:licenses`; wire into CI as a required check (board G7).

import { readFileSync, existsSync } from "node:fs";
import { globSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED = "Apache-2.0";
const failures = [];

// 1. Root LICENSE + NOTICE
const rootLicensePath = join(root, "LICENSE");
if (!existsSync(rootLicensePath)) {
  failures.push("root LICENSE is missing");
}
const rootLicense = existsSync(rootLicensePath)
  ? readFileSync(rootLicensePath, "utf8")
  : "";
if (rootLicense && !rootLicense.includes("Apache License")) {
  failures.push("root LICENSE does not look like Apache-2.0");
}
if (!existsSync(join(root, "NOTICE"))) {
  failures.push("NOTICE is missing (Apache-2.0 attribution file)");
}

// 2 + 3. Workspace packages
const manifests = [
  "package.json",
  ...globSync("packages/*/package.json", { cwd: root }),
  ...globSync("adapters/*/package.json", { cwd: root }),
  ...globSync("examples/*/package.json", { cwd: root }),
];

for (const rel of manifests) {
  const pkg = JSON.parse(readFileSync(join(root, rel), "utf8"));
  const label = `${rel} (${pkg.name ?? "?"})`;

  // Private packages may omit the field entirely; a *wrong* value is still drift.
  if (pkg.license !== EXPECTED && !(pkg.private === true && pkg.license === undefined)) {
    failures.push(`${label}: license is ${JSON.stringify(pkg.license)}, expected "${EXPECTED}"`);
  }

  // Publishable packages must ship a LICENSE identical to root.
  if (rel !== "package.json" && pkg.private !== true) {
    const licPath = join(root, dirname(rel), "LICENSE");
    if (!existsSync(licPath)) {
      failures.push(`${label}: missing LICENSE file`);
    } else if (readFileSync(licPath, "utf8") !== rootLicense) {
      failures.push(`${label}: LICENSE differs from root LICENSE`);
    }
  }
}

if (failures.length > 0) {
  console.error("License check FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`License check OK — ${manifests.length} manifests, all ${EXPECTED}; LICENSE copies match root; NOTICE present.`);
