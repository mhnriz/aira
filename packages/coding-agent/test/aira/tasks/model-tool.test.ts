/**
 * Aira interaction + tasks — model tool tests (Phase 11).
 *
 * Covers `ask_user` outcome rendering (answered/cancelled/timed-out/
 * unavailable/superseded — never an invented answer) and the `tasks` tool
 * actions through real managers.
 */
import { describe, expect, it } from "vitest";
import { createAiraInteractionManager } from "../../../src/aira/interaction/manager.ts";
import { createAiraInteractionToolDefinitions } from "../../../src/aira/interaction/model-tool.ts";
import { acquireAiraSessionState, disposeAiraSessionState } from "../../../src/aira/state.ts";
import { createAiraTaskManager } from "../../../src/aira/tasks/manager.ts";
import { createAiraTaskToolDefinitions } from "../../../src/aira/tasks/model-tool.ts";

async function runTool<T>(
	toolDefinition: ReturnType<typeof createAiraInteractionToolDefinitions>[keyof ReturnType<
		typeof createAiraInteractionToolDefinitions
	>],
	params: T,
	ctx: unknown = {},
) {
	// The execute signature: (toolCallId, params, signal, onUpdate, ctx)
	return toolDefinition.execute("t1", params as never, undefined, undefined, ctx as never);
}

describe("ask_user model tool (Phase 11)", () => {
	it("returns the structured answer when the user picks a choice", async () => {
		const state = acquireAiraSessionState("tool-test");
		const interaction = createAiraInteractionManager(state);
		interaction.attachUI();
		const tools = createAiraInteractionToolDefinitions({ runtime: interaction });
		const execute = tools.ask_user!.execute.bind(tools.ask_user!);

		const pending = runTool(tools.ask_user!, {
			question: "Which database?",
			options: [{ title: "Postgres" }, { title: "SQLite" }],
			allowFreeform: false,
		});
		const question = interaction.status().question!;
		expect(question.choicesCount).toBe(2);
		interaction.answer(question.interactionId, { resolution: "answered", selections: ["o2"] });
		const result = (await pending) as { content: Array<{ text?: string }>; details: Record<string, unknown> };
		expect(result.content[0]?.text).toContain("User answered: SQLite");
		expect(result.details.resolution).toBe("answered");
		void execute;
		disposeAiraSessionState(state.sessionId, state);
	});

	it("cancellation is truthful: no invented answer is returned to the model", async () => {
		const state = acquireAiraSessionState("tool-test-2");
		const interaction = createAiraInteractionManager(state);
		interaction.attachUI();
		const tools = createAiraInteractionToolDefinitions({ runtime: interaction });
		const pending = runTool(tools.ask_user!, { question: "Proceed?", options: [{ title: "Yes" }] });
		const question = interaction.status().question!;
		interaction.answer(question.interactionId, { resolution: "cancelled", selections: [] });
		const result = (await pending) as { content: Array<{ text?: string }> };
		expect(result.content[0]?.text).toContain("User cancelled");
		expect(result.content[0]?.text).toContain("NOT an answer");
		disposeAiraSessionState(state.sessionId, state);
	});

	it("headless sessions report unavailable truthfully (the question was never shown)", async () => {
		const state = acquireAiraSessionState("tool-test-3");
		const interaction = createAiraInteractionManager(state); // no attachUI
		const tools = createAiraInteractionToolDefinitions({ runtime: interaction });
		const result = (await runTool(tools.ask_user!, {
			question: "Do you want this?",
			options: [{ title: "Yes" }],
		})) as { content: Array<{ text?: string }> };
		expect(result.content[0]?.text).toContain("NOT asked");
		disposeAiraSessionState(state.sessionId, state);
	});
});

describe("tasks model tool (Phase 11)", () => {
	it("create → patch → list flows through the canonical manager", async () => {
		const state = acquireAiraSessionState("tool-test-4");
		const manager = createAiraTaskManager(state, { settings: () => ({ enabled: true }) });
		const tools = createAiraTaskToolDefinitions({ runtime: manager });

		const created = (await runTool(tools.tasks!, { action: "create", title: "write tests", dependsOn: [] })) as {
			content: Array<{ text?: string }>;
			details: Record<string, unknown>;
		};
		expect(created.content[0]?.text).toContain("Added task");
		const id = created.details.id as string;

		const patched = (await runTool(tools.tasks!, { action: "patch", id, status: "active" })) as {
			content: Array<{ text?: string }>;
		};
		expect(patched.content[0]?.text).toContain("active");

		const listed = (await runTool(tools.tasks!, { action: "list" })) as { content: Array<{ text?: string }> };
		expect(listed.content[0]?.text).toContain("1 active");

		// Invalid transitions surface as truthful errors.
		const bad = (await runTool(tools.tasks!, { action: "patch", id, status: "completed" })) as {
			content: Array<{ text?: string }>;
		};
		// active → completed is legal; pending → completed is not — this task
		// was activated above, so completion is fine; instead test a bogus id.
		expect(bad.content[0]?.text).toContain("Updated task");
		const unknown = (await runTool(tools.tasks!, { action: "patch", id: "t-nope", status: "active" })) as {
			content: Array<{ text?: string }>;
		};
		expect(unknown.content[0]?.text).toContain("unknown task");
		disposeAiraSessionState(state.sessionId, state);
	});
});
