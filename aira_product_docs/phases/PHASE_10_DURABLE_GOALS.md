# Phase 10: Durable Goals and Autonomous Continuation

**Status**: Complete

## Objective
Build Aira's native durable goal/runtime layer. The goal layer provides bounded autonomous continuation (evaluate -> FAIL -> repair -> evaluate) coordinated across Phase 6 (Execution), Phase 7 (Browser), Phase 8 (Verification), and Phase 9 (Task Graph).

## Implementation Details

### Goal Runtime Owner
- `GoalManager` coordinates the lifecycle natively within Aira.
- Exposes explicit machine-readable states: `idle`, `active`, `verifying`, `repairing`, `waiting`, `paused`, `completed`, `budget-limited`, `cancelled`, `error`.
- Validated state transitions using an explicit state machine.

### Verification Contract (PASS / FAIL / INCONCLUSIVE)
- Relies on Phase 8 verification. No Goal-specific verifier.
- **PASS**: Goal transitions to `completed`. Previous verification is marked stale if subsequent project edits occur.
- **FAIL**: Bounded repair continuation is triggered, providing the original objective, current verification, and blocking findings.
- **INCONCLUSIVE**: Bounded evidence acquisition is triggered, or if evidence cannot be safely acquired, falls back to `waiting`.

### Continuation Bounds
- Limits are implemented via `maxRounds` (default 4), with optional `tokenBudget` and `maxDurationMs`.
- No-progress and identical-failure loops are detected and blocked to prevent infinite loops and token thrashing.

### Ownership and Persistence
- Canonical goal owned by `AgentSession`.
- Goals persist in canonical cache (by session ID) to support pausing across restarts.
- New/Fork sessions do NOT silently inherit active goals.

### Settings
- Added canonical settings: `goals.enabled`, `goals.auto` (`off` | `smart` | `always`), `goals.maxRounds`, `goals.tokenBudget`, `goals.maxDurationMs`.
- `goals.auto = smart` identifies trivial tasks and skips creating durable goals for them.

### Commands
- Restricted manual command surface: `/goal` (create/status), `/goal stop`, `/goal resume`, `/goal cancel`, `/goal clear`.
- Goal health is checked in `/doctor`.

## Future Seams
- **Native Todo/Task View**: Goal projects task graph progression without maintaining a separate task list.
- **Permission Modes**: Designed for future capability/policy boundaries (e.g. blocking file mutation during wait state).
- **Q&A System**: Structured `waiting` states accommodate later ask-user pipelines.
