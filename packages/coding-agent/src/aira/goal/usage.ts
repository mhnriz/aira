/**
 * Aira goal — usage and budget accounting.
 *
 * Goal execution can multiply costs: root model turns, child agents, and
 * verifier calls. The budget model tracks REAL provider-reported usage when
 * available and NEVER invents numbers. Three truthful sources:
 *
 * - session-attributed: the host session stats delta since the goal started
 *   (includes user turns — labeled as session-attributed, not claimed as
 *   goal-exact);
 * - children: the Phase 9 orchestration aggregate token delta (children run
 *   outside session messages through the stream function);
 * - verifier: fresh-context verifier usage recorded on verification results
 *   (also outside session messages).
 *
 * Budget checks (maxRounds / tokenBudget / maxDurationMs) are evaluated by
 * the manager at completion boundaries; this module provides the pure
 * arithmetic.
 */
import type { AiraChildTokenUsage } from "../orchestration/types.ts";
import type { AiraGoalSettings } from "./settings.ts";
import type { AiraGoalUsage } from "./types.ts";

export interface AiraSessionUsageSnapshot {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
}

export interface AiraGoalUsageInputs {
	/** Current host session stats (undefined when unavailable). */
	session: AiraSessionUsageSnapshot | undefined;
	/** Session stats at goal start (baseline). */
	baseline: AiraSessionUsageSnapshot | undefined;
	/** Current orchestration aggregate child usage (undefined when none). */
	children: AiraChildTokenUsage | undefined;
	/** Child usage already accounted in previous refreshes. */
	childrenBaseline: AiraChildTokenUsage | undefined;
	/** Verifier tokens already accounted (per-result, seen once). */
	verifierTokens: number;
}

/** Compute the aggregate usage projection from its inputs (pure). */
export function computeAiraGoalUsage(inputs: AiraGoalUsageInputs): AiraGoalUsage {
	const sessionTokens = deltaSessionTokens(inputs.baseline, inputs.session);
	const childrenTokens = deltaChildTokens(inputs.childrenBaseline, inputs.children);
	const sources: string[] = [];
	if (sessionTokens !== undefined) {
		sources.push("session");
	}
	if (childrenTokens !== undefined) {
		sources.push("children");
	}
	if (inputs.verifierTokens > 0) {
		sources.push("verifier");
	}
	const known = [sessionTokens ?? 0, childrenTokens ?? 0, inputs.verifierTokens > 0 ? inputs.verifierTokens : 0];
	const consumed = known.some((value) => value > 0) ? known.reduce((sum, value) => sum + value, 0) : undefined;
	return {
		sessionTokens: sessionTokens !== undefined && sessionTokens > 0 ? sessionTokens : undefined,
		childrenTokens: childrenTokens !== undefined && childrenTokens > 0 ? childrenTokens : undefined,
		verifierTokens: inputs.verifierTokens > 0 ? inputs.verifierTokens : undefined,
		consumedTokens: consumed,
		sessionCost: deltaSessionCost(inputs.baseline, inputs.session),
		sources,
	};
}

/** Remaining tokens under the budget when a budget is set (truthful). */
export function remainingAiraGoalTokens(settings: AiraGoalSettings, usage: AiraGoalUsage): number | undefined {
	if (settings.tokenBudget === undefined || usage.consumedTokens === undefined) {
		return undefined;
	}
	return Math.max(0, settings.tokenBudget - usage.consumedTokens);
}

/**
 * Budget boundary verdict at a completion boundary. Returns the structured
 * budget-limited reason when a bound is exhausted, or undefined when
 * continuation is still permitted. `round` is the round that JUST ended.
 */
export function budgetBoundVerdict(
	settings: AiraGoalSettings,
	inputs: {
		round: number;
		startedAt: number;
		now: number;
		usage: AiraGoalUsage;
	},
): { reason: "max-rounds" | "token-budget" | "max-duration"; detail: string } | undefined {
	if (inputs.round > settings.maxRounds) {
		return {
			reason: "max-rounds",
			detail: `round ${inputs.round} exceeds the configured maximum of ${settings.maxRounds} rounds`,
		};
	}
	if (settings.tokenBudget !== undefined && inputs.usage.consumedTokens !== undefined) {
		if (inputs.usage.consumedTokens >= settings.tokenBudget) {
			return {
				reason: "token-budget",
				detail: `consumed ${inputs.usage.consumedTokens} tokens reached the configured budget of ${settings.tokenBudget}`,
			};
		}
	}
	if (settings.maxDurationMs !== undefined && inputs.startedAt > 0) {
		const elapsed = inputs.now - inputs.startedAt;
		if (elapsed >= settings.maxDurationMs) {
			return {
				reason: "max-duration",
				detail: `elapsed ${Math.round(elapsed / 1000)}s reached the configured budget of ${Math.round(settings.maxDurationMs / 1000)}s`,
			};
		}
	}
	return undefined;
}

function deltaSessionTokens(
	baseline: AiraSessionUsageSnapshot | undefined,
	current: AiraSessionUsageSnapshot | undefined,
): number | undefined {
	if (!baseline || !current) {
		return undefined;
	}
	return Math.max(0, current.tokens.total - baseline.tokens.total);
}

function deltaSessionCost(
	baseline: AiraSessionUsageSnapshot | undefined,
	current: AiraSessionUsageSnapshot | undefined,
): number | undefined {
	if (!baseline || !current) {
		return undefined;
	}
	return Math.max(0, current.cost - baseline.cost);
}

function deltaChildTokens(
	baseline: AiraChildTokenUsage | undefined,
	current: AiraChildTokenUsage | undefined,
): number | undefined {
	if (!current) {
		return undefined;
	}
	// A goal that started before any child ran has no baseline: children
	// produced during goal rounds count from zero (never invented, never lost).
	if (!baseline) {
		return current.total;
	}
	return Math.max(0, current.total - baseline.total);
}

/** Aggregate two child-usage snapshots (or-undefined semantics). */
export function mergeAiraChildTokenUsage(
	previous: AiraChildTokenUsage | undefined,
	next: AiraChildTokenUsage | undefined,
): AiraChildTokenUsage | undefined {
	if (!next) {
		return previous;
	}
	if (!previous) {
		return next;
	}
	return {
		input: Math.max(previous.input, next.input),
		output: Math.max(previous.output, next.output),
		cacheRead: Math.max(previous.cacheRead, next.cacheRead),
		cacheWrite: Math.max(previous.cacheWrite, next.cacheWrite),
		total: Math.max(previous.total, next.total),
	};
}
