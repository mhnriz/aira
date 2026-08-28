import { describe, expect, it } from "vitest";
import { createProcessTerminator, type KillEffects } from "../../../src/aira/execution/platform.ts";

/**
 * Phase 6 platform suite: the termination strategy is pinned per platform
 * with mock effects, so Windows behavior is a tested contract on any host.
 */

function mockEffects(): { effects: KillEffects; calls: string[] } {
	const calls: string[] = [];
	const effects: KillEffects = {
		kill: (pid, signal) => {
			calls.push(`kill ${pid} ${signal}`);
		},
		taskkill: (args) => {
			calls.push(`taskkill ${args.join(" ")}`);
		},
		directKill: (pid) => {
			calls.push(`direct ${pid}`);
		},
		probe: (pid) => {
			calls.push(`probe ${pid}`);
			// Only the pid's own group is dead; -pid groups report alive during
			// the tests by default (overridden per test when needed).
			return pid < 0;
		},
	};
	return { effects, calls };
}

describe("Aira execution cross-platform termination strategy", () => {
	it("POSIX graceful sends SIGTERM to the process group", () => {
		const { effects, calls } = mockEffects();
		const t = createProcessTerminator("darwin", effects);
		t.graceful(4242);
		expect(calls).toEqual(["kill -4242 SIGTERM"]);
	});

	it("POSIX forced sends SIGKILL to the process group", () => {
		const { effects, calls } = mockEffects();
		const t = createProcessTerminator("linux", effects);
		t.forced(4242);
		expect(calls).toEqual(["kill -4242 SIGKILL"]);
	});

	it("POSIX falls back to the single pid when the group is gone", () => {
		const calls: string[] = [];
		const effects: KillEffects = {
			kill: (pid, signal) => {
				calls.push(`kill ${pid} ${signal}`);
				if (pid < 0) {
					throw new Error("no such process group");
				}
			},
			taskkill: () => {},
			directKill: () => {},
			probe: () => false,
		};
		const t = createProcessTerminator("darwin", effects);
		t.graceful(4242);
		expect(calls).toEqual(["kill -4242 SIGTERM", "kill 4242 SIGTERM"]);
	});

	it("POSIX hasSurvivors probes the group with signal 0", () => {
		const calls: string[] = [];
		const effects: KillEffects = {
			kill: (pid, signal) => {
				calls.push(`kill ${pid} ${signal}`);
				throw new Error("gone");
			},
			taskkill: () => {},
			directKill: () => {},
			probe: () => false,
		};
		const t = createProcessTerminator("linux", effects);
		expect(t.hasSurvivors(9)).toBe(false);
		expect(calls).toEqual(["kill -9 0"]);
	});

	it("Windows graceful uses taskkill WITHOUT force flags", () => {
		const { effects, calls } = mockEffects();
		const t = createProcessTerminator("win32", effects);
		t.graceful(4242);
		expect(calls).toEqual(["taskkill /PID 4242"]);
	});

	it("Windows forced uses taskkill /F /T (whole process tree)", () => {
		const { effects, calls } = mockEffects();
		const t = createProcessTerminator("win32", effects);
		t.forced(4242);
		expect(calls).toEqual(["taskkill /F /T /PID 4242"]);
	});

	it("Windows falls back to direct kill when taskkill cannot spawn", () => {
		const calls: string[] = [];
		const effects: KillEffects = {
			kill: () => {},
			taskkill: () => {
				calls.push("taskkill");
				throw new Error("no taskkill");
			},
			directKill: (pid) => {
				calls.push(`direct ${pid}`);
			},
			probe: () => true,
		};
		const t = createProcessTerminator("win32", effects);
		t.graceful(4242);
		t.forced(4242);
		expect(calls).toEqual(["taskkill", "direct 4242", "taskkill", "direct 4242"]);
	});

	it("Windows has no group probe: the manager re-kills after graceful", () => {
		const { effects } = mockEffects();
		const t = createProcessTerminator("win32", effects);
		expect(t.hasSurvivors(4242)).toBe(true);
	});

	it("uses the real host effects by default (no injection)", () => {
		// Default effects must exist and never throw for a dead pid.
		const t = createProcessTerminator(process.platform);
		expect(() => t.graceful(999999)).not.toThrow();
		expect(() => t.forced(999999)).not.toThrow();
	});
});
