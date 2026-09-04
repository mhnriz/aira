/**
 * Agent Inspector — run state presentation (pure, token-free).
 *
 * Maps an orchestration run record to its truthful status line for the Agent
 * Browser and the child transcript header. Only real state is shown: status +
 * phase from the manager, last activity from the captured event buffer,
 * failure category/message from run telemetry, dependency/capacity wait
 * phases as-is. Nothing here fabricates a state the manager cannot know.
 */
import type { AiraChildRun } from "../../../aira/orchestration/types.ts";

/** Bounded status text for one run ("running · tool", "waiting-capacity", ...). */
export function inspectorRunStatus(run: AiraChildRun): {
	label: string;
	role: "cyan" | "yellow" | "green" | "red" | "muted";
	detail?: string;
} {
	switch (run.status) {
		case "running": {
			const parts = ["running"];
			if (run.activity) {
				parts.push(run.activity);
			}
			return { label: parts.join(" · "), role: "cyan" };
		}
		case "pending":
			return {
				label: run.phase === "waiting-dependency" ? "waiting-dependency" : "waiting-capacity",
				role: "yellow",
				detail: run.phase === "waiting-dependency" ? "waiting on an upstream child" : "waiting for capacity",
			};
		case "completed":
			return { label: "completed", role: "green", detail: run.result?.summary };
		case "failed":
			return {
				label: run.error?.category ?? "failed",
				role: "red",
				detail: run.error?.message ?? "child failed",
			};
		case "timed-out":
			return { label: "timed-out", role: "red", detail: run.error?.message };
		case "cancelled":
			return { label: "cancelled", role: "red", detail: run.error?.message };
		case "rejected":
			return { label: "rejected", role: "red", detail: run.error?.message };
		default:
			return { label: run.status, role: "muted" };
	}
}

/** Compact elapsed/duration text ("1m42s"; settled runs show duration). */
export function inspectorElapsed(run: AiraChildRun, now: number = Date.now()): string | undefined {
	const start = run.startedAt ?? run.createdAt;
	if (run.phase === "settled") {
		return run.durationMs !== undefined ? formatInspectorDuration(run.durationMs) : undefined;
	}
	return start !== undefined ? formatInspectorDuration(Math.max(0, now - start)) : undefined;
}

export function formatInspectorDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) {
		return `${total}s`;
	}
	if (total < 3600) {
		const minutes = Math.floor(total / 60);
		const seconds = total % 60;
		return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
	}
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

/** Bounded one-line task summary for list rows. */
export function inspectorTaskSummary(task: string, max = 64): string {
	const trimmed = task.trim().replace(/\s+/g, " ");
	if (trimmed.length <= max) {
		return trimmed;
	}
	return `${trimmed.slice(0, max - 1)}…`;
}
