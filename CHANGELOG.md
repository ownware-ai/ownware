# Changelog

All notable changes to Ownware are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once versions are published.

## [Unreleased]

### Added
- `ownware version` / `ownware --version` (`-V`) — prints the installed version.
- `OWNWARE_PORT` / `GATEWAY_PORT` are now honored by `ownware serve` (previously only the
  raw `server.js` entry read them).
- The `ownware` umbrella package now ships the `ownware` CLI directly (a thin bin over
  `@ownware/cortex`), so `npm i -g ownware` gives you a working command.
- `.env.example`, `docs/faq.md`, `docs/troubleshooting.md`, and this changelog.
- Docs now explain data/migrations/backups: migrations are automatic, the DB is snapshotted
  to `~/.ownware/backups/` before each upgrade (auto-restore on failure), and the downgrade
  guard keeps data safe.

### Changed
- Documentation truthfulness pass across the whole `docs/` tree and package READMEs:
  corrected tool-preset descriptions (`coding` includes shell), the multi-agent /
  prompt-fragment / zone / HITL / pricing code samples, streaming event names, the channel
  list (Discord + WhatsApp ship), the 3011-vs-4000 port story, and provider counts.

## [0.1.0] — unreleased

Initial pre-release: the from-scratch agent engine (`@ownware/loom`), the kernel + gateway
and `ownware` CLI (`@ownware/cortex`), the umbrella package (`ownware`), the typed wire SDK
(`@ownware/client`), and the messaging channel adapters (`@ownware/shuttle`). Keyless first
answer via Ollama, bind-safety invariant, encrypted credential vault, zone-based security,
proactive schedules, and five in-process channel adapters.

[Unreleased]: https://github.com/ownware-ai/ownware/compare/v0.1.0...HEAD
