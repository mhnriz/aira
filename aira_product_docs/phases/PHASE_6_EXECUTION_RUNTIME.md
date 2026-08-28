# Phase 6 — Execution Runtime: Report

> Status: complete (2026-08-28) | Commits listed at the end are part of this phase.
> Scope honored per the phase brief: the smallest robust native execution
> foundation — a process/runtime SERVICE owned by the harness, not a
> replacement bash tool. No browser work, no Phase 8 verifier, no
> engineering-loop.

## Architecture

### Modules introduced (`src/aira/execution/`)

```text
src/aira/execution/
├── manager.ts            AiraExecutionManager — the per-session runtime owner
├── buffer.ts             BoundedOutputBuffer — capped per-stream tails
├── platform.ts           cross-platform termination strategy (injectable effects)
├── project-commands.ts   project-aware runTests/runBuild/runCheck/runDev + depth resolution
├── tools.ts              process_start / process_status / process_logs / process_stop
├── status.ts             AiraExecutionStatus snapshot shapes (canonical state)
├── types.ts              ProcessRecord / ExecutionResult / events / handle
└── index.ts              public surface
```

### Canonical ownership model (ADR-024)

- One `AiraExecutionManager` per `AgentSession` instance, created at session
  construction (before the tool registry builds, so the process tools bind
  to it) and disposed with it.
- Every `ProcessRecord` carries `ownerSessionId` and belongs to exactly one
  manager. `dispose()` terminates ONLY the owning manager's processes
  (graceful → grace → forced). Two live sessions over the same session file
  (the legal Phase 1 overlapping lifecycle, ADR-018) can therefore never
  kill each other's processes; stale canonical-state disposal remains an
  ownership-checked no-op.
- Reuse is conservative and same-manager-only: `reuse: "reuse"` returns the
  manager's own still-running `dev` background process with identical
  cwd+command; `restart` terminates a match first. Arbitrary OS processes
  are never adopted; cross-session adoption is explicitly out of scope.
- Managed pids are registered with the host's last-resort detached-child
  tracking (`trackDetachedChildPid`), so SIGHUP/SIGTERM crash paths still
  reap them (verified in dogfood: TUI SIGTERM → dev server died).

### Host lifecycle integration points

```text
AgentSession constructor → createAiraExecutionManager(state, cwd, options)
AgentSession._buildRuntime → merge createAiraProcessToolDefinitions(...)
AgentSession.dispose()    → void this._airaExecution?.dispose()
AgentSession getter       → get airaExecution() (host/tests)
interactive /processes    → session.airaExecution.list() + formatProcessLine
/doctor                   → execution check from state.execution snapshot
```

### ProcessRecord / ExecutionResult shape

```text
ProcessRecord
├── id (dev-2 / test-1 style counter per purpose)
├── request { command | exe+args, cwd, env? }
├── purpose (run|test|build|check|dev|other)
├── mode (foreground|background) · ownerSessionId
├── pid / child handle · createdAt / startedAt
├── status (running|exited|terminated|spawn-failed)
├── exitCode / exitSignal / exitReason (exit|signal|timeout|cancelled|user|session-end|restart|spawn-error)
├── exitConfirmed (OS event seen) · exitedAt / terminatedAt
├── stdout / stderr BoundedOutputBuffer (128 KiB tail each)
└── exitPromise (resolved only after output pipes settle — never loses late output)

ExecutionResult
├── status (exited|terminated|timed-out|cancelled|spawn-failed|backgrounded|unavailable)
├── ok · exitCode · signal · durationMs · processId
├── stdout/stderr bounded tails with truncation flags
└── reason (spawn errors, fallbacks) — never raw full logs
```

`state.execution` carries a bounded snapshot (process table + up to 8 recent
result summaries); logs and truth live in the manager (ADR-024). Events:
`process_started`, `process_backgrounded`, `process_exited` (minimal bus for
later supervision; no supervision system built).

### Foreground / background semantics

- Foreground (default): waits for completion; optional `timeoutMs`; AbortSignal
  cancels (status `cancelled`).
- Background: returns immediately with a managed id; optional `timeoutMs`
  bounds it; logs keep flowing into the capped buffers.
- Auto: foreground until the process is still alive past the threshold
  (default 20s), then it is reclassified as managed background and the call
  returns a backgrounded handle. **The trigger is a runtime signal ("still
  alive past the threshold"), not a command-name heuristic** (per the brief);
  the contract is documented in the tool description and ADR-024.

### Timeout / cancellation semantics

- Foreground timeout → graceful termination → grace (1.5s) → forced; status
  `timed-out`, truthful.
- User abort (tool-call AbortSignal) → same path, status `cancelled`.
- Session disposal → same path with reason `session-end`.
- Forced fallback also probes the process group for survivors: a shell whose
  child ignored SIGTERM gets the whole tree reaped (this is why a polite
  SIGTERM alone is insufficient — observed and fixed during testing).

### Log buffering strategy

Per-stream `BoundedOutputBuffer`, default cap 128 KiB, keeps the TAIL,
marks truncation, tracks total/dropped bytes. The result tail caps at 6000
chars with an explicit `[stdout truncated]` marker; `process_logs` returns a
bounded tail (100–20000 chars). No persistence across restarts (Phase 6
scope); no unbounded memory.

### Process reuse/restart rules

Same-manager, purpose `dev`, still running, exact cwd+command match, and
explicit `reuse` policy. `new` (default) always launches. Documented in the
tool schema, ADR-024, and this report.

### Cross-platform strategy

`platform.ts` isolates termination per platform, with injectable
`KillEffects` so Windows behavior is a tested contract on any host:

- POSIX: spawn detached (process-group leader); graceful = SIGTERM to
  `-pid`, forced = SIGKILL to `-pid`, single-pid fallback; group-alive probe
  via `kill(-pid, 0)` to decide whether forced reaping is needed.
- Windows: `cross-spawn`-compatible resolution; graceful = `taskkill /PID`
  (no /F), forced = `taskkill /F /T /PID` (whole tree), direct-kill
  fallback, no portable group probe → always re-kill after graceful
  (harmless when already gone).
- Shell invocation reuses the host `getShellConfig()`/`getShellEnv()`
  (git-bash discovery on Windows, `binDir` PATH injection, stdin transport
  for legacy WSL bash); stdout/stderr decode with streaming TextDecoder and
  the host's ANSI/binary sanitization.

### Capability semantics

- `process_start` / `process_stop` classify `process` → PLAN-blocked by the
  existing semantic gate (no hard-coded new gate).
- `process_status` / `process_logs` classify `diagnostic` → PLAN-safe; they
  joined the PLAN read-only availability set (`AIRA_READ_ONLY_TOOLS`).
- `AIRA_MUTATING_TOOLS` audit set extended to match. No new policy engine.

### Relationship with Phase 5 intelligence

Cooperate, don't couple: the intelligence coordinator does not own
processes; the process manager does not own diagnostics. `/doctor` reports
both (`intelligence` + `execution` checks). The post-edit intelligence
pipeline is untouched; targeted execution primitives exist for later
orchestration to choose among (Phase 8), and Phase 5 diagnostics remain the
cheap immediate feedback path. No automatic run-after-edit behavior was
added (explicitly out of Phase 6 scope).

## Project execution

- `AiraProjectCommandRunner` consumes ONLY `ProjectProfile` + its commands
  (ADR-021) — no redetection, no competing project model.
- runTests: depth TARGETED (npm/pnpm/yarn/bun `-- <target>`, pytest/cargo/go
  `<target>`, dotnet project files; unknown toolchains append with a note) /
  RELATED (nearest subpackage with its own defensible profile — reuses Phase
  4 detection for that root) / PROJECT (full profile command). No profile or
  no command → truthful `unavailable` result.
- runBuild: first build command. runCheck: profile `checkCommands`
  (Phase 6 small canonical extension: TS `scripts.check`/`npx tsc --noEmit`,
  Python mypy/ruff, `cargo check`, `go vet`) with an explicit build-command
  fallback note. runDev: background by default, reuse-aware.
- No full-suite-after-every-edit behavior; primitives only.

## Modes

- BUILD: full execution — foreground/background/dev/tests/builds/checks;
  process tools active by default; normal capability semantics.
- PLAN: read-only at the host boundary as before. The new runtime cannot
  bypass it: process_start/process_stop are `process`-classified and blocked
  by the existing `beforeToolCall` gate AND hidden from the model
  (read-only availability set); process_status/process_logs are diagnostic
  and inspection-safe. Verified by tests and the dogfood doctor output.
- REVIEW: unchanged semantics — inspection emphasis, still implement-capable,
  execution allowed as safe verification; still NOT the Phase 8 Verifier.

## Dogfood (real `aira` binary, real provider)

Rebuilt `packages/coding-agent/dist` and drove the actual TUI on a pty
(tmux is not installed on this machine; used a Python pty driver), connected
to the configured `opencode-go` cloud provider, in a fixture Node project
(`/tmp/aira-p6-dogfood` with `npm test` → node echo, `npm run dev` → a
harmless ticker).

Flow A — simple execution:

```text
start node -e "console.log('p6-short-ok')"
exit code 0 · 1.3s
p6-short-ok
/processes →
  test-1  exited  node -e "console.log('p6-short-ok')"  1.3s code 0
```

Flow B — managed process lifecycle:

```text
start node dev-server.js
Started managed process dev-2 (node dev-server.js)
status dev-2 →  dev-2  running  node dev-server.js  2.9s  · pid 37984
logs dev-2   →  p6-dev-server-ready / p6-dev-tick-0 … (no stderr)
stop dev-2   →  process dev-2 terminated after 9.8s
/processes →
  test-1  exited     node -e "console.log('p6-short-ok')"  1.3s code 0
  dev-2   terminated  node dev-server.js  9.8s
/doctor → ok execution: active · 2 process(es) (0 running) · …  summary: 9/9
```

Lifecycle observed: after the TUI received SIGTERM, the managed dev process
was gone (session disposal cleanup, confirmed via `ps`). One real bug was
found and fixed by dogfood: the SDK-created host sessions (interactive/print/
RPC) used an explicit default tool list that overrode the new tools — the
process tools were registered but not active, so the model could not call
them. Fixed in the SDK default list (commit `43323ef9a`); the re-run shows
the model using process_start/status/logs/stop end-to-end.

## UI backlog

`aira_product_docs/UI_BACKLOG.md` (B-001) records the future native bottom
bar surfacing language-intelligence/LSP state ambiently (`◈ BUILD │ LSP TS ✓
│ LSP TS 2E 1W`, compact multi-language form, truncation rules). Recorded
only; NOT implemented in Phase 6.

## Verification

### Tests added

- `test/aira/execution/manager.test.ts` — real child processes: foreground
  exit 0/non-zero, spawn failure, timeout, cancellation, managed
  background (status/logs/terminate), auto-background escalation &
  foreground retention, graceful→forced fallback (SIGTERM-ignoring child),
  buffer caps/truncation, record bounding, reuse/restart rules, overlapping
  session isolation (two managers over one session id), disposal cleanup,
  canonical snapshot, lifecycle events (15).
- `test/aira/execution/platform.test.ts` — mocked termination strategy:
  POSIX group SIGTERM/SIGKILL, single-pid fallback, survivor probe, Windows
  taskkill without/with /F /T, direct-kill fallback, Windows always-rekill
  (9).
- `test/aira/execution/project-commands.test.ts` — depth semantics per
  toolchain, outside-root fallback, unavailable results, build/check
  consumption + fallback note, dev background+reuse, subpackage resolution
  (real fixture dirs), passthrough of mode/timeout (11).
- `test/aira/execution/host-integration.test.ts` — real AgentSession path:
  runtime armed + tools registered by default, model tool call →
  structured result text, background lifecycle through the session manager,
  dispose isolation across harnesses, PLAN blocking/allowance, REVIEW
  availability, spawn-failure degradation (7).
- Limits/tool-surface updates: capabilities, modes, plan-readonly, doctor
  (9 checks + execution cases), intelligence host-integration PLAN set,
  harness execution options, SDK tool-surface regressions (3592, 5109).

### Focused results

```text
vitest --run test/aira/execution      → 4 files, 44 passed, 0 failed
vitest --run test/aira                 → 213 passed, 0 failed
vitest --run test/suite test/aira      → 99 files, 474 passed, 0 failed
tsgo --noEmit (package)                → PASS
biome check (changed trees)            → clean
```

### Repo-wide checks

`npm run check` (biome `--error-on-warnings` whole repo, pinned-deps,
ts-imports, shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke) ran on
every Phase 6 commit via the pre-commit hook: PASS on all six commits.

The full non-e2e suite (`./test.sh`, isolated HOME) passed except the two
documented pre-existing environmental failures in `packages/ai`
(`fireworks-models` Fire Pass turbo router, `zai-coding-plan-models` zero
costs — machine-hydrated catalog pricing, zero Phase 6 diff in
`packages/ai`; the zai failure is the same one documented in Phase 5):

```text
coding-agent    2189 passed / 50 skipped — 0 failed (Phase 5: 2139/50)
packages/ai     2 failed / 946 passed (pre-existing environmental only)
agent 147 · tui 50 · client 15 · evals 36 · session-backends 87 · scripts 23 — all passed
```

One new Phase 6 finding was fixed during the full run: the
`default-tools-setting` regressions needed the extended built-in
enumeration for the process tools (committed as `3c9bad704`).

## Compatibility concerns

- No extension API, slash-command, keybinding, or package surface was
  removed; `/processes` follows the unnamespaced core-command convention
  (ADR-017).
- The SDK's `getAllTools()`/default active tool set now includes the four
  process tools (explicit `defaultTools`/`tools`/`noTools`/exclude semantics
  unchanged); two upstream regressions were updated for the extended
  built-in enumeration.
- PLAN behavior for extension tools is unchanged (unknown = permissive,
  ADR-022).
- Unknown/third-party tools remain unclassified; only the new built-ins
  gained classes.

## Architectural decisions that became ADRs

- **ADR-024 — Execution is a session-owned runtime service; process
  ownership is per-session-instance with explicit lifecycle semantics**
  (ownership/cleanup contract, reuse rules, auto-background contract,
  termination sequence, bounded state, orphan tracking).

## Local Git commits created (nothing pushed)

```text
a013fbde3 feat(aira): add native execution runtime with managed process lifecycle
400129c18 feat(aira): wire execution into host tools, modes, capability semantics
c0033ad09 feat(aira): add check commands to the canonical project profile
f08d83660 test(aira): cover the Phase 6 execution runtime through the host
43323ef9a fix(aira): make process tools active by default in SDK-created sessions
3c9bad704 test(coding-agent): extend default-tools regression for the native process tools
bd93e93f0 docs(aira): Phase 6 report, ADR-024, changelog, architecture, UI backlog
<docs commit> docs(aira): record full-suite verification results and commit list in Phase 6 report
<chore commit> chore(aira): drop accidentally staged workbench mockup from the docs commit
```

## Final `git status`

Working tree clean after the docs commit. `main` ahead of `upstream/main`,
behind by 29 (baseline divergence, unchanged). Only remote: `upstream`
(Pi). No `origin`, nothing pushed, nothing published.

One correction was committed during the phase: the docs commit accidentally
staged `aira_product_docs/AIRA_WORKBENCH_MOCKUP.html`, an untracked file
belonging to another session; a follow-up `chore` commit removed it from
tracking (working-tree copy untouched), restoring it to untracked state.

## Stopping point / next phase

Stopped after Phase 6 per roadmap discipline. Next: **Phase 7 — Browser
Runtime** (BrowserProvider abstraction, CDP/Playwright spike, isolated
profile). No Phase 7 functionality has leaked in; `engineering-loop` was not
consulted or integrated.