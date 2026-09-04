# Phase 12.2 — Agent Inspector (native child browser + live transcript view)

> Status: ✅ done
> Predecessor: `PHASE_12_1_NATIVE_VIEWPORTS.md` (accepted), Phase 9 orchestration,
> Phase 11 permissions/tasks.
> Scope: orchestration observability from the native Aira TUI. No roadmap
> phase started; no orchestration redesign; no child autonomy, permissions,
> scheduling, Goal semantics, or task-ownership changes (one documented
> bounded-history growth bug fixed — see §5.4). Phase 13 not begun.

## 1. USER PROBLEM

Aira can spawn child agents, but a stuck-looking child was only observable at
the coarse level of `/agents` and the Workbench AGENTS panel:

```
AGENTS
● explore      2m17s
● implement      51s
○ review         queued
```

The user could not distinguish genuinely working, stuck on a tool, waiting on
capacity/dependency, permission denial, repeated tool failure, tool-budget
exhaustion, model/provider stall, or completed-but-not-reconciled. This phase
builds a native Agent Inspector: browse running/recent children and view each
child's live transcript/event stream — read-only, zero model tokens.

## 2. REFERENCE STUDY (required first; read-only, sources not modified)

Four extracted reference extensions under `~/proj/aira-reference/extensions/`
were studied from actual source (not README claims). Findings classified
ADOPT / ADAPT / DEFER / REJECT.

### 2.1 @gotgenes/pi-subagents (`src/ui/session-navigator.ts`,
`transcript-content.ts`, `session-navigation.ts`)

- Read-only TRANSCRIPT OVERLAY for a picked subagent: center overlay, own
  scroll state (`scrollOffset` + `autoScroll` = follow-while-at-bottom),
  `Esc`/`q` closes, **unsubscribes on close/dispose** — a clean
  subscription-lifecycle model.
- `TranscriptContent` renders settled history as cached blocks (per width),
  updates the in-flight assistant component per delta, pairs tool results to
  their call block via a pending map; the agent core keeps in-flight messages
  outside the message array, so settled history is never rewritten.
- `TranscriptSource` seam: `live` (in-memory record) vs `fileSnapshotSource`
  (persisted session file after retention release) — the same renderer serves
  both.
- ADOPT: read-only viewer with own scroll state; direct Esc close; unsubscribe
  on dispose; follow-while-at-bottom semantics; width-cached rendering.
- ADAPT: Aira mounts the viewer in the native conversation viewport (no
  foreign overlay); keys go through the native `tui.select.*` keybinding
  architecture instead of hardcoded `matchesKey` strings.
- DEFER: file-snapshot transcript sourcing (no transcript persistence this
  pass — §12).
- REJECT: nothing here; architecture confirmed.

### 2.2 @primp9053/pi-subagent (`index.ts`, whole extension)

- In-memory `Map<string, SubAgent>` registry; per-sub `log: LogEntry[]`
  captured via `session.subscribe` (turn_start, tool_execution_start/end,
  message_update assistant text, agent_end, message_end errors) —
  **unbounded** log arrays.
- Display: `fmtLog` rendered as a custom chat message; while streaming, a
  ≤10-line widget above the editor; `activeViewId` module-level state switches
  which sub's log is shown (alt+s cycles). Cleanup on cancel +
  `session_shutdown` (abort → unsubscribe → dispose → clear map).
- ADAPT: Aira's per-run event BUFFERS with hard bounds are the same shape the
  reference lacks (count ring + char budget); structured events instead of
  preformatted `kind + text` strings; the viewer is a native viewport, never
  injected into the root transcript.
- REJECT: unbounded logs; injecting child transcripts into the root chat;
  module-level singleton registry (Aira keeps a session-owned manager).
- ADOPT: subscribe-based capture; registry + active-view id; session-shutdown
  cleanup.

### 2.3 @nklisch/pi-subagents (`src/index.ts`, `src/ui/session-navigator.ts`)

- Superset of gotgenes: ConcurrencyLimiter, retained metadata, tool APIs
  (get_subagent_result / list / resume / steer / stop / query_session).
- The navigator overlay adds literal `/` search (`querySession`), a tool-only
  Tab filter, match marks (n / Shift+n), a bounded match list, and a 100ms
  runtime ticker for live elapsed while viewing a running agent.
- ADOPT: bounded match list; the runtime ticker concept (Aira: 1s unref'd
  ticker — low-cost UI clock).
- DEFER: transcript search/filtering — explicitly out of scope for v1 (§19);
  resume/steer tooling — steering is deferred by design (§19).
- REJECT: none.

### 2.4 pi-subagentura (`src/rehydrate.ts`, `src/artifact.ts`,
`src/interactive-supervisor-ui.ts`, tmux/zellij multiplexers)

- Persists interactive subagent state to `<cwd>/.pi/subagentura-state.json`;
  on session_start it REHYDRATES: reconstructs each state, sets status via the
  persisted lifecycle fold PLUS pane liveness, skips states owned by other
  parent sessions, honors failed tombstones with TTL, reconciles delivery
  receipts. Idempotent; `isPaneAlive` never trusts a persisted "running".
- Defers nothing about tmux (we are NOT implementing tmux/zellij panes).
- ADOPT: status reconciliation truth — never show a child as running unless
  the live runtime says so (§12); lifecycle-metadata retention thoughts.
- REJECT: disk persistence of full state/transcripts for this pass (Aira
  orchestration is session-scoped; §12 documents truthful resume semantics).

## 3. CURRENT ORCHESTRATION CHARACTERIZATION (as studied before changes)

1. **What child event info exists today**: bounded run records
   (`AiraChildRun`: status/phase/error category+message/result/tokenUsage),
   canonical snapshot (`state.orchestration`), scheduler phases
   (`waiting-dependency`, `waiting-capacity`, `running`, `settled`),
   deterministic child permission gate (`gateForChild`: ASK→DENY, no prompts).
2. **Are child model/tool events discarded after projection?** Yes. The child
   runner (`runAiraChild`) only awaited `stream.result()`; the Pi
   `AssistantMessageEventStream` event queue (text/thinking/tool deltas) was
   never consumed — events died with the stream.
3. **Subscription seam?** Only snapshot-level `manager.subscribe()`; no
   per-child event seam.
4. **Safe bounded retention**: manager history capped at 64 runs; snapshot
   caps 12/8/6; envelope text bounds existing. A per-run event ring with
   count + char budgets fits these conventions.
5. **Waiting/failure reasons**: `phase` explains waiting; `error.category+message`
   explains failures — but tool-budget exhaustion mapped to generic `driver`.
6. **Child permissions**: Phase 11 contract intact — children never prompt.
   The gate resolves ASK→DENY with a truthful reason that becomes an error
   tool result; children have no interaction tools. Nested interactive storms
   are impossible by construction (§10).
7. **Cancellation/shutdown**: per-run + per-batch AbortSignals propagate into
   the child stream; dispose aborts everything; runs settle truthfully.
8. **Completed children inspectable**: yes, in the manager's bounded in-memory
   history (64) — but nothing in the TUI showed them beyond coarse rows.

## 4. ARCHITECTURE

Full child transcripts NEVER enter `AiraSessionState` (ADR-005: bounded,
token-free, UI-ready). The inspector follows the preferred shape:

```
AiraOrchestrationManager
        │
        ├── canonical bounded child snapshot  → state.orchestration (unchanged)
        │
        └── child event/transcript buffers (events.ts, per-run, bounded)
                  │
                  ├── events(runId)            read-only query (affordance copy)
                  ├── subscribeEvents(runId)   live tail (unsubscribe on close)
                  └──────┬─────────────────────
                         ▼
              Agent Inspector UI (interactive mode only)
              selectedConversation = { kind: "root" } | { kind: "child", id }
```

- The manager stays the single canonical owner of orchestration truth; the
  buffers are orchestration-owned side state, evicted with run history.
- The TUI owns only UI selection state (`view: "closed" | "browser" |
  { runId }`) — never engineering state.
- The inspector consumes zero model tokens: opening, listing, switching,
  scrolling, and live updates derive from run records, the snapshot, and the
  event buffers only (§16).

## 5. CHILD EVENT / TRANSCRIPT MODEL

Structured events (discriminated union, `orchestration/events.ts`) — never
preformatted strings:

- `text` / `thinking` — assistant blocks (accumulated from Pi
  `text_delta`/`text_end`, `thinking_delta`/`thinking_end`; ONE event per
  completed block, so buffer growth is proportional to model blocks, not
  tokens).
- `tool_call` — name + bounded args summary (path/command/pattern).
- `tool_result` — isError + bounded summary + bounded detail.
- `permission` — a root-policy denial blocked this tool (tool + reason).
- `status` — lifecycle transitions (pending → running → settled).
- `failure` — category + message (manager-emitted).
- `completion` — completed/failed + bounded summary (manager-emitted).

Bounds (protect memory; Aira bounded-state conventions):

- `MAX_CHILD_EVENTS_PER_RUN = 400` (ring, oldest evicted).
- `MAX_CHILD_EVENT_TOTAL_CHARS = 100_000` per run (oldest evicted under the
  budget; the newest event always survives).
- Per-event caps: text/thinking 600 chars, tool args 400, result summary 200,
  result detail 600. Enforced by the runner sink `boundChildEventText`.

Capture is a pure side-channel: `consumeStreamEvents` drains the stream's
async iterator while `stream.result()` resolves independently (the EventStream
resolves its final result separately from the iteration queue, verified
against the faux provider). A capture failure can never break the run.

### 5.4 Real bug found and fixed: unbounded manager history growth

The manager's run-history eviction sorted candidates with
`settledAt ?? 0` — the just-created PENDING run sorted FIRST, hit the
`evict !== run` guard, and was skipped; under sequential awaited dispatches
the map grew past `MAX_MANAGER_RUN_HISTORY` without evicting (the snapshot
caps masked it; the 64-run cap is also the inspector's retention bound).
Fixed by sorting pending/running runs LAST (`Number.MAX_SAFE_INTEGER`) so the
oldest settled run is evicted. Regression test:
`run history eviction also releases the evicted run's event buffer`.

## 6. STATUS / WAIT REASONS

Truthful taxonomy reused from Phase 9 (nothing fabricated):

- running (with derived last-activity: `thinking` | `tool` | `permission` from
  the buffered events — `childActivityOf`),
- waiting-capacity / waiting-dependency (existing `pending` phases),
- completed / failed / cancelled / timed-out / rejected (existing statuses),
- tool-budget-exceeded — NEW failure category: the runner's
  `"child exceeded its tool budget"` driver error previously surfaced as a
  generic `driver`; it now maps to `tool-budget-exceeded` in
  `categorizeDriverError` and appears in the browser, transcript, snapshot
  failures, and `/agents`.

No `waiting-permission` state exists: Phase 11 makes child ASK deterministic
(deny) — a child never waits on an invisible prompt, so such a state would be
a fabrication (§10).

## 7. AGENT BROWSER

- Entry: Left Arrow on an EMPTY composer with the cursor at the very start
  (`CustomEditor` checks the native `tui.editor.cursorLeft` keybinding — never
  a raw escape sequence — plus the new `Editor.atEmptyStart()`), root
  conversation selected, and at least one inspectable child. Everywhere else
  the editor behaves exactly as before (tests: non-empty text, cursor
  movement, delete-forward).
- Content: header (`AGENTS` + `N running · N queued`), up to 14 rows ordered
  running → waiting → settled-most-recent, each with role glyph, bounded task
  summary (64 chars), truthful state/activity (`running · tool`), elapsed
  (running live / settled duration; never a misleading 0s for waiting rows),
  and the failure category/reason on failed rows. No model prompts, no hidden
  system prompts, no secrets.
- Keys: Up/Down (`tui.select.up/down`), Enter (`tui.select.confirm`) views the
  selected child, Esc (`tui.select.cancel`) closes straight to the root
  conversation. Left/close conventions match the existing selector behavior.
- Grouping: active (running, then waiting) first, queued next, failed/
  completed later — no extra UI complexity, bounded rows.

## 8. CHILD TRANSCRIPT VIEW

- The LEFT conversation viewport shows the child's event stream; the Workbench
  pane keeps rendering the ROOT session's live canonical state.
- Header makes the view unmistakable: `AGENT · EXPLORE` + task line + status
  line (`running · tool · 1m42s`) — `CONVERSATION` never shows while
  inspecting; the footer adds a compact `VIEW explore` rail segment when room
  allows.
- Rendering reuses the Aira compact tool language (`buildCompactRow`):
  `● read path` (in flight) flips to `✓ read path`; failures show
  `✕ bash npm run check` plus a bounded error line; permission denials show a
  warning row with the policy reason. Thinking blocks render in the thinking
  color; full tool outputs are never dumped by default.
- Completion/failure appears in place (the view is live; Esc is the only
  required input).
- READ-ONLY v1: the composer is replaced by a hint strip
  (`view-only · esc return to conversation`) — no input path into a child
  exists. No steering, no typing into the child (§19).

## 9. SCROLLING / FOLLOW (reused Phase 12.1 engine, no new engine)

- Each inspector view owns its own `ScrollView` behind the shared conversation
  pane slot (the host swaps the mounted layout node via
  `swapConversationViewport`): root conversation ScrollView, browser
  ScrollView, child ScrollView.
- Consequence: the root conversation's scroll position and follow state are
  preserved BY CONSTRUCTION (never modified while inspecting); returning is a
  slot swap, not a save/restore dance.
- Child transcript: follow-at-bottom, unread indicator (existing
  `↓ N new lines` component reads the ACTIVE viewport), PageUp/PageDown/
  Home/End/line scroll via the renderer's keyboard scroll target, wheel over
  the transcript, stop-follow-on-upward-scroll, no yank on new output — all
  existing ScrollView semantics, verified by tests that simulate the layout
  pass.
- Each view's UI-local scroll state is bounded (one ScrollView per view).

## 10. PERMISSION FINDINGS (no redesign; Phase 11 verified)

- The Phase 11 contract remains true in current code: root owns interactive
  prompts; children never create nested dialogs; child ASK resolves
  deterministically (`AiraPermissionController.gateForChild`: ASK → DENY with
  a truthful reason appended — "children cannot prompt for permission; approve
  at the root or switch permission mode"). Children have no interaction tools
  (`buildAiraChildToolSet`), so there is no code path that waits on a prompt.
- No hang exists; no reproduction needed — the invariant is proven by the
  controller seam and covered by existing Phase 11 tests plus new runner
  capture tests (permission events carry the denial; blocked calls produce no
  fabricated tool_result).
- The inspector EXPOSES the outcome: `permission` events render as warning
  rows with the denial reason (e.g. `permission: bash: permission denied — ...
  children cannot prompt ...`), and browser rows show the resulting child
  behavior truthfully.

## 11. WORKBENCH INTEGRATION

- The AGENTS panel (pure projection) marks the child whose transcript is
  viewed with a leading copper `›` — explicitly documented as "transcript
  currently being viewed", NOT selected-for-cancellation/owner/priority. The
  inspected id travels as UI state through `WorkbenchProjectionInput.
  inspectedRunId` (projection stays pure; canonical state untouched).
- Workbench remains live ROOT state while inspecting (unchanged seam).

## 12. RESUME / RETENTION (truthful semantics)

- Orchestration is session-scoped and in-memory: run records, results, and
  the new event buffers never persist. After `/resume`, no children exist and
  nothing shows as running — state reports idle truthfully (the canonical
  snapshot and `/agents` derive from the manager, which starts empty).
- Retained history (≤ 64 runs, bounded) lives only for the life of the
  session. Buffers are evicted with their runs; disposal clears buffers and
  all subscriptions.
- Full-transcript persistence is deliberately NOT added (reference studies
  make disk snapshots attractive, but this pass's contract is in-memory
  live/recent inspection; a bounded persistence case can be argued later).

## 13. HEADLESS / SDK / RPC

- Everything is interactive-mode UI code + an optional orchestration seam.
  `events()`/`subscribeEvents()` are additive on the manager handle; SDK/RPC
  behavior is unchanged. `test/aira/orchestration/` and the suite's
  headless tests pass unchanged.

## 14. TOKEN / CONTEXT COST — ZERO

- Opening, listing, scrolling, switching, and live-updating the inspector
  make ZERO provider calls and add ZERO tokens: no model summarization, no
  injected inspector state, no synthetic messages. Enforced by test
  (`viewing consumes zero model calls`) and by construction (the UI reads
  only manager state; `schedule()` is never touched by the inspector).
- Recorded here for the later ambient-context audit (§17). The child event
  buffers are never fed back into any model context.

## 15. PERFORMANCE / MEMORY

- 1 / several / long-running children: per-run rings (400 events / 100k chars)
  bound memory; browser caps at 14 rows; transcript renders at most the ring.
- Heavy tool output: bounded summaries; full outputs never dumped.
- Rapid live output: one event per completed model block (not per token);
  per-width render cache keyed by version; snapshot publish stays on status
  transitions only (per-event subscribers only).
- Switching repeatedly: one per-run subscription at a time; torn down on
  switch/close/dispose; no leaks (tested).
- Completed/failed children: retained within bounded history and inspectable.
- No rerender storms: strong design (publish unchanged), retested via
  render-request assertions in the component tests.

## 16. TESTS

Added: `test/aira/orchestration/events.test.ts` (ring/budget/eviction/
activity), runner capture tests (text/thinking/tools/permission/bounds),
manager seam tests (buffer recording, live subscription + unsubscribe,
activity derivation, tool-budget category, dispose cleanup, eviction release),
and `test/aira/agent-inspector.test.ts` (browser listing incl. queued/waiting/
failed/tool-budget, Enter selection, Esc direct-to-root, stale-id degrade,
transcript header/role/task, live thinking/tool/result/failure/completion
rendering, no-composer-path, left-arrow entry + non-empty-composer safety,
root-scroll survival, child follow/no-yank, Workbench `›` marker, zero model
calls, subscription switch hygiene, narrow terminals). Existing suite green
(`./test.sh`).

## 17. FOLLOW-UP — RECORDED, NOT IMPLEMENTED

Observed outside this pass: in BUILD/PLAN/REVIEW mode the host enforcement
knows the mode, but the model does not always know its effective mode — in
PLAN this causes wasted attempts at mutation tools/writes and sometimes
delegating implement/write work to a child. NOT solved here (does not block
the Agent Inspector). Recorded in `UI_BACKLOG.md` as:

> "Model runtime mode awareness: inject the smallest invisible backend-side
> effective-mode/control hint so the model knows BUILD/PLAN/REVIEW without
> exposing it in the visible composer or adding unnecessary context."

A later context-cost audit should measure ambient token overhead from: mode
awareness, project context, Goal, browser, verification, tasks, orchestration,
and other injected runtime context — Agent Inspector itself is zero-token.

## 18. DOGFOOD (real built binary)

Run with the built binary in tmux per repo procedure. CASE A: two children
dispatched; Left on empty composer opens the browser with both rows, truthful
state/role/task/elapsed. CASE B: entering a running child shows live
reasoning/tool activity with no token cost from the viewer. CASE C: child
output scrolls independently; Workbench fixed; root position preserved on
return. CASE D: Esc from child view returns directly to the root conversation.
CASE E: deterministic child failure shows category in the browser and useful
last activity in the transcript. CASE F: hitting the child tool budget shows
`tool-budget-exceeded` (real occurrence during this phase's reference-study
delegations: three explore children exceeded their budget and previously
would have looked like an opaque driver error). CASE G: child attempts an
ASK-worthy action — policy resolves deterministically (deny, truthfully
explained in the transcript), no invisible dialog, no hang. CASE H: >
maxConcurrency leaves distinguishably queued children. CASE I: Workbench stays
root canonical state with the `›` marker on the inspected child. CASE J:
opening/switching/scrolling repeatedly makes no provider calls.

## 19. DEFERRED / OUT OF SCOPE (v1)

- Steering: typing into a child, sending messages, taking over, nested
  delegation, child permission approval, child-specific composer.
- Transcript search/filtering (nklisch `/` + tools filter) — revisit after
  dogfood.
- Persisted transcript snapshots (gotgenes fileSnapshotSource).
- Per-child interactive permission prompts (never — Phase 11 contract).

## 20. DEVELOPMENT RECORD

- Commits (local only; nothing pushed):
  1. `feat(aira): orchestration-owned child event buffers for the Agent
     Inspector` — events.ts, runner side-channel capture, manager seam,
     tool-budget-exceeded category, history-eviction growth fix.
  2. `feat(aira): Agent Inspector TUI — browser, child transcript view,
     per-view viewports` — entry behavior, browser, transcript, controller,
     workbench/footer markers, Editor.atEmptyStart, tests.
- Reference trees untouched; working tree clean at completion.