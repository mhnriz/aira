/**
 * Aira core — canonical session state.
 *
 * Phase 1 scope: one canonical Aira state owner per Pi session, deliberately
 * small. Future phases extend this shape (mode switching, project profiles,
 * capability providers) without replacing the ownership model.
 *
 * Ownership rule: one canonical state exists per session id. Acquisition is
 * explicit (session created) and returns an owner handle; release is explicit
 * (session disposed) and ownership-checked, so stale owners cannot dispose
 * state that a newer session over the same file has acquired. Getting and
 * transitioning state goes through this module so no subsystem can hold a
 * competing copy of the truth.
 */

import type { AiraBrowserStatus } from "./browser/status.ts";
import type { AiraExecutionStatus } from "./execution/status.ts";
import type { AiraIntelligenceStatus } from "./intelligence/status.ts";
import type { AiraProjectProfile } from "./project/profile.ts";

export type AiraMode = "build" | "plan" | "review";
export type AiraRuntimeStatus = "active" | "disposed";
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
	/** Native interaction mode; cycle/set via the modes module (Shift+Tab). */
	mode: AiraMode;
	/** "active" while the session lives; "disposed" after host teardown. */
	runtime: AiraRuntimeStatus;
	/** Detected project profile; undefined until the host resolves it. */
	project: AiraProjectProfile | undefined;
	/** Intelligence health snapshot; undefined until the coordinator runs. */
	intelligence: AiraIntelligenceStatus | undefined;
	/** Execution runtime snapshot; undefined until the runtime publishes. */
	execution: AiraExecutionStatus | undefined;
	/** Browser runtime snapshot; undefined until the runtime publishes. */
	browser: AiraBrowserStatus | undefined;
	/** Phase 1: always ["core"]. */
	capabilities: readonly AiraCapability[];
	/** Set when the owning session was disposed. */
	disposedAt?: number;
}

export const DEFAULT_AIRA_MODE: AiraMode = "build";
export const DEFAULT_AIRA_CAPABILITIES: readonly AiraCapability[] = ["core"];

const sessionStates = new Map<string, AiraSessionState>();

/**
 * Create the canonical state for a session.
 *
 * The host allows two live AgentSessions over the same session file (e.g. a
 * session resumed by one runtime while another runtime still holds it). When
 * an ACTIVE entry already exists, ownership transfers to the newest acquirer:
 * the previous owner's state object becomes stale, and its later dispose is a
 * no-op because it no longer matches the registry entry. This keeps one
 * canonical state per session id without breaking valid host lifecycles.
 */
export function acquireAiraSessionState(
	sessionId: string,
	startReason: AiraSessionStartReason = "startup",
): AiraSessionState {
	const state: AiraSessionState = {
		sessionId,
		startReason,
		createdAt: Date.now(),
		mode: DEFAULT_AIRA_MODE,
		runtime: "active",
		project: undefined,
		intelligence: undefined,
		execution: undefined,
		browser: undefined,
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
 * Ownership-checked: only the caller that acquired the CURRENT registry entry
 * may dispose it. A stale owner (whose state was replaced by a newer acquire)
 * disposing later is a no-op, so overlapping live sessions cannot kill each
 * other's state. Idempotent: releasing an unknown, already disposed, or
 * non-owned entry is a no-op.
 *
 * @returns true when an active, owned entry was transitioned by this call.
 */
export function disposeAiraSessionState(sessionId: string, owner: AiraSessionState): boolean {
	const state = sessionStates.get(sessionId);
	if (!state || state !== owner || state.runtime === "disposed") {
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
