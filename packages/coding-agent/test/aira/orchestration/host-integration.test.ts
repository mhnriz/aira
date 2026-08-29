/**
 * Phase 9 — orchestration through the real AgentSession path.
 *
 * - every session arms its own orchestration manager and publishes the
 *   canonical snapshot;
 * - the delegation tools are registered and active by default;
 * - the model can delegate a child through agents_delegate; the child runs
 *   through the NATIVE fresh-context path (real streamFn + scripted child
 *   responses) and returns a structured result;
 * - implement children can mutate the workspace in BUILD (real edit via the
 *   child tool loop);
 * - PLAN refuses implement/test at dispatch and PLAN children only receive
 *   read-only tool sets (a scripted write call is rejected as an unknown
 *   tool — no mutation path exists);
 * - REVIEW can delegate;
 * - settings off refuses dispatch;
 * - child failure does not break the root session;
 * - /doctor reports orchestration health without dispatching;
 * - /status carries the restrained orchestration line;
 * - session dispose aborts in-flight children.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { buildAiraDoctorReport } from "../../../src/aira/commands/doctor.ts";
import { buildAiraStatusReport } from "../../../src/aira/commands/status.ts";
import { createHarness, type Harness } from "../../suite/harness.ts";

const COMPLETED_RESULT_JSON = JSON.stringify({
	status: "completed",
	summary: "mapped the player module",
	findings: ["stream switching lives in streamController.ts"],
	evidence: ["src/player.ts:1"],
	relevantFiles: ["src/player.ts"],
	changedFiles: [],
	tests: [],
	errors: [],
});

const IMPLEMENTED_RESULT_JSON = JSON.stringify({
	status: "completed",
	summary: "fixed seek to clamp negative values",
	findings: [],
	evidence: ["src/player.ts:1"],
	relevantFiles: ["src/player.ts"],
	changedFiles: ["src/player.ts"],
	tests: [],
	errors: [],
});

function makeProjectDir(): string {
	const root = join(tmpdir(), `aira-suite-orchestration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "player.ts"), "export function seek(t: number) { return t; }\n");
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

function rootOf(harness: Harness): string {
	return harnesses.find((entry) => entry.harness === harness)?.root ?? harness.tempDir;
}

async function makeHarness(
	options: {
		settings?: { enabled?: boolean; maxParallel?: number; model?: string; timeoutMs?: number };
		mode?: "build" | "plan" | "review";
		withRunner?: boolean;
	} = {},
): Promise<Harness> {
	const root = makeProjectDir();
	const harness = await createHarness({
		cwd: root,
		settings: { orchestration: { enabled: true, ...options.settings } } as never,
	});
	harnesses.push({ harness, root });
	if (options.mode) {
		harness.session.setAiraMode(options.mode);
	}
	return harness;
}

const delegateCall = (id: string, tasks: unknown[], awaitResults = true) => ({
	type: "toolCall" as const,
	id,
	name: "agents_delegate",
	arguments: { tasks, await: awaitResults },
});

const editCall = (id: string) => ({
	type: "toolCall" as const,
	id,
	name: "edit",
	arguments: { path: "src/player.ts", edits: [{ oldText: "return t;", newText: "return Math.max(0, t);" }] },
});

const writeCall = (id: string) => ({
	type: "toolCall" as const,
	id,
	name: "write",
	arguments: { path: "src/hacked.ts", content: "export const hacked = true;\n" },
});

/** Poll until the canonical orchestration snapshot satisfies the predicate. */
async function waitForOrchestration(
	harness: Harness,
	predicate: (status: NonNullable<Harness["session"]["airaSessionState"]["orchestration"]>) => boolean,
	timeoutMs = 8000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = harness.session.airaSessionState.orchestration;
		if (status && predicate(status)) {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`orchestration snapshot never satisfied the predicate (status ${JSON.stringify(status)?.slice(0, 600)})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("Aira orchestration through the host (Phase 9)", () => {
	it("arms the per-session orchestration manager and publishes the canonical snapshot", async () => {
		const harness = await makeHarness();
		expect(harness.session.airaOrchestration).toBeDefined();
		expect(harness.session.airaSessionState.orchestration).toBeDefined();
		expect(harness.session.airaSessionState.orchestration!.status).toBe("idle");
		expect(harness.session.airaSessionState.orchestration!.maxConcurrency).toBe(2);
		// The delegation tools are registered and active by default.
		const activeTools = harness.session.getActiveToolNames();
		expect(activeTools).toContain("agents_delegate");
		expect(activeTools).toContain("agents_status");
		expect(activeTools).toContain("agents_cancel");
	});

	it("the model delegates a NATIVE child that returns a structured result", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			// Root: delegate one explore child.
			fauxAssistantMessage([delegateCall("t1", [{ role: "explore", task: "map the player module" }])]),
			// The NATIVE child consumes the next response as its final result.
			fauxAssistantMessage(fauxText(COMPLETED_RESULT_JSON)),
			// Root continues after the tool result.
			fauxAssistantMessage(fauxText("done")),
		]);
		await harness.session.prompt("delegate exploration of the player module");
		await waitForOrchestration(
			harness,
			(status) => status.children.length === 1 && status.children[0]!.status === "completed",
		);
		const status = harness.session.airaSessionState.orchestration!;
		expect(status.children[0]!.role).toBe("explore");
		expect(status.children[0]!.status).toBe("completed");
		expect(status.recentResults[0]!.summary).toContain("mapped the player module");
		expect(status.failures).toHaveLength(0);
		// The root model consumed exactly the scripted responses (no extras).
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("an implement child mutates the workspace in BUILD through the native tool loop", async () => {
		const root = join(tmpdir(), `aira-suite-orch-mut-${Date.now()}`);
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "player.ts"), "export function seek(t: number) { return t; }\n");
		const harness = await createHarness({ cwd: root });
		harnesses.push({ harness, root });
		harness.setResponses([
			fauxAssistantMessage([
				delegateCall("t1", [{ role: "implement", task: "make seek clamp negative values in src/player.ts" }]),
			]),
			// Child turn 1: edit the file.
			fauxAssistantMessage([editCall("c1")]),
			// Child turn 2: structured result.
			fauxAssistantMessage(fauxText(IMPLEMENTED_RESULT_JSON)),
			fauxAssistantMessage(fauxText("done")),
		]);
		await harness.session.prompt("delegate the seek clamp fix");
		await waitForOrchestration(
			harness,
			(status) => status.children.length === 1 && status.children[0]!.status === "completed",
		);
		const content = readFileSync(join(root, "src", "player.ts"), "utf8");
		expect(content).toContain("Math.max(0, t)");
		const run = harness.session.airaOrchestration!.list()[0]!;
		expect(run.result?.changedFiles).toContain("src/player.ts");
	});

	it("PLAN cannot be bypassed through orchestration: implement refused, children read-only", async () => {
		const harness = await makeHarness({ mode: "plan" });
		harness.setResponses([
			// Root delegates implement in PLAN (refused at dispatch) and a
			// read-only review child (accepted).
			fauxAssistantMessage([
				delegateCall("t1", [{ role: "implement", task: "change src/player.ts" }]),
				delegateCall("t2", [{ role: "review", task: "review src/player.ts" }]),
			]),
			// The review child consumes its structured result.
			fauxAssistantMessage(fauxText(COMPLETED_RESULT_JSON)),
			fauxAssistantMessage(fauxText("done")),
		]);
		await harness.session.prompt("delegate a change and a review");
		await waitForOrchestration(
			harness,
			(status) => status.children.length >= 1 && status.children[0]!.status !== "pending",
		);
		const runs = harness.session.airaOrchestration!.list();
		// The implement task never launched: no implement run exists.
		expect(runs.some((run) => run.role === "implement")).toBe(false);
		// Review children ran (read-only, allowed in PLAN); the implement
		// request was refused per-task in the same tool call.
		expect(runs.some((run) => run.role === "review" && run.status === "completed")).toBe(true);
		// No workspace mutation happened.
		const player = readFileSync(join(rootOf(harness), "src", "player.ts"), "utf8");
		expect(player).toContain("return t;");
		expect(player).not.toContain("Math.max");
	});

	it("PLAN child tool sets offer no mutation path: a scripted write call is an unknown tool", async () => {
		const harness = await makeHarness({ mode: "plan" });
		harness.setResponses([
			fauxAssistantMessage([delegateCall("t1", [{ role: "explore", task: "explore src" }])]),
			// Child attempts a workspace write — the tool does not exist in the
			// child's mode-gated set, so the execution fails closed.
			fauxAssistantMessage([writeCall("c1")]),
			fauxAssistantMessage(fauxText(COMPLETED_RESULT_JSON)),
			fauxAssistantMessage(fauxText("done")),
		]);
		await harness.session.prompt("delegate exploration");
		await waitForOrchestration(
			harness,
			(status) => status.children.length === 1 && status.children[0]!.status === "completed",
		);
		expect(harness.session.airaSessionState.orchestration!.children[0]!.status).toBe("completed");
		// The write never landed.
		try {
			readFileSync(join(rootOf(harness), "src", "hacked.ts"), "utf8");
			throw new Error("hacked.ts must not exist");
		} catch (error) {
			expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
		}
	});

	it("REVIEW mode can delegate inspection-oriented children", async () => {
		const harness = await makeHarness({ mode: "review" });
		harness.setResponses([
			fauxAssistantMessage([delegateCall("t1", [{ role: "review", task: "review src/player.ts for correctness" }])]),
			fauxAssistantMessage(fauxText(COMPLETED_RESULT_JSON)),
			fauxAssistantMessage(fauxText("done")),
		]);
		await harness.session.prompt("delegate a review");
		await waitForOrchestration(
			harness,
			(status) => status.children.length === 1 && status.children[0]!.status === "completed",
		);
		expect(harness.session.airaSessionState.orchestration!.children[0]!.role).toBe("review");
	});

	it("settings off refuses dispatch through the tool", async () => {
		const harness = await makeHarness({ settings: { enabled: false } });
		const result = await harness.session.airaOrchestration!.schedule([{ role: "explore", task: "x" }]);
		expect(result.ok).toBe(false);
		expect(result.tasks[0]!.reason).toContain("disabled");
		expect(harness.session.airaSessionState.orchestration!.enabled).toBe(false);
	});

	it("a failing child does not destabilize the root session", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage([
				delegateCall("t1", [{ role: "implement", task: "change src/player.ts" }]),
				delegateCall("t2", [{ role: "explore", task: "map src" }]),
			]),
			// Child 1 (implement): provider error.
			fauxAssistantMessage(fauxText("provider exploded"), {
				stopReason: "error",
				errorMessage: "provider exploded",
			}),
			// Child 2 (explore): structured result.
			fauxAssistantMessage(fauxText(COMPLETED_RESULT_JSON)),
			fauxAssistantMessage(fauxText("done")),
		]);
		await harness.session.prompt("delegate implementation and exploration");
		await waitForOrchestration(
			harness,
			(status) => status.children.length >= 2 && status.children.every((c) => c.status !== "running"),
		);
		const runs = harness.session.airaOrchestration!.list();
		const failed = runs.find((run) => run.role === "implement")!;
		expect(failed.status).toBe("failed");
		expect(failed.error?.category).toBe("driver");
		const explored = runs.find((run) => run.role === "explore")!;
		expect(explored.status).toBe("completed");
		expect(harness.session.airaSessionState.orchestration!.failures.length).toBeGreaterThan(0);
		// The root remains healthy and usable.
		expect(harness.session.airaSessionState.runtime).toBe("active");
		// Follow-up root turn works fine.
		harness.setResponses([fauxAssistantMessage(fauxText("ok"))]);
		await harness.session.prompt("still alive?");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("/doctor reports orchestration health without dispatching children", async () => {
		const harness = await makeHarness();
		const doctor = buildAiraDoctorReport(harness.session.airaSessionState);
		const check = doctor.checks.find((candidate) => candidate.name === "orchestration");
		expect(check).toBeDefined();
		expect(check!.pass).toBe(true);
		expect(check!.detail).toContain("enabled");
		expect(check!.detail).toContain("concurrency 0/2");
		// Disabled stays truthful (not broken).
		const disabled = await makeHarness({ settings: { enabled: false } });
		const disabledDoctor = buildAiraDoctorReport(disabled.session.airaSessionState);
		const disabledCheck = disabledDoctor.checks.find((candidate) => candidate.name === "orchestration")!;
		expect(disabledCheck.pass).toBe(true);
		expect(disabledCheck.detail).toContain("disabled");
	});

	it("/status carries the restrained orchestration line", async () => {
		const harness = await makeHarness();
		const report = buildAiraStatusReport(harness.session.airaSessionState);
		expect(report.orchestration).toBe("idle");
	});

	it("session dispose aborts in-flight children", async () => {
		const harness = await makeHarness();
		// The child runs through the real stream; no responses are queued, so it
		// only settles when the dispose aborts it.
		const runPromise = harness.session.airaOrchestration!.schedule([{ role: "explore", task: "long task" }], {
			awaitResults: true,
		});
		await waitForOrchestration(harness, (status) => status.status === "active");
		harness.session.dispose();
		const outcome = await runPromise;
		// The batch settles (no hang); its single task is cancelled (either
		// pre-launch rejection or in-flight cancellation — both carry the
		// bounded "cancelled" category).
		expect(outcome.ok).toBe(true);
		expect(["rejected", "cancelled", "failed"]).toContain(outcome.tasks[0]!.result);
		const record = harness.session.airaOrchestration!.list()[0]!;
		expect(record.error?.category).toBe("cancelled");
		expect(harness.session.airaSessionState.runtime).toBe("disposed");
		expect(harness.session.airaSessionState.orchestration!.status).toBe("idle");
	});
});
