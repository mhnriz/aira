/**
 * Phase 8 — automatic-verification eligibility: trivial-task skipping,
 * work detection, off/smart/always semantics.
 */
import { describe, expect, it } from "vitest";
import {
	type AiraChangeFile,
	decideAutomaticVerification,
	isDocLikePath,
	isTrivialImplementationChange,
} from "../../../src/aira/verification/eligibility.ts";

const file = (path: string, status: AiraChangeFile["status"] = "modified", added = 1, deleted = 1): AiraChangeFile => ({
	path,
	status,
	added,
	deleted,
});

describe("Aira verification eligibility (Phase 8)", () => {
	it("classifies doc/comment/declaration paths as trivial", () => {
		expect(isDocLikePath("README.md")).toBe(true);
		expect(isDocLikePath("docs/guide.md")).toBe(true);
		expect(isDocLikePath("src/CHANGELOG.md")).toBe(true);
		expect(isDocLikePath("LICENSE")).toBe(true);
		expect(isDocLikePath(".github/workflows/ci.yml")).toBe(true);
		expect(isDocLikePath("package.json")).toBe(true);
		expect(isDocLikePath("src/player.ts")).toBe(false);
		expect(isDocLikePath("app/views/player.vue")).toBe(false);
	});

	it("a doc-only change is trivial even with many files", () => {
		expect(
			isTrivialImplementationChange(
				[file("README.md", "modified", 10, 3), file("docs/guide.md", "added")],
				undefined,
			),
		).toBe(true);
	});

	it("a one-line code rename with clean diagnostics is trivial", () => {
		expect(isTrivialImplementationChange([file("src/player.ts", "modified", 1, 1)], true)).toBe(true);
	});

	it("a code change without clean diagnostics evidence is NOT trivial", () => {
		expect(isTrivialImplementationChange([file("src/player.ts", "modified", 1, 1)], undefined)).toBe(false);
		expect(isTrivialImplementationChange([file("src/player.ts", "modified", 1, 1)], false)).toBe(false);
	});

	it("multi-file or larger code changes are non-trivial", () => {
		expect(
			isTrivialImplementationChange(
				[file("src/player.ts", "modified", 1, 1), file("src/stream.ts", "modified", 1, 1)],
				true,
			),
		).toBe(false);
		expect(isTrivialImplementationChange([file("src/player.ts", "modified", 40, 12)], true)).toBe(false);
		// A single-file rename with unknown line counts (untracked) is non-trivial.
		expect(isTrivialImplementationChange([file("src/new.ts", "untracked", 0, 0)], true)).toBe(false);
	});

	it("off never runs automatically", () => {
		expect(decideAutomaticVerification("off", true, [file("src/a.ts")], true).run).toBe(false);
	});

	it("work detection gates every auto mode", () => {
		for (const auto of ["smart", "always"] as const) {
			expect(decideAutomaticVerification(auto, false, [file("src/a.ts")], true).run).toBe(false);
		}
	});

	it("smart skips trivial work without verifier tokens", () => {
		const decision = decideAutomaticVerification("smart", true, [file("README.md", "modified", 3, 1)], true);
		expect(decision.run).toBe(false);
		expect(decision.reason).toContain("trivial");
	});

	it("smart verifies non-trivial work; always verifies even trivial work", () => {
		expect(decideAutomaticVerification("smart", true, [file("src/player.ts", "modified", 5, 5)], true).run).toBe(
			true,
		);
		expect(decideAutomaticVerification("always", true, [file("README.md")], true).run).toBe(true);
	});

	it("empty change sets count as trivial (nothing to verify)", () => {
		expect(decideAutomaticVerification("smart", true, [], true).run).toBe(false);
	});
});
