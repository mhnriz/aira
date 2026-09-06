# PHASE 14 — COMPACTION, DURABILITY & KNOWLEDGE

**Status:** closed 2026-09-06. Aira completed the Phase 14 implementation
through Stages 1–9 and integrated the audited Pi 0.85.1 baseline. The detailed
chronological audit remains in [PHASE_14_PREPARATION.md](PHASE_14_PREPARATION.md);
this report records the final architecture and stopping point.

## Objective and outcome

Phase 14 made long-running Aira sessions durable without importing Pi's later
Drive, Chord, Delta, or remote-presentation architecture. The result is an
Aira-owned local durability model with explicit mutation authority, separated
ownership, recoverable generation and tool effects, named fork semantics,
operation observation, lifecycle corrections, and additive fullscreen TUI
navigation.

The upstream base is Pi 0.85.1. Upstream work was inspected chronologically;
small compatible changes were adapted with author/SHA provenance, while broad
runtime, package, replicated-state, and remote changes were classified in the
preparation ledger rather than copied mechanically.

## Completed stages

| Stage | Result |
|---|---|
| 1 | Session-owned `MutationLine`; committed-state visibility; external effects excluded from durable callbacks. |
| 2 | Explicit Session, Branch, and AgentLane ownership with atomic acquisition and compatibility delegation. |
| 3 | Lane-owned durable generation, captured request configuration, retry/deferred state, CAS transitions, and settlement. |
| 4 | Durable tool intent, checkpoints, outcomes, replay policy, placement, cancellation, and missing-tool recovery. |
| 5 | Explicit named branch forks, ancestry validation, lane-name preservation, and pre-publication checks. |
| 6 | Durable lane inbox and operation boundary with observation, cancellation, duplicate-consumption protection, and total recovery dispatch. |
| 7 | Compaction abort coordination and truthful signal-killed process failures. |
| 8 | Cached fullscreen search, jump-to-latest, accelerated Alt-wheel scrolling, and configurable selector save bindings. |
| 9 | Complete deferred-work triage; Chord, Delta, remote, facet, and package-topology families remain intentionally deferred. |

## Architecture and compatibility

The Session-owned mutation line is the single durable read-decide-write
authority. Providers, tools, hooks, timers, and event delivery remain outside
it. Session owns global state, Branch owns path state, AgentLane owns execution
state, and AgentHarness coordinates the runtime. Generation and tool effects
are represented by durable intent/effect/outcome records; uncertain external
effects remain visible rather than being silently replayed.

The Aira Workbench, Agent Inspector, Browser, BUILD/PLAN/REVIEW modes,
editor, permissions, goals, tasks, orchestration, verifier, `/new`, `/resume`,
themes, extension boundary, and `aira-zhr` remain intact. Aira keeps the Pi
package names and package versions for compatibility while reporting its own
product version as `Aira 0.1.5 (Pi base 0.85.1)`.

Chord, Delta, replicated state, remote/multi-process presentation, Radius,
facet distribution, and broad package/import topology changes are not part of
this release. They remain design-only or later-phase work until Aira has a
concrete consumer and a coordinated migration plan. Phase 15 remains future
work and is not started; the independent verifier was not redesigned.

## Validation and dogfood

The final validation was green: `npm run check`, `npm run build`,
permission-enabled `./test.sh`, and `git diff --check` passed. Focused suites
passed with 74 tests and one skip for the agent durability matrix, 176 tests
and five skips for coding-agent Phase 14/Phase 13 regressions, 56 TUI tests,
and 110 package/extension/theme/skills tests. The built Node and bundle CLIs
both report exactly `Aira 0.1.5 (Pi base 0.85.1)`; offline model listing,
package dry-run, and extension discovery/runner compatibility also passed.

The disposable built-Aira tmux smoke reached the Workbench, displayed the
expected no-provider notice, and exited cleanly on interrupt. A provider-free
`/doctor` probe likewise stopped at the expected missing-API-key boundary;
live model prompts and provider-backed dogfood remain environment-limited,
not product failures. No provider credentials or external release service is
required for the deterministic suites.

## Provenance and stopping point

Pi and Earendil Works receive credit for the upstream runtime, provider, tool,
session, and TUI foundations. Aira-specific adaptations remain in separate
semantic commits and are listed with their upstream lineage in the preparation
ledger. This closeout does not rewrite Phase 14 history, push, tag, publish, or
start Phase 15.
