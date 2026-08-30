/**
 * Phase 10 — no-progress and repeated-verdict detection: bounded autonomy
 * never relies on round numbers alone.
 */
import { describe, expect, it } from "vitest";
import {
	type AiraRoundObservation,
	blockingFindingSignature,
	isNoProgress,
	isRepeatedVerdict,
	roundFingerprint,
} from "../../../src/aira/goal/progress.ts";

const ROUND_1_A: AiraRoundObservation = {
	revisionId: "rev-1",
	blockingFinding: "player remains black after second switch",
	verdict: "fail",
};
const ROUND_1_B: AiraRoundObservation = {
	revisionId: "rev-1",
	blockingFinding: "player remains black after second switch",
	verdict: "fail",
};

describe("Aira goal progress detection (Phase 10)", () => {
	it("identical revision + identical blocking finding across rounds is no-progress", () => {
		expect(isNoProgress(ROUND_1_A, ROUND_1_B)).toBe(true);
	});

	it("a changed revision with the same finding is progress (repair moved the implementation)", () => {
		expect(isNoProgress(ROUND_1_A, { ...ROUND_1_B, revisionId: "rev-2" })).toBe(false);
	});

	it("a changed blocking finding with the same revision is progress", () => {
		expect(isNoProgress(ROUND_1_A, { ...ROUND_1_B, blockingFinding: "different blocker" })).toBe(false);
	});

	it("missing observations are never no-progress", () => {
		expect(isNoProgress(undefined, ROUND_1_A)).toBe(false);
		expect(isNoProgress(ROUND_1_A, { revisionId: undefined, blockingFinding: undefined, verdict: "fail" })).toBe(
			false,
		);
	});

	it("fingerprints are stable and bounded", () => {
		expect(roundFingerprint(ROUND_1_A)).toBe("rev-1\u000040:player remains black after second switch");
		expect(roundFingerprint({ revisionId: "x", blockingFinding: undefined, verdict: "fail" })).toBe("x\u0000-");
		expect(blockingFindingSignature("  a   b  ")).toBe(blockingFindingSignature("a b"));
	});

	it("repeated verdict requires two identical FAIL observations with a blocking finding", () => {
		expect(isRepeatedVerdict(ROUND_1_A, ROUND_1_B)).toBe(true);
		expect(isRepeatedVerdict(ROUND_1_A, { ...ROUND_1_B, blockingFinding: "other" })).toBe(false);
		expect(isRepeatedVerdict(ROUND_1_A, { revisionId: "r", blockingFinding: undefined, verdict: "fail" })).toBe(
			false,
		);
		expect(isRepeatedVerdict(ROUND_1_A, { revisionId: "r", blockingFinding: "x", verdict: "inconclusive" })).toBe(
			false,
		);
		expect(isRepeatedVerdict(undefined, ROUND_1_A)).toBe(false);
		expect(isRepeatedVerdict(ROUND_1_A, { ...ROUND_1_B, verdict: "pass" })).toBe(false);
	});
});
