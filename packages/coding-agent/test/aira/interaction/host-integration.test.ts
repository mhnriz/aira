/**
 * Phase 11 — interaction & control layer through the real AgentSession path.
 *
 * - every session arms interaction/permission/task managers and publishes
 *   canonical snapshots;
 * - the permission gate sits in beforeToolCall: routine BUILD work passes,
 *   risky process asks (headless → truthful denial), deny blocks with a
 *   truthful reason the model sees;
 * - PLAN + yolo/permissive still denies mutation (permissions never weaken
 *   the mode);
 * - the model-facing `ask_user` and `tasks` tools are registered and active
 *   by default and drive the canonical managers;
 * - goal waiting integrates: an open question moves an active goal to
 *   waiting (kind user-question); an answer resumes it (waiting → active);
 * - child tool calls go through the deterministic root permission gate.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { buildAiraDoctorReport } from "../../../src/aira/commands/doctor.ts";
import { buildAiraStatusReport } from "../../../src/aira/commands/status.ts";
import type { AiraVerifierOutcome } from "../../../src/aira/verification/verifier.ts";
import { createHarness, type Harness } from "../../suite/harness.ts";

const PASS_OUTCOME: AiraVerifierOutcome = {
	ok: true,
	verdict: {
		verdict: "pass",
		summary: "All explicit requirements verified.",
		requirements: [{ id: "R1", text: "auth works", kind: "explicit", status: "verified" }],
		findings: [],
		evidence: [{ category: "execution", label: "tests", summary: "npm test exited 0" }],
		missingEvidence: [],
		scopeAssessment: { verdict: "in-scope", notes: [] },
		confidence: "high",
	},
};

function makeProjectDir(): string {
	const root = join(tmpdir(), `aira-suite-p11-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p11-proj", scripts: { test: "node test.js" } }));
	writeFileSync(join(root, "src", "main.ts"), "export const main = () => 1;\n");
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
	execFileSync("git", ["config", "user.name", "t"], { cwd: root });
	execFileSync("git", ["add", "-A"], { cwd: root });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
	return root;
}

const harnesses: Array<{ harness: Harness; root: string }> = [];
afterEach(() => {
	while (harnesses.length > 0) {
		const { harness, root } = harnesses.shift()!;
		harness.session.dispose();
		harness.faux.unregister();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

async function makeHarness(
	options: {
		mode?: "build" | "plan" | "review";
		permissionMode?: "normal" | "permissive" | "strict" | "yolo";
		permissionsEnabled?: boolean;
		goalAuto?: "off" | "smart" | "always";
	} = {},
) {
	const root = makeProjectDir();
	const harness = await createHarness({
		cwd: root,
		settings: {
			permissions: { enabled: options.permissionsEnabled ?? true, mode: options.permissionMode ?? "normal" },
			goals: { enabled: true, auto: options.goalAuto ?? "off" },
		} as never,
		airaGoalOptions: {
			persistence: {
				path: join(root, "goal.json"),
				load: () => undefined,
				save: () => ({ status: "ok", error: undefined, path: join(root, "goal.json") }),
				clear: () => ({ status: "ok", error: undefined, path: join(root, "goal.json") }),
				recover: () => undefined,
			},
		},
		airaVerificationOptions: {
			runner: async () => PASS_OUTCOME,
		},
	});
	harnesses.push({ harness, root });
	if (options.mode) {
		harness.session.setAiraMode(options.mode);
	}
	return harness;
}

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
	type: "toolCall" as const,
	id,
	name,
	arguments: args,
});

async function gateResult(harness: Harness, name: string, args: Record<string, unknown>) {
	return (await harness.session.agent.beforeToolCall?.({
		toolCall: { type: "toolCall", id: "tc", name, arguments: args },
		args,
		assistantMessage: fauxAssistantMessage(fauxText("work")) as never,
		context: { systemPrompt: "", messages: [] },
	})) as { block?: boolean; reason?: string } | undefined;
}

describe("Phase 11 interaction & control through the host", () => {
	it("arms the three managers and publishes canonical snapshots; tools are default-active", async () => {
		const harness = await makeHarness();
		expect(harness.session.airaInteraction).toBeDefined();
		expect(harness.session.airaPermissions).toBeDefined();
		expect(harness.session.airaTasks).toBeDefined();
		expect(harness.session.airaSessionState.interaction).toBeDefined();
		expect(harness.session.airaSessionState.permissions?.mode).toBe("normal");
		expect(harness.session.airaSessionState.tasks).toBeDefined();
		const active = harness.session.getActiveToolNames();
		expect(active).toContain("ask_user");
		expect(active).toContain("tasks");
		// Headless sessions: no UI bridge attached → questions resolve unavailable.
		expect(harness.session.airaSessionState.interaction?.uiAttached).toBe(false);
	});

	it("CASE A — safe read-only action under normal permissions passes the gate", async () => {
		const harness = await makeHarness();
		const read = await gateResult(harness, "read", { path: "src/main.ts" });
		expect(read?.block).toBeUndefined();
		const edit = await gateResult(harness, "edit", { path: "src/main.ts" });
		expect(edit?.block).toBeUndefined();
		const bash = await gateResult(harness, "bash", { command: "npm test" });
		expect(bash?.block).toBeUndefined();
		expect(harness.session.airaSessionState.permissions?.lastDecision?.action).toBe("allow");
	});

	it("CASE B/C — risky mutation asks headless → truthful denial the model sees", async () => {
		const harness = await makeHarness();
		const denied = await gateResult(harness, "bash", { command: "git push origin main" });
		expect(denied?.block).toBe(true);
		expect(denied?.reason).toContain("permission prompt unavailable");
		// The model-facing tool result would carry exactly this reason.
		expect(harness.session.airaSessionState.permissions?.lastDecision?.action).toBe("deny");
	});

	it("CASE E — PLAN + yolo: mutation is still denied at the host boundary", async () => {
		const harness = await makeHarness({ permissionMode: "yolo" });
		harness.session.setAiraMode("plan");
		const denied = await gateResult(harness, "bash", { command: "npm test" });
		expect(denied?.block).toBe(true);
		expect(denied?.reason).toContain("PLAN");
		const deniedEdit = await gateResult(harness, "edit", { path: "src/main.ts" });
		expect(deniedEdit?.block).toBe(true);
		expect(deniedEdit?.reason).toContain("PLAN");
	});

	it("PLAN keeps the interaction surface: ask_user and tasks stay active", async () => {
		const harness = await makeHarness();
		harness.session.setAiraMode("plan");
		const active = harness.session.getActiveToolNames();
		expect(active).toContain("ask_user");
		expect(active).toContain("tasks");
		expect(active).not.toContain("bash");
	});

	it("CASE F — ask_user runs through the real model tool; an injected answer reaches the transcript", async () => {
		const harness = await makeHarness();
		const interaction = harness.session.airaInteraction!;
		interaction.attachUI(); // simulate the TUI bridge
		const model = harness.faux;
		harness.setResponses([
			fauxAssistantMessage([
				toolCall("t1", "ask_user", {
					question: "Use JWT or sessions?",
					options: [{ title: "JWT" }, { title: "Sessions" }],
					allowFreeform: false,
				}),
			]),
			fauxAssistantMessage(fauxText("the user chose JWT")),
		]);
		const promptPromise = harness.session.prompt("ask the user about auth");
		// Wait for the question to open and answer it like the TUI dialog would.
		await waitForCondition(() => interaction.status().pending);
		const question = interaction.status().question!;
		expect(question.type).toBe("semantic");
		interaction.answer(question.interactionId, { resolution: "answered", selections: ["o1"] });
		await promptPromise;
		const texts = harness.session.messages.map((m) => messageText(m));
		expect(texts.some((t) => t.includes("User answered: JWT"))).toBe(true);
		void model;
	});

	it("CASE G — goal enters waiting (user-question) and resumes on the answer", async () => {
		const harness = await makeHarness({ goalAuto: "always" });
		const interaction = harness.session.airaInteraction!;
		interaction.attachUI();
		harness.setResponses([
			fauxAssistantMessage([
				toolCall("t1", "write", { path: "src/auth.ts", content: "export const auth = true;\n" }),
			]),
			fauxAssistantMessage([
				toolCall("t2", "ask_user", {
					question: "Keep v1 compatibility?",
					options: [{ title: "Yes" }, { title: "No" }],
					allowFreeform: false,
				}),
			]),
			fauxAssistantMessage(fauxText("implemented and verified")),
		]);
		const promptPromise = harness.session.prompt("implement the auth middleware robustly");
		// The goal's "active" window can be shorter than one poll; key on the
		// stable signals instead: the open question (pending) and the goal's
		// waiting projection.
		await waitForCondition(() => interaction.status().pending);
		await waitForCondition(() => harness.session.airaSessionState.goal?.status === "waiting");
		// The goal reflects the open question truthfully (kind user-question).
		const goalWhileWaiting = harness.session.airaSessionState.goal!;
		expect(goalWhileWaiting.status).toBe("waiting");
		expect(goalWhileWaiting.waiting?.kind).toBe("user-question");
		expect(goalWhileWaiting.waiting?.reason).toBe("input-required");
		expect(goalWhileWaiting.needsUserInput).toBe(true);

		const question = interaction.status().question!;
		interaction.answer(question.interactionId, { resolution: "answered", selections: ["o1"] });
		// The goal resumes truthfully (waiting → active).
		await waitForCondition(() => harness.session.airaSessionState.goal?.status === "active");
		expect(harness.session.airaSessionState.goal?.waiting).toBeUndefined();
		await promptPromise;
		// The round completes and the boundary verification (PASS) completes the goal.
		await waitForCondition(() => harness.session.airaSessionState.goal?.status === "completed", 6000);
	});

	it("a cancelled semantic question leaves the goal waiting (no invented answer)", async () => {
		const harness = await makeHarness({ goalAuto: "always" });
		const interaction = harness.session.airaInteraction!;
		interaction.attachUI();
		harness.setResponses([
			fauxAssistantMessage([
				toolCall("t1", "ask_user", {
					question: "Which approach?",
					options: [{ title: "A" }, { title: "B" }],
					allowFreeform: false,
				}),
			]),
			fauxAssistantMessage(fauxText("the round continues after the cancellation")),
		]);
		const promptPromise = harness.session.prompt("implement the adapter");
		await waitForCondition(() => interaction.status().pending);
		const question = interaction.status().question!;
		interaction.answer(question.interactionId, { resolution: "cancelled", selections: [] });
		// The goal stays waiting truthfully (cancel is NOT an answer).
		await promptPromise;
		const goal = harness.session.airaSessionState.goal!;
		expect(goal.status).toBe("waiting");
		expect(goal.waiting?.kind).toBe("user-question");
		expect(goal.waiting?.reason).toBe("input-required");
	});

	it("permission ASK moves an active goal to waiting with kind permission; denial resumes it", async () => {
		const harness = await makeHarness({ goalAuto: "always" });
		const interaction = harness.session.airaInteraction!;
		interaction.attachUI();
		harness.setResponses([
			// The model attempts a risky command inside the goal round.
			fauxAssistantMessage([toolCall("t1", "bash", { command: "git push origin main" })]),
			fauxAssistantMessage(fauxText("handled the outcome")),
		]);
		const promptPromise = harness.session.prompt("ship the release");
		await waitForCondition(() => interaction.status().pending);
		await waitForCondition(() => harness.session.airaSessionState.goal?.status === "waiting");
		const goalWaiting = harness.session.airaSessionState.goal!;
		expect(goalWaiting.waiting?.kind).toBe("permission");
		expect(goalWaiting.waiting?.reason).toBe("permission");

		const question = interaction.status().question!;
		interaction.answer(question.interactionId, { resolution: "answered", selections: [], decision: "allow-once" });
		await waitForCondition(() => harness.session.airaSessionState.goal?.status === "active");
		expect(harness.session.airaSessionState.goal?.waiting).toBeUndefined();
		await promptPromise.catch(() => undefined);
	});

	it("CASE H — tasks tool through the session: model-created rows + orchestration projection agree", async () => {
		const harness = await makeHarness();
		const tasks = harness.session.airaTasks!;
		harness.setResponses([
			fauxAssistantMessage([
				toolCall("t1", "tasks", { action: "create", title: "scaffold" }),
				toolCall("t2", "tasks", { action: "create", title: "wire module", dependsOn: ["t-unknown"] }),
			]),
			fauxAssistantMessage(fauxText("done")),
		]);
		await harness.session.prompt("track the scaffold work");
		const status = tasks.status();
		expect(status.total).toBe(1);
		expect(status.summary).toContain("0/1");
		// The model sees the truthful rejection for the unknown dependency.
		const texts = harness.session.messages.map((m) => messageText(m));
		expect(texts.some((t) => t.includes("unknown dependency"))).toBe(true);
		// /tasks-style report renders the canonical snapshot token-free.
		expect(status.rows[0]?.source).toBe("model");
	});

	it("CASE J — doctor/status surfaces report the new subsystems truthfully", async () => {
		const harness = await makeHarness({ permissionMode: "strict" });
		const report = buildAiraDoctorReport(harness.session.airaSessionState);
		const permissionCheck = report.checks.find((check) => check.name === "permissions")!;
		expect(permissionCheck.pass).toBe(true);
		expect(permissionCheck.detail).toContain("mode strict");
		expect(report.checks.find((check) => check.name === "interaction")?.pass).toBe(true);
		expect(report.checks.find((check) => check.name === "tasks")?.pass).toBe(true);
		const status = buildAiraStatusReport(harness.session.airaSessionState);
		expect(status.permissions).toBe("strict");
		expect(status.tasks).toContain("no tasks");
	});

	it("CASE L — shutdown with a pending question leaves no wedged state", async () => {
		const harness = await makeHarness();
		const interaction = harness.session.airaInteraction!;
		interaction.attachUI();
		harness.setResponses([
			fauxAssistantMessage([
				toolCall("t1", "ask_user", { question: "Do you approve?", options: [{ title: "Yes" }] }),
			]),
		]);
		const promptPromise = harness.session.prompt("ask the user");
		await waitForCondition(() => interaction.status().pending);
		harness.session.dispose();
		await promptPromise.catch(() => undefined);
		const snapshot = harness.session.airaSessionState.interaction!;
		expect(snapshot.pending).toBe(false);
		// Re-probe: the session still owns valid canonical state (not wedged).
		expect(snapshot.recentClosed.length).toBeGreaterThan(0);
	});

	it("session starts with an empty task graph and clean interaction state", async () => {
		const harness = await makeHarness();
		expect(harness.session.airaSessionState.tasks?.total).toBe(0);
		expect(harness.session.airaSessionState.interaction?.pending).toBe(false);
	});
});

function messageText(message: unknown): string {
	const content = (message as { content?: unknown })?.content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null)
		.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
		.join("\n");
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 6000, intervalMs = 15): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) {
			return;
		}
		if (Date.now() > deadline) {
			const last = harnesses[harnesses.length - 1]?.harness;
			const state = last?.session.airaSessionState;
			throw new Error(
				`condition never became true (goal=${state?.goal?.status} interactionPending=${state?.interaction?.pending} questions=${JSON.stringify(state?.interaction?.question)?.slice(0, 120)})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
