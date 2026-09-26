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
		expect(result.report.toolResultsCompacted).toBeGreaterThan(0);

		// 2. the active request is byte-identical
		expect(result.messages[0]).toBe(messages[0]);
		const request = result.messages[0];
		if (request.role !== "user") throw new Error("unreachable");
		expect(request.content).toBe("substantial active engineering request");

		// 3. every assistant message produced in the active turn stays verbatim:
		// the model must never continue from a compacted view of its own turn
		for (let i = 1; i < messages.length; i++) {
			if (messages[i].role !== "assistant") continue;
			expect(result.messages[i]).toBe(messages[i]);
		}

		// 4. old same-turn tool output is still compacted
		let compactedToolResults = 0;
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role !== "toolResult") continue;
			if (result.messages[i] !== messages[i]) compactedToolResults++;
		}
		expect(compactedToolResults).toBeGreaterThan(0);
		expect(
			result.messages.some(
				(m) =>
					m.role === "toolResult" && m.content.some((b) => b.type === "text" && b.text.startsWith("[earlier ")),
			),
		).toBe(true);

		// 5. the newest execution bytes stay verbatim by reference
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

	it("compacts old-turn thinking but keeps active-turn reasoning verbatim", () => {
		const messages: AgentMessage[] = [];
		// Old turn with reasoning that is eligible for compaction.
		messages.push(user("older request", 1));
		messages.push(
			fauxAssistantMessage([fauxThinking(longProse("old thinking")), fauxText("old step")], { timestamp: 2 }),
		);
		for (let i = 0; i < 12; i++) {
			messages.push(assistantWithToolCall(longProse(`old execution step ${i}`), `old-turn-${i}`, i + 3));
			messages.push(toolResult(`old-turn-${i}`, `file body ${i} `.repeat(500), { timestamp: i + 3 }));
		}
		// Active turn with reasoning that must stay verbatim.
		messages.push(user("active request", 100));
		messages.push(
			fauxAssistantMessage([fauxThinking(longProse("active thinking")), fauxText("active step")], {
				timestamp: 101,
			}),
		);
		messages.push(assistantWithToolCall(longProse("active execution"), "active-turn-0", 102));
		messages.push(toolResult("active-turn-0", "active body ".repeat(500), { timestamp: 102 }));

		const result = compactAiraModelContext(messages, settings({ recentBytes: 8_000 }));

		// Old-turn reasoning is compacted on the existing rules.
		const oldAssistant = result.messages[1];
		if (oldAssistant.role !== "assistant") throw new Error("unreachable");
		const thinking = oldAssistant.content.find((b) => b.type === "thinking");
		expect(thinking?.type === "thinking" ? thinking.thinking : undefined).toBe(
			AIRA_CONTEXT_COMPACTION_MARKERS.assistantThinking,
		);

		// Active-turn reasoning stays verbatim by reference.
		const activeAssistantIndex = messages.length - 3;
		expect(result.messages[activeAssistantIndex]).toBe(messages[activeAssistantIndex]);
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

describe("compactAiraModelContext — visible response protection", () => {
	/** Old history over the trigger, then a completed report, then a new user request. */
	function reportThenFollowUpHistory(): { messages: AgentMessage[]; reportIndex: number; activeIndex: number } {
		const messages: AgentMessage[] = [user("first request", 1)];
		messages.push(
			fauxAssistantMessage([fauxThinking(longProse("first reasoning")), fauxText("first step")], { timestamp: 2 }),
		);
		for (let i = 0; i < 12; i++) {
			messages.push(assistantWithToolCall(longProse(`first turn step ${i}`), `first-turn-${i}`, i + 3));
			messages.push(toolResult(`first-turn-${i}`, `first body ${i} `.repeat(500), { timestamp: i + 3 }));
		}
		messages.push(
			fauxAssistantMessage(
				[
					fauxThinking(longProse("report reasoning")),
					fauxText(
						`BEGIN_REPORT ${longProse("report body", 20_000)} MIDDLE_REPORT ${longProse("report tail", 20_000)} END_REPORT`,
					),
				],
				{ timestamp: 100 },
			),
		);
		const reportIndex = messages.length - 1;
		const activeIndex = messages.length;
		messages.push(user("follow-up request about the report", 101));
		messages.push(fauxAssistantMessage([fauxText("working")], { timestamp: 102 }));
		return { messages, reportIndex, activeIndex };
	}

	it("keeps the latest completed assistant report verbatim when a new user message arrives", () => {
		const { messages, reportIndex } = reportThenFollowUpHistory();
		const before = measureAiraConversationBytes(messages);
		const result = compactAiraModelContext(messages);

		// The report is untouched by reference and still contains its full text.
		expect(result.messages[reportIndex]).toBe(messages[reportIndex]);
		const text = assistantTextOf(result.messages[reportIndex]);
		expect(text).toContain("BEGIN_REPORT");
		expect(text).toContain("MIDDLE_REPORT");
		expect(text).toContain("END_REPORT");
		expect(text).not.toContain(AIRA_CONTEXT_COMPACTION_MARKERS.assistantConclusion);

		// Older history still compacts and the projection shrinks.
		expect(result.report.triggered).toBe(true);
		expect(result.report.savedBytes).toBeGreaterThan(0);
		expect(result.messages.some((m) => m.role === "assistant" && hasCompactedAssistantBlock(m))).toBe(true);
		expect(measureAiraConversationBytes(result.messages)).toBeLessThan(before);
	});

	it("never compacts assistant output produced inside the active turn", () => {
		const { messages, activeIndex } = reportThenFollowUpHistory();
		// A large streamed response plus tool work inside the active turn.
		messages.push(
			fauxAssistantMessage([fauxText(`ACTIVE_BEGIN ${longProse("active body", 40_000)} ACTIVE_END`)], {
				timestamp: 103,
			}),
		);
		const growthIndex = messages.length - 1;
		messages.push(assistantWithToolCall(longProse("active tool step"), "active-tool", 104));
		messages.push(toolResult("active-tool", "active result ".repeat(500), { timestamp: 104 }));

		const result = compactAiraModelContext(messages);

		// Every assistant message after the active user request stays verbatim.
		for (let i = activeIndex + 1; i < messages.length; i++) {
			if (messages[i].role !== "assistant") continue;
			expect(result.messages[i]).toBe(messages[i]);
		}
		const activeText = assistantTextOf(result.messages[growthIndex]);
		expect(activeText).toContain("ACTIVE_BEGIN");
		expect(activeText).toContain("ACTIVE_END");
		expect(activeText).not.toContain(AIRA_CONTEXT_COMPACTION_MARKERS.assistantConclusion);

		// The turn still shrinks by compacting older history and tool output.
		expect(result.report.triggered).toBe(true);
		expect(result.report.savedBytes).toBeGreaterThan(0);
		let compactedToolResults = 0;
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role !== "toolResult") continue;
			if (result.messages[i] !== messages[i]) compactedToolResults++;
		}
		expect(compactedToolResults).toBeGreaterThan(0);
	});
});

function pathToolCall(toolName: string, path: string, id: string, prose = "working", timestamp = 1): AgentMessage {
	return fauxAssistantMessage([fauxText(prose), fauxToolCall(toolName, { path }, { id })], { timestamp });
}

function namedToolResult(
	toolName: string,
	toolCallId: string,
	text: string,
	options: { isError?: boolean; timestamp?: number } = {},
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [fauxText(text)],
		isError: options.isError ?? false,
		timestamp: options.timestamp ?? 1,
	};
}

function textOf(message: AgentMessage | undefined): string {
	if (message?.role !== "toolResult") return "";
	const block = message.content[0];
	return block?.type === "text" ? block.text : "";
}

function assistantTextOf(message: AgentMessage | undefined): string {
	if (message?.role !== "assistant") return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n");
}

function hasCompactedAssistantBlock(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false;
	return message.content.some(
		(block) =>
			block.type === "text" &&
			(block.text === AIRA_CONTEXT_COMPACTION_MARKERS.assistantProse ||
				block.text === AIRA_CONTEXT_COMPACTION_MARKERS.assistantThinking ||
				block.text.endsWith(AIRA_CONTEXT_COMPACTION_MARKERS.assistantConclusion)),
	);
}

const PROTECTION_SETTINGS = { triggerBytes: 100, recentBytes: 800, maxRecentMessageBytes: 2_000 };

/** read target -> repository search -> oversized result -> edit preparation. */
function pressureFixture(): { messages: AgentMessage[]; readResultIndex: number } {
	const messages: AgentMessage[] = [user("read the target and prepare an edit", 1)];
	messages.push(pathToolCall("read", "src/target.ts", "read-target", longProse("reading target"), 2));
	const readResultIndex = messages.length;
	messages.push(
		namedToolResult("read", "read-target", `TARGET FILE BODY ${"contents ".repeat(200)}`, { timestamp: 2 }),
	);
	messages.push(assistantProse(longProse("exploring the repository"), 3));
	messages.push(
		fauxAssistantMessage(
			[fauxText(longProse("searching")), fauxToolCall("search", { query: "needle" }, { id: "search-1" })],
			{ timestamp: 4 },
		),
	);
	messages.push(namedToolResult("search", "search-1", `SEARCH RESULT ${"hit ".repeat(20_000)}`, { timestamp: 4 }));
	messages.push(user("now prepare the edit", 5));
	return { messages, readResultIndex };
}

describe("compactAiraModelContext — progressive context protection", () => {
	it("keeps the latest read of an active path verbatim when a large result dominates", () => {
		const { messages, readResultIndex } = pressureFixture();
		const result = compactAiraModelContext(messages, settings(PROTECTION_SETTINGS));

		expect(result.report.triggered).toBe(true);
		expect(result.report.protectedActiveReads).toBe(1);
		expect(result.report.protectedActiveReadBytes).toBeGreaterThan(0);
		expect(result.report.activePathsConsidered).toBe(1);
		expect(result.report.oversizedResultCapApplied).toBeGreaterThanOrEqual(1);
		expect(result.messages[readResultIndex]).toBe(messages[readResultIndex]);
		expect(textOf(result.messages[readResultIndex])).toContain("TARGET FILE BODY");
	});

	it("eventually compacts an old read whose path is no longer active", () => {
		const messages: AgentMessage[] = [user("start", 1)];
		messages.push(pathToolCall("read", "src/old.ts", "old-read", longProse("reading old"), 2));
		messages.push(namedToolResult("read", "old-read", `OLD BODY ${"stale ".repeat(300)}`, { timestamp: 2 }));
		for (let i = 0; i < 5; i++) {
			messages.push(assistantProse(longProse(`filler ${i}`), 10 + i));
			messages.push(
				namedToolResult("search", `filler-${i}`, `FILLER ${"filler ".repeat(300)}`, { timestamp: 10 + i }),
			);
		}
		messages.push(user("active", 100));

		const result = compactAiraModelContext(
			messages,
			settings({ ...PROTECTION_SETTINGS, activePathLookbackMessages: 4 }),
		);
		expect(result.report.triggered).toBe(true);
		expect(result.report.activePathsConsidered).toBe(0);
		expect(result.report.protectedActiveReads).toBe(0);
		const oldRead = result.messages.find((m) => m.role === "toolResult" && m.toolCallId === "old-read");
		expect(textOf(oldRead).startsWith("[earlier read result compacted")).toBe(true);
	});

	it("bounds how many active paths can pin reads", () => {
		const messages: AgentMessage[] = [user("start", 1)];
		for (let i = 0; i < 6; i++) {
			messages.push(pathToolCall("read", `src/f${i}.ts`, `read-${i}`, longProse(`reading ${i}`), 2 + i));
			messages.push(
				namedToolResult("read", `read-${i}`, `BODY ${i} ${"content ".repeat(300)}`, { timestamp: 2 + i }),
			);
		}
		messages.push(
			fauxAssistantMessage(
				[fauxText(longProse("searching")), fauxToolCall("search", { query: "x" }, { id: "search-1" })],
				{ timestamp: 50 },
			),
		);
		messages.push(namedToolResult("search", "search-1", `HUGE ${"hit ".repeat(20_000)}`, { timestamp: 50 }));
		messages.push(user("active", 100));

		const result = compactAiraModelContext(
			messages,
			settings({ ...PROTECTION_SETTINGS, maxProtectedActiveReads: 2 }),
		);
		expect(result.report.protectedActiveReads).toBe(2);
		const bodies = result.messages.filter((m) => m.role === "toolResult" && m.toolCallId.startsWith("read-"));
		expect(bodies).toHaveLength(6);
		// The two newest reads survive; the older four are compacted.
		expect(textOf(bodies[5])).toContain("BODY 5");
		expect(textOf(bodies[4])).toContain("BODY 4");
		for (let i = 0; i < 4; i++) {
			expect(textOf(bodies[i]).startsWith("[earlier read result compacted")).toBe(true);
		}
	});

	it("protects only the latest read when a path is read repeatedly", () => {
		const messages: AgentMessage[] = [user("start", 1)];
		messages.push(pathToolCall("read", "src/foo.ts", "read-1", longProse("read one"), 2));
		messages.push(namedToolResult("read", "read-1", `FOO V1 ${"v1 ".repeat(300)}`, { timestamp: 2 }));
		messages.push(pathToolCall("read", "src/foo.ts", "read-2", longProse("read two"), 3));
		messages.push(namedToolResult("read", "read-2", `FOO V2 ${"v2 ".repeat(300)}`, { timestamp: 3 }));
		messages.push(
			fauxAssistantMessage(
				[fauxText(longProse("searching")), fauxToolCall("search", { query: "x" }, { id: "search-1" })],
				{ timestamp: 50 },
			),
		);
		messages.push(namedToolResult("search", "search-1", `HUGE ${"hit ".repeat(20_000)}`, { timestamp: 50 }));
		messages.push(user("active", 100));

		const result = compactAiraModelContext(messages, settings(PROTECTION_SETTINGS));
		expect(result.report.protectedActiveReads).toBe(1);
		const first = result.messages.find((m) => m.role === "toolResult" && m.toolCallId === "read-1");
		const second = result.messages.find((m) => m.role === "toolResult" && m.toolCallId === "read-2");
		expect(textOf(second)).toContain("FOO V2");
		expect(textOf(first).startsWith("[earlier read result compacted")).toBe(true);
	});

	it("does not protect errored reads", () => {
		const messages: AgentMessage[] = [user("start", 1)];
		messages.push(pathToolCall("read", "src/foo.ts", "read-1", longProse("read"), 2));
		messages.push(namedToolResult("read", "read-1", `FAILED ${"err ".repeat(300)}`, { isError: true, timestamp: 2 }));
		messages.push(
			fauxAssistantMessage(
				[fauxText(longProse("searching")), fauxToolCall("search", { query: "x" }, { id: "search-1" })],
				{ timestamp: 50 },
			),
		);
		messages.push(namedToolResult("search", "search-1", `HUGE ${"hit ".repeat(20_000)}`, { timestamp: 50 }));
		messages.push(user("active", 100));

		const result = compactAiraModelContext(messages, settings(PROTECTION_SETTINGS));
		expect(result.report.activePathsConsidered).toBe(1);
		expect(result.report.protectedActiveReads).toBe(0);
		const failed = result.messages.find((m) => m.role === "toolResult" && m.toolCallId === "read-1");
		expect(textOf(failed)).toContain("FAILED");
	});

	it("releases a read once a newer edit supersedes it", () => {
		const messages: AgentMessage[] = [user("start", 1)];
		messages.push(pathToolCall("read", "src/foo.ts", "read-1", longProse("read"), 2));
		messages.push(namedToolResult("read", "read-1", `FOO ${"body ".repeat(300)}`, { timestamp: 2 }));
		messages.push(pathToolCall("edit", "src/foo.ts", "edit-1", longProse("editing"), 3));
		messages.push(namedToolResult("edit", "edit-1", `EDITED ${"diff ".repeat(100)}`, { timestamp: 3 }));
		messages.push(
			fauxAssistantMessage(
				[fauxText(longProse("searching")), fauxToolCall("search", { query: "x" }, { id: "search-1" })],
				{ timestamp: 50 },
			),
		);
		messages.push(namedToolResult("search", "search-1", `HUGE ${"hit ".repeat(20_000)}`, { timestamp: 50 }));
		messages.push(user("active", 100));

		const result = compactAiraModelContext(messages, settings(PROTECTION_SETTINGS));
		expect(result.report.protectedActiveReads).toBe(0);
		const read = result.messages.find((m) => m.role === "toolResult" && m.toolCallId === "read-1");
		expect(textOf(read).startsWith("[earlier read result compacted")).toBe(true);
	});

	it("protects the latest read taken after an edit", () => {
		const messages: AgentMessage[] = [user("start", 1)];
		messages.push(pathToolCall("read", "src/foo.ts", "read-1", longProse("read one"), 2));
		messages.push(namedToolResult("read", "read-1", `FOO V1 ${"v1 ".repeat(300)}`, { timestamp: 2 }));
		messages.push(pathToolCall("edit", "src/foo.ts", "edit-1", longProse("editing"), 3));
		messages.push(namedToolResult("edit", "edit-1", `EDITED ${"diff ".repeat(100)}`, { timestamp: 3 }));
		messages.push(pathToolCall("read", "src/foo.ts", "read-2", longProse("re-reading"), 4));
		messages.push(namedToolResult("read", "read-2", `FOO V2 ${"v2 ".repeat(300)}`, { timestamp: 4 }));
		messages.push(
			fauxAssistantMessage(
				[fauxText(longProse("searching")), fauxToolCall("search", { query: "x" }, { id: "search-1" })],
				{ timestamp: 50 },
			),
		);
		messages.push(namedToolResult("search", "search-1", `HUGE ${"hit ".repeat(20_000)}`, { timestamp: 50 }));
		messages.push(user("active", 100));

		const result = compactAiraModelContext(messages, settings(PROTECTION_SETTINGS));
		expect(result.report.protectedActiveReads).toBe(1);
		const latest = result.messages.find((m) => m.role === "toolResult" && m.toolCallId === "read-2");
		expect(textOf(latest)).toContain("FOO V2");
	});

	it("stops one oversized result from monopolizing the recent window", () => {
		const build = (): AgentMessage[] => [
			user("start", 1),
			assistantProse(longProse("filler zero"), 2),
			namedToolResult("read", "filler-0", `FILLER 0 ${"filler ".repeat(300)}`, { timestamp: 2 }),
			assistantProse(longProse("filler one"), 3),
			namedToolResult("read", "filler-1", `FILLER 1 ${"filler ".repeat(300)}`, { timestamp: 3 }),
			assistantProse(longProse("valuable old context", 3_000), 4),
			namedToolResult("read", "valuable", `VALUABLE ${"body ".repeat(100)}`, { timestamp: 4 }),
			assistantProse("short thinking", 5),
			namedToolResult("read", "huge", `HUGE ${"hit ".repeat(40_000)}`, { timestamp: 5 }),
			user("active", 100),
		];

		const capped = compactAiraModelContext(
			build(),
			settings({ triggerBytes: 100, recentBytes: 1_000, maxRecentMessageBytes: 400 }),
		);
		expect(capped.report.triggered).toBe(true);
		expect(capped.report.oversizedResultCapApplied).toBeGreaterThanOrEqual(1);
		const cappedValuable = capped.messages.find((m) => m.role === "toolResult" && m.toolCallId === "valuable");
		expect(textOf(cappedValuable)).toContain("VALUABLE");

		const uncapped = compactAiraModelContext(
			build(),
			settings({ triggerBytes: 100, recentBytes: 1_000, maxRecentMessageBytes: Number.MAX_SAFE_INTEGER }),
		);
		expect(uncapped.report.oversizedResultCapApplied).toBe(0);
		const uncappedValuable = uncapped.messages.find((m) => m.role === "toolResult" && m.toolCallId === "valuable");
		expect(textOf(uncappedValuable).startsWith("[earlier read result compacted")).toBe(true);
	});

	it("is idempotent with active-read protection in play", () => {
		const { messages } = pressureFixture();
		const options = settings(PROTECTION_SETTINGS);
		const first = compactAiraModelContext(messages, options);
		const again = compactAiraModelContext(first.messages, options);
		expect(again.messages).toEqual(first.messages);
		expect(again.report.savedBytes).toBe(0);
	});

	it("records compacted context categories in the report", () => {
		const messages: AgentMessage[] = [user("start", 1)];
		for (let i = 0; i < 6; i++) {
			messages.push(
				fauxAssistantMessage([fauxThinking(longProse(`think ${i}`)), fauxText(longProse(`step ${i}`))], {
					timestamp: i + 2,
				}),
			);
			messages.push(
				namedToolResult(i % 2 === 0 ? "read" : "search", `call-${i}`, `body ${i} ${"payload ".repeat(500)}`, {
					timestamp: i + 2,
				}),
			);
		}
		messages.push(user("active", 100));

		const result = compactAiraModelContext(messages, settings({ triggerBytes: 100, recentBytes: 500 }));
		expect(result.report.triggered).toBe(true);
		expect(result.report.compactedAssistantThinking).toBeGreaterThan(0);
		expect(result.report.compactedAssistantNarration).toBeGreaterThan(0);
		expect(result.report.compactedToolResultsByTool.read ?? 0).toBeGreaterThan(0);
		const byToolTotal = Object.values(result.report.compactedToolResultsByTool).reduce((sum, n) => sum + n, 0);
		expect(byToolTotal).toBe(result.report.toolResultsCompacted);
	});

	it("protects a target read across substantial intervening exploration", () => {
		const messages: AgentMessage[] = [user("start", 1)];
		messages.push(pathToolCall("read", "src/target.ts", "read-target", longProse("reading target"), 2));
		const targetIndex = messages.length;
		messages.push(namedToolResult("read", "read-target", `TARGET ${"contents ".repeat(200)}`, { timestamp: 2 }));
		for (let i = 0; i < 40; i++) {
			messages.push(
				fauxAssistantMessage(
					[
						fauxText(longProse(`searching ${i}`)),
						fauxToolCall("search", { query: `q${i}` }, { id: `search-${i}` }),
					],
					{ timestamp: 3 + i },
				),
			);
			messages.push(
				namedToolResult("search", `search-${i}`, `HIT ${i} ${"hit ".repeat(200)}`, { timestamp: 3 + i }),
			);
		}
		messages.push(user("prepare the edit", 100));

		const result = compactAiraModelContext(messages, settings(PROTECTION_SETTINGS));
		expect(result.report.triggered).toBe(true);
		expect(result.report.protectedActiveReads).toBe(1);
		expect(result.messages[targetIndex]).toBe(messages[targetIndex]);
		expect(textOf(result.messages[targetIndex])).toContain("TARGET");
	});
});
