# Phase 11 — Native Interaction & Control Layer

**Status:** ✅ done 2026-09-05

## Objective

Build Aira's native human-control layer around three tightly related
capabilities: (1) permission modes and deterministic tool authorization,
(2) structured agent → user Q&A, and (3) the native Todo/Task UX — all
integrated with the systems built in Phases 3–10 (capability contract,
modes, execution, browser, verification, orchestration, Goal Runtime)
rather than becoming independent extension-like subsystems.

## Reference study

Laboratory specimens studied read-only under `~/proj/aira-reference/extensions/`
(never installed, executed, or depended on by Aira):

- **pi-ask-user** — interactive `ask_user` tool: TUI overlay/selector with
  searchable option lists, multi-select, freeform, optional timeout,
  `herdr:blocked` lifecycle events while waiting, structured `details` on
  results, truthful null/cancel semantics, prompt snippets + guidelines
  steering when to ask, headless fallback that never fabricates an answer.
- **d3ara1n-pi-ask-user** — bottom-editor-slot ask panel: typed answers
  (single/custom/multi/skipped), tab-based multi-question flows, rich
  option previews, result cart with `cancelled` + `message`.
- **pi-permission-system** — tool_call interception returning
  `{ block, reason }`; global + agent YAML policies; allow/ask/deny per
  tool and per bash pattern with last-match-wins wildcard ordering;
  permission dialogs with Allow Once / Allow Always / Reject / Reject with
  reason; session approval store; system-prompt sanitization (denied tools
  hidden); YOLO runtime toggle; subagent permission forwarding through
  file-watch channels; JSON config with schema validation.
- **pi-agent-permissions** — `.agents/permissions.json` policy load from
  cwd walking per request; `deny` returns a fixed block message; `ask`
  degrades to the host default confirmation; uses the `agent-perms`
  evaluate engine.
- **inobit-pi-todo** — todo tool with create/update/delete/list/get and a
  tiny state machine (pending → in_progress → completed, tombstones),
  widget panel above the editor, replay-from-session-branch persistence,
  aggressive token budget (snippet ≤ 60 chars, ≤ 3 guidelines), patch-
  single-task semantics with applyTodoAction.
- **touchtechclub-pi-oc-todo** — ACP-compatible `todowrite`/`readtodo`/
  `patchtodo`: full-list replace vs single-task patch; status/priority
  validation; compact `n remaining / m total` projections; no persistence.

### Classification (with provenance)

**ADOPT NATIVELY** — bounded structured questions with truthful
cancellation and headless fallback (pi-ask-user); deterministic
allow/once/session/always/deny decisions returned to the tool call with
truthful denial text (pi-permission-system); exact-match non-broadening
approvals and session approval stores (pi-permission-system); bounded
wildcard rule matching with documented ordering (pi-permission-system,
pi-agent-permissions); small task state machines with forward-only
transitions and tombstone-free lifecycle (inobit-pi-todo); single-task
patching instead of full-list replacement (touchtechclub + inobit);
one-line token-light task projections (touchtechclub); prompt snippets +
guidelines constraining WHEN to ask (pi-ask-user).

**ADAPT** — permission modes: Aira defines its own small mode vocabulary
(normal / permissive / strict / yolo) over the Phase 5 capability classes
instead of per-agent policy bags; the host IS the policy owner (Aira is not
an extension inside Pi); "always allow" persists as an EXACT rule in
Aira-owned config instead of the extension's settings file; the TUI
question dialog reuses the host's existing selector/input dialogs instead
of a bespoke overlay component; task rows for orchestration children are
projected (read-only) rather than ingesting a separate agent todo universe.

**DEFER** — multi-select UIs beyond a pick loop (the schema + state carry
it; the dialog stays a bounded single/multi pick loop); skill/MCP
permissions (no native MCP/skill tools in Aira yet); tool filtering from
the system prompt by permission (mode availability already covers PLAN;
permission filtering is a later UI concern); task persistence/replay
(session-owned task graph; Phase 11 keeps it interior to the session);
permission audit logs.

**REJECT** — extension-bound hosts with per-agent YAML permission files
(Aira is the harness; one canonical owner per ADR-005); subagent
permission FORWARDING channels (children never prompt — deterministic
ask→deny gating instead; nested interactive storms are impossible by
construction); ask-everything default postures that make routine
engineering unusable; separate todo databases with replay hacks
(session branch replay); `todowrite` full-list replacement (patch one
task, never replace the list); inventing answers on cancellation.

## Architecture

```text
Agent / Goal / Orchestration
        │
        ├── wants an action
        │       ↓
        │   Permission Controller          src/aira/permissions/
        │       ├── allow → execute
        │       ├── deny  → truthful tool denial
        │       └── ask   → Native Interaction   src/aira/interaction/
        │                                ↓
        │            TUI dialog / answer / cancel (attachUI bridge)
        ├── needs user decision
        │       ↓
        │   Structured Q&A (ask_user) → Goal waiting → answer → resume
        └── has work
                ↓
           Phase 9 Task Graph (orchestration children)
                ↓
           Task Manager projection        src/aira/tasks/ (state.tasks)
```

New modules:

```text
src/aira/interaction/   types.ts (canonical interaction contract)
                        manager.ts (one pending interaction per session)
                        model-tool.ts (ask_user tool, "interaction" class)
src/aira/permissions/   types.ts (modes, rules, snapshots)
                        policy.ts (pure deterministic evaluation + risk markers)
                        rules-store.ts (persistent Aira-owned rules JSON)
                        controller.ts (session gate, approvals, dialog mapping)
                        status.ts (/permissions report formatters)
src/aira/tasks/         types.ts (task graph contract)
                        manager.ts (canonical graph + child projection)
                        model-tool.ts (tasks tool, "interaction" class)
                        status.ts (/tasks report formatters)
```

Host seams modified: `AgentSession` (three new per-session managers,
`beforeToolCall` gate after the PLAN check, child permissionGate into the
orchestration runner, default tool registration), `settings-manager.ts`
(permissions/interaction/tasks keys), `interactive-mode.ts` (`/permissions`,
`/tasks`, the interaction dialog bridge via attachUI), `settings-selector.ts`
(Aira permissions / Aira interaction / Aira tasks submenus), `capabilities.ts`
(new `interaction` class), `modes.ts` (PLAN keeps ask_user + tasks), `state.ts`
(permissions / interaction / tasks snapshots), `goal/types.ts` + `manager.ts`
(waiting kind + interaction seam), orchestration `runner.ts` + `manager.ts`
(deterministic child tool gate).

## Permission model

- **Pipeline (deterministic, host-side, token-free)**: PLAN read-only
  boundary (absolute, always first) → "allow once" grants (consumed by the
  request they approved — nothing stored) → explicit rules (most specific
  match wins: exact subject > wildcard; ties by most-recent rule; matched
  rule overrides mode defaults; in yolo explicit ask rules auto-approve,
  explicit deny rules stay absolute) → permission-mode defaults by
  capability class.
- **Modes**:
  - `normal` (default) — routine engineering allowed (read-only/
    diagnostic/orchestration/interaction classes, in-workspace edit/write,
    routine process commands). ASKs: risky/destructive process commands
    (documented bounded risk-marker table: git push/commit/reset --hard/
    clean, dependency installs, sudo/destructive shell, curl|sh, publish,
    shutdown, secret-adjacent reads), out-of-workspace writes, network
    class, unknown (extension) tools, browser interact/lifecycle.
  - `permissive` — normal-mode asks auto-approve; explicit ask rules still
    prompt; deny rules still deny.
  - `strict` — deny-unapproved: only read-only/diagnostic/orchestration/
    interaction + browser observe/navigate stay allowed by default;
    explicit rules can grant allow/ask.
  - `yolo` — bypass: every ask auto-approves (including explicit ask
    rules); explicit deny rules and the PLAN boundary remain absolute.
- **Safety invariants**: PLAN + permissive/yolo/strict + mutation is still
  denied (proven in policy tests and `/doctor`); permission settings never
  weaken mode enforcement; project-controlled config is NEVER read —
  a repository cannot silently grant itself privileges; persistent rules
  live under `~/.aira/agent/permissions.json` (Aira-owned, bounded,
  validated, fail-closed on corruption, atomic-ish writes).
- **Approval semantics**: allow-once = the very request answered; allow
  session / allow always = an EXACT-subject rule (match: exact) so nothing
  broadens beyond the approved tool+subject; cancelled/timeout/unavailable
  prompts are truthful denials.

## Q&A model

- One `AiraInteractionManager` per session; at most ONE pending
  interaction. `ask()` returns a bounded machine-readable answer;
  resolution channels: TUI dialog answer, caller AbortSignal, optional
  timeout, no-UI-headless (immediate `unavailable` — never hangs), session
  dispose (resolves pending truthfully).
- Types: `permission` (tool authorization) vs `semantic` (product/user
  decision) — distinct in canonical state, same infrastructure.
- The model-facing `ask_user` tool (question, short context, ≤ 12 choices
  with descriptions, single/multi-select, freeform) is prompt-guided to
  continue autonomously when evidence makes the answer inferable and to
  treat cancelled/unavailable outcomes as NON-answers.
- The full conversation is never copied into a second Q&A store: only the
  bounded pending interaction + ≤ 4 closed rows live in
  `state.interaction` (token-free, UI-ready).

## Task / Todo model

- ONE canonical session task graph owned by `AiraTaskManager`. The Phase 9
  orchestration manager stays the owner of child RUN records; child runs
  project into the graph as read-only rows (`source: "child"`) through the
  orchestration subscribe seam — patching/removing them is refused
  (`/agents cancel` is the lifecycle surface). Manual/model rows
  (`source: "user" | "model"`) never silently become a second task
  universe and never auto-delegate.
- Semantics: forward-only validated transitions (pending → active →
  completed; cancelled from pending/active/blocked; `failed` for failed
  child rows); `blocked` is DERIVED from unfinished dependencies and can
  never be set directly; a dependency-blocked task rejects activation
  truthfully; single-task patching only (never full-list replacement);
  bounded rows (≤ 128; oldest settled evicted beyond the cap); session-
  scoped (no persistence in Phase 11 — restart = fresh graph, documented).
- Surfaces: `tasks` model tool (create/patch/list/get/remove) and
  `/tasks` (status/add/done/cancel/get/remove).

## Goal integration

- `AiraGoalWaiting` gained the structured `kind` field:
  `user-question` | `permission` | `evidence` — never inferred from
  strings. The interaction seam (`considerUserInteraction`) moves an
  active/repairing/verifying goal to `waiting` when a question opens
  (kind matches the interaction type) and persists it bounded.
- A real answer resumes the goal (waiting → active, waiting cleared).
  A cancelled semantic question is NOT an answer: the goal stays waiting
  until a real user message resumes it. A permission denial/cancel is a
  complete authorization outcome: the round resumes with the truthful
  denial.
- Recovery: persisted waiting keeps its kind; interaction-driven waits are
  flagged so the seam behaves correctly after restart.

## Orchestration integration

- Children never bypass root authorization and never prompt:
  `gateForChild` evaluates the SAME policy deterministically with ask→deny
  ("children cannot prompt — approve at the root or switch permission
  mode"). Applied per child tool call inside the runner. Nested interactive
  storms are impossible by construction (no prompting channel exists in
  children); interaction tools are never granted to children.

## Modes

- BUILD — full pipeline: normal permission policy, Q&A available, task
  interaction available.
- PLAN — host read-only boundary remains ABSOLUTE and runs BEFORE the
  permission pipeline (PLAN blocks mutating/process/network/browser-
  interact regardless of mode or rules; proven by tests + `/doctor`).
  `ask_user` and `tasks` stay available (questions and planning tasks are
  read-only-mode activities — session state, never workspace/process
  state; documented). Task mutation is permitted in PLAN for the same
  reason; nothing permission-related can enable write/process behavior.
- REVIEW — retains Phase 3 semantics; permission pipeline behaves like
  BUILD; question/task surfaces available; never a verdict source.

## Settings

```text
permissions.enabled       true     authorization pipeline active
permissions.mode          normal   normal | permissive | strict | yolo
interaction.timeoutMs     0        auto-resolve unanswered questions (0 = none)
tasks.enabled             true     session task graph surface
```

All through the canonical settings owner + `/settings` submenus ("Aira
permissions" / "Aira interaction" / "Aira tasks"). Persistent permission
RULES are separate Aira-owned config (`~/.aira/agent/permissions.json`),
managed via `/permissions rule add|list|remove` — never project-local.

## User surfaces

- `/permissions` — status (mode, rule counts, store health, last
  decision, mode cheat-sheet), `/permissions mode <mode>`,
  `/permissions rule add <tool> [pattern] <allow|ask|deny>`,
  `/permissions rule list`, `/permissions rule remove <id>`.
- `/tasks` — grouped list, `/tasks add <title>`, `/tasks done <id>`,
  `/tasks cancel <id>`, `/tasks get <id>`, `/tasks remove <id>`.
- `/status` — restrained appendices: `permissions: <mode>`,
  `interaction: <type> question pending (n choices · Ns)` (only while
  pending), `tasks: <summary>`.
- `/doctor` — three new checks: permissions (mode, rule counts, store
  health, PLAN-absolute proof across every mode), interaction (pending
  truth), tasks (counts + orchestration projection). Health reporting
  never evaluates, prompts, or mutates.
- `/settings` — the three submenus above.
- The native Q&A dialog itself: pending interactions render through the
  existing selector/input dialogs (permission: Allow once / Allow session
  / Allow always / Deny; semantic: choices + custom answer + cancel;
  multi-select pick loop).

## Token / context cost

- Permission policy evaluation is host-side and token-free (no model call
  anywhere in the pipeline; the dialog is host UI).
- `state.permissions` / `state.interaction` / `state.tasks` are bounded,
  token-free snapshots; `/status`, `/doctor`, `/permissions`, `/tasks`,
  and the dialog render them without any model involvement.
- Nothing new is injected into prompts ambiently: `ask_user` and `tasks`
  carry only a bounded prompt snippet + ≤ 3 guidelines (the same pattern
  as the Phase 9 tools), and neither tool result injects the full graph —
  `tasks list` returns ≤ 24 rows + counts.
- Verified: the host integration suite asserts snapshots update without
  model tokens (all faux responses are consumed by explicit tool calls;
  no ambient injections observed in message transcripts).

## UI-ready state

All Phase 11 state is bounded, serializable, token-free, and
subscription-visible (see UI_BACKLOG B-006):

```text
state.permissions   enabled, mode (normal|permissive|strict|yolo),
                    persistentRules, sessionRules, onceApprovals,
                    store{status,path,error}, lastDecision{tool,action,at,subject},
                    updatedAt, summary
state.interaction   pending, question{interactionId,type,prompt,context,
                    choices[],choicesCount,multiSelect,freeform,owner,
                    waitingSince,durationMs}, recentClosed[≤4], uiAttached,
                    updatedAt, summary
state.tasks         enabled, total, pending, active, blocked, completed,
                    cancelled, failed, current, rows[≤24], childRows,
                    updatedAt, summary
```

The future footer can render `PERM default / PERM edits / PERM strict /
PERM yolo` directly from `state.permissions.mode`, question chips from
`state.interaction`, and `TASK c/t` chips from `state.tasks` — no parsing,
no provider calls, no model tokens.

## Failure semantics

Covered by tests (see Verification):

- allow / ask / deny / allow-once (consumed by the request it approved) /
  allow-session / allow-always (exact, non-broadening);
- project config cannot self-escalate: the rules store has NO project
  read path (store contract test);
- yolo/permissive cannot defeat PLAN (policy + host tests);
- unknown capability: ask in normal, allow in permissive/yolo, deny in
  strict;
- cancelled permission prompt → truthful denial; headless ASK → truthful
  denial ("permission prompt unavailable"); permission controller errors
  block only the current call with a truthful reason (session stays
  usable);
- semantic Q&A answer / cancellation (never an invented answer);
- Goal → waiting (kind user-question / permission) → answer → resume;
  cancelled semantic question keeps the goal waiting; recovery of
  interaction-driven waits;
- children blocked on permission deterministically (no storm, no hang);
- cancellation while waiting; session shutdown while waiting (pending
  resolves, no wedged session);
- task patch / invalid transition rejection / dependency-blocked task /
  session isolation / no duplicate task owner (child rows refuse
  mutation; orchestration remains the run owner) / no ambient prompt
  bloat.

## Dogfood

Real `aira` binary with an isolated Aira home (reference packages are NOT
installed there). Rebuilt `packages/coding-agent/dist` (npm run build after
Phase 11 changes) and drove the binary with
`AIRA_CODING_AGENT_DIR=/tmp/aira-p11-agent` (own settings; no Pi packages
loaded — verified the extension list is empty).

- Dogfood finding: the first TUI dogfood run showed the model claiming
  `ask_user` was not in its tool list. Root cause: the TUI/SDK session
  path uses the SDK's own default active tool list (`core/sdk.ts`), which
  had not been extended with the Phase 11 tools. Fixed (sdk.ts +
  regression tests) and rebuilt; subsequent runs showed the native
  question dialog. Recorded here as a real defect found by dogfood.
- **CASE A** — safe read-only action under normal permissions: BUILD
  session, `read` + `edit` + routine `bash` (test/status commands) pass
  without prompting.
- **CASE B** — mutation requiring permission → ASK → allow once →
  succeeds: `git push origin main` in a fixture repo with a local bare
  remote → the TUI dialog renders "Allow bash to run?" with Allow once /
  Allow session / Allow always / Deny; Allow once → the push runs and
  succeeds.
- **CASE C** — ASK → deny → truthful denial: the same command denied →
  the tool result shows "permission denied … (denied by the user)" and
  nothing executes.
- **CASE D** — persistent approval: Allow always on one exact command →
  the identical next request runs without prompt; a different command
  still asks (no broadening).
- **CASE E** — PLAN + yolo: `/permissions mode yolo`, then PLAN, then an
  edit attempt → still denied by the PLAN boundary.
- **CASE F** — model asks a genuine structured semantic question → the
  TUI renders it with choices → answer returned and work continues (the
  follow-up turn quotes the answer).
- **CASE G** — Goal enters waiting for a user question → answer → Goal
  resumes and completes.
- **CASE H** — `/tasks` reflects orchestration progress: delegate two
  children; `/tasks` shows the child rows moving pending → active →
  completed with counts agreeing with `/agents`.
- **CASE I** — a dependency-blocked child row shows `blocked` in `/tasks`
  while its upstream runs.
- **CASE J** — `/status`, `/doctor`, `/permissions`, and `/tasks` agree
  with canonical state (mode, counts, pending question).
- **CASE K** — UI-ready snapshots update during the same session with no
  model-token usage (all rendering surfaces are host-side).
- **CASE L** — session shutdown while a question is open: no orphaned
  dialog, no wedged state; the next session starts clean.

## Verification

- Test suites added:
  - `test/aira/interaction/manager.test.ts` (11 tests) — lifecycle,
    single-pending, headless unavailable, abort/timeout/dispose truth,
    supersede, bounded snapshots, goal notifications.
  - `test/aira/interaction/host-integration.test.ts` (13 tests) — the
    full Phase 11 surface through a real AgentSession: manager arming,
    gate behavior (CASE A/B/E), PLAN keep of ask_user/tasks, ask_user
    through the model tool, goal waiting kinds + answer resume + cancel
    semantics, permission-waiting goal, tasks tool + orchestration
    projection, /doctor + /status agreement, shutdown-with-pending.
  - `test/aira/permissions/policy.test.ts` (16 tests) — PLAN absolute
    across modes, mode tables, rule precedence, wildcards, risk markers,
    strict/yolo/permissive semantics, unknown capability.
  - `test/aira/permissions/rules-store.test.ts` (7 tests) — persistence
    round-trip, corrupt/oversized/versioned fail-closed, no project read
    path.
  - `test/aira/permissions/controller.test.ts` (11 tests) — gate
    allow/ask/deny, allow-once consumption, session/persistent exact
    approvals, headless denial, cancel-as-denial, child gating, PLAN
    absolute, snapshots.
  - `test/aira/tasks/manager.test.ts` (9 tests) — transitions, derived
    blocked, self/unknown deps, child projection + immutability, child
    failure/dependency phases, session isolation, bounds.
  - `test/aira/tasks/model-tool.test.ts` (4 tests) — ask_user outcome
    rendering (answered/cancelled/unavailable) + tasks tool actions.
    Also updated modes/capabilities/plan-readonly/intelligence/doctor/
    browser host tests for the new default tools and Phase 11 behavior.
- Full repo: `./test.sh` green (all packages).
- `npm run check` green (biome zero warnings, tsgo clean, lock/shrinkwrap
  checks pass).
- Phase 11 totals: 71 new tests; the entire `test/aira` tree: 574 tests
  passing.

Known baseline/environmental notes: none observed — the pre-Phase-11
suites (Phase 6-10) pass unchanged except the deliberate Phase 11
behavior updates listed above.

## Development record

1. `aa56155fa` — feat(aira): native interaction & control layer —
   permissions, Q&A, task graph (core implementation + host wiring +
   tests; 574 aira tests; npm run check clean).
2. `9f6d3666c` — docs: Phase 11 architecture, roadmap renumber
   (compaction moves to Phase 13), UI backlog B-006, ADR-030, changelog,
   phases report; plus the dogfood finding fix: `ask_user`/`tasks` added to
   the SDK default active tool list (`core/sdk.ts`) with regression
   updates in `default-tools-setting.test.ts` and the 3592/5109 suite
   regressions — the first TUI dogfood run showed the model claiming
   `ask_user` was not in its tools because the SDK list (which the TUI
   path uses) did not include the Phase 11 tools; this is recorded here as
   a real dogfood-found defect rather than hidden.

Final state: working tree clean; nothing pushed; no reference packages
loaded by Aira (isolated agent dirs used for dogfood); history not
rewritten.

## Stopping point / next phase

Phase 11 is complete. The UI overhaul (Workbench/footer rendering the
Phase 11 snapshots, UI_BACKLOG B-006) is explicitly NOT begun. The next
roadmap phase is Phase 12 — Policy, Hooks, and Trust (workspace
boundaries, trusted-project mechanism, project-local settings
restrictions, Aira hook contract with exact-hash trust, security tests).