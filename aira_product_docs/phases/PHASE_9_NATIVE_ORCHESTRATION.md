# Phase 9 — Native Multi-Agent Orchestration

**Status:** ✅ done 2026-08-31

## Goal

Build Aira's native multi-agent orchestration: bounded work delegated from the
root session to isolated child agents, bounded parallel execution, small
dependency graphs, structured results, truthful failure/cancellation
semantics, and UI-ready canonical telemetry — without a workflow engine, an
agent catalog, or reference-extension baggage.

## Reference study

Laboratory specimens installed in stock Pi, studied read-only
(`~/.pi/agent/npm/node_modules/`):

- **pi-maestro-teammate** — the full teammate runtime: child `pi` subprocesses
  forked from parent session snapshots, RPC control channel, model routing
  with health-ranked fallbacks and circuit breakers, retry classification,
  concurrent graphs with `{name}` dependency references, structured output
  schemas, progress phases, completion outbox, session lease fencing.
- **pi-maestro-flow** — the root-side integration: `teammate`-family tools,
  worker-to-worker messaging (`teammate-send`), todo-context injection,
  per-role prompt/agent configs, swarm (ACO) skill over persisted JSON state.
- **pi-maestro-backend-core** — the backend capability contract
  (native/emulated/withheld capability delivery).

`pi-subagents` and `@crayonlu/qi-harness` were NOT installed in this stock Pi;
their ideas were not studied from source and are not claimed.

### Behaviors observed (answering the reference questions)

**Agent lifecycle** — children are real Pi subprocesses started per dispatch
(`--mode rpc --no-extensions --fork <snapshot> --model … --tools …`); parent
ownership is the extension tool in the root session; completion settles
through result publication + lifecycle confirmation; cancellation travels an
AbortSignal into the child RPC process (SIGTERM → grace → group kill/taskkill
tree reclamation); timeouts are per-run; abnormal termination settles
`terminalStatus` and results are reclaimed via `attemptReclamations`.

**Isolation** — children inherit the PARENT TRANSCRIPT through the fork
snapshot (up to the spawning tool call; a synthetic compaction boundary is
injected when the retained chain exceeds a threshold). Tools are inherited
per agent config + extension registry; project context and skills are
config-flag controlled; model and thinking level are explicit args.

**Parallelism** — `runGraph` over normalized tasks: semaphore concurrency
(default 4), dependency completion listeners, phases
`waiting-dependency` / `waiting-capacity`, cycle rejection, per-graph task
ceiling + a cross-dispatch active-agent ceiling, per-task abort signals.

**Result propagation** — `SingleResult[]`: agent, task, exitCode, full
transcript messages, usage (tokens + cost), model + `attemptedModels`,
`structuredOutput`, durationMs, terminalStatus, publicationId, warnings;
dependent tasks resolve `{name}` / `{name.field}` references from structured
outputs.

**Coordination** — root tool owns dispatch; children can message the parent
and other children (`teammate-send`), call nested `teammate` (depth-guarded),
and observe via `observe`/`teammate-list`; todos are resolved into child
prompts.

**Model routing** — explicit model → agent-config model → default; implicit
fallbacks from the authenticated model list, health-ranked with circuit
breakers; `attemptedModels` records the truth; unavailable models fail a
candidate attempt and move down the chain.

**Failure handling** — per-candidate retry with classification
(transient/permanent), fallback sweeps, replay fences after completed tool
calls, synthetic failures for dependents of failed tasks, cleanup of prompt/
schema/output scratch files, subprocess reclamation with forced fallback.

## Classification

### ADOPT NATIVELY

1. **Fresh-context bounded child runs** through the session's stream
   function (the Phase 8 verifier pattern) — children are model invocations
   with their own system prompt, explicit envelope, and tool set. No
   subprocess-per-child.
2. **Explicit context envelope** (task, role, project, files, bounded
   context, mode, result contract) — never the parent conversation.
3. **Structured result contract** (status/summary/findings/evidence/
   relevantFiles/changedFiles/tests/errors) with a single JSON
   parse+normalize path — the parent consumes results, not transcripts.
4. **Small DAG scheduler**: task ids + same-batch `dependencies`, DFS cycle
   detection, self/unknown/duplicate rejection, semaphore concurrency,
   dependency-failure propagation (synthetic rejection), per-run and batch
   abort signals, hard per-batch task ceiling.
5. **Truthful model degradation**: inherit / default / explicit
   provider-model; unavailable or unauthenticated models fail by name —
   never silently substituted; the actual model identity is telemetry.
6. **Real token accounting** from `AssistantMessage.usage` when the provider
   exposes it; aggregate per-session totals; never invented.
7. **Bounded canonical telemetry** in `AiraSessionState.orchestration`
   (child rows, results, failures with category/message/retryable,
   concurrency truth, aggregate tokens, one-line summary) — token-free and
   UI-ready.
8. **Cancellation as a first-class abort path** into the model stream,
   option 2 in the reference's own phase names: cancel one child, cancel
   all, timeout cancellation, session-dispose cancellation — no orphans, no
   dangling timers.
9. **Progress phases** (`waiting-dependency` / `waiting-capacity` / running /
   settled) and per-child phase in telemetry.

### ADAPT

1. **Root-only delegation** (reference: nested `teammate` with a depth
   guard) — Aira children never receive orchestration tools; recursion is
   impossible by construction. Strict depth limits are unnecessary when
   children cannot spawn at all.
2. **Role table** (reference: per-role agent configs with prompt/tools/
   thinking) — five lightweight roles (explore/research/review/test/
   implement) influencing prompt framing, capability-derived tool access,
   and result emphasis. One table row = one role; no agent catalog.
3. **Briefing references** (reference: lazy `agent://` / `file:` entries) —
   Aira passes bounded file paths in the envelope instead of inline content;
   children read what they need with their read tools.
4. **Mode-weighted behavior** (reference: nothing comparable) — BUILD full,
   PLAN read-only by construction, REVIEW inspection-oriented roles.

### DEFER

- Worker-to-worker messaging (`teammate-send`) — no Phase 9 need; root
  aggregation is the coordination model.
- Model capability routing with fallback chains, health ranking, circuit
  breakers — the runtime resolver seam exists; routing policy is a later
  phase.
- Structured output schemas + `{name.field}` variable resolution — the
  structured result contract already covers dependencies; field-level
  templating can come with a real workflow need.
- Todo-context injection — Aira has no todo system yet.
- Durable completion dispatch / completion outbox / persistence — session
  state is sufficient; audit persistence stays behind canonical storage.
- Background autonomous orchestration loops, supervision of children,
  per-role retry policies.

### REJECT

- Fork-snapshot parent-transcript inheritance (context leakage by design;
  Aira's isolation requirement is the opposite).
- Subprocess-per-child with RPC channels, lease fencing, and session forks —
  in-process fresh-context runs give the same isolation property (fresh
  context, bounded tools, no shared mutable state) at a fraction of the
  machinery, matching the Phase 8 verifier precedent.
- Swarm/ACO optimization over persisted JSON team state.
- Large agent catalogs, workflow marketplaces, MCP orchestration, remote
  agents, cloud coordination, shared knowledge stores.
- Replay fences / circuit-breaker infrastructure in Phase 9.

## Architecture

### Modules introduced (`src/aira/orchestration/`)

```text
src/aira/orchestration/
├── types.ts        task contract, structured result contract, run record,
│                   canonical AiraOrchestrationStatus snapshot, failure
│                   telemetry, token usage
├── settings.ts     orchestration.enabled / maxParallel (1..8) / model
│                   (inherit|default|provider-model) / timeoutMs (30s..15m)
│                   + conservative defaults + normalization
├── roles.ts        five-role table: explore / research / review (read-only),
│                   test (adds process), implement (adds mutating+process);
│                   framing, capability classes, result emphasis
├── envelope.ts     bounded child envelope (task ≤ 4000 chars, ≤ 50 files,
│                   context ≤ 8000 chars, mode, read-only framing, result
│                   contract) + child system prompt
├── tools.ts        mode-gated, capability-derived child tool sets (PLAN
│                   collapses to read-only+diagnostic; never browser /
│                   orchestration / unknown tools; process tools bind to the
│                   ROOT execution manager)
├── runner.ts       fresh-context child runner: bounded tool loop (≤ 8 rounds
│                   × 4 calls), JSON result parse + normalize (bounds),
│                   timeout, cancellation, provider-error mapping, real
│                   token usage
├── scheduler.ts    small DAG scheduler: prepare (duplicate/unknown/self/
│                   cycle/too-many rejection) + run (semaphore concurrency,
│                   dependency completion listeners, dependency-failure
│                   propagation, abort-before-launch)
├── manager.ts      per-session AiraOrchestrationManager (single canonical
│                   owner): dispatch validation, PLAN mode gate, model
│                   resolution, run records, bounded history (64), bounded
│                   snapshot publishing, cancel/status/subscribe/dispose
├── status.ts       snapshot projections + summarizeAiraOrchestration
├── model-tools.ts  agents_delegate / agents_status / agents_cancel tool
│                   definitions (classify as `orchestration`)
└── index.ts
```

### Ownership

`AiraOrchestrationManager` is session-instance-scoped (ADR-024 pattern):
created in the `AgentSession` constructor beside execution/browser/
verification, disposed with the session. Children are NOT session owners;
they are run records owned by the root manager. One store: the manager's run
map; canonical projection: `state.orchestration`. No second owner exists.

### Child context contract

A child receives ONLY:

- task objective (bounded, ≤ 4000 chars);
- role framing + expected result emphasis;
- project root + bounded profile summary;
- bounded relevant-file list (≤ 50 paths);
- bounded parent-selected context (≤ 8000 chars);
- execution mode + read-only enforcement framing in PLAN;
- the structured result contract.

The parent conversation is never injected. The child system prompt states
the isolation rules explicitly ("You do not spawn further agents. You do not
browse.").

### Result contract

Every child returns one JSON object:

```json
{ "status": "completed" | "failed",
  "summary": "… ≤ 600 chars", "findings": ["… ≤ 12 × 300"],
  "evidence": ["…"], "relevantFiles": ["…"], "changedFiles": ["…"],
  "tests": ["…"], "errors": ["…"] }
```

Parsed from fenced/embedded JSON; normalized with hard bounds; `failed`
children carry a bounded error telemetry row
(`{category, message, retryable}`).

### Scheduler design

- One batch = up to 8 tasks with optional same-batch `dependencies`.
- Validation happens BEFORE dispatch: duplicate ids, self-dependencies,
  unknown dependencies, DFS-detected cycles, oversized batches — each fails
  with a specific reason, never hangs.
- Concurrency: semaphore over `settings.maxParallel` (default 2).
- Dependency completion: per-task listener lists; a task whose upstream
  failed/rejected never runs (synthetic rejection, category
  `dependency-failed`).
- Cancellation: batch AbortController + per-run AbortController; abort
  before launch skips pending runs; abort in flight propagates into the
  model stream (the runner races the signal).

### Capability/isolation model

- Tool sets derive from role capability classes through the semantic
  capability tables (ADR-022), extended with the `orchestration` class for
  the three delegation tools.
- PLAN mode: mutation-capable roles are refused PER-TASK at dispatch (mixed
  batches keep their read-only tasks with per-task refusal reasons); every
  PLAN child's tool set collapses to read-only + diagnostic regardless of
  role. A PLAN child physically cannot write, execute, or browse.
- Children never receive browser tools, orchestration tools (root-only
  delegation), or unknown/extension tools — there is no
  privilege-escalation path through unclassified tools.

### Mode behavior

- BUILD: full orchestration; implement/test children may mutate/execute.
- PLAN: read-only exploratory children only.
- REVIEW: inspection-oriented roles favored; implement remains permitted
  (REVIEW stays implement-capable per Phase 3), tool sets are BUILD-equivalent.

### Failure/cancellation semantics

- Child driver failure → run `failed` with category (`driver` | `timeout` |
  `model-unavailable` | `cancelled`); bounded message; retryable flag.
- Timeout (settings default 5 minutes, per-task override bounded) →
  `timed-out`.
- Cancellation (user/`/agents cancel`/`agents_cancel`/session dispose) →
  `cancelled` (or `rejected` when aborted before launch) — both carry the
  `cancelled` category.
- Session dispose aborts every run and batch; the snapshot settles to idle.
- Failures never destabilize the root: the root session keeps working after
  any child outcome (dogfood CASE 4).

### UI telemetry exposed

`AiraSessionState.orchestration` (bounded, token-free):

```text
enabled, status (idle|active), runningCount, queuedCount, maxConcurrency,
children[≤12] {id, taskId, role, task≤100, status, phase, model, elapsedMs,
              dependencies, resultSummary, tokenUsage, error{category,message,retryable}},
recentResults[≤8], failures[≤6] {id, taskId, role, category, message,
              timestamp, retryable},
aggregateTokenUsage?, epochStartedAt?, summary, updatedAt
```

The future Workbench/footer renders this directly; it never needs child
processes or logs. UI notes: `UI_BACKLOG.md` B-001 pattern followed
(footer-style summary line + expandable view), no UI built this phase.

## User-visible behavior

- **Model surface**: `agents_delegate` (batch dispatch, await or background),
  `agents_status` (bounded snapshot), `agents_cancel` (one run or all) —
  registered and active by default (also in the SDK default tool list).
- **Command surface**: `/agents` (status + child rows + failure rows),
  `/agents status`, `/agents cancel [id|all]`.
- **Settings**: `/settings` → "Aira agents": enable, max parallel (1–8),
  default child model behavior (inherit/default/explicit), per-child timeout.
  Persisted via the canonical settings owner (`orchestration.*`).
- **`/status`**: restrained `orchestration:` line (`idle` / `2 running ·
  1 queued` / `disabled`).
- **`/doctor`**: truthful orchestration check (enabled/disabled, state,
  concurrency, active children, failure count) — never dispatches.

## Settings

```text
orchestration.enabled       true      delegation may run
orchestration.maxParallel   2         max children executing at once
orchestration.model         inherit   child model policy
orchestration.timeoutMs     300000    per-child hard timeout
```

## Tests

`test/aira/orchestration/` (62 tests, all passing via `./test.sh`):

- settings.test.ts — defaults, normalization, invalid-value sanitization
- roles.test.ts — the five roles, read-only vs mutating semantics
- envelope.test.ts — bounded explicit context, no transcript injection,
  read-only framing
- tools.test.ts — capability-derived tool sets, PLAN collapse, never
  browser/orchestration/unknown tools
- runner.test.ts — tool loop, fenced/unparseable results, normalization
  bounds, provider errors, tool-budget failsafe, timeout, cancellation
- scheduler.test.ts — parallel bounds, A→B→C and diamond ordering, cycle/
  self/unknown/duplicate/oversize rejection, dependency-failure propagation,
  abort-before-launch, queue semantics
- manager.test.ts — child creation, structured results, model inheritance /
  explicit selection / unavailable model, PLAN refusal + read-only
  toolsets, concurrency + queueing, DAG ordering, timeout, cancellation
  propagation, child crash, parent shutdown, bounded history, failure
  telemetry, real token aggregation, background dispatch, disabled settings
- host-integration.test.ts — through the real `AgentSession`: manager armed +
  canonical snapshot, default tool registration, NATIVE child through the
  real stream function, BUILD child mutates the workspace, PLAN refusal and
  unknown-tool write attempt, REVIEW delegation, settings off, child failure
  without root destabilization, `/doctor` + `/status` surfaces, session
  dispose aborting in-flight children.

Also updated for the new default tools: modes/plan-readonly/default-tools/
doctor/intelligence host tests, regressions 3592/5109. The Phase 8 verifier
and Phase 7 browser suites still pass; a latent timeout race in the
fresh-context runner (raceWithTimeout never observed the timeout rejection)
was fixed in both the child runner and the verifier.

## Dogfood (real `aira` binary)

Rebuilt `packages/coding-agent/dist`; isolated agent dir
(`AIRA_CODING_AGENT_DIR=/tmp/aira-p9-agent`: own settings without reference
packages, copied auth + models-store), fixture project under
`/tmp/aira-dogfood/proj` (real git repo with `src/player.ts`,
`src/streams.ts`). Real model: opencode-go/deepseek-v4-flash for every
delegation.

- **CASE 1 — successful child**: print mode delegated one `explore` child
  through `agents_delegate`; the child read the repository and returned a
  bounded structured summary the root quoted back verbatim.
- **CASE 2 — two concurrent children**: one `agents_delegate` call with two
  explore tasks; both completed with independent file-level summaries.
- **CASE 3 — dependency ordering**: tasks a → b (deps a) → c (deps b);
  b appended `B_SAW_NOTES` only after a wrote NOTES.md, c appended
  `C_SAW_B` after seeing b's line.
- **CASE 4 — child failure, parent survives**: explicit `model="no/
  such-provider"` child failed truthfully in ~1ms
  (`model-unavailable: requested child model "no/such-provider" is not
  configured`, "failed · model no/such-provider · 1ms" in `/agents`); the
  root then answered a normal follow-up prompt (`PARENT_ALIVE`).
- **CASE 5/6 — PLAN cannot escape read-only through a child**: in PLAN the
  implement child was refused at dispatch (`REFUSED — role implement can
  mutate and is refused in PLAN (read-only enforcement)`) while the explore
  child completed; NOTES.md contains zero `PLAN_LOOPHOLE` bytes.
- **CASE 7 — cancellation**: a background `research` child was cancelled
  with `/agents cancel`; the run row transitioned `running` → `cancelled`,
  state returned to idle, no orphans.
- **CASE 8 — state matches reality**: `/status` → `orchestration: idle`;
  `/agents` → child rows with role/status/model/elapsed + failure rows
  (type/model/time) matching what happened; `/doctor` →
  `ok orchestration: enabled · idle · concurrency 0/2 · 3 child record(s)
  (0 active) · 2 failure(s)`, 12/12 checks.

Zero orphan processes after the session (verified by ps).

## Known limitations

- Browser-capable children are not available in Phase 9: browser tools are
  never granted to children (respects the user's browser settings by not
  auto-granting; a later phase can add an explicit capability).
- Research role has no network tools yet (no native web tool exists); it is
  read-only workspace investigation.
- Child tool `bash` is not granted; process-class children use the managed
  execution tools only (deterministic lifecycle, root-owned).
- Aggregate token usage reflects only children whose provider exposes usage
  (never invented).
- One batch = one dispatch call; cross-batch dependencies are not supported
  (root aggregates results between dispatches).
- No persistence of orchestration state across sessions (session-owned
  state only; ADR-005 pattern).
- Child messages are not surfaced in the root transcript (only structured
  results + telemetry); detailed transcripts are not stored.

## Future extension points

- Nested delegation with a strict depth limit (children currently cannot
  spawn at all — the strongest form of the recursion guard).
- Model routing policies behind the existing `resolveRuntime` seam
  (fallback chains, capability-based task routing).
- Structured output schemas per role and `{name.field}` result references.
- Browser-capable children behind an explicit per-task capability flag.
- Durable orchestration audit behind canonical storage (a later
  `node:sqlite` upgrade path remains available).
- A process/tool broker for child ↔ root tool mediation.