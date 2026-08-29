import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../../suite/harness.ts";

/**
 * Phase 5 host-integration suite: Aira intelligence is AMBIENT through the
 * real AgentSession path — no slash commands, no explicit tool calls.
 *
 * - session construction arms the coordinator when the cwd is a project;
 * - `prompt()` injects the compact ambient context message;
 * - a real `edit` tool execution triggers the automatic post-edit pipeline
 *   (repository reindex; language-server diagnostics when a server is
 *   installed — otherwise clean degradation, never a failure);
 * - PLAN keeps intelligence read-only; context still injects;
 * - a session without a project stays fully usable.
 *
 * The deterministic mock-server diagnostics path is covered at the
 * coordinator level (`coordinator.test.ts`); this suite keeps assertions
 * environment-independent (no real language-server availability assumed).
 */
const harnesses: Harness[] = [];

/** Throwaway Node+TS project with a tray source file. */
function makeProjectDir(): string {
	const root = join(tmpdir(), `aira-suite-intel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "intel-proj", scripts: { test: "vitest run" } }));
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
	writeFileSync(
		join(root, "src", "tray.ts"),
		"export function stabilizeTray() {}\nexport function detectionState() {}\n",
	);
	return root;
}

beforeAll(async () => {
	const harness = await createHarness({ cwd: makeProjectDir() });
	harnesses.push(harness);
});

afterAll(() => {
	for (const harness of harnesses) {
		harness.session.dispose();
	}
});

function customContext(harness: Harness): string[] {
	return harness.session.messages
		.filter(
			(m): m is Extract<AgentMessage, { role: "custom" }> =>
				m.role === "custom" && m.customType === "aira.intelligence",
		)
		.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

async function waitForRepositoryReady(harness: Harness, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = harness.session.airaSessionState.intelligence?.repository.status;
		if (status === "ready" || status === "degraded") {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(`repository never settled (status ${status})`);
		}
		await sleep(100);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Aira ambient intelligence through the host (Phase 5)", () => {
	it("arms intelligence at session construction for a project cwd", async () => {
		const harness = harnesses[0]!;
		await waitForRepositoryReady(harness);
		expect(harness.session.airaSessionState.intelligence?.active).toBe(true);
		expect(harness.session.airaSessionState.intelligence?.repository.filesIndexed).toBeGreaterThan(0);
		expect(harness.session.airaSessionState.intelligence?.repository.status).toBe("ready");
	});

	it("injects a compact ambient context message on the first prompt", async () => {
		const harness = harnesses[0]!;
		harness.setResponses([fauxAssistantMessage(fauxText("ok"))]);
		await harness.session.prompt("the detection state flips back to Not Ready after the tray stabilizes, fix it");
		const injections = customContext(harness);
		expect(injections.length).toBeGreaterThan(0);
		const content = injections.join("\n");
		expect(content).toContain("Project: aira-suite-intel-");
		expect(content).toContain("TypeScript");
		expect(content).toContain("Likely files");
		expect(content).toContain("src/tray.ts");
		expect(content).toContain("detectionState");
		// The injection is silent: it must not appear as a user message.
		expect(getUserTexts(harness).every((t) => !t.includes("Aira intelligence"))).toBe(true);
	});

	it("runs the automatic post-edit pipeline after a real edit tool execution", async () => {
		const harness = harnesses[0]!;
		const root = harness.session.airaSessionState.project!.root!;
		const file = join(root, "src", "tray.ts");
		writeFileSync(file, "export function stabilizeTray() {}\nexport function freshMarker() {}\n");

		// The model "calls" the edit tool; the host executes it and fires the
		// tool lifecycle events the coordinator subscribes to.
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("edit", {
					path: file,
					oldText: "export function stabilizeTray() {}",
					newText: "export function stabilizeTray() {}\nexport function freshMarker() {}",
				}),
			]),
		]);
		await harness.session.prompt("add a fresh marker function to the tray");

		// Debounce: repository reindexed the file; real-language-server
		// diagnostics may or may not exist (environment-dependent) — the
		// contract is: nothing crashed and the working set learned the edit.
		await sleep(1500);
		const status = harness.session.airaSessionState.intelligence;
		expect(status?.degraded).toBe(false);
		expect(status?.liveCode.crashCount).toBe(0);

		// The next prompt surfaces the changed-file signal automatically.
		harness.setResponses([fauxAssistantMessage(fauxText("fixed"))]);
		await harness.session.prompt("continue");
		const injections = customContext(harness);
		expect(injections.join("\n")).toContain("Changed files");
		expect(injections.join("\n")).toContain("src/tray.ts");
	});

	it("keeps PLAN read-only: intelligence ops never mutate, context still injected", async () => {
		const harness = harnesses[0]!;
		const before = harness.session.getActiveToolNames().sort();
		harness.session.setAiraMode("plan");
		try {
			expect(harness.session.getActiveToolNames().sort()).toEqual([
				"agents_cancel",
				"agents_delegate",
				"agents_status",
				"browser_console",
				"browser_navigate",
				"browser_network",
				"browser_observe",
				"browser_screenshot",
				"browser_scroll",
				"browser_status",
				"browser_wait",
				"find",
				"grep",
				"ls",
				"process_logs",
				"process_status",
				"read",
			]);
			harness.setResponses([fauxAssistantMessage(fauxText("planning"))]);
			await harness.session.prompt("which file handles tray state?");
			expect(customContext(harness).join("\n")).toContain("Project: aira-suite-intel-");
		} finally {
			harness.session.setAiraMode("build");
			expect(harness.session.getActiveToolNames().sort()).toEqual(before);
		}
	});

	it("degrades when there is no project: sessions stay fully usable", async () => {
		const harness = await createHarness();
		try {
			harnesses.push(harness);
			// No project → the intelligence service is honestly inactive.
			expect(harness.session.airaSessionState.intelligence?.active).toBe(false);
			harness.setResponses([fauxAssistantMessage(fauxText("hi"))]);
			await harness.session.prompt("hello");
			expect(getUserTexts(harness).some((t) => t.includes("hello"))).toBe(true);
			expect(customContext(harness)).toEqual([]);
		} finally {
			harness.session.dispose();
		}
	});
});
