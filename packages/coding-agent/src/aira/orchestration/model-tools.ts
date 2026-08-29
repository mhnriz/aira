/**
 * Aira orchestration — model-facing delegation tools.
 *
 * Three restrained native tools expose orchestration to the model:
 *
 * - agents_delegate  dispatch a bounded batch of child tasks (parallel or
 *                    dependency-ordered; await or background);
 * - agents_status    inspect the bounded orchestration snapshot (read-only);
 * - agents_cancel    cancel one child or all active orchestration.
 *
 * Capability semantics: all three classify as `orchestration` (ADR-022
 * vocabulary extension, Phase 9). Host-level PLAN policy does not block the
 * class — the orchestration scheduler IS the enforcement point: PLAN children
 * only receive read-only/diagnostic tool sets and mutation-capable roles are
 * refused at dispatch (documented + tested; see orchestration/manager.ts).
 *
 * A child never receives these tools: delegation is root-only.
 */
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import type { AiraOrchestrationHandle } from "./manager.ts";
import { AIRA_CHILD_ROLES } from "./roles.ts";
import type { AiraChildTaskSpec } from "./types.ts";

const ROLE_LITERALS = AIRA_CHILD_ROLES.map((role) => Type.Literal(role.role));

const childTaskSchema = Type.Object({
	id: Type.Optional(
		Type.String({ description: "Optional task id used for dependency edges (unique within the batch)." }),
	),
	role: Type.Union(ROLE_LITERALS, {
		description:
			"Lightweight role: explore (read-only mapping), research (read-only analysis), review (independent inspection), test (run tests/checks), implement (bounded workspace changes).",
	}),
	task: Type.String({ description: "Bounded task objective (<= 4000 chars). The child receives ONLY this envelope." }),
	dependencies: Type.Optional(
		Type.Array(Type.String(), { description: "Task ids in this batch that must complete first." }),
	),
	files: Type.Optional(Type.Array(Type.String(), { description: "Relevant file paths to start from (bounded)." })),
	context: Type.Optional(
		Type.String({ description: "Optional bounded context/evidence for the child (<= 8000 chars)." }),
	),
	model: Type.Optional(
		Type.String({ description: 'Explicit model "provider/model"; inherits the session model when absent.' }),
	),
	timeoutMs: Type.Optional(Type.Number({ description: "Per-task timeout in milliseconds (default from settings)." })),
});

const delegateSchema = Type.Object({
	tasks: Type.Array(childTaskSchema, {
		description: "Child tasks to dispatch (max 8). Dependencies are task ids within this same batch.",
	}),
	await: Type.Optional(
		Type.Boolean({
			description:
				"true (default): wait until every child settles and return their structured results. false: return immediately with run ids; poll agents_status / cancel with agents_cancel.",
		}),
	),
});

const statusSchema = Type.Object({});

const cancelSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Run id to cancel; omit to cancel all active orchestration." })),
});

export type AgentsDelegateInput = Static<typeof delegateSchema>;

/** The slice of the orchestration manager the tools need. */
export interface AiraOrchestrationToolRuntime {
	schedule(
		specs: AiraChildTaskSpec[],
		options?: { awaitResults?: boolean },
	): ReturnType<AiraOrchestrationHandle["schedule"]>;
	status(): ReturnType<AiraOrchestrationHandle["status"]>;
	cancel(runId?: string, reason?: string): ReturnType<AiraOrchestrationHandle["cancel"]>;
}

function renderRunLine(task: {
	taskId: string;
	role: string;
	runId?: string;
	accepted: boolean;
	reason?: string;
	result?: unknown;
}): string {
	if (!task.accepted) {
		return `- ${task.taskId} (${task.role}): REFUSED — ${task.reason ?? "rejected"}`;
	}
	if (task.runId === undefined) {
		return `- ${task.taskId} (${task.role}): accepted`;
	}
	if (task.result === undefined) {
		return `- ${task.taskId} (${task.role}): run ${task.runId}`;
	}
	if (typeof task.result === "string") {
		return `- ${task.taskId} (${task.role}): ${task.result}`;
	}
	const result = task.result as { status?: string; summary?: string; changedFiles?: string[]; errors?: string[] };
	const changed =
		result.changedFiles && result.changedFiles.length > 0 ? ` · changed: ${result.changedFiles.join(", ")}` : "";
	return `- ${task.taskId} (${task.role}): ${result.status ?? "settled"}: ${result.summary ?? "no summary"}${changed}`;
}

function renderStatus(status: AiraOrchestrationStatusSnapshot): string {
	const lines = [
		`orchestration: ${status.enabled ? `enabled · ${status.summary}` : "disabled"}`,
		`concurrency: ${status.runningCount}/${status.maxConcurrency} running · ${status.queuedCount} queued`,
	];
	if (status.children.length > 0) {
		lines.push(`children:`);
		for (const child of status.children) {
			const model = child.model ? ` · model ${child.model}` : "";
			const elapsed = child.elapsedMs !== undefined ? ` · ${formatChildDuration(child.elapsedMs)}` : "";
			lines.push(
				`- ${child.taskId} [${child.role}] ${child.status}${child.phase !== "settled" ? ` (${child.phase})` : ""}${model}${elapsed}`,
			);
		}
	}
	if (status.failures.length > 0) {
		lines.push(`failures:`);
		for (const failure of status.failures) {
			lines.push(`- ${failure.taskId}: ${failure.category} — ${failure.message}`);
		}
	}
	return lines.join("\n");
}

function formatChildDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

export function createAiraOrchestrationToolDefinitions(options: {
	runtime: AiraOrchestrationToolRuntime;
}): Record<string, ToolDefinition> {
	const { runtime } = options;
	const delegateTool: ToolDefinition<typeof delegateSchema, unknown, undefined> = {
		name: "agents_delegate",
		label: "agents delegate",
		description:
			"Dispatch bounded work to isolated child agents. Each child receives ONLY its explicit envelope (task, role, files, context, mode) plus a capability-derived tool set — never the parent conversation. Roles: explore/research/review are read-only; test runs managed tests/checks; implement makes workspace changes. Dependencies are task ids within the same batch (A → B ordering; cycles are rejected). PLAN mode refuses implement/test. Children cannot spawn children. Use for parallelizable or delegable work; for trivial tasks just do them yourself.",
		promptSnippet: "Delegate bounded work to isolated child agents",
		promptGuidelines: [
			"Keep task text bounded (<= 4000 chars) and self-contained: children do not see the conversation.",
			"Use dependencies only when ordering matters; prefer parallel dispatch otherwise.",
			"Prefer await=false for long work, then poll agents_status; await=true blocks until settlement (bounded by per-child timeouts).",
			"Do not delegate trivial tasks; children consume model tokens.",
		],
		parameters: delegateSchema,
		async execute(_toolCallId, params) {
			const result = await runtime.schedule(params.tasks, { awaitResults: params.await ?? true });
			const lines = [
				result.ok
					? `dispatched ${result.tasks.length} task(s)`
					: `dispatch refused: ${result.tasks[0]?.reason ?? "invalid"}`,
				...result.tasks.map(renderRunLine),
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { ok: result.ok, batchId: result.batchId, tasks: result.tasks },
			};
		},
	};

	const statusTool: ToolDefinition<typeof statusSchema, unknown, undefined> = {
		name: "agents_status",
		label: "agents status",
		description:
			"Inspect the bounded orchestration snapshot: running/queued children, roles, models, elapsed time, settled results, and failures. Token-free; never blocks.",
		promptSnippet: "Inspect active children and orchestration state",
		parameters: statusSchema,
		async execute() {
			const status = runtime.status();
			return {
				content: [{ type: "text", text: renderStatus(status) }],
				details: { status },
			};
		},
	};

	const cancelTool: ToolDefinition<typeof cancelSchema, unknown, undefined> = {
		name: "agents_cancel",
		label: "agents cancel",
		description:
			"Cancel one child run (by run id) or all active orchestration when no id is given. Cancellation propagates into the child's model stream; settled children stay settled.",
		promptSnippet: "Cancel a child run or all active orchestration",
		parameters: cancelSchema,
		async execute(_toolCallId, params) {
			runtime.cancel(
				params.id ?? undefined,
				params.id ? "cancelled by user" : "all orchestration cancelled by user",
			);
			return {
				content: [
					{
						type: "text",
						text: params.id ? `cancelling run ${params.id}` : "cancelling all active orchestration",
					},
				],
				details: { cancelled: params.id ?? "all" },
			};
		},
	};

	return {
		agents_delegate: delegateTool,
		agents_status: statusTool,
		agents_cancel: cancelTool,
	};
}

/** Typed projection used by renderStatus (keeps tool definitions decoupled). */
type AiraOrchestrationStatusSnapshot = {
	enabled: boolean;
	summary: string;
	runningCount: number;
	queuedCount: number;
	maxConcurrency: number;
	children: Array<{
		taskId: string;
		role: string;
		status: string;
		phase: string;
		model?: string;
		elapsedMs?: number;
	}>;
	failures: Array<{ taskId: string; category: string; message: string }>;
};
