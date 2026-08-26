# Phase 1 — Aira Core Seam: Report

> Status: complete (2026-08-26) | Commits listed at the end are part of this phase.
> Convention: every phase gets a report in this directory — see [README.md](README.md).

## Architecture discovered in the Pi coding-agent host

- **`core/sdk.ts` → `createAgentSession()`** is the *sole* construction site of `AgentSession` (all flows funnel through it via `main.ts` → `createAgentSessionFromServices`, covering startup, `/new`, `/fork`, `/resume`, `/import`, and all modes — interactive, print, rpc, SDK).
- **`core/agent-session.ts`** — `AgentSession` constructor and `dispose()`. Dispose already routed teardown through pi-ai's `cleanupSessionResources` session-resource registry.
- **`core/agent-session-runtime.ts`** — `AgentSessionRuntime` owns replacements (`teardownCurrent` → dispose old → `createRuntime` → apply new).
- **`modes/interactive/interactive-mode.ts`** — command dispatch is a chain of `if (text === "/xyz")` branches; rendering convention is `Spacer` + `Text(theme.fg("dim", ...))` into `chatContainer`.
- **`core/slash-commands.ts`** — `BUILTIN_SLASH_COMMANDS` powers autocomplete and extension-conflict diagnostics.
- **`SessionStartEvent.reason`** — `"startup" | "reload" | "new" | "resume" | "fork"` is available at session construction.

## Where the Aira boundary was placed and why

`packages/coding-agent/src/aira/` — the architecture doc's conceptual `src/aira/` maps naturally into the coding-agent package (the host). Three modules, zero TUI/theme dependencies:

```text
src/aira/
├── index.ts              public surface
├── state.ts              AiraSessionState + registry (canonical truth)
├── lifecycle.ts          host → Aira bridge (2 functions, the whole contract)
└── commands/status.ts    /status report builder + plain-text formatter
```

## Host files modified (the entire seam — 3 files, +19 lines)

| File | Change |
|---|---|
| `core/agent-session.ts` | +6: constructor calls `onAiraSessionCreated(sessionId, reason)` and stores the returned state as ownership handle; `dispose()` calls `onAiraSessionDisposed(sessionId, handle)` |
| `core/slash-commands.ts` | +1: `/status` entry in `BUILTIN_SLASH_COMMANDS` (autocomplete + conflict diagnostics for free) |
| `modes/interactive/interactive-mode.ts` | +13: import, one `/status` dispatch branch, `handleStatusCommand()` rendering per existing conventions |

## Aira-native files created

`src/aira/state.ts`, `src/aira/lifecycle.ts`, `src/aira/commands/status.ts`, `src/aira/index.ts`, plus tests `test/aira/{state,lifecycle}.test.ts` and `test/aira/commands/status.test.ts`.

## AiraSessionState shape

```ts
interface AiraSessionState {
  readonly sessionId: string;              // the key of canonical state
  readonly startReason: "startup" | "reload" | "new" | "resume" | "fork";
  readonly createdAt: number;
  mode: "build" | "plan" | "review";       // Phase 1: always "build"
  runtime: "active" | "disposed";
  project: "unresolved";                   // project awareness = later phase
  capabilities: readonly ["core"];
  disposedAt?: number;
}
```

Ownership: acquire returns the state as an **ownership handle**; dispose is ownership-checked — a stale owner (replaced by a newer session over the same file) is a no-op. Recorded as ADR-018.

## Lifecycle events / integration points

Exactly two, both in `agent-session.ts`, both documented at the call site: **constructor** (creation, with start reason) and **dispose** (release, ownership-checked). No event bus — Phase 1 lifecycle is created → disposed.

**Bug found by the tests:** the runtime characterization suite showed the host *legally* allows two live sessions over one session id (resume while another runtime still holds the file). The first design (throw on double-acquire via pi-ai's anonymous cleanup registry) broke that valid host behavior. Fixed with ownership semantics in commit `17298582e`; recorded as ADR-018.

## `/status` behavior

Host command (unnamespaced per the product clarification; ADR-017). Renders in the chat area:

```text
Aira
runtime: active
session: <id>
mode: build
project: unresolved
capabilities: core
```

Missing canonical state renders `state: unavailable` (explicit, so wiring bugs are visible). Confirmed: Pi has no existing `/status`; extension collisions with builtins are already diagnosed by the host.

## Tests added (23)

- **state** (10): defaults, retrieval, unknown id, isolation, replacement/stale-owner, dispose transitions+timestamp, idempotency, re-acquisition, active-only tracking.
- **lifecycle** (5 bridge + 2 seam): creation, release-by-owner, stale-owner no-op, unknown-session no-op, isolation — plus end-to-end with **real `AgentSession`s** via the existing test harness (acquire on construction, release on dispose, no cross-session leakage).
- **status** (5): report building (active/disposed/unavailable) + exact formatted output.

## Verification commands and results

| Check | Result |
|---|---|
| `vitest run test/aira/ test/suite/agent-session-runtime.test.ts` | 33/33 PASS |
| full coding-agent suite (`vitest --run`) | 1997 passed, 1 failed — **pre-existing** flaky footer debounce test (documented in BASELINE.md) |
| `tsgo --noEmit` (package + root) | PASS |
| `npm run build` (coding-agent) | PASS (bundle built) |
| pre-commit `npm run check` (biome, pinned deps, ts-imports, shrinkwrap, browser smoke) | PASS on every commit |

## Compatibility concerns

None. No Pi extension/package API touched; the three host files are additive. `/status` joins the builtin list, which means an extension registering a `status` command now gets the standard builtin-conflict diagnostic — consistent with existing builtins, not a behavior change.

## Architectural decisions that became ADRs

- **ADR-017 — Core Aira commands are unnamespaced** (also corrected the `/aira ...` list in AIRA_ARCHITECTURE.md §18).
- **ADR-018 — Session-file overlap is a legal Pi host lifecycle; canonical state ownership transfers to the newest acquirer** (discovered by evidence during this phase).

## Local Git commits created (nothing pushed)

```text
046c3d94c feat(core): add canonical Aira session state
579b7dbef feat(core): add native Aira lifecycle bridge
ed26419f0 feat(status): add native Aira /status command
17298582e fix(core): ownership-checked Aira session state release
dd160a7ef docs(decision): record unnamespaced core command convention (ADR-017)
```

## Final `git status`

Clean working tree. `main` = `dd160a7ef`, ahead of `upstream/main` by 7, behind by 29 (baseline divergence). Only remote: `upstream` (Pi). No `origin`, nothing pushed, nothing published.

## Stopping point / next phase

Stopped after Phase 1 per roadmap discipline — no Phase 2+ functionality has leaked in. Next: **Phase 2 — Native Identity and `~/.aira/`** (canonical executable `aira`, product metadata, Aira home paths, path helpers, optional Pi migration).