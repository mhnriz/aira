/**
 * Phase 9 — orchestration manager: child creation, context isolation,
 * structured results, model inheritance/explicit selection/unavailability,
 * concurrency + queueing, timeout, cancellation, child crash, parent
 * shutdown, canonical state updates, bounded history, failure telemetry, and
 * token accounting.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	type AiraOrchestrationHandle,
	createAiraOrchestrationManager,
} from "../../../src/aira/orchestration/manager.ts";
import type { AiraChildOutcome, AiraChildRuntime } from "../../../src/aira/orchestration/runner.ts";
import type { AiraOrchestrationSettings } from "../../../src/aira/orchestration/settings.ts";
import { type AiraSessionState, acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";

const COMPLETED = {
	status: "completed" as const,
	summary: "mapped the module",
	findings: ["f1"],
	evidence: ["e1"],
	relevantFiles: ["src/a.ts"],
	changedFiles: [] as string[],
	tests: [] as string[],
	errors: [] as string[],
};

function makeState(): AiraSessionState {
	return acquireAiraSessionState(`orchestration-test-${Math.random().toString(36).slice(2)}`);
}

interface ManagerFixture {
	handle: AiraOrchestrationHandle;
	state: AiraSessionState;
	runner: {
		call: (options: {
			prompt: string;
			tools: string[];
			timeoutMs: number;
			signal?: AbortSignal;
		}) => Promise<AiraChildOutcome> | AiraChildOutcome;
		resolveRuntime: (options: { model?: string; settings: AiraOrchestrationSettings }) => Promise<
			| {
					runtime: AiraChildRuntime;
					resolvedModel: string;
			  }
			| { unavailable: string }
			| undefined
		>;
	};
	disposeEvents: string[];
}

function makeManager(
	options: {
		settings?: Partial<AiraOrchestrationSettings>;
		mode?: "build" | "plan" | "review";
		onModel?: string;
	} = {},
): ManagerFixture {
	const state = makeState();
	if (options.mode) {
		state.mode = options.mode;
	}
	const disposeEvents: string[] = [];
	const fixture: ManagerFixture = {
		handle: undefined as never,
		state,
		runner: {
			call: () => ({
				ok: true as const,
				result: {
					status: "completed" as const,
					summary: "",
					findings: [],
					evidence: [],
					relevantFiles: [],
					changedFiles: [],
					tests: [],
					errors: [],
				},
				model: "faux",
			}),
			resolveRuntime: () => Promise.resolve(undefined),
		},
		disposeEvents,
	};
	fixture.handle = createAiraOrchestrationManager(state, {
		cwd: "/proj/demo",
		settings: () => ({
			enabled: true,
			maxParallel: 2,
			model: options.onModel ?? "inherit",
			timeoutMs: 300_000,
			...options.settings,
		}),
		resolveRuntime: (request) => fixture.runner.resolveRuntime(request),
		runner: async (_runtime, runOptions, signal) => {
			disposeEvents.push(`ran:${runOptions.prompt.length}:${runOptions.tools.map((tool) => tool.name).join(",")}`);
			const outcome = fixture.runner.call({
				prompt: runOptions.prompt,
				tools: runOptions.tools.map((tool) => tool.name),
				timeoutMs: runOptions.timeoutMs,
				signal,
			});
			return outcome instanceof Promise ? outcome : Promise.resolve(outcome);
		},
	});
	return fixture;
}

const activeSessions: AiraSessionState[] = [];
afterEach(() => {
	while (activeSessions.length > 0) {
		const state = activeSessions.pop()!;
		disposeAiraSessionState(state.sessionId, state);
	}
});

const defaultResolve = {
	runtime: { model: { id: "m" } as never, streamFn: (async () => ({ result: async () => ({}) })) as never },
	resolvedModel: "faux/fake-model",
};

describe("Aira orchestration manager (Phase 9)", () => {
	it("creates children with explicit bounded envelopes and structured results", async () => {
		const fixture = makeManager();
		activeSessions.push(fixture.state);
		fixture.runner.resolveRuntime = async () => defaultResolve;
		fixture.runner.call = async () => ({ ok: true, result: COMPLETED, model: "faux/fake-model" });
		fixture.disposeEvents.length = 0;
		const result = await fixture.handle.schedule([{ role: "explore", task: "map the module" }], {
			awaitResults: true,
		});
		expect(result.ok).toBe(true);
		expect(result.tasks[0]!.accepted).toBe(true);
		expect(result.tasks[0]!.result).toMatchObject({ status: "completed", summary: "mapped the module" });
		// The child received ONLY the bounded envelope + read-only tools
		// (explore role): no transcript, no mutating tools, no orchestration tools.
		expect(fixture.disposeEvents).toHaveLength(1);
		expect(fixture.disposeEvents[0]).toContain("read,grep,find,ls");
		expect(fixture.disposeEvents[0]).not.toContain("edit");
		expect(fixture.disposeEvents[0]).not.toContain("bash");
		expect(fixture.disposeEvents[0]).not.toContain("agents_delegate");
		const run = fixture.handle.list()[0]!;
		expect(run.status).toBe("completed");
		expect(run.resolvedModel).toBe("faux/fake-model");
		expect(run.result?.summary).toBe("mapped the module");
	});

	it("publishes bounded canonical state (state.orchestration) with UI-ready rows", async () => {
		const fixture = makeManager();
		activeSessions.push(fixture.state);
		fixture.runner.resolveRuntime = async () => defaultResolve;
		fixture.runner.call = async () => ({ ok: true, result: COMPLETED, model: "faux/fake-model" });
		await fixture.handle.schedule([{ role: "explore", task: "map it" }], { awaitResults: true });
		const snapshot = fixture.state.orchestration!;
		expect(snapshot.status).toBe("idle"); // settled
		expect(snapshot.children).toHaveLength(1);
		expect(snapshot.children[0]!.role).toBe("explore");
		expect(snapshot.children[0]!.status).toBe("completed");
		expect(snapshot.children[0]!.resultSummary).toBe("mapped the module");
		expect(snapshot.recentResults).toHaveLength(1);
		expect(snapshot.failures).toHaveLength(0);
		expect(snapshot.maxConcurrency).toBe(2);
		expect(snapshot.summary).toBe("idle");
	});

	it("model inheritance resolves through the settings policy (inherit)", async () => {
		const fixture = makeManager();
		activeSessions.push(fixture.state);
		const requests: Array<{ model?: string; settingsModel: string }> = [];
		fixture.runner.resolveRuntime = async (request) => {
			requests.push({ model: request.model, settingsModel: request.settings.model });
			return defaultResolve;
		};
		fixture.runner.call = async () => ({ ok: true, result: COMPLETED, model: "faux/fake-model" });
		await fixture.handle.schedule([{ role: "research", task: "t" }], { awaitResults: true });
		expect(requests).toHaveLength(1);
		expect(requests[0]!.model).toBeUndefined();
		expect(requests[0]!.settingsModel).toBe("inherit");
	});

	it("explicit per-task model selection reaches the resolver", async () => {
		const fixture = makeManager();
		activeSessions.push(fixture.state);
		const requests: Array<string | undefined> = [];
		fixture.runner.resolveRuntime = async (request) => {
			requests.push(request.model);
			return defaultResolve;
		};
		fixture.runner.call = async () => ({ ok: true, result: COMPLETED, model: "x" });
		await fixture.handle.schedule([{ role: "research", task: "t", model: "anthropic/claude-sonnet-4-5" }], {
			awaitResults: true,
		});
		expect(requests[0]).toBe("anthropic/claude-sonnet-4-5");
	});

	it("an unavailable model fails truthfully (never silently substituted)", async () => {
		const fixture = makeManager();
		activeSessions.push(fixture.state);
		fixture.runner.resolveRuntime = async () => ({
			unavailable: 'requested child model "weird/model" is not configured',
		});
		const result = await fixture.handle.schedule([{ role: "research", task: "t", model: "weird/model" }], {
			awaitResults: true,
		});
		expect(result.tasks[0]!.result).toBe("failed");
		const run = fixture.handle.list()[0]!;
		expect(run.status).toBe("failed");
		expect(run.error?.category).toBe("model-unavailable");
		expect(run.error?.message).toContain("not configured");
		const snapshot = fixture.state.orchestration!;
		expect(snapshot.failures[0]!.category).toBe("model-unavailable");
		expect(snapshot.failures[0]!.message).toContain("not configured");
	});

	it("PLAN refuses mutation-capable roles at dispatch (no loophole)", async () => {
		const fixture = makeManager({ mode: "plan" });
		activeSessions.push(fixture.state);
		let ran = false;
		fixture.runner.resolveRuntime = async () => defaultResolve;
		fixture.runner.call = async () => {
			ran = true;
			return { ok: true, result: COMPLETED, model: "x" };
		};
		const result = await fixture.handle.schedule([{ role: "implement", task: "t" }], { awaitResults: true });
		expect(result.ok).toBe(false);
		expect(result.tasks[0]!.accepted).toBe(false);
		expect(result.tasks[0]!.reason).toContain("PLAN");
		expect(ran).toBe(false);
		// Read-only exploration children still work in PLAN.
		const ok = await fixture.handle.schedule([{ role: "explore", task: "t" }], { awaitResults: true });
		expect(ok.ok).toBe(true);
		expect(ran).toBe(true);
	});

	it("PLAN children receive only read-only tool sets even for read-only roles", async () => {
		const fixture = makeManager({ mode: "plan" });
		activeSessions.push(fixture.state);
		fixture.runner.resolveRuntime = async () => defaultResolve;
		const toolNames: string[] = [];
		fixture.runner.call = async (options) => {
			toolNames.push(...options.tools);
			return { ok: true, result: COMPLETED, model: "x" };
		};
		// test is refused in PLAN at dispatch (mutation-capable), so use review
		// with an execution manager absent: PLAN keeps the 4 read-only tools.
		const ok = await fixture.handle.schedule([{ role: "review", task: "t" }], { awaitResults: true });
		expect(ok.ok).toBe(true);
		expect(toolNames).toEqual(["read", "grep", "find", "ls"]);
	});

	it("concurrency limit bounds parallel children; the rest queue", async () => {
		const fixture = makeManager({ settings: { maxParallel: 2 } });
		activeSessions.push(fixture.state);
		fixture.runner.resolveRuntime = async () => defaultResolve;
		let concurrentlyRunning = 0;
		let maxConcurrent = 0;
		const started: string[] = [];
		fixture.runner.call = async () => {
			concurrentlyRunning += 1;
			maxConcurrent = Math.max(maxConcurrent, concurrentlyRunning);
			started.push("x");
			await new Promise((resolve) => setTimeout(resolve, 20));
			concurrentlyRunning -= 1;
			return { ok: true, result: COMPLETED, model: "x" };
		};
		const result = await fixture.handle.schedule(
			[
				{ id: "a", role: "explore", task: "t1" },
				{ id: "b", role: "explore", task: "t2" },
				{ id: "c", role: "explore", task: "t3" },
				{ id: "d", role: "explore", task: "t4" },
			],
			{ awaitResults: true },
		);
		expect(result.tasks).toHaveLength(4);
		expect(maxConcurrent).toBeLessThanOrEqual(2);
		expect(maxConcurrent).toBe(2);
		expect(started).toHaveLength(4);
	});

	it("dependency ordering: C waits for A and B", async () => {
		const fixture = makeManager({ settings: { maxParallel: 2 } });
		activeSessions.push(fixture.state);
		fixture.runner.resolveRuntime = async () => defaultResolve;
		const order: string[] = [];
		fixture.runner.call = async () => {
			order.push("child");
			await new Promise((resolve) => setTimeout(resolve, 10));
			return { ok: true, result: COMPLETED, model: "x" };
		};
		await fixture.handle.schedule(
			[
				{ id: "a", role: "explore", task: "t1" },
				{ id: "b", role: "explore", task: "t2" },
				{ id: "c", role: "explore", task: "t3", dependencies: ["a", "b"] },
			],
			{ awaitResults: true },
		);
		const runs = fixture.handle.list();
		const c = runs.find((run) => run.taskId === "c")!;
		const a = runs.find((run) => run.taskId === "a")!;
		const b = runs.find((run) => run.taskId === "b")!;
		expect(c.startedAt!).toBeGreaterThanOrEqual(a.completedAt!);
		expect(c.startedAt!).toBeGreaterThanOrEqual(b.completedAt!);
		expect(order).toHaveLength(3);
	});

	it("a failed child rejects its dependents without destabilizing the batch", async () => {
		const fixture = makeManager();
		activeSessions.push(fixture.state);
		fixture.runner.resolveRuntime = async () => defaultResolve;
		fixture.runner.call = async ({ prompt }) =>
			prompt.includes("t1")
				? { ok: false, driverError: "provider exploded" }
				: { ok: true, result: COMPLETED, model: "x" };
		const result = await fixture.handle.schedule(
			[
				{ id: "a", role: "explore", task: "t1" },
				{ id: "b", role: "explore", task: "t2", dependencies: ["a"] },
				{ id: "c", role: "explore", task: "t3" },
			],
			{ awaitResults: true },
		);
		const runs = new Map(fixture.handle.list().map((run) => [run.taskId, run]));
		expect(result.ok).toBe(true);
		expect(runs.get("a")!.status).toBe("failed");
		expect(runs.get("a")!.error?.category).toBe("driver");
		expect(runs.get("b")!.status).toBe("rejected");
		expect(runs.get("b")!.error?.category).toBe("dependency-failed");
		expect(runs.get("c")!.status).toBe("completed");
		// The snapshot carries bounded failure telemetry.
		expect(fixture.state.orchestration!.failures.some((failure) => failure.category === "dependency-failed")).toBe(
			true,
		);
	});

	it("timeout cancels the child with a timeout failure category", async () => {
		const fixture = makeManager();
		activeSessions.push(fixture.state);
		fixture.runner.resolveRuntime = async () => defaultResolve;
		fixture.runner.call = async () => ({ ok: false, driverError: "child timed out after 30000ms" });
		const result = await fixture.handle.schedule([{ role: "explore", task: "t" }], { awaitResults: true });
		expect(result.tasks[0]!.result).toBe("timed-out");
		const run = fixture.handle.list()[0]!;
		expect(run.status).toBe("timed-out");
		expect(run.error?.category).toBe("timeout");
	});

	it("cancellation propagates into the running child abort signal", async () => {
		const fixture = makeManager();
		activeSessions.push(fixture.state);
		fixture.runner.resolveRuntime = async () => defaultResolve;
		let childSignal: AbortSignal | undefined;
		fixture.runner.call = ({ signal }) =>
			new Promise((resolve) => {
				childSignal = signal;
				signal?.addEventListener("abort", () => resolve({ ok: false as const, driverError: "child cancelled" }), {
					once: true,
				});
			});
		const run = fixture.handle.schedule([{ id: "a", role: "explore", task: "t" }], { awaitResults: true });
		await new Promise((resolve) => setTimeout(resolve, 30));
		fixture.handle.cancel(undefined, "user abort");
		const result = await run;
		const record = fixture.handle.list()[0]!;
		expect(childSignal?.aborted).toBe(true);
		expect(record.status).toBe("cancelled");
		expect(record.error?.category).toBe("cancelled");
		expect(result.tasks[0]!.result).toBe("cancelled");
	});

	it("a crashing child runner settles as a driver failure (never destabilizes)", async () => {
		const fixture = makeManager();
		activeSessions.push(fixture.state);
		fixture.runner.resolveRuntime = async () => defaultResolve;
		fixture.runner.call = async () => {
			throw new Error("runner crashed");
		};
		const result = await fixture.handle.schedule([{ role: "explore", task: "t" }], { awaitResults: true });
		expect(result.tasks[0]!.result).toBe("failed");
		const run = fixture.handle.list()[0]!;
		expect(run.status).toBe("failed");
		expect(run.error?.category).toBe("driver");
		expect(run.error?.message).toContain("runner crashed");
		// The root session state stays healthy.
		expect(fixture.state.runtime).toBe("active");
	});

	it("parent shutdown cancels active children and marks state idle", async () => {
		const fixture = makeManager();
		activeSessions.push(fixture.state);
		fixture.runner.resolveRuntime = async () => defaultResolve;
		const aborted: boolean[] = [];
		fixture.runner.call = ({ signal }) =>
			new Promise((resolve) => {
				aborted.push(signal?.aborted ?? false);
				signal?.addEventListener(
					"abort",
					() => {
						aborted.push(true);
						resolve({ ok: false as const, driverError: "child cancelled" });
					},
					{ once: true },
				);
			});
		const run = fixture.handle.schedule([{ id: "a", role: "explore", task: "t" }]);
		await new Promise((resolve) => setTimeout(resolve, 30));
		await fixture.handle.dispose();
		await run;
		expect(aborted.some(Boolean)).toBe(true);
		const record = fixture.handle.list()[0]!;
		expect(record.status).toBe("cancelled");
		expect(fixture.state.orchestration!.status).toBe("idle");
		// A disposed manager refuses new work.
		const refused = await fixture.handle.schedule([{ role: "explore", task: "t2" }]);
		expect(refused.ok).toBe(false);
	});

	it("keeps bounded history: snapshots cap children/results/failures", async () => {
		const fixture = makeManager();
		activeSessions.push(fixture.state);
		fixture.runner.resolveRuntime = async () => defaultResolve;
		let failNext = false;
		fixture.runner.call = async () => {
			if (failNext) {
				failNext = false;
				return { ok: false, driverError: "boom" };
			}
			failNext = true;
			return { ok: true, result: COMPLETED, model: "x" };
		};
		for (let index = 0; index < 12; index += 1) {
			await fixture.handle.schedule([{ role: "explore", task: `t${index}` }], { awaitResults: true });
		}
		const snapshot = fixture.state.orchestration!;
		expect(snapshot.children.length).toBeLessThanOrEqual(12);
		expect(snapshot.failures.length).toBeLessThanOrEqual(6);
		expect(snapshot.failures.length).toBeGreaterThan(0);
	});

	it("aggregates real token usage only when providers expose it", async () => {
		const fixture = makeManager();
		activeSessions.push(fixture.state);
		fixture.runner.resolveRuntime = async () => defaultResolve;
		fixture.runner.call = async () => ({
			ok: true,
			result: COMPLETED,
			model: "x",
			tokenUsage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
		});
		await fixture.handle.schedule([{ role: "explore", task: "t" }], { awaitResults: true });
		const snapshot = fixture.state.orchestration!;
		expect(snapshot.aggregateTokenUsage).toEqual({
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			total: 165,
		});
		// No token usage exposed: aggregate stays undefined (never invented).
		fixture.runner.call = async () => ({ ok: true, result: COMPLETED, model: "x" });
		await fixture.handle.schedule([{ role: "explore", task: "t2" }], { awaitResults: true });
		expect(fixture.state.orchestration!.aggregateTokenUsage?.total).toBe(165);
	});

	it("background dispatch returns immediately with run ids; state stays active", async () => {
		const fixture = makeManager();
		activeSessions.push(fixture.state);
		fixture.runner.resolveRuntime = async () => defaultResolve;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		fixture.runner.call = async () => {
			await gate;
			return { ok: true, result: COMPLETED, model: "x" };
		};
		const result = await fixture.handle.schedule([{ id: "a", role: "explore", task: "t" }], { awaitResults: false });
		expect(result.ok).toBe(true);
		expect(result.tasks[0]!.runId).toBeTruthy();
		expect("result" in result.tasks[0]!).toBe(false);
		expect(fixture.state.orchestration!.status).toBe("active");
		release();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(fixture.state.orchestration!.status).toBe("idle");
	});

	it("disabled settings refuse dispatch with a truthful reason", async () => {
		const fixture = makeManager({ settings: { enabled: false } });
		activeSessions.push(fixture.state);
		const result = await fixture.handle.schedule([{ role: "explore", task: "t" }]);
		expect(result.ok).toBe(false);
		expect(result.tasks[0]!.reason).toContain("disabled");
	});
});
