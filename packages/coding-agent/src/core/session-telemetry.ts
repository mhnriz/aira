import { stat } from "node:fs/promises";
import type { AgentEvent, ModelContextPayloadMeasurement } from "@earendil-works/pi-agent-core";
import type { AiraContextCompactionReport } from "../aira/context-compaction.ts";
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

/**
 * Stable machine-readable schema identifier for `SessionTelemetrySnapshot`.
 *
 * Versioning policy: additive, backward-compatible extensions to the snapshot
 * bump the minor version (1.0.0 → 1.1.0 → 1.2.0); renames/removals/semantic
 * changes bump the major version. The Step 2 context-payload block and the
 * Step 4 compaction block are additive.
 */
export const SESSION_TELEMETRY_SCHEMA_VERSION = "1.2.0";

/** Cap on retained per-request context summaries (bounded ring, newest first). */
export const CONTEXT_REQUEST_HISTORY_LIMIT = 10;

/** Usage block reuses the session's authoritative usage accounting. */
export interface SessionTelemetryUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

/**
 * One bounded per-request summary in the context history ring.
 * Numbers only: no prompt text, no message bodies, no tool contents.
 */
export interface ContextRequestSummary {
	/** Zero-based index of the request within the telemetry session. */
	requestIndex: number;
	totalBytes: number;
	systemBytes: number;
	conversationBytes: number;
	toolsBytes: number;
	messageCount: number;
	toolCount: number;
	conversation: {
		userBytes: number;
		assistantBytes: number;
		toolResultBytes: number;
	};
	/** Attributed contributor sizes for this request (custom message types only). */
	contributors: Array<{ key: string; bytes: number }>;
	/**
	 * Deterministic compaction accounting for this request, or null when the
	 * projection did not change. `preConversationBytes` is the compaction
	 * input projection size and `postConversationBytes` the returned
	 * projection size; both are measured on the model-visible message
	 * projection (role/content, plus tool identity for tool results).
	 */
	compaction: {
		preConversationBytes: number;
		postConversationBytes: number;
		savedBytes: number;
	} | null;
}

/**
 * Progressive context-compaction accounting (0.1.7 Step 4).
 *
 * Session-wide totals of the deterministic model-visible projection passes.
 * `originalConversationBytes` and `compactedConversationBytes` are summed over
 * PASSES THAT COMPACTED; non-triggering passes only move `passes`. Sizes are
 * the deterministic conversation projection described by
 * `packages/coding-agent/src/aira/context-compaction.ts`. No message content is
 * retained.
 */
export interface SessionTelemetryContextCompaction {
	/** Whether the compaction policy was enabled when the last pass ran. */
	enabled: boolean;
	/** Whether any pass has reduced old history in this session. */
	triggered: boolean;
	/** Number of projection passes observed (one per provider request). */
	passes: number;
	/** Number of passes that actually reduced old history. */
	events: number;
	/** Zero-based request index of the first compacting pass, or null. */
	firstTriggerRequestIndex: number | null;
	/** Summed pre-compaction conversation bytes over compacting passes. */
	originalConversationBytes: number;
	/** Summed post-compaction conversation bytes over compacting passes. */
	compactedConversationBytes: number;
	/** `originalConversationBytes - compactedConversationBytes`. */
	savedBytes: number;
	/** Total assistant messages whose prose/reasoning was reduced. */
	messagesCompacted: number;
	/** Total successful tool results whose payload was reduced. */
	toolResultsCompacted: number;
}

/** Size aggregation for one contributor identity. */
export interface SessionTelemetryContextContributor {
	totalBytes: number;
	latestBytes: number | null;
}

/**
 * Model-request payload composition (0.1.7 Step 2).
 *
 * Measured at the canonical request boundary (after context transformation
 * and provider-message conversion, immediately before dispatch). The size
 * unit is UTF-8 bytes of the deterministic JSON serialization described in
 * `measureModelContextPayload` (`packages/agent/src/context-payload.ts`):
 * the system prompt string, per-message `{ role, content }` projections
 * (plus tool-call identity for tool results), and per-tool
 * `{ name, description, parameters }` projections. Metadata only; the
 * payload text itself is never retained.
 */
export interface SessionTelemetryContext {
	requestCount: number;
	totalSerializedBytes: number;
	averageSerializedBytesPerRequest: number | null;
	minSerializedBytes: number | null;
	maxSerializedBytes: number | null;
	latestSerializedBytes: number | null;
	byTransport: {
		systemMessages: {
			totalBytes: number;
			latestBytes: number | null;
		};
		conversationMessages: {
			totalBytes: number;
			latestBytes: number | null;
			userBytes: number;
			assistantBytes: number;
			toolResultBytes: number;
		};
		toolDefinitions: {
			totalBytes: number;
			latestBytes: number | null;
			averageBytesPerRequest: number | null;
			toolCount: number;
			averageToolCountPerRequest: number | null;
		};
	};
	/**
	 * Attributed source buckets: custom message types only. Messages without a
	 * surviving source identity stay in the transport role buckets; this never
	 * fabricates a category.
	 */
	byContributor: Record<string, SessionTelemetryContextContributor>;
	/** Bounded per-request history ring (newest first). */
	recentRequests: ContextRequestSummary[];
	/** Progressive compaction accounting (0.1.7 Step 4). */
	compaction: SessionTelemetryContextCompaction;
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
	context: SessionTelemetryContext;
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
		/** One per edit/write tool invocation. */
		attempts: number;
		/** Invocations that ended successfully (including recovered ones). */
		successful: number;
		/** Failed exact-match attempts, including the pre-recovery miss of a recovered edit. */
		failed: number;
		/** Content-match conflicts (missing/ambiguous/EDIT_CONFLICT results). */
		conflicts: number;
		/** Automatic recovery retry, or a model retry after a failed edit to the same file. */
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
 * (core/tools/edit-diff.ts). These are the conflict classes: the oldText did not
 * match exactly anywhere, matched more than once, or failed a bounded recovery
 * so the tool returned a structured EDIT_CONFLICT result.
 */
const EDIT_CONFLICT_ERROR_PATTERNS = [
	/The oldText must match exactly including all whitespace and newlines/,
	/Each oldText must be unique/,
	/^EDIT_CONFLICT$/m,
] as const;

function isEditConflictError(message: string): boolean {
	return EDIT_CONFLICT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Whether a successful edit result reports that the initial exact attempt
 * missed and the tool re-anchored the region once (edit tool details.recovery).
 */
function toolResultRecoveredEdit(result: unknown): boolean {
	if (!result || typeof result !== "object") return false;
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return false;
	const recovery = (details as { recovery?: unknown }).recovery;
	return typeof recovery === "object" && recovery !== null;
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

	// Model requests
	private modelRequests = 0;

	// Context payload (Step 2) — bounded per-request history + aggregates.
	// The size unit is UTF-8 bytes of the deterministic request serialization
	// measured at the canonical request boundary; only metadata is retained.
	private contextRequestCount = 0;
	private contextTotalBytes = 0;
	private contextSystemBytes = 0;
	private contextConversationBytes = 0;
	private contextUserBytes = 0;
	private contextAssistantBytes = 0;
	private contextToolResultBytes = 0;
	private contextToolsBytes = 0;
	private contextToolCountSum = 0;
	private contextMinBytes: number | null = null;
	private contextMaxBytes: number | null = null;
	private contextLatestBytes: number | null = null;
	private contextLatestSystemBytes: number | null = null;
	private contextLatestConversationBytes: number | null = null;
	private contextLatestToolsBytes: number | null = null;
	private readonly contextContributorTotals = new Map<string, SessionTelemetryContextContributor>();
	private readonly contextRecentRequests: ContextRequestSummary[] = [];

	// Progressive context compaction (Step 4) — metadata only, no content.
	private compactionEnabled = false;
	private compactionTriggered = false;
	private compactionPasses = 0;
	private compactionEvents = 0;
	private compactionFirstTriggerRequestIndex: number | null = null;
	private compactionOriginalBytes = 0;
	private compactionCompactedBytes = 0;
	private compactionSavedBytes = 0;
	private compactionMessages = 0;
	private compactionToolResults = 0;
	/**
	 * Compaction accounting for the NEXT request. The transform projection runs
	 * immediately before the request it feeds, so the report is consumed by the
	 * following `observeModelRequestContext` and then cleared.
	 */
	private pendingCompaction: AiraContextCompactionReport | null = null;

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
		this.contextRecentRequests.length = 0;
		this.contextContributorTotals.clear();
	}

	private snapshotContext(): SessionTelemetryContext {
		const requestCount = this.contextRequestCount;
		const toolCount = this.contextRecentRequests[0]?.toolCount ?? 0;
		return {
			requestCount,
			totalSerializedBytes: this.contextTotalBytes,
			averageSerializedBytesPerRequest: requestCount === 0 ? null : this.contextTotalBytes / requestCount,
			minSerializedBytes: this.contextMinBytes,
			maxSerializedBytes: this.contextMaxBytes,
			latestSerializedBytes: this.contextLatestBytes,
			byTransport: {
				systemMessages: {
					totalBytes: this.contextSystemBytes,
					latestBytes: this.contextLatestSystemBytes,
				},
				conversationMessages: {
					totalBytes: this.contextConversationBytes,
					latestBytes: this.contextLatestConversationBytes,
					userBytes: this.contextUserBytes,
					assistantBytes: this.contextAssistantBytes,
					toolResultBytes: this.contextToolResultBytes,
				},
				toolDefinitions: {
					totalBytes: this.contextToolsBytes,
					latestBytes: this.contextLatestToolsBytes,
					averageBytesPerRequest: requestCount === 0 ? null : this.contextToolsBytes / requestCount,
					toolCount,
					averageToolCountPerRequest: requestCount === 0 ? null : this.contextToolCountSum / requestCount,
				},
			},
			byContributor: Object.fromEntries(
				[...this.contextContributorTotals.entries()].sort(([a], [b]) => a.localeCompare(b)),
			),
			recentRequests: [...this.contextRecentRequests],
			compaction: {
				enabled: this.compactionEnabled,
				triggered: this.compactionTriggered,
				passes: this.compactionPasses,
				events: this.compactionEvents,
				firstTriggerRequestIndex: this.compactionFirstTriggerRequestIndex,
				originalConversationBytes: this.compactionOriginalBytes,
				compactedConversationBytes: this.compactionCompactedBytes,
				savedBytes: this.compactionSavedBytes,
				messagesCompacted: this.compactionMessages,
				toolResultsCompacted: this.compactionToolResults,
			},
		};
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
					this.recordEditEnd(pending, event.isError, !event.isError && toolResultRecoveredEdit(event.result));
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

	private recordEditEnd(pending: PendingToolCall, isError: boolean, recovered: boolean): void {
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
			if (recovered) {
				// The initial exact attempt missed and the tool re-anchored once:
				// record the conflict and the automatic retry, then the final success.
				this.editFailures++;
				this.editConflicts++;
				this.editRetries++;
			} else if (previous?.failed) {
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
	 * Record one deterministic compaction projection pass (0.1.7 Step 4).
	 *
	 * Called once per provider request, immediately before the request the
	 * projection feeds. Stores counters only: byte totals and message counts.
	 * No discarded content, no placeholder text, no message bodies.
	 */
	observeContextCompaction(report: AiraContextCompactionReport): void {
		if (this.disposed) return;
		this.compactionEnabled = report.enabled;
		this.compactionPasses++;
		this.pendingCompaction = report;
		if (!report.triggered) return;
		this.compactionTriggered = true;
		this.compactionEvents++;
		if (this.compactionFirstTriggerRequestIndex === null) {
			// The pass belongs to the request that is about to be counted.
			this.compactionFirstTriggerRequestIndex = this.contextRequestCount;
		}
		this.compactionOriginalBytes += report.originalBytes;
		this.compactionCompactedBytes += report.compactedBytes;
		this.compactionSavedBytes += report.savedBytes;
		this.compactionMessages += report.messagesCompacted;
		this.compactionToolResults += report.toolResultsCompacted;
	}

	/**
	 * Record one model request's measured payload. Called exactly once per
	 * provider request from the canonical request boundary; the summary
	 * contains sizes and counts only. History is a bounded ring (newest
	 * first), so telemetry memory stays constant regardless of session length.
	 */
	observeModelRequestContext(measurement: ModelContextPayloadMeasurement): void {
		if (this.disposed) return;
		const pending = this.pendingCompaction;
		this.pendingCompaction = null;
		const summary: ContextRequestSummary = {
			requestIndex: this.contextRequestCount,
			totalBytes: measurement.totalBytes,
			systemBytes: measurement.systemBytes,
			conversationBytes: measurement.conversationBytes,
			toolsBytes: measurement.toolsBytes,
			messageCount: measurement.messageCount,
			toolCount: measurement.toolCount,
			conversation: { ...measurement.conversation },
			contributors: measurement.contributors.map((contributor) => ({
				key: contributor.key,
				bytes: contributor.bytes,
			})),
			compaction: pending?.triggered
				? {
						preConversationBytes: pending.originalBytes,
						postConversationBytes: pending.compactedBytes,
						savedBytes: pending.savedBytes,
					}
				: null,
		};
		this.contextRecentRequests.unshift(summary);
		if (this.contextRecentRequests.length > CONTEXT_REQUEST_HISTORY_LIMIT) {
			this.contextRecentRequests.pop();
		}

		this.contextRequestCount++;
		this.contextTotalBytes += measurement.totalBytes;
		this.contextSystemBytes += measurement.systemBytes;
		this.contextConversationBytes += measurement.conversationBytes;
		this.contextUserBytes += measurement.conversation.userBytes;
		this.contextAssistantBytes += measurement.conversation.assistantBytes;
		this.contextToolResultBytes += measurement.conversation.toolResultBytes;
		this.contextToolsBytes += measurement.toolsBytes;
		this.contextToolCountSum += measurement.toolCount;
		this.contextMinBytes =
			this.contextMinBytes === null
				? measurement.totalBytes
				: Math.min(this.contextMinBytes, measurement.totalBytes);
		this.contextMaxBytes =
			this.contextMaxBytes === null
				? measurement.totalBytes
				: Math.max(this.contextMaxBytes, measurement.totalBytes);
		this.contextLatestBytes = measurement.totalBytes;
		this.contextLatestSystemBytes = measurement.systemBytes;
		this.contextLatestConversationBytes = measurement.conversationBytes;
		this.contextLatestToolsBytes = measurement.toolsBytes;
		for (const contributor of measurement.contributors) {
			const entry = this.contextContributorTotals.get(contributor.key) ?? { totalBytes: 0, latestBytes: null };
			entry.totalBytes += contributor.bytes;
			entry.latestBytes = contributor.bytes;
			this.contextContributorTotals.set(contributor.key, entry);
		}
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
			context: this.snapshotContext(),
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
	const { usage, context, tools, repository, editing, validation, agent, timing } = snapshot;
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
	lines.push("Context payload");
	lines.push(`  requests           ${formatCount(context.requestCount)}`);
	lines.push(`  latest             ${formatPayloadBytes(context.latestSerializedBytes)}`);
	lines.push(`  avg                ${formatPayloadBytes(context.averageSerializedBytesPerRequest)}`);
	lines.push(`  peak               ${formatPayloadBytes(context.maxSerializedBytes)}`);
	lines.push(`  system             ${formatPayloadBytes(context.byTransport.systemMessages.latestBytes)} latest`);
	lines.push(
		`  conversation       ${formatPayloadBytes(context.byTransport.conversationMessages.latestBytes)} latest`,
	);
	lines.push(`  tools              ${formatPayloadBytes(context.byTransport.toolDefinitions.latestBytes)} latest`);
	lines.push("");
	lines.push("Context compaction");
	lines.push(`  enabled            ${context.compaction.enabled ? "yes" : "no"}`);
	lines.push(`  triggered          ${context.compaction.triggered ? "yes" : "no"}`);
	lines.push(`  passes             ${formatCount(context.compaction.passes)}`);
	lines.push(`  events             ${formatCount(context.compaction.events)}`);
	lines.push(`  saved              ${formatPayloadBytes(context.compaction.savedBytes)}`);
	lines.push(`  messages           ${formatCount(context.compaction.messagesCompacted)}`);
	lines.push(`  tool results       ${formatCount(context.compaction.toolResultsCompacted)}`);
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

function formatPayloadBytes(bytes: number | null): string {
	if (bytes === null) return "unavailable";
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${Math.round(kb)} KB`;
	return `${(kb / 1024).toFixed(1)} MB`;
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
