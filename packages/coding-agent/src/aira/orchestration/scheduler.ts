/**
 * Aira orchestration — scheduler.
 *
 * A small native DAG scheduler, deliberately NOT a workflow engine:
 *
 * - one batch = a set of tasks with optional same-batch dependency edges;
 * - cycle detection (DFS) rejects invalid graphs BEFORE any child launches;
 * - unknown/self dependencies and duplicate ids fail clearly, never hang;
 * - a semaphore bounds parallel children (settings.maxParallel);
 * - tasks wait in `pending` (phase waiting-dependency / waiting-capacity);
 * - a task whose upstream dependency FAILED never runs: it settles as a
 *   synthetic rejection with category "dependency-failed";
 * - cancellation is first-class: per-run AbortControllers, batch abort,
 *   timeout aborts, and session-shutdown abort (the manager owns disposal).
 *
 * The scheduler does not own model execution — it owns ordering, bounds, and
 * cancellation. The manager supplies the per-run executor, which returns the
 * settled status so dependency failure propagates deterministically.
 */

/** Maximum tasks in one dispatch batch (a runaway batch is not possible). */
export const MAX_CHILD_TASKS_PER_BATCH = 8;

/** Minimum per-child timeout (hard floor). */
export const MIN_CHILD_TIMEOUT_MS = 5_000;

/** Maximum per-child timeout (hard bound). */
export const MAX_CHILD_TIMEOUT_MS = 900_000;

export interface AiraScheduledTask {
	/** Unique task id within the batch. */
	taskId: string;
	/** Dependency task ids within the batch. */
	dependencies: string[];
	/** Per-task timeout override (undefined = settings default, applied by the manager). */
	timeoutMs?: number;
}

export interface AiraSchedulerRunTask extends AiraScheduledTask {
	/** Assigned run id (manager identity). */
	runId: string;
}

export interface AiraSchedulerEvents {
	/** A task was skipped (upstream dependency failed, or cancelled before launch). */
	onSkipped(task: AiraSchedulerRunTask, reason: string): void;
	/** A run's slot was acquired (started). */
	onStarted(task: AiraSchedulerRunTask): void;
}

export type AiraScheduleRejection =
	| { kind: "duplicate-id"; taskId: string }
	| { kind: "unknown-dependency"; taskId: string; dependency: string }
	| { kind: "self-dependency"; taskId: string }
	| { kind: "cycle"; path: string[] }
	| { kind: "too-many-tasks"; count: number; max: number };

/** Validate a batch's dependency graph; returns the rejection or the prepared tasks. */
export function prepareAiraSchedule(
	tasks: readonly AiraScheduledTask[],
	assignRunIds: (taskId: string) => string = defaultRunId,
): AiraSchedulerRunTask[] | AiraScheduleRejection {
	if (tasks.length === 0) {
		return [];
	}
	if (tasks.length > MAX_CHILD_TASKS_PER_BATCH) {
		return { kind: "too-many-tasks", count: tasks.length, max: MAX_CHILD_TASKS_PER_BATCH };
	}
	const ids = new Set<string>();
	for (const task of tasks) {
		if (ids.has(task.taskId)) {
			return { kind: "duplicate-id", taskId: task.taskId };
		}
		ids.add(task.taskId);
	}
	for (const task of tasks) {
		for (const dependency of task.dependencies) {
			if (dependency === task.taskId) {
				return { kind: "self-dependency", taskId: task.taskId };
			}
			if (!ids.has(dependency)) {
				return { kind: "unknown-dependency", taskId: task.taskId, dependency };
			}
		}
	}
	const cycle = findAiraScheduleCycle(tasks);
	if (cycle) {
		return { kind: "cycle", path: cycle };
	}
	return tasks.map((task) => ({
		...task,
		dependencies: [...task.dependencies],
		runId: assignRunIds(task.taskId),
	}));
}

/**
 * Run a batch through the scheduler (parallel + dependency-aware, bounded).
 *
 * `execute` must settle each run (never throw); its return value records the
 * run's settled status for dependency propagation ("completed" vs anything
 * else counts as dependency-failure for downstream tasks).
 */
export async function runAiraScheduler(
	tasks: readonly AiraSchedulerRunTask[],
	options: {
		/** Maximum parallel children. */
		maxConcurrency: number;
		/** External cancellation (batch/user/session). */
		signal?: AbortSignal;
		/** Executes one prepared run; returns the settled status. */
		execute(run: AiraSchedulerRunTask): Promise<"completed" | "failed">;
		events?: AiraSchedulerEvents;
	},
): Promise<void> {
	if (tasks.length === 0) {
		return;
	}
	// Cycle detection is a safety net for direct scheduler callers; prepare
	// already rejects cycles. Verify once more so the scheduler never hangs.
	const prepared = prepareAiraSchedule(tasks, (taskId) => tasks.find((task) => task.taskId === taskId)?.runId ?? "");
	if (prepared !== undefined && !Array.isArray(prepared) && prepared.kind === "cycle") {
		const { path } = prepared;
		for (const task of tasks) {
			options.events?.onSkipped(task, `dependency cycle: ${path.join(" -> ")}`);
		}
		return;
	}

	const maxConcurrency = Math.max(1, Math.min(options.maxConcurrency, tasks.length));
	const completed = new Set<string>();
	const failed = new Set<string>();
	const settled = new Set<string>();
	const listeners = new Map<string, Array<() => void>>();
	let runningCount = 0;
	const waiters: Array<() => void> = [];

	const acquire = (): Promise<void> => {
		if (runningCount < maxConcurrency) {
			runningCount += 1;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			waiters.push(() => {
				runningCount += 1;
				resolve();
			});
		});
	};
	const release = (): void => {
		runningCount -= 1;
		const next = waiters.shift();
		if (next) {
			next();
		}
	};
	const notify = (taskId: string): void => {
		const callbacks = listeners.get(taskId);
		if (callbacks) {
			listeners.delete(taskId);
			for (const callback of callbacks) {
				callback();
			}
		}
	};

	const waitForDependencies = async (run: AiraSchedulerRunTask): Promise<boolean> => {
		const deps = run.dependencies;
		if (deps.length === 0) {
			return true;
		}
		const unsettled = deps.filter((id) => !settled.has(id));
		if (unsettled.length === 0) {
			return !deps.some((id) => failed.has(id));
		}
		return new Promise<boolean>((resolve) => {
			let pending = unsettled.length;
			for (const id of unsettled) {
				const callbacks = listeners.get(id) ?? [];
				callbacks.push(() => {
					pending -= 1;
					if (pending === 0) {
						resolve(!deps.some((dep) => failed.has(dep)));
					}
				});
				listeners.set(id, callbacks);
			}
		});
	};

	const runOne = async (run: AiraSchedulerRunTask): Promise<void> => {
		if (options.signal?.aborted) {
			failed.add(run.taskId);
			settled.add(run.taskId);
			notify(run.taskId);
			options.events?.onSkipped(run, "cancelled before launch");
			return;
		}
		const depsOk = await waitForDependencies(run);
		if (!depsOk) {
			const failedDependency = run.dependencies.find((id) => failed.has(id)) ?? "upstream";
			failed.add(run.taskId);
			settled.add(run.taskId);
			notify(run.taskId);
			options.events?.onSkipped(run, failedDependency);
			return;
		}
		await acquire();
		try {
			if (options.signal?.aborted) {
				failed.add(run.taskId);
				settled.add(run.taskId);
				notify(run.taskId);
				options.events?.onSkipped(run, "cancelled before launch");
				return;
			}
			options.events?.onStarted(run);
			const status = await options.execute(run);
			if (status === "completed") {
				completed.add(run.taskId);
			} else {
				failed.add(run.taskId);
			}
		} catch (error) {
			// Executors must settle; treat an unexpected throw as a failure so
			// dependents never wait forever.
			failed.add(run.taskId);
			options.events?.onSkipped(run, error instanceof Error ? error.message : String(error));
		} finally {
			runningCount -= 1;
			release();
			settled.add(run.taskId);
		}
		notify(run.taskId);
	};

	await Promise.all(tasks.map(runOne));
}

/** Depth-first cycle detection over task dependencies; returns a cycle path when found. */
export function findAiraScheduleCycle(tasks: readonly AiraScheduledTask[]): string[] | undefined {
	const indexByName = new Map<string, number>();
	for (let index = 0; index < tasks.length; index += 1) {
		indexByName.set(tasks[index]!.taskId, index);
	}
	const state = new Array<number>(tasks.length).fill(0); // 0 unvisited, 1 in-stack, 2 done
	const stack: string[] = [];

	const visit = (index: number): string[] | undefined => {
		if (state[index] === 1) {
			const cycleStart = stack.indexOf(tasks[index]!.taskId);
			return cycleStart >= 0 ? [...stack.slice(cycleStart), tasks[index]!.taskId] : [tasks[index]!.taskId];
		}
		if (state[index] === 2) {
			return undefined;
		}
		state[index] = 1;
		stack.push(tasks[index]!.taskId);
		for (const dependency of tasks[index]!.dependencies) {
			const depIndex = indexByName.get(dependency);
			if (depIndex === undefined) {
				continue;
			}
			const cycle = visit(depIndex);
			if (cycle) {
				return cycle;
			}
		}
		stack.pop();
		state[index] = 2;
		return undefined;
	};

	for (let index = 0; index < tasks.length; index += 1) {
		const cycle = visit(index);
		if (cycle) {
			return cycle;
		}
	}
	return undefined;
}

let runIdCounter = 0;
function defaultRunId(): string {
	runIdCounter += 1;
	return `r${runIdCounter.toString(36)}`;
}
