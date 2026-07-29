# @ownware/client

## 0.4.0

### Minor Changes

- cfe469c: Accept DOCX and XLSX source uploads after verifying their ZIP-container
  framing, publish the expanded upload envelope as Ownware Gateway capability
  version 12 / contract revision 0.31.0, and expose the same closed media-type
  union through the client and OpenAPI contract.

  Upload acceptance remains narrower than document understanding: preparation
  continues to refuse these formats with `source_media_unsupported` until a
  bounded extractor is implemented.

- 00d263f: Publish a bounded owner-only connection inventory with provider-neutral status,
  fixed recovery guidance, opaque Ownware identities, and an explicit
  separate-grant requirement.
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

- 00d263f: Add subject-bound delegated principals and an owner-granted, field- and row-scoped Data View query contract with bounded verified cell selection.
- 00d263f: Bind protected source read and search subjects to verified delegated principals and remove subject selection from their request bodies.

### Patch Changes

- 00d263f: Define protected-search `observedAt` as evidence-snapshot creation time and clarify that repeated searches may retain it without making it authorization, cache, response-time, or freshness proof.
- 00d263f: Correct the documented source-upload signature, publish the complete grant and
  protected-content SDK surface, and add executable public source-lifecycle proof
  ownership.
- 98fa75d: Bind delegated-created conversation threads to a digest of the verified
  delegate, workspace, profile, subject, purpose and channel context. Mismatched
  or unbound continuation now denies before mutation. The same binding protects
  run snapshots, event streams, permission decisions and cancellation, while
  delegated runs receive no legacy unscoped identity, profile memory, AGENTS.md
  fallback or memory-proposal tool.

## 0.3.0

### Minor Changes

- Channel connect procedures: a durable, restart-safe engine for connecting
  messaging channels, driven from chat. `connect_channel` (contributed to every
  profile when channel procedures are enabled) starts or resumes a coded
  per-channel procedure that verifies stored credentials with the provider,
  pauses on the existing permission mechanic for the owner's consent (decline
  leaves state unchanged; abandonment leaves the gate waiting — a timeout is
  never a decision), registers the provider webhook, streams work lines, and
  records permanent append-only receipts. Ships the BYO WhatsApp Cloud API
  procedure (live credential probes, two-step callback registration,
  coexistence honesty, transient-vs-permanent Meta error handling). Connecting
  never makes an agent live — publishing stays a separate decision. The client
  SDK additionally surfaces `tool.call.progress` stream events as a new
  additive `progress` member on `RunStreamEvent`, so long procedures narrate
  instead of going silent.
- Add scoped, restart-safe source inspection jobs and compare-and-set source
  refreshes that invalidate inherited readiness and report safe conflict truth.
  Stale refresh placement is removed before conflict confirmation, with explicit
  cleanup-failed truth when absence cannot be verified.
  Add separately authorized bounded text preparation, versioned source-job
  projections, and content-free derived-resource manifests with explicit freshness.
  Advertise effective workspace/profile source quota ceilings, account for reserved
  growth transactionally, and return detail-minimised typed quota conflicts without
  blocking reads or non-growing recovery.
  Add separately authorized source deletion jobs with exact-revision fencing,
  durable replay, pre-destruction cancellation, partial retry, closed progress
  counts, and verified deletion before a minimal tombstone is reported.
  Add a provider-neutral internal access-grant foundation with immutable scoped
  revisions, live expiry/revocation, deny-by-default evaluation and hard floors
  that no permission or autonomy mode can bypass.
  Publish owner-only grant creation, inspection, pagination and exact-revision
  revocation, with durable minimal receipts. Add separately authorized delegated
  UTF-8 source-content ranges whose live grant and current source lineage are
  re-evaluated around the private read, plus SDK, capability and wire-contract
  support for the complete flow.
  Add a separately authorized `source_content.search` flow over one current
  prepared UTF-8 resource. The bounded literal scanner verifies the whole immutable
  object, re-evaluates grants and source truth before releasing results, returns
  stable byte-addressed evidence, and exposes explicit no-match, truncation, and
  no-partial timeout truth without a model or durable index.

## 0.2.0

### Minor Changes

- Add versioned Gateway capability negotiation, immutable run snapshots, and resumable run-scoped SSE.
