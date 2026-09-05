import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";
import { createAiraTaskManager } from "../../../src/aira/tasks/manager.ts";
import { createAiraTaskToolDefinitions } from "../../../src/aira/tasks/model-tool.ts";
import { type AiraTaskPersistence, createAiraTaskPersistence } from "../../../src/aira/tasks/persistence.ts";

interface PersistenceTraceEvent {
	managerId: string;
	operation: "recover-before" | "recover" | "save" | "tool";
	persistedRevision: string;
	persistedStatuses: string[];
	inMemoryStatuses: string[];
	normalizedCount?: number;
}

function tracePersistence(
	persistence: AiraTaskPersistence,
	managerId: string,
	trace: PersistenceTraceEvent[],
): AiraTaskPersistence {
	const capture = (
		operation: PersistenceTraceEvent["operation"],
		inMemoryStatuses: string[],
		normalizedCount?: number,
	): void => {
		const persisted = readPersistedTaskTrace(persistence.path);
		trace.push({
			managerId,
			operation,
			persistedRevision: persisted.revision,
			persistedStatuses: persisted.statuses,
			inMemoryStatuses,
			...(normalizedCount === undefined ? {} : { normalizedCount }),
		});
	};
	return {
		path: persistence.path,
		load: persistence.load,
		recover: () => {
			capture("recover-before", []);
			const recovered = persistence.recover();
			capture("recover", recovered?.tasks.map((task) => task.status) ?? [], recovered?.normalizedCount);
			return recovered;
		},
		save: (tasks) => {
			const result = persistence.save(tasks);
			capture(
				"save",
				tasks.map((task) => task.status),
			);
			return result;
		},
		clear: persistence.clear,
		health: persistence.health,
	};
}

async function invokeTracedTaskTool(
	managerId: string,
	manager: ReturnType<typeof createAiraTaskManager>,
	tools: ReturnType<typeof createAiraTaskToolDefinitions>,
	params: Record<string, unknown>,
	persistencePath: string,
	trace: PersistenceTraceEvent[],
): Promise<unknown> {
	const result = await tools.tasks!.execute("trace", params as never, undefined, undefined, undefined as never);
	const persisted = readPersistedTaskTrace(persistencePath);
	trace.push({
		managerId,
		operation: "tool",
		persistedRevision: persisted.revision,
		persistedStatuses: persisted.statuses,
		inMemoryStatuses: manager.list().map((task) => task.status),
	});
	return result;
}

function readPersistedTaskTrace(path: string): { revision: string; statuses: string[] } {
	try {
		const text = readFileSync(path, "utf8");
		const parsed = JSON.parse(text) as { tasks?: Array<{ status?: string }> };
		return {
			revision: createHash("sha256").update(text).digest("hex").slice(0, 12),
			statuses: (parsed.tasks ?? []).map((task) => task.status ?? "missing"),
		};
	} catch {
		return { revision: "missing", statuses: [] };
	}
}

function state(id: string) {
	return acquireAiraSessionState(id);
}

describe("Aira task persistence", () => {
	it("round-trips native tasks and maps interrupted active work to pending", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "aira-tasks-"));
		const id = "session-persist";
		const firstState = state(id);
		const first = createAiraTaskManager(firstState, {
			settings: () => ({ enabled: true }),
			persistence: createAiraTaskPersistence(id, "startup", { baseDir }),
		});
		const active = first.create("active work");
		const done = first.create("completed work");
		if (!active.ok || !done.ok) throw new Error("fixture setup failed");
		first.patch(active.task.id, { status: "active" });
		first.patch(done.task.id, { status: "active" });
		first.patch(done.task.id, { status: "completed" });
		first.dispose();
		disposeAiraSessionState(id, firstState);

		const secondState = state(id);
		const second = createAiraTaskManager(secondState, {
			settings: () => ({ enabled: true }),
			persistence: createAiraTaskPersistence(id, "resume", { baseDir }),
		});
		expect(second.list().map((task) => task.title)).toEqual(["active work", "completed work"]);
		expect(second.get(active.task.id)?.status).toBe("pending");
		expect(second.get(done.task.id)?.status).toBe("completed");
		expect(second.status().persistence?.status).toBe("ok");
		second.dispose();
		disposeAiraSessionState(id, secondState);
	});

	it("does not restore tasks for a new session and rejects unknown schemas safely", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "aira-tasks-"));
		const id = "session-schema";
		const persistence = createAiraTaskPersistence(id, "startup", { baseDir });
		writeFileSync(persistence.path, JSON.stringify({ version: 999, sessionId: id, tasks: [] }));
		expect(persistence.recover()).toBeUndefined();
		expect(persistence.health().status).toBe("failed");
		expect(createAiraTaskPersistence(id, "new", { baseDir }).recover()).toBeUndefined();
	});

	it("persists only native rows, never orchestration projections", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "aira-tasks-"));
		const id = "session-child";
		const persistence = createAiraTaskPersistence(id, "startup", { baseDir });
		const sessionState = state(id);
		const manager = createAiraTaskManager(sessionState, { settings: () => ({ enabled: true }), persistence });
		manager.create("native");
		manager.create("child projection", { source: "child" });
		const persisted = JSON.parse(readFileSync(persistence.path, "utf8")) as { tasks: Array<{ source: string }> };
		expect(persisted.tasks.every((task) => task.source !== "child")).toBe(true);
		manager.clear();
		manager.dispose();
		disposeAiraSessionState(id, sessionState);
	});

	it("preserves cancellation, recomputes dependency blocking, and isolates lifecycle reasons", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "aira-tasks-"));
		const id = "session-lifecycle";
		const firstState = state(id);
		const first = createAiraTaskManager(firstState, {
			settings: () => ({ enabled: true }),
			persistence: createAiraTaskPersistence(id, "startup", { baseDir }),
		});
		const dependency = first.create("dependency");
		const blocked = first.create("blocked after resume", { dependsOn: dependency.ok ? [dependency.task.id] : [] });
		const cancelled = first.create("cancelled");
		if (!dependency.ok || !blocked.ok || !cancelled.ok) throw new Error("fixture setup failed");
		first.patch(cancelled.task.id, { status: "cancelled" });
		first.dispose();
		disposeAiraSessionState(id, firstState);

		const resumedState = state(id);
		const resumed = createAiraTaskManager(resumedState, {
			settings: () => ({ enabled: true }),
			persistence: createAiraTaskPersistence(id, "resume", { baseDir }),
		});
		expect(resumed.list().map((task) => task.status)).toEqual(["blocked", "pending", "cancelled"]);
		expect(resumed.get(cancelled.task.id)?.status).toBe("cancelled");
		resumed.remove(cancelled.task.id);
		resumed.clear();
		resumed.dispose();
		disposeAiraSessionState(id, resumedState);

		const newSession = createAiraTaskPersistence(id, "new", { baseDir });
		const forkedSession = createAiraTaskPersistence(id, "fork", { baseDir });
		expect(newSession.recover()).toBeUndefined();
		expect(forkedSession.recover()).toBeUndefined();
	});

	it("does not duplicate rows across repeated resume construction", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "aira-tasks-"));
		const id = "session-repeat";
		const first = createAiraTaskPersistence(id, "startup", { baseDir });
		const taskState = state(id);
		const manager = createAiraTaskManager(taskState, { settings: () => ({ enabled: true }), persistence: first });
		manager.create("stable row");
		manager.dispose();
		disposeAiraSessionState(id, taskState);

		const second = createAiraTaskPersistence(id, "resume", { baseDir });
		const third = createAiraTaskPersistence(id, "resume", { baseDir });
		expect(second.recover()?.tasks).toHaveLength(1);
		expect(third.recover()?.tasks).toHaveLength(1);
	});

	it("traces durable active patch and keeps recovery out of resumed tool boundaries", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "aira-tasks-trace-"));
		const id = "session-trace";
		const trace: PersistenceTraceEvent[] = [];
		const firstState = state(id);
		const firstPersistence = tracePersistence(
			createAiraTaskPersistence(id, "startup", { baseDir }),
			"manager-1",
			trace,
		);
		const first = createAiraTaskManager(firstState, {
			settings: () => ({ enabled: true }),
			persistence: firstPersistence,
		});
		const firstTools = createAiraTaskToolDefinitions({ runtime: first });

		try {
			const created = (await invokeTracedTaskTool(
				"manager-1",
				first,
				firstTools,
				{
					action: "create",
					title: "interrupted work",
				},
				firstPersistence.path,
				trace,
			)) as { details: { id: string } };
			const id = created.details.id;
			await invokeTracedTaskTool(
				"manager-1",
				first,
				firstTools,
				{ action: "patch", id, status: "active" },
				firstPersistence.path,
				trace,
			);

			const afterPatch = readPersistedTaskTrace(firstPersistence.path);
			expect(afterPatch.statuses).toEqual(["active"]);
			expect(first.get(id)?.status).toBe("active");
			const firstSaveEvents = trace.filter((event) => event.operation === "save");
			expect(firstSaveEvents).toHaveLength(2);
			expect(firstSaveEvents[0]?.persistedRevision).not.toBe("missing");
			expect(firstSaveEvents[1]?.persistedRevision).not.toBe(firstSaveEvents[0]?.persistedRevision);

			await invokeTracedTaskTool("manager-1", first, firstTools, { action: "list" }, firstPersistence.path, trace);
			expect(first.get(id)?.status).toBe("active");
			expect(trace.filter((event) => event.operation === "recover")).toHaveLength(1);
			expect(trace.filter((event) => event.operation === "save").at(-1)).toMatchObject({
				managerId: "manager-1",
				operation: "save",
				persistedStatuses: ["active"],
				inMemoryStatuses: ["active"],
			});
			const firstToolEvents = trace.filter((event) => event.operation === "tool");
			expect(firstToolEvents.map((event) => event.managerId)).toEqual(["manager-1", "manager-1", "manager-1"]);
			expect(firstToolEvents[1]?.persistedRevision).toBe(firstSaveEvents[1]?.persistedRevision);
			expect(firstToolEvents[2]?.persistedRevision).toBe(firstToolEvents[1]?.persistedRevision);
		} finally {
			first.dispose();
			disposeAiraSessionState(id, firstState);
		}

		const secondState = state(id);
		const secondPersistence = tracePersistence(
			createAiraTaskPersistence(id, "resume", { baseDir }),
			"manager-2",
			trace,
		);
		const second = createAiraTaskManager(secondState, {
			settings: () => ({ enabled: true }),
			persistence: secondPersistence,
		});
		const secondTools = createAiraTaskToolDefinitions({ runtime: second });
		try {
			const recovered = second.list()[0];
			expect(recovered?.status).toBe("pending");
			const recoverBeforeEvent = trace.find(
				(event) => event.managerId === "manager-2" && event.operation === "recover-before",
			);
			const recoverEvent = trace.find((event) => event.managerId === "manager-2" && event.operation === "recover");
			expect(recoverBeforeEvent).toMatchObject({
				persistedStatuses: ["active"],
				inMemoryStatuses: [],
			});
			expect(recoverEvent).toMatchObject({
				persistedStatuses: ["pending"],
				inMemoryStatuses: ["pending"],
				normalizedCount: 1,
			});
			expect(recoverEvent?.persistedRevision).toBe(readPersistedTaskTrace(secondPersistence.path).revision);
			expect(recoverEvent?.persistedRevision).not.toBe(recoverBeforeEvent?.persistedRevision);
			expect(readPersistedTaskTrace(secondPersistence.path).statuses).toEqual(["pending"]);
			const traceLengthAfterRecovery = trace.length;

			await invokeTracedTaskTool(
				"manager-2",
				second,
				secondTools,
				{ action: "list" },
				secondPersistence.path,
				trace,
			);
			await invokeTracedTaskTool(
				"manager-2",
				second,
				secondTools,
				{ action: "get", id: recovered!.id },
				secondPersistence.path,
				trace,
			);
			expect(second.get(recovered!.id)?.status).toBe("pending");
			expect(trace).toHaveLength(traceLengthAfterRecovery + 2);
			expect(second).not.toBe(first);
			expect(trace.filter((event) => event.operation === "recover")).toHaveLength(2);
			expect(trace.filter((event) => event.operation === "tool").map((event) => event.managerId)).toEqual([
				"manager-1",
				"manager-1",
				"manager-1",
				"manager-2",
				"manager-2",
			]);
			expect(trace.filter((event) => event.operation === "tool").slice(-2)).toEqual([
				expect.objectContaining({
					managerId: "manager-2",
					persistedStatuses: ["pending"],
					inMemoryStatuses: ["pending"],
				}),
				expect.objectContaining({
					managerId: "manager-2",
					persistedStatuses: ["pending"],
					inMemoryStatuses: ["pending"],
				}),
			]);

			const thirdState = state(id);
			const thirdPersistence = tracePersistence(
				createAiraTaskPersistence(id, "resume", { baseDir }),
				"manager-3",
				trace,
			);
			const third = createAiraTaskManager(thirdState, {
				settings: () => ({ enabled: true }),
				persistence: thirdPersistence,
			});
			try {
				expect(third.list()[0]?.status).toBe("pending");
				const thirdRecoverBefore = trace.find(
					(event) => event.managerId === "manager-3" && event.operation === "recover-before",
				);
				const thirdRecover = trace.find(
					(event) => event.managerId === "manager-3" && event.operation === "recover",
				);
				expect(thirdRecoverBefore).toMatchObject({
					persistedStatuses: ["pending"],
					persistedRevision: recoverEvent?.persistedRevision,
				});
				expect(thirdRecover).toMatchObject({
					persistedStatuses: ["pending"],
					inMemoryStatuses: ["pending"],
					normalizedCount: 0,
				});
				expect(thirdRecover?.persistedRevision).toBe(thirdRecoverBefore?.persistedRevision);
			} finally {
				third.dispose();
				disposeAiraSessionState(id, thirdState);
			}
		} finally {
			second.dispose();
			disposeAiraSessionState(id, secondState);
		}
	});
});
