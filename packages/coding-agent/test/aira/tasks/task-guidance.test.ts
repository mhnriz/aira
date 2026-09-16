/**
 * Aira tasks — task-use policy guidance tests (0.1.8 lean prompt C).
 *
 * Proves the canonical model-facing guidance communicates the selective
 * task-use policy: direct execution is the default for one coherent
 * deliverable; tasks remain appropriate when the work is independent,
 * long-running or resumable, or explicitly requested. Task bookkeeping stays
 * one-at-a-time and child-delegated rows stay orchestration-owned. The tool
 * surface itself is unchanged.
 */
import { describe, expect, it } from "vitest";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";
import { createAiraTaskManager } from "../../../src/aira/tasks/manager.ts";
import { createAiraTaskToolDefinitions } from "../../../src/aira/tasks/model-tool.ts";
import { buildSystemPrompt } from "../../../src/core/system-prompt.ts";

function taskTool() {
	const state = acquireAiraSessionState("task-guidance-test");
	const manager = createAiraTaskManager(state, { settings: () => ({ enabled: true }) });
	const tools = createAiraTaskToolDefinitions({ runtime: manager });
	disposeAiraSessionState(state.sessionId, state);
	return tools.tasks!;
}

function guidanceText(): string {
	const tool = taskTool();
	return [...(tool.promptGuidelines ?? []), tool.description ?? ""].join("\n");
}

describe("tasks task-use guidance (selective planning)", () => {
	it("does not encourage a task graph for one coherent deliverable", () => {
		const text = guidanceText();
		expect(text).toMatch(/work directly for one coherent deliverable/i);
		expect(text).toMatch(/use tasks selectively/i);
	});

	it("removed the mechanical step-count trigger", () => {
		expect(guidanceText()).not.toContain("3+ distinct steps");
	});

	it("keeps task usage appropriate when the user explicitly requests a plan or checklist", () => {
		const text = guidanceText();
		expect(text).toMatch(/explicitly requested/i);
		expect(text).toMatch(/plan\/checklist/i);
	});

	it("keeps task usage appropriate for independent workstreams", () => {
		expect(guidanceText()).toMatch(/independent/i);
	});

	it("keeps task usage appropriate for child-agent coordination", () => {
		const text = guidanceText();
		expect(text).toMatch(/orchestration-owned/i);
		expect(text).toMatch(/agents_delegate/i);
	});

	it("keeps task usage appropriate for long-running or resumable work", () => {
		expect(guidanceText()).toMatch(/long-running or resumable/i);
	});

	it("keeps the one-task-at-a-time bookkeeping contract", () => {
		const text = guidanceText();
		expect(text).toMatch(/Patch one task at a time/i);
		expect(text).toMatch(/unfinished dependencies is blocked/i);
	});

	it("keeps the task tool surface available and unchanged", async () => {
		const tool = taskTool();
		expect(tool.name).toBe("tasks");
		expect(tool.promptSnippet).toBeTruthy();
		const description = tool.description ?? "";
		// All five actions remain.
		expect(description).toContain("Actions: create");
		expect(description).toContain("patch");
		expect(description).toContain("list (bounded)");
		expect(description).toContain("get (id)");
		expect(description).toContain("remove (id");
		// Lifecycle semantics unchanged.
		const descriptionNormalized = description.replace(/\s+/g, " ");
		expect(descriptionNormalized).toContain("pending -> active -> completed");
		expect(descriptionNormalized).toContain("blocked (derived from unfinished dependencies, never settable)");
		expect(descriptionNormalized).toContain("cancelled; failed (child rows)");
		// Execution still flows through the manager.
		const created = (await tool.execute(
			"t1",
			{ action: "create", title: "meaningful unit" },
			undefined,
			undefined,
			{} as never,
		)) as {
			content: Array<{ text?: string }>;
			details: Record<string, unknown>;
		};
		expect(created.content[0]?.text).toContain("Added task");
		expect(created.details.id).toBeTruthy();
	});

	it("reaches the session system prompt through the guidelines wiring", () => {
		const tool = taskTool();
		const prompt = buildSystemPrompt({
			selectedTools: ["read", "tasks"],
			toolSnippets: { tasks: tool.promptSnippet! },
			promptGuidelines: [...(tool.promptGuidelines ?? [])],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});
		expect(prompt).toContain("- Use tasks selectively: work directly for one coherent deliverable");
		expect(prompt).not.toContain("3+ distinct steps");
	});
});
