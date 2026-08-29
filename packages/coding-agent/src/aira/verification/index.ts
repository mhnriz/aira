/**
 * Aira verification — independent verification subsystem (Phase 8).
 *
 * One per-session manager owns the lifecycle: automatic triggering at the
 * agent_end completion boundary, eligibility/trivial-skip, revision dedupe,
 * bounded evidence aggregation from the canonical subsystem snapshots, the
 * fresh-context verifier model invocation, freshness invalidation, and the
 * canonical `state.verification` snapshot. The verdict contract is
 * PASS / FAIL / INCONCLUSIVE; INCONCLUSIVE never silently becomes PASS.
 */

export * from "./eligibility.ts";
export * from "./evidence.ts";
export * from "./manager.ts";
export * from "./prompt.ts";
export * from "./requirements.ts";
export * from "./settings.ts";
export * from "./types.ts";
export * from "./verifier.ts";
