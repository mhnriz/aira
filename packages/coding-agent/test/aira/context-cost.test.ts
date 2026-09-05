import { describe, expect, it } from "vitest";
import { buildBrowserContext } from "../../src/aira/browser/context.ts";
import { initialAiraBrowserStatus } from "../../src/aira/browser/status.ts";
import { buildAiraContextCostAudit, estimateAiraTextTokens } from "../../src/aira/context-cost.ts";
import { buildAiraGoalContinuationPrompt } from "../../src/aira/goal/prompt.ts";
import { buildIntelligenceContext } from "../../src/aira/intelligence/context.ts";
import { AiraFindingsStore } from "../../src/aira/intelligence/findings.ts";
import { buildAiraRuntimeControlEnvelope, buildAiraRuntimeModeEnvelope } from "../../src/aira/modes.ts";
import { buildAiraChildEnvelope } from "../../src/aira/orchestration/envelope.ts";
import { AIRA_TASK_RECOVERY_HINT } from "../../src/aira/tasks/types.ts";
import type { VerificationEvidenceBundle } from "../../src/aira/verification/evidence.ts";
import { buildVerifierEnvelope, VERIFIER_SYSTEM_PROMPT } from "../../src/aira/verification/prompt.ts";
import { createHarness } from "../suite/harness.ts";

describe("Aira context-cost audit", () => {
	it("measures exact text length with a deterministic conservative estimate", () => {
		expect(estimateAiraTextTokens("12345")).toBe(2);
		expect(
			buildAiraContextCostAudit([
				{ id: "mode-envelope", activation: "mode", text: "<aira-runtime mode=build />" },
				{ id: "workbench", activation: "ui-only", text: "ENGINEERING CONTEXT" },
			]),
		).toEqual([
			{ id: "mode-envelope", activation: "mode", chars: 27, estimatedTokens: 7 },
			{ id: "workbench", activation: "ui-only", chars: 0, estimatedTokens: 0 },
		]);
	});

	it("does not imply UI text is model context", () => {
		const report = buildAiraContextCostAudit([{ id: "workbench", activation: "ui-only", text: "sidebar" }]);
		expect(report[0]?.activation).toBe("ui-only");
		expect(report[0]?.chars).toBe(0);
		expect(report[0]?.estimatedTokens).toBe(0);
	});

	it("measures the bounded one-shot task recovery hint", () => {
		const envelope = buildAiraRuntimeControlEnvelope("build", AIRA_TASK_RECOVERY_HINT);
		const recovery = buildAiraContextCostAudit([{ id: "task-recovery", activation: "task", text: envelope }])[0];

		expect(envelope).toContain("<aira-task-recovery>");
		expect(recovery?.chars).toBe(envelope.length);
		expect(recovery?.estimatedTokens).toBe(estimateAiraTextTokens(envelope));
		expect(buildAiraRuntimeControlEnvelope("build")).toBe(buildAiraRuntimeModeEnvelope("build"));
	});

	it("measures the exact bounded context builders used by Phase 13", () => {
		const browserStatus = initialAiraBrowserStatus();
		browserStatus.status = "active";
		browserStatus.tabs = [{ id: "tab-1", url: "http://localhost:3000", title: "Fixture", readyState: "complete" }];
		browserStatus.activeTab = browserStatus.tabs[0];
		browserStatus.observation = { revision: 1, summary: "fixture loaded", lastAt: 1 };
		browserStatus.console = {
			total: 1,
			errors: 1,
			warnings: 0,
			topFinding: { message: "fixture error", count: 1, firstAt: 1, lastAt: 1 },
		};
		const browser = buildBrowserContext({
			settings: { context: "on", budget: "compact" },
			status: browserStatus,
			relevanceSignal: true,
			pendingEdits: 0,
		});
		const intelligence = buildIntelligenceContext({
			prompt: "Inspect the fixture",
			mode: "build",
			activation: {
				active: true,
				reason: "fixture",
				languages: ["typescript"],
				liveCodeCandidates: [],
				confidence: "high",
			},
			projectRootName: "fixture",
			repository: undefined,
			findings: new AiraFindingsStore(),
			oriented: false,
		});
		const child = buildAiraChildEnvelope({
			role: "explore",
			task: "Inspect the fixture",
			mode: "plan",
			projectRoot: "/tmp/fixture",
			files: ["README.md"],
			context: "A bounded fixture",
			mutatingAllowed: false,
		});
		const verifierEvidence: VerificationEvidenceBundle = {
			objective: "Verify the fixture",
			mode: "plan",
			sections: [{ category: "repository", label: "REPOSITORY", text: "repository: clean" }],
			missingEvidence: [],
			limitations: [],
			text: "repository: clean",
		};
		const sections = buildAiraContextCostAudit([
			...["build", "plan", "review"].map((mode) => ({
				id: `mode-${mode}`,
				activation: "mode" as const,
				text: buildAiraRuntimeModeEnvelope(mode as "build" | "plan" | "review"),
			})),
			{ id: "browser-context", activation: "task", text: browser.content ?? "" },
			{ id: "project-intelligence-context", activation: "task", text: intelligence.content ?? "" },
			{ id: "child-envelope", activation: "child", text: child.prompt },
			{ id: "child-role-framing", activation: "child", text: child.systemPrompt },
			{ id: "verifier-system", activation: "child", text: VERIFIER_SYSTEM_PROMPT },
			{ id: "verifier-envelope", activation: "child", text: buildVerifierEnvelope(verifierEvidence) },
			{
				id: "goal-continuation",
				activation: "task",
				text: buildAiraGoalContinuationPrompt({
					objective: "Verify the fixture",
					round: 1,
					repair: { summary: "one issue", blocking: ["missing assertion"], unmet: [], evidence: ["check.ts:1"] },
					changeContext: "one file changed",
				}),
			},
			{ id: "workbench", activation: "ui-only", text: "large rendered sidebar" },
		]);

		expect(sections).toHaveLength(11);
		expect(sections.find((section) => section.id === "mode-plan")?.estimatedTokens).toBe(
			estimateAiraTextTokens(buildAiraRuntimeModeEnvelope("plan")),
		);
		expect(sections.find((section) => section.id === "browser-context")?.chars).toBe(browser.content?.length);
		expect(sections.find((section) => section.id === "workbench")).toEqual({
			id: "workbench",
			activation: "ui-only",
			chars: 0,
			estimatedTokens: 0,
		});
	});

	it("measures the exact native tool guidance in the active system prompt", async () => {
		const harness = await createHarness();
		try {
			const groups = {
				tasks: ["tasks"],
				interaction: ["ask_user"],
				orchestration: ["agents_delegate", "agents_status", "agents_cancel"],
				execution: ["process_start", "process_status", "process_logs", "process_stop"],
				browser: [
					"browser_open",
					"browser_status",
					"browser_observe",
					"browser_navigate",
					"browser_click",
					"browser_fill",
					"browser_press",
					"browser_scroll",
					"browser_wait",
					"browser_console",
					"browser_network",
					"browser_screenshot",
					"browser_verify",
					"browser_close",
				],
			} as const;
			const measureToolGroup = (names: readonly string[]): string =>
				names
					.map((name) => {
						const definition = harness.session.getToolDefinition(name);
						return [definition?.promptSnippet, ...(definition?.promptGuidelines ?? [])]
							.filter(Boolean)
							.join("\n");
					})
					.join("\n");
			const sections = buildAiraContextCostAudit([
				...Object.entries(groups).map(([id, names]) => ({
					id: `${id}-guidance`,
					activation: "always" as const,
					text: measureToolGroup(names),
				})),
				{ id: "permission-enforcement", activation: "host-only", text: "PLAN policy is host-enforced" },
				{
					id: "capability-preflight",
					activation: "host-only",
					text: "capability compatibility is checked before provider spend",
				},
				{ id: "workbench", activation: "ui-only", text: "ENGINEERING CONTEXT" },
			]);

			expect(sections.slice(0, 5).every((section) => section.chars > 0)).toBe(true);
			expect(sections.slice(5).every((section) => section.chars === 0 && section.estimatedTokens === 0)).toBe(true);
		} finally {
			harness.cleanup();
		}
	});
});
