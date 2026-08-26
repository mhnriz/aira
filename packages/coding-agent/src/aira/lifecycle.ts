/**
 * Aira core — host lifecycle bridge.
 *
 * The complete set of narrow seams between the Pi-derived host and the Aira
 * subsystem, Phase 1:
 *
 * ```text
 * Pi host                                  Aira bridge            Aira subsystem
 * AgentSession constructor            →   onAiraSessionCreated → acquireAiraSessionState
 * AgentSession.dispose()
 *   → cleanupSessionResources(id)     →   onAiraSessionDisposed → disposeAiraSessionState
 * ```
 *
 * - Creation: `AgentSession`'s constructor calls `onAiraSessionCreated` with
 *   the session id and its `SessionStartEvent` reason ("startup", "new",
 *   "fork", "resume"). Every session creation path in every mode (interactive,
 *   print, rpc, SDK) goes through that constructor.
 *
 * - Disposal: no new host wiring is needed. `AgentSession.dispose()` already
 *   routes every teardown (quit, `/new`, `/fork`, `/resume`, `/import`
 *   replacement) through pi-ai's per-session resource cleanup registry, so the
 *   registration below is the single release seam.
 *
 * There is deliberately no event bus yet: Phase 1 lifecycle is exactly
 * created → disposed, and the two functions below are the whole contract.
 */
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import {
	type AiraSessionStartReason,
	type AiraSessionState,
	acquireAiraSessionState,
	disposeAiraSessionState,
} from "./state.ts";

/** Host seam: a session was created. Returns the new canonical state. */
export function onAiraSessionCreated(sessionId: string, startReason: AiraSessionStartReason): AiraSessionState {
	return acquireAiraSessionState(sessionId, startReason);
}

/** Host seam: a session was disposed. */
export function onAiraSessionDisposed(sessionId: string): void {
	disposeAiraSessionState(sessionId);
}

// Release wiring: pi-ai invokes this for the owning session whenever
// AgentSession.dispose() runs (session quit or replacement). Guarded against
// undefined because the registry contract allows a missing session id.
registerSessionResourceCleanup((sessionId) => {
	if (sessionId) {
		onAiraSessionDisposed(sessionId);
	}
});
