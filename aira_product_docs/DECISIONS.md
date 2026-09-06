# Aira Architecture Decisions

This file records foundational decisions so future development sessions do not casually reverse them.

Format:

```text
ADR-NNN — Title
Status
Decision
Rationale
Consequences
```

---

## ADR-001 — Build Aira as a Pi-derived standalone product

**Status:** Accepted

### Decision

Aira will be developed from Pi's source code as its own product rather than implemented as a large coordinating Pi extension.

### Rationale

Core harness concerns—modes, keybindings, session state, tool routing, permissions, compaction, orchestration, and UI—belong at host level. Implementing them through extension interception would create unnecessary boundaries and conflicts.

### Consequences

Aira must maintain an upstream-sync strategy and keep native modifications isolated.

---

## ADR-002 — Preserve Pi compatibility

**Status:** Accepted

### Decision

Aira will preserve Pi extensions, skills, themes, package syntax, and relevant APIs wherever practical.

### Rationale

The Pi ecosystem is valuable and avoids rebuilding every specialist capability.

### Consequences

Compatibility requires explicit tests and adapters. Compatibility does not require identical Aira UX.

---

## ADR-003 — Use `aira` and `~/.aira/` exclusively as canonical product surfaces

**Status:** Accepted

### Decision

The canonical executable is `aira`. The canonical home is `~/.aira/`.

### Rationale

Aira is a complete product and should not present itself as a configuration layer inside Pi.

### Consequences

Pi resources may be imported/migrated, but normal operation must not depend on `~/.pi/`.

---

## ADR-004 — Keep Aira code isolated from upstream-derived code

**Status:** Accepted

### Decision

Aira-specific behavior should live behind narrow host integration seams and dedicated modules wherever practical.

### Rationale

This reduces upstream merge conflicts and keeps architectural ownership clear.

### Consequences

Some duplication or adapter code is acceptable if it prevents invasive upstream modifications.

---

## ADR-005 — Aira owns one canonical session state

**Status:** Accepted

### Decision

Modes, objectives, plans, task graphs, processes, supervision, and verification state have one Aira-owned source of truth.

### Rationale

Independent extensions owning overlapping state leads to race conditions and incoherent UX.

### Consequences

Compatibility integrations must project into or observe Aira state rather than creating competing state.

---

## ADR-006 — Native BUILD / PLAN / REVIEW modes

**Status:** Accepted

### Decision

Aira exposes three primary interaction modes and cycles them with `Shift+Tab`.

```text
BUILD → PLAN → REVIEW → BUILD
```

### Rationale

Mode switching is frequent enough to deserve native UX rather than slash commands.

### Consequences

Pi's thinking/effort shortcut may move to `Ctrl+Shift+E`. PLAN must enforce read-only behavior at host/policy level.

---

## ADR-007 — Event- and intent-driven operation is primary

**Status:** Accepted

### Decision

Routine capabilities should activate from task intent, project state, lifecycle events, edits, diagnostics, and runtime evidence.

### Rationale

A complete harness should not require the user to manually orchestrate internal tools.

### Consequences

Slash commands remain for explicit control, diagnostics, and recovery.

---

## ADR-008 — Scale orchestration with task complexity

**Status:** Accepted

### Decision

Aira will not automatically create plans, goals, or subagents for every request.

### Rationale

Excessive orchestration adds latency, cost, context, and failure modes.

### Consequences

A task classifier/heuristic must choose between direct, moderate, complex, and durable workflows.

---

## ADR-009 — Keep specialist engines replaceable

**Status:** Accepted

### Decision

Mature specialist machinery may initially remain external/internal dependencies behind Aira capability providers.

Initial candidates include Lens, Code Intelligence, web research, and a browser engine.

### Rationale

Aira should not spend months reproducing mature LSP/indexing/browser machinery merely for monolithic purity.

### Consequences

Aira owns behavior and UX; engines own specialist implementation. Providers may later be vendored/replaced based on evidence.

---

## ADR-010 — Browser defaults to isolation

**Status:** Accepted

### Decision

Aira's default browser automation uses an isolated Aira profile.

### Rationale

Development verification rarely needs access to the maintainer's personal signed-in browser state.

### Consequences

Personal browser/profile control requires explicit authorization/mode.

---

## ADR-011 — Verification is independent

**Status:** Accepted

### Decision

Non-trivial completion should be independently verified using diagnostics, tests/runtime evidence, and fresh reasoning.

### Rationale

The same agent that implemented a change should not be the sole authority that it is correct.

### Consequences

Verifier outcomes are PASS, FAIL, or INCONCLUSIVE. Inconclusive does not mean pass.

---

## ADR-012 — Keep the permanent agent taxonomy small

**Status:** Accepted

### Decision

Initial permanent roles are Scout, Researcher, and Verifier. The root agent may act as Builder.

### Rationale

Dozens of permanent roles create conceptual and prompt overhead. Specialized behavior can be generated from a smaller set of primitives.

### Consequences

New permanent roles require evidence that they represent a genuinely distinct recurring responsibility.

---

## ADR-013 — `engineering-loop` is excluded

**Status:** Accepted

### Decision

The existing `engineering-loop` project is not a dependency, foundation, or assumed source for Aira.

### Rationale

It is being set aside for further testing. Aira's architecture should stand independently.

### Consequences

Any future reuse must be proposed and evaluated explicitly.

---

## ADR-014 — Develop with frequent local Git commits

**Status:** Accepted

### Decision

Aira development must make local Git commits at coherent, tested checkpoints throughout implementation.

### Rationale

A long-lived host fork needs reliable rollback points and understandable change history. Large uncommitted phases are unnecessarily risky.

### Consequences

Agents working on Aira should commit locally after meaningful working milestones. **They must not push to GitHub unless explicitly instructed.** Multiple local commits may be pushed together when the maintainer is ready.

---

## ADR-015 — Upstream Pi remains a first-class remote

**Status:** Accepted

### Decision

The Aira repository should retain the official Pi repository as `upstream`, with Aira's repository as `origin`.

### Rationale

Aira should continue benefiting from relevant Pi runtime improvements.

### Consequences

Each Aira release should record its Pi base commit/version, and upstream syncs should occur from a clean committed state.

---

## ADR-016 — Do not build durable autonomy first

**Status:** Accepted

### Decision

Aira will build host identity, modes, project awareness, intelligence, execution, browser capability, and verification before long-running autonomous goals.

### Rationale

Autonomy built before stable state/execution primitives becomes fragile orchestration layered over unstable foundations.

### Consequences

The roadmap intentionally delays task swarms and durable goal loops.

---

## ADR-019 — Aira owns its home and product identity; Pi compatibility is preserved as an isolated migration surface

**Status:** Accepted

### Decision

- The canonical executable is `aira`; the npm package exposes both `aira` (canonical) and `pi` (compatibility alias) bin entries pointing at the same bundle.
- The canonical home is `~/.aira/` with the Pi-compatible internal layout preserved: `~/.aira/agent/` holds settings, sessions, cache (models store), extensions, skills, themes, prompts, agents, tools, keybindings, trust, and logs. Project-local resources use `<cwd>/.aira/`.
- Aira versions itself independently (`Aira 0.1.0`) while the packaged `PACKAGE_NAME`/`VERSION` remain the Pi-derived identity for compatibility and upstream syncing. `--version` and `/status` surface the Aira identity.
- Environment overrides are `AIRA_CODING_AGENT_DIR` / `AIRA_CODING_AGENT_SESSION_DIR`; the legacy `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` remain honored as compatibility aliases.
- Pi migration is optional and explicit via `aira import --pi` (conservative: no credentials unless `--include-secrets`, no overwrites unless `--force`, `--dry-run` supported). Normal operation never depends on `~/.pi`.

### Rationale

ADR-001 and ADR-003 establish Aira as a standalone Pi-derived product. Pi's `piConfig` is the intended fork seam: setting `name`/`configDir` re-points every centralized path helper under the Aira home with a minimal, upstream-syncable diff. Internal `agent/` layout and package machinery stay intact so upstream Pi merges remain easy and Pi tooling/extensions keep working.

### Consequences

- Pi homes are imported, not read: a clean machine with `aira` creates only `~/.aira/`.
- Existing Pi installations that want continuity run `aira import --pi` once; project-local `.pi/` content is not automatically migrated (documented limitation; `--session-dir` or manual copy remains available).
- Pi's official first-time setup is gated to the official Pi distribution; Aira skips it (its own onboarding arrives later).
- Pi self-update/installer machinery (`pi update`, managed installs) remains Pi-oriented until Aira distribution exists; Aira update/packaging is a later phase.

## ADR-024 — Execution is a session-owned runtime service; process ownership is per-session-instance with explicit lifecycle semantics

**Status:** Accepted

### Decision

- Aira execution is a native harness service (`src/aira/execution/`): one `AiraExecutionManager` per `AgentSession` instance, created at session construction and disposed with it. The canonical session state publishes a bounded snapshot (`state.execution`: process table + recent results, capped, no log contents), never a competing process truth (ADR-005).
- **Ownership is per-session-instance.** Every `ProcessRecord` carries `ownerSessionId` and belongs to exactly one manager. A session's dispose() terminates ONLY its own manager's processes (graceful → grace period → forced group/tree kill). Two live sessions over the same session file (the legal overlapping lifecycle, ADR-018) therefore cannot kill each other's processes: a stale session's disposal kills only what the stale session launched. Stale canonical-state disposal remains a no-op (ADR-018).
- **Reuse is conservative and same-manager-only.** `reuse: "reuse"` returns the manager's own still-running `dev` background process when cwd+command match exactly; `reuse: "restart"` terminates a matching one first. Arbitrary OS processes are never adopted; cross-session adoption is out of scope until evidence demands it.
- **Lifecycle semantics are explicit**: foreground waits for completion (optional timeout, AbortSignal cancels); background returns immediately with a managed id (optional timeout bounds it); `auto` stays foreground until the auto-background threshold (default 20s) with the process still alive, then reclassifies to managed background (documented contract: the runtime signal is "still alive past threshold", not a command-name heuristic). Background/timeout/cancelled/session-end termination is graceful first (SIGTERM to the process group; taskkill without /F on Windows), then forced (SIGKILL to the group; taskkill /F /T), including a group-survivor probe so a shell whose child ignored SIGTERM gets reaped. Log buffers are capped per stream (128 KiB tail, truncation flagged); records are capped (oldest exited evicted; running processes never evicted); results carry bounded tails, never full logs. No durable process history across application restarts (Phase 6 scope).
- Managed pids are registered with the host's last-resort detached-child tracking so crash/shutdown paths can still reap them.

### Rationale

Phase 1 characterized overlapping session lifecycles (ADR-018); naive dispose-by-id cleanup would let a stale session kill a newer owner's processes. Per-instance managers make ownership structurally testable (the overlap suite runs two managers over one session id) and deterministic. The runtime signal for auto-backgrounding avoids fragile command-name heuristics. Force-after-grace with a survivor probe is required because a polite SIGTERM frequently kills only the shell while a descendant (e.g. a dev tool ignoring SIGTERM) survives holding the pipes.

### Consequences

- `AgentSession` owns the manager; model tools (`process_start/status/logs/stop`) bind to it; `/processes` lists it; dispose drives cleanup (ADR-005 preserved).
- Dev-server reuse is per-session by contract: resuming/replacing a session does not adopt another session's server; a later phase may define cross-session adoption explicitly.
- Termination of a managed process kills its whole spawned tree by contract (documented); processes that must outlive the session must not be launched through the runtime.
- `state.execution` is a snapshot only; logs and truth live in the manager, so `/processes` and tools always report live state rather than a stored copy.


## ADR-025 — Browser is a native Aira-owned runtime behind a replaceable provider boundary, with an isolated profile and strict state/context separation

**Status:** Accepted

### Decision

- Aira owns ONE native browser runtime (`src/aira/browser/`): activation, settings, eligibility, session/tab ownership, evidence selection, ambient-context injection, cleanup, and canonical state. One `AiraBrowserManager` per `AgentSession` instance, created at construction (lazy; never launches anything at startup) and disposed with it.
- Browser mechanics sit behind a replaceable provider boundary (`AiraBrowserProvider`: availability/open/observe/navigate/interact/evaluate/wait/screenshot/evidence/close/dispose). Plain data crosses the boundary; no Playwright/CDP objects leak into Aira. The Phase 7 implementation is an Aira-native CDP provider (zero new npm dependencies; Node >= 22 native WebSocket) that launches an isolated Chromium.
- **The default is an isolated, disposable profile.** Aira launches its own browser with a fresh profile under canonical cache paths (`~/.aira/agent/cache/browser/`); DevToolsActivePort on a random loopback port; headless by default. Aira NEVER attaches to the user's personal browser profile. Personal/existing-browser control is an explicit future opt-in mode only.
- Aira has zero runtime dependency on the installed stock-Pi browser extensions (`betterwright`, `pi-browser-harness`); they were studied as laboratory specimens only.
- Session/tab resources are Aira-owned and per-session-instance (ADR-024 pattern): dispose kills only Aira's own browser process (pid tracked for crash-path reaping); a stale/replaced session cannot close another session's browser.
- **Subsystem state ≠ model context.** The canonical snapshot (`state.browser`) is bounded, serializable, provider-independent, and token-free; ambient model context (`browser.context` off|auto|on) is a separate, budgeted, deduplicated selection. Disabling context never hides UI-visible state.
- `ProjectProfile` drives eligibility; Phase 6 execution remains the sole owner of dev processes; local URL discovery consumes Phase 6 evidence first (dev-process output), then framework conventions, never network scans.
- PLAN keeps browser observation + navigation (read-only surface) and blocks browser interaction/evaluation/verification/lifecycle via the semantic capability table (ADR-022 refinement: `observe | navigate | interact | lifecycle` operation kinds, no tool-name heuristics).
- Automatic verification (`browser.autoVerify`) is exactly ONE bounded pass per relevant edit (debounced, min-gap throttled, dev-server + URL + eligibility gated); no repair→verify loops.
- Structured semantic observation (accessibility tree, bounded, stable refs) is the preferred evidence; screenshots are opt-in, stored as path references only, and pruned. Console/network evidence is bounded, deduplicated (counts + top finding).

### Rationale

Browser verification is core product capability (ADR-010); the Phase 7 study of the installed reference implementations showed (a) token-inefficient DOM dumps are avoidable via compressed a11y-tree observation with stable refs, (b) attach-to-personal-Chrome is a safety boundary Aira must not default to, (c) a persistent daemon is unnecessary because the Aira session lifecycle already owns lifetime, and (d) bounded console/network failure evidence with dedupe is the actionable shape. The provider boundary keeps the option of a Playwright/cloud provider later without touching Aira. State/context separation is what makes the future Workbench a rendering exercise instead of an architectural retrofit.

### Consequences

- `browser_*` tools classify as `browser` with semantic operation kinds; PLAN availability and gate derive from the tables in capabilities.ts/modes.ts.
- `browser.enabled`, `browser.context`, `browser.autoVerify`, `browser.contextBudget` live in the canonical settings file through the host `SettingsManager` and the existing `/settings` surface.
- Auto-verify requires output-derived local URLs; convention guesses never drive automatic checks.
- Ref staleness is truthful: refs are invalidated on main-frame navigation and re-verified against the live document at action time (URL + connectedness); a stale ref never silently targets a different element.
- Browser absence degrades to normal coding behavior (availability `unavailable`, snapshot truthful, Aira always installs and runs without a browser).
- The future shared context broker (Repository/LSP/Execution/Browser → one selection layer) must keep subsystem state token-free and injectable; context.ts already emits content hashes and hard budgets with that seam in mind.

## ADR-026 — Independent verification is a native per-session service with a fresh-context verifier role, a canonical verdict contract, and freshness-based invalidation

**Status:** Accepted

### Decision

- Verification is a native harness service (`src/aira/verification/`): one `AiraVerificationManager` per `AgentSession` instance (ADR-024 ownership pattern), armed at construction, disposed with the session, publishing the canonical `AiraSessionState.verification` snapshot (ADR-005). It answers "did the implementation satisfy the user's request?" ABOVE the Phase 5/6/7 subsystems: it consumes their bounded provider-independent snapshots and never re-implements diagnostics/process/browser mechanics.
- **Independence boundary.** The verifier is a FRESH model context: its own system prompt (verifier role), a bounded evidence envelope, and a restricted read-only tool set (`read`, `grep`, `find`, `ls`; at most two rounds). The implementing agent's conversation is never included; the verifier can never run a shell, edit, or interact with the browser or network. Verification consumes evidence at request time; it never starts fresh test/browser runs in Phase 8 (that flows through Execution/Browser capability boundaries in later orchestration phases). The same configured model is reused by default; model selection is a resolver seam (`verifierRuntime`) so a dedicated/lower-cost model can be added without touching the manager.
- **Verdict contract.** Canonical outcomes are `PASS` / `FAIL` / `INCONCLUSIVE` only. Verdicts are requirement-driven (explicit + necessary-inferred requirements with per-requirement verified/unmet/unverifiable status), carry bounded findings, evidence items, missing-evidence list, scope assessment, and confidence. Hardening rules (maestro-inspired): a pass that lists unmet requirements is downgraded to FAIL; a pass with no concrete evidence list is downgraded to INCONCLUSIVE; malformed/missing verdicts are INCONCLUSIVE; verifier driver failures (model/auth/timeout/cancellation) surface as INCONCLUSIVE with an explicit `lastError`, never as PASS. INCONCLUSIVE never silently becomes PASS.
- **Completion boundary.** Automatic verification triggers at `agent_end` (the run-level completion event), not per tool call or per provider turn; the run scope spans all turns of one agent run. `verification.auto` = off | smart | always (default smart): smart verifies non-trivial engineering work (bug fixes, behavior changes, multi-file implementations, API/state-machine changes, browser/UI behavior, test-related work, refactors) and skips trivial work (docs, comments, one-line renames with clean diagnostics) without invoking the model; always verifies every meaningful implementation; off never auto-verifies but explicit `/verify` still works when `verification.enabled` is true.
- **Dedupe and freshness.** The change identity is a content hash over the change set (paths, statuses, added/deleted lines, mtimes). An unchanged revision with a current result is never reverified (explicit `/verify` also reuses it unless forced). A new relevant edit invalidates the prior result immediately; the change-set mtimes are drift-checked (50ms tolerance) on every snapshot refresh; a result whose change set moved is stale, never fresh, and a stale PASS is not completion evidence. If the change set moves while the verifier runs (completion fence), the just-produced result is published stale.
- **Verification is not lintage, not review-mode, and not a repair loop.** REVIEW mode makes explicit verification easy but is not itself a verdict; mode state and verification state stay separate. FAIL produces structured findings, but Phase 8 deliberately has no unlimited repair loop — a FAIL is a transition a later orchestrator consumes (repair → BUILD → new revision → verify again).
- **Token cost is configurable and separated from state.** `verification.enabled` (default true), `verification.auto` (default smart), `verification.contextBudget` (compact ≤ 6000 / balanced ≤ 10000 / expanded ≤ 16000 chars, default compact) live in the canonical settings file through the host `SettingsManager` and the `/settings` surface. The canonical snapshot is token-free; rendering it never invokes the model (state ≠ model execution). Envelope content is secret-redacted and framed as untrusted data.

### Rationale

ADR-011 commits Aira to verification independent from the implementing agent; the Phase 8 study of `pi-maestro-flow` (goal verifier: fresh verifier subprocess, structured verdict with pass/unmet/evidence, completion fence, failure budgets), `pi-lens` (freshness kernel: mtime-vs-reference with drift tolerance, stale demotion instead of deletion), and `pi-codeontime-code-intelligence` (diff review: parse unified diff, machine rules, required-test-path checks) showed the proven shapes worth adopting natively: fresh-context verification, requirement-driven verdicts, evidence bounding, revision dedupe, and explicit INCONCLUSIVE semantics. Aira's native equivalent of Maestro's explicit `goal complete` boundary is `agent_end` for runs in which implementation work happened; the dedupe hash replaces Maestro's per-goal in-flight fence for repeat-run protection. The verifier consumes canonical snapshots rather than raw LSP/CDP/ChildProcess internals so provider boundaries stay intact, and PLAN-safe semantics fall out of the read-only tool restriction plus the mode gate on automatic runs.

### Consequences

- `AgentSession` owns the manager; `/verify`, `/verify status`, `/doctor` (verifier check — reports configuration/health/verdict, never runs the model), and `/status` (restrained verification line) consume the canonical snapshot.
- `state.verification` is bounded and UI-ready: status (idle/preparing/running/passed/failed/inconclusive), currentResult, requirement counts, highest finding, missing evidence, stale flag, lastError, lastSkipReason.
- The future Context Broker seam (ADR-025 consequences) and future Workbench/footer render verification from the snapshot; a stale verdict renders as stale, not current.
- Automatic verification is strictly gated (settings × mode × work × revision); repeated unchanged completions do not spend verifier tokens.
- Adding a repair loop, durable goals, or multi-agent orchestration is a later phase (roadmap 9–10); the FAIL result is already the clean transition input for that orchestration.

## Adding decisions

When a future architectural choice materially changes one of these assumptions:

1. add a new ADR;
2. mark the superseded ADR appropriately rather than silently rewriting history;
3. explain why evidence changed the decision;
4. commit the decision with the implementation or immediately before it.

---

## ADR-017 — Core Aira commands are unnamespaced

**Status:** Accepted

### Decision

Aira's own fundamental host commands belong directly to the host command surface:

```text
/status
/doctor
/mode
/capabilities
/processes
/checkpoint
/rewind
```

not:

```text
/aira status
/aira doctor
/aira mode
```

Third-party and compatibility extensions keep their own namespaced commands (for example `/lens-health`), and Aira does not modify third-party command behavior.

### Rationale

Aira is the coding harness itself, derived from Pi — not a Pi extension. Namespacing Aira's own features under an `aira` prefix would present the host as an extension of itself. Phase 1 already implements `/status` under this convention.

### Consequences

Supersedes the `/aira ...` examples in AIRA_ARCHITECTURE.md §18 and README.md. Extension commands that collide with built-in host commands are detected and diagnosed by the host (existing `BUILTIN_SLASH_COMMANDS` conflict diagnostics cover `/status` automatically). The convention applies only to core Aira commands; extension namespaces remain unchanged.

---

## ADR-018 — Session-file overlap is a legal Pi host lifecycle; canonical state ownership transfers to the newest acquirer

**Status:** Accepted

### Decision

The Pi-derived host permits two live `AgentSession`s over the same session id: a session file may be resumed (`switchSession`) by one runtime while another runtime in the same process still holds it. Aira treats this overlapping lifecycle as legal host behavior.

Consequently, acquisition of `AiraSessionState` never fails on an existing active entry. Each `acquireAiraSessionState(sessionId, reason)` returns a fresh canonical state as an **ownership handle**, replacing the previous entry. Disposal is ownership-checked: `disposeAiraSessionState(sessionId, handle)` transitions the entry only when the caller's handle still matches the current registry entry. A stale owner disposing later is a no-op.

### Rationale

Evidence from the Phase 1 runtime characterization suite (`test/suite/agent-session-runtime.test.ts`) demonstrated the overlapping lifecycle in the real host: `AgentSessionRuntime.switchSession` creates a new session for a destination file while the source runtime — or another runtime in the same process — still owns the same file. The Phase 1 implementation initially threw on double-acquire, which broke this valid host behavior; an unowned dispose-by-id would meanwhile have let the stale owner kill the newer session's state. Ownership handles resolve both failure modes.

### Consequences

- One canonical state per session id at any time; ownership silently transfers to the newest acquirer (ADR-005 is preserved — transfer happens explicitly at the Aira bridge, not through competing state).
- A stale owner's disposal must never transition state; subsystems must not assume dispose-by-id semantics.
- Aira session release cannot be routed through pi-ai's anonymous session-resource cleanup registry (it has no ownership channel). Instead `AgentSession.dispose()` calls the Aira bridge directly with the stored handle.
- Resuming a session file currently open elsewhere therefore yields a fresh canonical state, not a resurrected one.

## ADR-020 — Native modes are host-enforced; PLAN is read-only at the tool-policy boundary

**Status:** Accepted

### Decision

- The interactive host exposes the native mode cycle BUILD → PLAN → REVIEW → BUILD owned by the canonical `AiraSessionState` (`state.mode`). Mode semantics (`cycleAiraMode`, `setAiraMode`, tool classification, display labels) live in a dedicated `src/aira/modes.ts` module; nothing else writes the mode.
- `app.mode.cycle` (default `Shift+Tab`) drives the mode cycle interactively, alongside the unnamespaced `/mode` command (ADR-017). It is added to the editor-global reserved set for extension-conflict diagnostics.
- The default thinking-cycle shortcut moves from `Shift+Tab` to `Ctrl+Shift+E`. User keybindings load from `~/.aira/agent/keybindings.json` and override defaults, so a user who bound the thinking cycle (or anything else) to `Shift+Tab` keeps it; the default move only changes behavior for users who never customized it.
- PLAN is genuinely read-only at host/tool-policy level, not a system-prompt suggestion: (1) `AgentSession.beforeToolCall` blocks every built-in mutating tool (`bash`, `powershell`, `edit`, `write`) in PLAN even if one is present in the registry; (2) entering PLAN restricts the active tool set to read-only tools (`read`, `grep`, `find`, `ls`) and remembers/restores the prior set; (3) the interactive user `!bash` escape hatch is refused in PLAN. Reading, search, inspection, and other safe operations remain usable.
- REVIEW establishes native state, a footer indicator, and inspection-oriented policy semantics but keeps its tool set (it is not the independent verifier; that is a later phase).
- The Phase 3 UI absorbs `pi-polished-ui` ideas (single clean always-visible mode surface, ANSI-safe truncation) as native host UI. Aira does not depend on the standalone `pi-polished-ui` extension.

### Rationale

ADR-006 commits Aira to native modes and a `Shift+Tab` cycle, and ADR-005 makes the canonical session state the single owner of mode. Genuine read-only must be enforced where tool execution happens (the host boundary), not only in the prompt, or the model could modify the workspace in PLAN. Keeping mode semantics in one module prevents a second mode owner and makes the enforcement boundary auditable. The thinking shortcut move is the documented expectation in ADR-006 and AIRA_ARCHITECTURE.md §5.

### Consequences

- A user who never customized the thinking cycle gets `Shift+Tab` for modes and `Ctrl+Shift+E` for thinking; a user who customized either keeps their binding (possible overlap is resolved by insertion order, matching Pi's existing editor behavior).
- Plan mode is a strict subset of tool capability now; the future planning engine (roadmap Phase 5) is deliberately absent — this phase establishes the mode and its enforcement boundary only.
- Extension tools are not classified as mutating by Aira (only the built-ins are), so an extension-registered mutation-capable tool could in principle run in PLAN. This is a documented Phase 3 limitation; a future phase can classify extension tools or gate them explicitly.

## ADR-021 — Project scope is derived from the nearest defensible root within home; canonical session state owns the project profile

**Status:** Accepted

### Decision

- Project awareness derives a bounded, evidence-based `ProjectProfile` (`src/aira/project/`) from repository signals — Git markers, manifests, build files, languages, frameworks, package managers, conventional test/build/dev commands, browser-relevance heuristics, deployment/CI hints — and stores it in the canonical `AiraSessionState.project` (ADR-005). No subsystem owns a competing project profile.
- Project scope is a safety boundary. Detection never treats the user's home directory — or any parent of it — as one giant project; the climb for a project root stops at the home boundary and prefers the **nearest** defensible root (a directory carrying a Git marker or a recognized manifest/build file).
- Detection is lightweight and synchronous: bounded top-level reads only, never a repository index or semantic model. Confidence (`none`/`low`/`medium`/`high`) reflects the strength and count of evidence (Git + distinct languages + deployment + browser relevance), not certainty.
- The project profile is surfaced through the existing native `/status` and `/doctor` surfaces only; no new slash command and no UI expansion.

### Rationale

The roadmap (Phase 4) requires Aira to understand the workspace before invoking expensive capabilities, while explicitly excluding repo indexing/semantic intelligence (Phase 5+). The home boundary prevents classifying an arbitrary home directory as one giant project, and "nearest defensible root" yields a stable, defensible project identity (e.g. a monorepo subpackage with its own manifest, or the enclosing Git root otherwise). Holding the profile in canonical state keeps every mode and future subsystem observing the same project and avoids a competing project-state owner.

### Consequences

- `AiraSessionState.project` changes from a placeholder `"unresolved"` string to `AiraProjectProfile | undefined` (undefined = not yet resolved by the host).
- Detection runs eagerly at `AgentSession` construction from the session cwd, so interactive, print, RPC, and SDK sessions all carry a profile.
- Confidence is deliberately conservative; a bare Git repo without manifests is `low`, and anything at or above the home boundary is `none`.
- This phase intentionally does not add browser/process/LSP/intelligence; those remain Phase 5+.

## ADR-022 — Native capability classification is the semantic contract for host policy; unknown capabilities stay PLAN-permissive

**Status:** Accepted

### Decision

- Aira classifies capabilities with a small semantic vocabulary: `read-only`, `diagnostic`, `mutating`, `process`, `network`, `browser`, and `unknown`. The built-in tools classify as read-only (`read`, `grep`, `find`, `ls`), mutating (`edit`, `write`), or process (`bash`, `powershell`); `diagnostic`, `network`, and `browser` are reserved for future native operations (intelligence tools, web research, browser automation).
- The PLAN read-only gate (`isAiraMutatingCapability`) derives from the classification: `mutating` + `process` are blocked. `isAiraCapabilityReadOnly` (read-only + diagnostic) is the wider "safe in a read-only context" predicate.
- Unknown/third-party capabilities are **never** flagged mutating, so existing Pi extension tools keep working in PLAN without adopting Aira metadata (documented extension of the ADR-020 limitation, now stated as a classification rule rather than an absence of logic).

### Rationale

ADR-020 records that PLAN's host enforcement cannot semantically classify arbitrary extension tools. Phase 5 introduces native intelligence operations that must interact with mode policy, so a semantic contract is needed instead of an ever-growing hard-coded tool-name list. The vocabulary is derived from actual host needs today; nothing larger (permissions framework, per-tool policies) is built in this phase.

### Consequences

- `modes.ts` delegates `isAiraMutatingTool` to the classification; `AIRA_MUTATING_TOOLS` stays as the auditable built-in set.
- Future native intelligence/model tools must classify read-only or diagnostic; mutating/process classification gates them in PLAN.
- Third-party extensions remain unclassified by Aira (documented, not silently assumed safe — the classification simply does not apply to them).

## ADR-023 — Aira intelligence is a native service: activation from the canonical project profile, bounded providers, ambient context, honest degradation

**Status:** Accepted

### Decision

- Intelligence is a host service owned by the session coordinator (`src/aira/intelligence/`), not a bag of model tools: the harness decides when intelligence activates (from `AiraSessionState.project`, ADR-021), which operations run (post-edit diagnostics, prompt-time context injection, mode-weighted emphasis), what evidence reaches the model (bounded context packs), and how failures degrade.
- Two native providers sit behind the provider surface: **repository** (bounded file-level index: languages, symbols, imports/imported-by, source/test counterparts, lexical discovery, git changed files; JSON cache under `~/.aira/agent/cache/` — never the workspace) and **live-code** (project-scoped, lazy, reused language servers for TypeScript/JavaScript, Python, Go, Rust, C/C++, C#; minimal JSON-RPC LSP client; post-edit diagnostics; warm-only navigation; idle eviction; crash cooldown).
- Persistence is JSON-under-the-Aira-home, **not SQLite**, for this phase. Evidence: the reference implementation's `better-sqlite3` native addon fails to build on the verified Node 25.9.0 / macOS arm64 baseline (no prebuilt binary; node-gyp fails against V8 headers) and Phase 5's file-level index has no query workload requiring SQL. Node 25 ships a zero-dependency built-in `node:sqlite` (FTS5-capable) if a later phase's graph genuinely needs SQL; storage stays behind the provider boundary so the choice stays replaceable.
- Ambient behavior: at `AgentSession` construction the coordinator arms (fire-and-forget); `prompt()` injects one bounded context message (project orientation once, live-code availability once, likely files from the lexical index, changed files, diagnostics excluding stale findings, REVIEW impact); after each successful edit/write tool execution the coordinator reindexes the path and requests LSP diagnostics (debounced); identical content is never re-injected. No intelligence operation mutates the workspace (caches live under the Aira home), so PLAN needs no special gate beyond what the host already enforces; the coordinator additionally skips post-edit diagnostic runs in PLAN.
- Mode weighting: BUILD gets the full funnel; PLAN is read-only and gets orientation + likely files + availability (+ diagnostics if present); REVIEW emphasizes diagnostics, changed files, impact (imported-by), and counterparts.
- Health: the coordinator publishes an `AiraIntelligenceStatus` snapshot into canonical state (`state.intelligence`); `/doctor` reports it (repository/live-code/findings/degraded). `/status` remains restrained (unchanged).
- Degradation is the default contract: no project → inactive; unsupported languages → no server; missing language server → plain search; crashed server → cooldown + respawn; failed scan/cache → partial index. Nothing in the intelligence service can throw into session startup or tool execution.

### Rationale

Phase 5 studied `pi-lens` and `pi-codeontime-code-intelligence` as laboratory references. The proven ideas worth adopting natively: lifecycle-driven activation, post-edit diagnostics, findings freshness (mtime vs collection time with an explicit indeterminate verdict), bounded lazy LSP lifecycle, working-set heuristics (changed files, counterparts, lexical discovery), and honest degradation. What was deliberately NOT adopted this phase: embeddings/semantic retrieval (lexical + structural + LSP evidence already serves the funnel; no network or model dependency may gate local understanding), big graph/entity machinery, chunking, file watchers, learnings, review agents, and the 35+ runner ecosystem. Those are deferred or rejected, documented in the Phase 5 report. The reference extensions remain installed specimens; Aira does not depend on either.

### Consequences

- `AiraSessionState.intelligence` is a new canonical snapshot field written only by the coordinator (ADR-005 preserved).
- `AgentSession` gains four narrow seams: arm at construction, context injection in `prompt()`, agent-event subscription (turns + tool executions), and provider disposal; `airaSessionState` getter added for tests/diagnostics.
- A later phase can replace either provider behind `providers/index.ts` without touching the coordinator, and can switch persistence to `node:sqlite` behind the cache module.
- Prompt-time cost is bounded: context building is synchronous over in-memory structures; LSP work happens only in the post-edit pipeline and warm navigation; the repository scan runs in the background at session start.

## ADR-027 — Orchestration is a root-owned native per-session service; children receive bounded explicit envelopes and capability-derived tool sets; PLAN read-only holds through orchestration

**Status:** Accepted

### Decision

- Orchestration is a native harness service (`src/aira/orchestration/`): one
  `AiraOrchestrationManager` per `AgentSession` instance (ADR-024 ownership
  pattern), armed at construction, disposed with the session, publishing the
  canonical `AiraSessionState.orchestration` snapshot (ADR-005). The root
  session owns scheduling, cancellation, canonical state, result aggregation,
  and final synthesis; children are run records, never session owners and
  never holders of competing task state.
- Children are FRESH-CONTEXT model invocations through the session's stream
  function (the Phase 8 verifier pattern), NOT subprocesses: an explicit
  bounded envelope (task, role, project root, ≤ 50 file paths, ≤ 8k chars
  context, mode, result contract) plus a mode-gated, capability-derived tool
  set. The parent conversation is never injected; no transcript cloning.
- Isolation rules: children never receive browser tools, orchestration tools
  (root-only delegation — children cannot spawn children), or
  unknown/extension tools; process-class children get only the managed
  execution tools bound to the root's execution manager (Phase 6 runtime
  reuse); the semantic capability tables (ADR-022) derive every child tool
  set — never tool-name string matching.
- PLAN holds through orchestration: mutation-capable roles (implement/test)
  are refused per-task at dispatch with a truthful reason, and every PLAN
  child's tool set collapses to read-only + diagnostic. The delegation tools
  classify as a new `orchestration` capability class that host-level PLAN
  policy does not block — the scheduler is the enforcement point.
- A small DAG scheduler (task ids + same-batch dependencies, DFS cycle
  rejection, semaphore concurrency from `orchestration.maxParallel`,
  dependency-failure propagation, per-run and batch AbortSignals) is the
  whole workflow model; no workflow engine, no persistence in this phase.
- Model selection is inherit | default | explicit provider/model with
  truthful degradation: an unavailable or unauthenticated model fails by
  name (`model-unavailable`), never silently substituted; the resolved model
  identity is recorded per run. Real provider token usage is recorded when
  exposed, never invented.
- The Phase 8 verifier remains independent: orchestration consumes verifier
  evidence but never controls verdicts; the verifier is not a teammate.

### Rationale

Phase 9 studied pi-maestro-teammate and pi-maestro-flow as laboratory
specimens. The ideas worth adopting natively: bounded explicit child
context, structured results, small DAG scheduling with cycle rejection,
bounded concurrency, truthful model degradation, progress phases, and
first-class cancellation. The ideas deliberately NOT adopted: parent
transcript inheritance through fork snapshots (context leakage by design —
Aira's isolation requirement is the opposite), subprocess-per-child with RPC
channels and session leases (in-process fresh-context runs provide the same
isolation property with a fraction of the machinery), model fallback chains
with circuit breakers (runtime resolver seam exists; routing policy is
later), worker-to-worker messaging, todo-context injection, and swarm/ACO
optimization. Children cost real model tokens per run, so delegation is
bounded, concurrency-limited, and never automatic for trivial work.

### Consequences

- `AiraSessionState.orchestration` is a new canonical snapshot field written
  only by the manager (ADR-005 preserved): bounded child rows, settled
  results, failure telemetry (`category`/`message`/`retryable`), concurrency
  truth, aggregate real token usage, and a one-line summary — token-free and
  UI-ready. The future Workbench/footer renders it without model tokens or
  process inspection.
- `AgentSession` gains: manager creation at construction, disposal with the
  session (aborts every child/batch), a child model runtime resolver seam,
  and the three native model tools (`agents_delegate`, `agents_status`,
  `agents_cancel`) in the default active set (SDK included).
- `AIRA_READ_ONLY_TOOLS` includes the delegation tools: PLAN keeps
  read-only exploratory children; the scheduler's mode gate is the
  read-only enforcement point (per-task refusal + mode-collapsed tool sets).
- A later phase can add nested delegation behind a strict depth limit (the
  strongest recursion guard — children cannot spawn at all — is already in
  place), richer model routing behind the resolver seam, browser-capable
  children behind an explicit capability flag, and durable audit behind
  canonical storage (`node:sqlite` upgrade path remains available).
## ADR-028 — The Goal Runtime is a native coordinator of existing bounded services, never an unbounded engineering loop

**Status:** Accepted

### Decision

- The Goal Runtime is a native per-session manager (`src/aira/goal/Manager`): one canonical goal per session (ADR-024 pattern), armed at construction, disposed with the session, projecting the token-free, UI-ready `AiraSessionState.goal` snapshot (ADR-005).
- Goal lifecycle is explicit and machine-readable: `idle`, `active`, `verifying`, `repairing`, `waiting`, `paused`, `completed`, `budget-limited`, `cancelled`, `error`. A validated state machine (`src/aira/goal/StateMachine`) rejects invalid transitions.
- The Runtime is a coordinator, not an owner of implementation mechanics. It connects Phase 6 (Execution evidence), Phase 7 (Browser evidence), Phase 8 (Verification contract), and Phase 9 (Task decomposition). It does not create Goal-specific verifiers, test runners, task lists, or intelligence caches.
- The Phase 8 Verifier owns the completion boundary. `PASS` completes the Goal. `FAIL` initiates a bounded repair continuation (objective, verification contract, blocking findings, change context). `INCONCLUSIVE` triggers a bounded evidence acquisition attempt (e.g. running unrun tests); if evidence cannot safely be acquired, the Goal falls back to `waiting`.
- The Phase 9 task graph remains the sole decomposition owner. The Goal Runtime merely projects the task graph progression (completed vs total) into the goal snapshot. No duplicate `GoalTodos` array exists.
- The user retains steering authority. Any user message suspends an autonomous continuation loop. Sending a user message while a goal is `paused` or `waiting` resumes it.

### Rationale

Phase 10 studied `pi-maestro-flow` and `qi-harness` as laboratory references. Ideas adopted: explicit objective tracking, bounded evaluation/repair loops, explicit wait boundaries, and token-free progress projection. Ideas deliberately REJECTED: independent engineering loops, recursive child agents driving the objective, hidden extensions, full transcript inheritance for child agents, hallucinating `PASS` without evidence, and uncontrolled token usage. The Goal Runtime must be a first-class Aira service that coordinates existing native services (Verification, Execution, Browsing, Orchestration) rather than reinventing them.

### Consequences

- `AiraSessionState.goal` is a new canonical snapshot field.
- The Goal Runtime handles autonomous continuation directly within the `AgentSession` stream without recursive agent instantiation.
- A future Workbench UI can project Goal state without requiring a model invocation.
- The `WAITING` state explicitly accommodates future permission-mode blocks or structured Q&A boundaries.

## ADR-029 — Goal Continuation Bounds, Settings, and Persistence

**Status:** Accepted

### Decision

- Autonomous continuation is strictly bounded. Limits: `maxRounds` (default 4), optional `tokenBudget`, optional `maxDurationMs`. Exceeding a limit transitions the goal to `budget-limited`.
- No-progress and identical-failure loops are explicitly detected: if the task revision is identical across rounds and the blocking findings remain the same, the goal transitions to `error` / `budget-limited` instead of thrashing.
- Re-verification of a completed goal after project edits marks the verification as stale; `completed` is a truthful representation of fresh verification.
- Goal state persists across restarts into the canonical cache (keyed by session ID). Running-class goals recover as `paused` (interrupted) and require manual or steered resumption. Stale persisted state is cleared upon explicit `/goal clear`.
- New or forked sessions do NOT inherit active goals.
- Bounded manual surface: `/goal` commands (`status`, `stop`, `resume`, `cancel`, `clear`), canonical `/settings` integration (`goals.enabled`, `goals.auto`, `goals.maxRounds`), and `goals.auto = smart` allows the runtime to skip goal creation for trivial tasks.

### Rationale

Goals have the highest potential for runaway costs (tokens, compute time). Strong bounding mechanisms (budgets, no-progress detection) are non-negotiable. Persistence is required for long-running workflows, but only bounded machine-readable state is persisted, not massive child conversation transcripts. The `smart` auto setting respects the reality that single-line typo fixes should not spin up a heavy multi-round goal apparatus.

### Consequences

- Goals require careful state management across the session lifecycle, especially regarding session interruption.
- Verifier token usage is explicitly tracked and attributed to the goal's token budget for truthful accounting.
- `AiraSessionEvent` must include goal continuation hooks to allow proper host integration and test harness assertions.

## ADR-030 — Native interaction & control: one permission owner, one interaction owner, one task graph; PLAN stays absolute

**Status:** Accepted

### Decision

Phase 11 builds Aira's human-control layer as three tightly coupled NATIVE
services with strict single-owner state (ADR-005), layered on the Phase 5
capability contract — never a competing classification — and the existing
Phase 3-10 services:

1. **Canonical permission owner.** One `AiraPermissionController` per
   session (`src/aira/permissions/`) owns authorization. It hooks the host
   tool boundary (`AgentSession.beforeToolCall`) AFTER the PLAN read-only
   check; explicit user rules live in Aira-owned config
   (`~/.aira/agent/permissions.json`), never Pi-owned config and never
   project-local config (a repository cannot self-grant privileges —
   project permission files are not read at all in Phase 11).

2. **Permission precedence (deterministic).** (a) PLAN read-only is
   ABSOLUTE: mutating/process/network/browser-interact requests are denied
   in PLAN regardless of permission mode or explicit rules — no mode
   (including yolo) and no rule can weaken it; (b) "allow once" grants are
   consumed by the very request they approved (never stored for the next
   request, never broadened); (c) explicit rules: most specific match wins
   (exact subject beats wildcard), ties by most-recent rule, and a matched
   rule overrides mode defaults (in yolo, explicit ask rules auto-approve;
   explicit deny rules stay absolute in every mode); (d) mode defaults by
   capability class. Four small modes: `normal` (default — routine
   engineering allowed; risky/destructive process commands, out-of-workspace
   writes, network and unknown tools ask), `permissive` (normal asks
   auto-approve; explicit ask rules still prompt), `strict`
   (deny-unapproved), `yolo` (bypass; deny rules + PLAN remain absolute).
   The risk-marker table is a bounded deterministic substring list over the
   normalized command, reviewed in the Phase 11 report.

3. **Canonical interaction owner.** One `AiraInteractionManager` per
   session (`src/aira/interaction/`) owns ALL structured user questions: at
   most ONE pending interaction per session. Permission ASK (type
   "permission") and the model-facing `ask_user` tool (type "semantic")
   share this infrastructure — there is no second permission-dialog
   architecture and no duplicate Q&A state store. Outcomes are truthful
   (`answered` / `cancelled` / `timed-out` / `unavailable` / `superseded`);
   a cancelled/unavailable question is NEVER an answer. Headless sessions
   resolve as `unavailable` without hanging; session shutdown resolves
   pending questions (never a wedged session); the interactive TUI renders
   questions through the existing selector/input dialogs (attachUI bridge).

4. **Task Graph vs Todo ownership.** The Phase 9 orchestration manager
   remains the sole owner of child RUN records. A new `AiraTaskManager`
   (`src/aira/tasks/`) owns the ONE canonical session task graph: manual and
   model-created rows plus orchestration children PROJECTED as read-only
   rows through the orchestration subscribe seam (patching a child row is
   refused; `/agents cancel` is the lifecycle surface). No second mutable
   task universe exists. `blocked` is DERIVED from unfinished dependencies
   (never settable; activation of a dependency-blocked task is rejected
   truthfully). Single-task patching only — never full-list replacement.

5. **Goal waiting integration.** The Phase 10 Goal Runtime consumes the
   interaction seam: an open question moves a running-class goal to
   `waiting` with a structured kind (`user-question` / `permission` /
   `evidence` — never inferred from strings). A real answer resumes the goal
   (waiting → active); a cancelled semantic question leaves the goal
   waiting truthfully (only a real user message resumes it); a permission
   denial resumes the round with the truthful denial. Waiting state persists
   bounded and machine-readable (kind included); recovery keeps the goal
   waiting.

6. **Children never bypass root authorization and never prompt.**
   Deterministic child tool gating (`gateForChild`) evaluates the SAME
   policy with ask→deny: no prompting, no permission forwarding, no nested
   interactive storms — production-safe by construction.

### Rationale

The Phase 11 reference study (pi-ask-user, d3ara1n-pi-ask-user,
pi-permission-system, pi-agent-permissions, inobit-pi-todo,
touchtechclub-pi-oc-todo) showed proven shapes worth ADOPTING natively
(bounded structured questions with truthful cancellation; deterministic
allow/once/session/always/deny decisions with exact-match non-broadening;
session approval stores; wildcard rule matching; small task-state machines
with forward-only transitions; token-light projections). What was
deliberately NOT adopted: extension-bound hosts with per-agent YAML policies
(Aira IS the host — one canonical owner), persistent UI stores with replay
hacks (the canonical session owns task state), ask-everything default
postures that make routine engineering unusable (Aira's normal mode follows
AIRA_ARCHITECTURE.md §16), separate todo databases (the Phase 9 task graph
is the decomposition owner), and permission forwarding channels (children
cannot prompt — determinism over convenience). "Most specific match wins"
over "deny > allow > ask" precedence was chosen because it is deterministic,
documented, lets users override their own broad rules, and still keeps deny
rules absolute within a scope — while PLAN's absolute boundary is enforced
BEFORE any rule, which is the only precedence that matters for safety.

### Consequences

- `AiraSessionState` gains three bounded token-free snapshots:
  `state.permissions` (mode, rule counts, store health, last decision),
  `state.interaction` (pending question projection with choices, closed
  history), `state.tasks` (counts, current, bounded rows, summary) — all
  UI-ready with subscribe seams (UI_BACKLOG B-006).
- New model tools `ask_user` and `tasks` (capability class `interaction`:
  never workspace-mutating, available in PLAN, never granted to children);
  new plain surfaces `/permissions` (status/mode/rule add|list|remove) and
  `/tasks` (list/add/done/cancel/get/remove); `/settings` gains "Aira
  permissions" / "Aira interaction" / "Aira tasks" submenus; `/status` and
  `/doctor` gain restrained appendices (the doctor includes a PLAN-absolute
  proof across every permission mode).
- Default permission mode is `normal`: existing sessions gain ASK prompts
  for consequential requests (risky commands, out-of-workspace writes,
  unknown tools) while routine engineering stays frictionless; strict/yolo
  are explicit opt-ins. Permission enforcement can be disabled
  (`permissions.enabled=false`) without touching PLAN enforcement.
- Session rules and allow-once grants are session-scoped by design;
  persistent rules require explicit user action and are bounded
  (≤ 128 rules, length-bounded fields, validated on load; corrupt/oversized
  stores fail closed to the mode defaults with truthful health — never a
  crash). No project-config trust mechanism exists yet; Phase 12 owns
  hooks/trust.

## ADR-031 — Aira owns one native Workbench; UI only projects state

**Status:** accepted · Phase 12

**Context.** Aira's canonical state spans modes, project, intelligence,
execution, browser, verification, orchestration, goal, permissions,
interaction, and tasks. The product needs one cohesive terminal UI, and the
subsystems must remain the only state owners.

**Decision.** `InteractiveMode` owns exactly ONE native Workbench UI
(`WorkbenchController` + renderers under `modes/interactive/workbench/`).
A pure projection layer (`src/aira/ui/`) derives panels, footer segments,
and the current finding from `AiraSessionState` and bounded canonical seam
inputs (`workingSet()`, `relevantSymbols()`); it contains no business logic
and no mutating surface. Subsystem snapshots stay the only truth; the UI
never queries subsystem internals, runs git at render time, or spends model
tokens. Headless/SDK/RPC/print never import the TUI renderer (module-graph
test enforces the boundary).

**Consequences.** One owner, projection-only UI, token-free rendering;
`/status`, `/doctor`, `/permissions`, `/processes`, `/browser`, `/verify`
remain the authoritative plain-text surfaces and stay usable headless.

## ADR-032 — Responsive sidebar policy and semantic Workbench binding

**Status:** accepted · Phase 12

**Context.** The sidebar must be visible by default on wide terminals,
auto-hide below a safe minimum, stay hidden when the user turned it off, and
restore when the user asked for it. `Ctrl+O` is Pi's established tool-output
expansion action and must remain available.

**Decision.** Visibility is a pure policy (`aira/ui/visibility.ts`): width
below `72 + sidebarWidth` hides the sidebar regardless of user choice; on
safe widths, explicit OFF wins, else default follows `showOnStartup`, and
explicit ON wins. `app.workbench.toggle` defaults to `Ctrl+Shift+O`;
`app.tools.expand` remains `Ctrl+O`. User customizations are never
overwritten (user bindings override defaults); the tree-filter bindings
(context-scoped) are untouched; `/doctor` and the keybinding docs report the
resolved truth.

**Consequences.** Deterministic, testable responsiveness (auto-hide,
explicit-off, restore semantics all unit-tested); one documented shortcut
binding contract with a truthful conflict path.

## ADR-033 — Footer priority system and the highest-priority finding

**Status:** accepted · Phase 12

**Context.** The status rail must stay useful at any width and surface one
actionable finding without inventing severity.

**Decision.** The footer is a single line of segments with explicit drop
ranks: mode/context/model are required (never dropped, only compacted or
truncated); pending interaction/permission and the current finding rank
just below; active-work segments (verification, goal, agents, browser,
execution) drop before context; opportunistic segments (git Δ, permission
mode, LSP detail) drop first. `arbitrateCurrentFinding` picks ONE finding
across canonical sources with severity taken only from the source.

**Consequences.** Responsive dropping and truncation are deterministic and
unit-tested; a question or authorization is never buried; a stale PASS never
presented as current truth.

## ADR-034 — Theme semantic contract and `aira-zhr` as the default dark theme

**Status:** accepted · Phase 12

**Context.** Aira's visual baseline is a dark warm-neutral palette; the
Workbench must render acceptably under user-selected or third-party themes.

**Decision.** Eight optional semantic color roles extend the theme
contract (`copper`, `copperBright`, `blue`, `cyan`, `green`, `yellow`,
`red`, `purple`) with classic fallbacks (accent/success/warning/error/
muted…), so every existing theme stays valid untouched. `aira-zhr` is a
built-in theme and the default resolution for unset themes on dark
terminals; `light` stays the light default; explicitly configured themes
always win. The Workbench consumes roles, never literal colors.

**Consequences.** Semantic-only coloring (no rainbow telemetry), full
compatibility with third-party themes, one new built-in theme shipped in
the binary.

## ADR-035 — Extension chrome conflicts are diagnosed, never fought over

**Status:** accepted · Phase 12

**Context.** Pi lets extensions install custom footers/editors. Aira's
native Workbench owns the footer rail; two components must not fight for
the same renderer.

**Decision.** The Workbench uses the built-in footer surface. When an
extension installs a custom footer, Pi's existing replacement semantics
apply and the Workbench footer is suppressed; `/doctor` reports the
conflict truthfully (`chrome conflict` check in interactive mode). The
Workbench overlay is detached around renderer switches so mode toggling
never breaks.

**Consequences.** No silent fights; truthful diagnostics; extension UX
contract preserved (extension status line still renders on its own line).

## ADR-036 — Interactive presentation is an Aira-owned application shell

**Status:** accepted · Phase 12 direction change

**Context.** The first Workbench implementation projected the correct native
state but left Pi's startup help, context blocks, transcript hierarchy,
composer framing, update card, and direct-shell chrome visible. The result was
functionally Aira but visually read as stock Pi with a sidebar.

**Decision.** Interactive mode owns a restrained Aira application shell:
identity header, role-labelled conversation, compact activity/notices, framed
composer, bottom dock, Engineering Context rail, and one telemetry footer.
These components wrap or compose the existing Pi-derived runtime surfaces;
they do not replace editor input semantics, transcript/session data, tool
execution, extensions, keybindings, queueing, fullscreen behavior, or the
headless/RPC paths. Default startup hides loaded-resource detail; Ctrl+O
reveals it through the existing expansion action. Engineering panels remain
bounded projections of canonical state.

**Consequences.** Aira has a distinct shell at first paint without a parallel
runtime or state store. Visual ownership is interactive-only and testable at
the component/layout boundary. Compatibility behavior remains underneath the
presentation layer, and third-party extension replacement contracts continue
to apply.

## ADR-037 — Aira interactive mode is fullscreen-first with native viewports

**Status:** accepted · Phase 12.1

**Context.** Aira's conversation transcript and Engineering Workbench
previously relied on the host terminal's scrollback for navigation. That
forces the user out of the application (terminal scrollbar, no per-pane
state), breaks fixed header/composer/footer geometry, and cannot give the
Workbench its own scroll position. Pi's existing fullscreen renderer
(`TuiAltScreen`) already provides an application-owned transcript viewport
with follow-output, pointer-routed wheel scrolling, per-pane text selection,
search, prompt-jump, and scrollbars.

**Decision.** Aira's native interactive mode defaults to fullscreen and treats
Pi's fullscreen viewport as the canonical product shell. The conversation and
the Workbench are two independent scroll views inside one fixed shell (header,
composer dock, status rail stay fixed). Regular (terminal-scrollback) mode is
preserved as the explicit compatibility mode via `tuiMode: "regular"` or
`--tui-mode regular`; it renders the Workbench as a viewport-fixed rail and
does not attempt independent panes. Keyboard viewport navigation targets a
single focused pane (conversation by default, `Alt+O` cycles focus); the
mouse wheel always targets the pane under the pointer without stealing focus.
A scrolled-away conversation never yanks back to live output; a one-line
new-output indicator plus an `LIVE STATE · VIEWING HISTORY` Workbench subtitle
make the reading posture explicit, and End restores follow and clears the
indicator.

**Consequences.** Fullscreen becomes Aira's default interactive experience and
regular mode is a compatibility fallback. Viewport state is interactive-only
(never in `AiraSessionState`), headless/SDK/RPC are untouched, and rendering
remains token-free. Existing keyboard contracts are preserved: `Ctrl+A`
stays editor line-start, `Ctrl+O` stays tool expansion, `Ctrl+Shift+O` stays
the Workbench toggle, and `Alt+O` is the new pane-focus cycle.

## ADR-038 — Aira owns foreground semantics; the terminal owns the canvas

**Status:** accepted · Phase 12.2

**Context.** The Aira shell inherited Pi-era fills for the composer input
lane and the footer status rail (painted gray strips). On arbitrary dark
terminal backgrounds those strips read as leftover Pi chrome and broke the
composition: the Workbench imposed one fixed gray band instead of blending
with the user's terminal.

**Decision.** `aira-zhr` becomes a background-independent warm-neutral
semantic palette (`#D89A72` copper, `#7895BC` muted blue, `#A9BBD3` soft
blue, `#E7E1D9` warm ivory, `#8F8C89` taupe, `#82B792` success, `#D6AA6C`
warning, `#D77C78` error, `#66574F` border; focused border is copper).
Aira never paints the main Workbench chrome background: the composer lane and
footer rail inherit the terminal background, and structure comes from
borders, separators, and semantic foreground colors. The composer frame is
copper while focused and muted-subtle otherwise; the footer keeps its
priority-segment hierarchy (copper mode, blue info/model, warning/error
traffic lights, taupe metadata). Rendering stays inside the existing theme
abstraction — components consume semantic roles, never literal colors — and
explicitly configured or third-party themes still win untouched (they keep
their own fills and colors).

**Consequences.** The chrome reads as typography on the terminal on any dark
background (true black, charcoal, warm-dark, blue-black). Semantic roles keep
working for third-party themes with their classic fallbacks; only the
built-in default changed. HTML export keeps explicit page/card/info
backgrounds because exported HTML has no terminal behind it.

## ADR-039 — Native tasks persist bounded rows; runtime projections do not

**Status:** accepted · Phase 13

The Task Manager is the sole live task authority. It persists only native task
identity, title, status, dependencies, source, note, and meaningful
timestamps in a session-scoped Aira cache record with a schema version and
atomic replacement. Resume reconstructs the graph, maps interrupted active
work to pending, and recomputes dependency blocking. Child rows, process
state, rendering rows, and transcripts are excluded.

## ADR-040 — Runtime mode awareness is a small advisory control envelope

**Status:** accepted · Phase 13

The host appends one bounded effective-mode envelope to the next root system
prompt and includes the same mode semantics in fresh child envelopes. It is
not visible in the composer and cannot weaken the authoritative PLAN tool
policy. Mode-aware text is measured by the context-cost audit.

## ADR-041 — Capability incompatibility is rejected before child model spend

**Status:** accepted · Phase 13

Child specifications may declare a small explicit capability requirement
(`process`, `mutation`, or `browser`). The orchestration manager checks the
requested role and effective mode before creating a child provider runtime.
The check never broadens a role; incompatible work fails truthfully before a
provider call.

## ADR-042 — Runtime budgets are role-aware and observable

**Status:** accepted · Phase 13

Child roles and the independent verifier use bounded, role-calibrated tool
round limits. Usage and limits are published as compact telemetry alongside
the existing bounded lifecycle snapshots. Exhaustion remains a truthful
failure category; there is no unbounded extension or weighted quota system.

## ADR-043 — Interactive process input is a local-only execution seam

**Status:** accepted · Phase 13

Interactive processes extend the existing Execution Manager rather than
creating a second runtime. POSIX terminal allocation and host/UI input are
separate from model-visible tools and canonical state. Input is never logged,
persisted, emitted as an event, or sent through semantic `ask_user`. When a
host cannot supply the local bridge, the manager returns unavailable rather
than hanging.

## ADR-044 — Ambient context must declare measured cost

**Status:** accepted · Phase 13

Host enforcement and UI projection cost zero model tokens. Runtime facts the
model genuinely needs use the smallest bounded stable envelope; inactive
subsystem context is conditional, and unchanged context should use existing
caching. Every future ambient feature must provide exact character counts and
a local/provider token estimate where available. Observability data is not
automatically model context.

## ADR-045 — Goal workspace ownership is host-tracked and destructive repair is protected

**Status:** accepted · Phase 13

**Context.** A dirty worktree can contain user or another session's changes
that predate a Goal. Treating every current dirty path as Goal output allowed a
repair loop to restore unrelated files merely to make verification pass.

**Decision.** At Goal start, the host captures a bounded baseline from the
canonical repository change seam. Only successful direct `edit`/`write` tool
events in that Goal scope are candidates for Goal ownership. A path already in
the baseline, a path changed outside that execution path, or a path whose
post-edit fingerprint drifts is protected. The verifier receives bounded
baseline, Goal-owned, protected, and unowned counts and evaluates an active
Goal against its owned delta. The host refuses destructive restore,
checkout/reset, or tracked-file removal when any target is protected,
ambiguous, outside the workspace, or ownership evidence is unavailable.

**Consequences.** Baseline dirtiness alone cannot fail a read-only Goal and is
never repairable. Shared edits preserve the user's pre-Goal content at
minimum. Repair remains available for a clean-workspace Goal-owned path, but
the guard is authoritative at `beforeToolCall`; prompt text cannot grant
ownership. Ownership state is bounded, in-memory, and token-free apart from
the verifier's measured ownership summary.

## ADR-046 — Goal completion observes the all-settled task edge and forwards the stored objective

**Status:** accepted · Phase 13

**Context.** A Goal can outlive the root turn that dispatched it. With
`agents_delegate(await=false)` the root `agent_end` boundary fires while the
native child is still running; a completion boundary evaluated only at
`agent_end` either ends the Goal on builder-side evidence without an
independent verifier run or runs the verifier without the stored objective.

**Decision.** The Goal completion boundary is reachable from two edges: the
root `agent_end` event and the canonical task graph reaching an all-settled
state (total > 0, completed === total, and no pending, active, or blocked
work). Both edges invoke the same bounded boundary. A bounded completion key
makes repeated task snapshots and a root/child race run verification once.
The boundary passes the current Goal objective to the independent verifier,
and the verifier gives that boundary objective precedence over its
explicit-request fallback, so child-backed Goals are verified against the
user's actual explicit criteria.

**Consequences.** A background child settling after the root turn ends can no
longer complete a Goal without independent verification, and no user wake-up
is required. Filesystem-only objectives no longer gain unrelated
browser/runtime requirements. Known low-severity follow-up: the verifier's
diagnostic presentation can still show placeholder objective wording and
browser-evidence commentary when browser evidence is not applicable; this is
presentation wording only and is tracked as backlog item B-011, not a
lifecycle change.

## ADR-047 — Session mutation authority is serialized; external effects stay outside it

**Status:** accepted · Phase 14

**Context.** Session, branch, lane, generation, tool, and operation state must
publish one coherent committed view while providers, tools, hooks, timers, and
event delivery remain independently cancellable and observable. Running those
effects inside a durable callback would make retries and crash recovery depend
on callback timing and could allow an effect before its intent is committed.

**Decision.** A Session-owned `MutationLine` serializes durable read-decide-
write transitions and exposes only committed state to ordinary readers.
Nested mutations and external effects inside the mutation scope are rejected.
Provider and tool effects run after their durable intent transition and settle
through compare-and-set records; backend transactions remain responsible for
atomic publication and rollback.

**Consequences.** Recovery can identify pending or uncertain effects without
claiming exactly-once provider execution. Session/Branch/AgentLane ownership,
durable generation, durable tools, named forks, and the operation boundary all
use this authority without importing Pi's Drive runtime.

## ADR-048 — Aira keeps a local durable operation model instead of adopting Pi Drive

**Status:** accepted · Phase 14

**Context.** Pi's later Drive, Chord, Delta, and remote-presentation work is a
coordinated distributed/runtime architecture. Aira currently owns local
Session, Branch, AgentLane, Workbench, client/server, and verifier boundaries;
there is no current consumer for Chord services, replicated Delta state, or a
multi-process presentation worker.

**Decision.** Aira uses its existing Session record protocol, MutationLine,
lane-owned generation/tool state, and `DurableOperationBoundary` for local
durability and recovery. Pi Drive, Chord, Delta, replicated state, facet
distribution, Radius, and remote presentation remain design input and are not
introduced as placeholder APIs or parallel authorities.

**Consequences.** Local recovery, cancellation, fork ownership, and operation
observation remain testable without a speculative transport or replication
layer. Reconsider the deferred families only when Aira has a concrete
multi-process, plugin-service-host, mobile-handoff, or remote-presentation
consumer that justifies a coordinated architecture migration.
