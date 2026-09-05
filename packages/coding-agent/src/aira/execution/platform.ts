/**
 * Aira execution — cross-platform process termination.
 *
 * Termination strategy is isolated here so platform behavior is intentional
 * and testable without needing Windows:
 *
 * POSIX (macOS/Linux):
 * - Aira spawns detached, so each child is a process-group leader. Graceful
 *   termination sends SIGTERM to the whole group (`kill(-pid)`); forced
 *   termination sends SIGKILL to the group. When group signaling fails
 *   (already reaped or group gone), we fall back to signaling the single pid.
 *
 * Windows:
 * - There are no POSIX signals. Graceful termination runs `taskkill /PID
 *   <pid>` (no /F: asks the process tree to wind down politely); forced
 *   termination runs `taskkill /F /T /PID <pid>` which force-kills the whole
 *   process tree. `taskkill` is spawned detached and best-effort; if it
 *   cannot even be spawned we fall back to the direct `pid.kill()`
 *   (TerminateProcess on Windows).
 *
 * The manager always waits a grace period between the graceful and the
 * forced step, and only ever reports a process as terminated after the kill
 * sequence was attempted (exit events remain the source of truth for exit
 * codes).
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

/** Injectable kill effects so platform behavior is unit-testable. */
export interface KillEffects {
	/** POSIX `process.kill(pid, signal)` (signal 0 probes existence); throws when gone. */
	kill(pid: number, signal: NodeJS.Signals | 0): void;
	/** Spawn `taskkill` with the given args (Windows). Best-effort. */
	taskkill(args: string[]): void;
	/** Direct single-process kill (fallback when group/taskkill fails). */
	directKill(pid: number): void;
	/** True when a process/group still exists (POSIX: kill(pid, 0)). */
	probe(pid: number): boolean;
}

/** Real host effects. */
export function defaultKillEffects(): KillEffects {
	return {
		kill: (pid, signal) => process.kill(pid, signal),
		taskkill: (args) => {
			try {
				const child = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), args, {
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				});
				child.once("error", () => {});
			} catch {
				// Best-effort: nothing further; the manager falls back to directKill.
			}
		},
		directKill: (pid) => {
			try {
				process.kill(pid);
			} catch {
				// Already gone.
			}
		},
		probe: (pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		},
	};
}

export interface ProcessTerminator {
	/** Polite termination: SIGTERM to the group (POSIX) / taskkill without /F (Windows). */
	graceful(pid: number): void;
	/** Forced termination: SIGKILL to the group (POSIX) / taskkill /F /T (Windows). */
	forced(pid: number): void;
	/** True when the spawned group may still contain live descendants. */
	hasSurvivors(pid: number): boolean;
}

/**
 * Build the terminator for a target platform. The manager passes
 * `process.platform`; tests pass "win32" / "darwin" / "linux" to pin down the
 * strategy without needing a Windows machine.
 */
export function createProcessTerminator(
	platform: NodeJS.Platform,
	effects: KillEffects = defaultKillEffects(),
): ProcessTerminator {
	if (platform === "win32") {
		return {
			graceful: (pid) => {
				try {
					effects.taskkill(["/PID", String(pid)]);
				} catch {
					effects.directKill(pid);
				}
			},
			forced: (pid) => {
				try {
					effects.taskkill(["/F", "/T", "/PID", String(pid)]);
				} catch {
					effects.directKill(pid);
				}
			},
			// Windows has no portable group-aliveness probe: the manager re-kills
			// the tree after graceful (harmless when already gone).
			hasSurvivors: () => true,
		};
	}
	return {
		graceful: (pid) => killGroup(pid, "SIGTERM", effects),
		forced: (pid) => killGroup(pid, "SIGKILL", effects),
		hasSurvivors: (pid) => {
			try {
				effects.kill(-pid, 0);
				return true;
			} catch {
				return false;
			}
		},
	};
}

function killGroup(pid: number, signal: NodeJS.Signals, effects: KillEffects): void {
	try {
		effects.kill(-pid, signal);
	} catch {
		try {
			effects.kill(pid, signal);
		} catch {
			// Process already gone.
		}
	}
}

/** Is the given platform POSIX (process-group semantics)? */
export function isPosixPlatform(platform: NodeJS.Platform): boolean {
	return platform !== "win32";
}
