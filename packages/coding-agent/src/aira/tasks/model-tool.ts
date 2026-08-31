/**
 * Aira tasks — model-facing `tasks` tool.
 *
 * A restrained task-graph surface for the model: create and patch ONE task
 * at a time (never full-list replacement), list with bounded projection,
 * get a single task, remove a manual task. Orchestration-derived rows are
 * immutable through this surface (owned by the Phase 9 manager). The
 * prompt guidance keeps usage bounded: tasks appear when work has 3+
 * distinct steps; the tool never injects the full graph into context.
 */
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import type { AiraTaskManagerHandle } from "./manager.ts";

const TASKS_PROMPT_SNIPPET = "Manage a compact task list for tracked multi-step work";

const TASKS_PROMPT_GUIDELINES = [
	"Use tasks when work has 3+ distinct steps, the user gives a task list, or progress must be tracked; skip single trivial steps.",
	"Patch ONE task at a time (create/patch by id); never rewrite the whole list. Mark a task active before starting it (one at a time) and completed only when actually done.",
	"A task with unfinished dependencies is blocked and cannot be activated; children delegated with agents_delegate appear automatically and are orchestration-owned (never patch them).",
] as const;

const TASKS_DESCRIPTION = `Track session tasks (one canonical task graph; Token-free projection).

Actions: create (title, optional dependsOn/note), patch (id, optional
status/title/dependsOn/note), list (bounded), get (id), remove (id —
manual tasks only).

Statuses: pending -> active -> completed; blocked (derived from unfinished
dependencies, never settable); cancelled; failed (child rows).

Agent-delegated tasks (agents_delegate children) appear automatically as
read-only rows and cannot be patched or removed. Use one task per distinct
work item; skip trivial steps or chat.`;

const tasksSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("create"),
			Type.Literal("patch"),
			Type.Literal("list"),
			Type.Literal("get"),
			Type.Literal("remove"),
		],
		{ description: "Task operation" },
	),
	title: Type.Optional(Type.String({ description: "Task title (create/patch)" })),
	id: Type.Optional(Type.String({ description: "Task id (patch/get/remove)" })),
	status: Type.Optional(
		Type.Union(
			[Type.Literal("pending"), Type.Literal("active"), Type.Literal("completed"), Type.Literal("cancelled")],
			{ description: "Target status (patch)" },
		),
	),
	dependsOn: Type.Optional(
		Type.Array(Type.String(), { description: "Task ids that must settle first (create/patch)" }),
	),
	note: Type.Optional(Type.String({ description: "Optional bounded note (create/patch)" })),
});

type TasksParams = Static<typeof tasksSchema>;

/** Create the `tasks` tool bound to a session's task manager. */
export function createAiraTaskToolDefinitions(options: {
	runtime: AiraTaskManagerHandle;
}): Record<string, ToolDefinition> {
	const { runtime } = options;
	return {
		tasks: {
			name: "tasks",
			label: "tasks",
			description: TASKS_DESCRIPTION,
			promptSnippet: TASKS_PROMPT_SNIPPET,
			promptGuidelines: [...TASKS_PROMPT_GUIDELINES],
			parameters: tasksSchema,
			async execute(_toolCallId, params: TasksParams) {
				return executeTasksAction(runtime, params);
			},
		},
	};
}

function executeTasksAction(runtime: AiraTaskManagerHandle, params: TasksParams) {
	switch (params.action) {
		case "create": {
			const result = runtime.create(params.title ?? "", {
				source: "model",
				dependsOn: params.dependsOn,
				note: params.note,
			});
			return result.ok
				? {
						content: [{ type: "text" as const, text: `Added task ${result.task.id}: ${result.task.title}` }],
						details: { id: result.task.id, status: result.task.status },
					}
				: {
						content: [{ type: "text" as const, text: `Error: ${result.message}` }],
						details: { error: result.message },
					};
		}
		case "patch": {
			if (!params.id) {
				return errorResult("patch requires an id");
			}
			const result = runtime.patch(params.id, {
				...(params.title !== undefined ? { title: params.title } : {}),
				...(params.status !== undefined ? { status: params.status } : {}),
				...(params.dependsOn !== undefined ? { dependsOn: params.dependsOn } : {}),
				...(params.note !== undefined ? { note: params.note } : {}),
			});
			return result.ok
				? {
						content: [
							{
								type: "text" as const,
								text: `Updated task ${result.task.id}: ${result.task.title} → ${result.task.status}`,
							},
						],
						details: { id: result.task.id, status: result.task.status },
					}
				: errorResult(result.message);
		}
		case "get": {
			if (!params.id) {
				return errorResult("get requires an id");
			}
			const task = runtime.get(params.id);
			if (!task) {
				return errorResult(`unknown task "${params.id}"`);
			}
			const lines = [`#${task.id} [${task.status}] ${task.title}`];
			if (task.dependsOn.length > 0) {
				lines.push(`depends on: ${task.dependsOn.join(", ")}`);
			}
			if (task.note) {
				lines.push(task.note);
			}
			if (task.detail) {
				lines.push(task.detail);
			}
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { id: task.id, status: task.status },
			};
		}
		case "remove": {
			if (!params.id) {
				return errorResult("remove requires an id");
			}
			const result = runtime.remove(params.id);
			return result.ok
				? { content: [{ type: "text" as const, text: `Removed task ${params.id}` }], details: { id: params.id } }
				: errorResult(result.message);
		}
		case "list": {
			const status = runtime.status();
			if (!status.enabled) {
				return {
					content: [{ type: "text" as const, text: "tasks are disabled (tasks.enabled=false)" }],
					details: { disabled: true },
				};
			}
			const lines = [`${status.summary} (${status.total} total)`];
			for (const row of status.rows) {
				const glyph =
					row.status === "completed"
						? "✓"
						: row.status === "active"
							? "◐"
							: row.status === "blocked"
								? "⊘"
								: row.status === "failed"
									? "✕"
									: row.status === "cancelled"
										? "–"
										: "○";
				const source = row.source === "child" ? ` [child${row.childRole ? `:${row.childRole}` : ""}]` : "";
				lines.push(`${glyph} ${row.id} ${row.title} [${row.status}]${source}`);
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { ...status } };
		}
	}
}

function errorResult(message: string) {
	return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: { error: message } };
}
