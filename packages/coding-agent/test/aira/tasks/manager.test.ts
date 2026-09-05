/**
 * Aira tasks — task-graph manager tests (Phase 11).
 *
 * Covers: create/patch/list/get/remove, forward-only transitions, derived
 * blocked state, dependency-blocked rejection, orchestration child
 * projection (read-only rows, ownership), session isolation (fresh manager
 * = empty graph), bounds, and snapshot truth.
 */
import { describe, expect, it } from "vitest";
import type { AiraOrchestrationHandle } from "../../../src/aira/orchestration/manager.ts";
import type { AiraChildRun, AiraOrchestrationStatus } from "../../../src/aira/orchestration/types.ts";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";
import type { AiraTasksSettings } from "../../../src/aira/tasks/manager.ts";
import { createAiraTaskManager } from "../../../src/aira/tasks/manager.ts";

function childRun(partial: Partial<AiraChildRun> & { id: string; taskId?: string }): AiraChildRun {
	return {
		role: "explore",
		task: "map the module",
		status: "running",
		phase: "running",
		dependencies: [],
		createdAt: Date.now(),
		taskId: partial.taskId ?? partial.id,
		...partial,
	} as AiraChildRun;
}

function orchestrationStatusOf(runs: AiraChildRun[]): AiraOrchestrationStatus {
	return {
		enabled: true,
		status: "active",
		runningCount: runs.filter((run) => run.status === "running").length,
		queuedCount: 0,
		maxConcurrency: 2,
		children: [],
		recentResults: [],
		failures: [],
		summary: "active",
		updatedAt: Date.now(),
	};
}

class FakeOrchestration implements AiraOrchestrationHandle {
	readonly listeners = new Set<(status: AiraOrchestrationStatus) => void>();
	runs: AiraChildRun[] = [];
	async schedule(): Promise<never> {
		throw new Error("not used in task tests");
	}
	cancel(): never {
		throw new Error("not used in task tests");
	}
	list(): readonly AiraChildRun[] {
		return this.runs;
	}
	get(): never {
		throw new Error("not used");
	}
	events(): never {
		throw new Error("not used");
	}
	subscribeEvents(): never {
		throw new Error("not used");
	}
	status(): AiraOrchestrationStatus {
		return orchestrationStatusOf(this.runs);
	}
	subscribe(listener: (status: AiraOrchestrationStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async dispose(): Promise<void> {}
	emit(): void {
		for (const listener of this.listeners) {
			listener(this.status());
		}
	}
}

function makeManager(settings: AiraTasksSettings = { enabled: true }, orchestration?: FakeOrchestration) {
	const state = acquireAiraSessionState("tasks-test");
	const manager = createAiraTaskManager(state, { settings: () => settings, orchestration });
	return { state, manager, orchestration };
}

describe("AiraTaskManager (Phase 11)", () => {
	it("create/list/get/patch round-trips through the canonical graph", () => {
		const { state, manager } = makeManager();
		const created = manager.create("fix streaming seek", { source: "model" });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.task.status).toBe("pending");
		expect(created.task.source).toBe("model");

		const got = manager.get(created.task.id)!;
		expect(got.title).toBe("fix streaming seek");
		expect(manager.list()).toHaveLength(1);

		// forward transition pending → active → completed
		const activated = manager.patch(created.task.id, { status: "active" });
		expect(activated.ok).toBe(true);
		const completed = manager.patch(created.task.id, { status: "completed" });
		expect(completed.ok).toBe(true);

		// terminal: cannot re-open a completed task
		const reopen = manager.patch(created.task.id, { status: "active" });
		expect(reopen.ok).toBe(false);
		if (reopen.ok) return;
		expect(reopen.message).toContain("terminal");

		// invalid transition: pending → completed directly is illegal
		const second = manager.create("another task");
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		const invalid = manager.patch(second.task.id, { status: "completed" });
		expect(invalid.ok).toBe(false);
		if (invalid.ok) return;
		expect(invalid.message).toContain("cannot move");
		const completedViaCommand = manager.complete(second.task.id);
		expect(completedViaCommand.ok).toBe(true);

		// snapshot projection truth
		const snapshot = manager.status();
		expect(snapshot.completed).toBe(2);
		expect(snapshot.pending).toBe(0);
		expect(snapshot.total).toBe(2);
		expect(snapshot.rows.length).toBe(2);
		expect(state.tasks?.summary).toContain("2/2");
	});

	it("dependency-blocked tasks are derived and enforced", () => {
		const { manager } = makeManager();
		const base = manager.create("scaffold", { source: "user" });
		const child = manager.create("use scaffold", { source: "user", dependsOn: [base.ok ? base.task.id : ""] });
		expect(child.ok).toBe(true);
		if (!child.ok || !base.ok) return;

		// Derived blocked while the dependency is unfinished.
		expect(manager.get(child.task.id)!.status).toBe("blocked");
		expect(manager.status().blocked).toBe(1);

		// Cannot activate a dependency-blocked task.
		const activate = manager.patch(child.task.id, { status: "active" });
		expect(activate.ok).toBe(false);
		if (activate.ok) return;
		expect(activate.message).toContain("dependency-blocked");

		// Completing the dependency unblocks the task (derived pending).
		manager.patch(base.task.id, { status: "active" });
		manager.patch(base.task.id, { status: "completed" });
		expect(manager.get(child.task.id)!.status).toBe("pending");
		expect(manager.status().blocked).toBe(0);
	});

	it("a task cannot depend on itself; unknown dependencies are rejected", () => {
		const { manager } = makeManager();
		const created = manager.create("self dep");
		if (!created.ok) return;
		const self = manager.patch(created.task.id, { dependsOn: [created.task.id] });
		expect(self.ok).toBe(false);
		const unknown = manager.patch(created.task.id, { dependsOn: ["t-nope"] });
		expect(unknown.ok).toBe(false);
	});

	it("cancellation is allowed from pending/active/blocked only", () => {
		const { manager } = makeManager();
		const a = manager.create("a");
		if (!a.ok) return;
		manager.patch(a.task.id, { status: "active" });
		expect(manager.patch(a.task.id, { status: "cancelled" }).ok).toBe(true);
		expect(manager.get(a.task.id)!.status).toBe("cancelled");
		const b = manager.create("b");
		if (!b.ok) return;
		expect(manager.patch(b.task.id, { status: "failed" }).ok).toBe(false); // failed is not settable
	});

	it("orchestration children project as read-only rows; patching them is refused", () => {
		const orchestration = new FakeOrchestration();
		const { manager } = makeManager({ enabled: true }, orchestration);
		const run = childRun({
			id: "run-1",
			role: "implement",
			task: "write the parser",
			status: "running",
			phase: "running",
		});
		orchestration.runs = [run];
		orchestration.emit();

		const row = manager.get("c-run-1")!;
		expect(row).toBeDefined();
		expect(row.source).toBe("child");
		expect(row.status).toBe("active");
		expect(row.childRole).toBe("implement");

		// Child rows are immutable through the task surface.
		const patch = manager.patch(row.id, { status: "completed" });
		expect(patch.ok).toBe(false);
		if (patch.ok) return;
		expect(patch.message).toContain("orchestration");

		// Lifecycle is driven by the orchestration event seam.
		orchestration.runs = [{ ...run, status: "completed", phase: "settled", completedAt: Date.now() }];
		orchestration.emit();
		expect(manager.get("c-run-1")!.status).toBe("completed");
		expect(manager.status().completed).toBe(1);
		expect(manager.status().childRows).toBe(1);
	});

	it("child failures and dependency phases map truthfully", () => {
		const orchestration = new FakeOrchestration();
		const { manager } = makeManager({ enabled: true }, orchestration);
		orchestration.runs = [
			childRun({ id: "r-fail", taskId: "a", status: "failed", phase: "settled", task: "broken step" }),
			childRun({
				id: "r-dep",
				taskId: "b",
				dependencies: ["a"],
				status: "pending",
				phase: "waiting-dependency",
				task: "waits on a",
			}),
		];
		orchestration.emit();
		expect(manager.get("c-r-fail")!.status).toBe("failed");
		expect(manager.get("c-r-dep")!.status).toBe("blocked");
		expect(manager.status().failed).toBe(1);
		expect(manager.status().blocked).toBe(1);
		expect(manager.status().rows.some((row) => row.dependsOn.length > 0)).toBe(true);
	});

	it("disposed managers clear the graph; a fresh session starts empty (session isolation)", () => {
		const first = makeManager();
		first.manager.create("leftover", { source: "user" });
		first.manager.dispose();
		const second = makeManager();
		expect(second.manager.status().total).toBe(0);
		expect(second.state.tasks !== first.state.tasks).toBe(true);
		disposeAiraSessionState(first.state.sessionId, first.state);
		disposeAiraSessionState(second.state.sessionId, second.state);
	});

	it("rows are bounded: creates beyond the cap are rejected; child projections evict oldest settled", () => {
		const orchestration = new FakeOrchestration();
		const { manager } = makeManager({ enabled: true }, orchestration);
		// Fill the manual graph to the cap.
		for (let index = 0; index < 128; index += 1) {
			const created = manager.create(`task ${index}`, { source: "model" });
			expect(created.ok).toBe(true);
		}
		const rejected = manager.create("overflow", { source: "user" });
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.message).toContain("task limit");
		// Child projections beyond the total cap evict the oldest settled rows.
		orchestration.runs = Array.from({ length: 60 }, (_, index) =>
			childRun({
				id: `run-${index}`,
				status: "completed",
				phase: "settled",
				task: `completed child ${index}`,
				createdAt: Date.now() + index,
				completedAt: Date.now() + index + 1,
			}),
		);
		orchestration.emit();
		expect(manager.status().total).toBeLessThanOrEqual(128);
	});

	it("disabled settings project truthfully without breaking the manager", () => {
		const { manager } = makeManager({ enabled: false });
		manager.create("hidden work", { source: "user" });
		const snapshot = manager.status();
		expect(snapshot.enabled).toBe(false);
		expect(snapshot.summary).toBe("disabled");
	});
});
