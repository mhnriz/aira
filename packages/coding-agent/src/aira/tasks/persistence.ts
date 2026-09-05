/** Bounded persistence for the canonical native task graph. */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAiraCacheDir } from "../paths.ts";
import {
	AIRA_TASK_MAX_DEPENDENCIES,
	AIRA_TASK_MAX_NOTE_CHARS,
	AIRA_TASK_MAX_ROWS,
	AIRA_TASK_MAX_TITLE_CHARS,
	type AiraTask,
	type AiraTaskSource,
	type AiraTaskStatus,
} from "./types.ts";

export const AIRA_TASK_PERSISTED_STATE_VERSION = 1;

export interface AiraTaskPersistenceRecord {
	status: "ok" | "unavailable" | "failed";
	error: string | undefined;
	path: string | undefined;
}

export interface AiraPersistedTask {
	id: string;
	title: string;
	status: Exclude<AiraTaskStatus, "blocked" | "failed">;
	source: Exclude<AiraTaskSource, "child">;
	dependsOn: string[];
	note?: string;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
}

export interface AiraTaskRecoveryResult {
	tasks: AiraTask[];
	normalizedCount: number;
}

interface PersistedTasksFile {
	version: number;
	sessionId: string;
	tasks: AiraPersistedTask[];
}

export interface AiraTaskPersistence {
	path: string;
	load(): AiraPersistedTask[] | undefined;
	recover(): AiraTaskRecoveryResult | undefined;
	save(tasks: readonly AiraTask[]): AiraTaskPersistenceRecord;
	clear(): AiraTaskPersistenceRecord;
	health(): AiraTaskPersistenceRecord;
}

export function createAiraTaskPersistence(
	sessionId: string,
	startReason: string,
	options: { enabled?: boolean; baseDir?: string } = {},
): AiraTaskPersistence {
	const baseDir = options.baseDir ?? join(getAiraCacheDir(), "tasks");
	const path = join(baseDir, `${safeSessionFileName(sessionId)}.json`);
	let record: AiraTaskPersistenceRecord = { status: "unavailable", error: undefined, path };

	const load = (): AiraPersistedTask[] | undefined => {
		if (options.enabled === false || (startReason !== "startup" && startReason !== "resume")) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedTasksFile>;
			if (
				parsed.version !== AIRA_TASK_PERSISTED_STATE_VERSION ||
				parsed.sessionId !== sessionId ||
				!Array.isArray(parsed.tasks)
			) {
				record = { status: "failed", error: "malformed or unknown task persistence schema", path };
				return undefined;
			}
			const tasks = parsed.tasks.slice(0, AIRA_TASK_MAX_ROWS).flatMap((task) => {
				const normalized = normalizePersistedTask(task);
				return normalized ? [normalized] : [];
			});
			record = { status: "ok", error: undefined, path };
			return tasks;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				record = { status: "ok", error: undefined, path };
				return undefined;
			}
			record = { status: "failed", error: boundedError(error), path };
			return undefined;
		}
	};

	const recover = (): AiraTaskRecoveryResult | undefined => {
		const loaded = load();
		if (!loaded) {
			return undefined;
		}
		const normalizedCount = loaded.filter((task) => task.status === "active").length;
		const tasks = loaded.map((task) => ({
			...task,
			// A process may have disappeared while Aira was closed. Active work is
			// safe to resume only as pending; blocked is recomputed by TaskManager.
			status: task.status === "active" ? "pending" : task.status,
			dependsOn: [...task.dependsOn],
		}));
		if (normalizedCount > 0) {
			// Recovery is a durable state transition. If the manager is rebuilt
			// before the next ordinary task operation, a later resume must see the
			// already-normalized pending snapshot rather than stale active work.
			save(tasks);
		}
		return { tasks, normalizedCount };
	};

	const save = (tasks: readonly AiraTask[]): AiraTaskPersistenceRecord => {
		if (options.enabled === false) {
			record = { status: "unavailable", error: undefined, path };
			return record;
		}
		try {
			mkdirSync(baseDir, { recursive: true });
			const persistable = tasks
				.filter((task): task is AiraTask & { source: Exclude<AiraTaskSource, "child"> } => task.source !== "child")
				.slice(0, AIRA_TASK_MAX_ROWS)
				.map(toPersistedTask);
			const tempPath = `${path}.${process.pid}.tmp`;
			writeFileSync(
				tempPath,
				`${JSON.stringify({ version: AIRA_TASK_PERSISTED_STATE_VERSION, sessionId, tasks: persistable })}\n`,
				"utf8",
			);
			renameSync(tempPath, path);
			record = { status: "ok", error: undefined, path };
			return record;
		} catch (error) {
			record = { status: "failed", error: boundedError(error), path };
			return record;
		}
	};

	const clear = (): AiraTaskPersistenceRecord => {
		try {
			unlinkSync(path);
			record = { status: "ok", error: undefined, path };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				record = { status: "ok", error: undefined, path };
			} else {
				record = { status: "failed", error: boundedError(error), path };
			}
		}
		return record;
	};

	return { path, load, recover, save, clear, health: () => record };
}

function normalizePersistedTask(value: unknown): AiraPersistedTask | undefined {
	if (!value || typeof value !== "object") return undefined;
	const task = value as Record<string, unknown>;
	if (
		typeof task.id !== "string" ||
		typeof task.title !== "string" ||
		(task.status !== "pending" &&
			task.status !== "active" &&
			task.status !== "completed" &&
			task.status !== "cancelled") ||
		(task.source !== "user" && task.source !== "model") ||
		!Array.isArray(task.dependsOn) ||
		typeof task.createdAt !== "number"
	) {
		return undefined;
	}
	const title = bound(task.title, AIRA_TASK_MAX_TITLE_CHARS);
	if (!title) return undefined;
	const dependsOn = [
		...new Set(task.dependsOn.filter((id): id is string => typeof id === "string" && id.trim().length > 0)),
	].slice(0, AIRA_TASK_MAX_DEPENDENCIES);
	return {
		id: task.id.slice(0, 160),
		title,
		status: task.status,
		source: task.source,
		dependsOn,
		...(typeof task.note === "string" && task.note.trim()
			? { note: bound(task.note, AIRA_TASK_MAX_NOTE_CHARS) }
			: {}),
		createdAt: finiteTime(task.createdAt),
		...(typeof task.startedAt === "number" ? { startedAt: finiteTime(task.startedAt) } : {}),
		...(typeof task.completedAt === "number" ? { completedAt: finiteTime(task.completedAt) } : {}),
	};
}

function toPersistedTask(task: AiraTask & { source: Exclude<AiraTaskSource, "child"> }): AiraPersistedTask {
	return {
		id: task.id,
		title: task.title,
		status: task.status === "blocked" || task.status === "failed" ? "pending" : task.status,
		source: task.source,
		dependsOn: task.dependsOn.slice(0, AIRA_TASK_MAX_DEPENDENCIES),
		...(task.note ? { note: task.note } : {}),
		createdAt: task.createdAt,
		...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
		...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
	};
}

function bound(value: string, max: number): string {
	const trimmed = value.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function finiteTime(value: number): number {
	return Number.isFinite(value) ? value : Date.now();
}

function safeSessionFileName(sessionId: string): string {
	const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
	return safe || "session";
}

function boundedError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length <= 200 ? message : `${message.slice(0, 199)}…`;
}
