/**
 * Aira orchestration — canonical-state snapshot shapes.
 *
 * `AiraOrchestrationStatus` is the bounded, token-free, TUI-independent
 * snapshot published into `AiraSessionState.orchestration` (ADR-005). It
 * carries child rows, bounded settled results, bounded failure telemetry,
 * concurrency truth, aggregate real token usage (when the provider exposes
 * it), and a one-line summary for restrained surfaces. Detailed child
 * transcripts never enter canonical state; full run records stay in the
 * manager.
 */
import { boundChildText } from "./envelope.ts";
import type {
	AiraChildFailure,
	AiraChildResultSummary,
	AiraChildRun,
	AiraChildSnapshot,
	AiraChildTokenUsage,
	AiraOrchestrationStatus,
} from "./types.ts";

export const MAX_CHILDREN_IN_SNAPSHOT = 12;
export const MAX_RESULTS_IN_SNAPSHOT = 8;
export const MAX_FAILURES_IN_SNAPSHOT = 6;
export const MAX_TASK_TEXT_IN_SNAPSHOT = 100;

export function initialAiraOrchestrationStatus(enabled: boolean, maxConcurrency: number): AiraOrchestrationStatus {
	return {
		enabled,
		status: "idle",
		runningCount: 0,
		queuedCount: 0,
		maxConcurrency,
		children: [],
		recentResults: [],
		failures: [],
		summary: "idle",
		updatedAt: Date.now(),
	};
}

/** Project one run into its bounded UI-ready snapshot row. */
export function toAiraChildSnapshot(run: AiraChildRun): AiraChildSnapshot {
	return {
		id: run.id,
		taskId: run.taskId,
		role: run.role,
		task: boundChildText(run.task, MAX_TASK_TEXT_IN_SNAPSHOT),
		status: run.status,
		phase: run.phase,
		model: run.model,
		elapsedMs: run.durationMs ?? (run.startedAt !== undefined ? Date.now() - run.startedAt : undefined),
		dependencies: run.dependencies,
		...(run.result ? { resultSummary: run.result.summary } : {}),
		...(run.tokenUsage ? { tokenUsage: run.tokenUsage } : {}),
		...(run.error ? { error: run.error } : {}),
	};
}

/** Project one settled run into its bounded result row. */
export function toAiraChildResultSummary(run: AiraChildRun): AiraChildResultSummary {
	return {
		id: run.id,
		taskId: run.taskId,
		role: run.role,
		status: run.status,
		summary: run.result?.summary ?? run.error?.message ?? run.status,
		durationMs: run.durationMs ?? 0,
		model: run.resolvedModel ?? run.model,
		...(run.tokenUsage ? { tokenUsage: run.tokenUsage } : {}),
	};
}

/** Project one failed/cancelled/timed-out run into its bounded failure row. */
export function toAiraChildFailure(run: AiraChildRun): AiraChildFailure {
	return {
		id: run.id,
		taskId: run.taskId,
		role: run.role,
		category: run.error?.category ?? "driver",
		message: run.error?.message ?? run.status,
		timestamp: run.completedAt ?? Date.now(),
		retryable: run.error?.retryable ?? false,
	};
}

/** Aggregate real token usage across runs (only when every contributing run exposed it). */
export function aggregateAiraTokenUsage(runs: readonly AiraChildRun[]): AiraChildTokenUsage | undefined {
	let hasAny = false;
	const total: AiraChildTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	for (const run of runs) {
		const usage = run.tokenUsage;
		if (!usage) {
			continue;
		}
		hasAny = true;
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.total += usage.total;
	}
	return hasAny ? total : undefined;
}

/** One-line orchestration summary for restrained surfaces ("idle", "2 running · 1 queued"). */
export function summarizeAiraOrchestration(status: AiraOrchestrationStatus | undefined): string | undefined {
	if (!status) {
		return undefined;
	}
	if (!status.enabled) {
		return "disabled";
	}
	if (status.status === "active") {
		const parts: string[] = [];
		if (status.runningCount > 0) {
			parts.push(`${status.runningCount} running`);
		}
		if (status.queuedCount > 0) {
			parts.push(`${status.queuedCount} queued`);
		}
		if (parts.length > 0) {
			return parts.join(" · ");
		}
		return "active";
	}
	return "idle";
}
