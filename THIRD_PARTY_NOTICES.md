# Third-party notices

This file records third-party notices for code or substantial implementation
portions incorporated into Ownware source — beyond normal package-manager
dependency metadata — plus documented decisions on dependency licenses.
Referenced from [`NOTICE`](NOTICE). If you adapt external code into this
repo, keep the attribution in the source header **and** add an entry here.

## Incorporated / adapted code

### OpenClaw (browser launcher patterns)

Portions of the browser launcher in `packages/loom/src/browser-launcher/`
(`launcher.ts`, `executables.ts` — the launch-args layout, executable
discovery, and the SIGTERM→SIGKILL fallback pattern) are derived from
`openclaw/extensions/browser`.

- Upstream: https://github.com/openclaw/openclaw
- License: MIT
- Copyright: Copyright (c) 2025 Peter Steinberger

MIT License

Copyright (c) 2025 Peter Steinberger

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Documented dependency-license decisions

These are npm dependencies whose licenses warrant an explicit, recorded
rationale (the full dependency tree is scanned in CI —
`scripts/check-dep-licenses.mjs`):

- **`@img/sharp-libvips-*` — LGPL-3.0-or-later.** Prebuilt libvips binaries
  dynamically linked by `sharp` (itself Apache-2.0). LGPL obligations are
  satisfied for dynamic linking to an unmodified library whose source is
  published (https://github.com/lovell/sharp-libvips); no LGPL terms extend
  to Ownware's code. This is the standard posture across the Node ecosystem.
- **`node-forge` — dual-licensed (BSD-3-Clause OR GPL-2.0).** Ownware elects
  the **BSD-3-Clause** license.

## Conventions & inspiration (not licensed code)

Design conventions credited in the README's "Standing on shoulders" —
OpenClaw's `SOUL.md` personality-file idea, the Claude Code
agent-as-a-folder-of-text lineage, Hermes' proactive-schedules pattern —
are ideas, not copied code, and carry no license obligations. They are
acknowledged there with gratitude.
