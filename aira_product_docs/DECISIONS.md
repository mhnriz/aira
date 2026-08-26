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

## Adding decisions

When a future architectural choice materially changes one of these assumptions:

1. add a new ADR;
2. mark the superseded ADR appropriately rather than silently rewriting history;
3. explain why evidence changed the decision;
4. commit the decision with the implementation or immediately before it.
