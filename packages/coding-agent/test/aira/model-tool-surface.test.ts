/**
 * 0.1.7 Step 3 — adaptive model tool surface.
 *
 * The model-facing tool set is the registry filtered by deterministic runtime
 * capability state. These tests prove the contract end to end through the real
 * AgentSession path:
 *
 * - general engineering tools and the code-intelligence funnel stay available;
 * - a deterministically inactive/unavailable capability contributes no
 *   model-facing schemas, but keeps its activation/discovery tool;
 * - enabling the capability (or activating its runtime state) restores exactly
 *   the previous tools;
 * - identical runtime state yields identical exposure, with no prompt
 *   classifier and no hidden model requests;
 * - telemetry reports the resulting tool count and tool-definition bytes.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { AiraBrowserProvider } from "../../src/aira/browser/provider.ts";
import {
	type AiraModelToolCapabilityState,
	classifyAiraModelToolGate,
	hasAiraOrchestrationRuns,
	isAiraModelToolAvailable,
} from "../../src/aira/model-tool-surface.ts";
import { renderSessionTelemetryJson } from "../../src/core/session-telemetry.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const encoder = new TextEncoder();

/**
 * Minimal in-memory browser provider: the capability state machine under test
 * is real; browser mechanics are not (no real browser is launched).
 */
function fakeBrowserProvider(): AiraBrowserProvider {
	let open = false;
	const tab = { id: "tab-1", url: "http://127.0.0.1:1/", title: "fixture", readyState: "complete" };
	return {
		id: "fake",
		async probeAvailability() {
			return { available: true, provider: "fake", detail: "fake provider" };
		},
		async open() {
			open = true;
			return { ok: true, operation: "open", tab: { ...tab } };
		},
		async close() {
			open = false;
			return { ok: true, operation: "close" };
		},
		tabs: () => (open ? [{ ...tab }] : []),
		activeTabId: () => (open ? tab.id : undefined),
		async activateTab() {
			return { ok: true, operation: "activate-tab" };
		},
		async closeTab() {
			return { ok: true, operation: "close-tab" };
		},
		async observe() {
			return {
				title: "fixture",
				url: tab.url,
				readyState: "complete",
				summary: "fixture page · ready",
				nodeCount: 2,
				outline: '- button "Probe" [e1]',
				truncated: false,
				targets: [],
				at: Date.now(),
			};
		},
		async navigate() {
			return { ok: true, operation: "navigate", target: tab.url, tab: { ...tab } };
		},
		async resolveTarget() {
			return { x: 1, y: 1, label: "e1" };
		},
		async click() {
			return { ok: true, operation: "click", target: "e1", tab: { ...tab } };
		},
		async fill() {
			return { ok: true, operation: "fill" };
		},
		async pressKey() {
			return { ok: true, operation: "press" };
		},
		async scroll() {
			return { ok: true, operation: "scroll" };
		},
		async wait() {
			return { ok: true, operation: "wait" };
		},
		async evaluate() {
			return { ok: true, operation: "evaluate" };
		},
		async consoleEvidence() {
			return { total: 0, overflowed: false, records: [] };
		},
		async networkEvidence() {
			return { total: 0, overflowed: false, records: [] };
		},
		async screenshot() {
			return "/tmp/aira-model-tool-surface.jpg";
		},
		async dispose() {
			open = false;
		},
		onBrowserExit() {
			return () => {};
		},
	};
}

/** The exact measurement semantics of Context Payload Telemetry. */
function toolDefinitionBytes(tool: { name: string; description?: string; parameters?: unknown }): number {
	return encoder.encode(
		JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
	).length;
}

function activeBytes(harness: Harness): number {
	const active = new Set(harness.session.getActiveToolNames());
	return harness.session
		.getAllTools()
		.filter((tool) => active.has(tool.name))
		.reduce((sum, tool) => sum + toolDefinitionBytes(tool), 0);
}

const ALL_ON: AiraModelToolCapabilityState = {
	browserEnabled: true,
	browserSessionOpen: true,
	orchestrationEnabled: true,
	orchestrationEstablished: true,
};

const DEFAULT_OFF: AiraModelToolCapabilityState = {
	browserEnabled: true,
	browserSessionOpen: false,
	orchestrationEnabled: true,
	orchestrationEstablished: false,
};

describe("Aira model tool surface — deterministic policy", () => {
	it("keeps general engineering, intelligence, interaction, and process tools in every state", () => {
		const alwaysAvailable = [
			"read",
			"bash",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
			"powershell",
			"aira_symbol_search",
			"aira_module_report",
			"aira_semantic_navigation",
			"aira_diagnostics",
			"ask_user",
			"tasks",
			"process_start",
			"process_status",
			"process_logs",
			"process_stop",
			// Extension/third-party tools are never gated by the built-in table.
			"dynamic_tool",
		];
		for (const state of [
			{ ...ALL_ON },
			{ ...DEFAULT_OFF },
			{
				browserEnabled: false,
				browserSessionOpen: false,
				orchestrationEnabled: false,
				orchestrationEstablished: false,
			},
		]) {
			for (const name of alwaysAvailable) {
				expect(isAiraModelToolAvailable(name, state), `${name} @ ${JSON.stringify(state)}`).toBe(true);
				expect(classifyAiraModelToolGate(name)).toBe("always");
			}
		}
	});

	it("gates browser later-stage tools on an open session and the capability switch", () => {
		const sessionTools = [
			"browser_observe",
			"browser_navigate",
			"browser_click",
			"browser_fill",
			"browser_press",
			"browser_scroll",
			"browser_wait",
			"browser_evaluate",
			"browser_console",
			"browser_network",
			"browser_screenshot",
			"browser_close",
		];
		for (const name of sessionTools) {
			expect(isAiraModelToolAvailable(name, DEFAULT_OFF), name).toBe(false);
			expect(isAiraModelToolAvailable(name, ALL_ON), name).toBe(true);
			expect(
				isAiraModelToolAvailable(name, { ...ALL_ON, browserEnabled: false }),
				`${name} with browser.enabled=false`,
			).toBe(false);
		}
		// Activation/self-opening paths follow the capability switch only.
		expect(isAiraModelToolAvailable("browser_open", DEFAULT_OFF)).toBe(true);
		expect(isAiraModelToolAvailable("browser_verify", DEFAULT_OFF)).toBe(true);
		expect(isAiraModelToolAvailable("browser_open", { ...DEFAULT_OFF, browserEnabled: false })).toBe(false);
		expect(isAiraModelToolAvailable("browser_verify", { ...DEFAULT_OFF, browserEnabled: false })).toBe(false);
		// Read-only discovery surface is never gated: it reports the truthful reason.
		expect(isAiraModelToolAvailable("browser_status", { browserEnabled: false } as never)).toBe(true);
	});

	it("gates later-stage orchestration tools on an existing child run and the capability switch", () => {
		expect(isAiraModelToolAvailable("agents_delegate", DEFAULT_OFF)).toBe(true);
		expect(isAiraModelToolAvailable("agents_status", DEFAULT_OFF)).toBe(false);
		expect(isAiraModelToolAvailable("agents_cancel", DEFAULT_OFF)).toBe(false);
		expect(isAiraModelToolAvailable("agents_status", ALL_ON)).toBe(true);
		expect(isAiraModelToolAvailable("agents_cancel", ALL_ON)).toBe(true);
		const disabled: AiraModelToolCapabilityState = { ...ALL_ON, orchestrationEnabled: false };
		for (const name of ["agents_delegate", "agents_status", "agents_cancel"]) {
			expect(isAiraModelToolAvailable(name, disabled), name).toBe(false);
		}
	});

	it("is pure: identical state yields identical exposure", () => {
		for (const state of [DEFAULT_OFF, ALL_ON]) {
			const first = ["read", "browser_observe", "agents_status", "tasks"].map((name) =>
				isAiraModelToolAvailable(name, state),
			);
			const second = ["read", "browser_observe", "agents_status", "tasks"].map((name) =>
				isAiraModelToolAvailable(name, { ...state }),
			);
			expect(second).toEqual(first);
		}
	});

	it("treats any recorded child run as orchestration established", () => {
		const empty = { runningCount: 0, queuedCount: 0, children: [], recentResults: [], failures: [] };
		expect(hasAiraOrchestrationRuns(empty)).toBe(false);
		expect(hasAiraOrchestrationRuns({ ...empty, runningCount: 1 })).toBe(true);
		expect(hasAiraOrchestrationRuns({ ...empty, queuedCount: 2 })).toBe(true);
		expect(hasAiraOrchestrationRuns({ ...empty, children: [{}] })).toBe(true);
		expect(hasAiraOrchestrationRuns({ ...empty, recentResults: [{}] })).toBe(true);
		expect(hasAiraOrchestrationRuns({ ...empty, failures: [{}] })).toBe(true);
	});
});

describe("Aira model tool surface — default session", () => {
	it("keeps the general engineering surface and gates only later-stage tools", async () => {
		const harness = await createHarness();
		try {
			const active = harness.session.getActiveToolNames();
			for (const name of [
				"read",
				"bash",
				"edit",
				"write",
				"aira_symbol_search",
				"aira_module_report",
				"aira_semantic_navigation",
				"aira_diagnostics",
				"ask_user",
				"tasks",
				"process_start",
				"process_status",
				"process_logs",
				"process_stop",
				"browser_open",
				"browser_status",
				"browser_verify",
				"agents_delegate",
			]) {
				expect(active, name).toContain(name);
			}
			// No open browser session → observation/interaction are hidden.
			for (const name of ["browser_observe", "browser_click", "browser_close"]) {
				expect(active, name).not.toContain(name);
			}
			// No child run yet → the later-stage orchestration tools are hidden.
			expect(active).not.toContain("agents_status");
			expect(active).not.toContain("agents_cancel");
			// Nothing is deleted from the registry: every gated tool still exists
			// (execution APIs and explicit host selection keep working).
			const registry = harness.session.getAllTools().map((tool) => tool.name);
			for (const name of ["browser_observe", "agents_status", "agents_cancel"]) {
				expect(registry, name).toContain(name);
			}
			// Every gated tool name in the built-in table is a real registered tool.
			for (const name of registry) {
				expect([
					"always",
					"browser-enabled",
					"browser-session",
					"orchestration-enabled",
					"orchestration-established",
				]).toContain(classifyAiraModelToolGate(name));
			}
		} finally {
			harness.cleanup();
		}
	});

	it("produces identical exposure for identical runtime state", async () => {
		const a = await createHarness();
		const b = await createHarness();
		try {
			expect(b.session.getActiveToolNames()).toEqual(a.session.getActiveToolNames());
			expect(a.session.getActiveToolNames().length).toBe(18);
		} finally {
			a.cleanup();
			b.cleanup();
		}
	});

	it("does not derive the surface from prompt content (no keyword classifier)", async () => {
		const harness = await createHarness();
		try {
			const before = harness.session.getActiveToolNames();
			harness.setResponses([
				fauxAssistantMessage(fauxText("no browser work needed")),
				fauxAssistantMessage(fauxText("still no")),
				fauxAssistantMessage(fauxText("no children")),
			]);
			await harness.session.prompt("open the browser and check the page with playwright");
			await harness.session.prompt("now delegate to a child agent and poll agents_status");
			await harness.session.prompt("close the browser when done");
			expect(harness.session.getActiveToolNames()).toEqual(before);
			// Nothing was activated as a side effect of prompt wording.
			expect(harness.session.airaSessionState.browser?.status).toBe("idle");
			expect(harness.session.airaSessionState.orchestration?.children).toEqual([]);
			// No hidden model requests: three prompts → exactly three requests.
			expect(harness.session.getTelemetrySnapshot().usage.modelRequests).toBe(3);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps task creation possible and the task tool always exposed", async () => {
		const harness = await createHarness();
		try {
			expect(harness.session.getActiveToolNames()).toContain("tasks");
			const taskTool = harness.session.agent.state.tools.find((tool) => tool.name === "tasks")!;
			await taskTool.execute("t1", { action: "create", title: "surface test task" });
			const rows = harness.session.airaSessionState.tasks?.rows ?? [];
			expect(rows.some((row) => row.title === "surface test task")).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps the intelligence funnel available and working", async () => {
		const harness = await createHarness();
		try {
			for (const name of [
				"aira_symbol_search",
				"aira_module_report",
				"aira_semantic_navigation",
				"aira_diagnostics",
			]) {
				expect(harness.session.getActiveToolNames(), name).toContain(name);
			}
			const search = harness.session.agent.state.tools.find((tool) => tool.name === "aira_symbol_search")!;
			const result = await search.execute("t1", { query: "createHarness" });
			expect(result.content[0]).toMatchObject({ type: "text" });
		} finally {
			harness.cleanup();
		}
	});

	it("keeps gated tool execution APIs unchanged (explicit selection + truthful failure)", async () => {
		const harness = await createHarness();
		try {
			// Explicit host/extension selection still reaches a gated tool.
			harness.session.setActiveToolsByName(["browser_observe"]);
			expect(harness.session.getActiveToolNames()).toEqual(["browser_observe"]);
			const observe = harness.session.agent.state.tools.find((tool) => tool.name === "browser_observe")!;
			const result = await observe.execute("t1", {});
			expect(result.content[0]).toMatchObject({ type: "text" });
			expect((result.content[0] as { text: string }).text).toMatch(/browser is not open/i);
		} finally {
			harness.cleanup();
		}
	});
});

describe("Aira model tool surface — capability activation", () => {
	it("restores browser later-stage tools when a session opens and hides them on close", async () => {
		const harness = await createHarness({ airaBrowserOptions: { provider: fakeBrowserProvider() } });
		try {
			const browser = harness.session.airaBrowser!;
			await browser.activate();
			expect(harness.session.getActiveToolNames()).not.toContain("browser_observe");
			await browser.open();
			expect(harness.session.getActiveToolNames()).toContain("browser_observe");
			expect(harness.session.getActiveToolNames()).toContain("browser_close");
			await browser.close();
			expect(harness.session.getActiveToolNames()).not.toContain("browser_observe");
			expect(harness.session.getActiveToolNames()).toContain("browser_open");
		} finally {
			harness.cleanup();
		}
	});

	it("announces restored tools on the activation tool result (discoverability)", async () => {
		const harness = await createHarness({ airaBrowserOptions: { provider: fakeBrowserProvider() } });
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("browser_open", { url: "http://127.0.0.1:1/" })),
				fauxAssistantMessage(fauxText("opened")),
			]);
			await harness.session.prompt("open the local page");
			const openResult = harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "browser_open",
			) as { addedToolNames?: string[] } | undefined;
			expect(openResult?.addedToolNames).toContain("browser_observe");
			expect(openResult?.addedToolNames).toContain("browser_click");
			expect(openResult?.addedToolNames).toContain("browser_close");
		} finally {
			harness.cleanup();
		}
	});

	it("restores agents_status/agents_cancel once a child run exists", async () => {
		const harness = await createHarness();
		try {
			expect(harness.session.getActiveToolNames()).not.toContain("agents_status");
			const delegate = harness.session.agent.state.tools.find((tool) => tool.name === "agents_delegate")!;
			const result = await delegate.execute("t1", {
				tasks: [{ role: "explore", task: "map the module" }],
				await: false,
			});
			expect(result.details).toMatchObject({ ok: true });
			expect(harness.session.getActiveToolNames()).toContain("agents_status");
			expect(harness.session.getActiveToolNames()).toContain("agents_cancel");
			// The restored tool is executable through the unchanged execution API.
			const status = harness.session.agent.state.tools.find((tool) => tool.name === "agents_status")!;
			const statusResult = await status.execute("t2", {});
			expect((statusResult.content[0] as { text: string }).text).toContain("orchestration:");
		} finally {
			harness.cleanup();
		}
	});

	it("hides every targeted tool when the capability is disabled by settings, and restores it when enabled", async () => {
		const disabled = await createHarness({
			settings: { browser: { enabled: false }, orchestration: { enabled: false } },
		});
		const enabled = await createHarness();
		try {
			const off = disabled.session.getActiveToolNames();
			// Browser: only the read-only discovery surface survives.
			expect(off.filter((name) => name.startsWith("browser_"))).toEqual(["browser_status"]);
			// Orchestration: nothing at all (the capability is switched off).
			expect(off.filter((name) => name.startsWith("agents_"))).toEqual([]);
			// Registry intact.
			const registry = disabled.session.getAllTools().map((tool) => tool.name);
			expect(registry).toContain("browser_open");
			expect(registry).toContain("agents_delegate");
			// Enabling restores exactly the default surface.
			expect(enabled.session.getActiveToolNames()).toContain("browser_open");
			expect(enabled.session.getActiveToolNames()).toContain("browser_verify");
			expect(enabled.session.getActiveToolNames()).toContain("agents_delegate");
		} finally {
			disabled.cleanup();
			enabled.cleanup();
		}
	});
});

describe("Aira model tool surface — goals and verification defaults", () => {
	it("keeps goals OFF by default, contributes no goal tool, and still works when enabled", async () => {
		const off = await createHarness();
		const on = await createHarness({ settings: { goals: { enabled: true } } });
		try {
			expect(off.session.airaGoal!.status().enabled).toBe(false);
			expect(on.session.airaGoal!.status().enabled).toBe(true);
			// Goals contribute no model-facing tool in either state (unchanged).
			expect(off.session.getActiveToolNames().filter((name) => name.includes("goal"))).toEqual([]);
			expect(on.session.getActiveToolNames()).toEqual(off.session.getActiveToolNames());
			// Enabled goals still work through the native handle.
			const created = on.session.airaGoal!.create("Keep the fixture green");
			expect(created.ok).toBe(true);
			expect(on.session.airaGoal!.status().objective).toContain("fixture green");
		} finally {
			off.cleanup();
			on.cleanup();
		}
	});

	it("keeps verification OFF by default, contributes no verifier tool, and reports enabled truthfully", async () => {
		const off = await createHarness();
		const on = await createHarness({ settings: { verification: { enabled: true } } });
		try {
			expect(off.session.airaVerification!.status().enabled).toBe(false);
			expect(on.session.airaVerification!.status().enabled).toBe(true);
			// Verification contributes no model-facing tool in either state, and
			// enabling it does not change the exposed surface.
			expect(off.session.getActiveToolNames()).toEqual(on.session.getActiveToolNames());
			expect(off.session.getActiveToolNames().filter((name) => name.startsWith("aira_verif"))).toEqual([]);
		} finally {
			off.cleanup();
			on.cleanup();
		}
	});
});

describe("Aira model tool surface — context telemetry", () => {
	it("reports the resulting tool count and tool-definition bytes", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage(fauxText("done"))]);
			await harness.session.prompt("say done");
			const snapshot = harness.session.getTelemetrySnapshot();
			const active = harness.session.getActiveToolNames();
			expect(snapshot.context.requestCount).toBe(1);
			expect(snapshot.context.byTransport.toolDefinitions.toolCount).toBe(active.length);
			expect(snapshot.context.byTransport.toolDefinitions.latestBytes).toBe(activeBytes(harness));
			const latest = snapshot.context.recentRequests[0]!;
			expect(latest.toolCount).toBe(active.length);
			expect(latest.toolsBytes).toBe(activeBytes(harness));
			expect(latest.totalBytes).toBe(latest.systemBytes + latest.conversationBytes + latest.toolsBytes);
		} finally {
			harness.cleanup();
		}
	});

	it("does not alter the exposed tool set when /telemetry renders", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage(fauxText("done"))]);
			await harness.session.prompt("say done");
			const before = harness.session.getActiveToolNames();
			const rendered = renderSessionTelemetryJson(harness.session.getTelemetrySnapshot());
			expect(rendered).toContain('"toolDefinitions"');
			expect(harness.session.getActiveToolNames()).toEqual(before);
		} finally {
			harness.cleanup();
		}
	});

	it("reports the expanded surface after a capability becomes usable", async () => {
		const harness = await createHarness({ airaBrowserOptions: { provider: fakeBrowserProvider() } });
		try {
			harness.setResponses([fauxAssistantMessage(fauxText("one"))]);
			await harness.session.prompt("first");
			const before = harness.session.getTelemetrySnapshot().context.byTransport.toolDefinitions.latestBytes!;
			const browser = harness.session.airaBrowser!;
			await browser.activate();
			await browser.open();
			harness.setResponses([fauxAssistantMessage(fauxText("two"))]);
			await harness.session.prompt("second");
			const after = harness.session.getTelemetrySnapshot().context.byTransport.toolDefinitions.latestBytes!;
			expect(after).toBeGreaterThan(before);
			// The added bytes are exactly the restored browser tool definitions.
			expect(harness.session.getActiveToolNames()).toContain("browser_observe");
		} finally {
			harness.cleanup();
		}
	});

	it("carries a tool call through the real model path with the gated surface", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("tasks", { action: "create", title: "from the model" })),
				fauxAssistantMessage(fauxText("task created")),
			]);
			await harness.session.prompt("track this work");
			const rows = harness.session.airaSessionState.tasks?.rows ?? [];
			expect(rows.some((row) => row.title === "from the model")).toBe(true);
			expect(harness.session.getTelemetrySnapshot().tools.byName.tasks).toBe(1);
		} finally {
			harness.cleanup();
		}
	});
});
