/**
 * 0.1.7 Step 4 — deterministic progressive context compaction (pure module).
 *
 * These tests exercise the projection function directly: byte thresholds,
 * verbatim windows, active-request protection, structural tool pairing,
 * idempotence, fail-open behavior, and input immutability. Integration through
 * the real AgentSession lives in the same file's second half.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	AIRA_CONTEXT_COMPACTION_MARKERS,
	type AiraContextCompactionSettings,
	compactAiraModelContext,
	DEFAULT_AIRA_CONTEXT_COMPACTION_SETTINGS,
	measureAiraConversationBytes,
} from "../../src/aira/context-compaction.ts";

function user(text: string, timestamp = 1): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function assistantProse(text: string, timestamp = 1): AgentMessage {
	return fauxAssistantMessage(text, { timestamp });
}

function assistantWithToolCall(prose: string, id: string, timestamp = 1): AgentMessage {
	return fauxAssistantMessage([fauxText(prose), fauxToolCall("read", { path: "src/a.ts" }, { id })], { timestamp });
}

function toolResult(
	toolCallId: string,
	text: string,
	options: { isError?: boolean; timestamp?: number } = {},
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [fauxText(text)],
		isError: options.isError ?? false,
		timestamp: options.timestamp ?? 1,
	};
}

/** A simple deterministic "long prose" body. */
function longProse(label: string, chars = 3000): string {
	return `${label} ${"narration ".repeat(Math.ceil(chars / 10))}`;
}

function settings(overrides: Partial<AiraContextCompactionSettings> = {}): AiraContextCompactionSettings {
	return { ...DEFAULT_AIRA_CONTEXT_COMPACTION_SETTINGS, ...overrides };
}

/** Build a long history: several old turns plus a recent active turn. */
function longHistory(): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let i = 0; i < 8; i++) {
		messages.push(user(`old request ${i}`, i));
		messages.push(assistantWithToolCall(longProse(`old work ${i}`), `old-call-${i}`, i));
		messages.push(toolResult(`old-call-${i}`, `file body ${i} `.repeat(500), { timestamp: i }));
		messages.push(assistantProse(longProse(`old conclusion ${i}`), i));
	}
	// Active turn: newest user request and its entire execution chain.
	messages.push(user("current request", 100));
	messages.push(assistantWithToolCall("working on it", "active-call", 100));
	messages.push(toolResult("active-call", "active result", { timestamp: 100 }));
	return messages;
}

describe("compactAiraModelContext", () => {
	it("leaves a small history byte- and structure-equivalent", () => {
		const messages: AgentMessage[] = [
			user("hello"),
			assistantProse("short reply"),
			user("second"),
			assistantProse("another short reply"),
		];
		const before = measureAiraConversationBytes(messages);
		const result = compactAiraModelContext(messages, settings());
		expect(result.report.triggered).toBe(false);
		expect(result.report.savedBytes).toBe(0);
		expect(result.messages).toEqual(messages);
		expect(measureAiraConversationBytes(result.messages)).toBe(before);
	});

	it("does nothing when disabled, even past the threshold", () => {
		const messages = longHistory();
		const result = compactAiraModelContext(messages, settings({ enabled: false }));
		expect(result.report.enabled).toBe(false);
		expect(result.report.triggered).toBe(false);
		expect(result.messages).toEqual(messages);
	});

	it("triggers deterministically once the byte threshold is crossed", () => {
		const messages = longHistory();
		const total = measureAiraConversationBytes(messages);

		const justBelow = compactAiraModelContext(messages, settings({ triggerBytes: total }));
		expect(justBelow.report.triggered).toBe(false);

		const justAbove = compactAiraModelContext(messages, settings({ triggerBytes: total - 1 }));
		expect(justAbove.report.triggered).toBe(true);
		expect(justAbove.report.savedBytes).toBeGreaterThan(0);
		expect(justAbove.report.compactedBytes).toBe(justAbove.report.originalBytes - justAbove.report.savedBytes);
	});

	it("keeps the latest user request and its active tool chain verbatim", () => {
		const messages = longHistory();
		const result = compactAiraModelContext(messages, settings({ recentBytes: 1 }));
		expect(result.report.triggered).toBe(true);
		const activeStart = messages.findIndex((m) => m.role === "user" && m.content === "current request");
		for (let i = activeStart; i < messages.length; i++) {
			expect(result.messages[i]).toBe(messages[i]);
		}
	});

	it("keeps the whole recent window verbatim", () => {
		const messages = longHistory();
		const result = compactAiraModelContext(messages, settings({ recentBytes: 30_000 }));
		const tail = messages.slice(-3);
		for (const message of tail) {
			expect(result.messages).toContain(message);
		}
	});

	it("reduces old assistant narration but preserves tool calls", () => {
		const messages = longHistory();
		const result = compactAiraModelContext(messages, settings());
		const firstAssistant = result.messages[1];
		expect(firstAssistant.role).toBe("assistant");
		if (firstAssistant.role !== "assistant") throw new Error("unreachable");
		const toolCalls = firstAssistant.content.filter((block) => block.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toEqual(fauxToolCall("read", { path: "src/a.ts" }, { id: "old-call-0" }));
		const text = firstAssistant.content.find((block) => block.type === "text");
		expect(text).toEqual(fauxText(AIRA_CONTEXT_COMPACTION_MARKERS.assistantProse));
	});

	it("keeps a bounded head of an old assistant conclusion", () => {
		const messages = longHistory();
		const result = compactAiraModelContext(messages, settings());
		const conclusion = result.messages[3];
		expect(conclusion.role).toBe("assistant");
		if (conclusion.role !== "assistant") throw new Error("unreachable");
		const text = conclusion.content.find((block) => block.type === "text");
		expect(text?.type).toBe("text");
		if (text?.type !== "text") throw new Error("unreachable");
		expect(text.text.startsWith("old conclusion")).toBe(true);
		expect(text.text.endsWith(AIRA_CONTEXT_COMPACTION_MARKERS.assistantConclusion)).toBe(true);
	});

	it("reduces old successful tool results but keeps their call identity", () => {
		const messages = longHistory();
		const result = compactAiraModelContext(messages, settings());
		const reduced = result.messages[2];
		expect(reduced.role).toBe("toolResult");
		if (reduced.role !== "toolResult") throw new Error("unreachable");
		expect(reduced.toolCallId).toBe("old-call-0");
		expect(reduced.toolName).toBe("read");
		expect(reduced.isError).toBe(false);
		expect(reduced.content).toHaveLength(1);
		const block = reduced.content[0];
		if (block.type !== "text") throw new Error("unreachable");
		expect(block.text.startsWith("[earlier read result compacted: ")).toBe(true);
	});

	it("never touches errored tool results", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 6; i++) {
			messages.push(user(`old ${i}`, i));
			messages.push(assistantProse(longProse(`n ${i}`), i));
		}
		messages.push(user("current", 100));
		messages.push(assistantWithToolCall("try", "err-call", 100));
		messages.push(toolResult("err-call", "boom ".repeat(500), { isError: true, timestamp: 100 }));
		// An old error, far outside the recent window, must survive.
		const oldError = toolResult("ancient-call", "ancient failure ".repeat(500), { isError: true, timestamp: -10 });
		messages.splice(1, 0, oldError);
		const result = compactAiraModelContext(messages, settings({ recentBytes: 1, triggerBytes: 1000 }));
		const preserved = result.messages.find((m) => m.role === "toolResult" && m.toolCallId === "ancient-call");
		expect(preserved).toBe(oldError);
	});

	it("preserves assistant tool calls paired with their results after compaction", () => {
		const messages = longHistory();
		const result = compactAiraModelContext(messages, settings());
		for (let i = 0; i < result.messages.length; i++) {
			const message = result.messages[i];
			if (message.role !== "assistant") continue;
			const calls = message.content.filter((block) => block.type === "toolCall");
			for (const call of calls) {
				const matching = result.messages.find((m) => m.role === "toolResult" && m.toolCallId === call.id);
				expect(matching, `tool result missing for call ${call.id}`).toBeDefined();
			}
		}
	});

	it("fails open for custom/unknown messages and user content", () => {
		const messages = longHistory();
		const custom: AgentMessage = {
			role: "custom",
			customType: "aira.intelligence",
			content: "ambient context ".repeat(200),
			display: false,
			timestamp: 1,
		};
		messages.splice(0, 0, custom);
		const firstUser = messages.find((m) => m.role === "user");
		const result = compactAiraModelContext(messages, settings({ recentBytes: 1 }));
		expect(result.messages[0]).toBe(custom);
		expect(result.messages.find((m) => m === firstUser)).toBe(firstUser);
	});

	it("does not mutate the input array or its messages", () => {
		const messages = longHistory();
		const snapshot = JSON.stringify(messages);
		const result = compactAiraModelContext(messages, settings({ recentBytes: 1 }));
		expect(JSON.stringify(messages)).toBe(snapshot);
		expect(result.messages).not.toBe(messages);
	});

	it("is deterministic and idempotent", () => {
		const messages = longHistory();
		const first = compactAiraModelContext(messages, settings());
		const second = compactAiraModelContext(messages, settings());
		expect(second.messages).toEqual(first.messages);
		expect(second.report).toEqual(first.report);

		const third = compactAiraModelContext(first.messages, settings());
		expect(third.messages).toEqual(first.messages);
		expect(third.report.savedBytes).toBe(0);
	});

	it("reduces the projection bytes materially on a long history", () => {
		const messages = longHistory();
		const before = measureAiraConversationBytes(messages);
		const result = compactAiraModelContext(messages, settings());
		expect(result.report.originalBytes).toBe(before);
		expect(result.report.compactedBytes).toBeLessThan(before);
		expect(result.report.savedBytes).toBeGreaterThan(before * 0.3);
	});

	it("compacts older history as the session grows (progressive)", () => {
		const base = longHistory();
		const firstPass = compactAiraModelContext(base, settings());
		const grown = [...base, user("next request", 200), assistantProse(longProse("next work"), 200)];
		const secondPass = compactAiraModelContext(grown, settings());
		expect(secondPass.report.compactedBytes).toBeGreaterThan(firstPass.report.compactedBytes);
	});

	it("removes old reasoning blocks", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 6; i++) {
			messages.push(user(`old ${i}`, i));
			messages.push(fauxAssistantMessage([fauxThinking(longProse(`think ${i}`)), fauxText("ok")], { timestamp: i }));
		}
		messages.push(user("current", 100));
		messages.push(assistantProse("done", 100));
		const result = compactAiraModelContext(
			messages,
			settings({ recentBytes: 1, minAssistantProseChars: 1, triggerBytes: 1000 }),
		);
		const firstAssistant = result.messages[1];
		if (firstAssistant.role !== "assistant") throw new Error("unreachable");
		const thinking = firstAssistant.content.find((block) => block.type === "thinking");
		expect(thinking?.type === "thinking" ? thinking.thinking : undefined).toBe(
			AIRA_CONTEXT_COMPACTION_MARKERS.assistantThinking,
		);
	});
});
