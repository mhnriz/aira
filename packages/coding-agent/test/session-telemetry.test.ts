import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type Usage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	renderSessionTelemetryJson,
	renderSessionTelemetryText,
	SessionTelemetry,
} from "../src/core/session-telemetry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { ExtensionAPI } from "../src/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const EDIT_NOT_FOUND_ERROR =
	"Could not find edits[0] in a.ts. The oldText must match exactly including all whitespace and newlines.";
const EDIT_AMBIGUOUS_ERROR =
	"Found 2 occurrences of edits[0] in a.ts. Each oldText must be unique. Please provide more context to make it unique.";

function toolStart(toolCallId: string, toolName: string, args: unknown): AgentEvent {
	return { type: "tool_execution_start", toolCallId, toolName, args };
}

function toolEnd(toolCallId: string, toolName: string, isError: boolean, result: unknown): AgentEvent {
	return { type: "tool_execution_end", toolCallId, toolName, result, isError };
}

function textResult(text: string): unknown {
	return { content: [{ type: "text", text }] };
}

function emptyResult(): unknown {
	return { content: [] };
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function turnEnd(): AgentEvent {
	return {
		type: "turn_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "test",
			provider: "test",
			model: "test",
			timestamp: 0,
			usage: ZERO_USAGE,
			stopReason: "stop",
		},
		toolResults: [],
	};
}

/** Fake monotonic clock: `now` returns base + elapsed accumulation. */
function fakeClock() {
	let current = 1_000_000;
	return {
		now: () => current,
		advance: (ms: number) => {
			current += ms;
		},
	};
}

interface TempDir {
	dir: string;
	file: (name: string) => string;
	cleanup: () => void;
}

function createTempDir(): TempDir {
	const dir = mkdtempSync(join(tmpdir(), "pi-telemetry-test-"));
	return {
		dir,
		file: (name: string) => join(dir, name),
		cleanup: () => {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const cleanups: Array<() => void> = [];
const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});

const readToolParams = Type.Object({ path: Type.String() });
const editToolParams = Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() });
function makeReadTool(): AgentTool<typeof readToolParams> {
	return {
		name: "read",
		label: "read",
		description: "read",
		parameters: readToolParams,
		execute: async (_toolCallId, params) => ({
			content: [{ type: "text", text: readFileSync(params.path, "utf-8") }],
			details: {},
		}),
	};
}

function makeEditTool(): AgentTool<typeof editToolParams> {
	return {
		name: "edit",
		label: "edit",
		description: "edit",
		parameters: editToolParams,
		execute: async (_toolCallId, params) => {
			const content = readFileSync(params.path, "utf-8");
			if (!content.includes(params.oldText)) {
				throw new Error(EDIT_NOT_FOUND_ERROR);
			}
			writeFileSync(params.path, content.replace(params.oldText, params.newText), "utf-8");
			return { content: [{ type: "text", text: "edited" }], details: {} };
		},
	};
}

function makeExplodeTool(): AgentTool {
	return {
		name: "explode",
		label: "explode",
		description: "explode",
		parameters: Type.Object({}),
		execute: async () => {
			throw new Error("boom");
		},
	};
}

// ============================================================================
// Collector unit tests
// ============================================================================

describe("SessionTelemetry collector", () => {
	it("counts tool calls and per-tool counts without any failure", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const clock = fakeClock();
		const telemetry = new SessionTelemetry({ now: clock.now });

		clock.advance(100);
		await telemetry.onAgentEvent(toolStart("t1", "read", { path: temp.file("a.ts") }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t1", "read", false, emptyResult()), temp.dir);
		await telemetry.onAgentEvent(toolStart("t2", "read", { path: temp.file("a.ts") }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t2", "read", false, emptyResult()), temp.dir);
		await telemetry.onAgentEvent(toolStart("t3", "bash", { command: "ls" }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t3", "bash", false, emptyResult()), temp.dir);
		await telemetry.onAgentEvent(turnEnd(), temp.dir);
		await telemetry.onAgentEvent(turnEnd(), temp.dir);

		const snapshot = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(snapshot.tools.total).toBe(3);
		expect(snapshot.tools.failed).toBe(0);
		expect(snapshot.tools.cancelled).toBe(0);
		expect(snapshot.tools.byName).toEqual({ bash: 1, read: 2 });
		expect(snapshot.usage.modelRequests).toBe(2);
	});

	it("counts failed and cancelled tool calls separately", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const telemetry = new SessionTelemetry();

		await telemetry.onAgentEvent(toolStart("t1", "bash", { command: "false" }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t1", "bash", true, textResult("command failed")), temp.dir);
		await telemetry.onAgentEvent(toolStart("t2", "read", { path: temp.file("a.ts") }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t2", "read", true, textResult("Operation aborted")), temp.dir);
		await telemetry.onAgentEvent(toolStart("t3", "grep", { pattern: "x", path: temp.dir }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t3", "grep", true, textResult("no matches")), temp.dir);

		const snapshot = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(snapshot.tools.total).toBe(3);
		expect(snapshot.tools.failed).toBe(3);
		expect(snapshot.tools.cancelled).toBe(1);
	});

	it("distinguishes unique files from repeated unchanged reads and reads after modification", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const a = temp.file("a.ts");
		const b = temp.file("b.ts");
		writeFileSync(a, "one", "utf-8");
		writeFileSync(b, "two", "utf-8");
		const telemetry = new SessionTelemetry();

		// First read of a: fresh read.
		await telemetry.onAgentEvent(toolStart("t1", "read", { path: a }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t1", "read", false, emptyResult()), temp.dir);
		// Second read of a while unchanged: repeated unchanged.
		await telemetry.onAgentEvent(toolStart("t2", "read", { path: a }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t2", "read", false, emptyResult()), temp.dir);
		// Modify a, then read again: NOT an unchanged repeated read.
		writeFileSync(a, "one-two-three", "utf-8");
		await telemetry.onAgentEvent(toolStart("t3", "read", { path: a }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t3", "read", false, emptyResult()), temp.dir);
		// Read of b: a second unique file.
		await telemetry.onAgentEvent(toolStart("t4", "read", { path: b }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t4", "read", false, emptyResult()), temp.dir);

		const snapshot = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(snapshot.repository.reads).toBe(4);
		expect(snapshot.repository.uniqueFilesRead).toBe(2);
		expect(snapshot.repository.repeatedUnchangedReads).toBe(1);
	});

	it("does not classify a read after an edit as an unchanged repeated read", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const a = temp.file("a.ts");
		writeFileSync(a, "hello world", "utf-8");
		const telemetry = new SessionTelemetry();

		await telemetry.onAgentEvent(toolStart("t1", "read", { path: a }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t1", "read", false, emptyResult()), temp.dir);
		// Successful edit (same content, exercised through the edit flow).
		await telemetry.onAgentEvent(toolStart("t2", "edit", { path: a, oldText: "hello", newText: "hello" }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t2", "edit", false, emptyResult()), temp.dir);
		await telemetry.onAgentEvent(toolStart("t3", "read", { path: a }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t3", "read", false, emptyResult()), temp.dir);

		const snapshot = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(snapshot.repository.repeatedUnchangedReads).toBe(0);
		expect(snapshot.editing.successful).toBe(1);
	});

	it("counts edit attempts, successes, failures, conflicts, and retries", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const a = temp.file("a.ts");
		writeFileSync(a, "one", "utf-8");
		const telemetry = new SessionTelemetry();

		// Successful edit.
		await telemetry.onAgentEvent(toolStart("t1", "edit", { path: a, oldText: "one", newText: "two" }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t1", "edit", false, emptyResult()), temp.dir);
		// Exact-edit conflict (oldText not found).
		await telemetry.onAgentEvent(toolStart("t2", "edit", { path: a, oldText: "missing", newText: "x" }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t2", "edit", true, textResult(EDIT_NOT_FOUND_ERROR)), temp.dir);
		// Retry of the same file after the failure: succeeds -> retry counted.
		await telemetry.onAgentEvent(toolStart("t3", "edit", { path: a, oldText: "two", newText: "three" }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t3", "edit", false, emptyResult()), temp.dir);
		// Ambiguous oldText is also a conflict class.
		await telemetry.onAgentEvent(toolStart("t4", "edit", { path: a, oldText: "t", newText: "z" }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t4", "edit", true, textResult(EDIT_AMBIGUOUS_ERROR)), temp.dir);

		const snapshot = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(snapshot.editing.attempts).toBe(4);
		expect(snapshot.editing.successful).toBe(2);
		expect(snapshot.editing.failed).toBe(2);
		expect(snapshot.editing.conflicts).toBe(2);
		expect(snapshot.editing.retries).toBe(1);
	});

	it("classifies non-conflict edit failures as failed but not conflicts", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const a = temp.file("a.ts");
		writeFileSync(a, "one", "utf-8");
		const telemetry = new SessionTelemetry();

		await telemetry.onAgentEvent(toolStart("t1", "edit", { path: a, oldText: "one", newText: "two" }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t1", "edit", true, textResult("disk full")), temp.dir);

		const snapshot = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(snapshot.editing.failed).toBe(1);
		expect(snapshot.editing.conflicts).toBe(0);
	});

	it("counts ask_user tool invocations", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const telemetry = new SessionTelemetry();

		await telemetry.onAgentEvent(toolStart("t1", "ask_user", { question: "go?" }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t1", "ask_user", false, emptyResult()), temp.dir);

		const snapshot = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(snapshot.agent.askUser).toBe(1);
		expect(snapshot.tools.byName.ask_user).toBe(1);
	});

	it("counts searches from grep/find tool calls", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const telemetry = new SessionTelemetry();

		await telemetry.onAgentEvent(toolStart("t1", "grep", { pattern: "foo", path: temp.dir }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t1", "grep", false, emptyResult()), temp.dir);
		await telemetry.onAgentEvent(toolStart("t2", "find", { path: temp.dir }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t2", "find", false, emptyResult()), temp.dir);

		const snapshot = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(snapshot.repository.searches).toBe(2);
		expect(snapshot.repository.reads).toBe(0);
	});

	it("classifies validation invocations from process_start purpose metadata", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const telemetry = new SessionTelemetry();

		await telemetry.onAgentEvent(toolStart("t1", "process_start", { purpose: "test", command: "x" }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t1", "process_start", false, emptyResult()), temp.dir);
		await telemetry.onAgentEvent(toolStart("t2", "process_start", { purpose: "build", command: "x" }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t2", "process_start", false, emptyResult()), temp.dir);
		await telemetry.onAgentEvent(toolStart("t3", "process_start", { purpose: "check", command: "x" }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t3", "process_start", false, emptyResult()), temp.dir);
		await telemetry.onAgentEvent(toolStart("t4", "process_start", { purpose: "dev", command: "x" }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t4", "process_start", false, emptyResult()), temp.dir);

		const snapshot = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(snapshot.validation.tests).toBe(1);
		expect(snapshot.validation.builds).toBe(1);
		expect(snapshot.validation.checks).toBe(1);
	});

	it("counts verifier runs only on transitions into a running state", async () => {
		const telemetry = new SessionTelemetry();
		telemetry.observeVerificationState("idle");
		telemetry.observeVerificationState("preparing");
		telemetry.observeVerificationState("running");
		telemetry.observeVerificationState("passed");
		telemetry.observeVerificationState("preparing");
		telemetry.observeVerificationState("running");

		const snapshot = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(snapshot.validation.verifications).toBe(2);
	});

	it("counts task state transitions by type", async () => {
		const telemetry = new SessionTelemetry();
		// First observation is a baseline, not a transition.
		telemetry.observeTaskStatuses([
			{ id: "t1", status: "pending" },
			{ id: "t2", status: "pending" },
		]);
		telemetry.observeTaskStatuses([
			{ id: "t1", status: "active" },
			{ id: "t2", status: "pending" },
		]);
		telemetry.observeTaskStatuses([
			{ id: "t1", status: "completed" },
			{ id: "t2", status: "active" },
		]);
		telemetry.observeTaskStatuses([
			{ id: "t1", status: "completed" },
			{ id: "t2", status: "active" },
		]);

		const snapshot = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(snapshot.agent.taskTransitions).toBe(3);
		expect(snapshot.agent.taskTransitionsByType).toEqual({
			"active->completed": 1,
			"pending->active": 2,
		});
	});

	it("counts each child run id once", async () => {
		const telemetry = new SessionTelemetry();
		telemetry.observeChildRunId("run-1");
		telemetry.observeChildRunId("run-1");
		telemetry.observeChildRunId("run-2");

		const snapshot = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(snapshot.agent.childAgents).toBe(2);
	});

	it("tracks timing with a monotonic clock and leaves missing values null", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const clock = fakeClock();
		const telemetry = new SessionTelemetry({ now: clock.now });

		const fresh = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(fresh.timing.timeToFirstToolMs).toBeNull();
		expect(fresh.timing.timeToFirstRepositoryReadMs).toBeNull();
		expect(fresh.timing.timeToFirstEditMs).toBeNull();

		clock.advance(1_200);
		await telemetry.onAgentEvent(toolStart("t1", "read", { path: temp.file("a.ts") }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t1", "read", false, emptyResult()), temp.dir);
		clock.advance(30_200);
		await telemetry.onAgentEvent(
			toolStart("t2", "edit", { path: temp.file("a.ts"), oldText: "x", newText: "y" }),
			temp.dir,
		);
		await telemetry.onAgentEvent(toolEnd("t2", "edit", false, emptyResult()), temp.dir);
		clock.advance(73_300);

		const snapshot = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(snapshot.timing.timeToFirstToolMs).toBe(1_200);
		expect(snapshot.timing.timeToFirstRepositoryReadMs).toBe(1_200);
		expect(snapshot.timing.timeToFirstEditMs).toBe(31_400);
		expect(snapshot.timing.elapsedMs).toBe(104_700);
	});

	it("snapshot inspection does not mutate the measured counters", async () => {
		const telemetry = new SessionTelemetry();
		telemetry.observeChildRunId("run-1");
		telemetry.observeTaskStatuses([{ id: "t1", status: "active" }]);

		const first = telemetry.snapshot({
			inputTokens: 1,
			outputTokens: 2,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.5,
		});
		const second = telemetry.snapshot({
			inputTokens: 1,
			outputTokens: 2,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.5,
		});
		expect(second.tools).toEqual(first.tools);
		expect(second.repository).toEqual(first.repository);
		expect(second.editing).toEqual(first.editing);
		expect(second.agent).toEqual(first.agent);
		expect(second.usage).toEqual(first.usage);
	});

	it("exposes deterministic machine-readable JSON with a schema version", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const telemetry = new SessionTelemetry();

		await telemetry.onAgentEvent(toolStart("t1", "read", { path: temp.file("a.ts") }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t1", "read", false, emptyResult()), temp.dir);
		const snapshot = telemetry.snapshot({
			inputTokens: 40_200,
			outputTokens: 18_400,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.021,
		});
		const parsed = JSON.parse(renderSessionTelemetryJson(snapshot)) as Record<string, unknown>;

		expect(parsed.schemaVersion).toBe("1.0.0");
		expect(Object.keys(parsed).sort()).toEqual([
			"agent",
			"editing",
			"repository",
			"schemaVersion",
			"timing",
			"tools",
			"usage",
			"validation",
		]);
		expect(parsed.usage).toEqual({
			inputTokens: 40_200,
			outputTokens: 18_400,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.021,
			modelRequests: 0,
		});
		expect(parsed.timing).toEqual({
			elapsedMs: expect.any(Number),
			timeToFirstToolMs: expect.any(Number),
			timeToFirstRepositoryReadMs: expect.any(Number),
			timeToFirstEditMs: null,
		});
	});

	it("renders a compact human-readable summary without the JSON-only fields", async () => {
		const telemetry = new SessionTelemetry();
		const snapshot = telemetry.snapshot({
			inputTokens: 40_200,
			outputTokens: 18_400,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.021,
		});
		const text = renderSessionTelemetryText(snapshot);
		expect(text).toContain("Session Telemetry");
		expect(text).toContain("input tokens");
		expect(text).toContain("40,200");
		expect(text).toContain("$0.0210");
		expect(text).toContain("unavailable");
	});

	it("ignores events after dispose", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const telemetry = new SessionTelemetry();
		telemetry.dispose();

		await telemetry.onAgentEvent(toolStart("t1", "read", { path: temp.file("a.ts") }), temp.dir);
		await telemetry.onAgentEvent(toolEnd("t1", "read", false, emptyResult()), temp.dir);

		const snapshot = telemetry.snapshot({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(snapshot.tools.total).toBe(0);
	});
});

// ============================================================================
// Integration tests through the agent loop (faux provider)
// ============================================================================

describe("SessionTelemetry integration", () => {
	it("records tool calls, reads, and model requests through a real run", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const a = temp.file("a.ts");
		writeFileSync(a, "one", "utf-8");

		const harness = await createHarness({
			cwd: temp.dir,
			tools: [makeReadTool()],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: a }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const providerCallsBefore = harness.faux.state.callCount;
		await harness.session.prompt("read the file");

		const snapshot = harness.session.getTelemetrySnapshot();
		expect(snapshot.schemaVersion).toBe("1.0.0");
		expect(snapshot.tools.total).toBe(1);
		expect(snapshot.tools.byName).toEqual({ read: 1 });
		expect(snapshot.repository.reads).toBe(1);
		expect(snapshot.repository.uniqueFilesRead).toBe(1);
		expect(snapshot.repository.repeatedUnchangedReads).toBe(0);
		expect(snapshot.usage.modelRequests).toBe(2);
		expect(snapshot.agent.childAgents).toBe(0);
		// Telemetry itself never triggers provider calls.
		expect(harness.faux.state.callCount - providerCallsBefore).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("detects repeated unchanged reads across a multi-turn run", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const a = temp.file("a.ts");
		writeFileSync(a, "one", "utf-8");

		const harness = await createHarness({ cwd: temp.dir, tools: [makeReadTool()] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: a }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read", { path: a }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("read twice");

		const snapshot = harness.session.getTelemetrySnapshot();
		expect(snapshot.repository.reads).toBe(2);
		expect(snapshot.repository.uniqueFilesRead).toBe(1);
		expect(snapshot.repository.repeatedUnchangedReads).toBe(1);
	});

	it("counts edit attempts and conflicts through the real edit flow", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const a = temp.file("a.ts");
		writeFileSync(a, "one", "utf-8");

		const harness = await createHarness({ cwd: temp.dir, tools: [makeEditTool()] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", { path: a, oldText: "missing", newText: "x" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("edit", { path: a, oldText: "one", newText: "two" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("edit the file");

		const snapshot = harness.session.getTelemetrySnapshot();
		expect(snapshot.editing.attempts).toBe(2);
		expect(snapshot.editing.successful).toBe(1);
		expect(snapshot.editing.failed).toBe(1);
		expect(snapshot.editing.conflicts).toBe(1);
		expect(snapshot.editing.retries).toBe(1);
	});

	it("counts failed tool calls with isError results", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);

		const harness = await createHarness({ cwd: temp.dir, tools: [makeExplodeTool()] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("explode", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("explode");

		const snapshot = harness.session.getTelemetrySnapshot();
		expect(snapshot.tools.failed).toBe(1);
		expect(snapshot.tools.cancelled).toBe(0);
	});

	it("counts ask_user tool calls through the agent loop", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);

		const askUserTool: AgentTool = {
			name: "ask_user",
			label: "ask_user",
			description: "ask",
			parameters: Type.Object({ question: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "yes" }], details: {} }),
		};
		const harness = await createHarness({ cwd: temp.dir, tools: [askUserTool] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ask_user", { question: "go?" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("ask me");

		const snapshot = harness.session.getTelemetrySnapshot();
		expect(snapshot.agent.askUser).toBe(1);
	});

	it("never surfaces telemetry content in the model transcript", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const a = temp.file("a.ts");
		writeFileSync(a, "one", "utf-8");

		const harness = await createHarness({ cwd: temp.dir, tools: [makeReadTool()] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: a }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("read the file");
		// Inspect telemetry the way /telemetry does.
		harness.session.getTelemetrySnapshot();
		harness.session.getTelemetrySnapshot();

		const messages = harness.session.messages;
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const transcript = JSON.stringify(messages);
		expect(transcript).not.toContain("Session Telemetry");
		expect(transcript).not.toContain("modelRequests");
		const systemPrompt = harness.session.agent.state.systemPrompt;
		expect(systemPrompt).not.toContain("Session Telemetry");
		expect(systemPrompt).not.toContain("modelRequests");
		// Repeated inspection does not disturb the counters.
		const snapshot = harness.session.getTelemetrySnapshot();
		expect(snapshot.tools.total).toBe(1);
		expect(snapshot.repository.reads).toBe(1);
	});

	it("resets telemetry across a real session replacement (/new)", async () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		const faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
		cleanups.push(() => faux.unregister());
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const runtimeOptions = {
				cwd,
				agentDir: temp.dir,
				authStorage,
				settingsManager: SettingsManager.inMemory({ permissions: { enabled: false } }),
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			};
			const services = await createAgentSessionServices({ ...runtimeOptions, cwd });
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: temp.dir,
			agentDir: temp.dir,
			sessionManager: SessionManager.create(temp.dir),
		});
		cleanups.push(() => {
			void runtime.dispose();
		});
		await runtime.session.bindExtensions({});

		faux.setResponses([fauxAssistantMessage("hello")]);
		const firstSession = runtime.session;
		await firstSession.prompt("hi");
		expect(firstSession.getTelemetrySnapshot().usage.modelRequests).toBe(1);

		const result = await runtime.newSession();
		expect(result.cancelled).toBe(false);
		expect(runtime.session).not.toBe(firstSession);
		await runtime.session.bindExtensions({});

		const fresh = runtime.session.getTelemetrySnapshot();
		expect(fresh.usage.modelRequests).toBe(0);
		expect(fresh.tools.total).toBe(0);
		expect(fresh.repository.reads).toBe(0);
		expect(fresh.timing.timeToFirstToolMs).toBeNull();
	});
});
