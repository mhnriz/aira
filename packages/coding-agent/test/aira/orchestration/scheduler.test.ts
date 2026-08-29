/**
 * Phase 9 — DAG scheduler: dependency ordering, concurrency bounds, queueing,
 * cycle rejection, unknown/self dependency rejection, duplicate ids,
 * dependency-failure propagation, and cancellation.
 */
import { describe, expect, it } from "vitest";
import {
	type AiraSchedulerRunTask,
	findAiraScheduleCycle,
	prepareAiraSchedule,
	runAiraScheduler,
} from "../../../src/aira/orchestration/scheduler.ts";

function task(id: string, dependencies: string[] = [], runId = `r-${id}`): AiraSchedulerRunTask {
	return { taskId: id, dependencies, runId };
}

/** Run a schedule and record start order, concurrency, and settlement. */
async function runSchedule(
	tasks: AiraSchedulerRunTask[],
	options: {
		maxConcurrency?: number;
		signal?: AbortSignal;
		executor?: (run: AiraSchedulerRunTask) => Promise<"completed" | "failed">;
	} = {},
): Promise<{
	order: string[];
	maxObservedConcurrency: number;
	running: Map<string, number>;
	skipped: Array<{ taskId: string; reason: string }>;
	settled: Map<string, "completed" | "failed" | "skipped">;
}> {
	const order: string[] = [];
	const running = new Map<string, number>();
	const skipped: Array<{ taskId: string; reason: string }> = [];
	const settled = new Map<string, "completed" | "failed" | "skipped">();
	let concurrency = 0;
	let maxObservedConcurrency = 0;
	const defaultExecute = async (run: AiraSchedulerRunTask): Promise<"completed" | "failed"> => {
		running.set(run.taskId, (running.get(run.taskId) ?? 0) + 1);
		concurrency += 1;
		maxObservedConcurrency = Math.max(maxObservedConcurrency, concurrency);
		await new Promise((resolve) => setTimeout(resolve, 5));
		concurrency -= 1;
		running.set(run.taskId, (running.get(run.taskId) ?? 0) - 1);
		return "completed";
	};
	const execute = async (run: AiraSchedulerRunTask): Promise<"completed" | "failed"> => {
		const status = options.executor ? await options.executor(run) : await defaultExecute(run);
		if (status === "completed") {
			order.push(run.taskId);
			settled.set(run.taskId, "completed");
		} else {
			settled.set(run.taskId, "failed");
		}
		return status;
	};
	await runAiraScheduler(tasks, {
		maxConcurrency: options.maxConcurrency ?? 2,
		signal: options.signal,
		execute,
		events: {
			onStarted: () => undefined,
			onSkipped: (run, reason) => {
				skipped.push({ taskId: run.taskId, reason });
				settled.set(run.taskId, "skipped");
			},
		},
	});
	return { order, maxObservedConcurrency, running, skipped, settled };
}

describe("Aira orchestration scheduler (Phase 9)", () => {
	it("runs independent tasks in parallel bounded by the concurrency limit", async () => {
		const tasks = [task("a"), task("b"), task("c"), task("d")];
		const result = await runSchedule(tasks, { maxConcurrency: 2 });
		expect(result.order.sort()).toEqual(["a", "b", "c", "d"]);
		expect(result.maxObservedConcurrency).toBeLessThanOrEqual(2);
		expect(result.maxObservedConcurrency).toBe(2);
	});

	it("orders dependent tasks A -> B -> C (never before their dependencies)", async () => {
		const tasks = [task("c", ["b"]), task("a", []), task("b", ["a"])];
		const result = await runSchedule(tasks);
		const indexA = result.order.indexOf("a");
		const indexB = result.order.indexOf("b");
		const indexC = result.order.indexOf("c");
		expect(indexA).toBeGreaterThanOrEqual(0);
		expect(indexB).toBeGreaterThan(indexA);
		expect(indexC).toBeGreaterThan(indexB);
	});

	it("A + B -> C diamond: C waits for both independent dependencies", async () => {
		const tasks = [task("a"), task("b"), task("c", ["a", "b"])];
		const result = await runSchedule(tasks);
		const indexA = result.order.indexOf("a");
		const indexB = result.order.indexOf("b");
		const indexC = result.order.indexOf("c");
		expect(indexC).toBeGreaterThan(indexA);
		expect(indexC).toBeGreaterThan(indexB);
	});

	it("rejects cycles before dispatch", () => {
		expect(prepareAiraSchedule([task("a", ["b"]), task("b", ["a"])])).toEqual({
			kind: "cycle",
			path: ["a", "b", "a"],
		});
		expect(prepareAiraSchedule([task("a", ["a"])])).toEqual({ kind: "self-dependency", taskId: "a" });
		expect(findAiraScheduleCycle([task("a"), task("b", ["a"]), task("c", ["b"])])).toBeUndefined();
		expect(prepareAiraSchedule([task("a", ["missing"])])).toEqual({
			kind: "unknown-dependency",
			taskId: "a",
			dependency: "missing",
		});
	});

	it("rejects duplicate task ids and oversized batches", () => {
		expect(prepareAiraSchedule([task("a"), task("a")])).toEqual({ kind: "duplicate-id", taskId: "a" });
		const many = Array.from({ length: 9 }, (_, index) => task(`t${index}`));
		expect(prepareAiraSchedule(many)).toEqual({ kind: "too-many-tasks", count: 9, max: 8 });
	});

	it("a failed dependency skips its dependents (synthetic rejection, no hang)", async () => {
		const tasks = [task("a"), task("b", ["a"]), task("c", ["b"]), task("d")];
		const result = await runSchedule(tasks, {
			executor: async (run) => (run.taskId === "a" ? "failed" : "completed"),
		});
		expect(result.settled.get("a")).toBe("failed");
		expect(result.skipped.map((entry) => entry.taskId).sort()).toEqual(["b", "c"]);
		expect(result.order).toContain("d");
		expect(result.skipped.find((entry) => entry.taskId === "b")?.reason).toBe("a");
	});

	it("cancellation before launch skips pending tasks without running them", async () => {
		const tasks = [task("a"), task("b"), task("c"), task("d")];
		const controller = new AbortController();
		const order: string[] = [];
		const run = runAiraScheduler(tasks, {
			maxConcurrency: 1,
			signal: controller.signal,
			execute: async (run) => {
				order.push(run.taskId);
				await new Promise((resolve) => setTimeout(resolve, 10));
				return "completed";
			},
			events: {
				onStarted: () => undefined,
				onSkipped: () => undefined,
			},
		});
		// Cancel after the first task starts (single slot: the rest are queued).
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		await run;
		expect(order.length).toBe(1);
	});

	it("queues beyond the concurrency limit: no task runs before an earlier slot frees", async () => {
		const tasks = [task("a"), task("b"), task("c")];
		const startedAt = new Map<string, number>();
		const finishedAt = new Map<string, number>();
		await runAiraScheduler(tasks, {
			maxConcurrency: 2,
			execute: async (run) => {
				startedAt.set(run.taskId, Date.now());
				await new Promise((resolve) => setTimeout(resolve, 20));
				finishedAt.set(run.taskId, Date.now());
				return "completed";
			},
		});
		// c must start after a or b finished (only 2 slots).
		const startedC = startedAt.get("c")!;
		const finished = [...finishedAt.values()].sort((a, b) => a - b);
		expect(startedC).toBeGreaterThanOrEqual(finished[0]!);
	});
});
