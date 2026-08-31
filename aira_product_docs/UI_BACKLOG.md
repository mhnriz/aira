# Aira UI Backlog

Future Aira UI-overhaul requirements. These are recorded product/design
intents; **none of them are implemented yet.** Each entry stays a backlog
item until its owning phase picks it up.

---

## B-001 — Ambient language-intelligence / LSP state in the native bottom bar

**Status:** backlog (future Aira UI overhaul; explicitly NOT part of Phase 6)

**Problem:** language-intelligence/LSP state is currently only visible
through `/doctor` or model-facing context. The user should be able to see,
at a glance, whether the language toolchain backing the current file is
cold, ready, or reporting findings — without running a slash command.

**Desired direction** (the eventual native bottom bar should surface
language-intelligence/LSP state ambiently):

```text
◈ BUILD  │  LSP TS ○          (cold/unprobed)
◈ BUILD  │  LSP TS ✓          (ready, clean)
◈ BUILD  │  LSP TS 2E 1W      (ready, findings: 2 errors, 1 warning)
```

When findings exist, also show a compact highest-priority/current finding
when terminal width allows:

```text
◈ BUILD │ LSP TS 2E 1W │ TS2304: Cannot find name 'handle'
```

Constraints:

- The UI must truncate intelligently and avoid becoming noisy.
- Multi-language projects should use a compact representation, for example:

```text
LSP TS ✓ · PY ✓
```

**Explicitly deferred:** this is a UI overhaul item only. Phase 6 (execution
runtime) must not implement any bottom-bar/footer redesign; the canonical
health state it builds on is `AiraSessionState.intelligence`
(`/doctor` reports it today).

---

## B-002 — Browser state in the native bottom bar and Engineering Context pane

**Status:** backlog (future Aira UI overhaul; NOT part of Phase 7)

**Problem:** browser runtime state is currently visible through `/browser`,
`/doctor`, `/status`, and model-facing context only. The future Workbench
should render it from canonical state with zero provider calls and zero
model tokens.

**Data contract already available (Phase 7):** `AiraSessionState.browser`
(`AiraBrowserStatus`) — availability (unknown/available/unavailable/
disabled), status (idle/active/degraded/unavailable), provider,
profileKind (isolated), activeTab (id/url/title/readyState), tabs,
console {errors, warnings, total, topFinding}, network {failures,
topFinding}, observation {revision, summary, nodeCount}, verification
{status, lastCheckAt, finding}, screenshot {lastPath}, devProcess
{id, status, url}, reason, updatedAt. Updated on explicit state
transitions; `manager.subscribe()` is the event seam.

**Desired projection — Engineering Context pane:**

```text
Browser
─────────────────────
Chrome        ● ready
Page          /player
Console       1E 2W
Network       1 failed
Check         ✕ failed

Current finding
TypeError: player.seek is not a function
src/player.ts:184
```

**Desired projection — bottom bar segment (compact):**

```text
◈ BUILD  │  LSP TS 2E 1W  │  Browser ● 1E  ·  Runtime ●  ·  Git +4 -1
```

with highest-priority actionable finding when width allows:

```text
Browser ● 1E · TypeError player.seek
```

**Projection rules:**

- The footer/Workbench derive from native subsystem snapshots
  (intelligence, browser, execution, git), never from polling provider
  internals.
- `browser.context=off` must NOT hide browser state from the UI: the
  snapshot is token-free and separate from model-context selection.
- Context deduplication must never delete UI-visible state.
- The browser indicator reflects `status` (idle/active/degraded) and the
  `console.errors + network.failures` counts; the finding line uses
  `console.topFinding` / `network.topFinding` / `verification.finding`.

**Explicitly deferred:** the full Workbench/UI overhaul remains a later
phase; Phase 7 implemented only the underlying snapshot/event seam,
settings, and commands.

---

## B-003 — Verification state in the native bottom bar and Engineering Context pane

**Status:** backlog (future Aira UI overhaul; NOT part of Phase 8)

**Problem:** independent verification state is currently visible through
`/verify`, `/verify status`, `/doctor`, `/status`, and model-facing context
only. The future Workbench should render it from canonical state with zero
provider calls and zero model tokens.

**Data contract already available (Phase 8):** `AiraSessionState.verification`
(`AiraVerificationStatus`) — status (idle/preparing/running/passed/failed/
inconclusive), enabled/auto/contextBudget projections, currentResult
(verdict, summary, requirements with per-requirement status, findings,
evidence items, scopeAssessment, confidence, revisionId, stale,
staleReason), requirementsTotal/requirementsVerified counts, highestFinding,
missingEvidence, lastError, lastSkipReason, startedAt/completedAt/updatedAt.
Published on every state transition; `manager.subscribe()` is the event
seam.

**Desired projection — Engineering Context pane:**

```text
Verification
─────────────────────
Status       ● checking
Requirements 4 / 5
Diagnostics  ✓
Tests        ✓
Browser      ✕
Scope        ✓

Current finding
R3 · browser console error
TypeError: player.seek is not a function
```

**Desired projection — bottom bar segment (compact):**

```text
◈ BUILD  │  VERIFY …       (preparing/running)
◈ BUILD  │  VERIFY ✓       (passed, current)
◈ BUILD  │  VERIFY ✓ stale (passed but stale — not completion evidence)
◈ BUILD  │  VERIFY ✕ 1     (failed; count = blocking findings)
◈ BUILD  │  VERIFY ?       (inconclusive)
```

Optionally combined with the other subsystem chips:

```text
◈ BUILD │ LSP TS ✓ · Browser ✓ · Runtime ✓ · VERIFY ✕ 2
```

with the current highest-priority finding when width allows:

```text
VERIFY ✕ 2 · player remains black after second stream switch
```

**Projection rules:**

- The footer/Workbench derive from the canonical verification snapshot only
  (plus the other subsystem snapshots), never from verifier/model internals
  and never by running verification.
- A stale verdict renders as `stale`, never as current: a stale PASS is not
  completion evidence and must be visually distinct.
- INCONCLUSIVE renders as a question mark, never as a check.
- Verification state visibility is independent of verifier model execution:
  rendering the snapshot costs zero tokens (`verification.auto` only
  controls whether the model runs; it never hides state).
- Mode state and verification state stay separate: REVIEW mode is not a
  verdict, and showing a verdict does not imply a mode.

**Explicitly deferred:** the full Workbench/UI overhaul remains a later
phase; Phase 8 implemented only the underlying snapshot/event seam,
settings, `/verify` commands, and the restrained `/status`/`/doctor`
projections.

---

## B-004 — Orchestration state in the native bottom bar and Engineering Context pane

**Status:** backlog (future Aira UI overhaul; NOT part of Phase 9)

**Problem:** orchestration state is currently visible through `/agents`,
`/doctor`, `/status`, and model-facing tools only. The future Workbench
should render it from canonical state with zero model tokens and zero child
process/log inspection.

**Data contract already available (Phase 9):** `AiraSessionState.orchestration`
(`AiraOrchestrationStatus`) — enabled, status (idle/active), runningCount,
queuedCount, maxConcurrency, children (≤ 12: taskId, role, task ≤ 100 chars,
status, phase, model, elapsedMs, dependencies, resultSummary, tokenUsage,
error{category,message,retryable}), recentResults (≤ 8), failures (≤ 6:
taskId, role, category, message, timestamp, retryable), aggregateTokenUsage,
epochStartedAt, summary, updatedAt.

Desired chips (the future UI combines mode + LSP + verification + agents +
processes + browser + git + context):

```text
◇ AGENTS 3          (active)
AGENTS 3 running · 1 queued
├─ implement  fix streaming seek      running   deepseek-v4-flash  12.3s  1.2k tok
├─ explore    map player module       completed opencode-go/qwen3.7 … 4.1s
└─ review     audit seek contract     failed    model-unavailable   1ms   retryable
```

**Explicitly deferred:** the full Workbench/UI overhaul remains a later
phase; Phase 9 implemented only the underlying snapshot/event seam,
settings, the `/agents` inspection/cancel surface, and the restrained
`/status` (e.g. `orchestration: 2 running · 1 queued`) and `/doctor`
projections.

---

## B-005 — Goal Runtime state in the native bottom bar and Engineering Context pane

**Status:** backlog (future Aira UI overhaul; NOT part of Phase 10)

**Problem:** durable goal state is currently visible through `/goal`,
`/doctor`, `/status`, and model-facing tools only. The future Workbench
should render it from canonical state with zero model tokens and without
parsing any task logs.

**Data contract already available (Phase 10):** `AiraSessionState.goal`
(`AiraGoalSnapshot`) — enabled, auto, status (idle/active/verifying/
repairing/waiting/paused/completed/budget-limited/cancelled/error), round,
tasksCompleted, tasksTotal, tokensUsed, durationMs, stopReason,
blockReason, createdAt, updatedAt. Published on state transitions;
`manager.subscribe()` is the event seam.

**Desired projection — Engineering Context pane:**

```text
GOAL
─────────────────────
Status       ● active
Round        2
Tasks        3 / 6
Verify       waiting
Tokens       41k / 100k
Elapsed      8m 14s

Current
Implement middleware

Blocker
2 failing integration tests
```

And eventually for `waiting` states:
```text
Goal waiting for input
Choose authentication strategy
```

**Desired projection — bottom bar segment (compact):**

```text
◈ BUILD  │  GOAL 3/6  │  AGENTS 2  │  VERIFY …
◈ BUILD  │  GOAL R2   │  VERIFY ✕ 1
◈ BUILD  │  GOAL WAIT │  input needed
◈ BUILD  │  GOAL ✓
```

**Projection rules:**
- The footer/Workbench derive from the canonical goal snapshot only, never by evaluating the model or running child agents.
- Task completion projections are driven by the Task Graph (Phase 9) via the Goal snapshot; the Goal snapshot does not maintain a parallel task list.
- A Goal `waiting` state acts as a seam for the future structured Q&A / permission mode pipelines.
- Showing Goal state must cost zero model tokens.

**Explicitly deferred:** the full Workbench/UI overhaul remains a later phase; Phase 10 implemented only the underlying snapshot/event seam, settings, the `/goal` control surface, and the restrained `/status` and `/doctor` projections.

## B-006 — Interaction & control state in the native bottom bar and Engineering Context pane

**Status:** backlog (future Aira UI overhaul; NOT part of Phase 11)

**Problem:** permission/interaction/task state is currently visible through
`/permissions`, `/tasks`, `/doctor`, `/status`, and model-facing tools only.
The future Workbench should render it from canonical state with zero model
tokens and zero policy evaluation.

**Data contracts already available (Phase 11):**

- `AiraSessionState.permissions` (`AiraPermissionStatus`) — enabled, mode
  (normal|permissive|strict|yolo), persistentRules, sessionRules,
  onceApprovals, store {status, path, error}, lastDecision {tool, action,
  at, subject}, updatedAt, summary. Published on every evaluation/rule
  change; `manager.subscribe()` is the event seam. The future footer chip
  maps mode directly (`PERM normal` / `PERM permissive` / `PERM strict` /
  `PERM yolo`) without parsing strings.
- `AiraSessionState.interaction` (`AiraInteractionStatus`) — pending
  (bool), question {interactionId, type (permission|semantic), prompt
  (≤200 chars), context (≤400), choices (≤12, id+label+description),
  choicesCount, multiSelect, freeform, owner, waitingSince, durationMs},
  recentClosed (≤4: type, prompt, resolution, closedAt), uiAttached,
  updatedAt, summary.
- `AiraSessionState.tasks` (`AiraTasksStatus`) — enabled, total, pending,
  active, blocked, completed, cancelled, failed, current (active title),
  rows (≤24: id, title, status, source (user|model|child), dependsOn,
  childRunId, childRole, detail), childRows, updatedAt, summary.

**Desired projection — Engineering Context pane:**

```text
Permissions
─────────────────────
Mode         normal
Rules        2 persistent · 1 session
Store        ok · ~/.aira/agent/permissions.json

Interaction
─────────────────────
Question     ● pending (semantic)
Prompt       Should this API preserve backward compatibility with v1?
Choices      2    Owner agent    Waiting 12s

Tasks
─────────────────────
Status       3/8 · 1 active · 1 blocked
Current      Implement middleware
```

**Desired projection — bottom bar segment (compact):**

```text
◈ BUILD │ PERM default │ TASK 3/8 │ ASK ●
◈ BUILD │ PERM strict  │ TASK 3/8 ▼ blocked 1
◈ BUILD │ PERM yolo    │ TASK ✓
```

with the pending question when width allows:

```text
◈ BUILD │ PERM default │ ○ Ask pending: Keep v1 compatibility? (2 choices)
```

**Projection rules:**

- The footer/Workbench derive from the canonical snapshots only; rendering
  must never evaluate a permission request, open a question, or touch the
  task store.
- `permissions.enabled=false` renders `PERM off`, never a fake mode.
- A pending interaction renders as a question chip; `type` distinguishes
  authorization (permission) from product (semantic) without parsing.
- Task chip renders counts and the derived `blocked` truth (never inferred
  from titles); child-derived rows are visually distinct (`child` source).
- Mode state, permission state, interaction state, and task state stay
  separate: a strict permission mode is not a PLAN mode, and a pending
  question is not a failed subsystem.

**Explicitly deferred:** the full Workbench/UI overhaul remains a later
phase; Phase 11 implemented only the underlying snapshot/event seams,
settings, the `/permissions` and `/tasks` surfaces, the native Q&A dialog
bridge, and the restrained `/status`/`/doctor` projections.

---

## B-008 — Native Workbench & UI overhaul (Phase 12) — DONE

**Status:** ✅ implemented in Phase 12
([PHASE_12_NATIVE_WORKBENCH_UI.md](phases/PHASE_12_NATIVE_WORKBENCH_UI.md))

The full Workbench/UI overhaul tracked by the entries above is delivered.
Summary of what exists now (each projection derives from the canonical
snapshot named in the entry; token-free by construction):

- **Sidebar** (fullscreen HStack split; regular-mode viewport-fixed overlay
  rail): dynamic panels P0–P3 — Interaction/Authorization, Current Finding,
  Verification, Goal, Tasks & Agents, Execution, Browser, Working Set,
  Relevant Symbols, Changeset, Intelligence, Control — each visible only
  when its source state is relevant (progressive disclosure).
- **Footer**: responsive single-line segment rail with drop ranks
  (required: mode/context/model; P0 interaction/finding; active-work;
  opportunistic) and the arbitrated highest-priority current finding
  (severity always from the source).
- **Visibility policy**: default-on at safe widths, auto-hide below
  `72 + sidebarWidth`, explicit OFF respected, restore semantics
  deterministic (ADR-032).
- **Input**: `Ctrl+O` toggles the sidebar (ADR-032), `/workbench [on|off]`,
  four settings (`workbench.enabled|showOnStartup|density|width`), `/doctor`
  workbench/theme/shortcut/chrome-conflict checks.
- **Theme**: `aira-zhr` default dark theme + eight optional semantic color
  roles with classic fallbacks (ADR-034).
- **Tests**: projection, priority, visibility, footer arbitration,
  finding arbitration, theme mapping, keybindings, headless isolation
  (`test/aira/ui/*`).

Carried-forward out of scope (later phases): fullscreen live-resize
rendering on this dev machine is blocked by a PRE-EXISTING pi TUI crash on
SIGWINCH (baseline-verified; suggested for the Pi compatibility hardening
phase); live LSP diagnostics on this machine never publish (Phase 5
environment issue); a compact density mode beyond the shared spacing
constants, per-panel configurators, and a third-party panel registry stay
deferred by design.
