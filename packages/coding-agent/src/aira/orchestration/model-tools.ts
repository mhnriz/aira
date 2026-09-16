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
	requiredCapabilities: Type.Optional(
		Type.Array(Type.Union([Type.Literal("process"), Type.Literal("mutation"), Type.Literal("browser")]), {
			description: "Explicit capabilities required by the task; incompatible roles are rejected before model spend.",
		}),
	),
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

/**
 * One bounded line for a settled child failure. The category comes first so the
 * parent cannot read a capability/environment failure as failed engineering
 * work; the concrete component/operation/code and whether the task was actually
 * attempted follow. No stack traces, no provider payloads.
 */
function renderFailureLine(
	taskId: string,
	role: string,
	failure: {
		kind: string;
		category: string;
		message: string;
		component?: string;
		operation?: string;
		code?: string;
		taskStatus?: string;
		retryableHint?: string;
	},
): string {
	const evidence = [
		failure.component ? `component ${failure.component}` : undefined,
		failure.operation ? `operation ${failure.operation}` : undefined,
		failure.code ? `code ${failure.code}` : undefined,
		failure.taskStatus ? `task_status ${failure.taskStatus}` : undefined,
		failure.retryableHint && failure.retryableHint !== "unknown" ? `retryable ${failure.retryableHint}` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	const recommendation = childFailureRecommendation(failure.kind);
	const head = `- ${taskId} (${role}): CHILD_${failure.kind.toUpperCase()} [${failure.category}] — ${failure.message}`;
	return `${head}\n  ${evidence}${evidence.length > 0 ? " · " : ""}recommendation: ${recommendation}`;
}

/** Concise parent reaction for each failure kind (no automatic retries). */
function childFailureRecommendation(kind: string): string {
	switch (kind) {
		case "task_failure":
			return "use the returned evidence to revise the work";
		case "capability_failure":
			return "diagnose the capability or continue directly; do not rebuild it from primitives";
		case "environment_failure":
			return "inspect or fix the environment where appropriate";
		case "timeout":
			return "retry with a narrower scope or continue directly";
		case "cancelled":
			return "respect the cancellation";
		default:
			return "inspect the evidence before deciding";
	}
}

/**
 * Parent-facing bound for the child result projection.
 *
 * Children are required by their envelope to emit summary/findings/
 * relevantFiles/tests/errors, but only the summary reached the parent model:
 * the structured fields stayed in UI-only `details` (packages/ai never reads
 * `details`, so it is never provider-visible). These bounds project the
 * already-produced fields into the parent tool result deterministically. They
 * are the parent-consumer bound, stricter than the child's own emission bound
 * (runner.ts MAX_CHILD_*), derived from the observed distribution of real child
 * results (findings max 8, relevantFiles max 12, tests max 5, errors max 1).
 * `evidence` is deliberately not projected: it is a path/line index whose
 * non-redundant content duplicates the file:line refs already carried by
 * findings and relevantFiles.
 */
const AIRA_CHILD_RESULT_MAX_FINDINGS = 8;
const AIRA_CHILD_RESULT_MAX_FILES = 12;
const AIRA_CHILD_RESULT_MAX_TESTS = 6;
const AIRA_CHILD_RESULT_MAX_ERRORS = 4;
const AIRA_CHILD_RESULT_PROSE_CHARS = 240;
const AIRA_CHILD_RESULT_PATH_CHARS = 160;

/** Structural view of the child result envelope fields the parent consumes. */
type AiraChildResultProjection = {
	status?: string;
	summary?: string;
	findings?: string[];
	relevantFiles?: string[];
	changedFiles?: string[];
	tests?: string[];
	errors?: string[];
};

function clipChildResultItem(value: string, limit: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}\u2026`;
}

/** Deterministic, field-priority projection of a child's structured result. */
function renderChildResultProjection(result: AiraChildResultProjection): string[] {
	const sections = [
		{
			label: "errors",
			items: result.errors,
			limit: AIRA_CHILD_RESULT_MAX_ERRORS,
			chars: AIRA_CHILD_RESULT_PROSE_CHARS,
		},
		{
			label: "findings",
			items: result.findings,
			limit: AIRA_CHILD_RESULT_MAX_FINDINGS,
			chars: AIRA_CHILD_RESULT_PROSE_CHARS,
		},
		{
			label: "files",
			items: result.relevantFiles,
			limit: AIRA_CHILD_RESULT_MAX_FILES,
			chars: AIRA_CHILD_RESULT_PATH_CHARS,
		},
		{
			label: "validation",
			items: result.tests,
			limit: AIRA_CHILD_RESULT_MAX_TESTS,
			chars: AIRA_CHILD_RESULT_PATH_CHARS,
		},
	];
	const lines: string[] = [];
	for (const section of sections) {
		const items = (section.items ?? [])
			.filter((item) => typeof item === "string" && item.trim().length > 0)
			.map((item) => clipChildResultItem(item, section.chars));
		if (items.length === 0) continue;
		lines.push(`  ${section.label}:`);
		for (const item of items.slice(0, section.limit)) lines.push(`    - ${item}`);
		const hidden = items.length - section.limit;
		if (hidden > 0) lines.push(`    … +${hidden} more (full result in UI details)`);
	}
	return lines;
}

/** Returns the projection only when the payload carries real structured content. */
function asChildResultProjection(value: unknown): AiraChildResultProjection | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as AiraChildResultProjection;
	for (const items of [candidate.errors, candidate.findings, candidate.relevantFiles, candidate.tests]) {
		if (Array.isArray(items) && items.some((item) => typeof item === "string" && item.trim().length > 0)) {
			return candidate;
		}
	}
	return undefined;
}

function renderRunLine(task: {
	taskId: string;
	role: string;
	runId?: string;
	accepted: boolean;
	reason?: string;
	result?: unknown;
	failure?: {
		kind: string;
		category: string;
		message: string;
		component?: string;
		operation?: string;
		code?: string;
		taskStatus?: string;
		retryableHint?: string;
	};
}): string {
	if (!task.accepted) {
		return `- ${task.taskId} (${task.role}): REFUSED — ${task.reason ?? "rejected"}`;
	}
	if (task.runId === undefined) {
		return `- ${task.taskId} (${task.role}): accepted`;
	}
	if (task.failure) {
		const failureLine = renderFailureLine(task.taskId, task.role, task.failure);
		// Step 8 classification stays authoritative; when the failure preserved the
		// child's structured result, return that evidence too instead of only the
		// recommendation that tells the parent to use it.
		const preserved = asChildResultProjection(task.result);
		if (preserved === undefined) return failureLine;
		const preservedLines = renderChildResultProjection(preserved);
		return preservedLines.length > 0 ? `${failureLine}\n${preservedLines.join("\n")}` : failureLine;
	}
	if (task.result === undefined) {
		return `- ${task.taskId} (${task.role}): run ${task.runId}`;
	}
	if (typeof task.result === "string") {
		return `- ${task.taskId} (${task.role}): ${task.result}`;
	}
	const result = task.result as AiraChildResultProjection;
	const changed =
		result.changedFiles && result.changedFiles.length > 0 ? ` · changed: ${result.changedFiles.join(", ")}` : "";
	const head = `- ${task.taskId} (${task.role}): ${result.status ?? "settled"}: ${result.summary ?? "no summary"}${changed}`;
	const detail = renderChildResultProjection(result);
	return detail.length > 0 ? `${head}\n${detail.join("\n")}` : head;
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
			const budget =
				child.toolBudgetUsed !== undefined && child.toolBudgetLimit !== undefined
					? ` · tools ${child.toolBudgetUsed}/${child.toolBudgetLimit}${child.toolBudgetExtensions ? ` · +${child.toolBudgetExtensions} ext` : ""}`
					: "";
			lines.push(
				`- ${child.taskId} [${child.role}] ${child.status}${child.phase !== "settled" ? ` (${child.phase})` : ""}${model}${elapsed}${budget}`,
			);
		}
	}
	if (status.failures.length > 0) {
		lines.push(`failures:`);
		for (const failure of status.failures) {
			const evidence = [failure.component, failure.operation, failure.code]
				.filter((part): part is string => part !== undefined)
				.join("/");
			const suffix = evidence.length > 0 ? ` (${evidence})` : "";
			const attempted =
				failure.taskStatus === "not_attempted"
					? " · task not attempted"
					: failure.taskStatus === "attempted"
						? " · task attempted"
						: "";
			lines.push(`- ${failure.taskId}: ${failure.kind}${suffix} — ${failure.message}${attempted}`);
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
			"Dispatch bounded work to isolated child agents. Each child receives ONLY its explicit envelope (task, role, files, context, mode) plus a capability-derived tool set — never the parent conversation. Roles: explore/research/review are read-only; test runs managed tests/checks; implement makes workspace changes. Declare requiredCapabilities when the task needs process execution, mutation, or browser interaction; incompatible roles are rejected before provider spend. Dependencies are task ids in this batch. PLAN remains read-only. Children cannot spawn children.",
		promptSnippet: "Delegate bounded work to isolated child agents",
		promptGuidelines: [
			"Keep task text self-contained: children do not see the conversation. Use dependencies only when ordering matters and prefer parallel dispatch.",
			"Prefer await=false for long work, then poll agents_status. Do not delegate trivial tasks; children consume model tokens. Declare requiredCapabilities for execution or mutation work.",
			"Read settled child results by failure kind: task_failure means the child ran and the evidence should revise the work; capability_failure/environment_failure mean the child mechanism could not run, so diagnose or continue directly instead of rewriting the failed capability with ad-hoc primitives.",
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
		toolBudgetUsed?: number;
		toolBudgetLimit?: number;
		toolBudgetExtensions?: number;
	}>;
	failures: Array<{
		taskId: string;
		kind: string;
		category: string;
		message: string;
		component?: string;
		operation?: string;
		code?: string;
		taskStatus?: string;
		retryableHint?: string;
	}>;
};
