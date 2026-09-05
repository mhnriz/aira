/**
 * Aira goal — canonical contract types.
 *
 * Phase 10: the native durable Goal Runtime. One canonical goal per live
 * session (ADR-024 ownership pattern, mirroring execution/browser/
 * verification/orchestration). The goal owns the OBJECTIVE and LIFECYCLE;
 * the Phase 11 TaskManager owns the canonical task graph; the Phase 8 verifier
 * remains the independent completion authority. The Goal Runtime is a
 * COORDINATOR — it never re-implements implementation mechanics, execution,
 * browser, delegation, or verification.
 *
 * This module defines the explicit lifecycle state machine, the bounded
 * canonical snapshot (`state.goal`), the truthful usage/budget contract, and
 * the structured waiting seam for future native Q&A and permission modes.
 */

/** Explicit goal lifecycle states (smallest truthful set — no vague booleans). */
export type AiraGoalStatus =
	/** No goal for this session. */
	| "idle"
	/** Objective accepted; implementation round in flight or awaiting the next turn. */
	| "active"
	/** Independent verification is in flight at a completion boundary. */
	| "verifying"
	/** A FAIL produced a bounded repair continuation (round ≥ 2 in flight). */
	| "repairing"
	/** Progress genuinely requires the user or an unavailable capability. */
	| "waiting"
	/** User stopped autonomous continuation; state and evidence preserved; resumable. */
	| "paused"
	/** PASS with a fresh independent verification result. */
	| "completed"
	/** A hard bound (rounds/tokens/duration/no-progress/repeated verdict) ended continuation. */
	| "budget-limited"
	/** User cancelled active execution; owned in-flight work was aborted. */
	| "cancelled"
	/** Internal runtime failure; the root session stays fully usable. */
	| "error";

/** Why a goal stopped continuing (pause / budget / waiting reasons, structured). */
export type AiraGoalStopReason =
	// ---- paused ----
	| "user" // /goal stop
	| "interrupted" // session disposed or run aborted while active
	| "agent-error" // the implementation run ended with a model/provider error
	// ---- budget-limited ----
	| "max-rounds" // rounds consumed the configured maximum
	| "token-budget" // consumed tokens reached the configured budget
	| "max-duration" // elapsed time reached the configured budget
	| "no-progress" // consecutive rounds produced the same implementation state
	| "repeated-verdict" // consecutive rounds produced an identical FAIL verdict
	// ---- waiting ----
	| "input-required" // genuine user input needed (structured seam)
	| "missing-evidence" // evidence cannot be responsibly acquired automatically
	| "verification-disabled" // completion cannot be established while the verifier is off
	| "no-work" // an implementation round produced no changes
	| "permission" // a capability/policy boundary blocked required work
	| "plan-mode"; // read-only mode cannot produce implementation work

/** Structured waiting reason — the Phase 11 native Q&A / permission-mode seam. */
export interface AiraGoalWaiting {
	/** Bounded reason category (see AiraGoalStopReason waiting classes). */
	reason: AiraGoalStopReason;
	/**
	 * Structured interaction kind (Phase 11): "user-question" (semantic
	 * Q&A), "permission" (tool authorization), "evidence" (verifier- or
	 * capability-driven). Never inferred from strings — set explicitly by
	 * the waiting owner.
	 */
	kind: "user-question" | "permission" | "evidence";
	/** Bounded human-readable detail. */
	detail: string;
	/**
	 * When `input-required`, the structured Q&A component plugs in here:
	 * what decision/information the user must provide. Bounded; never
	 * a transcript.
	 */
	ask?: string;
}

/** Allowed lifecycle transitions (validated by the state machine module). */
export const AIRA_GOAL_TRANSITIONS: Readonly<Record<AiraGoalStatus, readonly AiraGoalStatus[]>> = {
	idle: ["active"],
	active: ["verifying", "repairing", "waiting", "paused", "completed", "budget-limited", "cancelled", "error"],
	verifying: ["active", "repairing", "waiting", "paused", "completed", "budget-limited", "cancelled", "error"],
	repairing: ["verifying", "waiting", "paused", "completed", "budget-limited", "cancelled", "error"],
	waiting: ["active", "paused", "cancelled", "error"],
	paused: ["active", "repairing", "cancelled", "error"],
	completed: ["idle"],
	"budget-limited": ["idle"],
	cancelled: ["idle"],
	error: ["idle"],
};

/** Token/cost telemetry across goal-owned work (truthful; never invented). */
export interface AiraGoalUsage {
	/**
	 * Session message tokens consumed since the goal started (input+output+
	 * cache; includes user turns — labeled "session-attributed", not claimed
	 * as goal-exact). Undefined when the session usage seam is unavailable.
	 */
	sessionTokens?: number;
	/** Child-agent tokens (Phase 9 aggregate delta) when any provider exposed them. */
	childrenTokens?: number;
	/** Verifier tokens (fresh-context verifier runs) when the provider exposed them. */
	verifierTokens?: number;
	/** Total consumed when at least one source is known (sum of known sources). */
	consumedTokens?: number;
	/** Remaining tokens under the configured budget when a budget is set. */
	remainingTokens?: number;
	/** Session cost delta (provider-reported) when available. */
	sessionCost?: number;
	/** Which sources contributed (bounded labels for truthful display). */
	sources: readonly string[];
}

/** Bounded projection of the underlying implementation revision state. */
export interface AiraGoalRevision {
	/** Verification revision id of the last verified change set (undefined pre-verification). */
	revisionId: string | undefined;
	/** Round the revision belongs to. */
	round: number;
	/** Signature of the highest-priority blocking finding (no-progress key). */
	blockingSignature: string | undefined;
}

/** Bounded task-graph projection (TaskManager is the canonical owner). */
export interface AiraGoalTaskProjection {
	/** Tasks completed in the canonical TaskManager graph. */
	completed: number;
	/** Tasks active right now in the canonical TaskManager graph. */
	active: number;
	/** Uncancelled, non-failed tasks in the canonical graph. */
	total: number;
}

/** Bounded projection of the current independent verification result. */
export interface AiraGoalVerificationProjection {
	verdict: string | undefined;
	stale: boolean;
	/** Bounded summary line (≤ 300 chars). */
	summary: string | undefined;
	/** Bounded missing-evidence list (≤ 4 items × 120 chars). */
	missingEvidence: readonly string[];
	/** Verifier driver error when the last run failed (INCONCLUSIVE driver). */
	lastError: string | undefined;
}

/** Bounded host-side workspace ownership counters for the current Goal. */
export interface AiraGoalWorkspaceProjection {
	available: boolean;
	baseline: number;
	owned: number;
	protected: number;
	unowned: number;
}

/** Persistence health (bounded machine-readable goal state on disk). */
export interface AiraGoalPersistenceHealth {
	enabled: boolean;
	status: "ok" | "unavailable" | "failed";
	/** Display path under home. */
	path: string | undefined;
	/** Bounded last failure reason. */
	error: string | undefined;
}

/** Canonical goal snapshot published into AiraSessionState.goal (token-free, UI-ready). */
export interface AiraGoalSnapshot {
	/** Projection of goals.enabled. */
	enabled: boolean;
	/** Projection of goals.auto. */
	auto: "off" | "smart" | "always";
	status: AiraGoalStatus;
	/** Goal identity; undefined while idle. */
	id: string | undefined;
	/** Bounded objective text (≤ 400 chars in the snapshot). */
	objective: string | undefined;
	/** Current implementation round (1 = initial user round). */
	round: number;
	/** Configured maximum rounds. */
	maxRounds: number;
	startedAt: number | undefined;
	updatedAt: number;
	completedAt: number | undefined;
	/** Structured stop/block reason (paused / budget-limited / waiting). */
	stopReason: AiraGoalStopReason | undefined;
	/** Structured waiting seam (future Q&A / permission modes). */
	waiting: AiraGoalWaiting | undefined;
	/** Budget configuration projection (only what is set). */
	budget: { tokens: number | undefined; maxDurationMs: number | undefined };
	usage: AiraGoalUsage;
	/** Revision/progress truth (no-progress detection evidence). */
	revision: AiraGoalRevision | undefined;
	/** Task-graph projection (Phase 9 owner). */
	tasks: AiraGoalTaskProjection;
	/** Verification projection (Phase 8 owner). */
	verification: AiraGoalVerificationProjection;
	/** Workspace ownership is a safety projection, never file contents. */
	workspace?: AiraGoalWorkspaceProjection;
	/** True when a completed goal's verified revision is no longer fresh. */
	staleCompletion: boolean;
	/** True when progress genuinely needs the user (waiting seam). */
	needsUserInput: boolean;
	/** Mode at the last completion boundary (mode semantics evidence). */
	mode: string | undefined;
	/** Bounded last meaningful event (UI hint, not a log). */
	lastEvent: string | undefined;
	persistence: AiraGoalPersistenceHealth;
	/** One-line summary for restrained surfaces. */
	summary: string;
}

/** Bounded persisted goal state (machine-readable; not a transcript). */
export interface AiraPersistedGoal {
	version: number;
	sessionId: string;
	goal: {
		id: string;
		objective: string;
		status: AiraGoalStatus;
		round: number;
		startedAt: number;
		updatedAt: number;
		completedAt?: number;
		stopReason?: AiraGoalStopReason;
		waiting?: AiraGoalWaiting;
		/** Snapshot of the last verification verdict at persist time (bounded). */
		lastVerdict?: "pass" | "fail" | "inconclusive";
		/** Session token consumption so far when known. */
		sessionTokens?: number;
	};
}

export const AIRA_GOAL_PERSISTED_STATE_VERSION = 1;

/** Terminal (no autonomous continuation possible) goal statuses. */
export const AIRA_GOAL_TERMINAL_STATUSES: readonly AiraGoalStatus[] = [
	"completed",
	"budget-limited",
	"cancelled",
	"error",
];

/** Statuses from which the user may clear the goal. */
export const AIRA_GOAL_CLEARABLE_STATUSES: readonly AiraGoalStatus[] = [...AIRA_GOAL_TERMINAL_STATUSES, "paused"];

/** Statuses in which an implementation round can still happen. */
export const AIRA_GOAL_RUNNING_STATUSES: readonly AiraGoalStatus[] = ["active", "repairing", "verifying"];

/** Statuses whose state may be resumed. */
export const AIRA_GOAL_RESUMABLE_STATUSES: readonly AiraGoalStatus[] = ["paused", "waiting"];
