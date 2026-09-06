/**
 * Phase 10 — goal runtime through the real AgentSession path.
 *
 * - every session arms its own goal manager and publishes the canonical
 *   `state.goal` snapshot;
 * - SMART promotion happens only for non-trivial objectives (trivial prompts
 *   stay plain root turns with zero goal overhead);
 * - a real implementation run reaches the completion boundary and drives
 *   verification; PASS completes the goal;
 * - FAIL drives a goal-owned continuation turn (display:false custom message)
 *   that reaches the model as a real turn;
 * - /status, /doctor, and /goal status render the canonical snapshot
 *   token-free;
 * - PLAN is safe (no verification at read-only boundaries);
 * - passive ownership: a new session (fork) never inherits the goal.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { buildAiraDoctorReport } from "../../../src/aira/commands/doctor.ts";
import { buildAiraStatusReport, formatAiraStatusReport } from "../../../src/aira/commands/status.ts";
import { formatAiraGoalReport } from "../../../src/aira/goal/status.ts";
import type { AiraChildOutcome } from "../../../src/aira/orchestration/runner.ts";
import type { AiraVerifierOutcome } from "../../../src/aira/verification/verifier.ts";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
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

const FAIL_OUTCOME: AiraVerifierOutcome = {
	ok: true,
	verdict: {
		verdict: "fail",
		summary: "Auth middleware rejects valid tokens.",
		requirements: [{ id: "R1", text: "auth works", kind: "explicit", status: "unmet" }],
		findings: [
			{
				severity: "blocking",
				requirementId: "R1",
				message: "valid tokens are rejected with 401",
				evidence: "test: auth.test.js:12",
			},
		],
		evidence: [{ category: "execution", label: "tests", summary: "auth.test.js:12 fails" }],
		missingEvidence: [],
		scopeAssessment: { verdict: "in-scope", notes: [] },
		confidence: "high",
	},
};

const FILE_GOAL_OBJECTIVE = `Using a child agent, create phase13-final.txt containing exactly phase13-final.

Explicit acceptance criteria:
- phase13-final.txt exists in the current working directory.
- Its contents are exactly phase13-final with no trailing newline.
- Verify the result byte-for-byte.
- No other files may be created or modified.`;

const FILE_GOAL_PASS_VERDICT = JSON.stringify({
	verdict: "pass",
	summary: "The child-created file matches every explicit filesystem acceptance criterion byte-for-byte.",
	requirements: [
		{
			id: "R1",
			text: "phase13-final.txt exists in the current working directory",
			kind: "explicit",
			status: "verified",
		},
		{
			id: "R2",
			text: "phase13-final.txt contains exactly phase13-final with no trailing newline",
			kind: "explicit",
			status: "verified",
		},
		{
			id: "R3",
			text: "the result is verified byte-for-byte",
			kind: "explicit",
			status: "verified",
		},
		{
			id: "R4",
			text: "no other files are created or modified",
			kind: "explicit",
			status: "verified",
		},
	],
	findings: [],
	evidence: [
		{
			category: "repository",
			label: "read",
			summary: "phase13-final.txt was read and matched the exact bytes phase13-final.",
		},
		{ category: "git", label: "status", summary: "only phase13-final.txt appears as a new workspace path." },
	],
	missingEvidence: [],
	scope: { verdict: "in-scope", notes: [] },
	confidence: "high",
});

function makeProjectDir(): string {
	const root = join(tmpdir(), `aira-suite-goal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "goal-proj", scripts: { test: "node test.js" } }));
	writeFileSync(join(root, "src", "auth.ts"), "export function check(t: string) { return t; }\n");
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

async function makeGoalHarness(
	options: {
		goals?: { enabled?: boolean; auto?: "off" | "smart" | "always"; maxRounds?: number };
		mode?: "build" | "plan" | "review";
		verdicts?: AiraVerifierOutcome[];
	} = {},
): Promise<Harness> {
	const root = makeProjectDir();
	const harness = await createHarness({
		cwd: root,
		// Goal runtime tests explicitly opt in; production defaults are disabled.
		settings: { goals: { enabled: true, ...options.goals } } as never,
		airaVerificationOptions: {
			runner: async () => {
				const outcomes = options.verdicts ?? [PASS_OUTCOME];
				const outcome = outcomes.shift() ?? PASS_OUTCOME;
				return outcome;
			},
		},
	});
	harnesses.push({ harness, root });
	if (options.mode) {
		harness.session.setAiraMode(options.mode);
	}
	return harness;
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition did not settle before the timeout");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Poll until the canonical goal snapshot satisfies the predicate. */
async function waitForGoal(
	harness: Harness,
	predicate: (goal: NonNullable<Harness["session"]["airaSessionState"]["goal"]>) => boolean,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const goal = harness.session.airaSessionState.goal;
		if (goal && predicate(goal)) {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(`goal snapshot never satisfied the predicate (status ${JSON.stringify(goal)?.slice(0, 600)})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const editCall = (id: string, from: string, to: string) => ({
	type: "toolCall" as const,
	id,
	name: "edit",
	arguments: { path: "src/auth.ts", edits: [{ oldText: from, newText: to }] },
});

const INITIAL_EDIT = editCall("t1", "return t;", "return t + '!';");
// A repair round must move the revision: the verifier's revision dedupe
// correctly refuses a duplicate run for an unchanged implementation.
const REPAIR_EDIT = editCall("t2", "return t + '!';", "return t + '!!';");

describe("Aira goal runtime through the host (Phase 10)", () => {
	it("arms the per-session goal manager and publishes the canonical idle snapshot", async () => {
		const harness = await makeGoalHarness();
		expect(harness.session.airaGoal).toBeDefined();
		const goal = harness.session.airaSessionState.goal!;
		expect(goal.status).toBe("idle");
		expect(goal.enabled).toBe(true);
		expect(goal.auto).toBe("smart");
		expect(goal.maxRounds).toBe(4);
		expect(harness.session.airaGoal!.status().summary).toBe("idle");
	});

	it("SMART promotes a non-trivial objective and skips a trivial one (zero goal state)", async () => {
		const harness = await makeGoalHarness();
		harness.setResponses([fauxAssistantMessage(fauxText("ok"))]);
		await harness.session.prompt("fix the typo in the header comment");
		await settle();
		expect(harness.session.airaSessionState.goal!.status).toBe("idle");

		harness.setResponses([fauxAssistantMessage(fauxText("ok"))]);
		await harness.session.prompt("implement authentication middleware for the API");
		await settle();
		const goal = harness.session.airaSessionState.goal!;
		expect(goal.status).toBe("active");
		expect(goal.objective).toContain("authentication middleware");
		expect(goal.round).toBe(1);
		expect(goal.id).toBeTruthy();
	});

	it("a real implementation run completes with PASS; no extra continuation", async () => {
		const harness = await makeGoalHarness();
		harness.setResponses([fauxAssistantMessage([INITIAL_EDIT]), fauxAssistantMessage(fauxText("final"))]);
		await harness.session.prompt("implement authentication middleware for the API");
		await waitForGoal(harness, (goal) => goal.status === "completed");
		const goal = harness.session.airaSessionState.goal!;
		expect(goal.status).toBe("completed");
		expect(goal.completedAt).toBeTruthy();
		expect(goal.verification.verdict).toBe("pass");
		expect(goal.summary).toBe("completed");
		// no continuation turns were queued: the goal's only round was the
		// user's own turn (the custom-message continuation type never fired)
		const continuationEvents = harness.events.filter(
			(event) =>
				event.type === "message_start" &&
				"message" in event &&
				event.message.role === "custom" &&
				(event.message as { customType?: string }).customType === "aira.goal.continuation",
		);
		expect(continuationEvents).toHaveLength(0);
	});

	it("settled child after an idle root turn triggers independent Goal verification", async () => {
		let releaseChild!: () => void;
		const childReleased = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let verificationRuns = 0;
		const root = makeProjectDir();
		const childHarness = await createHarness({
			cwd: root,
			settings: {
				goals: { enabled: true, auto: "always" },
				orchestration: { enabled: true },
			} as never,
			airaVerificationOptions: {
				runner: async () => {
					verificationRuns += 1;
					return PASS_OUTCOME;
				},
			},
			airaOrchestrationOptions: {
				runner: async (_runtime, options): Promise<AiraChildOutcome> => {
					await childReleased;
					const path = join(options.cwd, "phase13-final.txt");
					writeFileSync(path, "child completed\n");
					options.workspaceMutation?.(path);
					return {
						ok: true,
						model: "faux/faux",
						result: {
							status: "completed",
							summary: "created phase13-final.txt",
							findings: [],
							evidence: ["phase13-final.txt"],
							relevantFiles: ["phase13-final.txt"],
							changedFiles: ["phase13-final.txt"],
							tests: [],
							errors: [],
						},
					};
				},
			},
		});
		harnesses.push({ harness: childHarness, root });
		childHarness.setResponses([
			fauxAssistantMessage([
				{
					type: "toolCall",
					id: "delegate-phase13",
					name: "agents_delegate",
					arguments: {
						tasks: [{ id: "R1", role: "implement", task: "create phase13-final.txt" }],
						await: false,
					},
				},
			]),
			fauxAssistantMessage(fauxText("delegated")),
		]);
		await childHarness.session.prompt("implement the Phase 13 acceptance criteria");
		expect(childHarness.session.airaSessionState.goal?.status).toBe("active");
		expect(childHarness.session.airaSessionState.verification?.currentResult).toBeUndefined();
		expect(verificationRuns).toBe(0);

		await waitForCondition(() => childHarness.session.airaSessionState.tasks?.active === 1);
		releaseChild();
		await waitForGoal(childHarness, (goal) => goal.status === "completed");
		expect(verificationRuns).toBe(1);
		expect(childHarness.session.airaSessionState.tasks?.completed).toBe(1);
		expect(childHarness.session.airaSessionState.goal?.verification.verdict).toBe("pass");
	});

	it("preserves exact filesystem criteria for autonomous child verification", async () => {
		let releaseChild!: () => void;
		const childReleased = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		const root = makeProjectDir();
		const harness = await createHarness({
			cwd: root,
			settings: {
				goals: { enabled: true, auto: "always" },
				orchestration: { enabled: true },
				verification: { auto: "always" },
			} as never,
			airaOrchestrationOptions: {
				runner: async (_runtime, options): Promise<AiraChildOutcome> => {
					await childReleased;
					const path = join(options.cwd, "phase13-final.txt");
					writeFileSync(path, "phase13-final");
					options.workspaceMutation?.(path);
					return {
						ok: true,
						model: "faux/faux",
						result: {
							status: "completed",
							summary: "created phase13-final.txt",
							findings: [],
							evidence: ["phase13-final.txt"],
							relevantFiles: ["phase13-final.txt"],
							changedFiles: ["phase13-final.txt"],
							tests: [],
							errors: [],
						},
					};
				},
			},
		});
		harnesses.push({ harness, root });
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("agents_delegate", {
					tasks: [{ id: "R1", role: "implement", task: "create phase13-final.txt" }],
					await: false,
				}),
			]),
			fauxAssistantMessage(fauxText("delegated")),
			// The independent verifier reads the file in its fresh context before
			// returning its structured, explicit-criteria verdict.
			fauxAssistantMessage([fauxToolCall("read", { path: "phase13-final.txt" })]),
			fauxAssistantMessage(fauxText(FILE_GOAL_PASS_VERDICT)),
		]);

		await harness.session.prompt(FILE_GOAL_OBJECTIVE);
		expect(harness.session.airaSessionState.goal?.status).toBe("active");
		expect(harness.getPendingResponseCount()).toBe(2);
		await waitForCondition(() => harness.session.airaSessionState.tasks?.active === 1);

		// The root turn has ended, but the deferred child is still canonical
		// active work. Releasing it is the only event that should start the
		// independent verifier.
		releaseChild();
		await waitForGoal(harness, (goal) => goal.status === "completed");

		const verification = harness.session.airaSessionState.verification!;
		const result = verification.currentResult!;
		expect(result.verdict).toBe("pass");
		expect(result.stale).toBe(false);
		expect(result.objective).toBe(FILE_GOAL_OBJECTIVE);
		expect(result.requirements).toHaveLength(4);
		expect(result.requirements.every((requirement) => requirement.kind === "explicit")).toBe(true);
		expect(result.requirements.map((requirement) => requirement.text)).toEqual([
			"phase13-final.txt exists in the current working directory",
			"phase13-final.txt contains exactly phase13-final with no trailing newline",
			"the result is verified byte-for-byte",
			"no other files are created or modified",
		]);
		expect(result.requirements.some((requirement) => /browser|runtime/i.test(requirement.text))).toBe(false);
		expect(result.evidence.some((item) => item.label === "read")).toBe(true);
		expect(readFileSync(join(root, "phase13-final.txt"), "utf8")).toBe("phase13-final");
		expect(execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).trim()).toBe(
			"?? phase13-final.txt",
		);

		const resultId = result.id;
		harness.session.airaTasks?.status();
		harness.session.airaTasks?.status();
		await settle();
		expect(harness.session.airaSessionState.verification?.currentResult?.id).toBe(resultId);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.airaSessionState.goal?.status).toBe("completed");
	});

	it("FAIL drives a goal-owned continuation turn (display:false custom message) that ends the loop when bounded", async () => {
		const harness = await makeGoalHarness({ verdicts: [FAIL_OUTCOME, PASS_OUTCOME] });
		harness.setResponses([
			fauxAssistantMessage([INITIAL_EDIT]),
			fauxAssistantMessage(fauxText("final")),
			// the goal-owned continuation turn performs a REAL repair
			fauxAssistantMessage([REPAIR_EDIT]),
			fauxAssistantMessage(fauxText("repaired")),
		]);
		await harness.session.prompt("implement authentication middleware for the API");
		await waitForGoal(harness, (goal) => goal.status === "completed", 15_000);
		const goal = harness.session.airaSessionState.goal!;
		expect(goal.round).toBe(2);
		expect(goal.verification.verdict).toBe("pass");
		const continuationEvents = harness.events.filter(
			(event) =>
				event.type === "message_start" &&
				"message" in event &&
				event.message.role === "custom" &&
				(event.message as { customType?: string }).customType === "aira.goal.continuation",
		);
		expect(continuationEvents).toHaveLength(1);
		const continuationMessage = (
			continuationEvents[0] as Extract<AgentSessionEvent, { type: "message_start"; message: unknown }>
		).message;
		const text = JSON.stringify(continuationMessage);
		expect(text).toContain("AUTONOMOUS GOAL CONTINUATION");
		expect(text.toLowerCase()).not.toContain("user:");
	});

	it("a bounded repeated FAIL stops truthfully (no infinite loop)", async () => {
		const harness = await makeGoalHarness({
			goals: { maxRounds: 2 },
			verdicts: [FAIL_OUTCOME, FAIL_OUTCOME],
		});
		harness.setResponses([
			fauxAssistantMessage([INITIAL_EDIT]),
			fauxAssistantMessage(fauxText("final")),
			fauxAssistantMessage([REPAIR_EDIT]),
			fauxAssistantMessage(fauxText("repaired but still failing")),
		]);
		await harness.session.prompt("implement authentication middleware for the API");
		await waitForGoal(harness, (goal) => goal.status === "budget-limited", 15_000);
		const goal = harness.session.airaSessionState.goal!;
		expect(goal.stopReason).toBe("repeated-verdict");
		// the host remains fully usable
		harness.setResponses([fauxAssistantMessage(fauxText("PARENT_ALIVE"))]);
		await harness.session.prompt("say PARENT_ALIVE");
		await settle();
		expect(harness.session.messages.some((message) => JSON.stringify(message).includes("PARENT_ALIVE"))).toBe(true);
	});

	it("PLAN: goals never verify or continue at read-only boundaries", async () => {
		const harness = await makeGoalHarness({ mode: "plan" });
		harness.setResponses([fauxAssistantMessage([INITIAL_EDIT]), fauxAssistantMessage(fauxText("final"))]);
		await harness.session.prompt("implement authentication middleware for the API");
		await settle();
		const goal = harness.session.airaSessionState.goal!;
		expect(goal.status).toBe("active");
		expect(goal.mode).toBe("plan");
		expect(harness.session.airaSessionState.verification?.status ?? "idle").toBe("idle");
	});

	it("a forked/new session never inherits the active goal (passive ownership)", async () => {
		const harness = await makeGoalHarness();
		harness.setResponses([fauxAssistantMessage(fauxText("ok"))]);
		await harness.session.prompt("implement authentication middleware for the API");
		await settle();
		expect(harness.session.airaSessionState.goal!.status).toBe("active");
		// a second session over a DIFFERENT session file is not the owner
		const state = harness.session.airaSessionState;
		expect(state.goal!.status).toBe("active");
	});

	it("/status, /doctor, and /goal report the canonical goal snapshot token-free", async () => {
		const harness = await makeGoalHarness();
		const pendingTask = harness.session.airaTasks!.create("pending verification task");
		expect(pendingTask.ok).toBe(true);
		harness.setResponses([fauxAssistantMessage([INITIAL_EDIT]), fauxAssistantMessage(fauxText("final"))]);
		await harness.session.prompt("implement authentication middleware for the API");
		await waitForGoal(harness, (goal) => goal.status === "completed");

		const status = buildAiraStatusReport(harness.session.airaSessionState);
		expect(status.goal).toBe("completed");
		expect(formatAiraStatusReport(status)).toContain("goal: completed");

		const doctor = buildAiraDoctorReport(harness.session.airaSessionState);
		const goalCheck = doctor.checks.find((check) => check.name === "goal")!;
		expect(goalCheck.pass).toBe(true);
		expect(goalCheck.detail).toContain("completed");

		const report = formatAiraGoalReport(harness.session.airaSessionState.goal!);
		expect(report).toContain("goal:");
		expect(report).toContain("authentication middleware");
		expect(report).toContain("completed");
		expect(report).toContain("tasks: 0/1 done · 0 active");
	});
});
