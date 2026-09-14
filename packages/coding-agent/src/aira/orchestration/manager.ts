/**
 * Aira orchestration — per-session manager.
 *
 * The single canonical owner of orchestration for a session (ADR-024
 * ownership pattern, mirroring execution/browser/verification): validates
 * dispatch requests, applies the mode gate (PLAN: read-only roles only),
 * resolves each child's model (inherit / default / explicit — degrading
 * truthfully, never silently substituting), builds the bounded envelope and
 * mode-gated tool set, runs children through the scheduler, records bounded
 * telemetry, and publishes the canonical `state.orchestration` snapshot.
 *
 * Isolation contract: children receive ONLY their envelope + tool set. They
 * never receive the parent conversation, orchestration tools (root-only
 * delegation — a child cannot spawn children), browser tools, or
 * unknown/extension tools.
 *
 * The Phase 8 verifier stays independent: orchestration consumes verifier
 * evidence but never controls verdicts; the verifier is not a teammate.
 */
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AiraIntelligenceHandle } from "../intelligence/coordinator.ts";
import type { AiraSessionState } from "../state.ts";
import {
	boundChildList,
	boundChildText,
	buildAiraChildEnvelope,
	MAX_CHILD_CONTEXT_CHARS,
	MAX_CHILD_FILES,
	MAX_CHILD_TASK_CHARS,
} from "./envelope.ts";
import { type AiraChildEvent, AiraChildEventBuffer, childActivityOf } from "./events.ts";
import { buildAiraChildFailure, classifyAiraChildFailure, toAiraFailureEvidence } from "./failures.ts";
import { airaChildRoleOf, isAiraChildRoleReadOnly } from "./roles.ts";
import { type AiraChildOutcome, type AiraChildRuntime, runAiraChild } from "./runner.ts";
import {
	type AiraSchedulerRunTask,
	MAX_CHILD_TASKS_PER_BATCH,
	prepareAiraSchedule,
	runAiraScheduler,
} from "./scheduler.ts";
import type { AiraOrchestrationSettings } from "./settings.ts";
import {
	aggregateAiraTokenUsage,
	initialAiraOrchestrationStatus,
	MAX_CHILDREN_IN_SNAPSHOT,
	MAX_FAILURES_IN_SNAPSHOT,
	MAX_RESULTS_IN_SNAPSHOT,
	toAiraChildFailure,
	toAiraChildResultSummary,
	toAiraChildSnapshot,
} from "./status.ts";
import { type AiraChildToolSetOptions, buildAiraChildToolSet } from "./tools.ts";
import type {
	AiraChildFailureCategory,
	AiraChildFailureInfo,
	AiraChildResult,
	AiraChildRun,
	AiraChildRunStatus,
	AiraChildTaskSpec,
	AiraOrchestrationBatchResult,
	AiraOrchestrationStatus,
} from "./types.ts";

export interface AiraOrchestrationManagerOptions {
	/** Session working directory (child tool root). */
	cwd: string;
	/** Canonical settings accessor (live — changes take effect immediately). */
	settings: () => AiraOrchestrationSettings;
	/**
	 * Child model runtime resolver: "inherit" (session model), "default"
	 * (configured default model), or an explicit "provider/model" selector.
	 * Returns the runtime + truthful resolved identity, or `{ unavailable }`
	 * when the requested model cannot be used (never silently substituted).
	 */
	resolveRuntime?: (request: {
		model?: string;
		settings: AiraOrchestrationSettings;
	}) => Promise<{ runtime: AiraChildRuntime; resolvedModel: string } | { unavailable: string } | undefined>;
	/** Execution manager for process-class children (Phase 6 runtime reuse). */
	executionManager?: AiraChildToolSetOptions["executionManager"];
	/** Root intelligence coordinator shared by eligible children. */
	intelligence?: AiraIntelligenceHandle;
	/**
	 * Phase 11 permission seam: root-owned deterministic child tool gate
	 * (children never prompt; ask→deny upstream). Undefined = ungated
	 * (tests / hosts without the permission controller).
	 */
	permissionGate?: (
		toolName: string,
		args: Record<string, unknown>,
	) => { block: boolean; reason?: string } | undefined;
	/** Host callback for successful child workspace mutations. */
	workspaceMutation?: (path: string) => void;
	/** Runner seam (unit tests inject canned outcomes). */
	runner?: (
		runtime: AiraChildRuntime,
		options: {
			cwd: string;
			prompt: string;
			systemPrompt: string;
			tools: AgentTool[];
			timeoutMs: number;
			maxToolRounds: number;
			/** Live event sink (Agent Inspector); the real runner emits through it. */
			events?: (event: AiraChildEvent) => void;
			workspaceMutation?: (path: string) => void;
		},
		signal?: AbortSignal,
	) => Promise<AiraChildOutcome>;
	/** Max children per batch (tests may lower it). */
	maxTasksPerBatch?: number;
}

export interface AiraOrchestrationHandle {
	/**
	 * Dispatch a batch of child tasks. `awaitResults` waits until every run
	 * settles (bounded by per-child timeouts) and returns settled results;
	 * otherwise returns immediately with run ids (background delegation).
	 */
	schedule(specs: AiraChildTaskSpec[], options?: { awaitResults?: boolean }): Promise<AiraOrchestrationBatchResult>;
	/** Cancel one run, or all active orchestration when no id is given. */
	cancel(runId?: string, reason?: string): AiraOrchestrationBatchResult;
	/** Live run records (bounded history, most recent first). */
	list(): readonly AiraChildRun[];
	get(runId: string): AiraChildRun | undefined;
	/** Canonical snapshot (token-free). */
	status(): AiraOrchestrationStatus;
	/**
	 * Bounded event transcript for one run (read-only query; Agent Inspector).
	 * Returns an empty list for unknown/disposed runs (never throws).
	 */
	events(runId: string): readonly AiraChildEvent[];
	/**
	 * Live per-run event subscription (Agent Inspector tail). The listener
	 * receives ONE bounded event per model block/tool outcome; the buffer is
	 * already updated before the listener runs. Returns a no-op unsubscribe
	 * for unknown/disposed runs. One subscription per viewing UI.
	 */
	subscribeEvents(runId: string, listener: (event: AiraChildEvent) => void): () => void;
	subscribe(listener: (status: AiraOrchestrationStatus) => void): () => void;
	dispose(): Promise<void>;
}

/** Bounded history of completed runs kept in the manager (snapshots cap further). */
const MAX_MANAGER_RUN_HISTORY = 64;
const MAX_CHILD_TIMEOUT_MS = 900_000;
const MIN_CHILD_TIMEOUT_MS = 5_000;

export class AiraOrchestrationManager implements AiraOrchestrationHandle {
	private readonly state: AiraSessionState;
	private readonly options: AiraOrchestrationManagerOptions;
	private readonly runs = new Map<string, AiraChildRun>();
	private readonly runAborts = new Map<string, AbortController>();
	/** Per-run bounded event transcripts (Agent Inspector; orchestration-owned). */
	private readonly buffers = new Map<string, AiraChildEventBuffer>();
	private readonly eventListeners = new Map<string, Set<(event: AiraChildEvent) => void>>();
	private readonly listeners = new Set<(status: AiraOrchestrationStatus) => void>();
	private readonly activeBatches = new Set<AbortController>();
	private snapshot: AiraOrchestrationStatus;
	private epochStartedAt: number | undefined;
	private disposed = false;

	constructor(state: AiraSessionState, options: AiraOrchestrationManagerOptions) {
		this.state = state;
		this.options = options;
		this.snapshot = initialAiraOrchestrationStatus(options.settings().enabled, options.settings().maxParallel);
	}

	/** Publish the canonical snapshot (never throws; session startup safety). */
	activate(): void {
		if (this.disposed) {
			return;
		}
		this.publish();
	}

	schedule(
		specs: AiraChildTaskSpec[],
		options: { awaitResults?: boolean } = {},
	): Promise<AiraOrchestrationBatchResult> {
		if (this.disposed) {
			return Promise.resolve(this.refusedBatch(specs, "session disposed"));
		}
		const settings = this.options.settings();
		if (!settings.enabled) {
			return Promise.resolve(this.refusedBatch(specs, "orchestration is disabled (orchestration.enabled=false)"));
		}
		if (this.state.runtime !== "active") {
			return Promise.resolve(this.refusedBatch(specs, "session not active"));
		}
		if (specs.length === 0) {
			return Promise.resolve({ ok: true, tasks: [] });
		}
		if (specs.length > (this.options.maxTasksPerBatch ?? MAX_CHILD_TASKS_PER_BATCH)) {
			return Promise.resolve(
				this.refusedBatch(
					specs,
					`too many tasks: ${specs.length} exceeds the maximum of ${MAX_CHILD_TASKS_PER_BATCH}`,
				),
			);
		}

		// ---- mode gate (PLAN is genuinely read-only; no child loophole) ----
		// Mutation-capable roles are refused per-task; read-only roles in the
		// same batch still dispatch with mode-collapsed tool sets.
		const mode = this.state.mode;
		const gatedReasons = new Map<AiraChildTaskSpec, string>();
		const acceptedSpecs: AiraChildTaskSpec[] = [];
		for (const spec of specs) {
			const preflightReason = preflightChildTask(spec, mode);
			if (preflightReason) {
				gatedReasons.set(spec, preflightReason);
			} else {
				acceptedSpecs.push(spec);
			}
		}
		if (acceptedSpecs.length === 0) {
			return Promise.resolve({
				ok: false,
				tasks: specs.map((spec) => ({
					taskId: spec.id ?? spec.role,
					role: spec.role,
					accepted: false,
					reason: gatedReasons.get(spec) ?? `role ${spec.role} is refused in PLAN (read-only enforcement)`,
				})),
			});
		}

		// ---- normalize + validate the batch graph (accepted tasks only) ----
		const prepared = prepareAiraSchedule(
			acceptedSpecs.map((spec) => ({
				taskId: spec.id && spec.id.trim().length > 0 ? spec.id.trim() : generatedTaskId(spec.role),
				dependencies: [...(spec.dependencies ?? [])],
			})),
			() => randomUUID(),
		);
		if (!Array.isArray(prepared)) {
			return Promise.resolve(this.rejectionBatch(specs, prepared, gatedReasons));
		}

		// ---- create run records (one canonical store) ----
		const batchAbort = new AbortController();
		this.activeBatches.add(batchAbort);
		this.epochStartedAt ??= Date.now();
		for (let index = 0; index < prepared.length; index += 1) {
			const spec = acceptedSpecs[index]!;
			const sched = prepared[index]!;
			const run: AiraChildRun = {
				id: sched.runId,
				taskId: sched.taskId,
				createdAt: Date.now(),
				role: spec.role,
				task: boundChildText(spec.task, MAX_CHILD_TASK_CHARS),
				dependencies: sched.dependencies,
				status: "pending",
				phase: sched.dependencies.length > 0 ? "waiting-dependency" : "waiting-capacity",
				model: spec.model ?? settings.model,
				toolBudgetLimit: airaChildRoleOf(spec.role)?.toolBudget ?? 32,
			};
			this.recordRun(run);
		}
		this.publish();

		const batchId = `b-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
		const batch = runAiraScheduler(prepared, {
			maxConcurrency: settings.maxParallel,
			signal: batchAbort.signal,
			execute: (sched) =>
				this.executeRun(sched, acceptedSpecs[indexOfRun(prepared, sched.runId)]!, settings, batchAbort.signal),
			events: {
				onStarted: (task) => {
					const run = this.runs.get(task.runId);
					if (run) {
						run.status = "running";
						run.phase = "running";
						run.startedAt ??= Date.now();
						this.recordChildEvent(run.id, {
							kind: "status",
							at: Date.now(),
							status: run.status,
							phase: run.phase,
						});
						this.publish();
					}
				},
				onSkipped: (task, reason) => {
					const run = this.runs.get(task.runId);
					if (run && run.status === "pending") {
						run.status = "rejected";
						run.phase = "settled";
						run.completedAt = Date.now();
						run.durationMs = (run.completedAt ?? 0) - (run.startedAt ?? run.completedAt ?? 0);
						// Pre-execution outcomes: cancellation, or an upstream delegated task
						// failing. Neither means this task itself ran and failed.
						const cancelled = batchAbort.signal.aborted;
						const message = cancelled ? "cancelled before launch" : `upstream dependency failed: ${reason}`;
						const failure = cancelled
							? classifyAiraChildFailure({
									cancelled: true,
									message,
									component: "orchestration",
									operation: "cancel",
								})
							: buildAiraChildFailure({
									kind: "task_failure",
									category: "dependency-failed",
									message,
									component: "orchestration",
									operation: "dependency",
									taskStatus: "not_attempted",
								});
						run.error = failure;
						this.recordChildEvent(run.id, {
							kind: "failure",
							at: run.completedAt,
							category: failure.category,
							message: failure.message,
						});
						this.publish();
					}
				},
			},
		});

		const taskOutcomes = (withResults: boolean): AiraOrchestrationBatchResult["tasks"] => [
			...specs
				.filter((spec) => gatedReasons.has(spec))
				.map((spec) => ({
					taskId: spec.id ?? spec.role,
					role: spec.role,
					accepted: false as const,
					reason: gatedReasons.get(spec),
				})),
			...prepared.map((sched) => {
				const run = this.runs.get(sched.runId);
				const base = {
					taskId: sched.taskId,
					role: run?.role ?? "explore",
					runId: sched.runId,
					accepted: true as const,
				};
				if (!withResults || !run) {
					return base;
				}
				const failure = run.status === "completed" ? undefined : toAiraChildFailure(run);
				return {
					...base,
					// A failed run that still produced a child report keeps that report as
					// evidence (conclusion, files, tests); otherwise the settled status is
					// all that remains. Either way the classification above tells the parent
					// whether the work failed or the capability could not run.
					result: run.result ?? run.status,
					...(failure ? { failure } : {}),
				};
			}),
		];

		if (!options.awaitResults) {
			void batch.finally(() => {
				this.activeBatches.delete(batchAbort);
				this.epochEnd();
			});
			return Promise.resolve({ ok: true, batchId, tasks: taskOutcomes(false) });
		}

		return batch.then(() => {
			this.activeBatches.delete(batchAbort);
			this.epochEnd();
			return { ok: true, batchId, tasks: taskOutcomes(true) };
		});
	}

	/** Execute one run: model resolution, envelope, tool set, runner, telemetry. */
	private async executeRun(
		sched: AiraSchedulerRunTask,
		spec: AiraChildTaskSpec,
		settings: AiraOrchestrationSettings,
		batchSignal: AbortSignal,
	): Promise<"completed" | "failed"> {
		const run = this.runs.get(sched.runId);
		if (!run) {
			return "failed";
		}
		const abort = new AbortController();
		this.runAborts.set(run.id, abort);
		const signal = typeof AbortSignal.any === "function" ? AbortSignal.any([batchSignal, abort.signal]) : batchSignal;
		run.startedAt ??= Date.now();
		run.status = "running";
		run.phase = "running";
		this.recordChildEvent(run.id, { kind: "status", at: Date.now(), status: run.status, phase: run.phase });
		this.publish();

		try {
			// ---- model resolution (truthful degradation, never substitution) ----
			const resolved = await this.options.resolveRuntime?.({ model: spec.model, settings });
			if (!resolved || !("runtime" in resolved)) {
				// Pre-execution capability seam: no usable child model was resolved.
				// The delegated work was not attempted; never report task failure.
				const message = signal.aborted
					? "cancelled"
					: !resolved || !("unavailable" in resolved)
						? "child model unavailable"
						: resolved.unavailable;
				const failure = signal.aborted
					? classifyAiraChildFailure({
							cancelled: true,
							message,
							component: "child-model",
							operation: "resolve",
						})
					: buildAiraChildFailure({
							kind: "capability_failure",
							category: "model-unavailable",
							message,
							component: "child-model",
							operation: "resolve",
							taskStatus: "not_attempted",
						});
				this.failRun(run, failure);
				return "failed";
			}
			run.resolvedModel = resolved.resolvedModel;
			this.publish();

			// ---- bounded envelope + mode-gated tool set ----
			const toolSet = buildAiraChildToolSet({
				cwd: this.options.cwd,
				role: spec.role,
				mode: this.state.mode,
				executionManager: this.options.executionManager,
				intelligence: this.options.intelligence,
			});
			if (toolSet.capabilityGaps.length > 0) {
				run.capabilityGaps = toolSet.capabilityGaps;
			}
			const envelope = buildAiraChildEnvelope({
				role: spec.role,
				task: spec.task,
				mode: this.state.mode,
				projectRoot: this.options.cwd,
				project: this.state.project,
				files: boundChildList(spec.files ?? [], MAX_CHILD_FILES, 200),
				context: boundChildText(spec.context ?? "", MAX_CHILD_CONTEXT_CHARS),
				mutatingAllowed: toolSet.mutating,
				modelLabel: run.resolvedModel,
			});

			// ---- run (timeout bound; cancellation propagates into the stream) ----
			const timeoutMs = clampChildTimeout(spec.timeoutMs ?? settings.timeoutMs, settings.timeoutMs);
			const runnerOptions = {
				cwd: this.options.cwd,
				prompt: envelope.prompt,
				systemPrompt: envelope.systemPrompt,
				tools: toolSet.tools,
				gateTool: this.options.permissionGate,
				timeoutMs,
				maxToolRounds: Math.ceil((airaChildRoleOf(spec.role)?.toolBudget ?? 32) / 4),
				// Agent Inspector capture: stream/tool events are recorded per run.
				events: (event: AiraChildEvent) => this.recordChildEvent(run.id, event),
				workspaceMutation: this.options.workspaceMutation,
			};
			const outcome: AiraChildOutcome = this.options.runner
				? await this.options.runner(resolved.runtime, runnerOptions, signal)
				: await runAiraChild(resolved.runtime, runnerOptions, signal);

			if (outcome.toolCallsUsed !== undefined) run.toolBudgetUsed = outcome.toolCallsUsed;
			if (outcome.toolBudgetLimit !== undefined) run.toolBudgetLimit = outcome.toolBudgetLimit;
			if (outcome.toolBudgetExtensions !== undefined) run.toolBudgetExtensions = outcome.toolBudgetExtensions;
			if (!outcome.ok) {
				this.failRun(run, this.failureOf(run, outcome, signal));
				return "failed";
			}
			run.tokenUsage = outcome.tokenUsage;
			const completed = outcome.result.status === "completed";
			// The child ran and returned a result: an unmet acceptance criterion is a
			// real task failure, not an infrastructure problem.
			const resultFailure = completed
				? undefined
				: buildAiraChildFailure({
						kind: "task_failure",
						category: "driver",
						message: outcome.result.summary,
						component: "child-run",
						operation: "acceptance",
						taskStatus: "attempted",
					});
			this.settleRun(
				run,
				completed ? "completed" : "failed",
				resultFailure,
				completed ? undefined : outcome.result.summary,
				outcome.result,
			);
			return completed ? "completed" : "failed";
		} catch (error) {
			const evidence = toAiraFailureEvidence(error, "child run failed");
			this.failRun(
				run,
				signal.aborted
					? classifyAiraChildFailure({
							cancelled: true,
							message: "cancelled",
							component: "orchestration",
							operation: "cancel",
						})
					: classifyAiraChildFailure({
							...evidence,
							origin: evidence.origin ?? "capability",
							component: evidence.component ?? "orchestration",
							operation: evidence.operation ?? "execute",
						}),
			);
			return "failed";
		} finally {
			this.runAborts.delete(run.id);
		}
	}

	cancel(runId?: string, reason = "cancelled by user"): AiraOrchestrationBatchResult {
		if (runId) {
			this.runAborts.get(runId)?.abort(new Error(reason));
			return { ok: true, tasks: [] };
		}
		for (const abort of this.runAborts.values()) {
			abort.abort(new Error(reason));
		}
		for (const batch of this.activeBatches) {
			batch.abort(new Error(reason));
		}
		return { ok: true, tasks: [] };
	}

	list(): readonly AiraChildRun[] {
		return this.recentRuns();
	}

	get(runId: string): AiraChildRun | undefined {
		return this.runs.get(runId);
	}

	events(runId: string): readonly AiraChildEvent[] {
		return this.buffers.get(runId)?.events() ?? [];
	}

	subscribeEvents(runId: string, listener: (event: AiraChildEvent) => void): () => void {
		const listeners = this.eventListeners.get(runId);
		if (!listeners) {
			// Unknown or disposed run: stale ids degrade safely (no-op).
			return () => undefined;
		}
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}

	status(): AiraOrchestrationStatus {
		this.publish();
		return this.snapshot;
	}

	subscribe(listener: (status: AiraOrchestrationStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const abort of this.runAborts.values()) {
			abort.abort(new Error("session disposed"));
		}
		for (const batch of this.activeBatches) {
			batch.abort(new Error("session disposed"));
		}
		this.activeBatches.clear();
		this.runAborts.clear();
		this.listeners.clear();
		this.buffers.clear();
		this.eventListeners.clear();
		this.publish();
	}

	// -----------------------------------------------------------------------
	// internal bookkeeping
	// -----------------------------------------------------------------------

	private recordRun(run: AiraChildRun): void {
		this.runs.set(run.id, run);
		this.buffers.set(run.id, new AiraChildEventBuffer());
		this.eventListeners.set(run.id, new Set());
		this.recordChildEvent(run.id, {
			kind: "status",
			at: Date.now(),
			status: run.status,
			phase: run.phase,
		});
		if (this.runs.size <= MAX_MANAGER_RUN_HISTORY) {
			return;
		}
		// Bounded history: evict the oldest SETTLED run first. Pending/running
		// runs sort LAST (the just-created run must never be evicted): a naive
		// "settledAt ?? 0" sorts the brand-new run first and the history would
		// never evict under sequential awaited dispatches (growth bug, fixed).
		const candidates = [...this.runs.values()].sort((a, b) => {
			const settledA = a.phase === "settled" ? (a.completedAt ?? 0) : Number.MAX_SAFE_INTEGER;
			const settledB = b.phase === "settled" ? (b.completedAt ?? 0) : Number.MAX_SAFE_INTEGER;
			return settledA - settledB;
		});
		const evict = candidates[0];
		if (evict && evict !== run) {
			this.runs.delete(evict.id);
			this.runAborts.delete(evict.id);
			this.buffers.delete(evict.id);
			this.eventListeners.delete(evict.id);
		}
	}

	/**
	 * Record one child event into the run's bounded buffer, derive truthful
	 * last-activity, and notify the run's live subscribers. Deliberately does
	 * NOT publish the canonical snapshot: streaming events must never cause
	 * whole-Workbench rerender storms (publish stays on status transitions).
	 */
	private recordChildEvent(runId: string, event: AiraChildEvent): void {
		const buffer = this.buffers.get(runId);
		if (!buffer) {
			return;
		}
		buffer.append(event);
		const activity = childActivityOf(event);
		const run = this.runs.get(runId);
		if (run) {
			if (activity) run.activity = activity;
			run.lastActivityAt = event.at;
		}
		const listeners = this.eventListeners.get(runId);
		if (listeners) {
			for (const listener of [...listeners]) {
				try {
					listener(event);
				} catch {
					// A UI listener must never break orchestration.
				}
			}
		}
	}

	private epochEnd(): void {
		const active = [...this.runs.values()].some((r) => r.status === "running" || r.status === "pending");
		if (!active) {
			this.epochStartedAt = undefined;
		}
		this.publish();
	}

	/**
	 * Settle a run as failed from a classified failure envelope. The failure kind
	 * (task/capability/environment/timeout/cancelled/unknown) is preserved so the
	 * parent can tell "the work failed" from "the work could not run".
	 */
	private failRun(run: AiraChildRun, failure: AiraChildFailureInfo): void {
		const status: AiraChildRunStatus =
			failure.kind === "cancelled" ? "cancelled" : failure.kind === "timeout" ? "timed-out" : "failed";
		run.error = failure;
		this.recordChildEvent(run.id, {
			kind: "failure",
			at: Date.now(),
			category: failure.category,
			message: failure.message,
		});
		this.settleRun(run, status, failure, failure.message, undefined);
	}

	/**
	 * Map a settled runner outcome to a classified failure. A runner-provided
	 * structured failure is used as-is; a legacy driver string is classified as a
	 * capability failure (the child execution seam), so pre-execution capability
	 * errors are never reported as failed task work.
	 */
	private failureOf(run: AiraChildRun, outcome: AiraChildOutcome, signal: AbortSignal): AiraChildFailureInfo {
		if (outcome.ok) {
			return buildAiraChildFailure({ message: "child run failed", taskStatus: "unknown" });
		}
		if (outcome.error) {
			return signal.aborted && outcome.error.kind !== "cancelled"
				? { ...outcome.error, kind: "cancelled", category: "cancelled", retryableHint: "no" }
				: outcome.error;
		}
		const legacy = outcome.driverError;
		const gaps = run.capabilityGaps ?? [];
		if (signal.aborted || categorizeDriverError(legacy) === "cancelled") {
			return classifyAiraChildFailure({
				cancelled: true,
				message: legacy,
				component: "child-run",
				operation: "cancel",
			});
		}
		const category = categorizeDriverError(legacy);
		if (category === "timeout") {
			return classifyAiraChildFailure({
				timedOut: true,
				message: legacy,
				component: "child-run",
				operation: "timeout",
			});
		}
		if (category === "tool-budget-exceeded") {
			return buildAiraChildFailure({
				kind: "task_failure",
				category,
				message: legacy,
				component: "child-run",
				operation: "tool-budget",
				taskStatus: "attempted",
			});
		}
		// No structured classification from the runner: the seam is the child
		// execution capability, and a required capability gap (when present) is the
		// concrete unavailable component. The legacy driver category is preserved so
		// existing consumers keep their bounded reason code.
		const gap = gaps[0];
		return buildAiraChildFailure({
			kind: category === "permission-denied" ? "environment_failure" : "capability_failure",
			category,
			message: legacy,
			component: gap?.component ?? "child-run",
			operation: gap?.operation ?? "execute",
			// A known capability gap proves the work never ran; otherwise the stage is
			// unknown rather than assumed.
			taskStatus: gap ? "not_attempted" : "unknown",
			...(gaps.length > 0 ? { capabilityGaps: gaps } : {}),
		});
	}

	private settleRun(
		run: AiraChildRun,
		status: AiraChildRunStatus,
		failure: AiraChildFailureInfo | undefined,
		message: string | undefined,
		result: AiraChildResult | undefined,
	): void {
		run.status = status;
		run.phase = "settled";
		run.completedAt = Date.now();
		run.durationMs = run.completedAt - (run.startedAt ?? run.completedAt) || 0;
		run.result = result ?? run.result;
		if (failure !== undefined) {
			run.error = failure;
		}
		this.recordChildEvent(run.id, {
			kind: "completion",
			at: run.completedAt,
			status: status === "completed" ? "completed" : "failed",
			summary: result?.summary ?? message ?? status,
		});
		this.publish();
	}

	private recentRuns(): AiraChildRun[] {
		return [...this.runs.values()].sort(
			(a, b) => (b.startedAt ?? b.createdAt ?? 0) - (a.startedAt ?? a.createdAt ?? 0),
		);
	}

	private refusedBatch(specs: AiraChildTaskSpec[], reason: string): AiraOrchestrationBatchResult {
		return {
			ok: false,
			tasks: specs.map((spec) => ({ taskId: spec.id ?? spec.role, role: spec.role, accepted: false, reason })),
		};
	}

	private rejectionBatch(
		specs: AiraChildTaskSpec[],
		rejection: AiraScheduleRejectionLike,
		gatedReasons?: Map<AiraChildTaskSpec, string>,
	): AiraOrchestrationBatchResult {
		return {
			ok: false,
			tasks: specs.map((spec) => ({
				taskId: spec.id ?? spec.role,
				role: spec.role,
				accepted: false,
				reason: gatedReasons?.get(spec) ?? describeRejection(rejection),
			})),
		};
	}

	private publish(): void {
		const settings = this.disposed ? undefined : this.options.settings();
		const active = [...this.runs.values()].filter((r) => r.status === "pending" || r.status === "running");
		const anyActive = active.length > 0 || this.activeBatches.size > 0;
		this.snapshot = {
			enabled: settings?.enabled ?? this.snapshot.enabled,
			status: anyActive ? "active" : "idle",
			runningCount: active.filter((r) => r.status === "running").length,
			queuedCount: active.filter((r) => r.status === "pending").length,
			maxConcurrency: settings?.maxParallel ?? this.snapshot.maxConcurrency,
			children: this.recentRuns().slice(0, MAX_CHILDREN_IN_SNAPSHOT).map(toAiraChildSnapshot),
			recentResults: this.recentRuns()
				.filter((r) => r.phase === "settled")
				.slice(0, MAX_RESULTS_IN_SNAPSHOT)
				.map(toAiraChildResultSummary),
			failures: this.recentRuns()
				.filter((r) => r.error !== undefined)
				.slice(0, MAX_FAILURES_IN_SNAPSHOT)
				.map(toAiraChildFailure),
			aggregateTokenUsage: aggregateAiraTokenUsage([...this.runs.values()]),
			epochStartedAt: this.epochStartedAt ?? this.snapshot.epochStartedAt,
			summary: summarizeOrchestration(anyActive, active.length, settings?.enabled ?? this.snapshot.enabled),
			updatedAt: Date.now(),
		};
		this.state.orchestration = this.snapshot;
		for (const listener of [...this.listeners]) {
			listener(this.snapshot);
		}
	}
}

/** Create the session's orchestration manager and return the handle. */
export function createAiraOrchestrationManager(
	state: AiraSessionState,
	options: AiraOrchestrationManagerOptions,
): AiraOrchestrationHandle {
	const manager = new AiraOrchestrationManager(state, options);
	manager.activate();
	return manager;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The effective requested-model label for a run (settings + per-task override). */

function generatedTaskId(role: string): string {
	return `${role.slice(0, 3)}-${randomUUID().slice(0, 6)}`;
}

function indexOfRun(prepared: AiraSchedulerRunTask[], runId: string): number {
	return prepared.findIndex((sched) => sched.runId === runId);
}

function clampChildTimeout(requested: number, settingsDefault: number): number {
	if (!Number.isFinite(requested) || requested < MIN_CHILD_TIMEOUT_MS) {
		return Math.min(settingsDefault, MAX_CHILD_TIMEOUT_MS);
	}
	return Math.min(requested, MAX_CHILD_TIMEOUT_MS);
}

/**
 * Map a driver error string to a bounded actionable category.
 * Tool-budget exhaustion is a real failure mode ("child exceeded its tool
 * budget") and surfaces as its own category — never as a generic driver
 * error that reads as an opaque model/provider stall.
 */
function categorizeDriverError(message: string): AiraChildFailureCategory {
	if (message.includes("tool budget")) {
		return "tool-budget-exceeded";
	}
	if (message.includes("timed out")) {
		return "timeout";
	}
	if (message.includes("cancelled")) {
		return "cancelled";
	}
	if (message.toLowerCase().includes("permission") || message.toLowerCase().includes("denied")) {
		return "permission-denied";
	}
	return "driver";
}

function preflightChildTask(spec: AiraChildTaskSpec, mode: AiraSessionState["mode"]): string | undefined {
	if (mode === "plan" && !isAiraChildRoleReadOnly(spec.role)) {
		return `role ${spec.role} is refused in PLAN (read-only enforcement)`;
	}
	const role = airaChildRoleOf(spec.role);
	for (const capability of spec.requiredCapabilities ?? []) {
		const supported =
			capability === "mutation"
				? role?.capabilities.includes("mutating")
				: capability === "process"
					? role?.capabilities.includes("process")
					: false;
		if (!supported) {
			return `role ${spec.role} cannot satisfy required capability: ${capability === "process" ? "process execution" : capability}`;
		}
		if (mode === "plan") return `PLAN forbids required capability: ${capability}`;
	}
	return undefined;
}

type AiraScheduleRejectionLike = {
	kind: string;
	taskId?: string;
	dependency?: string;
	path?: string[];
	count?: number;
	max?: number;
};

function describeRejection(rejection: AiraScheduleRejectionLike): string {
	switch (rejection.kind) {
		case "duplicate-id":
			return `duplicate task id "${rejection.taskId}"`;
		case "self-dependency":
			return `task "${rejection.taskId}" depends on itself`;
		case "unknown-dependency":
			return `task "${rejection.taskId}" depends on unknown task "${rejection.dependency}"`;
		case "cycle":
			return `dependency cycle: ${(rejection.path ?? []).join(" -> ")}`;
		case "too-many-tasks":
			return `too many tasks: ${rejection.count} exceeds the maximum of ${rejection.max}`;
		default:
			return `invalid task graph (${rejection.kind})`;
	}
}

/** One-line orchestration summary ("idle", "2 running · 1 queued", "disabled"). */
function summarizeOrchestration(anyActive: boolean, activeCount: number, enabled: boolean): string {
	if (!enabled) {
		return "disabled";
	}
	if (!anyActive || activeCount === 0) {
		return "idle";
	}
	return `${activeCount} active`;
}
