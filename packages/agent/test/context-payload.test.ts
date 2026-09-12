import { describe, expect, it } from "vitest";
import { measureModelContextPayload } from "../src/context-payload.ts";
import type { AgentMessage } from "../src/types.ts";

const textEncoder = new TextEncoder();

function utf8(text: string): number {
	return textEncoder.encode(text).length;
}

function userMessage(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 };
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "test" as const,
		provider: "test" as const,
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 0,
	};
}

function toolResultMessage(text: string) {
	return {
		role: "toolResult" as const,
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: 0,
	};
}

function sampleTool(name = "read") {
	return {
		name,
		description: "read a file",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	};
}

/** The conversion target for a custom message under the standard contract. */
function customAsProviderMessage(_customType: string, content: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text: content }],
		timestamp: 0,
	};
}

function customMessage(customType: string, content: string): AgentMessage {
	return {
		role: "custom" as never,
		customType,
		content,
		display: false,
		timestamp: 0,
	} as unknown as AgentMessage;
}

function bashExecutionMessage(command: string, excludeFromContext: boolean): AgentMessage {
	return {
		role: "bashExecution" as never,
		command,
		output: "",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		excludeFromContext,
		timestamp: 0,
	} as unknown as AgentMessage;
}

describe("measureModelContextPayload", () => {
	it("measures system, conversation, and tools with an exact additive total", () => {
		const systemPrompt = "You are a test assistant.";
		const messages = [userMessage("hello")];
		const tools = [sampleTool()];
		const measurement = measureModelContextPayload(messages, { systemPrompt, messages, tools });

		const systemBytes = utf8(systemPrompt);
		const conversationBytes = utf8(JSON.stringify({ role: "user", content: messages[0].content }));
		const toolsBytes = utf8(
			JSON.stringify({ name: "read", description: "read a file", parameters: tools[0].parameters }),
		);
		expect(measurement.systemBytes).toBe(systemBytes);
		expect(measurement.conversationBytes).toBe(conversationBytes);
		expect(measurement.toolsBytes).toBe(toolsBytes);
		expect(measurement.totalBytes).toBe(systemBytes + conversationBytes + toolsBytes);
		expect(measurement.messageCount).toBe(1);
		expect(measurement.toolCount).toBe(1);
		expect(measurement.conversation).toEqual({ userBytes: conversationBytes, assistantBytes: 0, toolResultBytes: 0 });
		expect(measurement.contributors).toEqual([]);
	});

	it("splits conversation bytes by provider role", () => {
		const messages = [userMessage("u"), assistantMessage("a"), toolResultMessage("r")];
		const measurement = measureModelContextPayload(messages, { messages, systemPrompt: "" });
		const userBytes = utf8(JSON.stringify({ role: "user", content: messages[0].content }));
		const assistantBytes = utf8(JSON.stringify({ role: "assistant", content: messages[1].content }));
		const toolResultBytes = utf8(
			JSON.stringify({
				role: "toolResult",
				content: messages[2].content,
				toolCallId: "call-1",
				toolName: "read",
			}),
		);
		expect(measurement.conversation).toEqual({ userBytes, assistantBytes, toolResultBytes });
		expect(measurement.conversationBytes).toBe(userBytes + assistantBytes + toolResultBytes);
	});

	it("uses UTF-8 bytes, not UTF-16 code units", () => {
		const systemPrompt = "héllo — 中文";
		const measurement = measureModelContextPayload([], { systemPrompt, messages: [] });
		expect(measurement.systemBytes).toBe(utf8(systemPrompt));
		expect(measurement.systemBytes).toBeGreaterThan(systemPrompt.length);
	});

	it("attributes custom message bytes to the contributor identity exactly", () => {
		const agentMessages: AgentMessage[] = [customMessage("test.ctx", "CONTENT-A"), userMessage("hi")];
		const providerMessages = [customAsProviderMessage("test.ctx", "CONTENT-A"), userMessage("hi")];
		const measurement = measureModelContextPayload(agentMessages, {
			systemPrompt: "",
			messages: providerMessages,
		});
		const expectedBytes = utf8(JSON.stringify({ role: "user", content: [{ type: "text", text: "CONTENT-A" }] }));
		expect(measurement.contributors).toEqual([{ key: "test.ctx", bytes: expectedBytes, messageCount: 1 }]);
		expect(measurement.conversation.userBytes).toBe(
			expectedBytes + utf8(JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] })),
		);
	});

	it("keeps pairing correct when context-excluded bash executions are dropped", () => {
		const agentMessages: AgentMessage[] = [
			bashExecutionMessage("echo hi", true),
			customMessage("test.ctx", "CONTENT-B"),
			userMessage("hi"),
		];
		const providerMessages = [customAsProviderMessage("test.ctx", "CONTENT-B"), userMessage("hi")];
		const measurement = measureModelContextPayload(agentMessages, { systemPrompt: "", messages: providerMessages });
		const expectedBytes = utf8(JSON.stringify({ role: "user", content: [{ type: "text", text: "CONTENT-B" }] }));
		expect(measurement.contributors).toEqual([{ key: "test.ctx", bytes: expectedBytes, messageCount: 1 }]);
		expect(measurement.messageCount).toBe(2);
	});

	it("aggregates repeated contributors within one request", () => {
		const agentMessages: AgentMessage[] = [
			customMessage("test.ctx", "ONE"),
			customMessage("test.ctx", "TWO"),
			customMessage("other.ctx", "THREE"),
		];
		const providerMessages = [
			customAsProviderMessage("test.ctx", "ONE"),
			customAsProviderMessage("test.ctx", "TWO"),
			customAsProviderMessage("other.ctx", "THREE"),
		];
		const measurement = measureModelContextPayload(agentMessages, { systemPrompt: "", messages: providerMessages });
		// The size unit is the `{ role, content }` projection, not the full
		// message object (response-side metadata is never part of the request).
		const oneBytes = utf8(JSON.stringify({ role: "user", content: [{ type: "text", text: "ONE" }] }));
		const twoBytes = utf8(JSON.stringify({ role: "user", content: [{ type: "text", text: "TWO" }] }));
		const threeBytes = utf8(JSON.stringify({ role: "user", content: [{ type: "text", text: "THREE" }] }));
		expect(measurement.contributors).toEqual([
			{ key: "other.ctx", bytes: threeBytes, messageCount: 1 },
			{ key: "test.ctx", bytes: oneBytes + twoBytes, messageCount: 2 },
		]);
	});

	it("reports no contributor attribution when pairing cannot be established", () => {
		// A custom message present in the agent messages but absent from provider
		// messages (a host conversion contract that filters it): identities
		// cannot be paired, so no contributor bucket is fabricated.
		const agentMessages: AgentMessage[] = [customMessage("test.ctx", "CONTENT-C"), userMessage("hi")];
		const measurement = measureModelContextPayload(agentMessages, {
			systemPrompt: "",
			messages: [userMessage("hi")],
		});
		expect(measurement.contributors).toEqual([]);
		expect(measurement.conversation.userBytes).toBe(
			utf8(JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] })),
		);
	});

	it("returns only metadata — never message or tool contents", () => {
		const agentMessages: AgentMessage[] = [customMessage("test.ctx", "SECRET-CONTENT")];
		const providerMessages = [customAsProviderMessage("test.ctx", "SECRET-CONTENT")];
		const measurement = measureModelContextPayload(agentMessages, {
			systemPrompt: "SECRET-SYSTEM",
			messages: providerMessages,
			tools: [sampleTool()],
		});
		const serialized = JSON.stringify(measurement);
		expect(serialized).not.toContain("SECRET-CONTENT");
		expect(serialized).not.toContain("SECRET-SYSTEM");
		expect(serialized).not.toContain("read a file");
	});

	it("is deterministic for identical input", () => {
		const systemPrompt = "sys";
		const messages = [userMessage("hello")];
		const tools = [sampleTool()];
		const first = measureModelContextPayload(messages, { systemPrompt, messages, tools });
		const second = measureModelContextPayload(messages, { systemPrompt, messages, tools });
		expect(second).toEqual(first);
	});
});
