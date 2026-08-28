import type { AgentToolCall, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/compat";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../suite/harness.ts";

const harnesses: Harness[] = [];

function toolCallContext(name: string): BeforeToolCallContext {
	const toolCall = {
		type: "toolCall",
		id: `tc-${name}`,
		name,
		arguments: { command: "probe" },
	} as unknown as AgentToolCall;
	return {
		toolCall,
		args: { command: "probe" },
		assistantMessage: fauxAssistantMessage(fauxText("hi")) as AssistantMessage,
		context: { systemPrompt: "", messages: [] },
	};
}

beforeAll(async () => {
	// One canonical session with the real built-in tool registry (no override).
	const harness = await createHarness();
	harnesses.push(harness);
});

afterAll(() => {
	for (const harness of harnesses) {
		harness.session.dispose();
	}
});

describe("Aira PLAN read-only enforcement (host/tool-policy level)", () => {
	it("starts in BUILD with the full default tool set", () => {
		const harness = harnesses[0]!;
		expect(harness.session.airaMode).toBe("build");
		expect(harness.session.getActiveToolNames().sort()).toEqual([
			"bash",
			"browser_click",
			"browser_close",
			"browser_console",
			"browser_evaluate",
			"browser_fill",
			"browser_navigate",
			"browser_network",
			"browser_observe",
			"browser_open",
			"browser_press",
			"browser_screenshot",
			"browser_scroll",
			"browser_status",
			"browser_verify",
			"browser_wait",
			"edit",
			"process_logs",
			"process_start",
			"process_status",
			"process_stop",
			"read",
			"write",
		]);
	});

	it("enters PLAN with only the read-only tools available", () => {
		const harness = harnesses[0]!;
		harness.session.setAiraMode("plan");

		expect(harness.session.airaMode).toBe("plan");
		expect(harness.session.getActiveToolNames().sort()).toEqual([
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
	});

	it("restores the previous tool set when leaving PLAN", () => {
		const harness = harnesses[0]!;
		harness.session.setAiraMode("review");
		expect(harness.session.airaMode).toBe("review");
		expect(harness.session.getActiveToolNames().sort()).toEqual([
			"bash",
			"browser_click",
			"browser_close",
			"browser_console",
			"browser_evaluate",
			"browser_fill",
			"browser_navigate",
			"browser_network",
			"browser_observe",
			"browser_open",
			"browser_press",
			"browser_screenshot",
			"browser_scroll",
			"browser_status",
			"browser_verify",
			"browser_wait",
			"edit",
			"process_logs",
			"process_start",
			"process_status",
			"process_stop",
			"read",
			"write",
		]);

		harness.session.setAiraMode("build");
		expect(harness.session.airaMode).toBe("build");
		expect(harness.session.getActiveToolNames().sort()).toEqual([
			"bash",
			"browser_click",
			"browser_close",
			"browser_console",
			"browser_evaluate",
			"browser_fill",
			"browser_navigate",
			"browser_network",
			"browser_observe",
			"browser_open",
			"browser_press",
			"browser_screenshot",
			"browser_scroll",
			"browser_status",
			"browser_verify",
			"browser_wait",
			"edit",
			"process_logs",
			"process_start",
			"process_status",
			"process_stop",
			"read",
			"write",
		]);
	});

	it("blocks mutating tool execution in PLAN at the boundary", async () => {
		const harness = harnesses[0]!;
		harness.session.setAiraMode("plan");

		for (const mutating of [
			"bash",
			"powershell",
			"edit",
			"write",
			"process_start",
			"process_stop",
			"browser_open",
			"browser_click",
			"browser_fill",
			"browser_press",
			"browser_evaluate",
			"browser_verify",
			"browser_close",
		]) {
			const result = await harness.session.agent.beforeToolCall?.(toolCallContext(mutating));
			expect(result?.block, `${mutating} should be blocked in PLAN`).toBe(true);
			expect(result?.reason).toContain("PLAN mode is read-only");
		}
	});

	it("allows read-only tool execution in PLAN", async () => {
		const harness = harnesses[0]!;
		harness.session.setAiraMode("plan");

		for (const safe of ["read", "grep", "find", "ls", "process_status", "process_logs"]) {
			const result = await harness.session.agent.beforeToolCall?.(toolCallContext(safe));
			expect(result?.block, `${safe} should not be blocked in PLAN`).toBeUndefined();
		}
	});

	it("does not block mutating tools outside PLAN", async () => {
		const harness = harnesses[0]!;
		harness.session.setAiraMode("review");
		const blocked = await harness.session.agent.beforeToolCall?.(toolCallContext("bash"));
		expect(blocked?.block).toBeUndefined();
	});

	it("keeps canonical state authoritative across modes", () => {
		const harness = harnesses[0]!;
		harness.session.setAiraMode("build");
		expect(harness.session.airaMode).toBe("build");
	});
});
