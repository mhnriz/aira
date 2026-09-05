/**
 * Aira tasks — per-session task-graph manager.
 *
 * The single canonical owner of the session task graph (ADR-024 ownership
 * pattern). The model-facing `tasks` tool and the `/tasks` command both
 * operate through this manager; the Phase 9 orchestration manager is the
 * owner of child RUN records, and this manager projects them into task rows
 * (`source: "child"`, read-only) through the orchestration subscribe seam so
 * the human/model see ONE task universe. No second mutable task owner.
 *
 * Semantics:
 * - model patches use forward-only transitions and are validated (types.ts);
 *   the human `/tasks done` action activates a pending task before completing
 *   it so the command matches its user-facing meaning;
 * - `blocked` is DERIVED from unfinished dependencies and can never be set
 *   directly; a task with an unfinished dependency cannot become
 *   active/completed (truthful rejection);
 * - child-derived rows are immutable through the task surface ("owned by
 *   orchestration; cancel via /agents cancel");
 * - rows are bounded (AIRA_TASK_MAX_ROWS; oldest settled rows evicted);
 * - session-scoped persistence is bounded and native rows only; child rows
 *   remain orchestration-owned projections.
 */
import { randomUUID } from "node:crypto";
import type { AiraOrchestrationHandle } from "../orchestration/manager.ts";
import type { AiraSessionState } from "../state.ts";
import { type AiraTaskPersistence, createAiraTaskPersistence } from "./persistence.ts";
import {
	AIRA_TASK_MAX_DEPENDENCIES,
	AIRA_TASK_MAX_NOTE_CHARS,
	AIRA_TASK_MAX_ROWS,
	AIRA_TASK_MAX_TITLE_CHARS,
	AIRA_TASK_PATCHABLE_STATUSES,
	AIRA_TASK_RECOVERY_HINT,
	AIRA_TASK_SNAPSHOT_ROWS,
	AIRA_TASK_TRANSITIONS,
	type AiraTask,
	type AiraTaskPatch,
	type AiraTaskSource,
	type AiraTaskStatus,
	type AiraTasksStatus,
} from "./types.ts";

export interface AiraTasksSettings {
	enabled: boolean;
}

export interface AiraTaskManagerOptions {
	/** Canonical settings accessor (live). */
	settings: () => AiraTasksSettings;
	/** Orchestration handle (Phase 9) — child-run projection source. */
	orchestration?: AiraOrchestrationHandle;
	now?: () => number;
	/** Session identity and lifecycle reason for the default durable store. */
	sessionId?: string;
	startReason?: string;
	persistence?: AiraTaskPersistence;
	persistenceEnabled?: boolean;
}

export interface AiraTaskManagerHandle {
	/** Create a task row (source "user" | "model"). */
	create(
		title: string,
		options?: { source?: AiraTaskSource; dependsOn?: string[]; note?: string },
	): { ok: true; task: AiraTask } | { ok: false; message: string };
	/** Patch ONE task (never full-list replacement). */
	patch(id: string, patch: AiraTaskPatch): { ok: true; task: AiraTask } | { ok: false; message: string };
	get(id: string): AiraTask | undefined;
	list(status?: AiraTask["status"]): AiraTask[];
	/** Complete a user/model task, activating it first when necessary. */
	complete(id: string): { ok: true; task: AiraTask } | { ok: false; message: string };
	/** Remove a non-child task row (child rows are orchestration-owned). */
	remove(id: string): { ok: true } | { ok: false; message: string };
	clear(): { ok: true } | { ok: false; message: string };
	/** Canonical snapshot (token-free). */
	status(): AiraTasksStatus;
	/** Consume the one-shot model hint created by interrupted-task recovery. */
	consumeRecoveryHint?(): string | undefined;
	subscribe(listener: (status: AiraTasksStatus) => void): () => void;
	dispose(): void;
}

export class AiraTaskManager implements AiraTaskManagerHandle {
	private readonly state: AiraSessionState;
	private readonly options: AiraTaskManagerOptions;
	private readonly tasks = new Map<string, AiraTask>();
	private readonly listeners = new Set<(status: AiraTasksStatus) => void>();
	private snapshot: AiraTasksStatus;
	private unsubscribeOrchestration: (() => void) | undefined;
	private disposed = false;
	private readonly persistence: AiraTaskPersistence | undefined;
	private recoveryHintPending = false;

	constructor(state: AiraSessionState, options: AiraTaskManagerOptions) {
		this.state = state;
		this.options = options;
		this.persistence =
			options.persistence ??
			(options.sessionId
				? createAiraTaskPersistence(options.sessionId, options.startReason ?? "startup", {
						enabled: options.persistenceEnabled,
					})
				: undefined);
		const recovered = this.persistence?.recover();
		for (const task of recovered?.tasks ?? []) {
			if (!this.tasks.has(task.id)) this.tasks.set(task.id, task);
		}
		this.recoveryHintPending = (recovered?.normalizedCount ?? 0) > 0;
		this.refreshDerivedStates();
		this.snapshot = this.buildSnapshot();
	}

	activate(): void {
		if (this.disposed) {
			return;
		}
		this.unsubscribeOrchestration = this.options.orchestration?.subscribe((status) => {
			// Project orchestration run records into child-derived task rows.
			const runs = this.options.orchestration?.list() ?? [];
			this.syncChildRows(status, runs);
		});
		this.publish();
	}

	create(
		title: string,
		options: { source?: AiraTaskSource; dependsOn?: string[]; note?: string } = {},
	): { ok: true; task: AiraTask } | { ok: false; message: string } {
		if (this.disposed) {
			return { ok: false, message: "session disposed" };
		}
		const normalized = title.trim();
		if (!normalized) {
			return { ok: false, message: "task title is required" };
		}
		if (this.tasks.size >= AIRA_TASK_MAX_ROWS) {
			return { ok: false, message: `task limit reached (${AIRA_TASK_MAX_ROWS})` };
		}
		const dependsOn = this.normalizeDependencies(options.dependsOn);
		const unknown = dependsOn.find((id) => !this.tasks.has(id));
		if (unknown) {
			return { ok: false, message: `unknown dependency task "${unknown}"` };
		}
		const source = options.source === "model" || options.source === "child" ? options.source : "user";
		const task: AiraTask = {
			id: `t-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
			title: this.boundTitle(normalized),
			status: "pending",
			source,
			dependsOn,
			...(options.note ? { note: this.boundNote(options.note) } : {}),
			createdAt: this.now(),
		};
		this.tasks.set(task.id, task);
		this.refreshDerivedStates();
		this.evictSettled();
		this.persist();
		this.publish();
		return { ok: true, task: this.clone(task) };
	}

	patch(id: string, patch: AiraTaskPatch): { ok: true; task: AiraTask } | { ok: false; message: string } {
		if (this.disposed) {
			return { ok: false, message: "session disposed" };
		}
		const task = this.tasks.get(id);
		if (!task) {
			return { ok: false, message: `unknown task "${id}"` };
		}
		if (task.source === "child") {
			return {
				ok: false,
				message: `task "${id}" is owned by orchestration (child run ${task.childRunId ?? ""}); cancel via /agents`,
			};
		}
		if (task.status === "completed" || task.status === "cancelled" || task.status === "failed") {
			return { ok: false, message: `task "${id}" is ${task.status} (terminal)` };
		}

		if (patch.title !== undefined) {
			const title = patch.title.trim();
			if (!title) {
				return { ok: false, message: "task title cannot be empty" };
			}
			task.title = this.boundTitle(title);
		}
		if (patch.note !== undefined) {
			task.note = patch.note.trim() ? this.boundNote(patch.note) : undefined;
		}
		if (patch.dependsOn !== undefined) {
			const dependsOn = this.normalizeDependencies(patch.dependsOn);
			if (dependsOn.includes(task.id)) {
				return { ok: false, message: "a task cannot depend on itself" };
			}
			const unknown = dependsOn.find((depId) => !this.tasks.has(depId));
			if (unknown) {
				return { ok: false, message: `unknown dependency task "${unknown}"` };
			}
			task.dependsOn = dependsOn;
		}

		if (patch.status !== undefined) {
			if (!AIRA_TASK_PATCHABLE_STATUSES.includes(patch.status)) {
				return { ok: false, message: `status "${patch.status}" cannot be set directly (blocked is derived)` };
			}
			// Dependency-blocked tasks cannot be activated/completed (truthful,
			// checked before the transition table so the reason is actionable).
			if ((patch.status === "active" || patch.status === "completed") && this.hasUnfinishedDependencies(task)) {
				return {
					ok: false,
					message: `task "${id}" is dependency-blocked: finish ${this.unfinishedDependencies(task).join(", ")} first`,
				};
			}
			if (patch.status !== task.status) {
				const allowed = AIRA_TASK_TRANSITIONS[task.status] ?? [];
				if (!allowed.includes(patch.status)) {
					return {
						ok: false,
						message: `cannot move task "${id}" from ${task.status} to ${patch.status}`,
					};
				}
				task.status = patch.status;
				if (patch.status === "active") {
					task.startedAt ??= this.now();
				}
				if (patch.status === "completed") {
					task.completedAt = this.now();
				}
			}
		}

		this.refreshDerivedStates();
		this.persist();
		this.publish();
		return { ok: true, task: this.clone(task) };
	}

	get(id: string): AiraTask | undefined {
		const task = this.tasks.get(id);
		return task ? this.clone(task) : undefined;
	}

	list(status?: AiraTask["status"]): AiraTask[] {
		const rows = [...this.tasks.values()];
		const ordered = rows.sort((a, b) => statusOrder(a.status) - statusOrder(b.status) || a.createdAt - b.createdAt);
		return status === undefined
			? ordered.map((task) => this.clone(task))
			: ordered.filter((task) => task.status === status).map((task) => this.clone(task));
	}

	complete(id: string): { ok: true; task: AiraTask } | { ok: false; message: string } {
		const task = this.tasks.get(id);
		if (!task) return { ok: false, message: `unknown task "${id}"` };
		if (task.status === "pending") {
			const activated = this.patch(id, { status: "active" });
			if (!activated.ok) return activated;
		}
		return this.patch(id, { status: "completed" });
	}

	remove(id: string): { ok: true } | { ok: false; message: string } {
		const task = this.tasks.get(id);
		if (!task) {
			return { ok: false, message: `unknown task "${id}"` };
		}
		if (task.source === "child") {
			return { ok: false, message: `task "${id}" is owned by orchestration; cancel via /agents` };
		}
		this.tasks.delete(id);
		this.refreshDerivedStates();
		this.persist();
		this.publish();
		return { ok: true };
	}

	clear(): { ok: true } | { ok: false; message: string } {
		if (this.disposed) return { ok: false, message: "session disposed" };
		for (const [id, task] of this.tasks) {
			if (task.source !== "child") this.tasks.delete(id);
		}
		this.refreshDerivedStates();
		this.persist();
		this.publish();
		return { ok: true };
	}

	status(): AiraTasksStatus {
		this.publish();
		return this.snapshot;
	}

	consumeRecoveryHint(): string | undefined {
		if (!this.recoveryHintPending) {
			return undefined;
		}
		this.recoveryHintPending = false;
		return AIRA_TASK_RECOVERY_HINT;
	}

	subscribe(listener: (status: AiraTasksStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.persist();
		this.disposed = true;
		this.unsubscribeOrchestration?.();
		this.unsubscribeOrchestration = undefined;
		this.tasks.clear();
		this.listeners.clear();
		this.publish();
	}

	// -----------------------------------------------------------------------
	// internals
	// -----------------------------------------------------------------------

	private syncChildRows(
		status: import("../orchestration/types.ts").AiraOrchestrationStatus,
		runs: ReadonlyArray<import("../orchestration/types.ts").AiraChildRun>,
	): void {
		void status;
		const byId = new Map(runs.map((run) => [run.id, run]));
		// Batch dependency edges reference task ids; resolve them to run ids so
		// child rows reference rows that actually exist in this graph.
		const taskIdToRunId = new Map(runs.map((run) => [run.taskId, run.id]));
		const mapDependencies = (deps: readonly string[]): string[] =>
			deps.map((dep) => taskIdToRunId.get(dep) ?? dep).slice(0, AIRA_TASK_MAX_DEPENDENCIES);
		// Key child rows by run id; drop rows whose run vanished (rejected
		// before launch has no run record in list()).
		for (const [id, task] of [...this.tasks]) {
			if (task.source === "child" && task.childRunId !== undefined && !byId.has(task.childRunId)) {
				this.tasks.delete(id);
			}
		}
		for (const run of runs) {
			const detail = childTaskDetail(run);
			const existing = [...this.tasks.values()].find(
				(task) => task.source === "child" && task.childRunId === run.id,
			);
			if (existing) {
				existing.title = this.boundTitle(run.task);
				existing.status = childTaskStatus(run.status, run.phase);
				existing.detail = detail;
				existing.dependsOn = mapDependencies(run.dependencies);
				if (existing.status === "completed") {
					existing.completedAt ??= run.completedAt;
				}
				continue;
			}
			const task: AiraTask = {
				id: `c-${run.id.slice(0, 12)}`,
				title: this.boundTitle(run.task),
				status: childTaskStatus(run.status, run.phase),
				source: "child",
				dependsOn: mapDependencies(run.dependencies),
				createdAt: run.createdAt,
				...(run.startedAt ? { startedAt: run.startedAt } : {}),
				...(run.completedAt ? { completedAt: run.completedAt } : {}),
				childRunId: run.id,
				childRole: run.role,
				...(detail ? { detail } : {}),
			};
			this.tasks.set(task.id, task);
		}
		this.refreshDerivedStates();
		this.evictSettled();
		this.publish();
	}

	private normalizeDependencies(dependsOn: string[] | undefined): string[] {
		if (!dependsOn) {
			return [];
		}
		const seen = new Set<string>();
		return dependsOn
			.map((id) => id.trim())
			.filter((id) => id.length > 0 && !seen.has(id) && seen.add(id) !== undefined)
			.slice(0, AIRA_TASK_MAX_DEPENDENCIES);
	}

	private hasUnfinishedDependencies(task: AiraTask): boolean {
		return this.unfinishedDependencies(task).length > 0;
	}

	private unfinishedDependencies(task: AiraTask): string[] {
		return task.dependsOn.filter((depId) => {
			const dep = this.tasks.get(depId);
			if (!dep) {
				return false;
			}
			return dep.status !== "completed" && dep.status !== "cancelled" && dep.status !== "failed";
		});
	}

	/** `blocked` is derived from unfinished dependencies (never settable). */
	private refreshDerivedStates(): void {
		for (const task of this.tasks.values()) {
			if (task.source === "child") {
				continue; // child rows derive from orchestration phases directly
			}
			if (task.status === "pending" && this.hasUnfinishedDependencies(task)) {
				task.status = "blocked";
			} else if (task.status === "blocked" && !this.hasUnfinishedDependencies(task)) {
				task.status = "pending";
			}
		}
	}

	private evictSettled(): void {
		if (this.tasks.size <= AIRA_TASK_MAX_ROWS) {
			return;
		}
		const settled = [...this.tasks.values()]
			.filter((task) => task.status === "completed" || task.status === "cancelled" || task.status === "failed")
			.sort((a, b) => (a.completedAt ?? a.createdAt) - (b.completedAt ?? b.createdAt));
		for (const task of settled) {
			if (this.tasks.size <= AIRA_TASK_MAX_ROWS) {
				break;
			}
			this.tasks.delete(task.id);
		}
	}

	private boundTitle(title: string): string {
		const trimmed = title.trim();
		return trimmed.length <= AIRA_TASK_MAX_TITLE_CHARS
			? trimmed
			: `${trimmed.slice(0, AIRA_TASK_MAX_TITLE_CHARS - 1)}…`;
	}

	private boundNote(note: string): string {
		const trimmed = note.trim();
		return trimmed.length <= AIRA_TASK_MAX_NOTE_CHARS
			? trimmed
			: `${trimmed.slice(0, AIRA_TASK_MAX_NOTE_CHARS - 1)}…`;
	}

	private buildSnapshot(): AiraTasksStatus {
		const rows = [...this.tasks.values()].sort(
			(a, b) => statusOrder(a.status) - statusOrder(b.status) || a.createdAt - b.createdAt,
		);
		const counts = { pending: 0, active: 0, blocked: 0, completed: 0, cancelled: 0, failed: 0 };
		for (const task of rows) {
			counts[task.status] = (counts[task.status] ?? 0) + 1;
		}
		const enabled = this.options.settings().enabled;
		const currentRow = rows.find((task) => task.status === "active");
		const projection = rows.slice(0, AIRA_TASK_SNAPSHOT_ROWS).map((task) => rowProjection(task));
		const total = rows.length - counts.cancelled - counts.failed;
		return {
			enabled,
			total,
			...counts,
			current: currentRow ? this.boundTitle(currentRow.title).slice(0, 120) : undefined,
			rows: projection,
			childRows: rows.filter((task) => task.source === "child").length,
			updatedAt: this.now(),
			summary: taskSummary(total, counts, enabled),
			...(this.persistence ? { persistence: persistenceSnapshot(this.persistence.health()) } : {}),
		};
	}

	private persist(): void {
		this.persistence?.save([...this.tasks.values()]);
	}

	private publish(): void {
		this.snapshot = this.buildSnapshot();
		this.state.tasks = this.snapshot;
		for (const listener of [...this.listeners]) {
			listener(this.snapshot);
		}
	}

	private clone(task: AiraTask): AiraTask {
		return { ...task, dependsOn: [...task.dependsOn] };
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}

function statusOrder(status: AiraTask["status"]): number {
	switch (status) {
		case "active":
			return 0;
		case "blocked":
			return 1;
		case "pending":
			return 2;
		case "completed":
			return 3;
		case "failed":
			return 4;
		case "cancelled":
			return 5;
	}
}

function childTaskStatus(
	runStatus: import("../orchestration/types.ts").AiraChildRunStatus,
	phase: import("../orchestration/types.ts").AiraChildPhase,
): AiraTask["status"] {
	switch (runStatus) {
		case "running":
			return "active";
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "timed-out":
		case "cancelled":
		case "rejected":
			return "cancelled";
		case "pending":
			return phase === "waiting-dependency" ? "blocked" : "pending";
	}
}

function childTaskDetail(run: import("../orchestration/types.ts").AiraChildRun): string | undefined {
	if (!run.error) {
		return undefined;
	}
	return `${run.error.category}: ${run.error.message.slice(0, 120)}`;
}

function rowProjection(task: AiraTask): AiraTasksStatus["rows"][number] {
	return {
		id: task.id,
		title: task.title,
		status: task.status,
		source: task.source,
		dependsOn: [...task.dependsOn],
		...(task.childRunId ? { childRunId: task.childRunId } : {}),
		...(task.childRole ? { childRole: task.childRole } : {}),
		...(task.detail ? { detail: task.detail } : {}),
	};
}

function taskSummary(total: number, counts: Record<AiraTaskStatus, number>, enabled: boolean): string {
	if (!enabled) {
		return "disabled";
	}
	if (total === 0) {
		return "no tasks";
	}
	return `${counts.completed}/${total} · ${counts.active} active${counts.blocked > 0 ? ` · ${counts.blocked} blocked` : ""}`;
}

/** Create the session's task manager and return the handle. */
export function createAiraTaskManager(state: AiraSessionState, options: AiraTaskManagerOptions): AiraTaskManagerHandle {
	const manager = new AiraTaskManager(state, options);
	manager.activate();
	return manager;
}

function persistenceSnapshot(record: { status: "ok" | "unavailable" | "failed"; error: string | undefined }): {
	status: "ok" | "unavailable" | "failed";
	error?: string;
} {
	return { status: record.status, ...(record.error ? { error: record.error } : {}) };
}
