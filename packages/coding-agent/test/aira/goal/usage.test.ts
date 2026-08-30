/**
 * Phase 10 — goal usage/budget accounting: real provider-reported numbers
 * only, truthful deltas, honest "unknown" when no source is available.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_AIRA_GOAL_SETTINGS } from "../../../src/aira/goal/settings.ts";
import { budgetBoundVerdict, computeAiraGoalUsage, mergeAiraChildTokenUsage } from "../../../src/aira/goal/usage.ts";

const SESSION = {
	tokens: { input: 10_000, output: 2_000, cacheRead: 500, cacheWrite: 0, total: 12_500 },
	cost: 0.05,
};
const CHILDREN = { input: 3_000, output: 500, cacheRead: 0, cacheWrite: 0, total: 3_500 };

describe("Aira goal usage accounting (Phase 10)", () => {
	it("aggregates session delta + children delta + verifier tokens without double counting", () => {
		const usage = computeAiraGoalUsage({
			session: SESSION,
			baseline: { tokens: { input: 2_000, output: 500, cacheRead: 100, cacheWrite: 0, total: 2_600 }, cost: 0.01 },
			children: CHILDREN,
			childrenBaseline: { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0, total: 1_200 },
			verifierTokens: 900,
		});
		expect(usage.sessionTokens).toBe(9_900);
		expect(usage.childrenTokens).toBe(2_300);
		expect(usage.verifierTokens).toBe(900);
		expect(usage.consumedTokens).toBe(13_100);
		expect(usage.sessionCost).toBe(0.04);
		expect(usage.sources).toEqual(["session", "children", "verifier"]);
	});

	it("never invents numbers: unknown sources stay undefined", () => {
		const usage = computeAiraGoalUsage({
			session: undefined,
			baseline: undefined,
			children: undefined,
			childrenBaseline: undefined,
			verifierTokens: 0,
		});
		expect(usage.consumedTokens).toBeUndefined();
		expect(usage.sessionTokens).toBeUndefined();
		expect(usage.childrenTokens).toBeUndefined();
		expect(usage.sources).toEqual([]);
	});

	it("deltas are clamped at zero (usage never goes backward)", () => {
		const usage = computeAiraGoalUsage({
			session: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 },
			baseline: SESSION,
			children: CHILDREN,
			childrenBaseline: CHILDREN,
			verifierTokens: 0,
		});
		expect(usage.sessionTokens).toBeUndefined();
		expect(usage.childrenTokens).toBeUndefined();
	});

	it("child baselines merge monotonically (max semantics)", () => {
		const merged = mergeAiraChildTokenUsage(
			{ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
			{ input: 200, output: 50, cacheRead: 10, cacheWrite: 0, total: 260 },
		);
		expect(merged).toEqual({ input: 200, output: 50, cacheRead: 10, cacheWrite: 0, total: 260 });
		expect(mergeAiraChildTokenUsage(undefined, CHILDREN)).toEqual(CHILDREN);
		expect(mergeAiraChildTokenUsage(CHILDREN, undefined)).toEqual(CHILDREN);
	});

	it("budget bounds: max rounds, token budget, duration — truthful reasons", () => {
		const settings = { ...DEFAULT_AIRA_GOAL_SETTINGS, tokenBudget: 10_000, maxDurationMs: 60_000 };
		// rounds: continuation to round 5 exceeds maxRounds 4
		expect(budgetBoundVerdict(settings, { round: 5, startedAt: 0, now: 1_000, usage: { sources: [] } })?.reason).toBe(
			"max-rounds",
		);
		expect(
			budgetBoundVerdict(settings, {
				round: 2,
				startedAt: 0,
				now: 1_000,
				usage: { consumedTokens: 12_000, sources: ["session"] },
			})?.reason,
		).toBe("token-budget");
		expect(
			budgetBoundVerdict(settings, {
				round: 2,
				startedAt: 1_000,
				now: 120_000,
				usage: { consumedTokens: 100, sources: ["session"] },
			})?.reason,
		).toBe("max-duration");
		// within bounds: no verdict
		expect(
			budgetBoundVerdict(settings, {
				round: 2,
				startedAt: 0,
				now: 30_000,
				usage: { consumedTokens: 100, sources: ["session"] },
			}),
		).toBeUndefined();
		// token budget set but consumption unknown: no invented verdict
		expect(budgetBoundVerdict(settings, { round: 2, startedAt: 0, now: 0, usage: { sources: [] } })).toBeUndefined();
	});
});
