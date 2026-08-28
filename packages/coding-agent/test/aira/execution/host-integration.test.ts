import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../suite/harness.ts";

/**
 * Phase 6 host-integration suite: the execution runtime is a NATIVE harness
 * service through the real AgentSession path.
 *
 * - every session arms its own process manager and gets the four process
 *   tools, active by default;
 * - a real model tool call to process_start runs a short command and returns
 *   structured evidence;
 * - a managed background process is inspectable and stoppable through the
 *   tools; session disposal terminates what the session owns;
 * - PLAN blocks process_start/process_stop at the boundary and keeps
 *   process_status/process_logs available; REVIEW stays implement-capable;
 * - the runtime degrades cleanly (spawn failures are results, not throws).
 */
const QUICK_OK = `node -e "console.log('exec-host-ok')"`;
const LINGER = `node -e "setInterval(()=>{},1000)"`;

function makeProjectDir(): string {
	const root = join(tmpdir(), `aira-suite-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "exec-proj", scripts: { test: "npx vitest run" } }),
	);
	return root;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Text content of assistant/toolResult messages (string or text parts). */
function messageTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((m) => m.role === "assistant" || m.role === "toolResult")
		.map((m) => {
			const content: unknown = m.content;
			if (typeof content === "string") {
				return content;
			}
			if (Array.isArray(content)) {
				return content
					.filter((p) => (p as { type?: string }).type === "text")
					.map((p) => (p as { text?: string }).text ?? "")
					.join("\n");
			}
			return "";
		})
		.filter((t) => t.length > 0);
}

describe("Aira execution runtime through the host (Phase 6)", () => {
	it("arms the per-session runtime and registers the process tools by default", async () => {
		const harness = await createHarness({ cwd: makeProjectDir() });
		try {
			const manager = harness.session.airaExecution;
			expect(manager).toBeDefined();
			const names = harness.session.getActiveToolNames();
			expect(names).toContain("process_start");
			expect(names).toContain("process_status");
			expect(names).toContain("process_logs");
			expect(names).toContain("process_stop");
			// Canonical state carries the runtime snapshot.
			expect(harness.session.airaSessionState.execution?.active).toBe(true);
		} finally {
			harness.session.dispose();
		}
	});

	it("executes a short foreground command via the process_start tool with structured evidence", async () => {
		const harness = await createHarness({ cwd: makeProjectDir() });
		try {
			harness.setResponses([
				fauxAssistantMessage([
					fauxToolCall("process_start", {
						command: QUICK_OK,
						background: false,
						purpose: "test",
					}),
				]),
				fauxAssistantMessage(fauxText("final")),
			]);
			await harness.session.prompt("run the quick check");
			const texts = messageTexts(harness);
			const resultText = texts.find((t) => t.includes("exit code 0"));
			expect(
				resultText,
				JSON.stringify(
					harness.session.messages.map((m) => ({ role: m.role, content: (m as { content?: unknown }).content })),
				),
			).toBeDefined();
			expect(resultText).toContain("exec-host-ok");
			// The evidence is structured in canonical state too.
			const recent = harness.session.airaSessionState.execution?.recentResults ?? [];
			expect(recent.some((r) => r.status === "exited" && r.ok)).toBe(true);
		} finally {
			harness.session.dispose();
		}
	});

	it("manages a background dev process: status, logs, stop, truthful cleanup", async () => {
		const harness = await createHarness({
			cwd: makeProjectDir(),
			airaExecutionOptions: { terminateGraceMs: 200 },
		});
		try {
			const manager = harness.session.airaExecution!;
			const start = await manager.start(
				{ command: LINGER, cwd: harness.session.airaSessionState.project!.root! },
				{ mode: "background", purpose: "dev" },
			);
			expect(start.status).toBe("backgrounded");
			const id = start.processId!;
			expect(manager.get(id)?.status).toBe("running");

			// process_status shows the running process.
			const statusBefore = manager.get(id)!;
			expect(statusBefore.pid).toBeGreaterThan(0);

			// process_logs yields the captured stream (bounded shape).
			const logs = manager.logs(id)!;
			expect(logs.stdout).toBeDefined();
			expect(logs.stderr).toBeDefined();

			// process_stop terminates gracefully.
			const stopped = await manager.terminate(id, "user");
			expect(stopped?.status).toBe("terminated");
			expect(manager.get(id)?.exitConfirmed).toBe(true);

			// A second stop is a truthful no-op (already stopped).
			const again = await manager.terminate(id, "user");
			expect(again?.status).toBe("terminated");
		} finally {
			harness.session.dispose();
		}
	});

	it("session disposal cleans up only this session's managed processes", async () => {
		const harnessA = await createHarness({ cwd: makeProjectDir() });
		const harnessB = await createHarness({ cwd: makeProjectDir() });
		try {
			const procA = await harnessA.session.airaExecution!.start(
				{ command: LINGER, cwd: harnessA.session.airaSessionState.project!.root! },
				{ mode: "background" },
			);
			const procB = await harnessB.session.airaExecution!.start(
				{ command: LINGER, cwd: harnessB.session.airaSessionState.project!.root! },
				{ mode: "background" },
			);
			// Disposing A only kills A's process.
			harnessA.session.dispose();
			await sleep(400);
			expect(harnessA.session.airaExecution!.get(procA.processId!)?.status).toBe("terminated");
			expect(harnessB.session.airaExecution!.get(procB.processId!)?.status).toBe("running");
		} finally {
			harnessB.session.dispose();
		}
	});

	it("PLAN blocks process_start/process_stop but allows process_status/process_logs", async () => {
		const harness = await createHarness({ cwd: makeProjectDir() });
		try {
			harness.session.setAiraMode("plan");
			const active = harness.session.getActiveToolNames();
			expect(active).toContain("process_status");
			expect(active).toContain("process_logs");
			expect(active).not.toContain("process_start");
			expect(active).not.toContain("process_stop");

			const toolCall = (name: string) => ({
				toolCall: { type: "toolCall", id: `tc-${name}`, name, arguments: `{"id":"dev-1"}` } as any,
				args: { id: "dev-1" },
				assistantMessage: fauxAssistantMessage(fauxText("planning")) as any,
				context: { systemPrompt: "", messages: [] },
			});
			for (const blocked of ["process_start", "process_stop"]) {
				const before = await harness.session.agent.beforeToolCall?.(toolCall(blocked));
				expect(before?.block, `${blocked} should be blocked in PLAN`).toBe(true);
			}
			for (const allowed of ["process_status", "process_logs"]) {
				const before = await harness.session.agent.beforeToolCall?.(toolCall(allowed));
				expect(before?.block, `${allowed} should not be blocked in PLAN`).toBeUndefined();
			}
		} finally {
			harness.session.setAiraMode("build");
			harness.session.dispose();
		}
	});

	it("REVIEW keeps execution available and is not PLAN", async () => {
		const harness = await createHarness({ cwd: makeProjectDir() });
		try {
			harness.session.setAiraMode("review");
			const active = harness.session.getActiveToolNames();
			expect(active).toContain("process_start");
			expect(active).toContain("process_stop");
			const before = await harness.session.agent.beforeToolCall?.({
				toolCall: { type: "toolCall", id: "tc-1", name: "process_start", arguments: "{}" } as any,
				args: {},
				assistantMessage: fauxAssistantMessage(fauxText("review")) as any,
				context: { systemPrompt: "", messages: [] },
			});
			expect(before?.block).toBeUndefined();
		} finally {
			harness.session.setAiraMode("build");
			harness.session.dispose();
		}
	});

	it("degrades cleanly: spawn failure is a structured result, not a crash", async () => {
		const harness = await createHarness({ cwd: makeProjectDir() });
		try {
			const result = await harness.session.airaExecution!.start({
				exe: "no-such-binary-aira-p6",
				args: [],
				cwd: harness.session.airaSessionState.project!.root!,
			});
			expect(result.status).toBe("spawn-failed");
			expect(result.ok).toBe(false);
			expect(result.reason).toBeTruthy();
			// The session is still fully usable.
			harness.setResponses([fauxAssistantMessage(fauxText("ok"))]);
			await harness.session.prompt("still alive?");
			expect(messageTexts(harness).some((t) => t.includes("ok"))).toBe(true);
		} finally {
			harness.session.dispose();
		}
	});
});
