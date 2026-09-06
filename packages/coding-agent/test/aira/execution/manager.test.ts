import { describe, expect, it } from "vitest";
import { type AiraExecutionManagerOptions, createAiraExecutionManager } from "../../../src/aira/execution/manager.ts";
import type { AiraExecutionResult } from "../../../src/aira/execution/types.ts";
import { acquireAiraSessionState, disposeAiraSessionState, getAiraSessionState } from "../../../src/aira/state.ts";

/**
 * Phase 6 process-manager suite. Uses REAL child processes (node) for the
 * lifecycle contract; platform-specific termination behavior is mocked in
 * `platform.test.ts`, and the ownership/overlap semantics are covered here
 * with two managers over the same session id.
 */

const QUICK_OK = `node -e "console.log('hello-exec'); console.error('warn-line')"`;
const QUICK_FAIL = `node -e "console.error('boom'); process.exit(3)"`;
const LINGER = `node -e "setInterval(()=>{},1000)"`;
const TICKER = `node -e "let i=0; setInterval(()=>{console.log('tick'+i++)},30)"`;

interface Ctx {
	sessionId: string;
	state: ReturnType<typeof acquireAiraSessionState>;
	manager: ReturnType<typeof createAiraExecutionManager>;
}

function makeManager(options?: AiraExecutionManagerOptions): Ctx {
	const sessionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const state = acquireAiraSessionState(sessionId, "startup");
	const manager = createAiraExecutionManager(state, process.cwd(), {
		terminateGraceMs: 250,
		autoBackgroundMs: 300,
		...options,
	});
	return { sessionId, state, manager };
}

async function finish(ctx: Ctx): Promise<void> {
	await ctx.manager.dispose();
	disposeAiraSessionState(ctx.sessionId, ctx.state);
}

function ok(result: AiraExecutionResult): AiraExecutionResult {
	expect(result.ok, JSON.stringify(result)).toBe(true);
	return result;
}

describe("Aira execution process manager (real child processes)", () => {
	it("runs a short foreground command and returns structured evidence", async () => {
		const ctx = makeManager();
		try {
			const result = ok(await ctx.manager.start({ command: QUICK_OK, cwd: process.cwd() }));
			expect(result.status).toBe("exited");
			expect(result.exitCode).toBe(0);
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
			expect(result.stdout.text).toContain("hello-exec");
			expect(result.stderr.text).toContain("warn-line");
			expect(result.processId).toBeDefined();
			// The record is inspectable after the fact with truthful status.
			const record = ctx.manager.get(result.processId!);
			expect(record?.status).toBe("exited");
			expect(record?.exitCode).toBe(0);
			expect(record?.exitConfirmed).toBe(true);
		} finally {
			await finish(ctx);
		}
	});

	it("uses the local interactive bridge without exposing its secret", async () => {
		const ctx = makeManager();
		try {
			const prompts: string[] = [];
			ctx.manager.attachInteractiveInputBridge?.({
				requestSecret: async (prompt) => {
					prompts.push(prompt);
					return "local-only-secret";
				},
			});
			const result = await ctx.manager.start(
				{
					command: `node -e "process.stdin.setEncoding('utf8'); process.stdout.write('Password:'); process.stdin.once('data',()=>{ console.log('authenticated'); process.exit(0) })"`,
					cwd: process.cwd(),
				},
				{ interactive: true, timeoutMs: 5000 },
			);
			expect(result.ok, JSON.stringify(result)).toBe(true);
			expect(result.interactiveAuth).toBe("succeeded");
			expect(prompts).toEqual(["sudo password"]);
			expect(result.stdout.text).not.toContain("local-only-secret");
			expect(result.stderr.text).not.toContain("local-only-secret");
			expect(ctx.manager.logs(result.processId!)?.stdout.text).not.toContain("local-only-secret");
			expect(JSON.stringify(ctx.state)).not.toContain("local-only-secret");
		} finally {
			await finish(ctx);
		}
	});

	it("reports failed local authentication only after the child rejects it", async () => {
		const ctx = makeManager();
		try {
			ctx.manager.attachInteractiveInputBridge?.({
				requestSecret: async () => "deliberately-invalid-test-secret",
			});
			const result = await ctx.manager.start(
				{
					command: `node -e "process.stdin.setEncoding('utf8'); process.stdout.write('Password:'); process.stdin.once('data',()=>{ console.error('Sorry, try again'); process.exit(1) })"`,
					cwd: process.cwd(),
				},
				{ interactive: true, timeoutMs: 5000 },
			);
			expect(result.status).toBe("exited");
			expect(result.ok).toBe(false);
			expect(result.exitCode).toBe(1);
			expect(result.interactiveAuth).toBe("failed");
			expect(ctx.manager.get(result.processId!)?.interactiveAuth).toBe("failed");
			expect(JSON.stringify(ctx.state)).not.toContain("deliberately-invalid-test-secret");
		} finally {
			await finish(ctx);
		}
	});

	it("forwards ordinary local input through the PTY without model involvement", async () => {
		const ctx = makeManager();
		try {
			let secretRequests = 0;
			ctx.manager.attachInteractiveInputBridge?.({
				requestSecret: async () => {
					secretRequests += 1;
					return undefined;
				},
			});
			const completion = ctx.manager.start(
				{
					command: `node -e "process.stdout.write('READY\\n'); process.stdin.setEncoding('utf8'); process.stdin.once('data',data=>{ process.stdout.write('received:'+data.trim()+'\\n'); process.exit(0) })"`,
					cwd: process.cwd(),
				},
				{ interactive: true, timeoutMs: 5000 },
			);
			let processId: string | undefined;
			for (let attempt = 0; attempt < 20 && processId === undefined; attempt += 1) {
				processId = ctx.manager.list()[0]?.id;
				if (processId === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(processId).toBeDefined();
			expect(ctx.manager.writeInput(processId!, "hello from local input\n")).toBe(true);
			const result = await completion;
			expect(result.ok, JSON.stringify(result)).toBe(true);
			expect(result.stdout.text).toContain("received:hello from local input");
			expect(secretRequests).toBe(0);
		} finally {
			await finish(ctx);
		}
	});

	it("returns a truthful unavailable result for interactive headless execution", async () => {
		const ctx = makeManager();
		try {
			const result = await ctx.manager.start(
				{ command: "echo never-started", cwd: process.cwd() },
				{ interactive: true },
			);
			expect(result.status).toBe("unavailable");
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("no local secret-input UI");
			expect(ctx.manager.list()).toHaveLength(0);
		} finally {
			await finish(ctx);
		}
	});

	it("cancels an interactive process when local authentication is cancelled", async () => {
		const ctx = makeManager();
		try {
			ctx.manager.attachInteractiveInputBridge?.({
				requestSecret: async () => undefined,
			});
			const result = await ctx.manager.start(
				{ command: `node -e "process.stdout.write('Password:'); setInterval(()=>{},1000)"`, cwd: process.cwd() },
				{ interactive: true, timeoutMs: 5000 },
			);
			expect(result.status).toBe("cancelled");
			expect(result.ok).toBe(false);
			expect(result.interactiveAuth).toBe("cancelled");
		} finally {
			await finish(ctx);
		}
	});

	it("times out an interactive process without retaining its secret", async () => {
		const ctx = makeManager();
		try {
			ctx.manager.attachInteractiveInputBridge?.({
				requestSecret: async (_prompt, signal) =>
					new Promise<string | undefined>((resolve) => {
						signal.addEventListener("abort", () => resolve(undefined), { once: true });
					}),
			});
			const result = await ctx.manager.start(
				{ command: `node -e "process.stdout.write('Password:'); setInterval(()=>{},1000)"`, cwd: process.cwd() },
				{ interactive: true, timeoutMs: 150 },
			);
			expect(result.status).toBe("timed-out");
			expect(JSON.stringify(ctx.state)).not.toContain("secret");
		} finally {
			await finish(ctx);
		}
	});

	it("reports a non-zero exit truthfully (spawn success is not success)", async () => {
		const ctx = makeManager();
		try {
			const result = await ctx.manager.start({ command: QUICK_FAIL, cwd: process.cwd() });
			expect(result.status).toBe("exited");
			expect(result.ok).toBe(false);
			expect(result.exitCode).toBe(3);
			expect(result.stderr.text).toContain("boom");
		} finally {
			await finish(ctx);
		}
	});

	it.skipIf(process.platform === "win32")("maps signal exits to non-zero process results", async () => {
		const ctx = makeManager();
		try {
			const result = await ctx.manager.start({
				exe: process.execPath,
				args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
				cwd: process.cwd(),
			});
			expect(result.status).toBe("exited");
			expect(result.ok).toBe(false);
			expect(result.exitCode).toBe(128 + 15);
			expect(result.signal).toBe("SIGTERM");
		} finally {
			await finish(ctx);
		}
	});

	it("reports a spawn failure truthfully (no pid, no exit code, ok=false)", async () => {
		const ctx = makeManager();
		try {
			const result = await ctx.manager.start({
				exe: "definitely-not-a-real-binary-xyz-123",
				args: [],
				cwd: process.cwd(),
			});
			expect(result.status).toBe("spawn-failed");
			expect(result.ok).toBe(false);
			expect(result.exitCode).toBeUndefined();
			expect(result.reason).toBeTruthy();
			const record = ctx.manager.get(result.processId!);
			expect(record?.status).toBe("spawn-failed");
			expect(record?.spawnError).toBeTruthy();
		} finally {
			await finish(ctx);
		}
	});

	it("times out a foreground command and terminates it", async () => {
		const ctx = makeManager();
		try {
			const result = await ctx.manager.start({ command: LINGER, cwd: process.cwd() }, { timeoutMs: 300 });
			expect(result.status).toBe("timed-out");
			expect(result.ok).toBe(false);
			const record = ctx.manager.get(result.processId!);
			expect(record?.status).toBe("terminated");
			expect(record?.exitReason).toBe("timeout");
		} finally {
			await finish(ctx);
		}
	});

	it("cancels a foreground command on AbortSignal", async () => {
		const ctx = makeManager();
		try {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 150);
			const result = await ctx.manager.start({ command: LINGER, cwd: process.cwd() }, { signal: controller.signal });
			expect(result.status).toBe("cancelled");
			expect(result.ok).toBe(false);
		} finally {
			await finish(ctx);
		}
	});

	it("manages a background process: status → logs → terminate", async () => {
		const ctx = makeManager();
		try {
			const result = await ctx.manager.start(
				{ command: TICKER, cwd: process.cwd() },
				{ mode: "background", purpose: "dev" },
			);
			expect(result.status).toBe("backgrounded");
			expect(result.ok).toBe(true);
			const id = result.processId!;
			const record = ctx.manager.get(id);
			expect(record?.status).toBe("running");
			expect(record?.pid).toBeDefined();
			expect(ctx.manager.list().some((r) => r.id === id)).toBe(true);
			// Bounded logs grow while it runs.
			await new Promise((resolve) => setTimeout(resolve, 350));
			const logs = ctx.manager.logs(id)!;
			expect(logs.stdout.text).toContain("tick");
			// Terminate gracefully and observe the truthful transition.
			const stopped = await ctx.manager.terminate(id, "user");
			expect(stopped?.status).toBe("terminated");
			expect(stopped?.exitReason).toBe("user");
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(ctx.manager.get(id)?.status).toBe("terminated");
			expect(ctx.manager.get(id)?.exitConfirmed).toBe(true);
		} finally {
			await finish(ctx);
		}
	});

	it("escalates a long-running foreground command to managed background (auto)", async () => {
		const ctx = makeManager();
		try {
			const result = await ctx.manager.start({ command: TICKER, cwd: process.cwd() }, { mode: "auto" });
			expect(result.status).toBe("backgrounded");
			expect(result.ok).toBe(true);
			const record = ctx.manager.get(result.processId!);
			expect(record?.mode).toBe("background");
			expect(record?.backgroundedAt).toBeDefined();
			await ctx.manager.terminate(result.processId!, "user");
		} finally {
			await finish(ctx);
		}
	});

	it("keeps auto mode foreground when the command completes quickly", async () => {
		// Leave enough startup headroom for the full repository suite; this test
		// checks the completed-process branch, not a scheduler race at 300 ms.
		const ctx = makeManager({ autoBackgroundMs: 2_000 });
		try {
			const result = await ctx.manager.start({ command: QUICK_OK, cwd: process.cwd() }, { mode: "auto" });
			expect(result.status).toBe("exited");
			expect(result.exitCode).toBe(0);
		} finally {
			await finish(ctx);
		}
	});

	it("falls back to forced termination when graceful is ignored", async () => {
		const ctx = makeManager({ terminateGraceMs: 200 });
		try {
			// Direct spawn (no shell wrapper): the child IS the SIGTERM-ignoring
			// process, so graceful can never work and the forced step must.
			const result = await ctx.manager.start(
				{
					exe: process.execPath,
					args: ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
					cwd: process.cwd(),
				},
				{ mode: "background" },
			);
			const id = result.processId!;
			// Give the handler time to install so graceful is genuinely ignored.
			await new Promise((resolve) => setTimeout(resolve, 400));
			const started = Date.now();
			const record = await ctx.manager.terminate(id, "user");
			expect(record?.status).toBe("terminated");
			// SIGTERM was ignored; the forced step had to happen after the grace
			// period, and the OS confirmed the exit.
			expect(record?.exitConfirmed).toBe(true);
			expect(Date.now() - started).toBeGreaterThanOrEqual(150);
		} finally {
			await finish(ctx);
		}
	});

	it("caps per-stream log buffers and marks truncation", async () => {
		const ctx = makeManager({ maxLogBytesPerStream: 2048 });
		try {
			const result = await ctx.manager.start(
				{
					// No process.exit(): exiting abruptly drops unflushed async pipe
					// writes, so the retained tail would not cover the end of the
					// stream and the assertion below would be timing-dependent.
					command: `node -e "for(let i=0;i<200000;i++){console.log('line-'+i)}"`,
					cwd: process.cwd(),
				},
				{ timeoutMs: 20_000 },
			);
			expect(result.status).toBe("exited");
			const record = ctx.manager.get(result.processId!);
			expect(record?.stdout.snapshot().truncated).toBe(true);
			expect(record?.stdout.snapshot().totalBytes).toBeGreaterThan(2048);
			// The retained tail keeps the RECENT output (end of stream).
			expect(record?.stdout.snapshot().text.includes("line-199999")).toBe(true);
			expect(record?.stdout.snapshot().text.includes("line-0")).toBe(false);
			// The result tail is bounded too.
			expect(result.stdout.text.length).toBeLessThan(7000);
		} finally {
			await finish(ctx);
		}
	});

	it("bounds retained records (oldest exited evicted; running kept)", async () => {
		const ctx = makeManager({ maxRecords: 3 });
		try {
			for (let i = 0; i < 4; i++) {
				await ctx.manager.start({ command: QUICK_OK, cwd: process.cwd() });
			}
			// 4 exited records with a cap of 3: only the newest 3 remain.
			expect(ctx.manager.list().length).toBe(3);

			const bg = await ctx.manager.start({ command: LINGER, cwd: process.cwd() }, { mode: "background" });
			// The cap still holds, but the RUNNING process is never evicted —
			// the oldest exited record makes room instead.
			expect(ctx.manager.list().length).toBe(3);
			expect(ctx.manager.get(bg.processId!)?.status).toBe("running");
		} finally {
			await finish(ctx);
		}
	});

	it("reuses a matching running dev process; restart replaces it", async () => {
		const ctx = makeManager();
		try {
			const dev = `node -e "setInterval(()=>{},1000)"`;
			const request = { command: dev, cwd: process.cwd() };
			const first = await ctx.manager.start(request, { mode: "background", purpose: "dev" });
			const second = await ctx.manager.start(request, { mode: "background", purpose: "dev", reuse: "reuse" });
			expect(second.status).toBe("backgrounded");
			expect(second.processId).toBe(first.processId);
			expect(second.reused).toBe(true);
			expect(ctx.manager.list().length).toBe(1);

			// A different command must NOT be reused.
			const other = await ctx.manager.start(
				{ command: `node -e "setTimeout(()=>{},5000)"`, cwd: process.cwd() },
				{ mode: "background", purpose: "dev", reuse: "reuse" },
			);
			expect(other.reused).toBeUndefined();
			expect(ctx.manager.list().length).toBe(2);

			// Restart terminates the match and launches fresh.
			const restarted = await ctx.manager.start(request, { mode: "background", purpose: "dev", reuse: "restart" });
			expect(restarted.reused).toBeUndefined();
			expect(restarted.processId).not.toBe(first.processId);
			expect(ctx.manager.get(first.processId!)?.status).toBe("terminated");
			expect(ctx.manager.get(restarted.processId!)?.status).toBe("running");
		} finally {
			await finish(ctx);
		}
	});

	it("session disposal terminates owned processes; overlapping sessions are isolated", async () => {
		// Two live states over the SAME session id: same shape as the Phase 1
		// overlapping lifecycle. The second acquire replaces the registry
		// entry; managers are per-instance (ADR-024), so each dispose only
		// ever touches its own processes.
		const sessionId = `overlap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const stateA = acquireAiraSessionState(sessionId, "startup");
		const stateB = acquireAiraSessionState(sessionId, "resume");
		const managerA = createAiraExecutionManager(stateA, process.cwd(), { terminateGraceMs: 250 });
		const managerB = createAiraExecutionManager(stateB, process.cwd(), { terminateGraceMs: 250 });
		try {
			expect(getAiraSessionState(sessionId)).toBe(stateB);
			const aProc = await managerA.start({ command: TICKER, cwd: process.cwd() }, { mode: "background" });
			const bProc = await managerB.start({ command: TICKER, cwd: process.cwd() }, { mode: "background" });

			// Disposing the NEWER session must not touch the older owner's process.
			await managerB.dispose();
			expect(managerA.get(aProc.processId!)?.status).toBe("running");
			expect(managerB.get(bProc.processId!)?.status).toBe("terminated");

			// Disposing the STALE session cleans up only its own process.
			await managerA.dispose();
			expect(managerA.get(aProc.processId!)?.status).toBe("terminated");

			// State disposal is ownership-checked: the stale owner is a no-op.
			expect(disposeAiraSessionState(sessionId, stateA)).toBe(false);
			expect(disposeAiraSessionState(sessionId, stateB)).toBe(true);
		} finally {
			await managerA.dispose().catch(() => {});
			await managerB.dispose().catch(() => {});
		}
	});

	it("publishes a bounded execution snapshot into canonical state", async () => {
		const ctx = makeManager();
		try {
			expect(ctx.state.execution?.active).toBe(true);
			const result = await ctx.manager.start({ command: QUICK_OK, cwd: process.cwd() });
			const snapshot = ctx.state.execution!;
			expect(snapshot.processes.length).toBe(1);
			expect(snapshot.processes[0]?.status).toBe("exited");
			expect(snapshot.recentResults.length).toBe(1);
			expect(snapshot.recentResults[0]?.status).toBe("exited");
			expect(snapshot.recentResults[0]?.command).toContain("hello-exec");
			expect(result.processId).toBe(snapshot.processes[0]?.id);
		} finally {
			await finish(ctx);
		}
	});

	it("emits lifecycle events (started / exited) to subscribers", async () => {
		const ctx = makeManager();
		try {
			const events: string[] = [];
			ctx.manager.subscribe((event) => {
				events.push(`${event.type}:${event.processId}`);
			});
			const result = await ctx.manager.start({ command: QUICK_OK, cwd: process.cwd() });
			expect(events).toContain(`process_started:${result.processId}`);
			expect(events).toContain(`process_exited:${result.processId}`);
		} finally {
			await finish(ctx);
		}
	});
});
