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

	it("keeps the latest user request verbatim even with a minimal recent budget", () => {
		const messages = longHistory();
		const result = compactAiraModelContext(messages, settings({ recentBytes: 1 }));
		expect(result.report.triggered).toBe(true);
		const activeStart = messages.findIndex((m) => m.role === "user" && m.content === "current request");
		// The active request itself is never compacted, whatever the budget,
		// and the boundary may now reach past it into the work it produced.
		expect(result.messages[activeStart]).toBe(messages[activeStart]);
		expect(result.report.firstCompactedIndex).toBeLessThan(activeStart);
	});

	it("keeps the latest user request and its recent execution tail verbatim", () => {
		const messages = longHistory();
		const result = compactAiraModelContext(messages, settings({ recentBytes: 32_000 }));
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

/**
 * 0.1.7 Step 4.1 — the active-request boundary.
 *
 * One user prompt can drive many model/tool turns. Step 4 protected the active
 * user message AND everything after it, so that workload could never compact.
 * These tests pin the corrected semantics: the request stays verbatim, its
 * newest execution bytes stay verbatim, and older same-turn assistant/tool
 * history becomes eligible.
 */
describe("compactAiraModelContext — long-running active turn", () => {
	/** One user request followed by `turns` assistant/tool exchanges. */
	function singleTurnHistory(turns: number): AgentMessage[] {
		const messages: AgentMessage[] = [user("substantial active engineering request", 1)];
		for (let i = 0; i < turns; i++) {
			messages.push(assistantWithToolCall(longProse(`execution step ${i}`), `same-turn-${i}`, i + 2));
			messages.push(toolResult(`same-turn-${i}`, `file body ${i} `.repeat(500), { timestamp: i + 2 }));
		}
		return messages;
	}

	it("compacts a single user turn whose autonomous run crosses the trigger", () => {
		const messages = singleTurnHistory(20);
		const before = measureAiraConversationBytes(messages);
		expect(before).toBeGreaterThan(DEFAULT_AIRA_CONTEXT_COMPACTION_SETTINGS.triggerBytes);

		const result = compactAiraModelContext(messages);

		// 1. compaction triggers without a second user message
		expect(result.report.triggered).toBe(true);
		expect(result.report.savedBytes).toBeGreaterThan(0);
		expect(result.report.messagesCompacted).toBeGreaterThan(0);
		expect(result.report.toolResultsCompacted).toBeGreaterThan(0);

		// 2. the active request is byte-identical
		expect(result.messages[0]).toBe(messages[0]);
		const request = result.messages[0];
		if (request.role !== "user") throw new Error("unreachable");
		expect(request.content).toBe("substantial active engineering request");

		// 3. old same-turn work is compacted
		expect(result.report.firstCompactedIndex).toBe(1);
		const firstAssistant = result.messages[1];
		if (firstAssistant.role !== "assistant") throw new Error("unreachable");
		expect(firstAssistant.content.find((b) => b.type === "text")).toEqual(
			fauxText(AIRA_CONTEXT_COMPACTION_MARKERS.assistantProse),
		);

		// 4. the newest execution bytes stay verbatim by reference
		const newestAssistant = messages[messages.length - 2];
		const newestResult = messages[messages.length - 1];
		expect(result.messages).toContain(newestAssistant);
		expect(result.messages).toContain(newestResult);

		// 5. the projection shrinks
		expect(measureAiraConversationBytes(result.messages)).toBeLessThan(before);

		// 6. tool protocol stays valid
		for (const message of result.messages) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				expect(result.messages.find((m) => m.role === "toolResult" && m.toolCallId === block.id)).toBeDefined();
			}
		}

		// 7. the canonical input history is unchanged
		expect(messages[0]).not.toBe(result.messages[1]);
		expect(JSON.stringify(messages)).toBe(JSON.stringify(singleTurnHistory(20)));
	});

	it("does not compact a tiny single-turn session", () => {
		const messages: AgentMessage[] = [user("small request", 1), assistantProse("small reply", 2)];
		const result = compactAiraModelContext(messages);
		expect(result.report.triggered).toBe(false);
		expect(result.report.savedBytes).toBe(0);
		expect(result.messages).toEqual(messages);
	});

	it("keeps the newest execution bytes verbatim under the recent budget", () => {
		const messages = singleTurnHistory(20);
		const result = compactAiraModelContext(messages);
		const recentBudget = DEFAULT_AIRA_CONTEXT_COMPACTION_SETTINGS.recentBytes;
		let accumulated = 0;
		let verbatimMessages = 0;
		for (let i = messages.length - 1; i >= 1; i--) {
			if (result.messages[i] !== messages[i]) break;
			accumulated += measureAiraConversationBytes([messages[i]]);
			verbatimMessages++;
		}
		expect(verbatimMessages).toBeGreaterThan(0);
		// The tail survives as a real byte budget, not a fixed message count.
		expect(accumulated).toBeGreaterThanOrEqual(recentBudget);
		const tail = messages.slice(messages.length - verbatimMessages);
		for (const message of tail) expect(result.messages).toContain(message);
	});

	it("keeps a tool call/result pair that straddles the byte boundary together", () => {
		const messages = singleTurnHistory(20);

		// Find the pair the raw byte boundary would split: the first tool result
		// whose verbatim window starts above its call.
		let straddleResultIndex = -1;
		{
			let accumulated = 0;
			for (let i = messages.length - 1; i >= 1; i--) {
				accumulated += measureAiraConversationBytes([messages[i]]);
				if (accumulated >= 12_000) {
					straddleResultIndex = i;
					break;
				}
			}
		}
		expect(straddleResultIndex).toBeGreaterThan(0);
		expect(messages[straddleResultIndex].role).toBe("toolResult");

		const result = compactAiraModelContext(messages, settings({ recentBytes: 12_000 }));
		expect(result.report.triggered).toBe(true);

		// The boundary pair stays whole: the call and its result are both kept
		// by reference, and the result is never replaced by a placeholder while
		// its call is inside the verbatim window.
		const straddlingResult = messages[straddleResultIndex];
		if (straddlingResult.role !== "toolResult") throw new Error("unreachable");
		const callIndex = messages.findIndex(
			(m) =>
				m.role === "assistant" &&
				m.content.some((b) => b.type === "toolCall" && b.id === straddlingResult.toolCallId),
		);
		expect(callIndex).toBeGreaterThanOrEqual(0);
		if (result.messages[callIndex] === messages[callIndex]) {
			expect(result.messages[straddleResultIndex]).toBe(straddlingResult);
		}

		// Whatever the placement, the pair is present and structurally intact.
		for (const message of result.messages) {
			if (message.role !== "toolResult") continue;
			expect(
				result.messages.some(
					(m) =>
						m.role === "assistant" && m.content.some((b) => b.type === "toolCall" && b.id === message.toolCallId),
				),
			).toBe(true);
		}
	});

	it("protects an active request that is the only user message in history", () => {
		const messages = singleTurnHistory(12);
		const result = compactAiraModelContext(messages, settings({ recentBytes: 1 }));
		expect(result.report.triggered).toBe(true);
		expect(result.messages[0]).toBe(messages[0]);
		expect(result.report.firstCompactedIndex).not.toBe(0);
	});

	it("leaves multi-user-turn histories on the existing Step 4 path", () => {
		const messages = longHistory();
		const result = compactAiraModelContext(messages);
		expect(result.report.triggered).toBe(true);
		// Old turns (before the active request) are still compacted.
		const oldAssistant = result.messages[1];
		if (oldAssistant.role !== "assistant") throw new Error("unreachable");
		expect(oldAssistant.content.find((b) => b.type === "text")).toEqual(
			fauxText(AIRA_CONTEXT_COMPACTION_MARKERS.assistantProse),
		);
		// The active request and its whole chain stay verbatim by reference.
		const activeStart = messages.findIndex((m) => m.role === "user" && m.content === "current request");
		for (let i = activeStart; i < messages.length; i++) {
			expect(result.messages[i]).toBe(messages[i]);
		}
	});

	it("keeps thinking blocks on the existing assistant-compaction rules", () => {
		const messages: AgentMessage[] = [user("one long autonomous request", 1)];
		messages.push(
			fauxAssistantMessage([fauxThinking(longProse("old thinking")), fauxText("step")], { timestamp: 2 }),
		);
		for (let i = 0; i < 20; i++) {
			messages.push(assistantWithToolCall(longProse(`execution step ${i}`), `same-turn-${i}`, i + 3));
			messages.push(toolResult(`same-turn-${i}`, `file body ${i} `.repeat(500), { timestamp: i + 3 }));
		}

		const result = compactAiraModelContext(messages, settings({ recentBytes: 8_000 }));
		const oldAssistant = result.messages[1];
		if (oldAssistant.role !== "assistant") throw new Error("unreachable");
		const thinking = oldAssistant.content.find((b) => b.type === "thinking");
		expect(thinking?.type === "thinking" ? thinking.thinking : undefined).toBe(
			AIRA_CONTEXT_COMPACTION_MARKERS.assistantThinking,
		);
	});

	it("stays deterministic, idempotent, and non-mutating on a single turn", () => {
		const messages = singleTurnHistory(20);
		const snapshot = JSON.stringify(messages);

		const first = compactAiraModelContext(messages);
		const second = compactAiraModelContext(messages);
		expect(second.messages).toEqual(first.messages);
		expect(second.report).toEqual(first.report);

		const third = compactAiraModelContext(first.messages);
		expect(third.messages).toEqual(first.messages);
		expect(third.report.savedBytes).toBe(0);

		expect(JSON.stringify(messages)).toBe(snapshot);
		expect(first.messages).not.toBe(messages);
	});

	it("still fails open for user, custom, and bash history in the eligible zone", () => {
		const custom: AgentMessage = {
			role: "custom",
			customType: "aira.intelligence",
			content: "ambient context ".repeat(200),
			display: false,
			timestamp: 1,
		};
		const messages: AgentMessage[] = [custom];
		for (let i = 0; i < 20; i++) {
			messages.push(assistantWithToolCall(longProse(`execution step ${i}`), `same-turn-${i}`, i + 2));
			messages.push(toolResult(`same-turn-${i}`, `file body ${i} `.repeat(500), { timestamp: i + 2 }));
		}
		messages.push(user("active request", 100));

		const result = compactAiraModelContext(messages, settings({ recentBytes: 1 }));
		expect(result.report.triggered).toBe(true);
		expect(result.messages[0]).toBe(custom);
		expect(result.messages[result.messages.length - 1]).toBe(messages[messages.length - 1]);
	});
});
