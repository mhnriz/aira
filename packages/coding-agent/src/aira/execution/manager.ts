/**
 * Aira execution — process manager (the runtime owner).
 *
 * One manager exists per AgentSession (per-session runtime). It launches
 * shell and direct-executable processes, owns their lifecycle, captures
 * bounded stdout/stderr, tracks truthful status, terminates gracefully with
 * forced fallback, exposes logs, and publishes a bounded snapshot into
 * canonical session state (`state.execution`).
 *
 * Ownership contract (ADR-024):
 * - Every record carries `ownerSessionId` and belongs to exactly one
 *   manager instance (the session that launched it).
 * - A session's dispose() terminates ONLY its own manager's processes.
 *   Two overlapping sessions over the same session file therefore cannot
 *   kill each other's processes: stale-session disposal kills only what the
 *   stale session launched.
 * - Reuse (`reuse: "reuse"`) considers only this manager's own still-running
 *   `dev` processes with identical cwd+command. Arbitrary OS processes are
 *   never adopted.
 * - Records are bounded: exited records are evicted oldest-first past
 *   `maxRecords`. Log buffers are capped per stream. No durable persistence
 *   across application restarts (Phase 6 scope).
 */
import { spawn } from "node:child_process";
import { stripAnsi } from "../../utils/ansi.ts";
import { getShellConfig, getShellEnv, sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { AiraSessionState } from "../state.ts";
import { BoundedOutputBuffer, DEFAULT_EXECUTION_LOG_BYTES } from "./buffer.ts";
import { createProcessTerminator, type KillEffects, type ProcessTerminator } from "./platform.ts";
import { type AiraExecutionStatus, type AiraProcessSnapshot, initialAiraExecutionStatus } from "./status.ts";
import {
	type AiraExecutionEvent,
	type AiraExecutionResult,
	type AiraProcessPurpose,
	type AiraProcessRecord,
	type AiraProcessRequest,
	type AiraStartOptions,
	displayCommand,
} from "./types.ts";

/** Output still draining after exit is given up to this long (quiet pipe). */
const EXIT_STDIO_GRACE_MS = 150;

export interface AiraExecutionManagerOptions {
	/** Per-stream log byte cap (default 128 KiB). */
	maxLogBytesPerStream?: number;
	/** Tail characters included in execution results (default 6000). */
	resultTailChars?: number;
	/** Auto-background threshold in ms (default 20s). */
	autoBackgroundMs?: number;
	/** Grace period between graceful and forced termination (default 1500ms). */
	terminateGraceMs?: number;
	/** Max retained records (default 32; oldest exited evicted). */
	maxRecords?: number;
	/** Max retained recent results in the snapshot (default 8). */
	maxRecentResults?: number;
	/** Injectable platform for the termination strategy (tests). */
	platform?: NodeJS.Platform;
	/** Injectable kill effects (tests). */
	killEffects?: KillEffects;
	/** Injectable clock (tests). */
	now?: () => number;
	/** Injectable env (tests). */
	env?: () => NodeJS.ProcessEnv;
	/** Injectable shell config resolver (tests). */
	shellConfig?: () => ReturnType<typeof getShellConfig>;
	/** Injectable spawn (tests). */
	spawnImpl?: typeof spawn;
}

const FORCE_WAIT_MS = 3000;

const PURPOSE_PREFIX: Record<AiraProcessPurpose, string> = {
	run: "run",
	test: "test",
	build: "build",
	check: "check",
	dev: "dev",
	other: "proc",
};

export class AiraExecutionManager {
	private readonly state: AiraSessionState;
	/** Session working directory (root for relative cwd resolution). */
	readonly sessionCwd: string;
	private readonly options: Required<
		Pick<
			AiraExecutionManagerOptions,
			| "maxLogBytesPerStream"
			| "resultTailChars"
			| "autoBackgroundMs"
			| "terminateGraceMs"
			| "maxRecords"
			| "maxRecentResults"
		>
	> &
		AiraExecutionManagerOptions;
	private readonly records = new Map<string, AiraProcessRecord>();
	private readonly listeners = new Set<(event: AiraExecutionEvent) => void>();
	private readonly timeoutTimers = new Map<string, NodeJS.Timeout>();
	private readonly recentResults: AiraExecutionResult[] = [];
	private idCounter = 0;
	private disposed = false;
	private degraded = false;
	private disposePromise: Promise<void> | undefined;
	private status: AiraExecutionStatus = initialAiraExecutionStatus();
	private readonly terminator: ProcessTerminator;
	private readonly now: () => number;

	constructor(state: AiraSessionState, sessionCwd: string, options: AiraExecutionManagerOptions = {}) {
		this.state = state;
		this.sessionCwd = sessionCwd;
		this.options = {
			maxLogBytesPerStream: DEFAULT_EXECUTION_LOG_BYTES,
			resultTailChars: 6000,
			autoBackgroundMs: 20_000,
			terminateGraceMs: 1500,
			maxRecords: 32,
			maxRecentResults: 8,
			...options,
		};
		this.now = options.now ?? (() => Date.now());
		this.terminator = createProcessTerminator(options.platform ?? process.platform, options.killEffects);
		this.publish();
	}

	// =========================================================================
	// Launch
	// =========================================================================

	async start(request: AiraProcessRequest, options: AiraStartOptions = {}): Promise<AiraExecutionResult> {
		const now = this.now();
		if (this.disposed) {
			return unavailableResult(request, now, "execution runtime is disposed");
		}
		const purpose = options.purpose ?? requestPurposeHint(request);
		if (options.reuse === "reuse" || options.reuse === "restart") {
			const existing = this.findReusable(request, purpose);
			if (existing && options.reuse === "reuse") {
				const result: AiraExecutionResult = {
					status: "backgrounded",
					ok: true,
					command: displayCommand(request),
					cwd: request.cwd,
					startedAt: existing.startedAt,
					durationMs: now - existing.startedAt,
					processId: existing.id,
					stdout: { text: "", truncated: false },
					stderr: { text: "", truncated: false },
					reused: true,
				};
				this.pushRecent(result);
				return result;
			}
			if (existing) {
				await this.terminate(existing.id, "restart");
			}
		}

		const record = this.newRecord(
			request,
			purpose,
			options.mode === "auto" ? "foreground" : (options.mode ?? "foreground"),
		);
		try {
			this.launch(record);
		} catch (err) {
			record.status = "spawn-failed";
			record.exitReason = "spawn-error";
			record.spawnError = err instanceof Error ? err.message : String(err);
			return this.resultOf(record);
		}
		this.records.set(record.id, record);
		this.publish();
		this.emit({ type: "process_started", processId: record.id, record: snapshotOf(record) });

		const mode = options.mode ?? "foreground";
		if (mode === "background") {
			this.armBackgroundTimeout(record, options.timeoutMs);
			return this.backgroundedResult(record);
		}
		if (mode === "auto") {
			return this.waitAuto(record, options);
		}
		return this.waitForeground(record, options);
	}

	/** Launch the child process; throws synchronously on invalid requests. */
	private launch(record: AiraProcessRecord): void {
		const env = { ...(this.options.env?.() ?? getShellEnv()), ...record.request.env };
		if (record.request.command !== undefined) {
			const shell = this.options.shellConfig?.() ?? getShellConfig();
			const commandFromStdin = shell.commandTransport === "stdin";
			const child = (this.options.spawnImpl ?? spawn)(
				shell.shell,
				commandFromStdin ? shell.args : [...shell.args, record.request.command],
				{
					cwd: record.request.cwd,
					detached: process.platform !== "win32",
					env,
					stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
					windowsHide: true,
				},
			);
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(record.request.command);
			}
			this.attach(record, child);
			return;
		}
		if (record.request.exe !== undefined) {
			const child = (this.options.spawnImpl ?? spawn)(record.request.exe, [...(record.request.args ?? [])], {
				cwd: record.request.cwd,
				detached: process.platform !== "win32",
				env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			this.attach(record, child);
			return;
		}
		throw new Error("process_start requires either command or exe");
	}

	private attach(record: AiraProcessRecord, child: ReturnType<typeof spawn>): void {
		record.child = child;
		record.pid = child.pid;
		const stdoutDecoder = new TextDecoder();
		const stderrDecoder = new TextDecoder();
		// Output may still be in flight when the process exits (a child of the
		// child may hold the pipe open). We must not resolve the exit promise
		// on `exit` alone or the result tail silently loses late output — the
		// same idle-grace the host bash tool uses. Finalize happens when both
		// streams ended, or when the pipe went quiet after exit.
		let exited = false;
		let stdoutEnded = false;
		let stderrEnded = false;
		let settled = false;
		let postExitTimer: NodeJS.Timeout | undefined;
		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			this.finalizeExit(record, code);
		};
		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(record.exitCode ?? null), EXIT_STDIO_GRACE_MS);
		};
		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(record.exitCode ?? null);
			}
		};
		const onData = () => {
			if (exited && !settled) armIdleTimer();
		};
		child.stdout?.on("data", (data: Buffer) => {
			record.stdout.append(decodeSanitized(stdoutDecoder, data));
			onData();
		});
		child.stderr?.on("data", (data: Buffer) => {
			record.stderr.append(decodeSanitized(stderrDecoder, data));
			onData();
		});
		child.stdout?.on("end", () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		});
		child.stderr?.on("end", () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		});
		child.stdout?.on("error", () => {});
		child.stderr?.on("error", () => {});
		child.once("error", (err: NodeJS.ErrnoException) => {
			// Spawn failure (ENOENT, EACCES, ...) — truthful non-success.
			record.spawnError = `${err.code ?? "error"}: ${err.message}`;
			record.status = "spawn-failed";
			record.exitReason = "spawn-error";
			record.exitConfirmed = true;
			record.exitedAt = this.now();
			finalize(null);
		});
		child.once("exit", (code, signal) => {
			exited = true;
			record.exitCode = code;
			record.exitSignal = signal;
			record.exitConfirmed = true;
			record.exitedAt = this.now();
			// The status transition happens HERE (exit time), deterministically:
			// a terminating record becomes "terminated", a natural one becomes
			// "exited". Callers awaiting the exit promise can then read a stable
			// status without racing the terminator's post-await bookkeeping.
			if (record.status === "running") {
				record.status = record.terminating ? "terminated" : "exited";
				record.exitReason ??= signal ? "signal" : "exit";
			}
			maybeFinalizeAfterExit();
			armIdleTimer();
		});
		child.once("close", (code) => {
			finalize(code ?? record.exitCode ?? null);
		});
	}

	private finalizeExit(record: AiraProcessRecord, code: number | null): void {
		record.exitPromiseResolve(code);
		this.publish();
		this.emit({ type: "process_exited", processId: record.id, record: snapshotOf(record) });
	}

	// =========================================================================
	// Foreground / background waits
	// =========================================================================

	private async waitForeground(record: AiraProcessRecord, options: AiraStartOptions): Promise<AiraExecutionResult> {
		const abort = this.attachAbort(record, options);
		this.armTimeout(record, options.timeoutMs);
		try {
			await record.exitPromise;
		} finally {
			if (abort) {
				options.signal?.removeEventListener("abort", abort);
			}
			this.clearTimer(record.id);
		}
		const result = this.resultOf(record);
		this.pushRecent(result);
		return result;
	}

	private async waitAuto(record: AiraProcessRecord, options: AiraStartOptions): Promise<AiraExecutionResult> {
		const abort = this.attachAbort(record, options);
		this.armTimeout(record, options.timeoutMs);
		try {
			const outcome = await Promise.race([
				record.exitPromise.then(() => "exit" as const),
				new Promise<"time">((resolve) => setTimeout(() => resolve("time"), this.options.autoBackgroundMs)),
			]);
			if (outcome === "time" && record.status === "running" && !record.terminating) {
				// Still alive past the threshold: this is a long-running
				// process. Escalate to managed background (documented
				// auto-background contract) and return its handle.
				record.mode = "background";
				record.backgroundedAt = this.now();
				this.publish();
				this.emit({ type: "process_backgrounded", processId: record.id, record: snapshotOf(record) });
				return this.backgroundedResult(record);
			}
			await record.exitPromise;
		} finally {
			if (abort) {
				options.signal?.removeEventListener("abort", abort);
			}
			this.clearTimer(record.id);
		}
		const result = this.resultOf(record);
		this.pushRecent(result);
		return result;
	}

	private attachAbort(record: AiraProcessRecord, options: AiraStartOptions): (() => void) | undefined {
		const signal = options.signal;
		if (!signal) {
			return undefined;
		}
		const onAbort = () => {
			void this.terminate(record.id, "cancelled");
		};
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
		return onAbort;
	}

	private armTimeout(record: AiraProcessRecord, timeoutMs: number | undefined): void {
		if (timeoutMs === undefined || timeoutMs <= 0) {
			return;
		}
		const timer = setTimeout(() => {
			this.timeoutTimers.delete(record.id);
			void this.terminate(record.id, "timeout");
		}, timeoutMs);
		this.timeoutTimers.set(record.id, timer);
	}

	private armBackgroundTimeout(record: AiraProcessRecord, timeoutMs: number | undefined): void {
		this.armTimeout(record, timeoutMs);
	}

	private clearTimer(id: string): void {
		const timer = this.timeoutTimers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.timeoutTimers.delete(id);
		}
	}

	// =========================================================================
	// Inspection
	// =========================================================================

	get(id: string): AiraProcessRecord | undefined {
		return this.records.get(id);
	}

	list(): readonly AiraProcessRecord[] {
		return [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	logs(
		id: string,
		tailChars = 4000,
	): { stdout: { text: string; truncated: boolean }; stderr: { text: string; truncated: boolean } } | undefined {
		const record = this.records.get(id);
		if (!record) {
			return undefined;
		}
		return {
			stdout: record.stdout.tail(tailChars),
			stderr: record.stderr.tail(tailChars),
		};
	}

	subscribe(listener: (event: AiraExecutionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	// =========================================================================
	// Termination
	// =========================================================================

	async terminate(
		id: string,
		reason: "user" | "timeout" | "cancelled" | "restart" | "session-end" = "user",
	): Promise<AiraProcessRecord | undefined> {
		const record = this.records.get(id);
		if (!record) {
			return undefined;
		}
		if (record.status !== "running") {
			// Already exited/spawn-failed: nothing to kill; leave the truthful
			// reason alone.
			return record;
		}
		record.terminating = true;
		record.exitReason = reason;
		const pid = record.pid;
		if (pid === undefined) {
			// Never got an OS pid (spawn failure path); nothing to kill.
			record.status = "terminated";
			record.terminatedAt = this.now();
			return record;
		}
		this.terminator.graceful(pid);
		const gracefulExited = await raceTimeout(record.exitPromise, this.options.terminateGraceMs);
		// Force-kill the group when the child did not exit politely, OR when
		// descendants may have survived the shell's exit (e.g. a grandchild
		// that ignored SIGTERM keeps the process group alive). Killing an
		// already-empty group is a no-op.
		if (!gracefulExited || this.terminator.hasSurvivors(pid)) {
			record.forcePending = true;
			this.terminator.forced(pid);
			if (!gracefulExited) {
				await raceTimeout(record.exitPromise, FORCE_WAIT_MS);
			}
		}
		record.forcePending = false;
		// The exit handler already transitions running→terminated at exit time;
		// for the no-exit-event path this is the final truthful transition.
		record.status = "terminated";
		record.terminatedAt = this.now();
		if (!record.exitConfirmed) {
			// The kill was delivered but no exit event arrived within the wait
			// window. Report truthfully: terminated (kill sent), exit
			// unconfirmed. A late exit event still updates the code.
			record.exitedAt ??= this.now();
		}
		this.publish();
		this.emit({ type: "process_exited", processId: record.id, record: snapshotOf(record) });
		return record;
	}

	// =========================================================================
	// Reuse
	// =========================================================================

	/** Reuse candidates: this manager's own running dev processes, same request. */
	private findReusable(request: AiraProcessRequest, purpose: AiraProcessPurpose): AiraProcessRecord | undefined {
		const candidates = [...this.records.values()].filter(
			(r) =>
				r.status === "running" &&
				r.purpose === "dev" &&
				purpose === "dev" &&
				r.mode === "background" &&
				r.request.cwd === request.cwd &&
				sameRequest(r.request, request),
		);
		if (candidates.length === 0) {
			return undefined;
		}
		candidates.sort((a, b) => b.createdAt - a.createdAt);
		return candidates[0];
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	async dispose(): Promise<void> {
		if (this.disposePromise) {
			return this.disposePromise;
		}
		this.disposePromise = (async () => {
			this.disposed = true;
			for (const timer of this.timeoutTimers.values()) {
				clearTimeout(timer);
			}
			this.timeoutTimers.clear();
			const running = [...this.records.values()].filter((r) => r.status === "running");
			if (running.length > 0) {
				await Promise.allSettled(running.map((r) => this.terminate(r.id, "session-end")));
			}
			this.publish();
			this.listeners.clear();
		})();
		return this.disposePromise;
	}

	// =========================================================================
	// Internals
	// =========================================================================

	private newRecord(
		request: AiraProcessRequest,
		purpose: AiraProcessPurpose,
		mode: "foreground" | "background",
	): AiraProcessRecord {
		this.idCounter += 1;
		const id = `${PURPOSE_PREFIX[purpose]}-${this.idCounter}`;
		const now = this.now();
		let resolveExit!: (code: number | null) => void;
		const exitPromise = new Promise<number | null>((resolve) => {
			resolveExit = resolve;
		});
		return {
			id,
			request,
			purpose,
			mode,
			ownerSessionId: this.state.sessionId,
			createdAt: now,
			startedAt: now,
			status: "running",
			stdout: new BoundedOutputBuffer(this.options.maxLogBytesPerStream),
			stderr: new BoundedOutputBuffer(this.options.maxLogBytesPerStream),
			exitPromise,
			exitPromiseResolve: resolveExit,
		};
	}

	private backgroundedResult(record: AiraProcessRecord): AiraExecutionResult {
		return {
			status: "backgrounded",
			ok: true,
			command: displayCommand(record.request),
			cwd: record.request.cwd,
			startedAt: record.startedAt,
			durationMs: (record.backgroundedAt ?? this.now()) - record.startedAt,
			processId: record.id,
			stdout: { text: "", truncated: false },
			stderr: { text: "", truncated: false },
		};
	}

	private resultOf(record: AiraProcessRecord): AiraExecutionResult {
		const startedAt = record.createdAt;
		const durationMs = (record.exitedAt ?? this.now()) - startedAt;
		const stdout = record.stdout.tail(this.options.resultTailChars);
		const stderr = record.stderr.tail(this.options.resultTailChars);
		if (record.status === "spawn-failed") {
			return {
				status: "spawn-failed",
				ok: false,
				command: displayCommand(record.request),
				cwd: record.request.cwd,
				startedAt,
				durationMs,
				processId: record.id,
				stdout,
				stderr,
				reason: record.spawnError,
			};
		}
		let status: AiraExecutionResult["status"];
		if (record.status === "terminated") {
			status =
				record.exitReason === "timeout"
					? "timed-out"
					: record.exitReason === "cancelled"
						? "cancelled"
						: "terminated";
		} else {
			status = "exited";
		}
		const ok = status === "exited" && record.exitCode === 0;
		return {
			status,
			ok,
			command: displayCommand(record.request),
			cwd: record.request.cwd,
			startedAt,
			durationMs,
			exitCode: record.exitCode,
			signal: record.exitSignal,
			processId: record.id,
			stdout,
			stderr,
			reason: status === "exited" ? undefined : record.exitReason,
		};
	}

	/** Record a final result into the bounded evidence list + snapshot (bounded). */
	private pushRecent(result: AiraExecutionResult): void {
		this.recentResults.push(result);
		while (this.recentResults.length > this.options.maxRecentResults) {
			this.recentResults.shift();
		}
		this.publish();
	}

	private publish(): void {
		this.status = buildExecutionSnapshot(
			this.records,
			this.recentResults,
			{
				active: !this.disposed,
				degraded: this.degraded,
			},
			this.options.maxRecords,
		);
		if (this.state.runtime !== "disposed") {
			this.state.execution = this.status;
		}
	}

	private emit(event: AiraExecutionEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// A listener must never break the runtime.
			}
		}
	}
}

/** Create the session's execution manager (host seam). */
export function createAiraExecutionManager(
	state: AiraSessionState,
	sessionCwd: string,
	options?: AiraExecutionManagerOptions,
): AiraExecutionManager {
	return new AiraExecutionManager(state, sessionCwd, options);
}

// =========================================================================
// Helpers
// =========================================================================

function raceTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		promise.then(
			() => finish(true),
			() => finish(false),
		);
		const timer = setTimeout(() => finish(false), ms);
		// Keep the timer from holding the event loop after resolution.
		promise.finally(() => clearTimeout(timer)).catch(() => {});
	});
}

function sameRequest(a: AiraProcessRequest, b: AiraProcessRequest): boolean {
	return (
		a.command === b.command &&
		a.exe === b.exe &&
		a.cwd === b.cwd &&
		(a.args?.length ?? 0) === (b.args?.length ?? 0) &&
		(a.args ?? []).every((arg, i) => arg === b.args?.[i])
	);
}

function requestPurposeHint(request: AiraProcessRequest): AiraProcessPurpose {
	const command = request.command ?? request.exe ?? "";
	if (/\b(test|spec)\b/.test(command)) return "test";
	if (/\b(build|compile)\b/.test(command)) return "build";
	if (/\b(check|lint|typecheck|tsc)\b/.test(command)) return "check";
	if (/\b(dev|serve|start|watch|run)\b/.test(command)) return "dev";
	return "run";
}

function decodeSanitized(decoder: InstanceType<typeof TextDecoder>, data: Buffer): string {
	return sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");
}

function unavailableResult(request: AiraProcessRequest, now: number, reason: string): AiraExecutionResult {
	return {
		status: "unavailable",
		ok: false,
		command: displayCommand(request),
		cwd: request.cwd,
		startedAt: now,
		durationMs: 0,
		stdout: { text: "", truncated: false },
		stderr: { text: "", truncated: false },
		reason,
	};
}

function snapshotOf(record: AiraProcessRecord): AiraProcessSnapshot {
	return {
		id: record.id,
		purpose: record.purpose,
		mode: record.mode,
		status: record.status,
		command: displayCommand(record.request),
		cwd: record.request.cwd,
		pid: record.pid,
		createdAt: record.createdAt,
		startedAt: record.startedAt,
		exitedAt: record.exitedAt,
		terminatedAt: record.terminatedAt,
		exitCode: record.exitCode,
		exitSignal: record.exitSignal,
		exitReason: record.exitReason,
		reused: record.reused,
	};
}

function buildExecutionSnapshot(
	records: Map<string, AiraProcessRecord>,
	recentResults: readonly AiraExecutionResult[],
	runtime: { active: boolean; degraded: boolean },
	maxRecords: number,
): AiraExecutionStatus {
	// Bounded records: evict oldest EXITED records past the cap. Running
	// processes are never evicted (they must stay inspectable/killable).
	const all = [...records.values()].sort((a, b) => a.createdAt - b.createdAt);
	if (all.length > maxRecords) {
		const running = all.filter((r) => r.status === "running");
		const evictable = all.filter((r) => r.status !== "running");
		const toEvict = evictable.slice(0, Math.max(0, evictable.length - (maxRecords - running.length)));
		for (const record of toEvict) {
			records.delete(record.id);
		}
	}
	return {
		active: runtime.active,
		degraded: runtime.degraded,
		processes: [...records.values()].sort((a, b) => a.createdAt - b.createdAt).map((record) => snapshotOf(record)),
		recentResults: recentResults.map((r) => ({
			status: r.status,
			ok: r.ok,
			command: r.command,
			cwd: r.cwd,
			startedAt: r.startedAt,
			durationMs: r.durationMs,
			exitCode: r.exitCode,
			processId: r.processId,
			reason: r.reason,
		})),
	};
}
