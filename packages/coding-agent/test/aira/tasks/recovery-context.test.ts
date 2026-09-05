import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createAiraTaskPersistence } from "../../../src/aira/tasks/persistence.ts";
import { AIRA_TASK_RECOVERY_HINT } from "../../../src/aira/tasks/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness } from "../../suite/harness.ts";

async function executeTasksTool(
	harness: Awaited<ReturnType<typeof createHarness>>,
	params: Record<string, unknown>,
): Promise<unknown> {
	const tool = harness.session.getToolDefinition("tasks");
	if (!tool) throw new Error("tasks tool is not registered");
	return tool.execute("recovery-test", params as never, undefined, undefined, undefined as never);
}

function persistedStatuses(path: string): string[] {
	const persisted = JSON.parse(readFileSync(path, "utf8")) as { tasks: Array<{ status: string }> };
	return persisted.tasks.map((task) => task.status);
}

describe("Aira task recovery context", () => {
	it("atomically normalizes recovery and gives the next model turn a one-shot hint", async () => {
		const root = mkdtempSync(join(tmpdir(), "aira-task-recovery-context-"));
		const taskPath = createAiraTaskPersistence("task-recovery-context", "startup", { baseDir: root }).path;
		const first = await createHarness({
			sessionManager: SessionManager.inMemory(root, { id: "task-recovery-context" }),
			airaTaskOptions: {
				persistence: createAiraTaskPersistence("task-recovery-context", "startup", { baseDir: root }),
			},
		});
		try {
			const created = (await executeTasksTool(first, { action: "create", title: "resume interrupted task" })) as {
				details: { id: string };
			};
			const taskId = created.details.id;
			await executeTasksTool(first, { action: "patch", id: taskId, status: "active" });
			expect(persistedStatuses(taskPath)).toEqual(["active"]);
		} finally {
			first.cleanup();
		}

		const second = await createHarness({
			sessionManager: SessionManager.inMemory(root, { id: "task-recovery-context" }),
			sessionStartEvent: { type: "session_start", reason: "resume" },
			airaTaskOptions: {
				persistence: createAiraTaskPersistence("task-recovery-context", "resume", { baseDir: root }),
			},
		});
		try {
			const task = second.session.airaTasks?.list()[0];
			expect(task?.status).toBe("pending");
			expect(persistedStatuses(taskPath)).toEqual(["pending"]);

			second.setResponses([
				fauxAssistantMessage(fauxToolCall("tasks", { action: "patch", id: task!.id, status: "active" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("tasks", { action: "patch", id: task!.id, status: "completed" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxText("continued and completed")),
			]);
			await second.session.prompt("continue the interrupted task");

			expect(second.session.systemPrompt).toContain(
				`<aira-task-recovery>${AIRA_TASK_RECOVERY_HINT}</aira-task-recovery>`,
			);
			expect(second.session.airaTasks?.get(task!.id)?.status).toBe("completed");
			expect(persistedStatuses(taskPath)).toEqual(["completed"]);
			expect(second.session.airaTasks?.consumeRecoveryHint?.()).toBeUndefined();
		} finally {
			second.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
