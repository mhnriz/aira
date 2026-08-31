import { describe, expect, it } from "vitest";
import { initialAiraIntelligenceStatus } from "../../../src/aira/intelligence/status.ts";
import { type AiraSessionState, acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";
import { arbitrateCurrentFinding } from "../../../src/aira/ui/finding.ts";
import { arbitrateFooterSegments, projectWorkbench } from "../../../src/aira/ui/projection.ts";
import type { WorkbenchProjectionInput } from "../../../src/aira/ui/types.ts";
import {
	isWorkbenchNarrow,
	resolveWorkbenchVisibility,
	workbenchLayoutFor,
	workbenchSafeMinimum,
} from "../../../src/aira/ui/visibility.ts";
import { initialAiraVerificationStatus } from "../../../src/aira/verification/types.ts";

/** Bounded canonical-state fixture for projection tests. */
function sessionFixture(): AiraSessionState {
	return acquireAiraSessionState("wb-test", "startup");
}

function disposeFixture(state: AiraSessionState): void {
	disposeAiraSessionState("wb-test", state);
}

function defaultInput(state: AiraSessionState, width = 160): WorkbenchProjectionInput {
	return {
		state,
		workingSet: [],
		symbols: [],
		width,
		settings: { enabled: true, showOnStartup: true, density: "comfortable", width: 42 },
		explicitVisible: undefined,
		cwd: "~/proj/aira",
		branch: "main",
		context: { percent: "12.5", window: 1_000_000, autoCompact: true, over90: false, over70: false },
		modelId: "deepseek-v4-flash",
		thinkingLevel: "max",
	};
}

describe("Workbench visibility policy", () => {
	it("is visible by default on wide terminals", () => {
		expect(
			resolveWorkbenchVisibility({
				width: 160,
				enabled: true,
				showOnStartup: true,
				sidebarWidth: 42,
				explicitVisible: undefined,
			}),
		).toBe(true);
	});

	it("auto-hides below the safe minimum width", () => {
		expect(
			resolveWorkbenchVisibility({
				width: 100,
				enabled: true,
				showOnStartup: true,
				sidebarWidth: 42,
				explicitVisible: undefined,
			}),
		).toBe(false);
		expect(isWorkbenchNarrow(100, 42)).toBe(true);
	});

	it("keeps explicit OFF off when the terminal widens again", () => {
		// Narrow: hidden regardless.
		expect(
			resolveWorkbenchVisibility({
				width: 80,
				enabled: true,
				showOnStartup: true,
				sidebarWidth: 42,
				explicitVisible: false,
			}),
		).toBe(false);
		// Wide again: explicit OFF still wins.
		expect(
			resolveWorkbenchVisibility({
				width: 160,
				enabled: true,
				showOnStartup: true,
				sidebarWidth: 42,
				explicitVisible: false,
			}),
		).toBe(false);
	});

	it("restores explicit ON after a narrow stretch (user asked for it)", () => {
		expect(
			resolveWorkbenchVisibility({
				width: 100,
				enabled: true,
				showOnStartup: true,
				sidebarWidth: 42,
				explicitVisible: true,
			}),
		).toBe(false);
		expect(
			resolveWorkbenchVisibility({
				width: 160,
				enabled: true,
				showOnStartup: true,
				sidebarWidth: 42,
				explicitVisible: true,
			}),
		).toBe(true);
	});

	it("auto-hidden default returns when the terminal widens", () => {
		expect(
			resolveWorkbenchVisibility({
				width: 100,
				enabled: true,
				showOnStartup: true,
				sidebarWidth: 42,
				explicitVisible: undefined,
			}),
		).toBe(false);
		expect(
			resolveWorkbenchVisibility({
				width: 160,
				enabled: true,
				showOnStartup: true,
				sidebarWidth: 42,
				explicitVisible: undefined,
			}),
		).toBe(true);
	});

	it("respects workbench.enabled=false as a hard off", () => {
		expect(
			resolveWorkbenchVisibility({
				width: 200,
				enabled: false,
				showOnStartup: true,
				sidebarWidth: 42,
				explicitVisible: true,
			}),
		).toBe(false);
	});

	it("showOnStartup=false hides the default but explicit ON still shows", () => {
		expect(
			resolveWorkbenchVisibility({
				width: 160,
				enabled: true,
				showOnStartup: false,
				sidebarWidth: 42,
				explicitVisible: undefined,
			}),
		).toBe(false);
		expect(
			resolveWorkbenchVisibility({
				width: 160,
				enabled: true,
				showOnStartup: false,
				sidebarWidth: 42,
				explicitVisible: true,
			}),
		).toBe(true);
	});

	it("classifies layouts wide/medium/narrow deterministically", () => {
		expect(workbenchLayoutFor(160)).toBe("wide");
		expect(workbenchLayoutFor(110)).toBe("medium");
		expect(workbenchLayoutFor(80)).toBe("narrow");
		expect(workbenchSafeMinimum(42)).toBe(114);
	});
});

describe("Workbench finding arbitration", () => {
	it("prefers a pending interaction over verifier/lsp findings", () => {
		const state = sessionFixture();
		state.interaction = {
			pending: true,
			question: {
				interactionId: "q1",
				type: "semantic",
				prompt: "Keep backward compatibility with v1?",
				choices: [],
				choicesCount: 0,
				multiSelect: false,
				freeform: true,
				owner: "agent",
				waitingSince: Date.now() - 4_000,
				durationMs: 4_000,
			},
			recentClosed: [],
			uiAttached: true,
			updatedAt: Date.now(),
			summary: "pending",
		};
		state.verification = {
			...initialAiraVerificationStatus({ enabled: true, auto: "smart", contextBudget: "balanced" }),
			status: "failed",
			currentResult: {
				id: "r1",
				revisionId: "rev1",
				verdict: "fail",
				summary: "login still crashes",
				mode: "build",
				objective: "fix login",
				requirements: [],
				findings: [],
				evidence: [],
				missingEvidence: [],
				scopeAssessment: { verdict: "in-scope", notes: [] },
				confidence: "medium",
				startedAt: 1,
				completedAt: 2,
				stale: false,
			},
			requirementsTotal: 0,
			requirementsVerified: 0,
			stale: false,
			missingEvidence: [],
			updatedAt: Date.now(),
		};
		const finding = arbitrateCurrentFinding(state);
		expect(finding?.source).toBe("ask");
		expect(finding?.severity).toBe("wait");
		expect(finding?.priority).toBe(0);
		disposeFixture(state);
	});

	it("surfaces a fresh verifier FAIL before LSP warnings", () => {
		const state = sessionFixture();
		state.verification = {
			...initialAiraVerificationStatus({ enabled: true, auto: "smart", contextBudget: "balanced" }),
			status: "failed",
			currentResult: {
				id: "r1",
				revisionId: "rev1",
				verdict: "fail",
				summary: "login still crashes",
				mode: "build",
				objective: "fix login",
				requirements: [],
				findings: [],
				evidence: [],
				missingEvidence: [],
				scopeAssessment: { verdict: "in-scope", notes: [] },
				confidence: "medium",
				startedAt: 1,
				completedAt: 2,
				stale: false,
			},
			requirementsTotal: 0,
			requirementsVerified: 0,
			stale: false,
			missingEvidence: [],
			updatedAt: Date.now(),
		};
		state.intelligence = {
			...initialAiraIntelligenceStatus(),
			findings: {
				total: 1,
				errors: 0,
				warnings: 1,
				stale: 0,
				top: [
					{
						severity: "warning",
						message: "deprecated API",
						path: "src/x.ts",
						freshness: "fresh",
					},
				],
			},
		};
		const finding = arbitrateCurrentFinding(state);
		expect(finding?.source).toBe("verifier");
		expect(finding?.severity).toBe("error");
		expect(finding?.code).toBe("VERIFY");
		disposeFixture(state);
	});

	it("does not invent an LSP error (no artifact when only warnings exist at P2)", () => {
		const state = sessionFixture();
		state.intelligence = {
			...initialAiraIntelligenceStatus(),
			findings: {
				total: 1,
				errors: 0,
				warnings: 1,
				stale: 0,
				top: [{ severity: "warning", message: "deprecated API", path: "src/x.ts", freshness: "fresh" }],
			},
		};
		const finding = arbitrateCurrentFinding(state);
		expect(finding?.severity).toBe("warning");
		expect(finding?.source).toBe("lsp");
		expect(finding?.priority).toBe(2);
		disposeFixture(state);
	});

	it("returns undefined when nothing actionable exists", () => {
		const state = sessionFixture();
		expect(arbitrateCurrentFinding(state)).toBeUndefined();
		disposeFixture(state);
	});

	it("reports a stale verification result honestly (warning, not pass)", () => {
		const state = sessionFixture();
		state.verification = {
			...initialAiraVerificationStatus({ enabled: true, auto: "smart", contextBudget: "balanced" }),
			status: "passed",
			currentResult: {
				id: "r1",
				revisionId: "rev1",
				verdict: "pass",
				summary: "all good",
				mode: "build",
				objective: "fix login",
				requirements: [],
				findings: [],
				evidence: [],
				missingEvidence: [],
				scopeAssessment: { verdict: "in-scope", notes: [] },
				confidence: "high",
				startedAt: 1,
				completedAt: 2,
				stale: true,
				staleReason: "new edit landed",
			},
			requirementsTotal: 0,
			requirementsVerified: 0,
			stale: true,
			missingEvidence: [],
			updatedAt: Date.now(),
		};
		const finding = arbitrateCurrentFinding(state);
		expect(finding?.severity).toBe("warning");
		expect(finding?.label).toContain("stale");
		disposeFixture(state);
	});

	it("a permission ASK outranks a semantic question via source tag", () => {
		const state = sessionFixture();
		state.interaction = {
			pending: true,
			question: {
				interactionId: "q1",
				type: "permission",
				prompt: "Allow bash: npm test?",
				choices: [],
				choicesCount: 0,
				multiSelect: false,
				freeform: false,
				owner: "permission:bash",
				waitingSince: Date.now() - 1_000,
				durationMs: 1_000,
			},
			recentClosed: [],
			uiAttached: true,
			updatedAt: Date.now(),
			summary: "pending",
		};
		const finding = arbitrateCurrentFinding(state);
		expect(finding?.source).toBe("permission");
		expect(finding?.severity).toBe("wait");
		disposeFixture(state);
	});
});

describe("Workbench panel projection", () => {
	it("orders urgent panels before context panels deterministically", () => {
		const state = sessionFixture();
		state.tasks = {
			enabled: true,
			total: 2,
			pending: 0,
			active: 1,
			blocked: 1,
			completed: 0,
			cancelled: 0,
			failed: 0,
			current: "Repair surface",
			rows: [
				{ id: "t1", title: "Repair surface", status: "active", source: "user", dependsOn: [] },
				{ id: "t2", title: "Re-run verification", status: "blocked", source: "user", dependsOn: ["t1"] },
			],
			childRows: 0,
			updatedAt: Date.now(),
			summary: "1/2 · 1 active",
		};
		state.intelligence = initialAiraIntelligenceStatus();
		const input = defaultInput(state);
		const projection = projectWorkbench(input);
		const ids = projection.panels.map((panel) => panel.id);
		expect(ids[0]).toBe("tasks"); // P1 active work (no P0 present)
		expect(ids).toContain("intelligence"); // P2 context
		expect(projection.sidebarVisible).toBe(true);
		// Panel order follows (priority, stable order): find intelligence after tasks.
		expect(ids.indexOf("intelligence")).toBeGreaterThan(ids.indexOf("tasks"));
		disposeFixture(state);
	});

	it("keeps the control panel at P3 and hides it in medium layouts", () => {
		const state = sessionFixture();
		state.permissions = {
			enabled: true,
			mode: "normal",
			persistentRules: 2,
			sessionRules: 1,
			onceApprovals: 0,
			store: { status: "ok", path: "~/.aira/agent/permissions.json", error: undefined },
			lastDecision: undefined,
			updatedAt: Date.now(),
			summary: "normal",
		};
		const wide = projectWorkbench(defaultInput(state, 160));
		expect(wide.panels.find((panel) => panel.id === "control")).toBeDefined();
		expect(wide.panels.find((panel) => panel.id === "control")?.priority).toBe(3);
		const medium = projectWorkbench(defaultInput(state, 110));
		expect(medium.panels.find((panel) => panel.id === "control")).toBeUndefined();
		disposeFixture(state);
	});

	it("renders the working set and changeset from the canonical git seam", () => {
		const state = sessionFixture();
		const input = defaultInput(state, 160);
		const workingSet = [
			{ path: "src/player/controller.ts", status: "modified" as const, added: 14, deleted: 8 },
			{ path: "src/player/types.ts", status: "modified" as const, added: 3, deleted: 1 },
		];
		const projection = projectWorkbench({ ...input, workingSet });
		const panel = projection.panels.find((p) => p.id === "working-set");
		expect(panel).toBeDefined();
		expect(panel?.rows[0]?.value).toContain("src/player/controller.ts");
		const changeset = projection.panels.find((p) => p.id === "changeset");
		expect(changeset?.rows[0]?.value).toContain("+17 -9");
		disposeFixture(state);
	});

	it("omits panels with no relevant state", () => {
		const state = sessionFixture();
		const projection = projectWorkbench(defaultInput(state, 160));
		expect(projection.panels.find((p) => p.id === "working-set")).toBeUndefined();
		expect(projection.panels.find((p) => p.id === "goal")).toBeUndefined();
		expect(projection.panels.find((p) => p.id === "verification")).toBeUndefined();
		expect(projection.panels.find((p) => p.id === "interaction")).toBeUndefined();
		disposeFixture(state);
	});
});

describe("Workbench footer arbitration", () => {
	it("never drops required segments (mode/context/model)", () => {
		const state = sessionFixture();
		state.intelligence = initialAiraIntelligenceStatus();
		const input = defaultInput(state, 40); // very narrow
		const projection = projectWorkbench(input);
		const ids = projection.footer.map((segment) => segment.id);
		expect(ids).toContain("mode");
		expect(ids).toContain("context");
		expect(ids).toContain("model");
		disposeFixture(state);
	});

	it("drops opportunistic segments first when width runs out", () => {
		const state = sessionFixture();
		state.intelligence = {
			...initialAiraIntelligenceStatus(),
			active: true,
			repository: { status: "ready", filesIndexed: 100, cacheLoaded: true, changesAvailable: true, changeCount: 3 },
		};
		state.permissions = {
			enabled: true,
			mode: "normal",
			persistentRules: 0,
			sessionRules: 0,
			onceApprovals: 0,
			store: { status: "ok", path: undefined, error: undefined },
			lastDecision: undefined,
			updatedAt: Date.now(),
			summary: "normal",
		};
		const wide = projectWorkbench(defaultInput(state, 160));
		const wideIds = wide.footer.map((s) => s.id);
		expect(wideIds).toContain("permission");
		expect(wideIds).toContain("git");
		const narrow = projectWorkbench(defaultInput(state, 60));
		const narrowIds = narrow.footer.map((s) => s.id);
		// git delta (dropRank 1) and permission (dropRank 2) disappear first.
		expect(narrowIds).not.toContain("git");
		expect(narrowIds).not.toContain("permission");
		expect(narrowIds).toContain("mode");
		disposeFixture(state);
	});

	it("displays the highest-priority finding compactly in the footer", () => {
		const state = sessionFixture();
		state.intelligence = {
			...initialAiraIntelligenceStatus(),
			active: true,
			findings: {
				total: 1,
				errors: 1,
				warnings: 0,
				stale: 0,
				top: [
					{
						severity: "error",
						code: "TS2339",
						message: "Property 'replaceWith' does not exist on type 'Surface'",
						path: "src/player/controller.ts",
						line: 184,
						freshness: "fresh",
					},
				],
			},
		};
		const projection = projectWorkbench(defaultInput(state, 160));
		expect(projection.finding?.code).toBe("TS2339");
		expect(projection.finding?.source).toBe("lsp");
		const findingSegment = projection.footer.find((s) => s.id === "finding");
		expect(findingSegment).toBeDefined();
		expect(findingSegment?.text).toContain("TS2339");
		disposeFixture(state);
	});

	it("arbitrates footer segments to fit a given width without dropping required ones", () => {
		const left = [
			{
				id: "mode" as const,
				text: "◈ BUILD",
				role: "copper" as const,
				dropRank: Number.POSITIVE_INFINITY,
				required: true,
			},
			{ id: "finding" as const, text: "TS2339 · replaceWith missing", role: "red" as const, dropRank: 60 },
			{ id: "verification" as const, text: "VERIFY ✕1", role: "red" as const, dropRank: 10 },
			{ id: "permission" as const, text: "PERM normal", role: "purple" as const, dropRank: 2 },
		];
		const right = [
			{ id: "git" as const, text: "Δ3", role: "muted" as const, dropRank: 1 },
			{
				id: "context" as const,
				text: "53%/1.0M",
				role: "text" as const,
				dropRank: Number.POSITIVE_INFINITY,
				required: true,
			},
			{
				id: "model" as const,
				text: "deepseek-v4-flash · max",
				role: "purple" as const,
				dropRank: Number.POSITIVE_INFINITY,
				required: true,
			},
		];
		const wide = arbitrateFooterSegments(left, right, 160);
		expect(wide.map((s) => s.id)).toContain("permission");
		const narrow = arbitrateFooterSegments(left, right, 44);
		const narrowIds = narrow.map((s) => s.id);
		expect(narrowIds).toContain("mode");
		expect(narrowIds).toContain("context");
		expect(narrowIds).toContain("model");
		expect(narrowIds).not.toContain("git");
		expect(narrowIds).not.toContain("verification");
	});
});
