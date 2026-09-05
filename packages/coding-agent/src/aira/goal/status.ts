/**
 * Aira goal — restrained summaries for `/status`, `/goal`, and `/doctor`.
 *
 * Token-free projections of the canonical `state.goal` snapshot. `/status`
 * keeps ONE restrained line; `/goal` renders a bounded report (the future
 * Workbench owns the detailed projection — see UI_BACKLOG).
 */
import type { AiraGoalSnapshot } from "./types.ts";

/** Compact one-line goal summary for `/status` (restrained). */
export function summarizeAiraGoal(goal: AiraGoalSnapshot | undefined): string | undefined {
	if (!goal) {
		return undefined;
	}
	return goal.summary;
}

/** Bounded report for the `/goal` command (status surface). */
export function formatAiraGoalReport(goal: AiraGoalSnapshot | undefined): string {
	if (!goal || goal.status === "idle") {
		const settings = goal
			? `enabled: ${goal.enabled} · auto: ${goal.auto} · max rounds: ${goal.maxRounds}`
			: undefined;
		return ["goal: idle", ...(settings ? [settings] : [])].join("\n");
	}
	const lines = [
		`goal: ${goal.objective ?? "(no objective)"}`,
		`status: ${goal.status}${goal.stopReason ? ` · ${goal.stopReason}` : ""}`,
		`round: ${goal.round}/${goal.maxRounds}`,
	];
	if (goal.startedAt) {
		lines.push(`elapsed: ${formatElapsed(goal.startedAt, goal.completedAt ?? Date.now())}`);
	}
	if (goal.tasks.total > 0) {
		lines.push(`tasks: ${goal.tasks.completed}/${goal.tasks.total} done · ${goal.tasks.active} active`);
	}
	if (goal.verification.verdict) {
		lines.push(
			`verify: ${goal.verification.verdict}${goal.verification.stale ? " (stale)" : ""}${goal.verification.lastError ? ` · error: ${goal.verification.lastError}` : ""}`,
		);
	}
	const tokens = usageLine(goal);
	if (tokens) {
		lines.push(tokens);
	}
	if (goal.waiting) {
		lines.push(
			`waiting: ${goal.waiting.reason} — ${goal.waiting.detail}${goal.waiting.ask ? ` (ask: ${goal.waiting.ask})` : ""}`,
		);
	}
	if (goal.staleCompletion) {
		lines.push("note: the verified implementation changed after completion (stale)");
	}
	if (goal.lastEvent) {
		lines.push(`last: ${goal.lastEvent}`);
	}
	lines.push(`controls: /goal stop · /goal resume · /goal clear`);
	return lines.join("\n");
}

export function formatAiraGoalIdleLine(): string {
	return "goal: idle";
}

function usageLine(goal: AiraGoalSnapshot): string | undefined {
	const parts: string[] = [];
	if (goal.usage.consumedTokens !== undefined) {
		const remaining = goal.usage.remainingTokens !== undefined ? ` / ${goal.usage.remainingTokens} left` : "";
		parts.push(`tokens: ${goal.usage.consumedTokens} consumed${remaining}`);
	}
	if (goal.budget.tokens !== undefined) {
		parts.push(`budget: ${goal.budget.tokens}`);
	}
	if (goal.budget.maxDurationMs !== undefined) {
		parts.push(`duration: ${Math.round(goal.budget.maxDurationMs / 1000)}s`);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatElapsed(startedAt: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m ${rest}s`;
}
