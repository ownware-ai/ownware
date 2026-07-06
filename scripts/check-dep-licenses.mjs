#!/usr/bin/env node
// Dependency license-compat guard (governance board G10).
//
// Scans the PRODUCTION dependency tree of every publishable package and
// fails on any license not in the allowlist — fail-closed: an unknown or
// new license class must be reviewed and either added here (with a
// THIRD_PARTY_NOTICES.md entry if it warrants one) or the dependency
// replaced. Copyleft that would contaminate Apache-2.0 distribution
// (GPL/AGPL/SSPL as sole license) is never allowed.
//
// Documented exceptions (see THIRD_PARTY_NOTICES.md):
//   - LGPL-3.0-or-later: sharp's dynamically-linked libvips binaries.
//   - (BSD-3-Clause OR GPL-2.0): node-forge dual license — we elect BSD.

import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGES = [
  "packages/loom",
  "packages/cortex",
  "packages/ownware",
  "packages/client",
  "adapters/shuttle",
];

const ALLOW = [
  "MIT",
  "Apache-2.0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Unlicense",
  "Python-2.0",
  // Documented exceptions — THIRD_PARTY_NOTICES.md:
  "LGPL-3.0-or-later",
  "(BSD-3-Clause OR GPL-2.0)",
  // Dual/multi licenses where a permissive option exists:
  "(MIT OR WTFPL)",
  "(BSD-2-Clause OR MIT OR Apache-2.0)",
  "(MIT OR CC0-1.0)",
  "(Apache-2.0 OR MIT)",
  "(MIT OR Apache-2.0)",
].join(";");

let failed = false;
for (const pkg of PACKAGES) {
  try {
    execFileSync(
      "bunx",
      ["license-checker-rseidelsohn", "--production", "--onlyAllow", ALLOW],
      { cwd: join(root, pkg), stdio: ["ignore", "ignore", "pipe"] },
    );
    console.log(`OK  ${pkg}`);
  } catch (err) {
    failed = true;
    const stderr = err.stderr?.toString().trim() ?? String(err);
    console.error(`FAIL  ${pkg}\n${stderr}\n`);
  }
}

if (failed) {
  console.error(
    "\nDependency license check FAILED — a dependency carries a license outside the allowlist.\n" +
      "Review it: replace the dep, or (if genuinely compatible) add the license here AND record\n" +
      "the rationale in THIRD_PARTY_NOTICES.md. Never allow sole-GPL/AGPL/SSPL in distributed code.",
  );
  process.exit(1);
}
console.log(`\nDependency license check OK — ${PACKAGES.length} packages, production trees clean.`);
