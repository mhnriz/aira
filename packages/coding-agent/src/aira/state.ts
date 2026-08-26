/**
 * Aira core — canonical session state.
 *
 * Phase 1 scope: one canonical Aira state owner per Pi session, deliberately
 * small. Future phases extend this shape (mode switching, project profiles,
 * capability providers) without replacing the ownership model.
 *
 * Ownership rule: a session id has at most one ACTIVE state at any time.
 * Acquisition is explicit (session created), release is explicit (session
 * disposed). Getting and transitioning state goes through this module so no
 * subsystem can hold a competing copy of the truth.
 */

export type AiraMode = "build" | "plan" | "review";
export type AiraRuntimeStatus = "active" | "disposed";
export type AiraProjectStatus = "unresolved";
export type AiraCapability = "core";
/** Mirrors the Pi host SessionStartEvent reasons. */
export type AiraSessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

export interface AiraSessionState {
	/** Owning Pi session id. The key of canonical state. */
	readonly sessionId: string;
	/** How the owning session started (startup | new | fork | resume | ...). */
	readonly startReason: AiraSessionStartReason;
	/** When this state was acquired (ms since epoch). */
	readonly createdAt: number;
	/** Phase 1: always "build". */
	mode: AiraMode;
	/** "active" while the session lives; "disposed" after host teardown. */
	runtime: AiraRuntimeStatus;
	/** Phase 1: always "unresolved" (project awareness is a later phase). */
	project: AiraProjectStatus;
	/** Phase 1: always ["core"]. */
	capabilities: readonly AiraCapability[];
	/** Set when the owning session was disposed. */
	disposedAt?: number;
}

export const DEFAULT_AIRA_MODE: AiraMode = "build";
export const DEFAULT_AIRA_PROJECT: AiraProjectStatus = "unresolved";
export const DEFAULT_AIRA_CAPABILITIES: readonly AiraCapability[] = ["core"];

const sessionStates = new Map<string, AiraSessionState>();

/**
 * Create the canonical state for a session.
 *
 * @throws when an ACTIVE state already exists for the same session id — a
 * second owner for a live session is a lifecycle bug and must surface loudly.
 * A disposed state for the same id (e.g. the same session file resumed again)
 * may be re-acquired: the previous owner was explicitly released.
 */
export function acquireAiraSessionState(
	sessionId: string,
	startReason: AiraSessionStartReason = "startup",
): AiraSessionState {
	const existing = sessionStates.get(sessionId);
	if (existing?.runtime === "active") {
		throw new Error(`Aira session state already exists for active session "${sessionId}"`);
	}

	const state: AiraSessionState = {
		sessionId,
		startReason,
		createdAt: Date.now(),
		mode: DEFAULT_AIRA_MODE,
		runtime: "active",
		project: DEFAULT_AIRA_PROJECT,
		capabilities: DEFAULT_AIRA_CAPABILITIES,
	};
	sessionStates.set(sessionId, state);
	return state;
}

/** Retrieve the canonical state for a session, if any. */
export function getAiraSessionState(sessionId: string): AiraSessionState | undefined {
	return sessionStates.get(sessionId);
}

/**
 * Release the canonical state for a session.
 *
 * Marks the state disposed rather than deleting it, so tests and diagnostics
 * can observe the transition. Idempotent: releasing an unknown or already
 * disposed session is a no-op.
 *
 * @returns true when an active state was transitioned by this call.
 */
export function disposeAiraSessionState(sessionId: string): boolean {
	const state = sessionStates.get(sessionId);
	if (!state || state.runtime === "disposed") {
		return false;
	}
	state.runtime = "disposed";
	state.disposedAt = Date.now();
	return true;
}

/** All currently active states (one per live session). Diagnostics/testing use. */
export function getActiveAiraSessionStates(): readonly AiraSessionState[] {
	return [...sessionStates.values()].filter((state) => state.runtime === "active");
}
