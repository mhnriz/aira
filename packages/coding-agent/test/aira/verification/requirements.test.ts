/**
 * Phase 8 — requirement model: bounded normalization of verifier-emitted
 * requirements/findings/evidence, explicit-vs-inferred distinction, counts.
 */
import { describe, expect, it } from "vitest";
import {
	countRequirementStatuses,
	MAX_FINDINGS,
	MAX_MISSING_EVIDENCE_ITEMS,
	MAX_REQUIREMENT_TEXT_CHARS,
	MAX_VERIFICATION_REQUIREMENTS,
	normalizeEvidenceItems,
	normalizeFindings,
	normalizeMissingEvidence,
	normalizeScopeAssessment,
	normalizeVerificationRequirements,
} from "../../../src/aira/verification/requirements.ts";

describe("Aira verification requirement model (Phase 8)", () => {
	it("normalizes a valid requirement list preserving kind/status", () => {
		const out = normalizeVerificationRequirements([
			{ id: "R1", text: "player stays visible", kind: "explicit", status: "verified" },
			{ id: "R2", text: "stream switch succeeds", kind: "explicit", status: "verified" },
			{ id: "R3", text: "no console exception", kind: "inferred", status: "unverifiable" },
		]);
		expect(out).toEqual([
			{ id: "R1", text: "player stays visible", kind: "explicit", status: "verified" },
			{ id: "R2", text: "stream switch succeeds", kind: "explicit", status: "verified" },
			{ id: "R3", text: "no console exception", kind: "inferred", status: "unverifiable" },
		]);
	});

	it("bounds the checklist and dedupes ids", () => {
		const many = Array.from({ length: 30 }, (_, index) => ({ id: `R${index + 1}`, text: `req ${index + 1}` }));
		const out = normalizeVerificationRequirements(many);
		expect(out.length).toBe(MAX_VERIFICATION_REQUIREMENTS);
		expect(new Set(out.map((r) => r.id)).size).toBe(out.length);
		// Duplicate ids are dropped.
		const dupes = normalizeVerificationRequirements([
			{ id: "R1", text: "a" },
			{ id: "R1", text: "b" },
		]);
		expect(dupes.length).toBe(1);
	});

	it("falls back to stable ids and explicit kind for malformed entries", () => {
		const out = normalizeVerificationRequirements([{ text: "objective requirement" }, 42, { id: "R9" }]);
		expect(out).toEqual([{ id: "R1", text: "objective requirement", kind: "explicit", status: "unverifiable" }]);
	});

	it("bounds requirement text", () => {
		const out = normalizeVerificationRequirements([{ id: "R1", text: "x".repeat(MAX_REQUIREMENT_TEXT_CHARS + 100) }]);
		expect(out[0].text.length).toBeLessThanOrEqual(MAX_REQUIREMENT_TEXT_CHARS);
	});

	it("normalizes findings with severity bounds and requirement anchors", () => {
		const out = normalizeFindings([
			{ severity: "blocking", requirementId: "R1", message: "player remains black", evidence: "console: TypeError" },
			{ severity: "nonsense", message: "falls back to warning", evidence: 42 },
			{ message: "" },
		]);
		expect(out.length).toBe(2);
		expect(out[0].severity).toBe("blocking");
		expect(out[1].severity).toBe("warning");
		expect(out[1].evidence).toBeUndefined();
	});

	it("bounds finding count and message length", () => {
		const out = normalizeFindings(
			Array.from({ length: 30 }, (_, index) => ({ severity: "info", message: `f${index}` })),
		);
		expect(out.length).toBeLessThanOrEqual(MAX_FINDINGS);
		const long = normalizeFindings([{ message: "y".repeat(600) }]);
		expect(long[0].message.length).toBeLessThanOrEqual(400);
	});

	it("normalizes evidence items and missing-evidence lists with caps", () => {
		const evidence = normalizeEvidenceItems([
			{ category: "execution", label: "tests", summary: "npm test exited 0" },
			{ category: "other", label: "x", summary: "unknown category becomes verifier" },
		]);
		expect(evidence[0].category).toBe("execution");
		expect(evidence[1].category).toBe("verifier");

		const missing = normalizeMissingEvidence(Array.from({ length: 20 }, (_, index) => `missing ${index}`));
		expect(missing.length).toBe(MAX_MISSING_EVIDENCE_ITEMS);
		expect(normalizeMissingEvidence(["a", "a"])).toEqual(["a"]);
	});

	it("normalizes scope assessment", () => {
		expect(normalizeScopeAssessment({ verdict: "drift", notes: ["config changed", "generated artifact"] })).toEqual({
			verdict: "drift",
			notes: ["config changed", "generated artifact"],
		});
		expect(normalizeScopeAssessment({ verdict: "bogus" })).toEqual({ verdict: "uncertain", notes: [] });
		expect(normalizeScopeAssessment(undefined)).toEqual({ verdict: "uncertain", notes: [] });
	});

	it("counts verified requirements for the UI snapshot", () => {
		const { total, verified } = countRequirementStatuses(
			normalizeVerificationRequirements([
				{ id: "R1", text: "a", status: "verified" },
				{ id: "R2", text: "b", status: "unmet" },
				{ id: "R3", text: "c", status: "unverifiable" },
			]),
		);
		expect(total).toBe(3);
		expect(verified).toBe(1);
	});
});
