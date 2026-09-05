import type { AiraInteractiveAuthStatus } from "./types.ts";

/**
 * Aira execution — canonical-state snapshot shapes.
 *
 * `AiraExecutionStatus` is the bounded health/evidence snapshot the execution
 * runtime publishes into `AiraSessionState.execution` (ADR-005: one canonical
 * state owner). It carries process summaries and a bounded list of recent
 * execution results — never full log contents. Logs stay in the runtime and
 * are accessed through the manager (`logs()`); the snapshot exists so the
 * host (`/doctor`, diagnostics, later supervision) can observe execution
 * health cheaply and truthfully.
 */

export interface AiraProcessSnapshot {
	id: string;
	purpose: string;
	mode: "foreground" | "background";
	status: "running" | "exited" | "terminated" | "spawn-failed";
	/** Display command (shell string or exe + args). */
	command: string;
	cwd: string;
	pid?: number;
	createdAt: number;
	startedAt?: number;
	exitedAt?: number;
	terminatedAt?: number;
	exitCode?: number | null;
	exitSignal?: string | null;
	exitReason?: string;
	/** True when this record was reused instead of launched. */
	reused?: boolean;
	/** True when this record has a local terminal input bridge. */
	interactive?: boolean;
	/** Non-secret local authentication lifecycle fact. */
	interactiveAuth?: AiraInteractiveAuthStatus;
	/** True while the local bridge is collecting input. */
	interactiveInputPending?: boolean;
	/** Bounded non-secret prompt label, when input is required. */
	interactivePrompt?: string;
}

export interface AiraExecutionResultSummary {
	status: "exited" | "terminated" | "timed-out" | "cancelled" | "spawn-failed" | "backgrounded" | "unavailable";
	ok: boolean;
	command: string;
	cwd: string;
	startedAt: number;
	durationMs: number;
	exitCode?: number | null;
	processId?: string;
	reason?: string;
}

export interface AiraExecutionStatus {
	/** True when the session's execution runtime is armed. */
	active: boolean;
	/** True when the runtime hit an internal error and degraded. */
	degraded: boolean;
	/** Bounded process table (records are capped, oldest exited evicted). */
	processes: AiraProcessSnapshot[];
	/** Bounded recent execution evidence (results are capped). */
	recentResults: AiraExecutionResultSummary[];
}

export function initialAiraExecutionStatus(): AiraExecutionStatus {
	return {
		active: false,
		degraded: false,
		processes: [],
		recentResults: [],
	};
}
