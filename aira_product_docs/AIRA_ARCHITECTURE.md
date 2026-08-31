# Aira Product Architecture

> Status: initial architecture freeze  
> Model: standalone Pi-derived product with Pi compatibility  
> Canonical home: `~/.aira/`  
> Canonical executable: `aira`

## 1. Product boundary

Aira is built from Pi's source code rather than implemented as a coordinating Pi extension.

```text
Pi upstream
    ↓
Pi-derived runtime foundation
    ↓
Aira native harness
    ↓
complete Aira product
```

This removes artificial extension boundaries around host-level concerns such as modes, tool visibility, keybindings, session state, permissions, compaction, orchestration, and UI.

Pi compatibility is preserved as a platform contract so the ecosystem remains useful.

## 2. Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                            AIRA                              │
├──────────────────────────────────────────────────────────────┤
│ Pi-derived Runtime                                           │
│ models · providers · tools · sessions · TUI · package loader │
├──────────────────────────────────────────────────────────────┤
│ Native Harness                                               │
│ intent router · state machine · modes · orchestrator         │
│ task graph · capability router · supervision                 │
├──────────────────────────────────────────────────────────────┤
│ Native Engineering                                           │
│ project detector · repo intelligence · diagnostics           │
│ processes · tests · browser · git · verification             │
├──────────────────────────────────────────────────────────────┤
│ Agents                                                       │
│ Scout · Researcher · Verifier                                │
├──────────────────────────────────────────────────────────────┤
│ Policy                                                       │
│ permissions · workspace boundaries · trust · hooks           │
├──────────────────────────────────────────────────────────────┤
│ Native UX                                                    │
│ editor · status lane · footer · modes · diff/review          │
├──────────────────────────────────────────────────────────────┤
│ Pi Compatibility                                             │
│ extensions · skills · themes · package syntax · migration    │
└──────────────────────────────────────────────────────────────┘
```

## 3. Source boundary

Keep Aira-specific implementation isolated wherever practical so upstream Pi remains mergeable.

Preferred conceptual structure:

```text
src/
├── core/                 # Pi-derived runtime; minimize invasive changes
├── ui/                   # Pi-derived host UI
├── extensions/           # Pi-compatible extension machinery
├── compat/
│   └── pi/               # compatibility and migration behavior
└── aira/
    ├── harness/
    ├── modes/
    ├── project/
    ├── intelligence/
    ├── execution/
    ├── browser/
    ├── agents/
    ├── supervision/
    ├── policy/
    └── ui/
```

Exact paths should follow the upstream repository once inspected. The architectural requirement is separation, not these literal folder names.

Prefer narrow host integration seams:

```text
Pi lifecycle event
       ↓
Aira bridge
       ↓
Aira subsystem
```

over scattering Aira-specific conditions throughout upstream code.

## 4. Canonical state

Aira must have one session-state owner.

```text
AiraSessionState
├── mode
├── objective
├── intent
├── taskClass
├── plan
├── taskGraph
├── project
├── intelligence      (health snapshot, Phase 5)
├── workingSet
├── capabilities
├── activeProcesses
├── supervision
├── checkpoints
└── verification
```

No subsystem or compatibility extension may create a competing source of truth for these concepts.

## 5. Modes

### BUILD

Default mode. Editing and normal engineering execution are enabled subject to policy.

### PLAN

Read-only project mode. Reading, search, repository intelligence, research, and read-only LSP operations remain available. Project mutations are blocked at the host/policy layer.

### REVIEW

Inspection-oriented mode. Diff, diagnostics, tests, runtime evidence, requirements, and verification are prioritized. Unrestricted implementation is not silently permitted.

Native mode cycle:

```text
Shift+Tab
BUILD → PLAN → REVIEW → BUILD
```

Thinking/effort may move to `Ctrl+Shift+E`.

## 6. Intent and complexity

Modes are user-visible state. Intent is an internal orchestration hint.

Initial intents:

```text
direct
investigate
implement
debug
refactor
review
research
plan
operate
```

Complexity should scale execution:

```text
trivial
  → direct

moderate
  → understand → implement → diagnose → verify

complex
  → understand → plan → decompose → execute → verify → repair

durable
  → persistent task state → bounded autonomous rounds → independent verification
```

Do not spawn a team for trivial changes.

## 7. Project awareness

Aira should derive a project profile from repository signals:

```text
ProjectProfile
├── root
├── git
├── languages[]
├── frameworks[]
├── packageManagers[]
├── testCommands[]
├── buildCommands[]
├── devCommands[]
├── browserRelevant
├── deploymentHints[]
└── confidence
```

Project scope is a safety boundary. Aira must not treat the user's entire home directory as a repository by default.

## 8. Capability router

Aira exposes a native capability classification contract (ADR-022) so host policy can reason semantically:

```text
read-only    read, grep, find, ls
mutating     edit, write
process      bash, powershell
diagnostic   reserved for native intelligence operations
network      reserved (web research)
browser      reserved (Phase 7)
unknown      third-party tools (never flagged mutating; PLAN-permissive)
```

Routine capabilities activate from lifecycle/intent, not manual commands (ADR-007).

## 9. Repository intelligence

Repository intelligence answers:

> What code and relationships matter to the current objective?

Phase 5 ships a native bounded file-level index (ADR-023): languages, symbols, imports/imported-by, source/test counterparts, lexical discovery, and git changed files, persisted as a JSON cache under the Aira home. It is a service (activation from the canonical project profile, ambient context selection) rather than a pile of tools. Embeddings/semantic retrieval and large graph machinery are deferred; no network or model call gates local understanding. Storage stays behind the provider boundary (`node:sqlite` is the zero-dependency upgrade path if a later phase needs SQL).

## 10. Live code intelligence

Live code intelligence answers:

> What does the actual language/toolchain say about the code now?

Phase 5 ships a native minimal LSP client with project-scoped, lazy, reused language servers (TypeScript/JavaScript, Python, Go, Rust, C/C++, C#), post-edit diagnostics, warm-only navigation, idle eviction, and crash degradation. Missing servers degrade to plain search. Health reporting never spawns a server: a supported project with a resolvable server reports `idle` (cold/unprobed), an actively running server reports `ready`, `unavailable` is reserved for when no relevant server actually resolves, and crashed/cooldown states report `degraded`. The reference implementations (pi-lens, pi-codeontime-code-intelligence) were studied as laboratory specimens; Aira does not depend on either.

## 11. Execution runtime

Aira operates the software it edits through a native per-session execution
runtime (ADR-024). One `AiraExecutionManager` per `AgentSession` owns the
lifecycle: launch, status, bounded stdout/stderr capture, termination
(graceful → forced with group-survivor reaping), disposal cleanup, and
conservative dev-server reuse. The canonical session state carries a bounded
snapshot (`state.execution`); logs and truth live in the manager.

```text
AiraExecutionManager (per session)
├── start(request, {mode, timeoutMs, reuse, signal}) → ExecutionResult
├── get / list / logs(id, tail) / terminate(id, reason)
├── subscribe(events)                     # started / backgrounded / exited
├── dispose()                             # graceful → forced, own processes only
└── ProcessRecord                         # id, request, cwd, pid, purpose,
                                          # ownerSessionId, status, exitCode,
                                          # bounded stdout/stderr buffers,
                                          # lifecycle metadata
```

- Foreground commands wait and return structured evidence (exit code,
  duration, bounded output tails with truncation markers). Background
  commands return a managed id immediately; `auto` stays foreground until it
  outlives the auto-background threshold (~20s), then becomes managed
  background (runtime signal, not a command-name heuristic).
- Ownership is per-session-instance (ADR-024): disposal kills only the
  session's own processes, so overlapping sessions over the same session
  file cannot kill each other's processes. Managed pids join the host's
  last-resort detached-child tracking for crash-path reaping.
- Project-aware execution consumes the canonical `ProjectProfile` commands
  (test/build/check/dev) with explicit depth semantics: TARGETED (toolchain-
  aware target suffix), RELATED (nearest subpackage with its own profile),
  PROJECT (full command). `runCheck` prefers profile check commands and
  falls back to build.
- Model-facing tools: `process_start`, `process_status`, `process_logs`,
  `process_stop` (registered by default; `process` class for start/stop,
  `diagnostic` for status/logs). The restrained `/processes` command lists
  the live table; `/doctor` gained an `execution` check.

The harness should start/reuse/restart development servers when appropriate
and consume their logs without requiring the user to manage tmux manually.

Testing should distinguish targeted checks, related tests, full suites,
builds/type checks, and runtime/browser verification.

## 12. Browser

Browser and public-web research are separate capabilities. Phase 7 ships a
native browser subsystem (`src/aira/browser/`) with ONE runtime owner per
session (`AiraBrowserManager`, ADR-025) behind a replaceable provider
boundary (`AiraBrowserProvider`); the Phase 7 provider is an Aira-native
CDP/Chromium implementation (zero new npm dependencies).

- **Isolated by default**: Aira launches its own disposable Chromium
  (headless, fresh profile under `~/.aira/agent/cache/browser/`, random
  loopback DevTools port). Personal signed-in browsers are never touched;
  attached use would be an explicit future opt-in mode.
- **Observation first**: bounded accessibility-tree/semantic observation
  with stable element refs is the primary evidence; DOM dumps never enter
  state or context. Console/network evidence is bounded and deduplicated
  (counts + top finding). Screenshots are opt-in, path-referenced only,
  and pruned.
- **State ≠ context**: `state.browser` is a bounded, provider-independent,
  token-free snapshot (future Workbench/footer render it without model
  tokens). Ambient prompt context (`browser.context` off|auto|on) is a
  separate budgeted, deduplicated selection; AUTO commonly injects zero
  browser tokens.
- **Verification**: one bounded auto-verify pass after a browser-relevant
  edit when a Phase 6 dev process runs and a local URL was discovered
  (output-derived only); `browser_verify` for explicit checks (REVIEW).
  No retry loops; browser absence degrades truthfully.

Desired web-app verification:

```text
edit
 ↓
diagnostics
 ↓
start/reuse app
 ↓
browser
 ├── semantic observation (a11y first)
 ├── interaction (ref-based)
 ├── console
 ├── network
 └── screenshot when useful
 ↓
bounded verification evidence
```

## 13. Agents

Keep the permanent taxonomy deliberately small: five lightweight roles that
influence prompt framing, capability-derived tool access, and expected result
format — not a large agent catalog (ADR-027).

### Explore

Read-only repository exploration: map unfamiliar code, trace flows, locate
definitions and usage; strongest output is concrete file/line references.

### Research

Read-only investigation and bounded analysis with evidence references
(no native web tool exists yet — workspace + provided context only).

### Review

Independent inspection-oriented review: evaluate correctness, robustness,
fit; findings ordered by severity with remediation suggestions. REVIEW is
NOT the Phase 8 verifier — orchestration never controls verifier verdicts.

### Test

Test-oriented execution through the managed execution runtime (root-owned
process lifecycle) plus analysis of results.

### Implement

Bounded workspace changes: smallest coherent change set + change reports.

### Verifier

Independent fresh-context completion review (Phase 8, ADR-026). Not a
teammate; never an orchestration child.

Children are runs owned by the root session's orchestration manager: they
receive an explicit bounded envelope (task, role, project, files, context,
mode, result contract) — never the parent conversation — and a mode-gated,
capability-derived tool set. Children cannot spawn children (root-only
delegation), cannot browse, and never receive unknown/extension tools.

Subagents never own competing canonical task state.

## 14. Verification

Verification combines independent evidence:

```text
                  VERIFY
                    │
       ┌────────────┼────────────┐
       │            │            │
 diagnostics      tests       reasoning
       │            │            │
 code health     behavior     requirements
 types/lint      runtime      architecture
 structure       browser      edge cases
```

Phase 8 ships the native independent verification service
(`src/aira/verification/`, ADR-026): one per-session manager, a fresh-context
verifier model call, and the canonical verdict contract.

```text
implementation believes it is finished
            ↓
      independent verification   (fresh context, bounded evidence, read-only tools)
            ↓
       ┌─────┼────────────┐
      PASS  FAIL     INCONCLUSIVE
```

- **Independence**: the verifier receives the user objective, the approved
  change summary, repository/language/execution/browser evidence snapshots,
  and explicit missing-evidence markers — NEVER the implementation
  conversation. Its only tools are read/grep/find/ls (bounded); no shell, no
  edits, no browser interaction.
- **Requirement-driven**: a bounded checklist (explicit + necessary inferred)
  with per-requirement verified/unmet/unverifiable status derived from the
  objective.
- **Verdicts**: PASS / FAIL / INCONCLUSIVE. INCONCLUSIVE never silently
  becomes PASS; a pass with unmet requirements is FAIL, a pass without
  concrete evidence is INCONCLUSIVE, verifier driver failures are
  INCONCLUSIVE with an explicit lastError.
- **Bounded**: evidence envelope budgets (compact/balanced/expanded), capped
  requirements/findings/evidence, secret redaction, revision-hash dedupe
  (unchanged implementations are not reverified).
- **Fresh**: a new relevant edit or a moved change set invalidates a prior
  PASS immediately; mtime drift of the verified change set stales on
  refresh. A stale verdict is not completion evidence.
- **Canonical state**: `state.verification` is a bounded, token-free,
  UI-ready snapshot (status, currentResult, requirement counts, highest
  finding, stale, missing evidence, lastError) — the future Workbench/footer
  render it without model tokens. Verification state is separate from
  REVIEW-mode state.
- No repair loop exists in Phase 8: FAIL carries structured findings; a
  later orchestrator owns repair → BUILD → new revision → verify.

## 15. Supervision

All findings should normalize into one Aira-owned bus.

Sources include:

- diagnostics;
- tests/build;
- browser runtime;
- process failures;
- verifier;
- orchestration (bounded child failure telemetry in `state.orchestration`);
- policy.

Aira decides whether to repair, retry, surface, pause, ask, or fail. Third-party engines should not each dominate the user interface.

## 16. Permissions and trust

Suggested normal policy:

```text
workspace reads/search       allow
workspace edits              allow
normal tests/build           allow
git status/diff/log          allow

dependency installation      ask
git commit                   configurable
git push                     ask
outside-workspace writes     ask
system configuration         ask
destructive shell            ask/deny
secrets                      deny by default
```

A repository cannot grant itself additional privileges.

Future `.aira` project hooks must be explicitly trusted by exact configuration hash; modifying the configuration invalidates trust.

## 17. Compaction

Aira should preserve engineering state rather than trusting generic conversation summarization.

Persist:

```text
objective
plan
task graph
decisions
working set
important references
unresolved findings
process state
verification state
```

Code can be retrieved again from repository intelligence rather than copied wholesale into checkpoints.

## 18. UX

Aira should absorb the useful work prototyped in `pi-polished-ui` into native host UI over time.

Example:

```text
AIRA ◈ BUILD   stream-web   main   ✓ healthy
AIRA ◇ PLAN    stream-web   main   read-only
AIRA ◎ REVIEW  stream-web   main   SUP 1
```

Do not expose every internal engine all the time.

Every subsystem is a UI telemetry PRODUCER into canonical state; the future
Workbench/footer is a CONSUMER, never another state owner (see
`UI_BACKLOG.md`). Phase 9 adds orchestration telemetry:

```text
AIRA ◈ BUILD   ◉ LSP  ✓ VERIFY   ◇ AGENTS 3
AGENTS 3 running · 1 queued
├─ implement  fix streaming seek      running   deepseek-v4-flash  12.3s  1.2k tok
├─ explore    map player module       completed opencode-go/qwen3.7 … 4.1s
└─ review     audit seek contract     failed    model-unavailable  1ms    retryable
```

All rows render from `AiraSessionState.orchestration` (bounded, token-free);
no child process or log inspection is needed. Mode + LSP + verification +
agents + processes + browser + git + context combine without invasive
subsystem changes.

### 18.1 Native Workbench (Phase 12)

Aira now owns one native Workbench UI (ADR-031). The sidebar renders the
engineering context beside the conversation; the footer is a responsive
segment rail; `Ctrl+Shift+O` toggles the sidebar while `Ctrl+O` retains
tool-output expansion (ADR-032). Structure:

```text
Canonical subsystem snapshots (state.*)
            ↓
  WorkbenchProjection   (src/aira/ui — pure, token-free, headless-safe)
            ↓
    panels + footer + sidebar (modes/interactive/workbench — TUI only)
```

- Dynamic panels (P0 urgent → P3 ambient; Working Set, Relevant Symbols,
  Changeset, Intelligence, Execution, Browser, Verification, Goal, Tasks &
  Agents, Control, Interaction, Current Finding).
- Responsive: wide (full adaptive), medium (P3 dropped), narrow (sidebar
  auto-hidden; footer drops low-priority segments).
- Fullscreen mode renders an HStack split with independent sidebar
  scrolling; regular mode uses a viewport-fixed overlay rail with a
  base-width shrink (`AiraTuiMainScreen`).
- The Workbench consumes ONLY canonical snapshots + the bounded
  working-set/symbols seams; rendering spends zero model tokens.
- Extension chrome conflicts are diagnosed truthfully (`/doctor`); a
  third-party custom footer replaces the native rail per Pi's contract.

Minimal explicit controls:

```text
/status
/doctor
/capabilities
/processes
/checkpoint
/rewind
/mode
```

Core Aira commands are unnamespaced (ADR-017).

Routine engineering capabilities should activate automatically.

## 19. Pi compatibility

Aira should preserve, wherever practical:

- Pi extension APIs;
- Pi skills;
- Pi themes;
- Pi provider/model compatibility;
- Pi package source syntax such as `npm:` and `git:`;
- familiar package management behavior.

Canonical Aira paths remain under `~/.aira/` — `~/.aira/agent` for the Pi-compatible home resources, `<cwd>/.aira` for project-local ones (the Pi `piConfig` fork seam re-points the centralized path helpers). Compatibility code may import or migrate from `~/.pi/`, but Aira must not require `~/.pi/` for normal operation. The npm package ships both `aira` (canonical) and `pi` (compatibility alias) executables.

## 20. Architectural invariants

1. Aira is a standalone product.
2. `aira` is the canonical executable.
3. `~/.aira/` is the canonical home.
4. Aira owns native UX, modes, state, orchestration, and policy.
5. Pi compatibility is preserved where practical but does not dictate Aira UX.
6. Aira-specific code stays isolated from upstream-derived code wherever practical.
7. One canonical state owner exists per session.
8. Plan mode is genuinely read-only.
9. Task complexity controls orchestration complexity.
10. Subagents do not own competing task truth.
11. Verification is independent from implementation completion claims.
12. Browser defaults to an isolated profile (ADR-025); browser state is
    token-free and separate from ambient model context.
13. Verification is a native service (ADR-026): fresh-context verifier,
    canonical PASS/FAIL/INCONCLUSIVE contract, revision dedupe, freshness
    invalidation, token-free canonical state; INCONCLUSIVE never silently
    becomes PASS; no unbounded repair loop.
14. Orchestration is a native per-session service (ADR-027): root-owned
    children with bounded explicit envelopes, capability-derived tool sets,
    a small DAG scheduler, truthful model degradation, token-free canonical
    telemetry; children never receive orchestration/browser/unknown tools;
    PLAN read-only holds through orchestration.
13. Projects cannot silently grant privileges.
14. Optional specialist engines degrade gracefully.
15. Mature machinery is not rewritten without a measured reason.
16. The existing `engineering-loop` is not part of this architecture.
17. Development uses frequent local Git commits; publishing/pushing is a separate action.
18. Intelligence is a native host service: activation comes from the canonical project profile, context is a bounded budget, and degraded providers fall back to plain Pi behavior (ADR-023).

## 1.10. Goal Runtime (Phase 10)

The native Goal Runtime provides bounded autonomous continuation (evaluate -> FAIL -> repair -> evaluate) for long-running engineering objectives. 

### Core Principles
- **Coordinator, Not Owner**: Goal does not duplicate execution, verification, or task decomposition. It coordinates existing Phase 6 (Execution), Phase 7 (Browser), Phase 8 (Verification), and Phase 9 (Task Graph) services.
- **Bounded Continuation**: Every goal is constrained by limits on rounds (`maxRounds`), token budget (`tokenBudget`), or execution time (`maxDurationMs`). No-progress loops (identical failures across rounds) are aggressively detected to block infinite thrashing.
- **State Machine**: Explicit validated lifecycle: `idle`, `active`, `verifying`, `repairing`, `waiting`, `paused`, `completed`, `budget-limited`, `cancelled`, `error`.
- **Ownership (ADR-024, ADR-028)**: A single canonical Goal Runtime manager per `AgentSession`. It does not bleed across to unrelated or forked sessions. State persists into the canonical machine-readable cache to survive restarts as `paused`.
- **Read-Only / Token-Free Projection**: Goal state projection (via `AiraSessionState.goal`) must require zero token cost, supporting the future Workbench UI (see B-005).

### Inter-System Seams
- **Verification Authority**: Phase 8 Verifier dictates the completion boundary. `PASS` marks completion; `FAIL` sparks bounded repair; `INCONCLUSIVE` triggers evidence acquisition or wait states.
- **Task Graph Dependency**: Goal does not own a secondary todo list. It leverages the Phase 9 task graph to project tasks completed vs. total.
- **User Steering**: Pending user messages defer continuation. Explicit user steer messages resume paused or waiting goals.

## 1.11. Interaction & Control Layer (Phase 11)

The native human-control layer (ADR-030): deterministic tool authorization,
structured Q&A, and the canonical task graph — three tightly coupled
services with ONE canonical owner each, integrated with the Phase 3-10
systems rather than becoming extension-like subsystems.

```text
Agent / Goal / Orchestration
        │
        ├── wants an action
        │       ↓
        │   Permission Controller          (src/aira/permissions/)
        │       ├── allow → execute
        │       ├── deny  → truthful tool denial
        │       └── ask   → Native Interaction   (src/aira/interaction/)
        │                                ↓
        │                    TUI dialog / answer / cancel
        ├── needs user decision
        │       ↓
        │   Structured Q&A (ask_user) → waiting → answer → resume
        └── has work
                ↓
           Phase 9 Task Graph (orchestration children)
                ↓
           Task Manager projection        (src/aira/tasks/, state.tasks)
```

- **Permission pipeline** (host-side, deterministic, token-free): PLAN
  read-only is ABSOLUTE (no mode, no rule can weaken it) → allow-once
  grants (consumed by the request they approved) → explicit rules (most
  specific match wins; persistent rules in Aira-owned
  `~/.aira/agent/permissions.json`; project config is NEVER read) →
  mode defaults by the Phase 5 capability class. Modes: `normal`
  (default), `permissive`, `strict` (deny-unapproved), `yolo` (bypass —
  explicit denies + PLAN remain).
- **Structured Q&A**: one pending interaction per session; permission ASK
  and the `ask_user` model tool share the same manager (types
  "permission" | "semantic" in canonical state). Outcomes are truthful
  (answered / cancelled / timed-out / unavailable / superseded); a
  cancelled question is never an answer. Headless = unavailable, never a
  hang; the interactive TUI renders the dialog.
- **Task graph**: the Phase 9 orchestration manager stays the owner of
  child run records; the Task Manager owns manual/model rows and projects
  child runs as read-only rows (patching refused). `blocked` is derived;
  transitions are forward-only; single-task patching only.
- **Goal waiting**: structured kinds `user-question` / `permission` /
  `evidence` (never inferred from strings); answer resumes, semantic
  cancel keeps the goal waiting, permission denial resumes the round.
- **Children never prompt**: deterministic child gating evaluates the
  ROOT policy with ask→deny — no permission forwarding, no nested
  interactive storms.
- **Token discipline**: all policy evaluation is host-side; snapshots
  (`state.permissions`, `state.interaction`, `state.tasks`) are bounded,
  token-free, UI-ready with subscribe seams (UI_BACKLOG B-006).
