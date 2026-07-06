#!/usr/bin/env node
/**
 * `ownware` CLI entry.
 *
 * A deliberately thin shim: `npm i -g ownware` must yield a working `ownware`
 * command, but the real CLI (init · run · serve · key · channel · schedule)
 * lives in @ownware/cortex. Importing cortex's `./cli` runs its top-level
 * `main()` against `process.argv`, so every verb and flag works identically —
 * without duplicating the command surface here. This is why the docs can say
 * `npm i -g ownware` and then `ownware init` and have it be true.
 */
import '@ownware/cortex/cli'
