/**
 * Aira goal — bounded persistence.
 *
 * Unlike Phase 9's ephemeral child runs, goal state earns LIGHTWEIGHT
 * durability: a single bounded machine-readable JSON file per session under
 * the canonical Aira cache (`~/.aira/agent/cache/goals/<sessionId>.json`).
 * No transcripts, no task-graph duplication, no session files touched.
 *
 * Semantics:
 * - Written on every meaningful lifecycle transition (promote, stop, wait,
 *   complete, budget-limit, cancel, error) and on dispose of an active goal
 *   (persisted as `paused` with reason `interrupted` so a restart never
 *   silently auto-resumes).
 * - Recovered on session start with reason `startup` or `resume` when the
 *   persisted file belongs to THIS session id. `new` and `fork` sessions
 *   have different session ids and never inherit a goal (ownership rule).
 * - A persisted goal whose status was running-class at crash time is
 *   recovered as `paused` (`interrupted`) — explicit user action resumes.
 * - Persistence failure degrades gracefully: the goal stays runtime-owned
 *   and the snapshot reports `persistence.status = "failed"` (never traps
 *   the user, never throws).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAiraCacheDir } from "../paths.ts";
import {
	AIRA_GOAL_PERSISTED_STATE_VERSION,
	AIRA_GOAL_RUNNING_STATUSES,
	type AiraGoalStatus,
	type AiraGoalStopReason,
	type AiraGoalWaiting,
	type AiraPersistedGoal,
} from "./types.ts";

export interface AiraGoalPersistenceRecord {
	/** "ok" | "unavailable" | "failed" (bounded health for /doctor). */
	status: "ok" | "unavailable" | "failed";
	/** Bounded last failure reason. */
	error: string | undefined;
	/** Storage path when derivable. */
	path: string | undefined;
}

export interface AiraGoalPersistableState {
	id: string;
	objective: string;
	status: AiraGoalStatus;
	round: number;
	startedAt: number;
	updatedAt: number;
	completedAt: number | undefined;
	stopReason: AiraGoalStopReason | undefined;
	waiting: AiraGoalWaiting | undefined;
	lastVerdict: "pass" | "fail" | "inconclusive" | undefined;
	sessionTokens: number | undefined;
}

export interface AiraGoalPersistence {
	/** Path of this goal's persisted state file. */
	path: string;
	/** Load persisted state for the session; undefined when absent/unreadable. */
	load(): AiraPersistedGoal | undefined;
	/** Persist the goal state (bounded, atomic-ish write). Returns health. */
	save(state: AiraGoalPersistableState): AiraGoalPersistenceRecord;
	/** Remove the persisted state (clear). Returns health. */
	clear(): AiraGoalPersistenceRecord;
	/** Recover a persisted goal into resumable runtime semantics. */
	recover(): AiraGoalPersistableState | undefined;
}

/** Session start reasons that may recover a persisted goal. */
const RECOVERY_REASONS = new Set(["startup", "resume"]);

export function createAiraGoalPersistence(
	sessionId: string,
	startReason: string,
	options: { enabled?: boolean; baseDir?: string } = {},
): AiraGoalPersistence {
	const baseDir = options.baseDir ?? join(getAiraCacheDir(), "goals");
	const path = join(baseDir, `${safeSessionFileName(sessionId)}.json`);

	const load = (): AiraPersistedGoal | undefined => {
		try {
			const raw = readFileSync(path, "utf-8");
			const parsed = JSON.parse(raw) as AiraPersistedGoal;
			if (!parsed || typeof parsed !== "object" || parsed.version !== AIRA_GOAL_PERSISTED_STATE_VERSION) {
				return undefined;
			}
			if (parsed.sessionId !== sessionId || !parsed.goal || typeof parsed.goal !== "object") {
				return undefined;
			}
			return parsed;
		} catch {
			return undefined;
		}
	};

	const save = (state: AiraGoalPersistableState): AiraGoalPersistenceRecord => {
		if (options.enabled === false) {
			return { status: "unavailable", error: undefined, path };
		}
		try {
			mkdirSync(baseDir, { recursive: true });
			const record: AiraPersistedGoal = {
				version: AIRA_GOAL_PERSISTED_STATE_VERSION,
				sessionId,
				goal: {
					id: state.id,
					objective: state.objective,
					status: state.status,
					round: state.round,
					startedAt: state.startedAt,
					updatedAt: state.updatedAt,
					...(state.completedAt !== undefined ? { completedAt: state.completedAt } : {}),
					...(state.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
					...(state.waiting !== undefined ? { waiting: state.waiting } : {}),
					...(state.lastVerdict !== undefined ? { lastVerdict: state.lastVerdict } : {}),
					...(state.sessionTokens !== undefined ? { sessionTokens: state.sessionTokens } : {}),
				},
			};
			writeFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
			return { status: "ok", error: undefined, path };
		} catch (error) {
			return { status: "failed", error: boundedError(error), path };
		}
	};

	const clear = (): AiraGoalPersistenceRecord => {
		try {
			rmSync(path, { force: true });
			return { status: "ok", error: undefined, path };
		} catch (error) {
			return { status: "failed", error: boundedError(error), path };
		}
	};

	const recover = (): AiraGoalPersistableState | undefined => {
		if (!RECOVERY_REASONS.has(startReason)) {
			return undefined;
		}
		const persisted = load();
		if (!persisted) {
			return undefined;
		}
		const goal = persisted.goal;
		// A running-class goal persisted at crash time never auto-resumes.
		const status: AiraGoalStatus = AIRA_GOAL_RUNNING_STATUSES.includes(goal.status) ? "paused" : goal.status;
		return {
			id: goal.id,
			objective: goal.objective,
			status,
			round: goal.round,
			startedAt: goal.startedAt,
			updatedAt: Date.now(),
			completedAt: goal.completedAt,
			stopReason: AIRA_GOAL_RUNNING_STATUSES.includes(goal.status) ? "interrupted" : goal.stopReason,
			waiting: goal.waiting,
			lastVerdict: goal.lastVerdict,
			sessionTokens: goal.sessionTokens,
		};
	};

	return { path, load, save, clear, recover };
}

function safeSessionFileName(sessionId: string): string {
	// Session ids may contain path-ish characters; keep the file name bounded
	// and filesystem-safe (hash preserved for debuggability).
	const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
	return safe.length > 0 ? safe : `session-${randomUUID()}`;
}

function boundedError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length <= 200 ? message : `${message.slice(0, 199)}…`;
}
