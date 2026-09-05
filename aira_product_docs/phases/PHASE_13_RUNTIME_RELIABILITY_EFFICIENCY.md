# PHASE 13 — RUNTIME RELIABILITY, AWARENESS & EFFICIENCY

**Status:** closed. Final live dogfood validation passed: the child-backed
Goal reproduction now completes autonomously end to end (delegate, root turn
end, child settle, all-settled task graph, completion boundary, independent
verifier `PASS · fresh`, Goal `completed`) with no user wake-up. The only
remaining item is one low-severity, non-blocking verifier presentation
wording debt recorded in the report and as backlog item B-011; the
completion-boundary lifecycle is closed and is not reopened for it. Real
provider coverage includes successful and failed children, bounded loop
termination, process execution, mode awareness, PLAN enforcement,
persistence, and Workbench checkpoints; native Chromium fixture and
wide/medium/narrow tmux layout evidence pass. Successful/cached sudo
authentication and empirical budget calibration remain deferred, as do the
deferred work items recorded in section 17; Phase 14 has not started.

## 1. BASELINE

- Starting commit: `02d3c9b5d` (`feat(aira): Aira 0.1.4 — native Agent Inspector & child transcript viewer`).
- Aira `0.1.4`, Pi base `0.84.3`.
- Environment: macOS / Apple Silicon; primary checkout
  `/Users/hariz/proj/aira`; branch `main`; npm-linked `aira` CLI.
- The reference laboratory was left untouched and no reference extension was
  installed.
- Characterized TaskManager, GoalManager, orchestration and child runner,
  verifier, execution and permission paths, mode/prompt assembly, Workbench
  projections and sizing, Git refresh, session recovery, and Inspector event
  storage.

## 2. DOGFOOD FINDINGS

- Reproduced the prior stale-model-mode problem: changing the UI to REVIEW
  during an active PLAN turn left the next provider continuation describing
  PLAN. The host envelope is now refreshed when the mode changes; a regression
  test and rebuilt-binary provider run confirm the next response describes
  REVIEW.
- Reproduced successful and failed real-provider children using only a
  disposable synthetic fixture. A test child also ran a harmless `printf`
  command.
- Real provider `opencode/gpt-5.6-luna` was unavailable because of provider
  credits; `opencode-go/mimo-v2.5` supplied the successful headless and
  interactive evidence.
- A real automatic verifier trigger after child work became INCONCLUSIVE with
  a truthful timeout (`verifier timed out after 18…` in the TUI); no PASS was
  fabricated.
- A separate disposable Git-project verifier run also failed closed as
  INCONCLUSIVE because the provider returned no valid structured verdict.
- A live Test child accepted a `sleep 60` process workload, exposed its
  `1/2` active state and `40`-call tool limit, and accepted `agents_cancel`.
  The parent provider turn hung before a second status snapshot, so this is
  cancellation-request evidence, not proof of a fully settled live run.
- A real Test child under tmux ran one harmless `process_start` call with
  `interactive=true`; the PTY workload returned `phase13-interactive` and
  exited successfully without changing files.
- A live Explore child was given a read-only repeated-read workload against
  the synthetic fixture. The host stopped it with the typed
  `tool-budget-exceeded` outcome after 34.4 seconds; the settled Inspector
  telemetry reported `tools 12/48`. No commands, edits, browser tools, or
  nested delegation were used.
- A real root-owned safe `sudo id -u` request passed through the Aira
  permission card, then showed the local masked password prompt. Escape
  cancelled authentication; `/status` remained responsive afterward, the
  execution result reported `local authentication: cancelled`, and no
  password or privilege was entered.
- A second root-owned run entered one deliberately invalid test string in the
  local prompt. Sudo rejected it, retries were cancelled, `/usr/bin/id -u`
  never executed, and `/status` remained responsive afterward.
- The native Chromium fixture was rerun successfully against localhost: all
  10 tests passed, including isolated launch, interaction, evidence capture,
  timeout handling, cleanup, and manager integration. No repo mutation or
  credential entry was attempted during dogfood.
- The Phase 12.2 Agent Browser regression was reproduced at the lifecycle seam:
  settled child history remains eligible after concurrent delegation, but a
  session rebind disposed the Inspector without recreating it and custom
  editor replacement dropped the contextual empty-start Left Arrow hook. The
  fix recreates Inspector after `/resume` and `/new`, preserves the hook while
  retaining ordinary cursor-left editing, and keeps browser open/close UI-only
  with zero provider calls.
- The persistence diagnostic trace disproved the suspected live
  `TaskManager` reconstruction bug. A resumed manager remained the same
  manager across ordinary task-tool calls; those boundaries performed no
  recovery. The actual defect was memory-only recovery normalization: an
  interrupted `active` row became `pending` in memory while the persisted
  snapshot remained stale.
- Recovery now atomically rewrites normalized snapshots. A second
  reconstruction observes persisted `pending` and reports zero additional
  semantic recovery transitions. The resumed model also receives one bounded,
  one-shot host hint to consult canonical task state; no task graph, composer
  text, or permanent UI context is injected.
- The verifier/repair dogfood exposed a critical ownership failure: a
  read-only Goal saw three pre-existing dirty Phase 13 files, and an unsafe
  repair path restored them to make the worktree clean. The earlier files were
  restored before this fix; the incident was not a live TaskManager bug.
- The repair boundary now captures a deterministic Goal baseline from the
  canonical Git change seam. Only successful direct Goal `edit`/`write` events
  can establish ownership. Baseline, shared, externally appearing, drifted,
  outside-workspace, and unavailable paths are protected by the host. Active
  Goal verification evaluates only the owned delta and reports bounded
  baseline/owned/protected/unowned counts; baseline dirtiness alone is not a
  Goal failure.
- A live lifecycle regression showed that a background `implement` child could
  settle after the root `agent_end` boundary, leaving only builder-side
  evidence and no independent verifier run. Goal verification now also
  observes the canonical task graph's all-settled completion edge. The same
  boundary is used for direct parent work, and a bounded completion key makes
  root/child races and repeated task snapshots run verification once.
- The first completion-boundary tests were too narrow: they exercised the Goal
  observer with a synthetic task source, not the host's asynchronous delegate
  path. The corrected trace is `agents_delegate(await=false)` returns to the
  root, the root turn ends, the native child settles later, orchestration
  publishes, TaskManager projects the all-settled graph, and Goal invokes the
  independent verifier with no active root turn. A host regression now covers
  this exact sequence and confirms one fresh PASS without a user wake-up.
- Live dogfood then exposed a separate verifier-input defect. The Goal stored
  the complete user objective, but the autonomous boundary called
  `verification.verify()` without carrying it forward. The verifier therefore
  received `(explicit verification request)`, had no authoritative criteria,
  and inferred an unrelated browser/runtime requirement. The boundary now
  passes the current Goal objective explicitly; the verifier manager gives that
  boundary objective precedence over its explicit-request fallback. This fixes
  all explicit criteria classes uniformly (filesystem, tests, commands, and
  source changes); filesystem-only objectives do not gain browser requirements.
- Final live dogfood passed the exact child-backed Goal reproduction
  autonomously: `agents_delegate(await=false)` returns to the root, the root
  turn ends, the native child settles, canonical task state reaches
  all-settled, the Goal completion boundary fires, and the independent
  verifier runs — all with no user wake-up, no "where were we" resume, and no
  manual verification request. The live run surfaced `child task completed
  successfully`, `VERIFICATION: PASS · fresh`, `GOAL ✓`, then Goal
  `completed`.
- Remaining non-blocking follow-up debt (low severity): the verifier
  presentation can still show stale/default wording — such as "Objective text
  is a placeholder ('explicit …')" and browser-evidence commentary — even
  when browser evidence is correctly not applicable. The verdicts and the
  completion-boundary lifecycle are correct; this is presentation wording
  only, it is recorded as backlog item B-011, and the lifecycle is not
  reopened or redesigned for it.

## 3. CHILD OBSERVABILITY

- Orchestration owns a bounded per-run event buffer; events are not copied into
  canonical `AiraSessionState` or task rows.
- Event count, per-event text, detail text, child summaries, and parent result
  projection are bounded. Oldest events are evicted first.
- Failure taxonomy distinguishes runtime/model error, permission denial,
  cancellation, timeout, invalid result, and tool-budget exhaustion.
- Child snapshots and run/status output expose `toolBudgetUsed`,
  `toolBudgetLimit`, `toolBudgetExtensions`, and `lastActivityAt` when
  available. `/agents`, Agent Browser, and Inspector snapshots expose the
  bounded values. Verifier snapshots expose the corresponding read-only
  budget telemetry.
- Parent task results remain structured and bounded; child transcripts are not
  persisted as native tasks.
- Zero-token proof: Inspector data is projected from host state and is not
  included in system-prompt composition. Projection and focused tests contain
  no provider call seam.

## 4. TASK PERSISTENCE

- Canonical owner: native `TaskManager`; persistence is a storage boundary,
  not a second task authority.
- Storage: session-scoped JSON under the Aira cache directory,
  `tasks/<safe-session-id>.json`.
- Schema: versioned schema 1 containing native task fields only; child rows,
  process state, transcript content, and rendering rows are excluded.
- Writes use a temporary file followed by atomic rename. Malformed JSON and
  unknown schema versions produce degraded persistence health rather than
  silently inventing state.
- Save triggers cover create, patch, remove, clear, and manager disposal.
- Resume restores completed, pending, dependency, and derived blocking state.
  Recovered `active` rows become `pending`; the runtime never claims an
  interrupted actor is still running. This normalization is written back
  through the existing temporary-file-plus-atomic-rename save path before the
  resumed manager continues. Reconstructing the same session again sees
  persisted `pending`, so recovery is idempotent.
- `/new` starts a new session and does not recover the old task file. Forks do
  not resurrect child projections as native tasks.
- Goal snapshots project the published `state.tasks` snapshot and subscribe to
  TaskManager changes; they do not own task rows. A focused lifecycle test
  restores completed and interrupted native rows alongside a persisted goal,
  verifies stable IDs, and asserts matching totals after resume. Real linked-CLI
  restart/resume also covers completed and pending rows; a live interrupted
  actor was not safely forced during dogfood.

## 5. MODE AWARENESS

- Injection seam: the host appends one bounded control envelope after normal
  system-prompt composition. The composer itself is unchanged.
- Contract: `<aira-runtime mode=MODE posture="..." host-enforcement=authoritative />`.
  It is advisory model context; host tool policy remains authoritative.
- If recovery normalized one or more interrupted native tasks, the next model
  inference additionally receives the one-shot bounded
  `<aira-task-recovery>...</aira-task-recovery>` hint to consult canonical
  task state. No hint is added when no task was normalized, and the hint is
  consumed after that inference.
- BUILD describes implementation, execution, and verification posture.
- PLAN describes read-only planning/inspection posture and is enforced by tool
  availability and dispatch gates.
- REVIEW describes evidence gathering and inspection posture.
- Mode commands update the canonical mode, active tool set, and runtime
  envelope. The envelope is refreshed immediately so a later continuation
  cannot reuse the previous mode.
- Child envelopes receive the effective mode.
- Real provider evidence: PLAN response explicitly stated read-only mode;
  changing to REVIEW produced a REVIEW response after the fix. Real PLAN
  mutation attempt did not create the disposable target file.
- Measured envelope cost: BUILD 93 chars / 24 estimated tokens, PLAN 100 / 25,
  REVIEW 96 / 24 using the local `ceil(chars / 4)` estimator.

## 6. ROLE/CAPABILITY PREFLIGHT

- Role contracts are authoritative and semantic: explore/research/review are
  read-only; test adds `process`; implement adds `mutating` and `process`.
- Child requests may declare `requiredCapabilities` from `process`,
  `mutation`, and `browser`.
- Incompatible requests are rejected before a provider runtime is created;
  PLAN also rejects mutation-capable dispatch. The scheduler does not grant
  Explore extra capabilities to make an incompatible request work.
- Focused tests prove zero provider calls on rejection. Real provider evidence
  shows Explore reading a fixture, Test executing `printf` under its
  process-capable role, and an Explore + `process` request refused before any
  child provider started.

## 7. CHILD / VERIFIER BUDGETS

- Initial Phase 13 role budgets are Explore 48, Research 48, Review 32, Test
  40, and Implement 40 raw tool calls. The verifier is bounded to eight rounds
  with two calls per round (16 maximum tool calls).
- Every child and verifier run reports used/limit telemetry where the runtime
  produces it; exhaustion is a typed stop reason, not an invisible hang.
- Failed child outcomes retain the runner's used/limit/extension telemetry
  before failure projection, so budget exhaustion remains inspectable instead
  of disappearing from `/agents` and Inspector rows.
- Timeout, cancellation, invalid-result, and no-progress paths terminate
  without unbounded retries. One progress-gated extension is allowed per child
  or verifier run (+8 child calls or +4 verifier calls); repeated identical
  tool calls receive no extension. No adaptive quota framework was added.
- Representative automated fixtures cover exact exhaustion and telemetry
  behavior. Real provider runs completed the successful fixture and process
  workloads, but did not establish a statistically meaningful before/after
  exhaustion rate or calibrate budgets from a production workload. Therefore
  criteria requiring empirical calibration and routine-success rate remain
  open rather than being claimed as complete.

A live no-progress-style repeated-read workload independently confirmed that
the host terminates a child with `tool-budget-exceeded` instead of allowing an
unbounded loop. The live snapshot reported `12/48` tools after 34.4 seconds;
the runtime's internal limit enforcement may account for more model/tool
rounds than the compact Inspector count exposes, so this is termination
evidence rather than a budget-calibration sample.

The bounded extension is deliberately progress-gated: a new successful tool
signature in the immediately preceding round is required. One extension is
the maximum per run, and failed or repeated identical calls do not qualify.

Measured real-provider sample:

| Workload | Tool calls | Provider tokens | Outcome |
| --- | ---: | ---: | --- |
| Explore read of disposable fixture | 1 / 48 | 1,736 input + 250 output (3,522 total including cache) | completed |
| Explore two-file mode/role comparison | 2 / 48 | 4,579 input + 878 output + 1,600 cache read (7,057 total) | completed in 14.9s |
| Explore six-file architecture audit | 6 / 48 | 10,356 input + 2,740 output (23,336 total) | child completed in 32.6s; parent response interrupted after child settlement |
| Explore read of missing disposable file | not surfaced in final snapshot | not surfaced | reported ENOENT |
| Test single process with corrected fallback | 4 / 40 | 937 input + 825 output + 13,632 cache read (15,394 total) | completed in 21.2s |
| Explore repeated-read loop against disposable fixture | 12 / 48 | not surfaced in compact live result | failed with typed `tool-budget-exceeded` after 34.4s |

## 8. INTERACTIVE EXECUTION

- POSIX interactive execution uses a small Python stdlib `forkpty` proxy owned
  by the Execution Manager. The bridge writes input directly to the PTY and
  receives bounded output.
- Password-prompt detection is local-only. The native secret-input component
  masks input, clears it before callback delivery, supports Esc cancellation,
  and never routes the secret through `ask_user`, model arguments, or child
  events.
- Aira permission authorization remains a host decision before process
  execution; OS authentication is a separate PTY interaction.
- Echoed secrets are redacted before output capture. Headless and unsupported
  platforms return truthful unavailable/cancelled results rather than waiting
  forever.
- Interactive authentication remains `requested` until the child exits; only
  a zero exit after secret submission becomes `succeeded`, while a non-zero
  exit becomes `failed`. Submission alone is never treated as proof of OS
  authentication.
- Focused security tests cover masking, cancellation, redaction, timeout, and
  headless fallback. Live dogfood approved safe root `process_start` requests,
  displayed the local sudo prompt, exercised cancellation and an invalid test
  password, and verified `/status` afterward. Correct authentication was not
  completed because this host had no cached authorization and no real password
  was entered. Stored credentials and passwordless sudo remain deferred.

## 9. ENGINEERING CONTEXT

- The existing minimum-width layout remains the lower bound. On wide terminals
  the context pane expands to a bounded percentage; medium and narrow layouts
  retain their established visibility rules.
- The Workbench projection is independent of provider context, so resizing
  does not alter model input or Inspector ownership.
- Responsive projection tests pass. Linked-CLI tmux captures at 160×40,
  120×30, and 80×24 show the context pane at wide/medium widths and the
  usable narrow composer with context collapsed. A real Explore child was
  opened in Agent Browser and its child transcript remained usable through
  160×40 → 120×30 → 80×24 resizing; Esc returned directly to the root
  conversation and widening restored the Workbench.

## 10. GIT CHECKPOINTS

- Data source: read-only local Git commands through a coalesced refresh path.
- The Workbench shows the current HEAD and at most five recent short commits,
  plus a truthful dirty-tree hint.
- The projection is bounded, read-only, and independent of task or child rows.
- Real linked-CLI dogfood showed recent local commits and the dirty working
  tree. Checkpoint projection tests prove it adds no provider request or model
  tokens.

## 11. CONTEXT / TOKEN AUDIT

The local estimator is deterministic: `ceil(characters / 4)`. Costs below are
measured from exact current native builders and active tool definitions using a
disposable fixture. UI-only and host-only rows are outside model context.

| Feature | Activation | First-turn cost | Repeat cost | Root/Child | Action |
| --- | --- | ---: | ---: | --- | --- |
| Runtime mode: BUILD | always | 93 chars / 24 est. tokens | 93 / 24 | root + child | keep; authoritative hint |
| Runtime mode: PLAN | mode | 100 chars / 25 est. tokens | 100 / 25 | root + child | keep; avoids futile actions |
| Runtime mode: REVIEW | mode | 96 chars / 24 est. tokens | 96 / 24 | root + child | keep; review posture |
| Interrupted-task recovery hint | resumed session; only when `active` rows normalized | 222 chars / 56 est. tokens including BUILD envelope (87 chars / 22 est. tokens for hint text/tag) | 0 after one inference | root | keep; bounded, one-shot canonical-state reminder |
| Project/profile orientation | task; first orientation only | 129 chars / 33 est. tokens | 0 when unchanged | root | keep; bounded and deduplicated |
| Browser evidence pack | task; active + relevant | 106 chars / 27 est. tokens | 0 when unchanged | root | keep; hard compact budget + dedupe |
| Tasks guidance | always; active tool | 532 chars / 133 est. tokens | 532 / 133 (cache eligible) | root | keep; concise native guidance |
| Interaction/Q&A guidance | always; active tool | 552 chars / 138 est. tokens | 552 / 138 (cache eligible) | root | keep; semantic Q&A only |
| Orchestration guidance | always; active tools | 643 chars / 161 est. tokens | 643 / 161 (cache eligible) | root | keep; child context remains separate |
| Execution guidance | always; active tools | 793 chars / 199 est. tokens | 793 / 199 (cache eligible) | root | keep; runtime state remains UI-only |
| Browser tool guidance | always; active tools | 1,199 chars / 300 est. tokens | 1,199 / 300 (cache eligible) | root | keep; operation descriptions are bounded |
| Child task envelope | child invocation | 1,273 chars / 319 est. tokens | per child | child | keep; explicit task only |
| Child role framing | child invocation | 892 chars / 223 est. tokens | per child | child | keep; no parent transcript |
| Verifier system contract | verifier invocation | 3,777 chars / 945 est. tokens | per verifier | verifier | keep; bounded structured verdict contract |
| Verifier evidence envelope | verifier invocation | 440 chars / 110 est. tokens | per verifier | verifier | keep; explicit missing-evidence markers |
| Goal repair continuation | task; repair only | 400 chars / 100 est. tokens | only on repair | root | keep; bounded new evidence only |
| Workspace ownership summary | active Goal verification; bounded counts only | 208 chars / 52 est. tokens in the fully populated case | per verifier run | verifier | keep; protects baseline and unowned paths without contents |
| Permission enforcement | host-only | 0 provider tokens | 0 | root | keep authoritative and invisible |
| Capability preflight | host-only | 0 provider tokens | 0 | root | keep before provider spend |
| Workbench | ui-only | 0 provider tokens | 0 | root | keep outside context |
| Agent Inspector | ui-only | 0 provider tokens | 0 | root | keep outside context |
| Checkpoints | ui-only | 0 provider tokens | 0 | root | keep outside context |

- Steady-state newly introduced Aira mode overhead is 24–25 estimated tokens
  per rebuilt root or child system prompt; the conditional recovery envelope
  costs 222 characters / 56 estimated tokens on its one affected inference
  (the recovery hint/tag itself is 87 characters / 22 estimated tokens).
  The representative first-turn root-side guidance total is 955 estimated
  tokens before conditional intelligence, browser evidence, recovery context,
  or conversation history. Provider cache accounting is distinct from this
  deterministic text estimate.
- Conditional project orientation and browser evidence deduplicate to zero
  repeat message text when unchanged. Host enforcement and all three UI
  projections add zero provider tokens by construction.
- Workspace ownership tracking is host-only and token-free. Its verifier
  summary is bounded to four counts plus two protection sentences; the fully
  populated form measures 208 characters / 52 estimated tokens. File contents
  are never placed in canonical state or model context.
- The optimization was to keep Workbench/Inspector/Git data host-side, keep
  ambient evidence capped and deduplicated, and measure native prompt
  metadata instead of inventing synthetic costs. The context-cost contract is:
  every new injected section must be bounded, measured, justified, and
  excluded when it is UI-only or host-only.

## 12. AIRA SESSION STATE

- New bounded state covers task persistence health, orchestration child
  telemetry, verifier telemetry, interaction status, runtime mode, Git
  checkpoint projection, Workbench-derived intelligence, goal status, and
  Goal workspace ownership counters.
- Canonical state remains token-free and excludes secrets, transcripts, raw
  child event buffers, and unbounded output.
- Native task rows serialize through the versioned persistence boundary;
  derived UI projections are recomputed on load.
- Workbench, Inspector, and checkpoint views read state without provider calls.

## 13. /DOCTOR

- `/doctor` reports persistence health, task recovery state, orchestration,
  verification, execution, interaction, permissions, mode, and intelligence
  wiring in addition to the existing checks.
- Degraded states identify unavailable persistence, unavailable headless
  interaction, provider absence, and failed browser/diagnostic components
  without converting them to false passes.
- The rebuilt linked CLI reported `19/19` checks passed in the clean local
  dogfood session.

## 14. TESTS

- `npm run check`: passed, including formatting, pinned-dependency,
  shrinkwrap, TypeScript, and browser-smoke checks.
- Focused Aira tests passed for persistence, mode/read-only enforcement,
  orchestration preflight and bounded events, context cost, execution,
  verification, Workbench projections, SDK host wiring, and lifecycle
  recovery. The current full focused Aira run, including the real Chromium
  fixture, passed 80 files / 735 tests after the interactive-auth correction.
  The mode regression file contains 8 passing tests. The post-diagnosis
  persistence/recovery/context run passed 4 files / 20 tests, including
  durable normalization, idempotent reconstruction, the one-shot hint, and
  the real host sequence that reactivates and completes the recovered task.
- `npm run build --workspace packages/coding-agent`: passed; rebuilt bundle
  contains 48 files / 7.6 MiB.
- The post-fix execution manager rerun passed 21/21 tests, including confirmed
  local-auth success, confirmed non-zero failure, cancellation, timeout, and
  secret-boundary assertions.
- The focused ownership/verifier/Goal/Agent Inspector run passed 11 files / 139
  tests. It covers baseline-only read-only Goals, owned-delta verification,
  shared and external protection, bounded destructive-command refusal,
  byte-identical three-file dogfood, and host `beforeToolCall` enforcement.
- The focused Goal completion-boundary regression passed 7 tests covering direct
  parent work, implement-child completion, multiple children, resumed child
  work, already-settled paused-goal recovery, disabled verification, and
  duplicate completion events.
- The latest focused Goal/verification/orchestration/workspace rerun passed 10
  files / 130 tests. It includes the completion-boundary regressions and the
  ownership race where a repair guard refresh occurs between mutation start and
  mutation completion.
- The latest focused Goal/verification/orchestration/workspace/persistence
  rerun passed 16 files / 173 tests. The host regression uses the real
  `agents_delegate(await=false)` tool loop and a deferred native child; task
  settlement alone starts independent verification after the root turn has
  ended.
- The exact filesystem Goal dogfood regression also passes through the native
  fresh-context verifier: it reads the child-created file, preserves four
  explicit criteria, synthesizes no browser/runtime requirement, returns fresh
  PASS, and remains deduplicated after repeated task snapshots.
- The final closeout focused Phase 13 suite passed 30 files / 269 tests,
  covering goal, verification, orchestration, workspace ownership, lifecycle,
  and session state. It includes the completion-boundary regressions (7
  tests), the host `agents_delegate(await=false)` deferred-child regression,
  the ownership race across a repair-guard refresh, and the filesystem
  criteria verifier regression.
- Earlier direct coding-agent coverage recorded 314 passed, 9 failed, and 6
  skipped test files with 2,723 passed tests; those failures were limited to
  the Chromium fixture. The current focused Aira rerun covers that fixture
  successfully (80 files / 735 tests).
- The latest `./test.sh` run exited 1 with 312 coding-agent test files passed,
  4 failed, and 6 skipped, with 2,731 passed, 11 failed, and 50 skipped tests.
  Ten failures were the existing `fd`-dependent find/regression tests. The
  remaining Aira auto-background test failure was timing-sensitive under the
  full-suite load and was fixed by `70c5176e3`; the focused execution rerun
  passes 21/21. The `fd` failures remain environment-specific and are not
  Phase 13 regressions.

## 15. DOGFOOD

The real-provider runs used `opencode-go/mimo-v2.5` and disposable paths under
`/private/tmp/aira-phase13-provider.XaBOic`. No private repository content or
password was sent to the provider.

| Case | Result | Evidence / limitation |
| --- | --- | --- |
| A. Inspector successful child | Pass | Real Explore child read `child-fixture.txt`; Inspector showed completion, `1/48` tools, and bounded result. Provider usage was 1,736 input + 250 output tokens, with 3,522 total including cache. |
| B. Inspector failed child | Pass | Real Explore child read a missing disposable file and reported ENOENT failure. |
| C. Inspector budget exhaustion | Pass | Live read-only repeated-read child terminated with typed `tool-budget-exceeded`; Inspector reported `tools 12/48` after 34.4s. |
| D. Tasks survive quit + resume | Pass | Real linked CLI persisted and restored native rows. |
| E. Completed task survives resume | Pass | Completed ID/status verified before and after restart. |
| F. Interrupted task recovery | Automated only | Persistence trace and host regression prove active→pending is atomically durable, idempotent on reconstruction, and accompanied by a one-shot canonical-state hint; no live actor was forcibly interrupted. |
| G. Goal/task counts after resume | Automated only | Focused lifecycle coverage restores both persisted managers, verifies stable task IDs and active→pending recovery, and asserts matching Goal/TaskManager totals. A live provider goal restart was not completed. |
| H. PLAN model awareness | Pass | Real model stated PLAN and read-only posture, including the runtime envelope semantics. |
| I. PLAN host enforcement | Pass | Real mutation target remained absent; host toolset excluded mutation. |
| J. PLAN mutation delegation preflight | Pass | Real linked CLI in PLAN refused an Implement delegation before child startup and reported zero provider spend. |
| K. REVIEW awareness | Pass | Rebuilt real CLI produced a REVIEW response after switching from PLAN. |
| L. BUILD awareness | Pass | Real CLI entered BUILD and displayed the correct mode; provider child work ran under BUILD. |
| M. Mode change during session | Pass | Real BUILD → PLAN → REVIEW cycle; active-turn stale-envelope regression fixed and tested. |
| N. Explore/process incompatibility | Pass | Real linked CLI refused an Explore child requesting `process` before child provider startup and reported zero provider spend. |
| O. Test/process task | Pass | Real Test child ran `printf phase13-process` successfully. |
| P. Realistic Explore child | Pass | Real Explore child read and reported the synthetic fixture value. |
| Q. Realistic verifier | Inconclusive | A real automatic verifier trigger timed out, and a separate disposable Git-project run returned no valid structured verdict; both surfaced INCONCLUSIVE rather than PASS. |
| R. Looping child termination | Pass | Live repeated-read Explore child was stopped by the host with `tool-budget-exceeded`; no nested delegation, commands, or edits were allowed. |
| S. Productive budget extension | Automated only | Focused tests prove one progress-gated bounded extension; no real provider exhaustion/extension workload was forced. |
| T. Cached sudo authentication | Not run | No privileged command was executed. |
| U. Secure sudo password entry | Partial | Live root execution displayed the masked local sudo prompt and was cancelled before credential entry; correct-password completion was not attempted. |
| V. Incorrect sudo password | Pass | A deliberately invalid test string was entered locally; sudo rejected it, retries were cancelled, and the privileged command never executed. |
| W. Sudo cancellation | Pass | Live root execution was approved at the Aira layer, then the local sudo prompt was cancelled with Escape; execution settled as cancelled. |
| X. Password absent from state/logs/events | Pass | No password was entered; the live result exposed only `local authentication: cancelled`, while redaction and boundary tests pass. |
| Y. Interactive process under tmux | Pass | Real linked CLI delegated a Test child under tmux; the child ran `process_start` with `interactive=true`, returned `phase13-interactive`, and exited successfully. |
| Z. Wide Engineering Context | Pass | Offline linked-CLI tmux capture at 160×40 shows the Engineering Context pane alongside the conversation. |
| AA. Medium layout | Pass | Offline linked-CLI tmux capture at 120×30 retains a balanced context pane and usable composer. |
| AB. Narrow layout | Pass | Offline linked-CLI tmux capture at 80×24 collapses the context pane while retaining the composer and status footer. |
| AC. Inspector after sizing | Pass | Real linked CLI opened Agent Browser and a child transcript, survived 160×40 → 120×30 → 80×24 resizing, then returned to root and restored the Workbench after widening. |
| AD. Recent checkpoints | Pass | Real Workbench showed recent local commits. |
| AE. Dirty worktree | Pass | Real Workbench showed `working tree dirty`. |
| AF. Checkpoints zero-token | Automated only | Host projection has no provider seam. |
| AG. Workbench zero-token | Automated only | UI projection remains outside model context. |
| AH. Inspector zero-token | Automated only | Bounded Inspector architecture/tests contain no provider injection. |
| AI. Context audit | Pass | Measured table and deterministic audit tests recorded. |
| AJ. Mode-awareness cost | Pass | BUILD/PLAN/REVIEW character and estimator measurements recorded. |
| AK. Clean shutdown | Pass | Real tmux sessions exited cleanly with Ctrl-D/Ctrl-C cleanup. |
| AL. Resume after interruption | Partial | Same-session restart passed; active-work interruption was not run. |
| AM. Truthful `/doctor` | Pass | Rebuilt linked CLI reported 19/19 checks passed. |
| AN. Headless/SDK paths | Automated only | Real headless `-p` returned `phase13-ok`; focused SDK host coverage constructs the native runtime without a TUI or provider call. |
| AO. Workspace ownership repair guard | Pass | Disposable live-style Git fixture reproduced three pre-existing dirty files; read-only Goal evidence classified all three as baseline/protected, destructive restore was refused, and all three files remained byte-identical. |
| AP. Child-backed Goal verification boundary | Pass | Host-level lifecycle coverage confirms `agents_delegate(await=false)` can settle after root `agent_end`, then canonical all-settled task state starts exactly one independent verification; direct, resumed, disabled, and duplicate-event cases remain covered. |
| AQ. Final live child-backed Goal completion | Pass | The exact reproduction completed autonomously: delegate returns → root turn ends → child settles → all-settled task graph → Goal completion boundary → independent verifier `PASS · fresh` → Goal `completed`. No user wake-up, "where were we", or manual verification request was required. |

## 16. REFERENCE STUDY

No reference specimen was used for implementation. The reference laboratory
was intentionally left read-only because the native Aira code and focused
tests provided sufficient architectural evidence. No extension was installed
and no runtime dependency was introduced.

## 17. ADRS / DOCUMENTATION

- Updated `AIRA_ARCHITECTURE.md`, `ROADMAP.md`, `UI_BACKLOG.md`, package
  `CHANGELOG.md`, and the Phase 13 report.
- Added ADRs 039–044 covering task persistence/recovery, runtime-mode control,
  role/capability preflight, bounded budgets, PTY/secret-input boundaries, and
  context-cost accounting. Added ADR-045 for Goal workspace ownership and
  destructive repair boundaries and ADR-046 for the Goal completion boundary
  (task-graph all-settled edge and boundary objective precedence).
- Deferred work remains recorded: child steering, transcript persistence,
  interactive Git rollback, arbitrary panes, passwordless/stored sudo,
  nested delegation, and Phase 14.
- Low-severity follow-up debt: the verifier presentation wording issue
  (placeholder objective wording and browser-evidence commentary when browser
  evidence is not applicable) is recorded as backlog item B-011. It is
  presentation-only debt against a closed lifecycle and is not a Phase 13
  exit-criterion failure.

## 18. LOCAL COMMITS

Chronological Phase 13 checkpoints, oldest first:

- `29dd0cbe1` — `feat(agent): harden runtime reliability and efficiency`
- `a28090b86` — `docs(agent): finalize Phase 13 report`
- `eed3747fc` — `test(agent): cover task recovery lifecycle`
- `1740ef0ee` — `docs(agent): record Phase 13 dogfood coverage`
- `96a764c4b` — `docs(agent): correct Phase 13 verification totals`
- `952fa93c2` — `docs(agent): record final Phase 13 checkpoint`
- `2cede191c` — `docs(agent): keep Phase 13 status durable`
- `6430852d5` — `fix(agent): refresh mode envelope during active turns`
- `6c4143fe7` — `docs(agent): record Phase 13 evidence matrix`
- `87205e49f` — `docs(agent): add measured child telemetry`
- `b9922ded7` — `feat(agent): add bounded productive budget extensions`
- `6ea48bce9` — `docs(agent): document bounded budget extensions`
- `dfbe97d1e` — `docs(agent): record verifier timeout evidence`
- `7507674be` — `test(agent): guard budget extension progress gate`
- `b96428a7e` — `docs(agent): list Phase 13 checkpoints`
- `5ad626abb` — `fix(agent): align verifier budget prompt`
- `ad333dabc` — `fix(agent): harden Phase 13 context and PTY audits`
- `9d23ed556` — `docs(agent): record complete Phase 13 context audit`
- `12261965e` — `feat(agent): export context cost audit seam`
- `6de0c3e32` — `docs(agent): close Phase 13 report bookkeeping`
- `ecbe31425` — `fix(agent): align goal task projections`
- `c866c6506` — `test(agent): cover Aira SDK host wiring`
- `315b376f0` — `docs(agent): record SDK and live probe evidence`
- `7f5fc4eb7` — `docs(agent): record tmux layout evidence`
- `0a6ea0960` — `docs(agent): close Phase 13 checkpoint list`
- `939dd3526` — `fix(agent): expose goal task totals`
- `6fb5d52ae` — `docs(agent): record goal totals checkpoint`
- `a0c13a04b` — `docs(agent): record Chromium fixture pass`
- `436753230` — `docs(agent): record live workload samples`
- `78cad2ea3` — `docs(agent): record inspector resize dogfood`
- `fb8a62341` — `docs(agent): record interactive tmux dogfood`
- `c236342f0` — `docs(agent): complete Phase 13 checkpoint list`
- `24113de8f` — `docs(agent): record six-file budget sample`
- `da6888893` — `docs(agent): record live capability preflight`
- `f622f92eb` — `docs(agent): track latest Phase 13 checkpoint`
- `1f7f59545` — `docs(agent): record live plan preflight`
- `79cb6e7e4` — `docs(agent): track preflight checkpoints`
- `3f9a8ec0b` — `fix(agent): preserve failed child budget telemetry`
- `143835644` — `docs(agent): record failed budget telemetry`
- `5a02e015b` — `docs(agent): record post-fix test rerun`
- `f17b14202` — `docs(agent): record live sudo cancellation`
- `98f2aec04` — `docs(agent): record wrong password dogfood`
- `4a2583135` — `docs(agent): clarify sudo verification boundary`
- `d71f46a47` — `fix(agent): report interactive auth outcome truthfully`
- `abbc77107` — `docs(agent): record interactive auth semantics`
- `30853313d` — `docs(agent): record focused Phase 13 rerun`
- `70c5176e3` — `test(agent): stabilize auto execution timing`
- `f6722d739` — `fix(agent): protect pre-existing workspace changes during repair`
- `f3e466b14` — `fix(agent): persist recovered task state and hint resumed model`
- `9580178ca` — `docs(agent): record live budget termination evidence`
- `ee29f30a7` — `docs(agent): reconcile Phase 13 test counts`
- Closeout — `fix(agent): harden Phase 13 runtime reliability` wraps the
  completion-boundary/objective-forwarding work, the workspace event baseline
  race, the focused regressions, and this report/ADR correction.

## 19. FINAL GIT STATUS

- Branch: `main`, ahead of `origin/main` by the Phase 13 checkpoint commits
  and the closeout commit.
- The closeout commit `fix(agent): harden Phase 13 runtime reliability` wraps
  the completion-boundary/objective-forwarding work, the workspace event
  baseline race, the focused regressions, and this report/ADR correction.
  All Phase 13 work is now committed; the working tree is clean.
- Nothing was pushed, tagged, or published.
- Phase 14 has not started.
