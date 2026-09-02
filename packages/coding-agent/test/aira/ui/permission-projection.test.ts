/**
 * Aira permission projections — footer, Workbench panel, current finding
 * (Phase 12.x).
 *
 * While a permission is pending, every restrained surface derives from the
 * host-attached presentation: the footer ASK segment and the finding label
 * show the operation/subject (never the generic "Allow X to run?" text),
 * and the Workbench Permission panel shows operation + subject inline.
 */
import { describe, expect, it } from "vitest";
import type { AiraSessionState } from "../../../src/aira/state.ts";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";
import { arbitrateCurrentFinding } from "../../../src/aira/ui/finding.ts";
import { interactionPanel } from "../../../src/aira/ui/panels.ts";
import { projectWorkbench } from "../../../src/aira/ui/projection.ts";

function permissionState(overrides: { withPresentation?: boolean; prompt?: string } = {}): AiraSessionState {
	const state = acquireAiraSessionState("perm-proj-test", "startup");
	state.interaction = {
		pending: true,
		question: {
			interactionId: "q-1",
			type: "permission",
			prompt: overrides.prompt ?? "Allow bash to run?",
			choices: [
				{ id: "allow-once", label: "Allow once", description: "Run only this request" },
				{ id: "allow-session", label: "Allow session", description: "Approve this exact subject for this session" },
				{ id: "allow-always", label: "Allow always", description: "Persist approval for this exact subject" },
				{ id: "deny", label: "Deny", description: "Do not execute" },
			],
			choicesCount: 4,
			multiSelect: false,
			freeform: false,
			owner: "permission:bash",
			...(overrides.withPresentation
				? {
						permission: {
							tool: "bash",
							capability: "process",
							operation: "Shell command",
							subject: "git push --dry-run origin main",
							redacted: false,
							reason: "remote repository operation",
							details: [{ label: "Working directory", value: "~/proj/aira" }],
							summary: "git push --dry-run origin main",
						},
					}
				: {}),
			waitingSince: Date.now() - 12_000,
			durationMs: 12_000,
		},
		recentClosed: [],
		uiAttached: true,
		updatedAt: Date.now(),
		summary: "question pending (permission)",
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
	return state;
}

function footerText(state: AiraSessionState, width = 160): string[] {
	const projection = projectWorkbench({
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
	});
	return projection.footer.map((segment) => segment.text);
}

const cleanup = () => disposeAiraSessionState("perm-proj-test", undefined as never);

describe("permission projections (Phase 12.x)", () => {
	it("footer ASK segment shows the actual command, not the question text", () => {
		const footer = footerText(permissionState({ withPresentation: true }), 220);
		expect(footer).toContain("ASK ● git push --dry-run origin main");
		expect(footer.join(" ")).not.toContain("Allow bash to run");
		// Permission mode remains separately visible.
		expect(footer.some((text) => text.startsWith("PERM "))).toBe(true);
		cleanup();
	});

	it("footer ASK segment falls back to the prompt without a presentation", () => {
		const footer = footerText(permissionState({ withPresentation: false }));
		expect(footer).toContain("ASK ● Allow bash to run?");
		cleanup();
	});

	it("footer ASK segment stays bounded for long commands", () => {
		const state = permissionState({ withPresentation: true });
		state.interaction!.question!.permission!.summary = `git commit -am ${"x".repeat(200)}`;
		const segment = footerText(state).find((text) => text.startsWith("ASK ●"))!;
		expect(segment.length).toBeLessThanOrEqual(48);
		expect(segment.endsWith("…")).toBe(true);
		cleanup();
	});

	it("Workbench Permission panel shows operation + subject (1-2 lines)", () => {
		const panel = interactionPanel(permissionState({ withPresentation: true }))!;
		expect(panel.id).toBe("interaction");
		expect(panel.title).toBe("Permission");
		expect(panel.priority).toBe(0);
		expect(panel.rows[0]).toMatchObject({ value: "? Shell command", role: "purple" });
		expect(panel.rows[1]).toMatchObject({ value: "git push --dry-run origin main", role: "text" });
		expect(panel.hint).toContain("waiting 12s");
		expect(JSON.stringify(panel.rows)).not.toContain("Allow bash to run");
		cleanup();
	});

	it("Workbench panel keeps the prompt path without a presentation", () => {
		const panel = interactionPanel(permissionState({ withPresentation: false }))!;
		expect(panel.rows[0]).toMatchObject({ value: "? Allow bash to run?", role: "purple" });
		cleanup();
	});

	it("semantic questions keep their prompt in both surfaces", () => {
		const state = permissionState({ withPresentation: false });
		state.interaction!.question!.type = "semantic";
		state.interaction!.question!.prompt = "Which auth approach?";
		const footer = footerText(state);
		expect(footer).toContain("ASK ● Which auth approach?");
		const finding = arbitrateCurrentFinding(state)!;
		expect(finding.label).toContain("Which auth approach?");
		const panel = interactionPanel(state)!;
		expect(panel.title).toBe("Interaction");
		expect(panel.rows[0]).toMatchObject({ value: "? Which auth approach?", role: "yellow" });
		cleanup();
	});

	it("current finding labels the operation/subject while permission is pending", () => {
		const finding = arbitrateCurrentFinding(permissionState({ withPresentation: true }))!;
		expect(finding.source).toBe("permission");
		expect(finding.priority).toBe(0);
		expect(finding.label).toContain("authorization:");
		expect(finding.label).toContain("git push --dry-run origin main");
		expect(finding.label).not.toContain("Allow bash to run");
		expect(finding.detail).toContain("waiting 12s");
		cleanup();
	});
});
