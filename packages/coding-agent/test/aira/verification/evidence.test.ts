/**
 * Phase 8 — evidence aggregation: bounded, provider-independent bundles from
 * canonical snapshots; missing-evidence semantics; budgets; redaction.
 */
import { describe, expect, it } from "vitest";
import type { AiraBrowserStatus } from "../../../src/aira/browser/status.ts";
import type { AiraExecutionStatus } from "../../../src/aira/execution/status.ts";
import type { AiraIntelligenceStatus } from "../../../src/aira/intelligence/status.ts";
import type { VerificationEvidenceSource } from "../../../src/aira/verification/evidence.ts";
import {
	buildVerificationEvidence,
	redactVerificationSecrets,
	trimToBudget,
	VERIFICATION_BUDGET_CHARS,
} from "../../../src/aira/verification/evidence.ts";
import type { AiraWorkspaceOwnershipObservation } from "../../../src/aira/workspace/ownership.ts";

function baseSource(): VerificationEvidenceSource {
	return {
		objective: "fix the player staying black after switching streams",
		mode: "build",
		changeFiles: [{ path: "src/player.ts", status: "modified", added: 3, deleted: 2 }],
		editedPaths: ["src/player.ts"],
		intelligence: undefined,
		execution: undefined,
		browser: undefined,
		contextBudget: "compact",
	};
}

const intelligence: AiraIntelligenceStatus = {
	active: true,
	activationReason: "project",
	confidence: "high",
	languages: ["typescript"],
	liveCode: {
		status: "ready",
		servers: [{ id: "ts", status: "ready", available: true }],
		spawnCount: 1,
		crashCount: 0,
	},
	repository: { status: "ready", filesIndexed: 12, cacheLoaded: true, changesAvailable: true, changeCount: 1 },
	findings: { total: 0, errors: 0, warnings: 0, stale: 0, top: [] },
	degraded: false,
};

const execution: AiraExecutionStatus = {
	active: true,
	degraded: false,
	processes: [],
	recentResults: [
		{
			status: "exited",
			ok: true,
			command: "npm test -- src/player.test.ts",
			cwd: "/tmp/proj",
			startedAt: 1,
			durationMs: 1200,
			exitCode: 0,
		},
	],
};

const browser: AiraBrowserStatus = {
	availability: "available",
	eligible: true,
	status: "active",
	provider: "fake",
	profileKind: "isolated",
	tabs: [],
	console: {
		errors: 1,
		warnings: 0,
		total: 1,
		topFinding: { message: "TypeError: player.seek is not a function", count: 1, firstAt: 1, lastAt: 1 },
	},
	network: { failures: 0 },
	observation: { revision: 2, summary: "player page · ready", nodeCount: 20 },
	verification: {
		status: "failed",
		lastCheckAt: 2,
		finding: { message: "TypeError: player.seek is not a function", count: 1, firstAt: 1, lastAt: 1 },
	},
	screenshot: {},
	updatedAt: 2,
};

describe("Aira verification evidence (Phase 8)", () => {
	it("renders bounded workspace ownership counts and protection semantics", () => {
		const workspace: AiraWorkspaceOwnershipObservation = {
			available: true,
			baseline: [{ path: "user.md", status: "modified", added: 1, deleted: 0 }],
			owned: [{ path: "goal.ts", status: "modified", added: 2, deleted: 1 }],
			protected: [{ path: "user.md", status: "modified", added: 1, deleted: 0 }],
			unowned: [{ path: "external.ts", status: "modified", added: 1, deleted: 0 }],
			counts: { baseline: 1, owned: 1, protected: 1, unowned: 1 },
		};
		const bundle = buildVerificationEvidence({ ...baseSource(), workspace });
		expect(bundle.text).toContain("WORKSPACE OWNERSHIP");
		expect(bundle.text).toContain("baseline/pre-existing: 1");
		expect(bundle.text).toContain("Goal-owned: 1");
		expect(bundle.text).toContain("protected: 1");
		expect(bundle.text).toContain("unowned concurrent: 1");
		expect(bundle.text).toContain("excluded from destructive repair");
	});

	it("renders every available evidence category and the objective", () => {
		const bundle = buildVerificationEvidence({ ...baseSource(), intelligence, execution, browser });
		expect(bundle.objective).toContain("player staying black");
		expect(bundle.text).toContain("OBJECTIVE");
		expect(bundle.text).toContain("CHANGED FILES");
		expect(bundle.text).toContain("src/player.ts");
		expect(bundle.text).toContain("DIAGNOSTICS");
		expect(bundle.text).toContain("npm test -- src/player.test.ts");
		expect(bundle.text).toContain("BROWSER");
		expect(bundle.text).toContain("TypeError: player.seek is not a function");
		expect(bundle.missingEvidence).toEqual([]);
	});

	it("declares missing evidence explicitly when sources are absent", () => {
		const bundle = buildVerificationEvidence(baseSource());
		expect(bundle.missingEvidence).toContain("Language diagnostics unavailable (intelligence inactive).");
		expect(bundle.missingEvidence).toContain("No test/build execution evidence in this session.");
		expect(bundle.missingEvidence).toContain("Browser evidence unavailable (no browser runtime snapshot).");
	});

	it("never fabricates browser evidence when the browser is unavailable", () => {
		const unavailable = { ...browser, status: "unavailable" as const, reason: "no browser executable" };
		const bundle = buildVerificationEvidence({ ...baseSource(), intelligence, execution, browser: unavailable });
		expect(bundle.missingEvidence.join(" ")).toContain("no browser executable");
		expect(bundle.text).toContain("(unavailable)");
	});

	it("respects hard budgets per context class with truncation markers", () => {
		for (const budget of ["compact", "balanced", "expanded"] as const) {
			const hugeObjective = "x".repeat(40_000);
			const bundle = buildVerificationEvidence({ ...baseSource(), contextBudget: budget, objective: hugeObjective });
			expect(bundle.text.length).toBeLessThanOrEqual(VERIFICATION_BUDGET_CHARS[budget]);
			expect(bundle.text).toContain("[TRUNCATED]");
		}
		expect(trimToBudget("abcdef", 4)).toBe("\n[TR");
		expect(trimToBudget("abc", 2)).toBe("\n[");
		expect(trimToBudget("short", 100)).toBe("short");
	});

	it("uses run-tracked edited paths when the git seam is unavailable", () => {
		const bundle = buildVerificationEvidence({
			...baseSource(),
			changeFiles: undefined,
			editedPaths: ["src/a.ts", "src/b.ts"],
		});
		expect(bundle.text).toContain("src/a.ts");
		expect(bundle.text).toContain("src/b.ts");
		expect(bundle.limitations.join(" ")).toContain("Git change stats unavailable");
	});

	it("bounds the change-file list and reports the delta summary", () => {
		const many = Array.from({ length: 60 }, (_, index) => ({
			path: `src/file${index}.ts`,
			status: "modified" as const,
			added: 1,
			deleted: 0,
		}));
		const bundle = buildVerificationEvidence({ ...baseSource(), changeFiles: many });
		expect(bundle.text).toContain("60 file(s)");
		expect(bundle.text).toContain("… and 20 more");
	});

	it("redacts secrets from evidence text", () => {
		const redacted = redactVerificationSecrets(
			'apiKey: sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 token: "ghp_abcdefghijklmnopqrstuvwxyz1234567890" Authorization: Bearer abc123 https://user:pass@example.com',
		);
		expect(redacted).not.toContain("sk-proj-");
		expect(redacted).not.toContain("ghp_");
		expect(redacted).not.toContain("Bearer abc123");
		expect(redacted).not.toContain("user:pass");
		expect(redacted).toContain("[REDACTED]");
	});

	it("flags browser idleness truthfully without fake evidence", () => {
		const idleBrowser = {
			...browser,
			console: { errors: 0, warnings: 0, total: 0 },
			network: { failures: 0 },
			verification: { status: "none" as const },
		};
		const bundle = buildVerificationEvidence({ ...baseSource(), intelligence, execution, browser: idleBrowser });
		expect(bundle.missingEvidence).toContain(
			"Browser check not run (no automatic/explicit browser verification evidence).",
		);
	});
});
