/**
 * Phase 10 — SMART goal promotion eligibility: trivial objectives never
 * create durable goals; non-trivial objectives do; `always` promotes
 * everything; `off` never promotes automatically.
 */
import { describe, expect, it } from "vitest";
import { decideAiraGoalPromotion, isTrivialGoalObjective } from "../../../src/aira/goal/eligibility.ts";

describe("Aira goal promotion eligibility (Phase 10)", () => {
	it("classifies trivial objectives (no durable goal in smart mode)", () => {
		const trivial = [
			"fix the typo in the header",
			"fix spelling in README",
			"add a comment to the seek function",
			"rename seek to seekTo",
			"fix spacing in player.ts",
			"reformat the file",
			"add a newline",
			"update the changelog",
			"bump version to 1.2.3",
			"what does seek do?",
			"explain the stream switch",
			"/status",
			"ok",
			"thanks",
		];
		for (const text of trivial) {
			expect(isTrivialGoalObjective(text), text).toBe(true);
			expect(decideAiraGoalPromotion("smart", text).promote, text).toBe(false);
		}
	});

	it("classifies substantial objectives (durable goal in smart mode)", () => {
		const substantial = [
			"implement authentication middleware for the API",
			"fix the bug where the player stays black after switching streams",
			"refactor the stream module into separate concerns",
			"add a new browser-based settings panel",
			"cross-module change: move session state into its own package",
			"write a test suite for the scheduler",
			"investigate the crash when resuming sessions",
			"delegate the repository mapping to child agents and integrate results",
			"multi-step feature: add user accounts with roles",
		];
		for (const text of substantial) {
			expect(isTrivialGoalObjective(text), text).toBe(false);
			expect(decideAiraGoalPromotion("smart", text).promote, text).toBe(true);
		}
	});

	it("always promotes everything; off never promotes", () => {
		for (const text of ["fix typo", "implement auth", "hello"]) {
			expect(decideAiraGoalPromotion("always", text).promote).toBe(true);
			expect(decideAiraGoalPromotion("off", text).promote).toBe(false);
		}
	});

	it("empty objectives are trivial (never promoted)", () => {
		expect(isTrivialGoalObjective("")).toBe(true);
		expect(isTrivialGoalObjective("   ")).toBe(true);
	});

	it("objective text is bounded before classification", () => {
		const long = "implement auth ".repeat(200);
		expect(isTrivialGoalObjective(long)).toBe(false);
		expect(decideAiraGoalPromotion("smart", long).promote).toBe(true);
	});
});
