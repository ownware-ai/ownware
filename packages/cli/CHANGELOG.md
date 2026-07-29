# @ownware/cli

## 0.2.0

### Minor Changes

- cfe469c: New package: `@ownware/cli` — chat with your own agent in the terminal
  (S1 fallback renderer). `ownware-cli` boots a loopback gateway in-process
  (or attaches with `--base-url`) and drives it purely over the wire
  contract via `@ownware/client`: streamed replies, one-line tool/thinking/
  subagent rows, plain approval cards answered with y/n against the exact
  run-permission decision route, esc/ctrl-c run cancellation, and
  `--resume` that replays the last session in the directory via `/hydrate`.
  Works under plain Node with `NO_COLOR`/non-TTY fallback. Under Bun on a
  TTY it upgrades to the OpenTUI split-footer shell (transcript in real
  scrollback, only the prompt + status footer repaints; the gateway runs
  as a node child process); `--simple` forces the plain renderer. The
  owned gateway's console output goes to `<dataDir>/cli/gateway.log`,
  never into the transcript. Replies render as markdown (bold, bullets,
  code, tables — never raw `**`), the launch banner shows version ·
  profile · model · gateway, and the design-system tokens (carbon/bone/
  cobalt) drive a truecolor theme with a bordered prompt box in the TUI.
  In the TUI, `/model` and `/profile` open a bottom-anchored fuzzy picker
  (mid-session switching; profile switch starts a new thread), `/help` and
  a bare `/` command palette round out the slash commands, tool rows show
  what ran on what (`● shell_execute $ bun run build · 4.2s ✓`) with
  result previews and `… +N lines` counts, and the launch splash is the
  pixel wordmark. The CLI registers its working directory as a gateway
  workspace and sends `workspaceId` on every run (`workspaceId` added to
  the client's RunInput), so in-workspace reads and writes flow at
  standard security level instead of every file access escalating to an
  "outside workspace" approval.

  The client also exposes scoped legacy permission decisions plus live and
  historical sub-agent event readers used by terminal and other wire-contract
  clients.

### Patch Changes

- Updated dependencies [cfe469c]
- Updated dependencies [cfe469c]
- Updated dependencies [00d263f]
- Updated dependencies [00d263f]
- Updated dependencies [00d263f]
- Updated dependencies [98fa75d]
- Updated dependencies [98fa75d]
- Updated dependencies [cfe469c]
- Updated dependencies [cfe469c]
- Updated dependencies [00d263f]
- Updated dependencies [cfe469c]
- Updated dependencies [00d263f]
- Updated dependencies [00d263f]
  - @ownware/cortex@0.4.0
  - @ownware/client@0.4.0
