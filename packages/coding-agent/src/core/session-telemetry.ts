import { stat } from "node:fs/promises";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { resolveReadPathAsync, resolveToCwd } from "./tools/path-utils.ts";

/**
 * Session telemetry — local, passive observability for the current session.
 *
 * This collector records FACTS about a session's engineering behavior
 * (counts, durations, per-tool/per-path metadata). It makes no judgment
 * about whether those facts are good or bad, and it never changes agent
 * behavior: no prompt contributions, no model calls, no settings.
 *
 * Storage is session-local and in-memory: nothing is persisted, uploaded,
 * or aggregated across sessions. Prompt contents, source contents, and
 * secrets are never captured — only counters and lightweight metadata
 * (tool names, resolved paths, file identity, durations).
 */

/** Stable machine-readable schema identifier for `SessionTelemetrySnapshot`. */
export const SESSION_TELEMETRY_SCHEMA_VERSION = "1.0.0";

/** Usage block reuses the session's authoritative usage accounting. */
export interface SessionTelemetryUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

/**
 * Machine-readable telemetry snapshot.
 *
 * Field names are stable within `schemaVersion`. Unavailable values are
 * `null`; zero is only used for values that are measured and truthfully zero.
 */
export interface SessionTelemetrySnapshot {
	schemaVersion: string;
	usage: SessionTelemetryUsage & { modelRequests: number };
	tools: {
		total: number;
		failed: number;
		cancelled: number;
		byName: Record<string, number>;
	};
	repository: {
		reads: number;
		uniqueFilesRead: number;
		repeatedUnchangedReads: number;
		searches: number;
	};
	editing: {
		attempts: number;
		successful: number;
		failed: number;
		conflicts: number;
		retries: number;
	};
	validation: {
		tests: number;
		builds: number;
		checks: number;
		verifications: number;
	};
	agent: {
		askUser: number;
		childAgents: number;
		taskTransitions: number;
		taskTransitionsByType: Record<string, number>;
	};
	timing: {
		elapsedMs: number;
		timeToFirstToolMs: number | null;
		timeToFirstRepositoryReadMs: number | null;
		timeToFirstEditMs: number | null;
	};
}

/** Options for the collector clock (tests inject a fake clock). */
export interface SessionTelemetryOptions {
	/** Monotonic clock in milliseconds. Defaults to `performance.now()`. */
	now?: () => number;
}

const READ_TOOL_NAMES = new Set(["read"]);
const SEARCH_TOOL_NAMES = new Set(["grep", "find"]);
const EDIT_TOOL_NAMES = new Set(["edit", "write"]);
const REPOSITORY_TOOL_NAMES = new Set([...READ_TOOL_NAMES, ...SEARCH_TOOL_NAMES]);

/**
 * Error messages produced by the edit tool's exact-match machinery
 * (core/tools/edit-diff.ts). These are the two conflict classes: the
 * oldText did not match exactly anywhere, or matched more than once.
 */
const EDIT_CONFLICT_ERROR_PATTERNS = [
	/The oldText must match exactly including all whitespace and newlines/,
	/Each oldText must be unique/,
] as const;

function isEditConflictError(message: string): boolean {
	return EDIT_CONFLICT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/** Extract the plain text of a tool result content for error classification. */
export function toolResultErrorText(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text?: string } => {
			return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text";
		})
		.map((part) => part.text ?? "")
		.join("");
}

/** The agent loop produces this exact error text for aborted tool executions. */
const ABORTED_TOOL_ERROR_TEXT = "Operation aborted";

interface PendingToolCall {
	name: string;
	path?: string;
	resolvedPath?: string;
	startedAtMs: number;
}

interface ReadIdentity {
	mtimeMs: number;
	size: number;
	mutationSeq: number;
}

/**
 * Session-local telemetry collector.
 *
 * Threading/ownership: one collector per `AgentSession` instance. A fresh
 * session (startup, /new, /resume, /fork, /clone, /import) owns a fresh
 * collector, so telemetry follows the runtime's session lifecycle exactly:
 * replacing the session replaces the collector. Nothing is retained across
 * sessions.
 */
export class SessionTelemetry {
	private readonly now: () => number;
	private readonly startTimeMs: number;

	private toolCalls = 0;
	private toolFailures = 0;
	private toolCancellations = 0;
	private readonly toolCounts = new Map<string, number>();

	// Repository activity
	private reads = 0;
	private readonly uniqueFilesRead = new Set<string>();
	private repeatedUnchangedReads = 0;
	private searches = 0;
	private readonly readIdentities = new Map<string, ReadIdentity>();
	private readonly fileMutationSeqs = new Map<string, number>();

	// Editing
	private editAttempts = 0;
	private editSuccesses = 0;
	private editFailures = 0;
	private editConflicts = 0;
	private editRetries = 0;
	private readonly lastEditOutcome = new Map<string, { tool: string; failed: boolean }>();

	// Validation (process_start tool `purpose` metadata + verifier runs)
	private testInvocations = 0;
	private buildInvocations = 0;
	private checkInvocations = 0;
	private verificationRuns = 0;

	// Agent behavior
	private askUserInvocations = 0;
	private childAgents = 0;
	private readonly seenChildRunIds = new Set<string>();
	private taskTransitions = 0;
	private readonly taskTransitionsByType = new Map<string, number>();
	private readonly taskStatusById = new Map<string, string>();
	private verificationState: string | null = null;

	// Timing
	private timeToFirstToolMs: number | null = null;
	private timeToFirstRepositoryReadMs: number | null = null;
	private timeToFirstEditMs: number | null = null;

	private modelRequests = 0;

	// In-flight tool calls (parallel batches: end events arrive per toolCallId).
	private readonly pendingToolCalls = new Map<string, PendingToolCall>();

	private disposed = false;

	constructor(options?: SessionTelemetryOptions) {
		this.now = options?.now ?? (() => performance.now());
		this.startTimeMs = this.now();
	}

	get startedAtMs(): number {
		return this.startTimeMs;
	}

	dispose(): void {
		this.disposed = true;
		this.pendingToolCalls.clear();
	}

	private elapsedMs(): number {
		return Math.max(0, this.now() - this.startTimeMs);
	}

	private recordFirstToolAt(nowMs: number): void {
		if (this.timeToFirstToolMs === null) {
			this.timeToFirstToolMs = Math.max(0, nowMs - this.startTimeMs);
		}
	}

	private recordFirstRepositoryReadAt(nowMs: number): void {
		if (this.timeToFirstRepositoryReadMs === null) {
			this.timeToFirstRepositoryReadMs = Math.max(0, nowMs - this.startTimeMs);
		}
	}

	private recordFirstEditAt(nowMs: number): void {
		if (this.timeToFirstEditMs === null) {
			this.timeToFirstEditMs = Math.max(0, nowMs - this.startTimeMs);
		}
	}

	private static argumentPath(args: unknown): string | undefined {
		if (!args || typeof args !== "object") return undefined;
		const record = args as Record<string, unknown>;
		const path = record.path ?? record.file_path;
		return typeof path === "string" && path.length > 0 ? path : undefined;
	}

	private static argumentPurpose(args: unknown): string | undefined {
		if (!args || typeof args !== "object") return undefined;
		const purpose = (args as Record<string, unknown>).purpose;
		return typeof purpose === "string" ? purpose : undefined;
	}

	/**
	 * Record one agent event. The collector only observes; it never returns
	 * values that influence the agent. Async only for the one stat per `read`
	 * tool invocation (documented repeated-read semantics below).
	 */
	async onAgentEvent(event: AgentEvent, cwd: string): Promise<void> {
		if (this.disposed) return;
		switch (event.type) {
			case "tool_execution_start": {
				const nowMs = this.now();
				this.toolCalls++;
				this.toolCounts.set(event.toolName, (this.toolCounts.get(event.toolName) ?? 0) + 1);
				this.recordFirstToolAt(nowMs);
				if (event.toolName === "ask_user") {
					this.askUserInvocations++;
				}
				if (REPOSITORY_TOOL_NAMES.has(event.toolName)) {
					this.recordFirstRepositoryReadAt(nowMs);
				}
				if (event.toolName === "read") {
					await this.recordReadStart(event.toolCallId, event.args, cwd, nowMs);
				} else {
					this.pendingToolCalls.set(event.toolCallId, { name: event.toolName, startedAtMs: nowMs });
				}
				if (SEARCH_TOOL_NAMES.has(event.toolName)) {
					this.searches++;
				}
				if (EDIT_TOOL_NAMES.has(event.toolName)) {
					this.recordEditStart(event.toolCallId, event.toolName, event.args, cwd, nowMs);
				}
				if (event.toolName === "process_start") {
					this.recordValidationPurpose(SessionTelemetry.argumentPurpose(event.args));
				}
				return;
			}
			case "tool_execution_end": {
				const pending = this.pendingToolCalls.get(event.toolCallId);
				this.pendingToolCalls.delete(event.toolCallId);
				if (!pending) return;
				if (event.isError) {
					this.toolFailures++;
					const errorText = toolResultErrorText(event.result);
					if (errorText === ABORTED_TOOL_ERROR_TEXT) {
						this.toolCancellations++;
					} else if (pending.name === "edit" && isEditConflictError(errorText)) {
						this.editConflicts++;
					}
				}
				if (EDIT_TOOL_NAMES.has(pending.name)) {
					this.recordEditEnd(pending, event.isError);
				}
				return;
			}
			case "turn_end": {
				this.modelRequests++;
				return;
			}
			default:
				return;
		}
	}

	private async recordReadStart(toolCallId: string, args: unknown, cwd: string, nowMs: number): Promise<void> {
		const rawPath = SessionTelemetry.argumentPath(args);
		if (rawPath === undefined) {
			this.pendingToolCalls.set(toolCallId, { name: "read", startedAtMs: nowMs });
			return;
		}
		// Invocations are counted as facts of model behavior (a read attempt),
		// including failed and policy-blocked ones. File identity is only
		// recorded when a stat succeeds, so failed reads never classify as
		// unchanged repeated reads.
		this.reads++;
		this.pendingToolCalls.set(toolCallId, { name: "read", path: rawPath, startedAtMs: nowMs });

		let resolvedPath: string | undefined;
		try {
			resolvedPath = await resolveReadPathAsync(rawPath, cwd);
		} catch {
			return;
		}
		let fileStats: Awaited<ReturnType<typeof stat>> | undefined;
		try {
			fileStats = await stat(resolvedPath);
		} catch {
			return;
		}
		if (!fileStats.isFile()) return;

		const mutationSeq = this.fileMutationSeqs.get(resolvedPath) ?? 0;
		const previous = this.readIdentities.get(resolvedPath);
		if (
			previous &&
			previous.mtimeMs === fileStats.mtimeMs &&
			previous.size === fileStats.size &&
			previous.mutationSeq === mutationSeq
		) {
			this.repeatedUnchangedReads++;
		}
		this.readIdentities.set(resolvedPath, {
			mtimeMs: fileStats.mtimeMs,
			size: fileStats.size,
			mutationSeq,
		});
		this.uniqueFilesRead.add(resolvedPath);
	}

	private recordEditStart(toolCallId: string, name: string, args: unknown, cwd: string, nowMs: number): void {
		this.editAttempts++;
		this.recordFirstEditAt(nowMs);
		const rawPath = SessionTelemetry.argumentPath(args);
		let resolvedPath: string | undefined;
		if (rawPath !== undefined) {
			try {
				resolvedPath = resolveToCwd(rawPath, cwd);
			} catch {
				resolvedPath = undefined;
			}
		}
		this.pendingToolCalls.set(toolCallId, { name, path: rawPath, resolvedPath, startedAtMs: nowMs });
	}

	private recordEditEnd(pending: PendingToolCall, isError: boolean): void {
		if (!pending.resolvedPath) return;
		const outcomeKey = `${pending.name}\u0000${pending.resolvedPath}`;
		const previous = this.lastEditOutcome.get(outcomeKey);
		if (isError) {
			this.editFailures++;
			if (previous?.failed) {
				this.editRetries++;
			}
			this.lastEditOutcome.set(outcomeKey, { tool: pending.name, failed: true });
		} else {
			this.editSuccesses++;
			this.fileMutationSeqs.set(pending.resolvedPath, (this.fileMutationSeqs.get(pending.resolvedPath) ?? 0) + 1);
			if (previous?.failed) {
				this.editRetries++;
			}
			this.lastEditOutcome.set(outcomeKey, { tool: pending.name, failed: false });
		}
	}

	private recordValidationPurpose(purpose: string | undefined): void {
		// The process_start tool's `purpose` parameter is authoritative tool
		// metadata (AiraProcessPurpose), not natural-language classification.
		switch (purpose) {
			case "test":
				this.testInvocations++;
				break;
			case "build":
				this.buildInvocations++;
				break;
			case "check":
				this.checkInvocations++;
				break;
			default:
				break;
		}
	}

	/**
	 * Diff a full task snapshot (id -> status) against the previous one and
	 * count every changed task status as one transition.
	 */
	observeTaskStatuses(rows: ReadonlyArray<{ id: string; status: string }>): void {
		for (const row of rows) {
			const previous = this.taskStatusById.get(row.id);
			if (previous === undefined) {
				this.taskStatusById.set(row.id, row.status);
				continue;
			}
			if (previous !== row.status) {
				this.taskTransitions++;
				const key = `${previous}->${row.status}`;
				this.taskTransitionsByType.set(key, (this.taskTransitionsByType.get(key) ?? 0) + 1);
				this.taskStatusById.set(row.id, row.status);
			}
		}
	}

	/** Count a child run the first time its run id is observed. */
	observeChildRunId(runId: string): void {
		if (this.seenChildRunIds.has(runId)) return;
		this.seenChildRunIds.add(runId);
		this.childAgents++;
	}

	/**
	 * Observe a verification snapshot state; a transition into "preparing" or
	 * "running" from another state starts one verifier invocation.
	 */
	observeVerificationState(state: string): void {
		const previous = this.verificationState;
		this.verificationState = state;
		if (
			previous !== null &&
			previous !== "preparing" &&
			previous !== "running" &&
			(state === "preparing" || state === "running")
		) {
			this.verificationRuns++;
		}
	}

	/**
	 * Build the machine-readable snapshot. `usage` comes from the session's
	 * authoritative usage accounting (AgentSession.getSessionStats), so the
	 * collector never estimates tokens.
	 */
	snapshot(usage: SessionTelemetryUsage): SessionTelemetrySnapshot {
		return {
			schemaVersion: SESSION_TELEMETRY_SCHEMA_VERSION,
			usage: {
				...usage,
				modelRequests: this.modelRequests,
			},
			tools: {
				total: this.toolCalls,
				failed: this.toolFailures,
				cancelled: this.toolCancellations,
				byName: Object.fromEntries([...this.toolCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
			},
			repository: {
				reads: this.reads,
				uniqueFilesRead: this.uniqueFilesRead.size,
				repeatedUnchangedReads: this.repeatedUnchangedReads,
				searches: this.searches,
			},
			editing: {
				attempts: this.editAttempts,
				successful: this.editSuccesses,
				failed: this.editFailures,
				conflicts: this.editConflicts,
				retries: this.editRetries,
			},
			validation: {
				tests: this.testInvocations,
				builds: this.buildInvocations,
				checks: this.checkInvocations,
				verifications: this.verificationRuns,
			},
			agent: {
				askUser: this.askUserInvocations,
				childAgents: this.childAgents,
				taskTransitions: this.taskTransitions,
				taskTransitionsByType: Object.fromEntries(
					[...this.taskTransitionsByType.entries()].sort(([a], [b]) => a.localeCompare(b)),
				),
			},
			timing: {
				elapsedMs: this.elapsedMs(),
				timeToFirstToolMs: this.timeToFirstToolMs,
				timeToFirstRepositoryReadMs: this.timeToFirstRepositoryReadMs,
				timeToFirstEditMs: this.timeToFirstEditMs,
			},
		};
	}
}

function formatCount(value: number): string {
	return value.toLocaleString("en-US");
}

/** Compact human-readable rendering for /telemetry (no theme dependency). */
export function renderSessionTelemetryText(snapshot: SessionTelemetrySnapshot): string {
	const { usage, tools, repository, editing, validation, agent, timing } = snapshot;
	const lines: string[] = [];
	lines.push("Session Telemetry");
	lines.push("");
	lines.push("Usage");
	lines.push(`  input tokens       ${formatCount(usage.inputTokens)}`);
	lines.push(`  output tokens      ${formatCount(usage.outputTokens)}`);
	if (usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0) {
		lines.push(
			`  cached tokens      ${formatCount(usage.cacheReadTokens)} (${formatCount(usage.cacheWriteTokens)} written)`,
		);
	}
	lines.push(`  cost               $${usage.costUsd.toFixed(4)}`);
	lines.push(`  model requests     ${formatCount(usage.modelRequests)}`);
	lines.push("");
	lines.push("Tools");
	lines.push(`  calls              ${formatCount(tools.total)}`);
	if (tools.failed > 0) {
		lines.push(`  failed             ${formatCount(tools.failed)}`);
	}
	if (tools.cancelled > 0) {
		lines.push(`  cancelled          ${formatCount(tools.cancelled)}`);
	}
	lines.push("");
	lines.push("Repository");
	lines.push(`  reads              ${formatCount(repository.reads)}`);
	lines.push(`  unique files       ${formatCount(repository.uniqueFilesRead)}`);
	lines.push(`  repeated reads     ${formatCount(repository.repeatedUnchangedReads)}`);
	lines.push(`  searches           ${formatCount(repository.searches)}`);
	lines.push("");
	lines.push("Editing");
	lines.push(`  attempts           ${formatCount(editing.attempts)}`);
	lines.push(`  successful         ${formatCount(editing.successful)}`);
	lines.push(`  failed             ${formatCount(editing.failed)}`);
	lines.push(`  conflicts          ${formatCount(editing.conflicts)}`);
	lines.push(`  retries            ${formatCount(editing.retries)}`);
	lines.push("");
	lines.push("Validation");
	lines.push(`  tests              ${formatCount(validation.tests)}`);
	lines.push(`  builds             ${formatCount(validation.builds)}`);
	lines.push(`  checks             ${formatCount(validation.checks)}`);
	lines.push(`  verifications      ${formatCount(validation.verifications)}`);
	lines.push("");
	lines.push("Agent");
	lines.push(`  ask_user           ${formatCount(agent.askUser)}`);
	lines.push(`  child agents       ${formatCount(agent.childAgents)}`);
	lines.push(`  task transitions   ${formatCount(agent.taskTransitions)}`);
	lines.push("");
	lines.push("Timing");
	lines.push(`  first tool         ${formatDuration(timing.timeToFirstToolMs)}`);
	lines.push(`  first repository   ${formatDuration(timing.timeToFirstRepositoryReadMs)}`);
	lines.push(`  first edit         ${formatDuration(timing.timeToFirstEditMs)}`);
	lines.push(`  elapsed            ${formatDuration(timing.elapsedMs)}`);
	return lines.join("\n");
}

function formatDuration(ms: number | null): string {
	if (ms === null) return "unavailable";
	if (ms < 1000) return `${ms.toFixed(0)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Pretty JSON rendering for `/telemetry --json` and RPC output. */
export function renderSessionTelemetryJson(snapshot: SessionTelemetrySnapshot): string {
	return JSON.stringify(snapshot, null, 2);
}
