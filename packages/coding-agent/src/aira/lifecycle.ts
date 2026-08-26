/**
 * Aira core — host lifecycle bridge.
 *
 * The complete set of narrow seams between the Pi-derived host and the Aira
 * subsystem, Phase 1:
 *
 * ```text
 * Pi host                                Aira bridge            Aira subsystem
 * AgentSession constructor          →   onAiraSessionCreated → acquireAiraSessionState
 * AgentSession.dispose()            →   onAiraSessionDisposed → disposeAiraSessionState
 * ```
 *
 * - Creation: `AgentSession`'s constructor calls `onAiraSessionCreated` with
 *   the session id and its `SessionStartEvent` reason ("startup", "new",
 *   "fork", "resume") and keeps the returned state as its ownership handle.
 *   Every session creation path in every mode (interactive, print, rpc, SDK)
 *   goes through that constructor.
 *
 * - Disposal: `AgentSession.dispose()` calls `onAiraSessionDisposed` with the
 *   same handle. Disposal is ownership-checked: when two live sessions overlap
 *   over the same session file (resume while another runtime still holds it),
 *   the later acquire owns the canonical state and the stale owner's disposal
 *   is a no-op.
 *
 * There is deliberately no event bus yet: Phase 1 lifecycle is exactly
 * created → disposed, and the two functions below are the whole contract.
 */
import {
	type AiraSessionStartReason,
	type AiraSessionState,
	acquireAiraSessionState,
	disposeAiraSessionState,
} from "./state.ts";

/** Host seam: a session was created. Returns the session's canonical state (ownership handle). */
export function onAiraSessionCreated(sessionId: string, startReason: AiraSessionStartReason): AiraSessionState {
	return acquireAiraSessionState(sessionId, startReason);
}

/** Host seam: a session was disposed. No-op for stale owners or unknown sessions. */
export function onAiraSessionDisposed(sessionId: string, owner: AiraSessionState): void {
	disposeAiraSessionState(sessionId, owner);
}
