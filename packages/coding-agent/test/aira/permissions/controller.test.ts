/**
 * Aira permissions — controller tests (Phase 11).
 *
 * Covers the session-side pipeline: allow/ask/deny, allow-once consumption,
 * allow-session and allow-always (exact-subject, never broadening),
 * headless ASK denial, permission-prompt cancellation as truthful denial,
 * child gating (ask→deny, no prompting), PLAN absolute through the
 * controller, and settings toggles.
 */
import { describe, expect, it } from "vitest";
import { createAiraInteractionManager } from "../../../src/aira/interaction/manager.ts";
import type { AiraPermissionSettings } from "../../../src/aira/permissions/controller.ts";
import { createAiraPermissionController } from "../../../src/aira/permissions/controller.ts";
import type { AiraPermissionRule } from "../../../src/aira/permissions/types.ts";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";

interface Rig {
	state: ReturnType<typeof acquireAiraSessionState>;
	controller: ReturnType<typeof createAiraPermissionController>;
	interaction: ReturnType<typeof createAiraInteractionManager>;
	settings: AiraPermissionSettings;
	setSettings(next: Partial<AiraPermissionSettings>): void;
	cleanup(): void;
}

function makeRig(
	options: { mode?: AiraPermissionSettings["mode"]; enabled?: boolean; attachUI?: boolean; cwd?: string } = {},
): Rig {
	const state = acquireAiraSessionState("perm-ctrl-test");
	const settings: AiraPermissionSettings = { enabled: options.enabled ?? true, mode: options.mode ?? "normal" };
	const interaction = createAiraInteractionManager(state);
	if (options.attachUI) {
		interaction.attachUI();
	}
	const controller = createAiraPermissionController(state, {
		cwd: options.cwd ?? "/proj/app",
		projectRoot: () => "/proj/app",
		settings: () => settings,
		interaction,
		store: createMemoryStore(),
	});
	return {
		state,
		controller,
		interaction,
		settings,
		setSettings(next) {
			if (next.enabled !== undefined) settings.enabled = next.enabled;
			if (next.mode !== undefined) settings.mode = next.mode;
		},
		cleanup() {
			interaction.dispose();
			controller.dispose();
			disposeAiraSessionState(state.sessionId, state);
		},
	};
}

function createMemoryStore() {
	let rules: AiraPermissionRule[] = [];
	return {
		load: () => ({
			rules: rules.map((rule) => ({ ...rule })),
			health: { status: "ok" as const, path: undefined, error: undefined },
		}),
		save: (next: readonly AiraPermissionRule[]) => {
			rules = [...next];
			return { status: "ok" as const, path: undefined, error: undefined };
		},
	};
}

describe("permission controller (Phase 11)", () => {
	it("normal mode: routine read/edit/process pass without prompting", async () => {
		const rig = makeRig();
		const read = await rig.controller.gate("read", { path: "/proj/app/README.md" });
		expect(read.block).toBe(false);
		const edit = await rig.controller.gate("edit", { path: "src/a.ts" });
		expect(edit.block).toBe(false);
		const bash = await rig.controller.gate("bash", { command: "npm test" });
		expect(bash.block).toBe(false);
		expect(rig.state.permissions?.mode).toBe("normal");
	});

	it("normal mode: a risky process command asks; allow-once lets exactly this request through once", async () => {
		const rig = makeRig({ attachUI: true });
		const gatePromise = rig.controller.gate("bash", { command: "git push origin main" });
		// The gate is awaiting the dialog: the shared interaction is pending.
		expect(rig.interaction.status().pending).toBe(true);
		const prompt = rig.interaction.status().question!;
		expect(prompt.type).toBe("permission");
		expect(prompt.choicesCount).toBe(4);
		expect(prompt.owner).toBe("permission:bash");

		// Answer "Allow once" → the gate resolves unblocked.
		await rig.interaction.answer(prompt.interactionId, {
			resolution: "answered",
			selections: [],
			decision: "allow-once",
		});
		const outcome = await gatePromise;
		expect(outcome.block).toBe(false);

		// The one-time approval was consumed: the next identical request asks again.
		const again = rig.controller.gate("bash", { command: "git push origin main" });
		expect(rig.interaction.status().pending).toBe(true);
		// Cancel it → truthful denial.
		const q2 = rig.interaction.status().question!;
		await rig.interaction.answer(q2.interactionId, { resolution: "cancelled", selections: [] });
		const second = await again;
		expect(second.block).toBe(true);
		expect(second.reason).toContain("permission prompt cancelled");
	});

	it("allow-session records an EXACT session rule that never broadens", async () => {
		const rig = makeRig({ attachUI: true });
		const gatePromise = rig.controller.gate("bash", { command: "git push origin main" });
		const prompt = rig.interaction.status().question!;
		await rig.interaction.answer(prompt.interactionId, {
			resolution: "answered",
			selections: [],
			decision: "allow-session",
		});
		expect((await gatePromise).block).toBe(false);

		// Same exact command: auto-allowed by the session rule (no prompt).
		const same = await rig.controller.gate("bash", { command: "git push origin main" });
		expect(same.block).toBe(false);
		expect(rig.interaction.status().pending).toBe(false);

		// A different (even similar) command is NOT covered: exact match only.
		const other = rig.controller.gate("bash", { command: "git push origin other" });
		expect(rig.interaction.status().pending).toBe(true);
		const q2 = rig.interaction.status().question!;
		await rig.interaction.answer(q2.interactionId, { resolution: "cancelled", selections: [] });
		expect((await other).block).toBe(true);
		expect(rig.controller.rules().session).toHaveLength(1);
	});

	it("allow-always persists an EXACT rule; the next equivalent request never prompts, unrelated ones still do", async () => {
		const rig = makeRig({ attachUI: true });
		const gatePromise = rig.controller.gate("write", { path: "/tmp/notes.txt" });
		const prompt = rig.interaction.status().question!;
		expect(prompt.type).toBe("permission");
		await rig.interaction.answer(prompt.interactionId, {
			resolution: "answered",
			selections: [],
			decision: "allow-always",
		});
		expect((await gatePromise).block).toBe(false);
		expect(rig.controller.rules().persistent).toHaveLength(1);
		const ruleRecord = rig.controller.rules().persistent[0]!;
		expect(ruleRecord.match).toBe("exact");
		expect(ruleRecord.subject).toBe("/tmp/notes.txt");

		// The identical absolute path is now silently allowed.
		const same = await rig.controller.gate("write", { path: "/tmp/notes.txt" });
		expect(same.block).toBe(false);
		// A different path still asks.
		const other = rig.controller.gate("write", { path: "/tmp/other.txt" });
		expect(rig.interaction.status().pending).toBe(true);
		const q2 = rig.interaction.status().question!;
		await rig.interaction.answer(q2.interactionId, { resolution: "cancelled", selections: [] });
		expect((await other).block).toBe(true);
	});

	it("headless ASK resolves as a truthful denial (no UI to grant with)", async () => {
		const rig = makeRig({ attachUI: false });
		const outcome = await rig.controller.gate("bash", { command: "git push origin main" });
		expect(outcome.block).toBe(true);
		expect(outcome.reason).toContain("permission prompt unavailable");
	});

	it("permission deny returns a truthful denial the model sees", async () => {
		const rig = makeRig({ attachUI: true });
		const gatePromise = rig.controller.gate("bash", { command: "git push origin main" });
		const prompt = rig.interaction.status().question!;
		await rig.interaction.answer(prompt.interactionId, { resolution: "answered", selections: [], decision: "deny" });
		const outcome = await gatePromise;
		expect(outcome.block).toBe(true);
		expect(outcome.reason).toContain("denied by the user");
	});

	it("disabling permission enforcement allows without prompting", async () => {
		const rig = makeRig({ attachUI: false });
		rig.setSettings({ enabled: false });
		const outcome = await rig.controller.gate("bash", { command: "git push origin main" });
		expect(outcome.block).toBe(false);
	});

	it("child gating never prompts: ASK becomes DENY with a truthful reason", async () => {
		const rig = makeRig({ attachUI: true });
		const child = rig.controller.gateForChild("bash", { command: "git push origin main" });
		expect(child.block).toBe(true);
		expect(child.reason).toContain("children cannot prompt");
		expect(rig.interaction.status().pending).toBe(false); // no storm
		const allowedChild = rig.controller.gateForChild("bash", { command: "npm test" });
		expect(allowedChild.block).toBe(false);
	});

	it("PLAN stays absolute through the controller (permission modes cannot weaken it)", async () => {
		const rig = makeRig({ mode: "yolo", attachUI: true });
		const state = rig.state;
		state.mode = "plan";
		const outcome = await rig.controller.gate("bash", { command: "npm test" });
		expect(outcome.block).toBe(true);
		expect(outcome.reason).toContain("PLAN");
	});

	it("explicit persistent rules gate before mode defaults", async () => {
		const rig = makeRig({ mode: "yolo", attachUI: false });
		rig.controller.addRule({ tool: "bash", subject: "git push *", match: "wildcard", action: "deny" }, "persistent");
		const outcome = await rig.controller.gate("bash", { command: "git push origin main" });
		expect(outcome.block).toBe(true);
		expect(outcome.reason).toContain("persistent rule");
	});

	it("snapshot projections carry mode/rule counts/last decision and stay bounded", async () => {
		const rig = makeRig({ attachUI: true });
		await rig.controller.gate("bash", { command: "npm test" });
		const status = rig.controller.status();
		expect(status.enabled).toBe(true);
		expect(status.mode).toBe("normal");
		expect(status.persistentRules).toBe(0);
		expect(status.lastDecision?.tool).toBe("bash");
		expect(status.lastDecision?.action).toBe("allow");
		expect(status.summary).toContain("normal");
	});
});
