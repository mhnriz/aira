# Phase Reports

Every completed roadmap phase gets a written report committed here, so any
future development session (human or pi) can reconstruct what happened without
re-deriving it.

## Convention

- File name: `PHASE_<N>_<NAME>.md` (e.g. `PHASE_1_CORE_SEAM.md`).
- The report is saved and committed **as part of the phase's final work**, at
  the same time the phase is declared complete.
- Update table below: mark the phase done, point to its report, and state the
  current phase.
- Reports record commit hashes at the time of writing. History is never
  rewritten (see DEVELOPMENT.md), so those hashes remain valid references.

## Recommended report outline

```text
Status / phase name
Architecture discovered in the Pi coding-agent host
Where the Aira boundary was placed and why
Host files modified to create the seam
Aira-native files created
<feature/state> shape (AiraSessionState, commands, etc.)
Lifecycle events / integration points used
<feature> behavior
Tests added
Verification commands and results
Compatibility concerns
Architectural decisions that became ADRs
Every local Git commit created
Final git status
Stopping point / next phase
```

## Phase table

| Phase | Status | Report | Notes |
| --- | --- | --- | --- |
| 0 — Fork and Baseline | ✅ done 2026-08-26 | [BASELINE.md](../BASELINE.md) (fork record lives at repo root) | Pi v0.84.3 base, commit `cbea4fb02` establishes it |
| 1 — Aira Core Seam | ✅ done 2026-08-26 | [PHASE_1_CORE_SEAM.md](PHASE_1_CORE_SEAM.md) | canonical `AiraSessionState`, lifecycle bridge, native `/status` |
| 2 — Native Identity and `~/.aira/` | ✅ done 2026-08-26 | [PHASE_2_NATIVE_IDENTITY.md](PHASE_2_NATIVE_IDENTITY.md) | `aira` executable, Aira product metadata, `~/.aira/` home + path helpers, optional `aira import --pi` |
| 3 — Native Modes and UX | ✅ done 2026-08-26 | [PHASE_3_NATIVE_MODES_UX.md](PHASE_3_NATIVE_MODES_UX.md) | BUILD/PLAN/REVIEW cycle (`Shift+Tab`), PLAN read-only at tool-policy boundary, `/mode` + `/doctor`, footer mode badge |
| 4 — Project Awareness | ✅ done 2026-08-27 | [PHASE_4_PROJECT_AWARENESS.md](PHASE_4_PROJECT_AWARENESS.md) | evidence-based `ProjectProfile` in canonical state; root/languages/frameworks/managers/commands/browser/deployment/confidence; home safety boundary |
| 5 — Intelligence | ✅ done 2026-08-27 | [PHASE_5_NATIVE_INTELLIGENCE.md](PHASE_5_NATIVE_INTELLIGENCE.md) | native intelligence service: repository + live-code providers, ambient context, automatic post-edit diagnostics, capability classification, graceful degradation |
| 6 — Execution Runtime | ✅ done 2026-08-28 | [PHASE_6_EXECUTION_RUNTIME.md](PHASE_6_EXECUTION_RUNTIME.md) | native per-session process runtime: managed processes, bounded log capture, cross-platform termination, project-aware test/build/check/dev primitives, process tools + `/processes` |
| 7 — Browser Runtime | — | — | — |
| 8 — Independent Verification | — | — | — |
| 9 — Task Graph and Delegation | — | — | — |
| 10 — Durable Autonomous Work | — | — | — |
| 11 — Compaction and Knowledge | — | — | — |
| 12 — Policy, Hooks, and Trust | — | — | — |
| 13 — Pi Compatibility Hardening | — | — | — |
| 14 — Distribution and Bootstrap | — | — | — |
