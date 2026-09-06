import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { DurableOperationBoundary } from "../../src/harness/operation-boundary.ts";
import { InMemorySessionRepo, JsonlSessionRepo, type Session } from "../../src/harness/session/index.ts";
import type { Entry, NewRecord, OperationStartedRecord, ProvisionedEntry } from "../../src/harness/session/types.ts";

const roots: string[] = [];

const target: ProvisionedEntry<Extract<Entry, { type: "message" }>> = {
	type: "message",
	id: "queued-1",
	message: { role: "user", content: [{ type: "text", text: "queued" }], timestamp: 1 },
};

function started(id: string): NewRecord<OperationStartedRecord> {
	return {
		type: "operation_started",
		id,
		lane: "main",
		sourceLeafId: null,
		intent: { kind: "run", originalPrompt: [], initialMessages: [] },
	};
}

async function createSessions(): Promise<
	{ name: string; session: Session; reopen: (session: Session) => Promise<Session> }[]
> {
	const memory = new InMemorySessionRepo();
	const memorySession = await memory.create({ id: "memory-operation" });
	const root = mkdtempSync(join(tmpdir(), "aira-operation-boundary-"));
	roots.push(root);
	const jsonl = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
	const jsonlSession = await jsonl.create({ id: "jsonl-operation", cwd: root });
	return [
		{ name: "memory", session: memorySession, reopen: async (session) => session },
		{
			name: "jsonl",
			session: jsonlSession,
			reopen: async (session) => jsonl.open((await session.getMetadata()) as Parameters<typeof jsonl.open>[0]),
		},
	];
}

afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("durable operation boundary", () => {
	it("persists tagged inbox ordering and consumes only at a committed boundary", async () => {
		for (const { session, reopen } of await createSessions()) {
			const boundary = new DurableOperationBoundary(session, "main");
			await boundary.enqueue("followUp", target, "run-1");
			await boundary.enqueue("steer", { ...target, id: "queued-2" }, "run-1");
			expect((await boundary.listInbox()).map((item) => item.target.id)).toEqual(["queued-1", "queued-2"]);
			const reopenedBeforeStart = new DurableOperationBoundary(await reopen(session), "main");
			expect((await reopenedBeforeStart.listInbox()).map((item) => item.target.id)).toEqual([
				"queued-1",
				"queued-2",
			]);

			await session.appendRecord(started("run-1"));
			expect(await boundary.consumeInbox("run-1", ["queued-1"])).toBe(true);
			expect((await boundary.listInbox()).map((item) => item.target.id)).toEqual(["queued-2"]);
			expect(await boundary.consumeInbox("run-1", ["queued-1"])).toBe(false);
			const reopened = new DurableOperationBoundary(await reopen(session), "main");
			expect((await reopened.listInbox()).map((item) => item.target.id)).toEqual(["queued-2"]);
		}
	});

	it("observes terminal identity and dispatches every supported recovery shape", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "observe" });
		const boundary = new DurableOperationBoundary(session, "main");
		expect(await boundary.observe("missing")).toEqual({ kind: "unknown", operationId: "missing" });
		await session.appendRecord(started("run-2"));
		expect(await boundary.observe("run-2")).toMatchObject({ kind: "pending", phase: "starting" });
		expect(await boundary.recover("run-2")).toEqual({ kind: "wait", operationId: "run-2", reason: "retry" });
		await session.appendRecord({ type: "abort_requested", id: "abort-2", lane: "main", runId: "run-2" });
		expect(await boundary.recover("run-2")).toEqual({ kind: "reconcile_cancellation", operationId: "run-2" });
		await session.appendRecord({
			type: "operation_finished",
			id: "finish-2",
			lane: "main",
			runId: "run-2",
			outcome: "aborted",
		});
		expect(await boundary.observe("run-2")).toMatchObject({ kind: "terminal", result: { status: "cancelled" } });
		expect(await boundary.recover("run-2")).toMatchObject({ kind: "terminal", result: { status: "cancelled" } });
	});

	it("reconciles cancellation with compare-and-set terminal ownership", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "cancel" });
		const boundary = new DurableOperationBoundary(session, "main");
		await session.appendRecord(started("run-3"));
		expect(await boundary.requestCancellation("run-3")).toBe("requested");
		expect(await boundary.requestCancellation("run-3")).toBe("already_requested");
		await session.appendRecord({
			type: "operation_finished",
			id: "finish-3",
			lane: "main",
			runId: "run-3",
			outcome: "completed",
		});
		expect(await boundary.requestCancellation("run-3")).toBe("already_terminal");
	});
});
