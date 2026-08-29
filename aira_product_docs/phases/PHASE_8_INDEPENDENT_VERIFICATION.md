# Phase 8 — Independent Verification: Report

> Status: complete (2026-08-29) | Commits listed at the end are part of this
> phase. Scope honored per the phase brief: a native independent verifier
> consuming bounded evidence from the Phase 4–7 subsystems (repository,
> language, execution, browser, git), with a documented independence boundary,
> canonical PASS/FAIL/INCONCLUSIVE semantics, freshness, smart token
> behavior, and UI-ready state. No repair loop, no durable goals, no task
> DAG, no Workbench UI, no footer redesign, no generic Context Broker, no
> persistent verification history, and **no engineering-loop** (ADR-013).

## Reference study

### Installed paths inspected (READ-ONLY)

`pi-maestro-flow` was not installed in stock Pi; per the brief it was
installed into STOCK PI first (`~/.pi/agent/npm/node_modules/pi-maestro-flow`
v0.24.0 + companion packages `pi-maestro-teammate`, `pi-maestro-backends`,
`pi-maestro-backend-core`, `maestro-flow`) and inspected read-only there —
never into Aira. `pi-lens` (v4.1.2) and `pi-codeontime-code-intelligence`
(v0.2.4) were already installed under `~/.pi/agent/npm/node_modules/` and
inspected read-only.

```text
~/.pi/agent/npm/node_modules/pi-maestro-flow/          v0.24.0 (installed for this study)
└── src/tools/goal-verification.ts     the goal verifier: verdict model, evidence
│                                      envelope, completion fence, failure budgets
└── src/teammate/…  agents/verifier.md (in pi-maestro-teammate) the verifier role prompt
~/.pi/agent/npm/node_modules/pi-lens/                  v4.1.2 (MIT)
└── dist/clients/freshness.js          one freshness kernel: mtime-vs-reference
│                                      fresh|stale|indeterminate, 50ms drift tolerance
└── dist/clients/blocker-freshness.js  stale demotion (mark, don't delete/assert)
~/.pi/agent/npm/node_modules/pi-codeontime-code-intelligence/ v0.2.4
└── dist/src/review/{diffParser,machineChecks,reviewDiff}.ts
                                       diff review: parse unified diff, machine rules
                                       (forbidden imports/deps/paths, required test
                                       path for source changes, duplicate text)
```

### Architecture findings

**pi-maestro-flow (goal verifier)**
- The verifier is a FRESH subprocess (`agent: "verifier"`) with `systemPromptMode:
  replace`, no inherited project context, thinking low, and tools restricted to
  read/grep/find/ls — the independence boundary is structural.
- Structured verdict: `{pass, reasoning, unmet[], evidence[]}` via a strict
  output schema; hardened normalization: pass+unmet → actionable fail, pass
  without concrete evidence → inconclusive, malformed → inconclusive.
- Bounded evidence envelope: objective (≤ 4k), completion summary (≤ 4k),
  recent session evidence + canonical workflow evidence (≤ 12k chars total,
  ≤ 24 items of ≤ 1.2k), secret-redacted, wrapped as `<untrusted_data>` with
  XML escaping.
- Completion boundary: explicit `goal complete` tool call; a
  `verificationInFlight` guard prevents duplicate concurrent runs; a
  completion FENCE (goal identity + revision captured before, re-checked
  after) discards verdicts if the goal moved while verifying.
- Failure budgets: inconclusive ×3 → pause; fail resets the budget;
  infrastructure errors (verifier load/provider) do not consume the goal's
  failure budget but are bounded (3 consecutive → pause).
- Acceptance-command-first: deterministic acceptance commands run before any
  agent verifier.

**pi-lens**
- ONE freshness kernel: `freshnessFromMtime({mtimeMs, referenceMs,
  toleranceMs})` → `fresh | stale | indeterminate` (+ 50ms drift tolerance for
  Windows mtime skew); callers map `indeterminate`.
- Stale blockers are DEMOTED with a `[stale — re-run to confirm]` marker and
  taken out of the authoritative channel — never silently deleted, never
  re-asserted with stale authority.
- Dependency-axis invalidation: a blocker for file F covers F's imports; when
  only a dependency changes, a read-time stat sweep over the forward imports
  (bounded, ≤ 128) demotes LSP-sourced blockers.

**pi-codeontime-code-intelligence**
- Diff review parses a unified diff and applies machine rules with severity +
  evidence: forbidden imports/dependencies/path edits, required-test-path for
  source changes, duplicate added text; a codebase-dry pass adds coverage-gap
  warnings (changed source without a test counterpart).

### Classification (implement natively / adapt / defer / reject)

1. **IMPLEMENT NATIVELY** — fresh-context verifier model invocation with a
   restricted read-only tool set; structured verdict with hardening rules
   (pass+unmet→FAIL, pass-without-evidence→INCONCLUSIVE); bounded
   secret-redacted untrusted evidence envelope; completion-boundary trigger at
   `agent_end` (Aira's native equivalent of Maestro's explicit completion
   boundary); in-flight guard + revision dedupe instead of per-goal fences;
   freshness via mtime-vs-reference with drift tolerance (Phase 5 kernel
   pattern); per-requirement explicit/inferred checklist; missing-evidence
   semantics; scope-drift assessment; canonical token-free snapshot.
2. **ADAPT** — failure budgets (bounded consecutive inconclusive/infra runs
   inform the FAIL transition, no pause machinery needed yet); the completion
   fence (Aira equivalent: the change-set revision is recomputed after the
   run and the result is published stale if the set moved).
3. **DEFER** — acceptance-command declarations, repair loops, goal objects,
   verification history persistence, verifier model routing settings
   (runtime resolver seam exists), browser-run-verification flows (evidence
   is snapshot-based in Phase 8), workflow/canonical-session evidence.
4. **REJECT** — teammate subprocess spawning (Aira runs the verifier in-loop
   as an awaited agent_end listener, which also fixes print-mode settlement),
   the extension-based registration model, daemon persistence, embeddings /
   large graph machinery, the maestro `goal` command surface.

### Source/license provenance

No source was copied or substantially adapted: the verdict contract, the
hardening rules, and the freshness kernel are original Aira implementations
informed by protocol-level study. pi-maestro-flow: license reviewed at
install (MIT); pi-lens: MIT; pi-codeontime-code-intelligence: MIT. Aira has
zero runtime dependency on any of them (the isolated dogfood agent dir had no
reference packages and every successful dogfood pass proved the native path).

## Architecture

### Modules introduced (`src/aira/verification/`)

```text
src/aira/verification/
├── types.ts          verdict contract (PASS/FAIL/INCONCLUSIVE), requirement
│                     model, findings, evidence items, scope assessment,
│                     VerificationResult, AiraVerificationStatus snapshot
├── settings.ts       verification.enabled / auto (off|smart|always) /
│                     contextBudget (compact|balanced|expanded) + defaults
├── eligibility.ts    deterministic trivial-work classification (doc/comment/
│                     one-line-rename-with-clean-diagnostics) and
│                     off/smart/always decision
├── requirements.ts   bounded normalization of verifier-emitted requirements,
│                     findings, evidence, missing evidence, scope (caps +
│                     stable ids + explicit/inferred distinction)
├── evidence.ts       bounded aggregation from canonical snapshots
│                     (intelligence/execution/browser + repository change
│                     seam + run-tracked edits), budgets (6k/10k/16k chars),
│                     missing-evidence derivation, secret redaction,
│                     truncation markers
├── prompt.ts         the verifier system prompt (role, process, verdict
│                     rules, output contract) + untrusted envelope builder
├── verifier.ts       fresh-context runner: restricted tool loop
│                     (read/grep/find/ls, ≤ 4 rounds × 2 calls), verdict
│                     parsing + hardening, timeouts, cancellation, driver
│                     failure → INCONCLUSIVE-with-lastError
└── manager.ts        AiraVerificationManager — lifecycle owner: agent_end
                      trigger, settings×mode×work gates, revision dedupe,
                      freshness (event + mtime drift), completion fence,
                      publish/subscribe, verify() API, dispose
```

### Verifier ownership / independence boundary

One `AiraVerificationManager` per `AgentSession` instance (ADR-024/ADR-025
pattern), created at construction, disposed with the session. The verifier is
a FRESH model context: its own system prompt, a bounded secret-redacted
evidence envelope, and read/grep/find/ls only — never the implementation
conversation, never a shell, never edits, never browser interaction, never
network. The envelope carries: objective, mode, changed-file summary
(paths/status/±lines), language diagnostics (live-code status + finding
counts), execution results (bounded recent results), browser evidence
(verification/console/network/observation), explicit missing-evidence and
limitation markers, and known limits. The implementing agent's turns are
excluded by construction.

### Lifecycle trigger / completion boundary

`agent_end` (the run-level completion event; in this host the run promise
resolves only after awaited `agent_end` listeners settle, which the manager
uses so print/headless sessions stay alive through verification). Not every
turn, not every tool call. The run scope spans all provider turns of one
run (a run = several turn_start emissions). Automatic runs are gated by:
`verification.enabled` → `verification.auto` ≠ off → mode ≠ PLAN →
work happened (successful edit/write, execution-result delta, or browser
operation) → smart-mode non-trivial classification → revision dedupe.
Explicit `verify()` (via `/verify`) bypasses the smart/trivial gate but
honors `enabled`, dedupe-with-current-result, and the in-flight guard.

### Requirement representation

Verification is requirement-driven: the verifier extracts a bounded checklist
(≤ 8) from the objective with `kind: explicit | inferred`, and maps each to
`verified | unmet | unverifiable`. Explicit = stated by the user; inferred =
necessary for the objective; the policy forbids manufacturing quality
requirements. Deterministic normalization (caps, stable ids, status kinds)
lives in requirements.ts; derived counts feed the UI snapshot.

### Evidence aggregation and budget

`buildVerificationEvidence` consumes ONLY canonical snapshots +
provider-independent seams:
- Repository: `AiraIntelligenceStatus.repository` + a new read-only
  `verificationChanges()` seam on the intelligence handle (per-file git
  change stats: path/status/±lines via `git status --porcelain` +
  `git diff --numstat`, ≤ 200 files, 3s git bounds); run-tracked edited
  paths merge in when git is unavailable.
- Language: `AiraIntelligenceStatus` liveCode status + findings counts
  (stale findings excluded).
- Execution: `AiraExecutionStatus.recentResults` (bounded tail).
- Browser: `AiraBrowserStatus` verification/console/network/observation.
- Git/change state: the seam's per-file stats + aggregate ± lines.
Budgets: compact ≤ 6000 / balanced ≤ 10000 / expanded ≤ 16000 characters of
envelope text; every section truncates with a marker; secrets are redacted
(API keys, tokens, cookies, credentials-in-URLs, private keys, JWTs, gh
tokens); the envelope is framed `<untrusted_data>` and XML-escaped.

### Model invocation strategy

Same configured model via the session's stream function and auth (the
`verifierRuntime` resolver seam on AgentSession; a future settings knob can
swap in a dedicated/lower-cost model without touching the manager). Output
bounded (≤ 1200 tokens); no thinking-level inflation; `cacheRetention:
"none"` so verification never pollutes prompt caches. Driver failures
(model unavailable, provider error, timeout ≤ 180s, cancellation,
tool-budget exhaustion, unparseable verdict) map to INCONCLUSIVE with an
explicit `lastError` — never PASS, and never fatal to the session.

### Verdict model

`AiraVerificationResult`: id, revisionId, verdict, summary, mode, objective,
requirements[], findings[] (severity blocking/warning/info + requirement
anchor + evidence refs), evidence[] (category/label/summary), missingEvidence[],
scopeAssessment (in-scope/drift/uncertain + notes), confidence, startedAt,
completedAt, stale, staleReason. Hardening (applied in verifier.ts):
pass+unmet → FAIL; pass with empty evidence list → INCONCLUSIVE; malformed
verdicts → INCONCLUSIVE; canonical outcomes are exclusively pass/fail/
inconclusive. `state.verification.status` mirrors the lifecycle:
idle/preparing/running/passed/failed/inconclusive.

### Freshness / invalidation

- Event-driven: any successful edit/write after `completedAt` marks the
  current result stale immediately (publish + subscriber notification).
- mtime drift: `status()`/refresh checks the verified change set's mtimes
  against `completedAt + 50ms` (Phase 5 kernel pattern); a removed file also
  stales.
- Change-set movement: at every `agent_end`, if the merged change set
  differs from the verified one, the old result is staled.
- Completion fence: after the verifier returns, the revision is recomputed;
  if it moved during the run the new result is published stale.
- A stale PASS is never completion evidence; `/status` renders
  `verification: pass · stale`; the UI backlog (B-003) makes staleness
  visually distinct.

### Session isolation / failure / cancellation

Manager is per-session-instance; dispose aborts the in-flight AbortController
run and the run settles as INCONCLUSIVE ("verifier cancelled"); overlapping
sessions cannot touch each other's verification state (state ownership
rules from Phase 1 apply). A verifier failure never breaks the session
(tests assert the session stays usable after driver failure).

## Settings

- `verification.enabled` — default `true`.
- `verification.auto` — `off | smart | always`, default `smart`.
  - `off`: no automatic runs; explicit `/verify` still works while enabled.
  - `smart`: verify non-trivial engineering work; skip trivial (docs,
    comments, one-line renames with clean non-stale diagnostics) — zero
    verifier tokens.
  - `always`: verify every meaningful implementation, still bounded.
- `verification.contextBudget` — `compact | balanced | expanded`, default
  `compact` (6k/10k/16k envelope chars).
- Canonical store only (`SettingsManager` → settings.json); surfaced through
  the existing `/settings` selector as an "Aira verification" submenu
  (Enable verification / Automatic verification / Context budget).
- `/doctor` check #11 ("verifier") reports configuration + snapshot +
  last verdict/staleness and never runs the model; `/status` adds a
  restrained `verification:` line.

## Evidence

- Repository: `verificationChanges()` seam (git per-file stats) + repository
  snapshot; run-tracked edits as fallback; explicit marker when git is
  unavailable.
- Language: live-code status + findings counts; blocking errors surface into
  the envelope with a "must be explained" instruction.
- Execution: bounded recent results with exit codes/durations; "no evidence"
  is declared explicitly.
- Browser: verification status, console/network counts + top findings,
  observation summary, availability; absence is declared (never fabricated).
- Missing evidence semantics: absence → requirement `unverifiable` →
  INCONCLUSIVE when any requirement is unverifiable; absence is NOT `unmet`
  (FAIL requires contradicting evidence). The dogfood FAIL case proved the
  distinction: the verifier found a deterministic static contradiction and
  failed with a concrete finding while still listing missing evidence.
- Scope drift: the change set (paths/±lines) is given to the verifier which
  returns in-scope/drift/uncertain with notes; the UI renders it; no
  automatic failure for extra files.

## Ambient behavior

- Completion trigger: `agent_end`, awaited by the host (proven by test:
  `prompt()` resolves ~600ms after a 600ms agent_end listener settles), so
  print/headless sessions settle verification before exit.
- Smart eligibility: trivial = all-doc paths, or one code file with ≤ 2
  total ± lines AND clean non-stale diagnostics; otherwise non-trivial.
- Dedupe: revisionId = hash over sorted change-set entries (status, path,
  added, deleted, mtime); an unchanged revision with a current non-stale
  result is never reverified — `agent_end` after a read-only follow-up
  reports "unchanged revision already verified"; explicit `/verify` reuses
  the result (force re-runs).
- Token behavior: trivial runs and deduped completions spend ZERO verifier
  tokens (tests assert no runner invocation and no response consumption);
  verification state stays UI-visible regardless (state ≠ model execution).

## Modes

- BUILD: full automatic verification at the completion boundary.
- PLAN: automatic verification never fires (nothing can be implemented;
  skip reason recorded); explicit `/verify` is allowed and stays read-only —
  the verifier's tool set is read-only by construction, and the dogfood
  confirmed the working tree is untouched by a PLAN verification.
- REVIEW: explicit verification is trivial (`/verify`, `/verify status`);
  REVIEW mode state and verification state remain separate (no conflation).

## UI-ready state

`state.verification` (`AiraVerificationStatus`) is bounded, serializable,
provider-independent, token-free: status, enabled/auto/contextBudget
projections, currentResult (bounded), requirementsTotal / requirementsVerified,
highestFinding, stale, missingEvidence, lastError, lastSkipReason,
startedAt/completedAt/updatedAt. `manager.subscribe()` is the event seam.
`/verify status` renders it; UI_BACKLOG B-003 documents the Workbench
(Status / Requirements N/M / Diagnostics · Tests · Browser · Scope chips /
current finding) and footer (`VERIFY …`, `VERIFY ✓`, `VERIFY ✓ stale`,
`VERIFY ✕ 2`, `VERIFY ?`) projections; proof that UI visibility is
independent of verifier token execution: with `auto: smart`, doc-only runs
render idle state while zero verifier tokens were spent (asserted).

## Dogfood (real `aira` binary)

Rebuilt `packages/coding-agent/dist`; ran the real binary with an ISOLATED
agent dir (`AIRA_CODING_AGENT_DIR=/tmp/aira-p8-agent`: own settings.json
with verification/browser blocks, copied auth + models-store, NO reference
packages — every successful verification proves the NATIVE path).
Fixtures: `/tmp/aira-p8-fixture` (real git repo, `seek()` + `node --test`
suite, package.json with `type: module`) and `/tmp/aira-p8-incon`
(no test script, state-machine file) — both deterministic and local.

- **CASE 1 — PASS**: print-mode run "change seek… run the suite with
  process_start": agent edited code+test, `npm test` exited 0, the
  fresh-context verifier (deepseek-v4-flash) used its read/grep/find/ls
  budget (read,read → grep,ls → verdict), returned
  `{"verdict":"pass",…,"npm test passes (exit 0)"…}`; total process time
  59s, clean exit, ZERO orphaned processes.
- **CASE 2 — FAIL**: fixture-injected defect (seek(3)=24 vs test asserting
  25); review prompt (no edits) then `/verify` → `state: failed`,
  `verdict: fail`, confidence high, finding "R1 · seek(3) evaluates to 24
  (seconds + 21), but the test asserts 25, so the test fails
  deterministically" (found by static read of both files — the read-only
  spot checks worked), 1/2 requirements, missing evidence listed. No
  repair loop: the session idles; the result is a transition.
  (A requirement-faithful variant — "make seek return 0, don't touch
  tests, run the suite" — correctly PASSED 3/3 because the failing test
  WAS the objective's expected outcome, proving the requirement-driven
  model doesn't conflate test-failure with objective-failure.)
- **CASE 3 — INCONCLUSIVE**: fixture with no test script, no browser; a
  state-machine change with no execution/browser evidence → `state:
  inconclusive`, requirements 0/1, missing evidence: acceptance criteria,
  test/build results, browser verification, reconstructed diff, LSP
  findings; the verifier explicitly refused to pass ("no concrete behavior
  can be verified"). Never converted to PASS.
- **CASE 4 — STALE**: after the FAIL verdict, a new edit landed →
  `verdict: fail (stale)` in `/verify status` and `/status` →
  `verification: fail · stale`.
- **CASE 5 — SMART trivial**: doc-only run → `last skip: trivial change
  (smart mode skips verifier tokens)`, state idle — zero verifier tokens.
- **CASE 6 — MODE**: PLAN keeps verification state visible
  (`/status verification: fail · stale`), explicit `/verify` ran without
  modifying the tree; REVIEW `/verify` runs; BUILD auto-verifies. The
  mode cycle and `/status`/`/doctor` all render canonical state.

**Dogfood findings fixed in-tree**: (1) a pre-existing Phase 5 leak — a
language server whose `initialize` handshake fails (or crashes) was abandoned
without killing the child; its stdio pipes kept print-mode processes alive
after teardown and leaked one server per failed spawn; `LspClient` now
force-kills the child (regression test with a hanging-handshake mock +
pid-file assertion, `requestTimeoutMs` injectable). (2) The verifier tool
loop was raised from 2 to 4 bounded rounds because the small opencode-go
model repeatedly needed an extra round before emitting the structured
verdict (budget exhaustion is otherwise an honest INCONCLUSIVE driver
error). (3) The verifier policy now distinguishes `unmet` (contradicting
evidence) from `unverifiable` (missing evidence) so absence yields
INCONCLUSIVE rather than a FAIL accusation. (4) Multi-turn runs (tool call →
next provider request) no longer reset the verification run scope.

## Verification

- Focused: `vitest --run test/aira/verification` → 69 tests (settings,
  eligibility, requirements, evidence, verifier runner with faux provider,
  manager lifecycle, host integration through the real AgentSession
  incl. the NATIVE fresh-context path with scripted verdict streams).
- `vitest --run test/aira` → 363 passed (40 files) — includes the extended
  live-code orphan regression and the updated /doctor checks (11/11).
- `vitest --run test/suite test/aira` → 622 passed (115 files).
- Repo-wide `npm run check` → PASS on every Phase 8 commit (biome,
  pinned deps, ts-imports, shrinkwrap, install-lock, tsgo, browser-smoke).
- Full suite `./test.sh`: coding-agent 2338 passed / 1 failed / 50 skipped.
  The single failure (`agent-session-concurrent` steering-message test:
  `auth.json.lock` ENOENT during a credential-store write) passes in
  isolation and is a parallel-load credential-store race, not a Phase 8
  regression. packages/ai: 2 failed / 946 passed — the SAME two
  pre-existing environmental catalog-pricing failures documented in the
  Phase 7 report (fireworks Fire Pass turbo router, zai-coding-plan zero
  costs; zero diff in packages/ai). agent · tui · client · evals ·
  session-backends · scripts: all passed.

## Development record

- **ADR-026** — Independent verification is a native per-session service
  with a fresh-context verifier role, a canonical verdict contract, and
  freshness-based invalidation (DECISIONS.md).
- Docs: AIRA_ARCHITECTURE.md (§14 rewritten + invariant 13),
  ROADMAP.md (Phase 8 status), phases/README.md (table row),
  UI_BACKLOG.md (B-003 verification projection), CHANGELOG.md (Added +
  Fixed entries).
- Reference packages: pi-maestro-flow installed into STOCK PI
  (`~/.pi/agent/npm/node_modules/`) for the study; nothing was installed
  into Aira; no dependency added.

### Local Git commits created (nothing pushed)

```text
05ee261d6 feat(aira): add native independent verification subsystem
55eeeb6d0 docs(aira): Phase 8 documentation, ADR-026, roadmap, UI backlog, changelog
ba92d91f6 fix(aira): dogfood findings — LSP orphan kill, verifier convergence, evidence wording
<final docs commit — Phase 8 report + changelog entry>
```

### Final `git status`

Working tree clean after the final docs commit. `main` ahead of
`upstream/main` (baseline divergence, unchanged). Only remote: `upstream`
(Pi). No `origin`, nothing pushed, nothing published.

## Stopping point / next phase

Stopped after Phase 8 per roadmap discipline. Next: **Phase 9 — Task Graph
and Delegation** (Scout/Researcher/subagents), which will be able to consume
`state.verification` and the FAIL transition for orchestration; the Workbench
UI overhaul remains explicitly deferred.