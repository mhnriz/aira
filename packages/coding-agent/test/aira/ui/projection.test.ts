import { describe, expect, it } from "vitest";
import { initialAiraBrowserStatus } from "../../../src/aira/browser/status.ts";
import type { AiraGoalSnapshot } from "../../../src/aira/goal/types.ts";
import { initialAiraIntelligenceStatus } from "../../../src/aira/intelligence/status.ts";
import { initialAiraOrchestrationStatus } from "../../../src/aira/orchestration/status.ts";
import { type AiraSessionState, acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";
import { arbitrateCurrentFinding } from "../../../src/aira/ui/finding.ts";
import { arbitrateFooterSegments } from "../../../src/aira/ui/footer.ts";
import { projectWorkbench } from "../../../src/aira/ui/projection.ts";
import type { WorkbenchProjectionInput } from "../../../src/aira/ui/types.ts";
import {
	isWorkbenchNarrow,
	resolveWorkbenchVisibility,
	responsiveWorkbenchWidth,
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
		checkpoints: [],
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

function goalFixture(): AiraGoalSnapshot {
	return {
		enabled: true,
		auto: "smart",
		status: "repairing",
		id: "goal-1",
		objective: "repair the Workbench layout",
		round: 2,
		maxRounds: 4,
		startedAt: Date.now() - 10_000,
		updatedAt: Date.now(),
		completedAt: undefined,
		stopReason: undefined,
		waiting: undefined,
		budget: { tokens: 100_000, maxDurationMs: undefined },
		usage: { consumedTokens: 41_000, remainingTokens: 59_000, sources: ["session"] },
		revision: undefined,
		tasks: { completed: 4, active: 3, total: 7 },
		verification: {
			verdict: "fail",
			stale: false,
			summary: "one requirement remains",
			missingEvidence: [],
			lastError: undefined,
		},
		staleCompletion: false,
		needsUserInput: false,
		mode: "build",
		lastEvent: "repair started",
		persistence: { enabled: true, status: "ok", path: undefined, error: undefined },
		summary: "repairing · round 2",
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

	it("expands the sidebar on wide terminals while preserving the configured minimum", () => {
		expect(responsiveWorkbenchWidth(120, 42)).toBe(42);
		expect(responsiveWorkbenchWidth(160, 42)).toBe(43);
		expect(responsiveWorkbenchWidth(220, 42)).toBe(60);
		expect(responsiveWorkbenchWidth(220, 60)).toBe(60);
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

	it("reports stale and indeterminate LSP findings as freshness warnings", () => {
		for (const freshness of ["stale", "indeterminate"] as const) {
			const state = sessionFixture();
			state.intelligence = {
				...initialAiraIntelligenceStatus(),
				findings: {
					total: 1,
					errors: 1,
					warnings: 0,
					stale: freshness === "stale" ? 1 : 0,
					top: [{ severity: "error", message: "old error", path: "src/x.ts", freshness }],
				},
			};
			const finding = arbitrateCurrentFinding(state);
			expect(finding?.severity).toBe("warning");
			expect(finding?.label).toContain(freshness);
			disposeFixture(state);
		}
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
	it("keeps the idle Workbench sparse", () => {
		const state = sessionFixture();
		state.intelligence = {
			...initialAiraIntelligenceStatus(),
			active: true,
			repository: { status: "ready", filesIndexed: 1612, cacheLoaded: true, changesAvailable: true, changeCount: 0 },
			liveCode: {
				status: "idle",
				servers: [
					{ id: "typescript", status: "idle", available: true },
					{ id: "pyright", status: "idle", available: true },
					{ id: "gopls", status: "idle", available: true },
				],
				spawnCount: 0,
				crashCount: 0,
			},
		};
		state.permissions = {
			enabled: true,
			mode: "normal",
			persistentRules: 6,
			sessionRules: 0,
			onceApprovals: 0,
			store: { status: "ok", path: undefined, error: undefined },
			lastDecision: undefined,
			updatedAt: Date.now(),
			summary: "normal",
		};
		const projection = projectWorkbench(defaultInput(state));
		expect(projection.panels.map((panel) => panel.id)).toEqual(["intelligence", "control"]);
		expect(projection.panels[0]?.rows.map((row) => row.value)).toEqual([
			"ready · 1612 files · clean",
			"idle · 3 available",
		]);
		disposeFixture(state);
	});

	it("projects running and queued agents with distinct lifecycle truth", () => {
		const state = sessionFixture();
		state.orchestration = {
			...initialAiraOrchestrationStatus(true, 2),
			status: "active",
			runningCount: 1,
			queuedCount: 1,
			children: [
				{
					id: "run-1",
					taskId: "explore",
					role: "explore",
					task: "inspect renderer",
					status: "running",
					phase: "running",
					model: undefined,
					elapsedMs: 18_000,
					dependencies: [],
				},
				{
					id: "run-2",
					taskId: "review",
					role: "review",
					task: "review layout",
					status: "pending",
					phase: "waiting-capacity",
					model: undefined,
					dependencies: [],
				},
			],
			summary: "1 running · 1 queued",
		};
		const projection = projectWorkbench(defaultInput(state));
		const agents = projection.panels.find((panel) => panel.id === "agents");
		expect(agents?.hint).toBe("1 running · 1 queued");
		expect(agents?.rows[0]).toMatchObject({ value: "● explore", trailing: "18s" });
		expect(agents?.rows[1]).toMatchObject({ value: "○ review", trailing: "queued" });
		expect(projection.footer.find((segment) => segment.id === "agents")?.text).toBe("AGENTS 1+1");
		disposeFixture(state);
	});

	it("projects bounded read-only Git checkpoints separately from the changeset", () => {
		const state = sessionFixture();
		const projection = projectWorkbench({
			...defaultInput(state),
			checkpoints: [
				{ hash: "abc1234", subject: "stabilize runtime", head: true, dirty: true },
				{ hash: "def5678", subject: "add workbench", head: false, dirty: true },
			],
		});
		const panel = projection.panels.find((candidate) => candidate.id === "checkpoints");
		expect(panel).toMatchObject({ title: "Checkpoints", priority: 3, hint: "working tree dirty" });
		expect(panel?.rows[0]).toMatchObject({ value: "HEAD abc1234 stabilize runtime", role: "copper" });
		disposeFixture(state);
	});

	it("projects an active goal with round and task progress", () => {
		const state = sessionFixture();
		state.goal = goalFixture();
		const goal = projectWorkbench(defaultInput(state)).panels.find((panel) => panel.id === "goal");
		expect(goal?.rows[0]).toMatchObject({ label: "State", value: "R2/4 · repairing" });
		expect(goal?.rows.find((row) => row.label === "Tasks")?.value).toBe("4 / 7 · 3 active");
		expect(goal?.progress?.value).toBe(0.5);
		disposeFixture(state);
	});

	it("shows browser and verifier panels only when their canonical state is relevant", () => {
		const state = sessionFixture();
		state.browser = {
			...initialAiraBrowserStatus(),
			availability: "available",
			status: "active",
			console: { errors: 0, warnings: 1, total: 1 },
		};
		state.verification = {
			...initialAiraVerificationStatus({ enabled: true, auto: "smart", contextBudget: "balanced" }),
			status: "running",
			updatedAt: Date.now(),
		};
		const ids = projectWorkbench(defaultInput(state)).panels.map((panel) => panel.id);
		expect(ids).toContain("browser");
		expect(ids).toContain("verification");
		disposeFixture(state);
	});

	it("projects pending interaction as secondary readiness telemetry", () => {
		const state = sessionFixture();
		state.interaction = {
			pending: true,
			question: {
				interactionId: "q1",
				type: "permission",
				prompt: "git push origin main",
				choices: [],
				choicesCount: 0,
				multiSelect: false,
				freeform: false,
				owner: "permission:bash",
				waitingSince: Date.now() - 12_000,
				durationMs: 12_000,
			},
			recentClosed: [],
			uiAttached: true,
			updatedAt: Date.now(),
			summary: "pending",
		};
		const interaction = projectWorkbench(defaultInput(state)).panels.find((panel) => panel.id === "interaction");
		expect(interaction?.title).toBe("Permission");
		expect(interaction?.rows[0]?.value).toBe("? git push origin main");
		expect(interaction?.hint).toContain("waiting 12s");
		disposeFixture(state);
	});

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
		state.intelligence = {
			...initialAiraIntelligenceStatus(),
			active: true,
			repository: { status: "ready", filesIndexed: 100, cacheLoaded: true, changesAvailable: true, changeCount: 0 },
			liveCode: { status: "idle", servers: [], spawnCount: 0, crashCount: 0 },
		};
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

	it("shows the Execution panel for a failed background process (dogfood finding)", () => {
		const state = sessionFixture();
		state.execution = {
			active: true,
			degraded: false,
			processes: [
				{
					id: "test-1",
					purpose: "test",
					mode: "background",
					status: "exited",
					command: "node -e 'process.exit(3)'",
					cwd: "/tmp/repo",
					createdAt: 1,
					startedAt: 1,
					exitedAt: 2,
					exitCode: 3,
					exitReason: "exit",
				},
			],
			recentResults: [],
		};
		const projection = projectWorkbench(defaultInput(state, 160));
		const panel = projection.panels.find((p) => p.id === "execution");
		expect(panel).toBeDefined();
		expect(panel?.rows[0]?.value).toContain("✕ node -e 'process.exit(3)'");
		expect(panel?.rows[0]?.trailing).toContain("code 3");
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
