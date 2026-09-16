/**
 * Aira orchestration — shared contract types.
 *
 * Phase 9: native multi-agent orchestration. The root Aira session owns one
 * per-session orchestration manager; children are bounded fresh-context model
 * runs (an explicit context envelope + a capability-derived tool set — never
 * the parent conversation, never shared mutable state). This module defines
 * the task contract, the structured child result contract, and the bounded
 * canonical telemetry shapes consumed by `/agents`, `/status`, `/doctor`,
 * and the Workbench (ADR-005: one canonical state owner).
 *
 * Everything here is deliberately small: five lightweight roles, one
 * structured result shape, and bounded snapshot lists. No persistent
 * workflow database, no agent catalog, no worker-to-worker messaging.
 *
 * Child event/transcript data (Agent Inspector) lives in `events.ts` and is
 * orchestration-owned only — it never enters `AiraSessionState`.
 */

import type { AiraChildActivity } from "./events.ts";

/** Lightweight task roles (small fixed taxonomy; extensible later). */
export type AiraChildRole = "explore" | "research" | "review" | "test" | "implement";

/** Lifecycle truth of one child run. */
export type AiraChildRunStatus =
	| "pending" // queued: waiting for dependencies and/or capacity
	| "running" // model invocation in flight
	| "completed" // structured result normalized and accepted
	| "failed" // failed / driver error / unparseable result
	| "cancelled" // aborted by user, scheduler, or session teardown
	| "timed-out" // exceeded its timeout
	| "rejected"; // refused before launch (invalid request / mode gate / model unavailable)

/** Scheduler phase of a child (what it is waiting on or doing). */
export type AiraChildPhase = "waiting-dependency" | "waiting-capacity" | "running" | "settled";

/** Failure categories surfaced in canonical telemetry (bounded, actionable). */
export type AiraChildFailureCategory =
	| "invalid-request"
	| "mode-refused"
	| "model-unavailable"
	| "driver"
	| "permission-denied"
	| "tool-budget-exceeded"
	| "timeout"
	| "cancelled"
	| "dependency-failed";

/**
 * Truthful failure classification: did the delegated work fail, or could a
 * required Aira capability / provider / environment / child-session mechanism
 * not run the work at all? Deterministic classification lives in ./failures.ts.
 */
export type AiraChildFailureKind =
	| "task_failure"
	| "capability_failure"
	| "environment_failure"
	| "timeout"
	| "cancelled"
	| "unknown_failure";

/** Whether the delegated work was actually attempted before the failure. */
export type AiraChildTaskExecutionStatus = "not_attempted" | "attempted" | "unknown";

/** Advisory retryability metadata. Never triggers a retry by itself. */
export type AiraRetryableHint = "yes" | "no" | "unknown";

/** A required child capability that the runtime could not grant. */
export interface AiraChildCapabilityGap {
	capability: string;
	component: string;
	operation: string;
	message: string;
}

/**
 * Bounded, privacy-safe diagnostics captured when a child's final message could
 * not be parsed into the result contract. Carries provenance (hash, length,
 * stop reason) and short secret-sanitized excerpts — never the raw body.
 */
export interface AiraChildResultDiagnostics {
	/** Provider stop reason of the unparseable message ("stop", "length", ...). */
	stopReason: string;
	/** Character length of the raw unparsed final message. */
	rawLength: number;
	/** SHA-256 of the raw unparsed final message (provenance, not content). */
	rawSha256: string;
	/** Secret-sanitized head excerpt (bounded). */
	head: string;
	/** Secret-sanitized tail excerpt (bounded). */
	tail: string;
	/** Whether a successful edit/write landed before the parse failure. */
	workspaceMutated: boolean;
}

/**
 * Bounded, secret-sanitized failure envelope. Preserves the original error
 * evidence (message, code, component, operation) while exposing the truthful
 * failure kind, so the parent can decide the next action.
 */
export interface AiraChildFailureInfo {
	kind: AiraChildFailureKind;
	category: AiraChildFailureCategory;
	message: string;
	retryable: boolean;
	retryableHint: AiraRetryableHint;
	code?: string;
	component?: string;
	operation?: string;
	taskStatus: AiraChildTaskExecutionStatus;
	/** Required capabilities that were unavailable when the run launched. */
	capabilityGaps?: AiraChildCapabilityGap[];
	/** Bounded parse diagnostics when a result could not be parsed (never the raw body). */
	diagnostics?: AiraChildResultDiagnostics;
}

/** One dispatchable child task (the parent-owned contract). */
export interface AiraChildTaskSpec {
	/**
	 * Optional caller-chosen task id used for dependency edges. Defaults to a
	 * generated id when absent; must be unique within the batch.
	 */
	id?: string;
	/** Lightweight role: explore | research | review | test | implement. */
	role: AiraChildRole;
	/** Bounded task objective (the child's explicit context — never the parent transcript). */
	task: string;
	/** Task ids in the SAME batch that must complete (successfully) first. */
	dependencies?: string[];
	/** Relevant file paths the child may start from (context references, bounded). */
	files?: string[];
	/** Optional bounded parent-provided context (evidence selection, bounded). */
	context?: string;
	/** Explicit model selector "provider/model". Inherits the session model when absent. */
	model?: string;
	/** Per-task timeout override (bounded; default comes from settings). */
	timeoutMs?: number;
	/** Explicit host-checkable capabilities required by this task. */
	requiredCapabilities?: readonly AiraChildCapabilityRequirement[];
}

export type AiraChildCapabilityRequirement = "process" | "mutation" | "browser";

/** The structured result a child must return (parsed + normalized). */
export interface AiraChildResult {
	/** "completed" | "failed" — an explicit child-level verdict. */
	status: "completed" | "failed";
	/** Bounded summary of what the child did. */
	summary: string;
	/** Bounded findings list. */
	findings: string[];
	/** Concrete evidence references (paths/commands/observations). */
	evidence: string[];
	/** Files the child read/considered relevant. */
	relevantFiles: string[];
	/** Files the child changed (workspace mutation evidence). */
	changedFiles: string[];
	/** Tests/checks the child performed. */
	tests: string[];
	/** Explicit errors the child reports. */
	errors: string[];
}

/** Real provider token usage when the provider exposes it (never invented). */
export interface AiraChildTokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/** One full child run record (manager's source of truth, bounded history). */
export interface AiraChildRun {
	/** Run identity (unique per dispatch). */
	id: string;
	/** Task label within its batch (parent-chosen or generated). */
	taskId: string;
	/** When the run record was created. */
	createdAt: number;
	role: AiraChildRole;
	/** Bounded task text. */
	task: string;
	/** Dependency task ids (same batch). */
	dependencies: string[];
	status: AiraChildRunStatus;
	phase: AiraChildPhase;
	/** Requested model selector ("inherit" resolves to the session model). */
	model: string | undefined;
	/** The model identity that actually ran (truthful telemetry). */
	resolvedModel?: string;
	startedAt?: number;
	completedAt?: number;
	durationMs?: number;
	/** Structured result when the child settled with a parseable result. */
	result?: AiraChildResult;
	/** Bounded failure telemetry (kind + category + preserved evidence). */
	error?: AiraChildFailureInfo;
	/** Real provider token usage when available. */
	tokenUsage?: AiraChildTokenUsage;
	/**
	 * Last truthful activity while running (derived from captured events;
	 * undefined until the first event). Feeds "running · tool" style rows.
	 */
	activity?: AiraChildActivity;
	/** Bounded host-side budget telemetry. */
	toolBudgetUsed?: number;
	toolBudgetLimit?: number;
	/** Number of progress-gated budget extensions granted for this run. */
	toolBudgetExtensions?: number;
	lastActivityAt?: number;
	/** Required capabilities the runtime could not grant (bounded metadata). */
	capabilityGaps?: AiraChildCapabilityGap[];
}

/** UI-ready child row (bounded; derived from AiraChildRun). */
export interface AiraChildSnapshot {
	id: string;
	taskId: string;
	role: AiraChildRole;
	/** Task text truncated to a bounded summary length. */
	task: string;
	status: AiraChildRunStatus;
	phase: AiraChildPhase;
	/** Last truthful activity while running (Agent Inspector rows). */
	activity?: AiraChildActivity;
	toolBudgetUsed?: number;
	toolBudgetLimit?: number;
	toolBudgetExtensions?: number;
	lastActivityAt?: number;
	model: string | undefined;
	elapsedMs?: number;
	dependencies: string[];
	/** One-line result summary when settled with a result. */
	resultSummary?: string;
	tokenUsage?: AiraChildTokenUsage;
	/** Bounded failure info (kind + category + preserved evidence) when the child failed. */
	error?: AiraChildFailureInfo;
	/** Required capabilities the runtime could not grant (bounded metadata). */
	capabilityGaps?: AiraChildCapabilityGap[];
}

/** Bounded settled-result evidence row. */
export interface AiraChildResultSummary {
	id: string;
	taskId: string;
	role: AiraChildRole;
	status: AiraChildRunStatus;
	summary: string;
	durationMs: number;
	model: string | undefined;
	tokenUsage?: AiraChildTokenUsage;
}

/** Bounded failure telemetry row (what the future UI needs to show). */
export interface AiraChildFailure {
	id: string;
	taskId: string;
	role: AiraChildRole;
	/** Truthful failure classification (task vs capability vs environment...). */
	kind: AiraChildFailureKind;
	category: AiraChildFailureCategory;
	message: string;
	timestamp: number;
	retryable: boolean;
	retryableHint: AiraRetryableHint;
	/** Whether the delegated work was attempted before the failure. */
	taskStatus: AiraChildTaskExecutionStatus;
	/** Preserved structured evidence when the failure exposed it. */
	code?: string;
	component?: string;
	operation?: string;
	/** Bounded parse diagnostics when the failure was an unparseable result. */
	diagnostics?: AiraChildResultDiagnostics;
}

/** Canonical orchestration snapshot published into AiraSessionState.orchestration. */
export interface AiraOrchestrationStatus {
	/** Projection of orchestration.enabled. */
	enabled: boolean;
	/** idle (no children), active (children running/queued), degraded (internal error). */
	status: "idle" | "active" | "degraded";
	/** Currently running children. */
	runningCount: number;
	/** Children waiting on dependencies or capacity. */
	queuedCount: number;
	/** Maximum parallel children (settings projection). */
	maxConcurrency: number;
	/** Bounded child table (most recent first; capped). */
	children: AiraChildSnapshot[];
	/** Bounded settled results (most recent first; capped). */
	recentResults: AiraChildResultSummary[];
	/** Bounded failure telemetry (most recent first; capped). */
	failures: AiraChildFailure[];
	/** Aggregate real token usage across children when any provider exposed it. */
	aggregateTokenUsage?: AiraChildTokenUsage;
	/** When the current orchestration epoch started (kept across batches until idle). */
	epochStartedAt?: number;
	/** Human-line summary for restrained surfaces ("2 running · 1 queued"). */
	summary: string;
	updatedAt: number;
}

/** Batch dispatch result returned to the caller (tools/host). */
export interface AiraOrchestrationBatchResult {
	ok: boolean;
	/** Batch identity. */
	batchId?: string;
	/** Per-task outcomes: accepted run ids, or rejection reasons. */
	tasks: Array<{
		taskId: string;
		role: AiraChildRole;
		runId?: string;
		accepted: boolean;
		reason?: string;
		/** Settled result when the batch awaited completion. */
		result?: AiraChildResult | AiraChildRunStatus;
		/**
		 * Settled failure classification when the run did not produce a usable
		 * result (failed/rejected/cancelled/timed-out). Lets the parent tell a
		 * capability failure apart from a real task failure.
		 */
		failure?: AiraChildFailure;
	}>;
}
