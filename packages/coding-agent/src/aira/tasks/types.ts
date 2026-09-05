/**
 * Aira tasks — canonical task-graph projection types.
 *
 * Phase 11: the native Todo/Task UX. ONE canonical task graph exists per
 * session, owned by `AiraTaskManager`. The Phase 9 orchestration manager
 * remains the owner of child RUN records; tasks derived from orchestration
 * children are projected into the task graph as read-only rows
 * (`source: "child"`) through the orchestration event seam — patching them
 * is refused. Manual/model-created tasks (`source: "user" | "model"`) are
 * planning rows that never become orchestration children (delegation stays
 * an explicit `agents_delegate` action). There is deliberately NO second
 * canonical task universe.
 *
 * Task status vocabulary (smallest truthful set):
 *   pending → active → completed        (forward transitions only)
 *   blocked     derived: an unfinished dependency blocks the task
 *   cancelled   user/model cancelled (pending|active|blocked only)
 *   failed      child-derived rows whose orchestration run failed
 *
 * All snapshots are bounded, serializable, and token-free (UI-ready).
 */

/** Task lifecycle truth (smallest truthful set). */
export type AiraTaskStatus = "pending" | "active" | "blocked" | "completed" | "cancelled" | "failed";

/** Where a task row came from. */
export type AiraTaskSource = "user" | "model" | "child";

/** One task row in the canonical graph. */
export interface AiraTask {
	/** Session-unique task id. */
	id: string;
	/** Bounded title. */
	title: string;
	status: AiraTaskStatus;
	source: AiraTaskSource;
	/** Task ids that must settle before this task can be active/completed. */
	dependsOn: string[];
	/** Bounded note (optional). */
	note?: string;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	/** Orchestration run id for child-derived rows (projection key). */
	childRunId?: string;
	/** Child role for child-derived rows. */
	childRole?: string;
	/** Bounded one-line detail (child failure category, etc). */
	detail?: string;
}

/** Compact single-task patch (never full-list replacement). */
export type AiraTaskPatch = {
	title?: string;
	status?: AiraTaskStatus;
	dependsOn?: string[];
	note?: string;
};

/** Bounded UI-ready row projection. */
export interface AiraTaskSnapshotRow {
	id: string;
	title: string;
	status: AiraTaskStatus;
	source: AiraTaskSource;
	dependsOn: string[];
	/** Child run id for orchestration-derived rows. */
	childRunId?: string;
	childRole?: string;
	/** Bounded one-line detail. */
	detail?: string;
}

/** Canonical task snapshot published into AiraSessionState.tasks (token-free). */
export interface AiraTasksStatus {
	/** Projection of tasks.enabled. */
	enabled: boolean;
	/** Total rows (excluding cancelled/failed). */
	total: number;
	pending: number;
	active: number;
	blocked: number;
	completed: number;
	cancelled: number;
	failed: number;
	/** Title of the current (active) task, bounded. */
	current: string | undefined;
	/** Bounded row projection (active/blocked/pending first, capped). */
	rows: AiraTaskSnapshotRow[];
	/** Child-derived row count (orchestration projection). */
	childRows: number;
	updatedAt: number;
	/** One-line summary for restrained surfaces ("3/8 · 1 active"). */
	summary: string;
	/** Bounded storage/recovery health; absent for hosts without persistence. */
	persistence?: { status: "ok" | "unavailable" | "failed"; error?: string };
}

export const AIRA_TASK_MAX_ROWS = 128;
export const AIRA_TASK_SNAPSHOT_ROWS = 24;
export const AIRA_TASK_MAX_TITLE_CHARS = 200;
export const AIRA_TASK_MAX_NOTE_CHARS = 300;
export const AIRA_TASK_MAX_DEPENDENCIES = 16;

/** One-shot model hint after interrupted task recovery. */
export const AIRA_TASK_RECOVERY_HINT =
	"interrupted native tasks were recovered; consult canonical task state before continuing";

/** Forward-only legal transitions (blocked is derived, never settable). */
export const AIRA_TASK_TRANSITIONS: Readonly<Record<AiraTaskStatus, readonly AiraTaskStatus[]>> = {
	pending: ["active", "cancelled"],
	active: ["completed", "cancelled"],
	blocked: ["cancelled"],
	completed: [],
	cancelled: [],
	failed: [],
};

/** Statuses a task may be patched INTO (blocked is derived). */
export const AIRA_TASK_PATCHABLE_STATUSES: readonly AiraTaskStatus[] = ["pending", "active", "completed", "cancelled"];
