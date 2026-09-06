import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { HarnessTool } from "../../src/harness/agent-harness.ts";
import { InMemorySessionRepo, type MessageEntry } from "../../src/harness/session/index.ts";
import { DurableToolExecution } from "../../src/harness/tool-execution.ts";
import type { AgentToolCall, AgentToolResult } from "../../src/types.ts";

function assistantEntry(id: string, calls: AgentToolCall[]): Omit<MessageEntry, "seq" | "parentId" | "timestamp"> {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: calls,
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		},
	};
}

function call(id: string, value: string): AgentToolCall {
	return { type: "toolCall", id, name: "record", arguments: { value } };
}

function tool(effect: (value: string, signal: AbortSignal | undefined) => Promise<void>): HarnessTool {
	return {
		name: "record",
		label: "record",
		description: "record a value",
		parameters: Type.Object({ value: Type.String() }),
		execute: async (_id, params, signal): Promise<AgentToolResult<undefined>> => {
			const value = (params as { value: string }).value;
			await effect(value, signal);
			return { content: [{ type: "text", text: value }], details: undefined };
		},
	};
}

async function setup(calls: AgentToolCall[] = [call("call-1", "one")]) {
	const repository = new InMemorySessionRepo();
	const session = await repository.create({ id: "tools" });
	const assistant = await session.appendEntry(assistantEntry("assistant", calls), "main");
	return { repository, session, assistant };
}

describe("durable tool execution", () => {
	it("commits intent before the external effect and does not replay a settled tool", async () => {
		const { session, assistant, repository } = await setup();
		let effects = 0;
		const execution = new DurableToolExecution(session, "main");
		const started = await execution.start({
			runId: "run-1",
			assistantEntryId: assistant.id,
			toolIndex: 0,
			call: call("call-1", "one"),
			args: { value: "one" },
		});
		const result = await execution.run(started, [
			tool(async (value) => {
				effects++;
				expect(
					(await session.findRecords({ type: "tool_execution_state", order: "newestFirst", limit: 1 }))[0]?.status,
				).toBe("effect_pending");
				await session.appendCustomEntry(`effect:${value}`);
			}),
		]);
		expect(result.kind).toBe("waiting");
		const ready = (await session.findRecords({ type: "tool_execution_state", order: "newestFirst", limit: 1 }))[0]!;
		expect(ready.status).toBe("outcome_ready");
		expect((await execution.place(ready)).kind).toBe("placed");
		const reopenedSession = await repository.open(await session.getMetadata());
		const reopened = new DurableToolExecution(reopenedSession, "main");
		const settled = (
			await reopenedSession.findRecords({ type: "tool_execution_state", order: "newestFirst", limit: 1 })
		)[0]!;
		expect(
			(
				await reopened.run(settled, [
					tool(async () => {
						effects++;
					}),
				])
			).kind,
		).toBe("completed");
		expect(effects).toBe(1);
	});

	it("makes an unsafe crash boundary explicit and permits safe replay", async () => {
		const { session, assistant } = await setup();
		const execution = new DurableToolExecution(session, "main");
		const unsafe = await execution.start({
			runId: "unsafe",
			assistantEntryId: assistant.id,
			toolIndex: 0,
			call: call("u", "u"),
			args: { value: "u" },
		});
		const pending = await session.transitionToolExecution("main", unsafe, {
			...unsafe,
			id: "unsafe-pending",
			status: "effect_pending",
		});
		expect(pending).toBeDefined();
		let effects = 1;
		const recovered = await execution.run(pending!, [
			tool(async () => {
				effects++;
			}),
		]);
		expect(recovered.kind).toBe("interrupted");
		expect(effects).toBe(1);

		const safe = await execution.start({
			runId: "safe",
			assistantEntryId: assistant.id,
			toolIndex: 1,
			call: call("s", "s"),
			args: { value: "s" },
			replay: "safe",
		});
		const safePending = await session.transitionToolExecution("main", safe, {
			...safe,
			id: "safe-pending",
			status: "effect_pending",
		});
		const replayed = await execution.run(safePending!, [
			tool(async () => {
				effects++;
			}),
		]);
		expect(replayed.kind).toBe("waiting");
		expect(effects).toBe(2);
	});

	it("places parallel outcomes in source order and fails missing tools durably", async () => {
		const { session, assistant } = await setup([call("a", "a"), call("b", "b")]);
		const execution = new DurableToolExecution(session, "main");
		const first = await execution.start({
			runId: "parallel",
			assistantEntryId: assistant.id,
			toolIndex: 0,
			call: call("a", "a"),
			args: { value: "a" },
		});
		const second = await execution.start({
			runId: "parallel",
			assistantEntryId: assistant.id,
			toolIndex: 1,
			call: call("b", "b"),
			args: { value: "b" },
		});
		const effects: string[] = [];
		const sharedTool = tool(async (value) => {
			if (value === "a") await new Promise((resolve) => setTimeout(resolve, 10));
			effects.push(value);
		});
		const [firstRun, secondRun] = await Promise.all([
			execution.run(first, [sharedTool]),
			execution.run(second, [sharedTool]),
		]);
		expect(firstRun.kind).toBe("waiting");
		expect(secondRun.kind).toBe("waiting");
		const states = await session.findRecords({ type: "tool_execution_state", order: "newestFirst" });
		const firstReady = states.find((state) => state.invocationId === first.invocationId)!;
		const secondReady = states.find((state) => state.invocationId === second.invocationId)!;
		expect((await execution.place(secondReady)).kind).toBe("waiting");
		expect((await execution.place(firstReady)).kind).toBe("placed");
		expect((await execution.place(secondReady)).kind).toBe("placed");
		expect(effects.sort()).toEqual(["a", "b"]);

		const missing = await execution.start({
			runId: "missing",
			assistantEntryId: assistant.id,
			toolIndex: 2,
			call: call("m", "m"),
			args: { value: "m" },
		});
		const failed = await execution.run(missing, []);
		expect(failed.kind).toBe("failed");
		expect((await execution.place(failed.state)).kind).toBe("placed");
	});

	it("cancels before admitting the effect", async () => {
		const { session, assistant } = await setup();
		const execution = new DurableToolExecution(session, "main");
		const started = await execution.start({
			runId: "cancel",
			assistantEntryId: assistant.id,
			toolIndex: 0,
			call: call("c", "c"),
			args: { value: "c" },
		});
		const controller = new AbortController();
		controller.abort();
		let effects = 0;
		const cancelled = await execution.run(
			started,
			[
				tool(async () => {
					effects++;
				}),
			],
			controller.signal,
		);
		expect(cancelled.kind).toBe("cancelled");
		expect(effects).toBe(0);
		expect((await execution.place(cancelled.state)).kind).toBe("placed");
	});
});
