# PHASE 14 — SESSION, BRANCH & LANE OWNERSHIP

**Status:** preparation only. Do not implement this as an upstream commit
port. The work must be designed for Aira and performed after the current
upstream synchronization is complete.

**Implementation reminder:** when deferred upstream work is eventually
implemented, credit the original upstream author in the local commit message.
Use the original commit hash and author as the reference for that credit.

## 1. Motivation

The Pi upstream session/branch/lane redesign exposed an architectural gap in
Aira. Aira has stronger surrounding infrastructure—Chord services, runtime
generations, operation state, pending writes, and session recovery—but its
current agent layer still mixes global session data, branch data, and agent
execution state.

Current concerns:

- `Session` still implements `SessionTree` and has implicit `main` behavior.
- `AgentHarness` still implements `AgentLane`.
- Durable writes do not have one clearly named session mutation-line boundary.
- Branch ownership and lane execution/configuration ownership are coupled.

## 2. Upstream reference commits

- `423e20c` — separate sessions, branches, and lanes; source for the ownership,
  mutation-line, branch, lane, and recovery boundaries.
- `b37834b` — durable retry and deferred polling; source for captured model
  configuration, explicit polling, deferred frame persistence, and settlement
  invariants.
- `eb1185d` — durable tool execution; source for tool intent, checkpoints,
  safe replay, outcome staging, cleanup, and crash-matrix coverage.
- `8fa7eeb` — persist a selected default into a non-empty model scope; source
  for scoped-model persistence behavior already adapted in Aira.

## 3. Current code reference points

These are the primary seams to revisit when Phase 14 starts. Line numbers are
from the preparation baseline and should be refreshed before implementation.

- `packages/agent/src/harness/session/session.ts:102-131`: `Session` currently
  implements `SessionTree` and creates lane-scoped views.
- `packages/agent/src/harness/session/session.ts:134-195`: implicit-main reads,
  appends, and lane creation/movement.
- `packages/agent/src/harness/session/session.ts:271-299`: lane appends pass
  directly to storage without an explicit session mutation callback.
- `packages/agent/src/harness/session/types.ts:301-352`: mixed session/tree
  public contract that should be split into global Session and Branch surfaces.
- `packages/agent/src/harness/agent-harness.ts:305-353`: `AgentHarness`
  currently implements `AgentLane` and owns the implicit `main` lane.
- `packages/session-backends/sqlite-node/src/sqlite/repo.ts:333-413`:
  serialized SQLite writes, writer-lease checks, and heartbeat lifecycle.
- `packages/coding-agent/src/core/agent-session.ts:1618-1634` and
  `:1728-1743`: current Aira prompt settlement and pending-write flush points.
- `packages/agent/src/harness/session/testing/conformance.ts:700-810`:
  existing branch, append, and storage validation coverage to extend.
- `packages/agent/src/harness/session/types.ts:145-192` and
  `packages/agent/test/harness/reducer.test.ts:490-650`: existing deferred
  records, retry prefixes, and reducer coverage to preserve or expand.
- `packages/agent/src/harness/agent-harness.ts:305-390`: current harness/tool
  ownership boundary and the point where durable execution state is still
  incomplete.
- `packages/coding-agent/src/core/agent-session.ts:2890-2928`: current
  compaction retry/continuation path, which must remain compatible with any
  durable retry redesign.

## 4. Goals

1. Introduce one explicit session mutation line for read-decide-write work.
2. Keep ordinary reads outside that line and expose only fully committed state.
3. Separate global `Session`, path-only `Branch`, and execution-owned `AgentLane`.
4. Remove implicit-main behavior from new APIs.
5. Make lane creation atomic and idempotent.
6. Preserve durable recovery for active operations, pending writes, and failures.
7. Keep providers, tools, hooks, timers, and asynchronous event delivery
   outside mutation callbacks.

## 5. Staged implementation

### Stage 1 — Mutation boundary

- Add an Aira-native `MutationLine` abstraction.
- Audit every session, lane, persistence, recovery, and Chord mutation path.
- Reject nested mutations and external effects inside mutation callbacks.
- Add storage-failure and concurrent-write tests.

#### Stage 1 disposition — implemented

- `423e20c` — **IMPLEMENTED**. Mario Zechner, `feat(agent): separate
  sessions, branches, and lanes`. Aira adopted only the reusable serialized
  mutation-line invariant; the upstream Session/Branch/AgentLane split remains
  deferred to Stage 2.
- `b37834b` — **DESIGN_ONLY**. Mario Zechner, `feat(agent): add durable retry
  and deferred polling`. Its captured-effect and settlement constraints were
  reviewed as follow-up invariants; the deferred runtime is not implemented.
- `eb1185d` — **DESIGN_ONLY**. Mario Zechner, `feat(agent): add durable tool
  execution`. Its intent/effect/outcome separation and prohibition on tool,
  hook, timer, and event effects inside durable callbacks informed the Stage 1
  mutation scope; durable tool execution remains deferred.
- Local implementation commit: this Stage 1 commit.
- Adopted invariant: Session-owned durable writes are serialized in submission
  order; ordinary reads remain outside the line; failed mutations do not poison
  later mutations; nested mutation and external-effect attempts are rejected by
  the mutation scope; backend transactions remain responsible for atomic
  publication and rollback.
- Tests: MutationLine focused coverage includes serialization, nested mutation,
  failed commit visibility, recovery, committed-read visibility, external
  effects, concurrent stress, and sealing. Agent session/storage conformance,
  JSONL, Memory, SQLite, recovery, and coding-agent lifecycle tests remain
  green.
- Dogfood: required post-implementation smoke coverage is recorded in the
  Stage 1 execution report; no intentional UX change is expected.
- Remaining follow-up: Stage 2 owns Session/Branch/AgentLane separation,
  atomic lane acquisition, and removal of implicit-main APIs. No Stage 2 work
  is included here.

#### Stage 2 disposition — implemented

- `423e20c` — **IMPLEMENTED**. Mario Zechner, `feat(agent): separate
  sessions, branches, and lanes`. Aira adapted the ownership boundary to its
  current storage-backed Session and scaffolded AgentHarness: explicit
  SessionBranch access, one mutation-line-backed branch get-or-create path, and
  explicit AgentLane handles with transitional harness delegation.
- Local implementation commit: this Stage 2 commit.
- Session owns global metadata, labels, storage access, branch acquisition, and
  the existing MutationLine. Branch owns only named path identity, tip,
  branch queries, and branch appends. AgentLane owns the explicit branch
  reference and execution-facing lane surface; AgentHarness coordinates the
  runtime and remains a compatibility delegate for existing callers.
- Storage format: unchanged. Existing lane rows and branch tips are reused;
  no migration or fork semantic change was introduced.
- Tests: explicit global/branch ownership, reopen preservation, sibling
  isolation, branch acquisition, and deterministic concurrent lane/branch
  acquisition were added. Memory, JSONL, and SQLite behavior remains
  conformant in focused coverage.
- Stage 3 retry/deferred generation, Stage 4 durable tools, and Stage 5 fork
  redesign remain deferred. Verifier, browser, Workbench, task, Goal, and
  orchestration behavior were not redesigned.

#### Stage 3 disposition — implemented

- `b37834b695a386869fac3681557a255950c947b3` — **IMPLEMENTED**. Mario
  Zechner, authored and committed 2026-08-25 18:35:45 +0200, exact subject
  `feat(agent): add durable retry and deferred polling`. The upstream change
  introduced captured generation configuration, durable retry/deferred phases,
  provider effects outside durable commits, response/usage settlement, and
  recovery tests. Aira adapted those invariants to the existing operation and
  record log instead of importing Pi's runtime-drive tree.
- Related commits inspected: `eb1185d93eec09ceb9369373ac02d31e9ca41785`
  (durable tools), `9b23c65834e0345ff1d7de055500d6928f65e118` (structural
  drive), `3a68f018c045ccb8308dc13ac953ec836bcc8994` (lane inbox/result
  redesign), and `c60dd63fdff6a26331c993422de99732cd109b07` (operation graph
  simplification). They were design/correction evidence only; no later commit
  materially contributed code to Stage 3.
- Aira implementation: `generation_state` records persist intent,
  effect-pending, retry-wait, deferred, cancelled, and settled state. Run
  operation intent captures model/provider identity, thinking level, safe
  request options, and retry policy; credentials and callbacks are excluded.
  `DurableGeneration` is owned by the explicit AgentLane handle and uses
  Session's MutationLine for compare-and-set transitions and settlement.
- Provider effects, retry waits, and deferred polling are outside MutationLine.
  There is no hidden polling loop or durable retry manager. Runtime callers
  wake and resume from persisted state; repeated or concurrent resumes lose
  the durable transition and do not start a second provider effect.
- Response, usage, generation state, and terminal operation settlement are
  committed through the existing Session mutation boundary. A crash after an
  external provider completion but before settlement retains an effect-pending
  state; Aira does not claim exactly-once provider execution and requires
  explicit recovery/resume for that at-least-once ambiguity.
- Compatibility: existing records and sessions remain readable; the new
  record is extensible JSONL/SQLite payload data and requires no migration.
  Existing coding-agent UX, compaction, verifier, task, goal, orchestration,
  browser, Workbench, and tool execution behavior were not redesigned.
- Tests: Memory, JSONL, and SQLite cover captured-model stability, retry
  persistence/reopen, terminal settlement, cancellation, deferred state,
  mutation/effect ordering, and concurrent resume deduplication. Existing
  harness/session suites remain green. Stage 4 durable tools and Stage 5 fork
  redesign remain deferred.
- Validation: `npm run check` passed; focused generation, harness/session,
  SQLite, and coding-agent regression suites passed. `npm run build` passed
  after the sandbox-only models.dev DNS failure was retried with network
  access. `./test.sh` completed with exit 1 only on environment-sensitive
  loopback/Unix-socket `EPERM`, network timeout, and real-Chrome fixture tests;
  Aira, SQLite, evals, protocol, telemetry, and TUI suites passed. Built CLI
  `--help`, `--version`, offline startup, `/new`, `/resume`, and clean `/quit`
  smoke checks passed. No process-kill crash test was added; reopen/resume and
  concurrent-resume crash-boundary behavior is covered by unit tests.
- Local implementation commit: this Stage 3 commit. No push was performed.

#### Stage 4 disposition — implemented

- `eb1185d93eec09ceb9369373ac02d31e9ca41785` — **IMPLEMENTED**. Mario
  Zechner, authored and committed 2026-08-25 20:13:16 +0200, exact subject
  `feat(agent): add durable tool execution`. The upstream change was inspected
  in full. Related settled-tool and lane-snapshot handoffs `6e8b9c8` and
  `e26afb6` were reviewed as design evidence but not copied; the later drive
  graph commits remain deferred because Aira has no compatible runtime owner.
- Aira implementation: lane-owned `DurableToolExecution` persists validated
  tool intent, invocation identity, replay policy, bounded checkpoints, staged
  outcomes, and terminal placement state. Tool preparation and argument
  validation are deterministic. The external tool effect runs only after the
  `effect_pending` mutation commits and outside the MutationLine. Unknown or
  missing tools become explicit durable failures. `safe` replay is opt-in;
  unknown or `never` replay policies recover an uncertain effect as
  `interrupted`, making the crash ambiguity visible instead of silently
  duplicating an external effect.
- Parallel tool outcomes are staged independently and materialized in source
  order. A settled tool is not replayed while a sibling is pending, and
  cancellation preserves a durable terminal outcome. Existing tool signatures,
  permission/workspace/PLAN ownership, coding-agent UX, and Stage 3 generation
  state remain unchanged. Existing Memory, JSONL, and SQLite record formats
  remain extensible without migration.
- Tests: focused durable-tool coverage verifies intent/effect ordering,
  mutation-line exclusion, safe and unsafe recovery, checkpoints, parallel
  placement, missing tools, cancellation, and reopen behavior. Existing
  session and generation suites remain the backend compatibility boundary.
- Validation and dogfood are recorded in the Stage 4 execution report. Stage 5,
  verifier redesign, fork changes, TUI/catalog/Chord/Delta work, packaging,
  and broad drive integration remain deferred. No push was performed.

#### Stage 5 disposition — implemented

- `f8da63be590e14080dc06eed8c8986bc2eec8310` — **ADAPTED**. David
  Brailovsky, `feat(agent): require explicit named branches for session forks`.
  Aira now requires `{ scope: "branch", branch }`, preserves that lane name
  in the destination, and keeps tree forks explicit with `{ scope: "tree" }`.
- `f2eae920c61f0434b37b331cc597a4faa0f90830` — **ADAPTED**. David
  Brailovsky, `fix(agent): validate fork entries against named branch ancestry`.
  Aira walks the selected lane ancestry and rejects off-branch, unknown,
  non-message, stale, and invalid before-root targets before publication.
- `1081eb2126748588c6579df7117be42f40a9892e` — **ADAPTED**. David
  Brailovsky, `fix(agent): require configured lanes for branch forks`.
  Aira's Stage 2 storage model has no separate persisted lane-configuration
  namespace; the durable lane row is the configuration/ownership boundary, so
  no second configuration model or runtime object is copied.
- `4e356c0ade5a788098c892bb8e35080bc439e97f` — **ADAPTED**. David
  Brailovsky, `feat(agent): centralize scalar fork namespace policy`.
  Aira has no scalar namespace store; its closed equivalent classifies entries
  as copied, lanes as reconstructed, facts as copied, and all generation/tool
  records as excluded. Stage 3/4 execution state is never fork-copied.
- Related evidence inspected: `f98c2850f5024409d95c9078b8b6417110b353cc`,
  `ef11444b6e0c4345ff1d7de055500d6928f65e118`,
  `5cf1b95c870c75ba912e9c136126af217edde811`,
  `4b7a0a7dbafe6c4fcbc704183c772a4ca4b7c863`, and
  `1df998a96ce918cd836a294336bad23981e13c84`. These informed bounded
  validation and ownership decisions; no streaming subsystem, worker redesign,
  or SQLite lease change was copied.
- Memory, JSONL, and SQLite share the named-branch contract. JSONL validates
  before destination directory creation and atomically publishes a fixed
  snapshot; Memory publishes after validation; SQLite validates before its
  transactional destination insert and rolls back copy failures. Existing
  reservations and collision guards remain active. Legacy JSONL headers still
  reopen with implicit `main`; no migration is required.
- Conformance covers named non-main forks, sibling ancestry rejection,
  destination non-publication, tree forks, before-root/at-tip placement,
  source preservation, collision safety, and reopen behavior. Stage 3
  generation and Stage 4 tool tests were rerun; their durable records remain
  excluded from fork projections. No UX, Stage 6, or Phase 15 redesign was
  included.
- Validation: focused fork/backend and Stage 3/4 suites passed; `npm run check`
  passed. The full build passed; the full test sweep reached all packages, with
  only the known sandbox socket/loopback integration failures; built-CLI help
  and version startup passed; and `git diff --check` passed. No push was
  performed.

#### Stage 6 disposition — implemented

The chronological upstream operation family was inspected in order:

- `9b23c65834e0345ff1d7de055500d6928f65e118` — Mario Zechner,
  `feat(agent): add structural drive foundation`. **SUPERSEDED** by the later
  lane-inbox and simplified operation graph; Aira did not copy the broad Drive
  runtime transplant.
- `3a68f018c045ccb8308dc13ac953ec836bcc8994` — Mario Zechner,
  `docs(agent): redesign WP05 around lane inbox, result records, and neutral leaves`.
  **DESIGN INPUT**. Aira adopted one tagged lane-owned inbox and neutral
  observation over its existing append-only records.
- `c60dd63fdff6a26331c993422de99732cd109b07` — Mario Zechner,
  `feat(agent): simplify durable operation graph`. **ADAPTED**. Family-specific
  runtime routing was not copied; Aira keeps generation/tool state records and
  adds one boundary dispatcher above them.
- `0f0ca0f6b78019b11f494b1476b0263a03a59597` — Mario Zechner,
  `feat(agent): make run boundaries atomic`. **ADAPTED**. The existing Aira
  MutationLine compare-and-set transitions remain the durable result boundary;
  no provider or tool effect runs in it.
- `3625e5b14645a42e2572b62a40df27c535421153` — Mario Zechner,
  `docs(agent): resolve M7 cancellation decisions`. **ADAPTED**. Cancellation
  is an explicit durable abort request and terminal ownership is decided by the
  serialized transition that wins, not by an AbortController alone.
- `8b6910732992521bcf907ce39101f8a633a5ba8d` — Mario Zechner,
  `feat(agent): make durable drive total`. **ADAPTED**. Recovery dispatch is
  exhaustive over generation/tool states and distinguishes resume, wait,
  materialize, cancellation reconciliation, interruption, terminal, and unknown.
- `89356540fb7318e04e9599a1bc742f5e8f358fe2` — Mario Zechner,
  `feat(agent): expose durable lane operations`. **ADAPTED**. Aira exposes the
  narrow `AgentLane.operations` surface without exposing mutable runtime state.
- `d09576def8ccc7774acfd998c051965948c88092` — Mario Zechner,
  `fix(agent): finalize durable lane replication`. **ADAPTED**. Durable facts
  remain authoritative; event/presentation delivery is outside mutation scope.
- `c5a35eabbfcb706fc240ac9417a1815aec4b13ff` — Mario Zechner,
  `feat(agent): fuse structural boundary routing`. **ADAPTED**. No second
  routing graph was introduced; one explicit boundary dispatcher is used.

Aira Stage 6 adds `DurableOperationBoundary` over the existing Session record
protocol. `queue_enqueued` records form an ordered tagged lane inbox;
`queue_consumed` is committed only after an operation exists, so a crash before
consumption leaves intent recoverable and a crash after consumption cannot
consume it twice. Existing operation IDs remain stable across generation,
tool, retry, deferred, and terminal records. Observation distinguishes unknown,
pending, cancellation-requested, interrupted, and immutable terminal results.
Recovery is total over supported generation/tool states and fails closed for
unknown identities. Memory, JSONL, and SQLite use the same semantics without a
schema migration; old sessions remain readable because the new record is
optional and append-only.

Stage 3 generation and Stage 4 tool execution remain unchanged in effect
ownership: provider/tool calls occur outside MutationLine, while their
compare-and-set durable transitions provide the race winner. Compaction,
existing steer/follow-up APIs, Goal/task/verifier orchestration, Workbench, and
child scheduling were not redesigned. No Pi Drive runtime, Stage 7 provider or
process work, verifier redesign, or Phase 15 work was included.

Tests cover inbox ordering, reopen, crash-before-consume, duplicate-consume
rejection, terminal observation, cancellation reconciliation, total recovery,
Memory/JSONL conformance, SQLite persistence, reducer validation, and existing
generation/tool/compaction regressions. Focused validation passed: 8 files,
178 tests, plus the 3-file boundary/reducer/SQLite run with 136 tests. Final
build, full test results, built-CLI dogfood, and commit details are recorded in
the Stage 6 implementation record. No push was performed.

#### Stage 7 disposition — implemented

Stage 7 was limited to runtime, provider, and process-lifecycle behavior. The
current HEAD audit found several requested upstream fixes already represented by
Aira-native code or earlier local adaptations. Only the two remaining correctness
gaps were changed:

- `bea67d90d1a74dde8852c63cac72d476013d3879` — David Brailovsky,
  `fix(coding-agent): cancel compaction on session abort`. **ADAPTED NOW** in
  local commit `d69a95b81`. Session idle tracking now includes compaction and
  branch summarization; `abort()` cancels those controllers and waits for cleanup
  before resolving. Deterministic manual-compaction abort coverage passes.
- `c2d3dc55b0b20af5aa3bb1d25774968116c9733f` — Qiaochu Hu,
  `fix(agent): map signal-killed processes to non-zero exit codes (#8994)`.
  **ADAPTED NOW** in local commit `702f8a21a`. `NodeExecutionEnv` and the Aira
  execution manager preserve the signal and report `128 + signal number`, while
  explicit user cancellation and timeout statuses remain distinct.

### Stage 7 at-a-glance upstream disposition

| Upstream | Disposition | Aira result |
|---|---|---|
| `bea67d9` | adapted now | compaction/branch-summary abort and idle cleanup |
| `e44d75c` | design-only | retain Aira's existing branch-summary budget |
| `2631b25` | already present | local `0bb06b350` preserves compaction boundaries across forks |
| `1a773c8` | already present | local `d8b5f7ec3` protects imported-session collisions |
| `2b768ba` | already present | local `f5056682f` restores external in-memory entries |
| `6f35de5` | already present | local `87b575c67` isolates concurrent share exports |
| `0095bce` | already present in Aira-native form | bounded execution-manager buffers and spill-backed shell capture |
| `d14d6b2` | design-only | documentation/status follow-up depends on the upstream graph |
| `c2d3dc5` | adapted now | truthful signal exit codes in agent and Aira runtimes |
| `8b5899d` | already present in current provider contracts | provider-specific stream compatibility and event-stream tests |
| `0fdec07` | already present in current provider contracts | thinking blocks/signatures and reasoning metadata are retained |
| `4e69b0c` | already present in current turn snapshot path | per-turn reasoning is passed through the captured turn; no settings transplant |

### Stage 7 deep audit

Compaction/session lifecycle commits were inspected in order. `bea67d9` fixed a
real Aira gap. `e44d75c20a51142abc056c243b13c1d7bb4be687` — Vegard Stikbakke,
`fix(coding-agent): raise branch summary output cap` — changes the upstream
branch-summary request to `min(4096, model.maxTokens)` and its settings contract.
Aira's branch summarization and compaction budget are independently configured;
the existing output cap was retained as **DESIGN_ONLY** rather than increasing
token cost without a matching Aira budget decision.

The session lifecycle commits were also inspected in full:

- `1a773c8e7a535e35a15e9babc37231e515b18794` — wutongyuonce,
  `fix(coding-agent): avoid overwriting imported sessions (#8985)`. Already
  present as `d8b5f7ec3`; import collision safety is covered by runtime tests.
- `2b768ba42cdbd7336474d6986a3ef1efbb0a44f7` — Julien Barbay,
  `feat(coding-agent): ingest external entries in in-memory sessions (#8980)`.
  Already present as `f5056682f`; external entries retain ids, parents, labels,
  compaction references, and session headers.
- `6f35de5b598037c28e05f52e23a00301e1275819` — wutongyuonce,
  `fix(coding-agent): isolate concurrent session shares (#8613)`. Already
  present as `87b575c67`; each share uses a private temporary directory and
  cleanup is scoped to that directory.
- `2631b25c34cbfcb660b1f05e1fe77170c1cf1f82` — yaogangqiang,
  `fix(coding-agent): preserve compaction boundary when forking (#8990)`.
  Already present as `0bb06b350`; forked compaction entries rewrite
  `firstKeptEntryId` through removed-label replacements without duplicating or
  losing the boundary.

The process/output family was inspected in full:

- `0095bce7db4fe6a63524b37535315f41b086656d` — Mario Zechner,
  `fix(agent): bound shell execution output`. The upstream patch introduces a
  producer-side adaptive publisher and spill/capture subsystem. Aira already
  bounds managed stdout/stderr with `BoundedOutputBuffer`, retains tails, tracks
  truncation, and uses spill-backed `executeShellWithCapture`; no duplicate
  process subsystem was added.
- `d14d6b22327d545d6a253f932165b63e48d7f9c8` — Mario Zechner,
  `fix(agent): finalize bounded shell output integration`. This is a handoff,
  documentation, and graph-budget follow-up to `0095bce`; it remains
  **DESIGN_ONLY** for Aira.
- `c2d3dc55b0b20af5aa3bb1d25774968116c9733f` — Qiaochu Hu, as above. Tests
  cover SIGKILL in `NodeExecutionEnv` and SIGTERM in the managed process
  manager. Aira cancellation still reports `cancelled` and timeout still
  reports `timed-out`; external signal death is an exited, non-success result.

The provider/stream family was inspected in full:

- `8b5899dce26f9f6b8d313ee6a4b4a8dccbb9bfc2` — Armin Ronacher,
  `fix(ai): restore stream compatibility`. The current Aira provider APIs use
  the compatible stream failure and tool-call framing rules; the upstream
  `AssistantMessageFrameEncoder` tree is not part of Aira's current package and
  was not transplanted.
- `0fdec07ba3973f9bd008cbfffb0eaa10ace8c5b3` — Armin Ronacher,
  `fix(ai): preserve provider thinking level in frames`. Current Aira retains
  thinking blocks, signatures, usage reasoning, and per-provider reasoning
  metadata in the existing event stream and assistant message types.
- `4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057` — Mario Zechner,
  `feat(ai): preserve Anthropic per-turn thinking effort`. Aira already owns
  reasoning per turn through `prepareNextTurnWithContext` and captured generation
  options, but its settings/provider composition differs from the 33-file
  upstream change. No lockfile, settings UI, or catalog transplant was made.

Stage 3 captured provider configuration remains unchanged; Stage 4 durable tool
effects remain outside MutationLine; Stage 6 operation observation, cancellation,
and recovery remain the sole durable boundary. Goal/verifier authority,
Workbench presentation, session import/reopen/fork behavior, and existing
process UX were not redesigned. Stage 8 was limited to the focused TUI and
selector slices recorded below; no Chord/Delta, remote, catalog, verifier, or
Phase 15 work was started.

Focused validation passed for compaction (24 tests), Node execution (30 passed,
1 platform skip), and managed execution (22 tests). The full regression/build,
built-CLI dogfood, and final Stage 7 status are recorded with the implementation
commits above. No push was performed.

#### Stage 8 disposition — implemented

Stage 8 was restricted to additive interaction improvements that fit Aira's
existing fullscreen and Workbench ownership. The implementation was split into
two semantic commits and left the runtime, verifier, remote, and presentation
architecture unchanged:

- `2d41163332c1a6d11c45911a92100fd2a55e4d1a` — Armin Ronacher,
  `fix(tui): make fullscreen transcript search scale linearly` — **ADAPTED NOW**
  in local commit `2545a445c`. Aira now caches the normalized transcript corpus,
  maps matches through compact source spans, uses the ASCII fast path, and uses
  binary search for retained search highlighting/navigation.
- `79680533c6b898894f2d2421c7f640b212d3dfdd` — Armin Ronacher,
  `feat(tui): add clickable jump-to-end indicator to fullscreen transcript` —
  **ADAPTED NOW** in `2545a445c`. The indicator is opt-in and only applies to
  the primary fullscreen transcript; its click target returns to the latest
  output without affecting Inspector or Workbench viewports.
- `ab9e6f89b45344f5e84e33eb6141f3e6e4c8d81e` — Alexey Zaytsev,
  `feat(tui): accelerate Alt-modified wheel scrolling (#9166)` — **ADAPTED NOW**
  in `2545a445c`, using Aira's existing mouse routing and a five-line multiplier.
- `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c` — Ramiz Wachtler,
  `fix(coding-agent): selector save keybindings (#9149)` — **ADAPTED NOW** in
  local commit `b74a888ac`. Model and thinking selector save actions now use
  configurable keybinding IDs and display configured hints.
- `9841914c71a74d81abe07f751aefd271fd924e63` — Alexey Zaytsev,
  `fix(tui): keep list selection unchanged on mouse hover` — **ALREADY ABSENT /
  NOT APPLICABLE**. Aira's `SelectList` and `SettingsList` do not implement the
  upstream hover-selection behavior, so no corrective hunk was needed.
- `1d9787c11fb91ecf7c892050f4c0607a995dd15b` — Cristina Poncela Cubeiro,
  `feat(tui): prettier Working... spinner (#8799)` — **ALREADY PRESENT in
  Aira-native form** through `Loader` and `WorkingStatusIndicator`; no visual
  transplant was made.
- `457ae8c79c2e3c570a36d305095afa18d3791dd1` — Cristina Poncela Cubeiro,
  `feat(tui): alt mode scrollbar but prettier (#8801)` — **ALREADY PRESENT /
  DESIGN_ONLY**. Aira already owns fullscreen scrollbar settings, theme colors,
  and Workbench layout; the broad upstream settings/theme refactor was not
  compatible with those boundaries.
- `f2a622789947b5b4297af6ac3b0091978cdd4216` — Ramiz Wachtler,
  `feat(coding-agent): adjust TUI selections in thinking-mode, models and scoped
  models (#8900)` — **PARTIALLY ALREADY PRESENT**. Aira already had the scoped
  model markers/toggles; only the compatible configurable-save correction was
  applied in `b74a888ac`.
- `eb3e9feed1bd092535ae77232e9dd351bc781e23` — Mario Zechner,
  `feat(coding-agent): split tool renderers and theme validation from their
  implementations` — **DESIGN_ONLY**. The 26-file renderer/theme dependency
  split would cross Aira's custom Workbench and tool-presentation boundary.

Focused validation passed: 55 TUI tests and 6 selector/keybinding tests.
`npm run check`, `npm run build`, built-CLI `--help`/`--version` dogfood, and
`git diff --check` passed. The full `./test.sh` regression passed after rerun
with local socket and browser permissions. The sandbox-only run reached 3,716
passing tests before environment-only `EPERM` failures for loopback sockets,
Unix-domain sockets, and Chrome startup; dependent cases timed out. No push was
performed.

### Stage 2 — Session and Branch separation

- Define explicit global `Session` and path-only `Branch` interfaces.
- Move branch tip, branch queries, and branch appends behind `Branch`.
- Keep session metadata, values, labels, and global queries on `Session`.
- Preserve existing storage formats unless a migration plan is approved.

### Stage 3 — AgentLane ownership

- Make lane configuration, queues, operation state, and execution belong to
  `AgentLane`.
- Make lane acquisition atomic and get-or-create where appropriate.
- Ensure active-run writes are durably staged before placement.
- Keep Aira task, goal, orchestration, and Chord lifecycle semantics intact.

### Stage 4 — Recovery and clients

- Rebuild recovery around the separated durable state.
- Update RPC, remote sessions, experimental clients, and service bindings.
- Add generation and attachment fencing for stale remote frames.
- Remove implicit-main compatibility only after migration coverage is complete.

### Deferred retry and polling follow-up

The upstream durable retry/deferred implementation is too coupled to Pi's
runtime model to port directly, but its invariants are useful for Aira:

- Persist retry state and retry timing across process restart.
- Make deferred polling an explicit one-per-drive operation with no hidden
  polling loop, cap, or backoff.
- Preserve the captured model and request configuration for deferred
  redemption.
- Persist streamed deferred frames so partial results survive recovery.
- Atomically settle response, usage, branch tip, and failure state.
- Fail closed on unavailable models, invalid or mismatched handles, provider
  errors, cancellation, and unknown outcomes.
- Test every crash boundary, repeated pending poll, cancellation race, and
  cleanup path.

### Durable tool execution follow-up

The upstream durable-tool implementation is also too coupled to Pi's new
runtime to port directly. Its useful invariants belong in Phase 14:

- Separate deterministic tool preparation and argument validation from the
  external tool effect.
- Persist tool intent before starting execution, including invocation identity
  and validated arguments.
- Persist partial tool output/checkpoints for safe replay and recovery.
- Stage tool outcomes before source-ordered materialization; never replay a
  completed tool merely because another parallel tool is still pending.
- Treat missing tools as explicit, detail-free error results and unsafe tools
  as interruption recovery rather than silently replaying them.
- Keep tool effects, progress callbacks, hooks, timers, and event delivery
  outside durable mutation callbacks.
- Atomically clean tool arguments, memos, checkpoints, pending payloads, and
  operation state on terminal settlement.
- Add crash-matrix tests for planned, effect-pending, checkpointed,
  outcome-ready, completed, parallel, abort, and reopen states.

## 6. Structural drive foundation reference — upstream `9b23c65`

Do not sync this commit directly. It introduces a large Pi-specific durable
execution graph and would conflict with Aira's current runtime and Chord
architecture. Revisit it during Phase 14 for these design inputs:

- Keep the visible durable procedure order: `prepare -> publish intent ->
  perform effect -> publish outcome`.
- Make structural operations explicit and durable, including compaction,
  branch summarization, navigation, retries, cancellation, and model absence.
- Treat standalone compaction as an inbox-carrying operation. Queued steer and
  follow-up messages should survive the operation and promote atomically into a
  normal assistant turn at the result boundary.
- Capture settings and preparation before hooks or generation so reopen and
  retry use the same request inputs.
- Ensure terminal cleanup, result publication, queue consumption, and branch
  tip updates are atomic; test races at every boundary.
- Keep external effects outside mutation callbacks and use explicit outcome
  records rather than implicit promise settlement.

Relevant upstream references:

- `packages/agent/src/harness/runtime/drive/structural.ts` — structural leaf
  procedures and request/retry/recovery sequencing.
- `packages/agent/src/harness/runtime/drive/checkpoint.ts` — threshold and
  overflow preparation publication.
- `packages/agent/src/harness/runtime/drive/response.ts` — response intent,
  effect, and outcome settlement.
- `packages/agent/src/harness/runtime/drive/retry.ts` — durable retry state
  and retry-cap recovery.
- `packages/agent/src/harness/runtime/lane.ts` — lane observation and inbox
  ownership.
- `packages/agent/test/harness/runtime/drive-structural.test.ts` — crash,
  cancellation, retry, model absence, navigation, and publication coverage.
- `packages/agent/docs/work-packages/05-direct-durable-drive.md` — standalone
  compaction inbox and promotion requirements.

The commit reports 168 focused tests across 16 files and a passing
`npm run check` upstream. Aira should implement only small, independently
reviewed slices after the session/branch/lane separation work above.

### Follow-up redesign reference — upstream `3a68f01`

This documentation commit supersedes part of `9b23c65`'s proposed standalone
compaction promotion design. Do not implement it during sync, but use these
revisions when planning Phase 14:

- Replace operation-owned queues with one lane-owned tagged inbox for steer,
  follow-up, next-run, and write items.
- Make queue selection explicit at each drain boundary and preserve queue modes
  without consuming items before the boundary commit.
- Replace family-specific operation leaves with a smaller neutral leaf set and
  a closed result-boundary datum.
- Persist one immutable result record per terminal operation and make settled
  operation observation total by operation id.
- Treat standalone compaction continuation as a second ordinary run operation,
  rather than promoting a compaction operation into a run.
- Reconcile cancellation, cleanup, watch surfaces, and public admission around
  lane inbox ownership.

Relevant upstream reference: `packages/agent/docs/work-packages/05-direct-durable-drive.md`.
The document explicitly withdraws the standalone-compaction promotion model and
defines milestones R1 (lane inbox), R2 (durable neutral results), and R3
(family-neutral operation leaves). Re-evaluate the earlier `9b23c65` notes
against this redesign before implementing any Phase 14 runtime slice.

### Durable operation graph simplification reference — upstream `c60dd63`

This large implementation commit applies the `3a68f01` redesign across Pi's
agent runtime, protocol, experimental clients, storage, recovery, and tests.
Skip it during synchronization: Aira's durable runtime and public Aira
surfaces are not structurally equivalent, so a broad port would couple
unrelated migration work to upstream internals.

Useful later references:

- `packages/agent/src/harness/runtime/drive/*.ts` — explicit generation,
  deferred, response, retry, structural, terminal, and tool procedures.
- `packages/agent/src/harness/runtime/lane.ts` — lane-owned drive and tagged
  inbox admission/observation.
- `packages/agent/src/harness/runtime/types.ts` — neutral operation state and
  durable result shapes.
- `packages/protocol/src/harness.ts` — public operation-result and lane-event
  schema changes that require an API migration, not a local type rename.
- `packages/agent/test/harness/runtime/` — focused crash, retry,
  cancellation, recovery, and protocol validation coverage.

Do not import this 49-file commit wholesale; implement independently reviewed
Aira slices after the prerequisite Phase 14 architecture work.

### Atomic run-boundary reference — upstream `0f0ca0f`

Skip this dependent runtime milestone during synchronization. It extracts a
shared structural boundary planner and makes run-boundary routing atomic on
top of `c60dd63` and `c5a35ea`.

Useful later requirements:

- Plan queued writes, steer/follow-up selection, threshold decisions, hook
  outcomes, continuation, and terminal finish from one authoritative boundary
  snapshot before committing.
- Keep pending payload validation and branch-tip movement in the same commit as
  queue consumption and lifecycle events.
- Replan after finish hooks against current lane input instead of trusting a
  stale pre-hook decision.
- Test boundary races, event ordering, retry/compaction outcomes, and recovery
  after every commit/effect transition.

Relevant references: `packages/agent/src/harness/runtime/drive/boundary.ts`,
`packages/agent/src/harness/runtime/drive/checkpoint.ts`,
`packages/agent/src/harness/runtime/drive/response.ts`, and
`packages/agent/test/harness/runtime/drive-structural.test.ts`.

### Cancellation decision reference — upstream `3625e5b`

This documentation-only follow-up refines M7 and remains deferred with the
durable-drive redesign. Useful constraints for Aira are:

- Reject cancellation when the expected operation id is stale, including ids
  that already have a settled result record.
- Commit the cancellation marker and removal of steer/follow-up queue items as
  one mutation, then signal the live effect only after the commit succeeds.
- Emit one family-neutral abort event containing drained steer/follow-up
  payloads; repeated cancellation observes the marker and emits nothing.
- Separate operation-abort cancellation from the Drive close-only signal used
  for deferred-provider cleanup, so cleanup can start after cancellation but
  cannot outlive harness shutdown.

Relevant reference: `packages/agent/docs/work-packages/05-direct-durable-drive.md`,
especially its M7 reconciliation and total-switch sections. This depends on
`c60dd63`, `c5a35ea`, and `0f0ca0f`; do not sync it independently.

### Total durable-drive dispatcher reference — upstream `8b69107`

Skip this 27-file runtime milestone during synchronization. It installs the
total direct dispatcher and reconciliation pass over Pi's 13 neutral operation
leaves, removes drained-control state, and completes M7 on top of the earlier
durable-drive redesign.

Useful later requirements:

- Dispatch every durable operation leaf through one exhaustive switch, with
  cancellation reconciliation taking precedence over ordinary procedures.
- Require every procedure continuation to replace durable lane projection or
  expose durable cancellation; unchanged continuation is an invariant defect.
- Keep cancellation atomic: durable marker, steer/follow-up drain, returned
  payloads, family-neutral abort event, and post-commit effect signalling.
- Reconcile structural, retry, deferred, tool, assistant, and terminal states
  after reopen without rereading authoritative storage state.
- Preserve operation-result records and lane snapshots as the observation
  surface for settled operations.

Relevant references: `packages/agent/src/harness/runtime/drive.ts`,
`packages/agent/src/harness/runtime/drive/reconcile.ts`,
`packages/agent/test/harness/runtime/drive-reconcile.test.ts`, and the M7
sections of `packages/agent/docs/work-packages/05-direct-durable-drive.md`.

### Three-process presentation reference — upstream `353c990`

Skip this 14-file experimental client during synchronization. It is a Pi
durable-harness presentation experiment with a Unix-socket TUI, session server,
and one stdio worker per session; Aira's existing product surfaces and runtime
ownership model are different.

Useful Phase 14 lessons:

- Keep live agent objects (storage, harness, lane, model runtime) in the worker;
  presentations should hold only a replicated, bounded snapshot.
- Use one typed RPC connection for calls, results, errors, cancellation,
  announcements, events, and liveness rather than side-channel getters.
- Pair snapshot capture with event-stream startup so a presentation cannot miss
  or duplicate events during attachment; use a single reducer for replication.
- Make service routing symmetric across hops and expose service identity in
  failures, while keeping process ownership explicit and cleanup bounded.
- Treat reconnect, navigation rebase, worker supervision, timeouts, and
  disconnect cancellation as first-class protocol behavior.
- Keep known tradeoffs visible: server event fan-out can become quadratic, and
  interactive requests need an explicit abort path.

Relevant references: `packages/coding-agent/src/experimental/mini/shared/rpc.ts`,
`shared/transport.ts`, `server/run.ts`, `worker/run.ts`, `worker/lane-service.ts`,
and `tui/session.ts`/`tui/view.ts`.

### Addressed event-routing reference — upstream `e055b9f`

This follow-up to `353c990` remains deferred because Aira does not use Pi's
experimental mini three-process topology. Its useful protocol lesson is to
give each presentation subscription an opaque destination id: the worker
addresses subscription events, the server routes addressed events to exactly
one presentation, and shared events continue to broadcast.

Preserve the client-side subscription-id check during rebase because the old
subscription may remain open until unwatch completes. Avoid routing based on
payload parsing; destination metadata belongs in the generic event frame.

Relevant references: `packages/coding-agent/src/experimental/mini/shared/rpc.ts`,
`server/run.ts`, `worker/lane-service.ts`, and `tui/session.ts`.

### Durable lane public-surface reference — upstream `8935654`

Skip this 49-file milestone during synchronization. It exposes Pi's durable
lane through public client, RPC, protocol, worker, session-routing, and
replicated-snapshot surfaces on top of the earlier drive redesign. Aira already
has different RPC, session-worker, browser, execution, and orchestration
surfaces, so this is not a safe wholesale port.

Useful later requirements:

- Keep the durable lane as the single owner of operation state, queues, model
  identity, and live execution; clients should observe snapshots and events.
- Make public operation APIs identity-based and total for settled operations,
  with stale operation isolation and explicit caller cancellation.
- Keep `watch` snapshot/event pairing gap-free, expose a normative reducer, and
  provide an explicit rebase/resnapshot path after navigation or divergence.
- Separate repository/session browsing from lane execution; an RPC facade may
  compose both without putting tree/fork/listing methods on the lane.
- Test remote attach, same-id joins, worker supervision, reconnects, liveness,
  event ordering, cancellation, and snapshot/event fold equivalence.

Relevant references: `packages/agent/src/harness/client.ts`,
`packages/agent/src/harness/runtime/reducer.ts`,
`packages/coding-agent/src/server/session-router.ts`,
`packages/coding-agent/src/experimental/session-worker.ts`, and the focused
client/protocol/remote-runtime tests.

### Durable lane completion reference — upstream `d09576d`

Skip this completion milestone during synchronization. It finalizes Pi's
durable lane replication and enables its public drive after completing M7–M10;
it also reconciles the normative harness documentation. The implementation
depends on the full `c60dd63` through `8935654` chain and is not portable to
Aira's separate runtime.

Useful later outcomes:

- Keep public drive behind a total dispatcher and complete reconciliation
  coverage, rather than exposing partially supported operation leaves.
- Treat `reduceLaneSnapshot` plus gap-free watch/resnapshot as the canonical
  remote presentation contract.
- Derive provider cache identity from session and lane lineage, not only the
  durable session id, so concurrent lanes cannot share an invalid cache path.
- Track durable streaming-frame volume as a separate storage-amplification
  problem; do not weaken unknown-outcome recovery merely to reduce JSONL size.

Relevant references: `packages/agent/src/harness/events.ts`,
`packages/agent/src/harness/runtime/lane.ts`,
`packages/agent/src/harness/runtime/drive-public.test.ts`,
`packages/agent/docs/harness.md`, and
`packages/agent/docs/work-packages/05-direct-durable-drive.md` (M11).

### Structural boundary fusion reference — upstream `c5a35ea`

Skip this dependent runtime slice during synchronization. It builds on
`c60dd63` and fuses structural result routing with queued-input materialization
at one mutation boundary. Useful later constraints are:

- A declined threshold decision should route directly to assistant generation
  when queued conversational input requires continuation, while preserving the
  threshold marker and avoiding a re-entry loop.
- Structural success/decline should select queued writes and steer items using
  the configured queue mode, materialize them in order, update the branch tip,
  and publish queue updates atomically.
- Missing pending payloads and invalid queued payload types must fail as
  session invariants rather than being silently discarded.
- Structural boundary tests should cover hook decline, queued steer/follow-up,
  write materialization, event ordering, and process-loss boundaries.

Relevant references: `packages/agent/src/harness/runtime/drive/structural.ts`,
`packages/agent/test/harness/runtime/drive-structural.test.ts`, and the
structural-boundary sections of
`packages/agent/docs/work-packages/05-direct-durable-drive.md`.

## 7. Required validation

- Run `npm run check` after every implementation stage.
- Run targeted agent, storage, SQLite, RPC, Chord, and recovery tests.
- Add conformance tests for concurrent lane creation and branch updates.
- Test storage failures during commit and process restart recovery.
- Verify no provider/tool/hook/timer work occurs inside mutation callbacks.
- Validate existing Aira task, goal, orchestration, permission, and session
  recovery behavior before closing the phase.

## 8. Scope boundary

This phase is separate from upstream synchronization. Do not copy Pi's large
session/branch/lane rewrite directly into Aira. Use it as architectural input,
then implement small Aira-specific commits with independent review and tests.

### Narrow package entry points and import-graph budgets — upstream `5507d76`

Skip this synchronization commit. It changes Pi's package export topology and
assumes Pi-specific package boundaries, while Aira's package layout and runtime
entry points differ. The idea is useful for Phase 14: avoid loading a large
barrel when a client needs one session, reducer, environment, or utility
module.

Later Aira work should consider:

- Add narrow public subpath exports for high-cost, frequently imported runtime
  utilities, while retaining the existing barrel for full imports.
- Replace value imports from broad agent/AI barrels with source-aligned narrow
  imports where this materially reduces startup graph size; keep type imports
  erased and separate from runtime imports.
- Add an entry-point graph checker with per-entry file budgets and forbidden
  dependency paths, so a later barrel export cannot silently reintroduce the
  startup cost.
- Measure representative consumers before and after, especially session
  listing, worker startup, and presentation/TUI startup.

Relevant upstream references: `scripts/check-entry-graphs.mjs`,
`packages/agent/package.json` (`./harness/*` exports),
`packages/ai/package.json` (`./utils/*`),
`packages/coding-agent/src/experimental/mini/server/run.ts`,
`packages/coding-agent/src/experimental/mini/tui/session.ts`, and the
`@earendil-works/pi-ai/utils/uuid` imports in
`packages/agent/src/harness/session/`.

### Post-WP05 roadmap audit — upstream `5976a2f`

Skip this documentation-only synchronization commit. Its useful material is
an evidence-backed inventory of follow-up boundaries after the durable runtime
work, but Pi's WP numbering and normative harness contract do not map directly
to Aira.

For later Aira planning, retain these review points:

- Resolve contradictions between process-local routed services and any planned
  remote-session transport before implementing either contract.
- Treat SQLite ownership fencing, physical identity, path safety, close
  semantics, and shared-container isolation as a distinct backend workstream.
- Keep schema migrations, repository lifecycle/close behavior, JSONL snapshot
  compaction, session-wide watch, telemetry, search, and durable frame-volume
  measurement as separate boundaries rather than one broad rewrite.
- Preserve the rule that providers, tools, hooks, timers, and asynchronous
  event delivery do not run inside storage mutation callbacks.

Relevant upstream references: `packages/agent/docs/post-wp05-roadmap.md`,
`packages/agent/docs/harness.md`,
`packages/agent/docs/work-packages/07-sqlite-ownership-fencing.md`,
`packages/coding-agent/docs/settings.md`, and
`packages/session-backends/sqlite-node/README.md`.

### Tool renderer and theme dependency split — upstream `eb3e9fe`

Defer this commit to Phase 14. It is too large and coupled to Pi's current
coding-agent/mini architecture for safe synchronization: 26 files, extensive
tool implementation/component conflicts, and references to mini files that Aira
has intentionally removed. Do not wholesale cherry-pick it.

Useful later direction:

- Separate tool presentation renderers from tool schemas and execution paths so
  presentation-only processes do not load TypeBox or the full tool graph.
- Move user-theme JSON validation behind an explicit validator installation,
  keeping built-in palette definitions lightweight.
- Preserve fallback rendering for extension tool overrides without custom
  renderers.
- Add exact subpath aliases for Vitest and a dedicated mini test launcher only
  if Aira restores an equivalent mini runtime.

Relevant upstream references: `packages/coding-agent/src/core/tools/renderers/`,
`packages/coding-agent/src/modes/interactive/theme/theme-json.ts`,
`packages/coding-agent/src/modes/interactive/components/tool-execution.ts`,
`packages/server/vitest.config.ts`, and `mini-test.sh`.

### Condensed harness specification — upstream `2d675d0`

Defer this documentation rewrite to Phase 14. It condenses Pi's durable
harness contract but remains coupled to Pi's Session/Branch/Lane model and is
not a direct Aira implementation guide.

Useful later references include the explicit separation of immutable entries,
mutable values/lists, and usage records; total durable restart state; intent
and settlement around uncertain provider/tool effects; and the rule that
external effects never run inside storage mutation callbacks. Reconcile these
against Aira's existing session, orchestration, and recovery contracts before
using them as requirements.

Relevant upstream references: `packages/agent/docs/harness.md`,
`packages/agent/docs/post-wp05-roadmap.md`, and
`packages/agent/docs/work-packages/05-direct-durable-drive.md`.

### Restore subtle harness contracts — upstream `35fb116`

Defer this documentation correction to Phase 14. Although small, it conflicts
with Aira's divergent `harness.md`, and Pi's `post-wp05-roadmap.md` is absent
from Aira by design. Do not restore that document wholesale.

Useful later review points are the distinction between standalone and durable
assistant execution-block contracts, the production-vs-test gate-close error
types, and explicit conformance coverage for cancellation ordering and race
cases. Reconcile these against Aira's actual source before changing behavior.

Relevant upstream references: `packages/agent/docs/harness.md`,
`packages/agent/docs/post-wp05-roadmap.md`,
`packages/agent/src/harness/execution/assistant.ts`,
`packages/agent/src/harness/execution/tools.ts`, and
`packages/agent/src/harness/runtime/types.ts`.

### Service bindings replacing facet attributes — upstream `97f7472`

Defer this large service-kernel migration to Phase 14. It replaces generic
facet attributes across agent and coding-agent hosts and requires coordinated
changes to service contracts, lifecycle ownership, and presentation hosts.

Useful later direction:

- Keep plugin facets non-generic and resolve host-local dependencies through
  stable service tokens rather than facet-specific attribute types.
- Bind concrete local services before facet activation, after setup-time
  dependency validation is complete.
- Keep presentation facets away from raw harness/session authority, credentials,
  registries, and storage objects; expose only deliberate semantic services.
- Preserve generation ownership so reloads dispose retired service graphs and
  stale handles cannot survive a host replacement.

Relevant upstream references: `packages/agent/src/plugins/services/`,
`packages/coding-agent/src/experimental/facets.ts`,
`packages/coding-agent/src/experimental/services/`, and
`packages/coding-agent/test/experimental-facets.test.ts`.

### Derived facet service routing — upstream `e44ecea`

Defer this dependent routing milestone to Phase 14. It assumes the service
binding kernel from `97f7472` and changes agent, client, protocol, server,
worker, and presentation routing together; it is not safe to cherry-pick into
Aira independently.

Useful later constraints:

- Derive service requirements and provider catalogues from facet setup rather
  than maintaining a second handwritten dependency list.
- Route server and selected-session services through one presentation graph,
  while keeping authorization and attachment decisions in the host.
- Fence attachment/service-generation changes so delayed calls, frames, and
  subscriptions from an old worker cannot affect a replacement.
- Keep service connections generation-owned and rehydrate selected bindings
  after attach, detach, or worker replacement.

Relevant upstream references: `packages/agent/src/plugins/services/`,
`packages/coding-agent/src/experimental/client-runtime.ts`,
`packages/coding-agent/src/experimental/client-tui.ts`,
`packages/coding-agent/src/experimental/session-worker.ts`, and
`packages/coding-agent/test/experimental-remote-runtime.test.ts`.

### Experimental TUI service — upstream `7522307`

Defer this dependent TUI-host migration to Phase 14. It builds on the service
routing changes above and coordinates attachment routing, facet loading,
session picking, model selection, and TUI lifecycle ownership.

Useful later direction:

- Keep attachment routing in the TUI host rather than duplicating it in each
  presentation facet.
- Give TUI facets narrow presentation services for registration and refresh;
  do not expose raw client/session transport details to plugins.
- Load the complete facet generation once, then create host-local runtime
  bindings around it; dispose the generation as one lifecycle unit.
- Preserve stale attachment protection when the selected session or worker
  changes.

Relevant upstream references: `packages/coding-agent/src/experimental/client-tui.ts`,
`packages/coding-agent/src/experimental/services/tui.ts`, and
`packages/coding-agent/test/experimental-client-tui.test.ts`.

### Preserve service facades across facet reloads — upstream `6f0ea81`

Defer this large plugin-reload redesign to Phase 14. It changes service facade
identity, facet lifecycle, protocol bindings, and reload behavior across agent,
coding-agent, and protocol surfaces; it is too coupled for a safe Aira port.

Useful later constraints:

- Preserve consumer-held service facade identity when a provider reload is
  shape-compatible, swapping the implementation behind the existing facade.
- Treat changes to service requirements, provisions, modes, or manifest
  membership as structural graph reassembly rather than an in-place swap.
- Close affected calls, watches, subscriptions, and observations during
  replacement; never queue work merely because a replacement is starting.
- Keep source-module ownership and the runtime service dependency graph as
  separate inputs to reload planning.
- Fence stale provider generations and hydrate complete replacement snapshots
  before dependent presentation services resume.

Relevant upstream references: `packages/agent/src/plugins/services/namespace.ts`,
`packages/agent/src/plugins/services/provider.ts`,
`packages/coding-agent/src/experimental/facets.ts`,
`packages/coding-agent/src/experimental/facet-loader.ts`,
`packages/coding-agent/src/experimental/services/`, and
`packages/coding-agent/test/experimental-facet-loader.test.ts`.

### Remove remote service events — upstream `a17ead3`

Defer this large service-system simplification to Phase 14. It removes remote
event members across agent, client, protocol, server, and coding-agent
surfaces, and depends on the preceding service-facade/reload redesign.

Useful later constraints:

- Treat replicated state or explicit pull methods as the recovery mechanism for
  state changes; non-durable event delivery must not be used to repair missed
  state after reload or reconnect.
- Keep service facades limited to supported member kinds and remove event
  transport only after all providers, consumers, wire contracts, and tests agree.
- Preserve attachment and generation fencing when replacing event-driven
  subscriptions with snapshot hydration or pull-based updates.
- Reassess Aira's existing event subscriptions before applying this idea;
  removing them may change plugin and UI behavior.

Relevant upstream references: `packages/agent/src/plugins/services/events.ts`,
`packages/agent/src/plugins/services/replicated-state.ts`,
`packages/agent/src/plugins/services/namespace.ts`,
`packages/coding-agent/src/experimental/services/connection.ts`, and
`packages/protocol/src/protocol.ts`.

### Align facet service contracts and errors — upstream `6441fa6`

Defer this dependent contract migration to Phase 14. It renames the
experimental plugin-service surface to facet services, changes service error
mapping, removes the plugin-reloading document, and updates agent,
coding-agent, and protocol consumers together.

Useful later direction:

- Map unsupported Harness slices to a stable service-level error at the
  provider boundary, while preserving unrelated failures unchanged.
- Keep public service terminology and error codes consistent across local and
  remote adapters.
- Treat removal of remote/event or reload contracts as a coordinated API
  migration, not a local cleanup.

Relevant upstream references: `packages/agent/src/harness/agent-harness.ts`,
`packages/agent/src/plugins/services/types.ts`,
`packages/coding-agent/src/experimental/services/chat-provider.ts`, and
`packages/coding-agent/test/experimental-chat-service.test.ts`.

### Wire Chat into experimental TUI — upstream `8288bc3`

Defer this dependent presentation slice to Phase 14. Aira's current `main`
does not contain Pi's experimental client-TUI/service surface, including
`client-tui.ts` and `services/chat.ts`, and the commit depends on the deferred
facet service-routing chain.

Useful later direction:

- Keep chat input as a narrow TUI facet that consumes a semantic `Chat`
  service, rather than accessing Session or Harness internals directly.
- Transition the presentation explicitly through session selection, model
  selection, and chat input, with busy/cancel states owned by the TUI host.
- Preserve attachment routing in the host and register one chat feature per
  connected server/session binding.
- Add focused tests for prompt submission, busy input handling, escape/back
  navigation, and service refresh before exposing the slice.

Relevant upstream references: `packages/coding-agent/src/experimental/client-tui.ts`,
`packages/coding-agent/src/experimental/services/tui.ts`,
`packages/coding-agent/src/experimental/services/chat.ts`, and
`packages/coding-agent/test/experimental-client-tui.test.ts`.

### Run experimental client as direct chat — upstream `4bd9438`

Defer this large experimental-runtime migration to Phase 14. It replaces raw
Harness/Chat exposure with a presentation-safe `AgentController`, replicated
lane state, direct startup for new/resumed sessions, and persisted model
selection. Aira's current `main` lacks the required experimental client,
controller, lane-replica, and protocol surfaces.

Useful later direction:

- Expose a narrow controller for prompt, queue, abort, resume, compaction, and
  navigation rather than publishing raw Harness or lane objects.
- Keep presentation state replicated and reconstructible from worker/session
  authority; do not make the TUI the owner of durable operation state.
- Make session-selection flags mutually exclusive and support direct startup
  for new, continued, or resumed sessions.
- Persist model selection through the session-scoped authority, with explicit
  routing identity and attachment protection.

Relevant upstream references: `packages/coding-agent/src/experimental/services/agent-controller.ts`,
`packages/coding-agent/src/experimental/services/agent-controller-provider.ts`,
`packages/coding-agent/src/experimental/lane-replica.ts`,
`packages/coding-agent/src/experimental/client-tui-chat.ts`,
`packages/coding-agent/src/cli/experimental/commands/client.ts`, and
`packages/coding-agent/test/experimental-agent-controller.test.ts`.

### Remove unnecessary local service tokens — upstream `ecd3164`

Defer this dependent experimental-TUI cleanup to Phase 14. It removes local
service tokens and routes host-created dependencies directly into the
presentation bridge, but assumes the preceding AgentController, facet-host,
lane-replica, and client-TUI architecture, which Aira's current `main` lacks.

Useful later direction:

- Pass host-owned implementation dependencies directly to built-in facet
  factories when they are not legitimate plugin-facing services.
- Keep the presentation bridge private and expose a local TUI service only
  when there is a stable contribution API for independently loaded facets.
- Avoid service tokens that merely rename internal wiring; retain semantic
  services only where independent consumers need lifecycle or transport
  boundaries.
- Preserve direct startup, model persistence, and coherent lane-watch state as
  one integration slice rather than partially porting individual cleanup edits.

Relevant upstream references: `packages/coding-agent/src/experimental/client-tui.ts`,
`packages/coding-agent/src/experimental/services/models-provider.ts`,
`packages/coding-agent/src/experimental/services/tui.ts`, and
`packages/coding-agent/test/experimental-client-tui.test.ts`.

### Share fullscreen TUI with experimental client — upstream `b6c8797`

Defer this experimental-client integration to Phase 14. It reuses Pi's stable
interactive renderer, viewport layout, theme controller, and terminal
appearance updates, but depends on the deferred client/service/lane-replica
architecture and files absent from Aira's current `main`.

Useful later direction:

- Reuse one renderer and viewport implementation across normal interactive and
  service-driven client presentations to avoid behavioral drift.
- Keep successful operation state derived from the replicated lane snapshot,
  not from presentation-local assumptions.
- Refresh theme and terminal capability state through the shared controllers,
  including active chat views and tool renderers.
- Keep experimental presentation startup, attachment, and lane-watch wiring as
  one integration slice rather than copying isolated view classes.

Relevant upstream references: `packages/coding-agent/src/experimental/client-tui.ts`,
`packages/coding-agent/src/experimental/client-tui-chat.ts`,
`packages/coding-agent/src/modes/interactive/chat-viewport.ts`,
`packages/coding-agent/src/modes/interactive/theme/theme-controller.ts`,
`packages/coding-agent/src/modes/interactive/tui-renderer.ts`, and
`packages/coding-agent/test/experimental-client-tui.test.ts`.

### Connect experimental sessions through Radius — upstream `1d0d110`

Defer this large transport integration to Phase 14. It adds Radius address
parsing, authentication, relay reconnect, server routing, and client-TUI
integration across the experimental runtime. Aira lacks the required
experimental client/service architecture, so this is not an independent port.

Useful later direction:

- Keep transport selection explicit in the client route type; do not infer
  Radius from a Unix address or silently fall back between transports.
- Treat authentication as a transport capability and reject unsupported
  combinations during command validation/startup, before opening a session.
- Make relay reconnect and disposal lifecycle-owned, with stale connection
  events fenced from the active client/session binding.
- Preserve the same semantic server/session service contracts across local Unix
  and authenticated remote transports.

Relevant upstream references: `packages/coding-agent/src/cli/experimental/command-options.ts`,
`packages/coding-agent/src/experimental/client-runtime.ts`,
`packages/coding-agent/src/experimental/radius-auth.ts`,
`packages/coding-agent/src/experimental/radius-relay.ts`, and
`packages/coding-agent/test/experimental-radius-relay.test.ts`.

### Allow exit while Radius reconnects — upstream `f55da4a`

Defer this follow-up to Phase 14 with `1d0d110`. It changes Pi's absent
experimental Radius client TUI so `Ctrl+D` or the configured exit action can
finish while reconnecting, and allows the clear action during busy state.

Useful later direction:

- Keep exit and clear actions responsive during reconnect/busy states; do not
  let a transport retry loop trap the presentation.
- Match exit handling through configurable keybindings, including the empty
  editor guard used to distinguish exit from text input.
- Add a regression test for exit during reconnect, clear during busy work, and
  normal chat-editor handling after reconnection.

Relevant upstream references: `packages/coding-agent/src/experimental/client-tui.ts`
and `packages/coding-agent/test/experimental-client-tui.test.ts`.

### Add facet-based slash commands — upstream `fcbb0b3`

Defer this experimental presentation feature to Phase 14. It adds a shared
facet-based `SlashCommands` service, plugin-provided command contributions,
autocomplete updates, modal selection, and command dispatch. It depends on
the deferred experimental client, facet-host, Radius, and AgentController
architecture, which Aira's current `main` does not contain.

Useful later direction:

- Keep slash-command contributions owned by the facet lifecycle, with cleanup
  removing autocomplete and dispatch registrations on unload/reload.
- Expose narrow command callbacks for selection, status, and prompt submission;
  do not give plugins raw editor or renderer access.
- Keep built-in commands and plugin commands in one registry while preserving
  deterministic ordering and conflict behavior.
- Treat modal command selection as a blocking UI prompt with cancellation and
  nested-prompt lifecycle handling.

Relevant upstream references: `packages/coding-agent/src/experimental/services/slash-commands.ts`,
`packages/coding-agent/src/experimental/services/slash-commands-provider.ts`,
`packages/coding-agent/src/experimental/plugins/hello.ts`,
`packages/coding-agent/src/experimental/client-tui.ts`, and
`packages/coding-agent/test/experimental-slash-commands.test.ts`.

### Unify process-local service lifecycle — upstream `d4ce5d5`

Defer this cross-package service-lifecycle migration to Phase 14. It changes
the service locality contract from `{ rpc: false }` to `{ local: true }` and
updates provider/namespace behavior, keyed services, documentation, and tests.
It depends on Pi's deferred experimental facet-service architecture.

Useful later direction:

- Make locality explicit in the service token and keep local services out of
  remote catalogues and resolution.
- Share lifecycle ordering, stable handles, keyed generations, activation,
  disposal, and reload behavior between local and remotely publishable
  services; only remote services should add validation, replication, and RPC.
- Keep local services suitable for native objects, credentials, filesystem
  handles, and synchronous methods without weakening the remote JSON boundary.
- Treat a locality-option rename as a coordinated contract migration across
  token declarations, provider validation, host routing, and consumers.

Relevant upstream references: `packages/agent/src/plugins/services/types.ts`,
`packages/agent/src/plugins/services/provider.ts`,
`packages/agent/src/plugins/services/namespace.ts`,
`packages/coding-agent/src/experimental/services/`, and
`packages/agent/test/plugins/services.test.ts`.

### Reconnect after abnormal Radius closure — upstream `35c4935`

Defer this transport fix to Phase 14. Aira has Radius provider/OAuth support,
but does not currently contain Pi's experimental `radius-relay.ts` transport or
its relay test harness, so this cannot be directly copied or safely adapted in
isolation.

Useful later direction:

- Map abnormal WebSocket closure (`1006`) to client error handling that permits
  the reconnect loop to run instead of treating the socket as a clean close.
- Use valid locally-generated WebSocket close codes (`4000` for protocol error,
  `4001` for transport error) because Undici rejects received RFC protocol
  codes such as `1002` and `1011` when passed to `close()`.
- Add a fake WebSocket regression test that enforces valid close-code ranges and
  verifies an established abnormal closure calls `onError` without calling
  `onClose`, allowing reconnection.

Relevant upstream references: `packages/coding-agent/src/experimental/radius-relay.ts`
and `packages/coding-agent/test/experimental-radius-relay.test.ts`.

### Add Chord runtime foundation — upstream `28b49a6`

Defer this large runtime migration to Phase 14. It introduces the standalone
`@earendil-works/chord` package and rewires Pi's harness context, runtime-drive
execution, telemetry propagation, package build graph, dependency metadata, and
tests around it. Aira does not currently contain the Chord package or the
matching harness/runtime-drive architecture, so this is not safe to adapt as
an incremental commit.

Useful later direction:

- Evaluate Chord as a shared application-composition runtime for service
  lifecycles, replicated state, RPC, and plugins rather than copying isolated
  context helpers.
- Preserve explicit telemetry context propagation through compaction and
  other harness operations when migrating context ownership.
- Treat the runtime-drive and session-line changes as one coordinated design;
  do not partially introduce the new context package.

Relevant upstream references: `packages/chord/`,
`packages/agent/src/harness/context.ts`,
`packages/agent/src/harness/runtime/drive/`, `packages/agent/src/harness/runtime/`,
`scripts/check-entry-graphs.mjs`, and the corresponding harness/chord tests.

### Move facet services into Chord — upstream `34dc9d0`

Defer this coordinated follow-up to the Chord foundation. It moves service,
replicated-state, facet-host, and loader ownership into `packages/chord/`,
updates consumers and package aliases, and leaves runtime JSON enforcement to
serializers. The change is tightly coupled to upstream `28b49a6`; partial
adoption would leave incompatible service ownership and import boundaries.

Relevant upstream references: `packages/chord/src/facets/`,
`packages/chord/src/services/`, `packages/agent/src/plugins/services/`,
`packages/coding-agent/src/experimental/services/`, `packages/protocol/`,
and the Chord facet/service tests.

### Simplify Chord service instance API — upstream `4151e57`

Defer this Chord-dependent API migration to Phase 14. It replaces observed
`RemoteServiceInstance` wrappers with ordinary typed service proxies, exposes
optional instance-key lookup, and renames the deferred multi-instance
capability from `ServiceInstances`/`add()` to `ServiceSpawner`/`spawn()`.
Applying it without the Chord foundation would create incompatible service
contracts and consumer/provider boundaries.

Relevant upstream references: `packages/chord/src/services/`,
`packages/chord/src/facets/host.ts`, `packages/chord/src/facets/types.ts`,
`packages/agent/docs/plugins.md`, `packages/agent/docs/rpc.md`, and the Chord
facet/service tests.

### Consolidate Chord public API — upstream `6ec57e6`

Defer this Chord API consolidation to Phase 14. It introduces the public
`api`, `context`, and `types` entrypoints, moves context internals behind the
public boundary, and updates agent, AI, protocol, package exports, and tests.
It depends on the deferred Chord runtime and service migrations; partial
adoption would create unstable import and type-export boundaries.

Relevant upstream references: `packages/chord/src/api.ts`,
`packages/chord/src/context/`, `packages/chord/src/types.ts`,
`packages/chord/package.json`, `packages/agent/src/harness/context.ts`,
`packages/agent/src/harness/session/types.ts`, and `packages/ai/src/types.ts`.

### Isolate Chord context API — upstream `e6dc574`

Defer this Chord API-boundary refinement to Phase 14. It keeps general public
types and runtime APIs at the Chord root while isolating generic context
constants and functions under `@earendil-works/chord/context`, and updates
agent, AI, protocol, and Chord consumers accordingly. It depends on the
deferred Chord foundation and public API migration.

Relevant upstream references: `packages/chord/src/context/`,
`packages/chord/src/index.ts`, `packages/chord/src/api.ts`,
`packages/chord/package.json`, `packages/agent/src/harness/context.ts`,
`packages/agent/src/harness/session/types.ts`, and `packages/ai/src/types.ts`.

### Simplify Chord service APIs — upstream `1bf0de2`

Defer this Chord-dependent service API refinement to Phase 14. It removes the
public keyed-instance lookup, makes `observe()` lifecycle-owned with no
returned disposer, and simplifies loopback/service-binding access guards across
Chord, agent documentation, and experimental coding-agent consumers. It must
follow the deferred Chord service migrations as one API transition.

Relevant upstream references: `packages/chord/src/api.ts`,
`packages/chord/src/facets/host.ts`, `packages/chord/src/services/consumer.ts`,
`packages/chord/src/services/instances.ts`, `packages/chord/src/index.ts`,
`packages/agent/docs/plugins.md`, and the Chord facet/service tests.

### Simplify Chord service slots — upstream `b1e9b9e`

Defer this Chord-internal service-slot refactor to Phase 14. It separates host
singleton slots from keyed-service sources and updates binding, access guards,
external-service resolution, and lifecycle disposal. Although only two source
files change, it depends on the preceding Chord service API migrations and has
no safe Aira-local equivalent today.

Relevant upstream references: `packages/chord/src/facets/host.ts`,
`packages/chord/src/services/handle.ts`, and the Chord facet/service tests.

### Clarify Chord remote service APIs — upstream `024439d`

Defer this Chord architecture refinement to Phase 14. It replaces direct facet
connection ownership with explicit remote service sources, changing catalogue
resolution, deferred-service handling, binding cleanup, host APIs, and related
consumer documentation and tests. It depends on the complete deferred Chord
foundation and service migration sequence.

Relevant upstream references: `packages/chord/src/facets/host.ts`,
`packages/chord/src/api.ts`, `packages/chord/src/services/consumer.ts`,
`packages/chord/src/services/protocol.ts`, `packages/agent/docs/plugins.md`,
`packages/agent/docs/rpc.md`, and the Chord facet/service tests.

### Harden Chord service lifecycle semantics — upstream `45d0174`

Defer this major Chord lifecycle hardening pass to Phase 14. It adds guarded
consumer service views, stale-instance protection, stronger provider replacement
and reload failure semantics, remote contract validation, and lifecycle tests.
It depends on the complete Chord service/source migration and must be adopted
as a coordinated runtime change rather than isolated helper code.

Relevant upstream references: `packages/chord/src/facets/host.ts`,
`packages/chord/src/services/consumer.ts`, `packages/chord/src/services/handle.ts`,
`packages/chord/src/services/provider.ts`, `packages/chord/src/services/protocol.ts`,
`packages/chord/PLANNING.md`, and the Chord facet/service tests.

### Add bundled facet distribution and reload — upstream `0252dff`

Defer this large Chord distribution/reload system to Phase 14. It adds
content-addressed facet bundles, server-selected presentation artifacts in the
handshake, protocol version 4 bootstrap data, and `/reload` flows for Session
and TUI generations across 49 files. It depends on the complete Chord runtime,
service-source, and lifecycle migrations and should not be partially adapted.

Useful later direction:

- Keep bundle identity content-addressed and validate manifests before loading.
- Treat handshake bootstrap data and protocol-version changes as one server,
  client, and test migration.
- Preserve generation ownership and atomic reload semantics for session and
  presentation facets, including cleanup on failed replacement.

Relevant upstream references: `packages/chord/src/bundler.ts`,
`packages/chord/src/node/`, `packages/coding-agent/src/experimental/plugins/bundled.ts`,
`packages/protocol/src/protocol.ts`, `packages/server/src/server.ts`,
`packages/server/src/transports/unix/`, and the bundle/reload conformance tests.

### Add package-based facet plugins — upstream `429f4e7`

Defer this Chord distribution continuation to Phase 14. It adds package-based
plugin discovery and bundling, fresh facet generations, persisted Session/TUI
selection, external dependency resolution, and stale local server-generation
replacement after protocol changes across 44 files. It depends on the
deferred Chord bundle/reload foundation and should be adopted as one plugin
distribution design.

Useful later direction:

- Read plugin identity, version, peer dependencies, and facet entry overrides
  from package metadata without installing dependencies or running lifecycle
  scripts.
- Externalize the host-provided Chord runtime and resolve other peer imports
  against the receiving application.
- Persist selected plugin/facet branches per Session and TUI, and replace stale
  local generations when protocol or bundle state changes.

Relevant upstream references: `packages/chord/src/node/package.ts`,
`packages/chord/src/node/bundle-loader.ts`, `packages/chord/src/bundler.ts`,
`packages/coding-agent/examples/extensions/plugins/`,
`packages/coding-agent/src/experimental/plugins/package.ts`,
`packages/coding-agent/src/experimental/session-worker-manager.ts`, and the
bundle/plugin reload tests.

### Simplify plugin facet lifecycle — upstream `5245aba`

Defer this facet-distribution follow-up to Phase 14. It removes handshake-based
facet delivery, hosts only the selected Session presentation branch, and
simplifies worker selection, startup options, package profiles, serialized
builds, and reload lifecycle across 18 files. It depends on the deferred Chord
bundle/plugin architecture and protocol changes.

Useful later direction:

- Keep presentation selection persisted and scoped to the active Session/TUI
  branch rather than broadcasting all available facet artifacts.
- Make reload ownership explicit: candidate generation loads first, successful
  replacement retires the old generation, and failed candidates are disposed.
- Keep server, client, session-worker, and protocol startup contracts aligned
  when removing handshake-delivered presentation bundles.

Relevant upstream references: `packages/coding-agent/src/experimental/client-runtime.ts`,
`packages/coding-agent/src/experimental/client-tui.ts`,
`packages/coding-agent/src/experimental/plugins/bundled.ts`,
`packages/coding-agent/src/experimental/plugins/package.ts`,
`packages/coding-agent/src/experimental/session-worker-manager.ts`,
`packages/protocol/src/protocol.ts`, and the experimental reload tests.

### Simplify experimental services and CLI — upstream `d3697e6`

Defer this Chord/plugin-dependent CLI migration to Phase 14. It simplifies the
experimental command namespace and option parser, removes legacy option
handling, adjusts service/plugin startup ownership, and updates the example
facet command across 23 files. It should follow the deferred Chord service,
facet distribution, and reload architecture rather than be applied in pieces.

Relevant upstream references: `packages/coding-agent/src/cli/experimental/`,
`packages/coding-agent/src/experimental/client-runtime.ts`,
`packages/coding-agent/src/experimental/client-tui.ts`,
`packages/coding-agent/src/experimental/services/`,
`packages/coding-agent/src/experimental/plugins/`, and the experimental CLI,
service, and presentation tests.

### Remove legacy session RPC facade — upstream `984846b`

Defer this Chord-dependent protocol migration to Phase 14. It routes Session
discovery, management, and prompting through Chord services, retains only
low-level lane watches, and reattaches Radius clients through SessionManagement.
It removes or rewires client, server, protocol, transport, experimental runtime,
and conformance code across 28 files.

Useful later direction:

- Keep the public client transport-neutral: typed service contracts belong to
  the application host, while request/subscription methods remain low-level
  adapters.
- Preserve full server/session/attachment addressing to prevent delayed-frame
  misrouting across reconnects or session switches.
- Treat removal of the legacy facade as one client/server/protocol migration;
  do not mix old RPC methods with the new Chord service route.

Relevant upstream references: `packages/client/src/client.ts`,
`packages/client/README.md`, `packages/protocol/src/protocol.ts`,
`packages/server/src/server.ts`, `packages/server/src/session-router.ts`,
`packages/coding-agent/src/experimental/client-runtime.ts`,
`packages/coding-agent/src/experimental/radius-relay.ts`, and the client/server
conformance tests.

### Make Chord facet generations collectible — upstream `65f77ec`

Defer this Chord bundle-loader redesign to Phase 14. It changes Node facet
bundles from ESM imports to VM-compiled CommonJS, adds restricted external
resolution and dynamic-import lowering, and makes retired generations eligible
for garbage collection after cleanup across seven files. It depends on the
deferred Chord bundling, plugin distribution, and reload architecture.

Relevant upstream references: `packages/chord/src/node/bundle-loader.ts`,
`packages/chord/src/node/bundle.ts`, `packages/chord/src/node/manifest.ts`,
`packages/chord/README.md`, `packages/chord/PLANNING.md`, and the bundle tests.

### SQLite host ownership documentation — upstream `5cf1b95`

This documentation adaptation is implemented separately in
`PHASE_14_SQLITE_HOST_OWNERSHIP.md`. It records the host-authoritative Session
ownership model, removal of SQLite writer leases, and read-only live-worker fork
requirements for later Phase 14 implementation.

### Tighten experimental service boundaries — upstream `8e374e4`

Defer this Chord-dependent boundary migration to Phase 14. It separates wire
message types from harness types, tightens Radius reconnect interfaces, and
rewires experimental client/server/session services and conformance tests
across 27 files. Apply it only with the deferred Chord service and protocol
architecture, not as isolated type renames.

Useful later direction:

- Keep wire DTOs explicit and structurally separate from internal harness
  messages, with compile-time adapter compatibility checks.
- Narrow reconnect helpers to the client capabilities they actually consume.
- Keep service-boundary ownership in the application host while preserving
  low-level transport behavior and truthful session addressing.

Relevant upstream references: `packages/coding-agent/src/experimental/harness-wire-adapter.ts`,
`packages/coding-agent/src/experimental/radius-relay.ts`,
`packages/coding-agent/src/experimental/services/`,
`packages/client/src/client.ts`, `packages/protocol/src/`, and the related
client/server/experimental conformance tests.

### Add JSON delta tracking — upstream `f7079d5`

Defer this Chord delta-tracking feature to Phase 14. Aira does not yet contain
the preceding `packages/chord` foundation, and this commit modifies existing
Chord package files as well as adding `src/delta/`; it cannot be applied as an
independent direct copy.

Useful later direction: evaluate the intent-preserving JSON delta primitive for
bounded durable output, including append, front-truncation, array-splice,
rebasing, path interning, validation, and snapshot/delta recovery boundaries.

Relevant upstream references: `packages/chord/src/delta/index.ts`,
`packages/chord/test/delta.test.ts`, `packages/chord/README.md`,
`packages/chord/PLANNING.md`, and `packages/chord/package.json`.

### Generate deltas at flush — upstream `9af45be`

Defer this refinement of the Chord delta subsystem to Phase 14. It changes
delta generation to derive operations from the tracked JSON value at flush time
without retaining mutation history, adds the detailed Delta guide, and expands
the tracker tests. It depends on the missing Chord foundation and `f7079d5`, so
it cannot be copied independently.

Useful later direction: preserve append/front-truncate and array-append intent,
tracker-owned value semantics, complete snapshot rebasing, ordered wire
encoding, untrusted-operation validation, and explicit consumer ownership.

Relevant upstream references: `packages/chord/src/delta/index.ts`,
`packages/chord/src/delta/README.md`, `packages/chord/test/delta.test.ts`,
`packages/chord/README.md`, and `packages/chord/package.json`.

### Explain delta stream encoding — upstream `8a738e2`

Defer this documentation refinement with the Chord Delta sequence. It expands
the user-facing guide with decoded `Op` and encoded `WireOp` vocabularies,
stateful path interning, batch boundaries, stream setup, and operation examples.
It depends on the deferred Chord Delta implementation and guide.

Relevant upstream reference: `packages/chord/src/delta/README.md`.

### Introduce delta operations upfront — upstream `b99964b`

Defer this documentation refinement to Phase 14 with the Chord Delta sequence.
It adds the concise operation-format explanation to the Delta guide, covering
root replacement, set/delete, string updates, array splices, and the `flush()`/
`apply()` relationship. It depends on `f7079d5` and `9af45be`.

Relevant upstream reference: `packages/chord/src/delta/README.md`.

### Keep delta guide user-focused — upstream `3de0030`

Defer this documentation cleanup with the Chord Delta sequence. It removes
implementation-detail wording about overlap verification from the user-facing
Delta guide while retaining the behavioral description of unrelated string
replacement.

Relevant upstream reference: `packages/chord/src/delta/README.md`.

### Add streaming fork work package — upstream `f98c285`

Defer this work package to Phase 14. It is a large, cross-backend redesign of
session forking that depends on the deferred WP07 SQLite ownership model and
the newer Agent/Chord session architecture, neither of which is present in
Aira. It replaces the fork contract, adds branch/tree scope validation,
introduces a closed fork classifier, preserves sequence numbers, and rewrites
Memory, JSONL, and SQLite fork paths around bounded-memory streaming copies.

Useful later direction: require explicit `{ scope: "branch", branch }` or
`{ scope: "tree" }`; validate complete branch/lane state and ancestry; exclude
reserved operation/pending/result state; preserve source sequence high-water
marks; make JSONL forks read-only and fixed-prefix; and stage SQLite forks
before publication with cleanup on success and failure.

Relevant upstream references: `packages/agent/docs/work-packages/08-named-branch-streaming-forks.md`,
`packages/agent/src/harness/session/fork.ts`,
`packages/agent/src/harness/session/jsonl/`,
`packages/session-backends/sqlite-node/src/sqlite/`, and the fork conformance
and backend tests listed in the work package.

### Align SQLite ownership with session workers — upstream `ef11444`

Defer the full implementation to Phase 14. Aira only has the earlier adapted
documentation boundary for this work; it does not contain the upstream
15-file SQLite implementation patch. The upstream change removes the SQLite
writer lease and storage-layer ownership, adds no-create read-write/read-only
access modes, supports live worker-owned source forks through independent WAL
readers, hardens physical path and session identity handling, improves
repository close draining, and adds substantial backend and integration tests.

Implement this only after reviewing Aira's current SQLite repository/session
architecture and the related fork work. Preserve the host-authoritative
ownership rule, repository-local create/open/fork/delete reservation, exact
physical source identity, shared-container deletion scope, and all-settled
close behavior. Do not treat the existing documentation adaptation as proof
that the runtime implementation is complete.

Relevant upstream references: `packages/agent/docs/harness.md`,
`packages/agent/docs/post-wp05-roadmap.md`,
`packages/agent/docs/work-packages/07-sqlite-host-ownership-live-forks.md`,
`packages/session-backends/sqlite-node/src/sqlite/`, and
`packages/session-backends/sqlite-node/test/`.

### Clarify Delta ownership and array costs — upstream `2865393`

Defer this Chord Delta documentation refinement to Phase 14. Aira does not
yet contain the Chord Delta package, so this cannot be applied independently.
It clarifies that tracked state may be a JSON object or array, documents wider
array diffs after structural index changes, tightens tracker-owned reference
and aliasing rules, and explains that decoding/applying invalid operations
terminates the stream and requires recovery from a later base batch.

Useful later direction: document the cost of combining array shifts with edits
at moved indices, require mutations through tracker-owned state, reject reuse
of one object at multiple live paths, and make Delta stream ownership and
recovery behavior explicit.

Relevant upstream references: `packages/chord/README.md` and
`packages/chord/src/delta/README.md`.

### Align assistant output handoff with Chord — upstream `c025524`

Defer this Chord-dependent documentation synchronization to Phase 14. Aira
does not yet have the Chord Delta production package or the upstream mobile
assistant-output handoff structure, so the 12-file documentation change cannot
be copied as an isolated update.

Useful later direction: make Chord the owner of dependency-free Delta
operations, tracker, applier, codec, and validation; treat the earlier delta
prototype as historical evidence; document tracked assistant output in scoped
storage instead of per-frame durable writes; and preserve unknown-outcome
recovery while bounding output amplification.

Relevant upstream references: `packages/agent/docs/harness.md`,
`packages/agent/docs/mobile-handoff/01-harness/01-delta/`,
`packages/agent/docs/mobile-handoff/01-harness/05-assistant-output/`,
`packages/agent/docs/post-wp05-roadmap.md`, and
`packages/agent/docs/work-packages/05-direct-durable-drive.md`.

### Optimize Delta string and baseline updates — upstream `ba74f03`

Defer this Chord Delta implementation change to Phase 14. Aira does not yet
contain the Chord Delta tracker, so it cannot be copied independently. The
change replaces cons-string-sensitive `startsWith()` checks with a sliced
prefix comparison, and advances the tracker baseline by sharing safe scalar,
string, and pure-array-append updates instead of replaying operations and
allocating whole touched arrays on every flush.

Useful later direction: preserve the optimization only for changes that can be
synced exactly and cheaply; fall back to operation replay for non-append array
changes. The upstream measurement reported approximately 845 microseconds to
42 microseconds for a 200 KB string growing by 8 bytes per flush.

Relevant upstream reference: `packages/chord/src/delta/index.ts`.

### Replace lane RPC with Chord service — upstream `ae2cc51`

Defer this major architectural migration to Phase 14. It changes 49 files and
depends on the deferred Chord runtime, Delta, JSON representation, service,
client, protocol, server, and experimental worker foundations. It replaces
lane-specific RPC with Chord service boundaries, adds strict-JSON transcript
snapshots and watch events, and rewires the coding-agent experimental client,
server, worker, session routing, and conformance surfaces.

Useful later direction: keep remote transcript payloads strictly JSON-safe,
separate reducer-relevant watch events from local Harness events, preserve
snapshot rebasing for navigation, and make service ownership and transport
boundaries explicit before migrating Aira's lane runtime.

Relevant upstream references: `packages/chord/`,
`packages/agent/src/harness/agent-harness.ts`,
`packages/agent/src/harness/runtime/reducer.ts`,
`packages/coding-agent/src/experimental/`, `packages/client/`,
`packages/protocol/`, and `packages/server/`.

### Add Delta-backed replicated state — upstream `86bac52`

Defer this commit as a complete architecture package. It changes 50 files
across Agent, AI test/runtime support, Chord, client, coding-agent
experimental services, protocol, server, and TypeScript configuration. The
commit replaces mutable lane/provider replication with tracked mutable state
that flushes immutable Delta operation batches, isolates path codecs per
subscription and state member, adds protocol service-state messages, and
rewires reducers, clients, servers, session workers, transcript providers,
model providers, and their conformance tests.

Aira proof: `packages/chord/` is absent from the current Aira tree. Aira's
available reducer remains the older `LaneView`/Harness-event design, so the
upstream `JsonRepresentation`, Delta tracker/applier, Chord service state,
and replicated subscription surfaces have no compatible local owners. The
50-file patch cannot be directly copied, and extracting isolated reducer or
protocol hunks would create a second incompatible replication model.

When implementing later, preserve the upstream separation between local
Harness events and replicated strict-JSON state, the per-subscriber path
codec, immutable operation-batch publication, service-state protocol
validation, and snapshot/rebase behavior. Review all affected package APIs
together and run the Chord, protocol, client, server, and experimental
conformance tests as one migration.

Relevant upstream references: `packages/chord/src/delta/index.ts`,
`packages/chord/src/services/state.ts`, `packages/protocol/src/service-state.ts`,
`packages/client/src/client.ts`, `packages/server/src/server.ts`,
`packages/coding-agent/src/experimental/lane-replica.ts`, and the 86bac52
reducer/service tests.

### Move service wire semantics into Chord — upstream `1a7bc80`

Defer this 38-file migration. The actual patch moves service wire encoding,
errors, and strict-JSON service-state handling into Chord while removing the
older protocol service definitions and changing client, server, and
experimental worker APIs. Aira has no `packages/chord` implementation and its
current client/server/protocol surfaces do not expose the upstream service
wire contracts.

Evidence: the upstream patch does not apply cleanly to Aira's current source
layout and includes lockfile/shrinkwrap changes for a package Aira does not
have. Applying isolated protocol deletions would remove active compatibility
code without installing the Chord replacement. Revisit only with
`86bac52`, `ae2cc51`, and the complete Chord service boundary.

Relevant upstream references: `packages/chord/src/services/wire.ts`,
`packages/chord/src/services/errors.ts`, `packages/client/src/client.ts`,
`packages/protocol/src/protocol.ts`, `packages/server/src/server.ts`, and
the service-wire tests.

### Close Delta append API decision — upstream `6c3fafb`

Defer this six-file mobile-handoff documentation decision. It records the
choice to use the Chord Delta tracker as the assistant-output append mechanism,
updates the prototype findings and tool-output examples, and adds an
append-decision document. Aira lacks both the upstream mobile-handoff document
tree and the Chord Delta implementation, so copying these documents would
describe an architecture that is not present in Aira.

Useful later direction: settle append semantics before implementing assistant
output replication, distinguish tracker-owned state from durable session state,
and preserve the unknown-outcome recovery boundary.

Relevant upstream references: `packages/agent/docs/mobile-handoff/README.md`,
`packages/agent/docs/mobile-handoff/01-harness/01-delta/`, and the affected
tool-output handoff examples.

### Consolidate remote service adapters — upstream `fa503683`

Defer this 19-file service migration. It adds Chord-side remote service
adapters, removes the experimental lane replica, and rewires client,
coding-agent experimental, and service-wire tests around those adapters. Aira
has no Chord package and no matching experimental service source tree, so the
deletions and API substitutions cannot be safely separated from the missing
replacement implementation.

Evidence: the upstream patch targets missing Aira paths and its deletion of
`lane-replica.ts` would have no corresponding replacement owner. Apply later
with `1a7bc80` and the Chord service runtime as one migration.

Relevant upstream references: `packages/chord/src/services/provider.ts`,
`packages/client/src/client.ts`, `packages/coding-agent/src/experimental/`,
and `packages/chord/test/service-wire.test.ts`.

### Remove experimental compatibility shims — upstream `7cf456a`

Defer this eight-file cleanup. It removes server error compatibility and
changes experimental session-worker manager/router behavior after the remote
service-adapter migration. Aira's current source does not contain the
upstream experimental session-worker tree, so the removals cannot be proven
behavior-preserving against Aira.

Relevant upstream references: `packages/coding-agent/src/experimental/`,
`packages/server/src/errors.ts`, `packages/server/src/session-router.ts`, and
the experimental session-worker and server conformance tests.

### Keep services available during facet reloads — upstream `c4b0e35`

Defer this 13-file Chord facet/service lifecycle change. It adds service-call
and handle lifecycle machinery, changes facet reload ordering and terminal
failure behavior, and updates coding-agent slash-command providers and tests.
Aira lacks the Chord facet host and service handle implementation, so copying
the reload edits or terminal-failure tests alone would create no valid local
owner for the new lifecycle semantics.

Useful later direction: preserve service availability across facet reloads,
make post-cutover reload failures terminal, and test service-handle cleanup
and slash-command behavior together.

Relevant upstream references: `packages/chord/src/facets/host.ts`,
`packages/chord/src/services/calls.ts`, `packages/chord/src/services/handle.ts`,
`packages/coding-agent/src/experimental/services/slash-commands-provider.ts`,
and the facet-loader/service tests.

### Allow Chord Delta bundle imports — upstream `6f6fa20`

Defer this one-line bundler change until the Chord Delta package is integrated.
The upstream patch adds `@earendil-works/chord/delta` to the coding-agent
bundle's allowed external packages so the bundle can leave that import
external. Aira's current `scripts/build-coding-agent-bundle.mjs` has no Chord
external entries, and `packages/chord/` is absent, so adding only this entry
would authorize a package that cannot resolve in Aira.

Evidence from Aira: the upstream patch fails `git apply --check` against the
current bundler because its surrounding Chord allowlist does not exist. Apply
this only alongside the Chord Delta bundle/package migration, then verify the
coding-agent bundle and its import-resolution tests.

Relevant upstream reference: `scripts/build-coding-agent-bundle.mjs`.

### Update WP08 implementation status — upstream `4b7a0a7`

Defer this documentation-only status update. It changes the WP08 handoff from
“actionable handoff, not implemented” to “in progress — implementing Slice A”.
Aira has not adopted WP08 and the referenced Chord/session fork architecture
is still deferred, so this status would be inaccurate in Aira. Reapply only
when the corresponding Slice A implementation has actually begun.

Relevant upstream reference:
`packages/agent/docs/work-packages/08-named-branch-streaming-forks.md`.

### Remove dead experimental protocol code — upstream `fbf2db6`

Defer this cleanup until the Chord service migration is implemented. The
actual patch removes protocol framing/json-value compatibility paths and
rewires 16 experimental client, server, plugin, worker, and lane-replica files
around the newer service protocol. It is not a safe isolated deletion in Aira:
the current source tree has no `packages/coding-agent/src/experimental/`
implementation, and its protocol package still owns the older framing surface.

Evidence from Aira: the upstream multi-file patch fails `git apply --check`,
including missing experimental source paths and incompatible protocol files.
Copying only the deletions would remove active Aira protocol behavior without
introducing the replacement service boundaries. Revisit this with
`86bac52`, `1a7bc80`, and the Chord service architecture as one unit.

Relevant upstream references: `packages/protocol/src/codec.ts`,
`packages/protocol/src/framing.ts`, `packages/protocol/src/protocol.ts`,
`packages/coding-agent/src/experimental/`, and the associated protocol and
experimental tests.

### Use invocation context for cwd-sensitive tools — upstream `62835ea` — implemented as `c0625be37`

This useful adaptation is implemented in Aira. The
upstream change updates bash, read, write, edit, grep, find, and ls so each
tool resolves relative paths and shell execution against `ctx.cwd` when an
extension supplies a session-specific working directory, falling back to the
factory cwd otherwise. It adds focused tests for all seven tools.

Aira proof: bash, read, find, grep, and ls already accept a context-like final
argument and pass it into some helpers, while write and edit currently discard
it; the upstream seven-file patch fails to apply cleanly because Aira's tool
signatures and test file have diverged. Later adaptation must inspect each
tool's current `ExtensionContext` contract, preserve shell environment
behavior, add Aira-specific coverage, and run the complete tools test plus
`npm run check`.

Relevant upstream references: `packages/coding-agent/src/core/tools/bash.ts`,
`edit.ts`, `find.ts`, `grep.ts`, `ls.ts`, `read.ts`, `write.ts`, and
`packages/coding-agent/test/tools.test.ts`.

## Chronological audit ledger: `86bac52` through `6ee906d`

This ledger records the individual review disposition and evidence. Upstream
patches were inspected with `git show` and checked against the current Aira
tree; a commit was not deferred merely because of its subject line.

1. `86bac52` — **deferred**. The 50-file patch changes Chord Delta tracking,
   strict-JSON service state, protocol messages, reducers, clients, servers,
   and experimental replication together. Aira has no `packages/chord/`, and
   the current reducer/protocol owners are different; isolated hunks would
   create a second incompatible replication model.
2. `6f6fa20` — **deferred**. Its one-line allowlist addition assumes existing
   Chord bundle externals. Aira has no Chord package or Chord allowlist, and
   the exact patch fails `git apply --check`.
3. `fbf2db6` — **deferred**. It removes old protocol framing/json-value paths
   while rewiring the experimental service implementation. Aira lacks the
   referenced experimental source tree and the exact patch fails against its
   protocol layout.
4. `1a7bc80` — **deferred**. It moves service wire semantics into Chord while
   deleting/replacing protocol definitions across 38 files. Aira lacks the
   Chord wire owner; isolated protocol deletions are unsafe.
5. `6c3fafb` — **deferred**. It documents a Chord Delta append decision in six
   mobile-handoff files that Aira does not have. It would document unavailable
   production behavior.
6. `d24c99f` — **direct copy**. The 166-line benchmark was absent in Aira and
   its exact patch applied cleanly. Full check passed. Local commit:
   `b3a6a92fc859a88e50322bb41c8eeaaf74e155e9`.
7. `fa50368` — **deferred**. It adds Chord remote adapters and deletes the
   experimental lane replica across 19 files. Aira has neither replacement
   owner, and the patch targets missing/incompatible paths.
8. `7cf456a` — **deferred**. Its compatibility-shim deletions depend on the
   preceding remote-adapter migration; Aira lacks the upstream experimental
   session-worker tree.
9. `c4b0e35` — **deferred**. It changes Chord facet reload lifecycle, service
   handles, and terminal failure behavior across 13 files. Aira has no Chord
   facet host or service lifecycle owner.
10. `56c6fb3` — **direct copy**. The implementation and regression patch
    applied cleanly after placing the tests under Aira's existing
    `test/suite/regressions/` layout. Two regression tests and full check
    passed. Local commit: `d20313ab5`.
11. `afda4d6` — **direct copy**. The implementation and regression patch
    applied cleanly under Aira's suite layout. Two regression tests and full
    check passed. Local commit: `cfd8e5282`.
12. `f2a6227` — **deferred**. Its 14-file selector-family change conflicts
    with Aira's current selector/test state and overlaps the independently
    applied theme-marker fix. The complete family needs one coherent Aira
    adaptation.
13. `6492144` — **direct copy**. Existing terminal capability logic matched
    the upstream patch exactly; the focused terminal-image test passed all 65
    tests and full check passed. Local commit: `033f82851`.
14. `62835ea` — **adapted**. Aira already had the callback paths but several
    tools discarded or loosely typed the context. The seven-tool cwd behavior
    was adapted, the tools test passed all 74 tests, and full check passed.
    Local commit: `c0625be37`; Aira author, crediting Vytautas and upstream
    `62835ea`.
15. `a63fb12` — **direct copy**. The NO_PROXY patch applied cleanly to Aira's
    proxy matcher and its focused test passed all 5 tests; full check passed.
    Local commit: `701a2c377`.
16. `3fc3ef5` — **adapted**. Source changes applied cleanly, but upstream test
    context differed. Aira-specific theme-marker coverage passed 2 tests and
    full check passed. Local commit: `f13e4e584`.
17. `f8da63b` — **deferred**. It changes the fork contract and nine backend,
    conformance, benchmark, and migration files. Aira lacks the referenced
    fork/storage modules; the patch fails path/context checks.
18. `435b0c6` — **merge commit**, no independent patch to apply.
19. `3205678` — **direct copy**. Added `y-nk pr` to the contributor allowlist.
    Local commit: `2d0231b4b9cbe1f4edb9cd48378f75de32c59472`, with upstream bot
    author and timestamp preserved.
20. `605a1b0` — **direct copy**. Existing SIGWINCH handling matched; its 3
    focused tests and full check passed. Local commit: `83402261b`.
21. `b8b873b` — **adapted**. It was incorrectly deferred initially. The four
    file patch applied cleanly, the OpenAI Responses compatibility test passed
    all 35 tests, and full check passed. Local commit:
    `3598ee219f2f5f9096e99e8146f59d42c39abf8`.
22. `f2eae92` — **deferred**. It adds named-branch ancestry validation and
    cross-backend conformance changes to fork modules absent or incompatible
    in Aira; it belongs with WP08.
23. `1081eb2` — **deferred**. It requires complete configured lanes for
    branch forks and changes the same missing WP08 backend/conformance model.
24. `4e356c0` — **deferred**. It introduces the shared reserved-namespace
    fork classifier, which has no compatible Aira owner without WP08.
25. `4b7a0a7` — **deferred**. It changes WP08 documentation status to “in
    progress”; Aira has not started that implementation, so the status would
    be false.
26. `5dd8c01` — **deferred**. It changes Chord facet post-cutover reload
    failure semantics and service handles; Aira lacks those Chord sources.
27. `1df998a` — **deferred**. It updates Harness documentation for WP08
    semantics that are not implemented in Aira.
28. `bf60867` — **merge commit**, no independent patch to apply.
29. `487af8e` — **merge commit**, no independent patch to apply.
30. `5009d06` — **direct copy**. Added the reusable `deslop` prompt, absent in
    Aira. Full check passed. Local commit:
    `d9928907b7d561f23e0e3d8d6a61e10a528a4358`, original author/timestamp
    preserved.
31. `c30cda1` — **merge commit**, no independent patch to apply.
32. `6ee906d` — **deferred**. It adds Chord source aliases and removes source
    resolution conditions from Vitest. Aira lacks all referenced Chord source
    entry points, so the alias patch cannot be applied meaningfully.

Backup before this range: `backup/pre-range-86bac52-6ee906d` at
`a06f948e9ab3a6eb43e7a7ec190cd1af06add0f7`. No remote push was performed.

### Adjust interactive selector status and availability behavior — upstream `f2a6227`

Defer this complete 14-file selector adaptation. The upstream commit changes
model, scoped-model, settings, thinking-level, and trust selectors together:
status markers move before labels, unavailable scoped models are struck,
scoped-model enablement toggles become consistent, saved trust/theme states
remain visible while browsing, and per-model thinking overrides are marked.
It also updates the changelog and broad selector/regression coverage.

Aira proof: the full upstream patch fails against Aira's current selector test
layout and overlaps the already applied theme-marker adaptation from `3fc3ef5`.
Applying isolated hunks would risk inconsistent marker placement and toggle
semantics across related selectors. Later adapt the full family against
Aira's current `SettingsConfig`, selector components, and existing regression
tests, then run every affected selector test plus `npm run check`.

Relevant upstream references: `packages/coding-agent/src/modes/interactive/components/model-selector.ts`,
`scoped-models-selector.ts`, `settings-selector.ts`, `thinking-selector.ts`,
`trust-selector.ts`, and the corresponding selector tests and regressions.

### Require explicit named branches for session forks — upstream `f8da63b`

Defer this fork-contract change. The patch removes implicit `main` defaults and
requires a named branch in `ForkOptions`, then updates Memory, JSONL, SQLite,
benchmarks, conformance, and migration tests. Aira's fork module and SQLite
storage layout differ from the upstream session-repository architecture; the
actual patch fails against Aira because the referenced fork/storage paths are
absent or structurally incompatible. Implement with the complete WP08 fork
contract, not as an isolated type change.

### Validate fork entries against named-branch ancestry — upstream `f2eae92`

Defer this follow-up to the same WP08 implementation. It validates that a
supplied fork entry belongs to the selected branch's current tip ancestry and
expands cross-backend conformance coverage. Aira lacks the matching upstream
fork/storage modules, and the patch fails its file/context checks. Later
preserve rejection of entries from other branches and ensure failed forks
leave no destination artifact or leaked reservation.

### Require configured lanes for branch forks — upstream `1081eb2`

Defer this fork validation refinement. It rejects data-only or incomplete
branch lane configuration and expands Memory, JSONL, SQLite, benchmark, and
conformance tests. It depends on the named-branch contract and lane-state
model that Aira does not currently share; applying only the validation hunk
would produce a partial contract.

### Centralize scalar fork namespace policy — upstream `4e356c0`

Defer this classifier change with WP08. It introduces a shared fork-policy
module, rewires fork selection, exports the policy, and adds conformance tests
for reserved `pi` namespaces. Aira has no equivalent shared policy owner and
its fork implementation does not use the upstream backend projection model.
Later implement one closed classifier consistently across Memory, JSONL, and
SQLite, including current-state failure for unknown reserved namespaces.

### Make post-cutover reload failures terminal — upstream `5dd8c01`

Defer this Chord facet lifecycle change. It removes the old service-call path,
changes facet reload failure handling and service handles, and expands facet
loader/service tests. Aira has no Chord facet host or service lifecycle
implementation, so isolated deletions would remove no-op or active behavior
without the replacement ownership model.

### Update Harness fork documentation for WP08 — upstream `1df998a`

Defer this documentation update until the named-branch streaming-fork
contract is implemented. It rewrites 33 lines of `harness.md` to describe the
new fork validation, state-copy, and bounded-memory semantics. Aira's current
Harness documentation intentionally describes a different pre-WP08 design;
copying this text now would document unavailable behavior. Reapply after the
WP08 implementation and its conformance tests are complete.

### Resolve workspace source dependencies in tests — upstream `6ee906d`

Defer this test-resolution change with Chord integration. It adds aliases for
Chord source entry points and removes source-resolution conditions from the
Vitest configuration so workspace tests load Chord source directly. Aira has
no `packages/chord` tree or those source entry points; the upstream alias
patch therefore cannot be applied meaningfully. Revisit after adding the
Chord package and update aliases only for entry points that Aira actually
ships.

## Final EOF disposition index — `86bac52` through `6ee906d`

This is the authoritative final index for the completed chronological review:

- Direct copies: `d24c99f` → `b3a6a92fc859a88e50322bb41c8eeaaf74e155e9`,
  `56c6fb3` → `d20313ab5`, `afda4d6` → `cfd8e5282`, `6492144` → `033f82851`,
  `a63fb12` → `701a2c377`, `3205678` →
  `2d0231b4b9cbe1f4edb9cd48378f75de32c59472`, and `5009d06` →
  `d9928907b7d561f23e0e3d8d6a61e10a528a4358`.
- Adaptations: `62835ea` → `c0625be37` and `3fc3ef5` → `f13e4e584`.
- Corrected adaptation: `b8b873b` →
  `3598ee2193f6b5f9096e99e8146f59d42c39abf8`; it was initially classified
  incorrectly and is now implemented.
- Deferred with detailed rationale above: `86bac52`, `6f6fa20`, `fbf2db6`,
  `1a7bc80`, `6c3fafb`, `fa50368`, `7cf456a`, `c4b0e35`, `f2a6227`,
  `f8da63b`, `f2eae92`, `1081eb2`, `4e356c0`, `4b7a0a7`, `5dd8c01`,
  `1df998a`, and `6ee906d`.
- No independent patch: merge commits `435b0c6`, `bf60867`, `487af8e`, and
  `c30cda1`.

All applied code commits passed `npm run check`; targeted tests and their
results are recorded in the chronological ledger above. No commit was pushed.

## Deferred upstream audit — `ee398cb` through `da840b6`

This section was appended after the prior EOF index. Entries retain the upstream
hash, the files inspected, the observed behavior, and the concrete reason the
change is deferred rather than silently dropped.

### Recover mini operations and forward aborts — upstream `ee398cb6d7c3777580303e0f60a6dce0eecb2846`

**Disposition: defer.** The patch changes `packages/coding-agent/src/experimental/mini/README.md`,
`src/experimental/mini/tui/view.ts`, and `src/experimental/mini/worker/run.ts` to recover durable
operations and forward aborts from a stale presentation. Aira has no
`packages/coding-agent/src/experimental/mini/` tree and no `AgentHarness.create()` result with
the upstream `open` recovery list. Copying the three hunks would either be impossible or create
an unconnected recovery path. Implement with Aira's session/workbench owner once its durable
operation recovery contract exists; test stale-view abort and worker replacement together.

### Bound shell execution output — upstream `0095bce7db4fe6a63524b37535315f41b086656d`

**Disposition: defer.** The 16-file diff rewrites `packages/agent/src/harness/env/nodejs.ts`,
`harness/tools/bash.ts`, `harness/types.ts`, and `harness/utils/shell-output.ts`, adds
`adaptive-publisher.ts` and `output-capture.ts`, exports the new contract, and replaces the
Node execution tests and handoff documents. It changes the ownership boundary from tool-level
strings to source-local bounded capture, spill, backpressure, and adaptive publication. Aira's
current harness has different output and tool contracts; copying only the new utility files
would not bound the existing producer. Revisit as one execution-output work package, including
the documented head/tail, spill, abort, timeout, and callback-error tests.

### Scoped storage implementation handoff — upstream `fbb31a7015947d67faf4b7de7bda46dd2fb79b8f`

**Disposition: defer.** This adds the 604-line `packages/agent/docs/mobile-handoff/01-harness/02-scopes/implementation-handoff.md`
and changes `scopes.md`. The document is an implementation contract for scoped Memory, JSONL,
and SQLite storage, retirement records, sidecars, global sequences, and conformance. Aira has no
Chord package and does not share those session-backend paths. Preserve the handoff as design
evidence, but do not present it as implemented until the storage model is deliberately ported.

### Merge `a84a161c7589d30282162e0604c17f349abe5d5c`

**Disposition: no independent patch.** This merge has two parents and no meaningful first-parent
diff to transplant. Its combined changes belong to other commits in this audit; cherry-picking
the merge would duplicate unrelated branch work.

### Finalize bounded shell output integration — upstream `d14d6b22327d545d6a253f932165b63e48d7f9c8`

**Disposition: defer.** The diff updates the shell-output handoff status in
`packages/agent/docs/mobile-handoff/01-harness/01-delta/delta.md` and `README.md`, plus the
`scripts/check-entry-graphs.mjs` budget. Those statements depend on the deferred `0095bce` shell
implementation and its new graph shape. Applying the documentation/status claim now would be
false; apply it with the bounded-output implementation.

### Handoff for settled tools — upstream `6e8b9c8ea6ba378346b8afd5884e2fb34d6d3695`

**Disposition: defer.** The 542-line `packages/agent/docs/work-packages/09-lane-snapshot-settled-tools.md`
handoff specifies the upstream lane snapshot and settled-tool lifecycle. Aira lacks that lane
runtime and the associated durable operation model. It is useful Phase 14 design material, but
not an executable sync.

### Preserve Anthropic per-turn thinking effort — upstream `4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057`

**Disposition: defer.** The 33-file diff changes Anthropic streaming, model generation, provider
composition, settings, proxy/server types, lockfiles, and adds mid-conversation/e2e diagnostics
tests. This is not a one-line API compatibility fix: it introduces per-turn effort persistence
through provider handoff and interactive settings. Aira's provider composition and settings
layers differ, so partial copying risks sending stale effort values or changing lockfiles without
the corresponding runtime. Revisit as a complete provider/settings slice with the upstream
tests adapted to Aira's configuration model.

### Retain settled tools until placement — upstream `e26afb63a46c374f4f482f4808317336790abb7a`

**Disposition: defer.** This changes 15 agent/runtime/docs/test files, including
`harness/runtime/drive/tools.ts`, `lane.ts`, `reducer.ts`, and watch/drive tests. It changes when
settled tool records remain visible until placement and coordinates terminal cleanup. Aira's
runtime does not have the same Drive/lane state machine; an isolated reducer change cannot be
validated. Implement with the complete lane-snapshot/settled-tool contract.

### Resolve plugin and conformance tests from source — upstream `e7b47bd7deab19641f5c4f9b56775b4fdb1b9908`

**Disposition: defer.** The diff changes `packages/coding-agent/src/experimental/plugins/bundled.ts`
and the SQLite Vitest config to resolve source entrypoints. Aira's package exports and conformance
layout differ, and the later source-only export assertion fails against Aira's current published
`./client` runtime export. Revisit with the packaging migration, not as a config-only copy.

### Cancel compaction on session abort — upstream `bea67d90d1a74dde8852c63cac72d476013d3879`

**Disposition: defer.** The diff changes `agent-session.ts`, RPC semantics, compaction suite tests,
and RPC docs. It coordinates an active compaction cancellation with session abort; Aira's session
controller and compaction ownership are different. Copying the 15-line control change without
its test state machine could leave a compaction promise running after abort. Port with Aira's
session lifecycle and cancellation tests.

### Merge commits `7123410467dfdff6e9975a7f185634b8a6b9cb1b`, `8c08d0645a62851b995c5b7ac00de1d50c9d325b`, and `9f74575f7902219dacdf079725b6e3bb9b4a0851`

**Disposition: no independent patch.** These merges combine already-audited dev/main work. The
individual parent diffs were inspected separately; no merge commit should be copied into Aira.

### Remove unnecessary Chord dependency — upstream `bf157122af6d66a01f267a450a831b1ea53cab3d`

**Disposition: defer.** The six-file diff removes Chord imports and rewires the AI package around
the post-Chord provider boundary. Aira has no `packages/chord` package and its current imports
already follow Aira's package layout. Applying deletions would either be a no-op or remove the
wrong dependency; revisit when Chord integration is intentionally designed.

### Relational algebra symbols and related test correction — upstream `f0592205f808c44bbd9705847220adcf2f584224`

**Disposition: defer.** The three-file mixed commit combines a TUI symbol-rendering change with a
coding-agent test type correction. Because the exact patch targets upstream TUI/theme and test
structures that Aira has customized, it is not a safe direct copy. Split and review each behavior
against Aira's renderer if the symbol feature is wanted.

### Restore stream compatibility — upstream `8b5899dce26f9f6b8d313ee6a4b4a8dccbb9bfc2`

**Disposition: defer.** The 14-file AI diff changes stream event typing and frame construction
across Anthropic, Google, Mistral, OpenAI, Azure, Codex, and shared helpers, with four test files
updated. Aira already has provider-specific frame adaptations, so copying the broad upstream
compatibility rewrite risks regressing existing providers. Port only after comparing Aira's frame
invariants and adding provider-by-provider tests.

### Preserve provider thinking level in frames — upstream `0fdec07ba3973f9bd008cbfffb0eaa10ace8c5b3`

**Disposition: defer.** Although only two files change, this is coupled to the frame contract
introduced by `8b5899dc`: `assistant-message-frame.ts` and its tests. Aira's frame representation
must first be reconciled with that compatibility work; an isolated field preservation change is
not sufficient evidence.

### Raise branch summary output cap — upstream `e44d75c20a51142abc056c243b13c1d7bb4be687`

**Disposition: defer.** The four-file change adjusts compaction limits, settings documentation,
changelog, and a branch-summarization test. Aira's compaction prompt and output-limit settings
are customized; blindly changing the cap could increase token cost or exceed Aira's model limits.
Re-evaluate with Aira's configured context budget and a matching regression test.

### Working spinner, jump-to-end, scrollbar, and linear search TUI series — upstream
`1d9787c11fb91ecf7c892050f4c0607a995dd15b`, `79680533c6b898894f2d2421c7f640b212d3dfdd`,
`457ae8c79c2e3c570a36d305095afa18d3791dd1`, and `2d41163332c1a6d11c45911a92100fd2a55e4d1`

**Disposition: defer as separate TUI work packages.** These diffs touch dozens of interactive
and pi-tui files: status indicators/editors/loaders, fullscreen scrolling, layouts, themes,
search indexing, mouse behavior, and many tests. Aira has already adapted the TUI with its own
workbench/sidebar and theme layers. Individual hunks can compile while breaking renderer state,
selection semantics, or accessibility. Revisit each feature against Aira's current TUI contract,
with focused tests before any copy.

### Signal-killed process exit codes — upstream `c2d3dc55b0b20af5aa3bb1d25774968116c9733f`

**Disposition: defer.** The diff changes Node execution signal mapping and its tests. Aira's
execution environment already contains cwd/tool adaptations and may use different process error
normalization. Port only after checking the exact Aira `ExecutionEnv` result contract and adding
signal-termination coverage.

### Remote harness dependency packaging — upstream `1382777ed8000e8a84f81053d66f6bb713dccd92`

**Disposition: defer.** The 28-file migration changes package exports, CLI entrypoints, Bun setup,
release scripts, lockfiles, workflows, consumer tests, and removes `src/main.ts`. This is a
release/packaging architecture change, not a source-level sync. Aira's product entrypoint and
release identity differ; implement only as a planned packaging phase with install smoke tests.

### Alt-wheel acceleration — upstream `ab9e6f89b45344f5e84e33eb6140f3e6e4c8d81e`

**Disposition: defer.** The two-file patch changes fullscreen wheel handling and tests, but Aira's
TUI has custom selection/scrollbar behavior. Reapply after the deferred scrollbar/selection review
so modifier handling does not conflict with Aira's mouse routing.

### Release/changelog commits — upstream `1a46b923d7c725e4d0759139f8687f04797a33d4`,
`1148f7958c260188b03488496044dcfa852ef580`, `107d79f11072bbc8a3a757ed7fd69596bee7d68c`,
`dd7e816b57dedbe971d159b388f48317a6139079`, `d981de1229ef899957bbe968bc8dcda02a21f477`,
and `da840b6216578c2a571d0374ac6a2091a83f9d91`

**Disposition: defer/no-op.** These commits audit or create released/unreleased changelog
sections and bump the entire upstream lockstep package version. Aira deliberately remains on its
own product release cadence (`0.1.4` while embedding Pi `0.84.3` at the start of this sync), so
copying Pi release metadata would mislabel Aira. Apply the relevant product changelog entries when
Aira is intentionally updated to `0.1.5` after the upstream sync.

### GPT-6 Astra support — upstream `17de82d7bea18a6589677a9761baabc2060c9efb`

**Disposition: defer.** The eight-file diff changes model generation, OpenAI Responses capability
handling, model types, tests, and coding-agent model docs. Aira's model catalog is generated and
has custom provider/model metadata; this needs a catalog regeneration and verification of the
Responses `max_output_tokens` behavior, not a partial model entry copy. Revisit after deciding
Aira's supported Pi release/model policy.

### Mouse-hover list behavior — upstream `9841914c71a74d81abe07f751aefd271fd924e63`

**Disposition: defer.** The diff changes both `select-list.ts` and `settings-list.ts` plus 70 lines
of mouse tests. Aira's selectors have additional workbench state and keybinding behavior. Port
with Aira-specific hover/focus tests after the current TUI series is reconciled.

### Selector save keybindings — upstream `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`

**Disposition: defer.** It changes core keybinding defaults, three selector components, docs,
changelog, and tests. Aira's selector/keybinding layer has product-specific bindings; copying the
upstream defaults could override configurable Aira behavior. Reconcile defaults and persistence
semantics in a dedicated adaptation.

### Source-only experimental exports — upstream `6f11c31d1134a32e64bf221baeec38e431091e05`

**Disposition: defer.** The test-only assertion expects `./client` and `./experimental/plugin` to
be source-only exports. Running it against Aira proved the mismatch: Aira's package metadata still
returns the built `./client` import/types entry. The standalone test was reverted locally after
failure (`af2af6c54...`); do not re-add it until the packaging migration is implemented.

### Deferred package/release follow-ups — upstream `e7b47bd`, `d981de1`, and `da840b6`

**Disposition: defer.** Their diffs were inspected in full as source-resolution, release, and
unreleased-section changes. They depend on the same package-layout/version decisions above and
would either duplicate Aira's existing metadata or alter its product release identity.

### Catalog-dependent fixes proven incomplete — upstream `22940a62f5b7c998530a467f00b54307c3cd911f` and `265a33393eee4191b5b6ede216d38b7a32203c5`

**Disposition: defer.** `22940a62` changes `processBasetenModels()` and tests both GLM 5.2
endpoints as text-only. Aira's focused test still observed `["text", "image"]` because its
checked-in `packages/ai/src/providers/data/baseten.json` retains the old snapshot. `265a3339`
adds Qwen 3.8 Flash mappings/tests, but Aira's focused suite reported eight failures: the
individual-plan model is absent and Aira maps existing Qwen 3.8 effort as `max`, not upstream
`xhigh`. Both incomplete applications were reverted (`5de8f9d48...`, `85ce3643d...`). Reapply
only with matching generated data and provider mappings.

### Contributor allowlist — upstream `2c273c1d90f078c16760524d778096b782edc093`

**Disposition: defer.** This adds `edverma pr` to `.github/APPROVED_CONTRIBUTORS`, which controls
CI contributor authorization. The system rejected committing this security-sensitive change
without explicit authorization; no local edit remains.

### Applied local proof index for this range

Direct or compatible hunks applied and checked: `96317e50b8d6` → `3fd2023c3`, `23842b1e693e` →
`03f988f49`, `ebc374490952` → `37449271a`, `256f63024d03` → `1aadd3799`, `69afa10503ad` →
`0f2f28006`, `1e4fbe3847e` → `2886e845a`, `e583b290a61e` → `6b42651d6`, `e266507b606b` →
`d10444620`, `f41f80466e30` → `37b364b9b`, `55adba4f2439` → `e583b3f1a`, `64eeb82a4694` →
`575d3bfe8`, `6aedd1066e54` → `eb1362eba`, `0dbf2b76fe79` → `24e98e168`, `007c0be64078` →
`c9fcd03b9`, `47236c844506` → `6d9699fe3`, `082f7577c23e` → `a8cf40d59`, `2631b25c34cb` →
`0bb06b350`, `1a773c8e7` → `d8b5f7ec3`, `2b768ba4` → `f5056682f`, `57e53b0d` → `bf235012a`,
`c6b00676` → `3b9cf2ba6`, `6f35de5` → `87b575c67`, `1d6dbf9` → `92d8b9639`, and `fbc87d25` →
`531480492`. Focused test counts from these commits were recorded in this chat; every code
commit's pre-commit `npm run check` passed.

All other commits in `ee398cb^..da840b6` were inspected by their complete file diffs and are
deferred/no-op where documented above: primarily missing Chord/session architecture, broad TUI
redesigns, package/release migrations, catalog snapshots, merge commits, and security-sensitive
allowlist changes. No upstream release commit was copied and nothing was pushed.
