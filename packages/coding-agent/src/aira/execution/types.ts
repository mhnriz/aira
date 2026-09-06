/**
 * Aira execution — shared types.
 *
 * The runtime's public contract: what a process is, how it was requested,
 * how it ended, and what evidence an execution produced. These shapes feed
 * the canonical state snapshot (status.ts), the model-facing tools, and
 * later supervision (Phase 8) — deliberately structured rather than raw
 * strings.
 */
import type { ChildProcess } from "node:child_process";
import type { BoundedOutputBuffer } from "./buffer.ts";
import type { AiraProcessSnapshot } from "./status.ts";

/** Why a process was launched (canonical, small vocabulary). */
export type AiraProcessPurpose = "run" | "test" | "build" | "check" | "dev" | "other";

/** How the runtime manages the process. */
export type AiraProcessMode = "foreground" | "background";

/** Lifecycle truth of a process record. */
export type AiraProcessStatus = "running" | "exited" | "terminated" | "spawn-failed";

/** Bounded lifecycle fact for local interactive authentication. */
export type AiraInteractiveAuthStatus = "requested" | "succeeded" | "failed" | "cancelled" | "unavailable";

/** Why a process stopped being running. */
export type AiraExitReason =
	| "exit"
	| "signal"
	| "timeout"
	| "cancelled"
	| "user"
	| "session-end"
	| "restart"
	| "spawn-error";

/** How a command was requested: shell string or direct executable + args. */
export interface AiraProcessRequest {
	/** Shell command (bash -c form). Mutually exclusive with `exe`. */
	command?: string;
	/** Executable spawned directly (no shell). Mutually exclusive with `command`. */
	exe?: string;
	/** Arguments for `exe` (ignored with `command`). */
	args?: readonly string[];
	/** Working directory. */
	cwd: string;
	/** Environment overrides on top of the host shell env. */
	env?: Readonly<Record<string, string>>;
}

export interface BoundedLogTail {
	text: string;
	truncated: boolean;
}

/** Bounded evidence of one execution. */
export interface AiraExecutionResult {
	status: "exited" | "terminated" | "timed-out" | "cancelled" | "spawn-failed" | "backgrounded" | "unavailable";
	/** True when the outcome is a success: exited 0 / backgrounded / reused. */
	ok: boolean;
	/** Display command. */
	command: string;
	cwd: string;
	startedAt: number;
	durationMs: number;
	/** Exit code when the process exited; signal exits use the shell convention 128 + signal number. */
	exitCode?: number | null;
	/** Fatal signal when the process died from one. */
	signal?: string | null;
	/** Managed-process id, when this execution produced or reused one. */
	processId?: string;
	/** Bounded stdout tail (truncation flagged; full logs via the manager). */
	stdout: BoundedLogTail;
	/** Bounded stderr tail (truncation flagged; full logs via the manager). */
	stderr: BoundedLogTail;
	/** Human-readable explanation for non-obvious outcomes (spawn errors, etc.). */
	reason?: string;
	/** True when an existing running process was reused instead of launched. */
	reused?: boolean;
	/** True when a previous matching process was restarted. */
	restarted?: boolean;
	/** Non-secret local authentication lifecycle fact, when applicable. */
	interactiveAuth?: AiraInteractiveAuthStatus;
}

/** Options for `start()` (how the manager should run the request). */
export interface AiraStartOptions {
	/**
	 * Foreground (default): wait for completion; returns a full
	 * `AiraExecutionResult`. Background: launch and return immediately with a
	 * managed process id. Auto: run foreground until `autoBackgroundMs`
	 * elapses with the process still alive, then reclassify it as a managed
	 * background process and return a backgrounded result (documented
	 * auto-background contract).
	 */
	mode?: "foreground" | "background" | "auto";
	/** Timeout for foreground runs / bounded background runs. None by default. */
	timeoutMs?: number;
	/**
	 * Reuse policy (only for `dev` purpose): "new" (default) always launches;
	 * "reuse" returns the still-running, same-command/same-cwd managed dev
	 * process if one exists; "restart" terminates a matching one first.
	 */
	reuse?: "new" | "reuse" | "restart";
	/** Cancellation for the foreground phase; ignored once backgrounded. */
	signal?: AbortSignal;
	purpose?: AiraProcessPurpose;
	/** Allocate a local terminal-backed session for host/UI input. */
	interactive?: boolean;
}

/**
 * Local-only input bridge for interactive processes.
 *
 * The prompt is a bounded, non-secret label. The returned value is written
 * directly to the PTY and is never part of an Aira tool result or snapshot.
 */
export interface AiraInteractiveInputBridge {
	requestSecret(prompt: string, signal: AbortSignal): Promise<string | undefined>;
}

/** Full managed-process record (process manager's source of truth). */
export interface AiraProcessRecord {
	id: string;
	request: AiraProcessRequest;
	purpose: AiraProcessPurpose;
	mode: AiraProcessMode;
	/** Session id that owns this record (owner session). */
	ownerSessionId: string;
	createdAt: number;
	startedAt: number;
	pid?: number;
	status: AiraProcessStatus;
	exitCode?: number | null;
	exitSignal?: string | null;
	exitReason?: AiraExitReason;
	exitedAt?: number;
	terminatedAt?: number;
	/** True when termination was requested (grace → forced). */
	terminating?: boolean;
	/** True when a termination is pending forced escalation. */
	forcePending?: boolean;
	/** True when the OS confirmed exit via an event (truthful reporting). */
	exitConfirmed?: boolean;
	/** True when this record was reused instead of launched. */
	reused?: boolean;
	/** When the record escalated from foreground to background (auto mode). */
	backgroundedAt?: number;
	/** True when the process is attached to a local interactive terminal bridge. */
	interactive?: boolean;
	/** Non-secret local authentication lifecycle fact. */
	interactiveAuth?: AiraInteractiveAuthStatus;
	/** Internal: a secret was submitted to the PTY; OS authentication is not yet confirmed. */
	interactiveAuthAttempted?: boolean;
	/** True while the local bridge is collecting input. */
	interactiveInputPending?: boolean;
	/** Bounded non-secret prompt label, when input is required. */
	interactivePrompt?: string;
	/** Internal cancellation for a pending local input request. */
	interactiveInputAbort?: AbortController;
	/** Spawn-failure error message. */
	spawnError?: string;
	stdout: BoundedOutputBuffer;
	stderr: BoundedOutputBuffer;
	/** Internal: resolved when the OS confirms exit (value: exit code). */
	exitPromise: Promise<number | null>;
	/** Internal: resolves `exitPromise` (set by the manager). */
	exitPromiseResolve: (code: number | null) => void;
	/** Internal: the live child process handle. */
	child?: ChildProcess;
}

/** Execution lifecycle events (minimal bus for later supervision). */
export type AiraExecutionEvent =
	| { type: "process_started"; processId: string; record: AiraProcessSnapshot }
	| { type: "process_backgrounded"; processId: string; record: AiraProcessSnapshot }
	| { type: "process_exited"; processId: string; record: AiraProcessSnapshot };

/** Display command for a request (shell string or exe + args). */
export function displayCommand(request: AiraProcessRequest): string {
	if (request.command !== undefined) {
		return request.command;
	}
	return [request.exe ?? "", ...(request.args ?? [])].filter((part) => part.length > 0).join(" ");
}

/** The runtime's public handle (owned by AgentSession; consumed by tools/host). */
export interface AiraExecutionHandle {
	/** Session working directory (root for relative cwd resolution). */
	sessionCwd: string;
	start(request: AiraProcessRequest, options?: AiraStartOptions): Promise<AiraExecutionResult>;
	get(id: string): AiraProcessRecord | undefined;
	list(): readonly AiraProcessRecord[];
	logs(id: string, tailChars?: number): { stdout: BoundedLogTail; stderr: BoundedLogTail } | undefined;
	/** Write local UI input to an interactive process; input is never model-visible or persisted. */
	writeInput(id: string, input: string): boolean;
	/** Attach a local-only secret input bridge; never available to model tools. */
	attachInteractiveInputBridge?(bridge: AiraInteractiveInputBridge): void;
	/** Detach the local-only secret input bridge. */
	detachInteractiveInputBridge?(): void;
	terminate(id: string, reason?: "user" | "timeout" | "cancelled" | "restart"): Promise<AiraProcessRecord | undefined>;
	subscribe(listener: (event: AiraExecutionEvent) => void): () => void;
	dispose(): Promise<void>;
}
