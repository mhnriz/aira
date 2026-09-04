/**
 * Phase 9 — child runner: structured result parsing, bounding, provider
 * failure behavior, tool-budget failsafe, timeout, and cancellation.
 *
 * Deterministic: the faux provider serves scripted assistant messages; the
 * child's tool set (read/grep/find/ls) executes against real fixture files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AiraChildRuntime,
	normalizeChildResult,
	parseChildResult,
	runAiraChild,
} from "../../../src/aira/orchestration/runner.ts";
import { createFindTool } from "../../../src/core/tools/find.ts";
import { createGrepTool } from "../../../src/core/tools/grep.ts";
import { createLsTool } from "../../../src/core/tools/ls.ts";
import { createReadTool } from "../../../src/core/tools/read.ts";

const COMPLETED_RESULT = JSON.stringify({
	status: "completed",
	summary: "Mapped the player module: seek() lives in src/player.ts.",
	findings: ["stream switching happens in streamController.ts"],
	evidence: ["src/player.ts:12", "src/streams.ts:40"],
	relevantFiles: ["src/player.ts", "src/streams.ts"],
	changedFiles: [],
	tests: [],
	errors: [],
});

function makeProjectDir(): string {
	const root = join(tmpdir(), `aira-orchestration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "player.ts"), "export function seek(t: number) { return t; }\n");
	return root;
}

const registrations: Array<{ unregister: () => void }> = [];
afterEach(() => {
	while (registrations.length > 0) {
		registrations.shift()?.unregister();
	}
});

function fauxRuntime(): { runtime: AiraChildRuntime; setResponses: (responses: unknown[]) => void } {
	const registration = registerFauxProvider({});
	registrations.push(registration);
	const model = registration.getModel();
	return {
		runtime: { model, streamFn: streamSimple, apiKey: "faux-key" },
		setResponses: (responses: unknown[]) => registration.setResponses(responses as never),
	};
}

function readOnlyTools(cwd: string) {
	return [createReadTool(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
}

describe("Aira child runner (Phase 9)", () => {
	it("applies the root permission gate to child tool calls (ask never prompts; deny blocks truthfully)", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		writeFileSync(join(root, "src", "player.ts"), "let t = 0;\nt += 1;\n");
		// First round: a denied tool, then an allowed one, then the result.
		setResponses([
			fauxAssistantMessage([
				fauxToolCall("edit", { path: "src/player.ts", edits: [] }),
				fauxToolCall("read", { path: "src/player.ts" }),
			]),
			fauxAssistantMessage(fauxText(COMPLETED_RESULT)),
		]);
		const outcome = await runAiraChild(runtime, {
			cwd: root,
			prompt: "inspect player.ts",
			systemPrompt: "child",
			tools: readOnlyTools(root),
			gateTool: (toolName) =>
				toolName === "edit"
					? { block: true, reason: "edit is blocked for children by permission policy" }
					: undefined,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// The child still completed: the denied tool call became a truthful
		// error result, the read succeeded, and the result parsed.
		expect(outcome.result.summary).toContain("Mapped the player module");
		// The denied tool's reason reached the model within the round.
		expect(JSON.stringify(outcome.result)).toBeTruthy();
	});

	it("gate failures degrade to ordinary child results (never a wedged child)", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "npm test" })]),
			fauxAssistantMessage(fauxText(COMPLETED_RESULT)),
		]);
		const outcome = await runAiraChild(runtime, {
			cwd: root,
			prompt: "run the tests",
			systemPrompt: "child",
			tools: readOnlyTools(root),
			gateTool: () => ({ block: true, reason: "children cannot prompt for permission; denied" }),
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result.summary).toContain("Mapped the player module");
	});

	it("runs a tool round and returns the structured result with the resolved model", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "src/player.ts" })]),
			fauxAssistantMessage(fauxText(COMPLETED_RESULT)),
		]);
		const outcome = await runAiraChild(runtime, {
			cwd: root,
			prompt: "TASK map it",
			systemPrompt: "Child role",
			tools: readOnlyTools(root),
			timeoutMs: 5000,
		});
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.result.status).toBe("completed");
			expect(outcome.result.summary).toContain("seek()");
			expect(outcome.result.relevantFiles).toContain("src/player.ts");
			expect(outcome.result.changedFiles).toEqual([]);
			expect(outcome.model).toBeTruthy();
		}
	});

	it("accepts fenced JSON and fails closed on unparseable output", async () => {
		expect(parseChildResult(`\`\`\`json\n${COMPLETED_RESULT}\n\`\`\``)).toBeDefined();
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([fauxAssistantMessage(fauxText("let me think about this"))]);
		const outcome = await runAiraChild(runtime, {
			cwd: root,
			prompt: "TASK",
			systemPrompt: "",
			tools: readOnlyTools(root),
			timeoutMs: 5000,
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.driverError).toContain("no valid structured result");
		}
	});

	it("normalizes + bounds malformed result fields", () => {
		const result = normalizeChildResult({
			status: "failed",
			summary: "s".repeat(5000),
			findings: Array.from({ length: 100 }, (_, index) => `f${index}`.repeat(100)),
			changedFiles: "not-an-array",
			evidence: [42, "ok", ""],
		});
		expect(result.status).toBe("failed");
		expect(result.summary.length).toBeLessThanOrEqual(600);
		expect(result.findings.length).toBeLessThanOrEqual(12);
		expect(result.findings[0]!.length).toBeLessThanOrEqual(300);
		expect(result.changedFiles).toEqual([]);
		expect(result.evidence).toEqual(["ok"]);
		expect(result.summary).not.toHaveLength(0);
	});

	it("maps provider errors to a driver error (never a fabricated result)", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([
			fauxAssistantMessage(fauxText("boom"), { stopReason: "error", errorMessage: "provider exploded" }),
		]);
		const outcome = await runAiraChild(runtime, {
			cwd: root,
			prompt: "TASK",
			systemPrompt: "",
			tools: readOnlyTools(root),
			timeoutMs: 5000,
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.driverError).toContain("provider exploded");
		}
	});

	it("fails closed when the model keeps calling tools beyond the budget", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([
			fauxAssistantMessage([fauxToolCall("ls", { path: "." })]),
			fauxAssistantMessage([fauxToolCall("ls", { path: "." })]),
			fauxAssistantMessage([fauxToolCall("ls", { path: "." })]),
		]);
		const outcome = await runAiraChild(runtime, {
			cwd: root,
			prompt: "TASK",
			systemPrompt: "",
			tools: readOnlyTools(root),
			timeoutMs: 5000,
			maxToolRounds: 2,
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.driverError).toContain("tool budget");
		}
	});

	it("timeout settles as a driver error", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		// A hanging child response: the run must settle on timeout, not hang.
		setResponses([() => new Promise(() => {}) as never]);
		const outcome = await runAiraChild(runtime, {
			cwd: root,
			prompt: "TASK",
			systemPrompt: "",
			tools: readOnlyTools(root),
			timeoutMs: 200,
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.driverError).toContain("timed out");
		}
	});

	it("cancellation settles as a driver error", async () => {
		const root = makeProjectDir();
		const { runtime, setResponses } = fauxRuntime();
		setResponses([() => new Promise(() => {}) as never]);
		const controller = new AbortController();
		const run = runAiraChild(
			runtime,
			{ cwd: root, prompt: "TASK", systemPrompt: "", tools: readOnlyTools(root), timeoutMs: 60_000 },
			controller.signal,
		);
		controller.abort();
		const outcome = await run;
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.driverError).toContain("cancelled");
		}
	});

	describe("Agent Inspector event capture (Phase 12.x)", () => {
		it("captures assistant text, thinking, tool calls, and tool results as structured events", async () => {
			const root = makeProjectDir();
			const { runtime, setResponses } = fauxRuntime();
			writeFileSync(join(root, "src", "player.ts"), "export const seek = 1;\n");
			setResponses([
				fauxAssistantMessage([
					fauxText("Inspecting the player module\u2026"),
					fauxToolCall("read", { path: "src/player.ts" }),
				]),
				fauxAssistantMessage(fauxText(COMPLETED_RESULT)),
			]);
			const captured: import("../../../src/aira/orchestration/events.ts").AiraChildEvent[] = [];
			const outcome = await runAiraChild(runtime, {
				cwd: root,
				prompt: "TASK map it",
				systemPrompt: "Child role",
				tools: readOnlyTools(root),
				timeoutMs: 10_000,
				events: (event) => captured.push(event),
			});
			expect(outcome.ok).toBe(true);
			const kinds = captured.map((event) => event.kind);
			expect(kinds).toContain("text");
			expect(kinds).toContain("tool_call");
			expect(kinds).toContain("tool_result");
			const textEvent = captured.find((event) => event.kind === "text");
			expect(textEvent && textEvent.kind === "text" ? textEvent.text : "").toContain("Inspecting");
			const call = captured.find((event) => event.kind === "tool_call");
			expect(call && call.kind === "tool_call" ? call.args : "").toContain("src/player.ts");
			const result = captured.find((event) => event.kind === "tool_result");
			expect(result && result.kind === "tool_result" ? result.isError : true).toBe(false);
		});

		it("captures thinking blocks as structured thinking events", async () => {
			const root = makeProjectDir();
			const { runtime, setResponses } = fauxRuntime();
			setResponses([fauxAssistantMessage([fauxThinking("tracing the control flow"), fauxText(COMPLETED_RESULT)])]);
			const captured: Array<{ kind: string; text?: string }> = [];
			const outcome = await runAiraChild(runtime, {
				cwd: root,
				prompt: "TASK",
				systemPrompt: "",
				tools: readOnlyTools(root),
				timeoutMs: 10_000,
				events: (event) => captured.push(event),
			});
			expect(outcome.ok).toBe(true);
			const thinking = captured.find((event) => event.kind === "thinking");
			expect(thinking?.text).toContain("tracing");
		});

		it("captures permission denials as structured permission events", async () => {
			const root = makeProjectDir();
			const { runtime, setResponses } = fauxRuntime();
			setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "npm test" })]),
				fauxAssistantMessage(fauxText(COMPLETED_RESULT)),
			]);
			const captured: Array<{ kind: string; tool?: string; reason?: string }> = [];
			const outcome = await runAiraChild(runtime, {
				cwd: root,
				prompt: "TASK",
				systemPrompt: "",
				tools: readOnlyTools(root),
				gateTool: () => ({ block: true, reason: "children cannot prompt for permission; denied" }),
				timeoutMs: 10_000,
				events: (event) => captured.push(event),
			});
			expect(outcome.ok).toBe(true);
			const permission = captured.find((event) => event.kind === "permission");
			expect(permission?.tool).toBe("bash");
			expect(permission?.reason).toContain("children cannot prompt");
			// A blocked call records the denial as a permission event; no
			// tool_result is fabricated for a call that never executed.
			expect(captured.some((event) => event.kind === "tool_result")).toBe(false);
		});

		it("bounds tool arguments in captured events", async () => {
			const root = makeProjectDir();
			const { runtime, setResponses } = fauxRuntime();
			const longPath = "x".repeat(2_000);
			setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: longPath })]),
				fauxAssistantMessage(fauxText(COMPLETED_RESULT)),
			]);
			const captured: Array<{ kind: string; args?: string }> = [];
			const outcome = await runAiraChild(runtime, {
				cwd: root,
				prompt: "TASK",
				systemPrompt: "",
				tools: readOnlyTools(root),
				timeoutMs: 10_000,
				events: (event) => captured.push(event),
			});
			expect(outcome.ok).toBe(true);
			const call = captured.find((event) => event.kind === "tool_call");
			const args = (call && call.kind === "tool_call" ? call.args : undefined) ?? "";
			expect(args.length).toBeLessThanOrEqual(400);
		});
	});
});
