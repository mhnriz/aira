/**
 * Aira progressive context compaction (0.1.7 Step 4).
 *
 * Long sessions grow monotonically: every assistant narration block and every
 * tool result stays in the model-visible projection forever. Step 3 bounded the
 * fixed cost (tool definitions); this module bounds the GROWING cost without a
 * summarizer model call.
 *
 * Boundary this module works at:
 *
 * ```text
 * canonical session history (agent.state.messages)
 *     │  untouched — UI, persistence, resume, fork, clone, export
 *     │
 *     └─ model-context projection (transformContext)
 *            ↓
 *         compact OLD messages deterministically
 *            ↓
 *         provider
 * ```
 *
 * The transform is a pure function of the input array: it never mutates its
 * input, never calls a model, never reads the filesystem, and produces
 * identical output for identical input. It is also idempotent — compacting an
 * already-compacted projection returns the same bytes.
 *
 * Structure, not deletion:
 *
 * - recent history stays verbatim (byte budget, not message count);
 * - the latest user message and everything after it always stay verbatim (the
 *   active request and its tool chain);
 * - old assistant prose is reduced to a bounded head plus a truthful marker;
 * - old successful tool results are reduced to a bounded placeholder that
 *   keeps the call identity; errored tool results are never touched;
 * - messages are never deleted, so assistant tool calls and their results
 *   stay structurally paired;
 * - anything the compactor cannot prove safe (unknown roles, custom Aira
 *   messages, user-authored content) is preserved unchanged.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai/compat";

/**
 * Deterministic compaction policy. Every value is a byte/character threshold,
 * never a wall-clock or semantic rule.
 */
export interface AiraContextCompactionSettings {
	/** Master switch; when false the projection is returned unchanged. */
	enabled: boolean;
	/**
	 * Total conversation-projection bytes at which compaction starts.
	 * Below this the projection is returned unchanged (small sessions pay
	 * nothing). Default: 48 KB.
	 */
	triggerBytes: number;
	/**
	 * Newest history kept fully verbatim, measured in conversation-projection
	 * bytes from the newest message backwards. Default: 32 KB.
	 */
	recentBytes: number;
	/**
	 * Assistant prose shorter than this is left alone even when old. Keeps
	 * short terminal conclusions intact. Default: 200 chars.
	 */
	minAssistantProseChars: number;
	/**
	 * Bounded head kept from an old assistant message that carries no tool
	 * call (a turn conclusion). Longer conclusions keep this many leading
	 * characters. Default: 400 chars.
	 */
	assistantConclusionHeadChars: number;
	/**
	 * Successful tool results smaller than this are left alone even when old.
	 * Default: 400 bytes.
	 */
	minToolResultBytes: number;
}

/** The canonical default policy. Deterministic; identical across sessions. */
export const DEFAULT_AIRA_CONTEXT_COMPACTION_SETTINGS: AiraContextCompactionSettings = {
	enabled: true,
	triggerBytes: 48_000,
	recentBytes: 32_000,
	minAssistantProseChars: 200,
	assistantConclusionHeadChars: 400,
	minToolResultBytes: 400,
};

/**
 * Deterministic placeholders. They carry structural metadata only — a role,
 * an optional tool name, and a byte size — never discarded content, never a
 * fabricated conclusion, never a success/failure claim the compactor cannot
 * prove.
 */
export const AIRA_CONTEXT_COMPACTION_MARKERS = {
	/** Replaces an old assistant narration block. */
	assistantProse: "[older assistant progress text compacted]",
	/** Appended to the bounded head of an old assistant conclusion. */
	assistantConclusion: "[rest of older assistant message compacted]",
	/** Replaces an old assistant reasoning block. */
	assistantThinking: "[older assistant reasoning compacted]",
	/** Replaces an old successful tool result payload. */
	toolResult: (toolName: string, bytes: number) => `[earlier ${toolName} result compacted: ${bytes} bytes]`,
} as const;

/** One compaction pass's deterministic accounting (metadata only). */
export interface AiraContextCompactionReport {
	/** The policy switch that was in effect for this pass. */
	enabled: boolean;
	/** Whether the trigger threshold was crossed and old content was reduced. */
	triggered: boolean;
	/** Conversation-projection bytes of the input projection. */
	originalBytes: number;
	/** Conversation-projection bytes of the output projection. */
	compactedBytes: number;
	/** `originalBytes - compactedBytes` (never negative). */
	savedBytes: number;
	/** Number of assistant messages whose prose/reasoning was reduced. */
	messagesCompacted: number;
	/** Number of successful tool results whose payload was reduced. */
	toolResultsCompacted: number;
	/** Lowest message index touched by this pass, or null when untouched. */
	firstCompactedIndex: number | null;
}

/** Result of one deterministic projection pass. */
export interface AiraContextCompactionResult {
	/** The model-visible projection. Never the input array instance. */
	messages: AgentMessage[];
	report: AiraContextCompactionReport;
}

/**
 * The message projection whose JSON serialization measures conversation size.
 * Mirrors the provider request projection used by Context Payload Telemetry:
 * `{ role, content }`, plus tool identity for tool results. Response-side
 * metadata (usage, api, provider, signatures) is not part of an outgoing
 * request and is excluded here too.
 */
function messageProjection(message: AgentMessage): Record<string, unknown> {
	if (message.role === "toolResult") {
		return {
			role: message.role,
			content: message.content,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
		};
	}
	if (message.role === "user" || message.role === "custom") {
		return { role: message.role, content: message.content };
	}
	if (message.role === "bashExecution") {
		// Converted to a user message carrying command + output; measure the
		// same information so the size accounting stays truthful. Bash
		// executions are never compacted (fail open).
		return {
			role: message.role,
			command: message.command,
			output: message.output,
			excludeFromContext: message.excludeFromContext === true,
		};
	}
	return { role: message.role, content: (message as { content: unknown }).content };
}

const textEncoder = new TextEncoder();

/** Deterministic UTF-8 byte length of one message projection. */
function projectionBytes(message: AgentMessage): number {
	return textEncoder.encode(JSON.stringify(messageProjection(message))).length;
}

/** Total conversation-projection bytes of a message array. */
export function measureAiraConversationBytes(messages: readonly AgentMessage[]): number {
	let total = 0;
	for (const message of messages) {
		total += projectionBytes(message);
	}
	return total;
}

function isPlaceholder(text: string): boolean {
	return (
		text === AIRA_CONTEXT_COMPACTION_MARKERS.assistantProse ||
		text === AIRA_CONTEXT_COMPACTION_MARKERS.assistantThinking ||
		text.startsWith("[earlier ") ||
		text.endsWith(AIRA_CONTEXT_COMPACTION_MARKERS.assistantConclusion)
	);
}

/**
 * Reduce one assistant text block. Idempotent: an already-compacted block is
 * returned unchanged, so repeated projections converge instead of eroding the
 * retained head.
 */
function compactAssistantText(text: string, keepHeadChars: number, minChars: number): string {
	if (isPlaceholder(text)) return text;
	if (text.length < minChars) return text;
	if (text.length <= keepHeadChars) return text;
	return `${text.slice(0, keepHeadChars)}\n${AIRA_CONTEXT_COMPACTION_MARKERS.assistantConclusion}`;
}

/**
 * Reduce one old assistant message in place-free fashion.
 *
 * - tool-call carriers keep every `toolCall` block verbatim (protocol identity:
 *   id, name, arguments) and only shrink narration/reasoning;
 * - a message with no tool call is a turn conclusion: its prose keeps a bounded
 *   head so the conclusion survives.
 */
function compactAssistantMessage(message: AssistantMessage, settings: AiraContextCompactionSettings): AssistantMessage {
	const hasToolCall = message.content.some((block) => block.type === "toolCall");
	let changed = false;
	const content = message.content.map((block) => {
		if (block.type === "text") {
			const next = hasToolCall
				? isPlaceholder(block.text) || block.text.length < settings.minAssistantProseChars
					? block.text
					: AIRA_CONTEXT_COMPACTION_MARKERS.assistantProse
				: compactAssistantText(block.text, settings.assistantConclusionHeadChars, settings.minAssistantProseChars);
			if (next !== block.text) changed = true;
			return next === block.text ? block : ({ ...block, text: next } satisfies TextContent);
		}
		if (block.type === "thinking") {
			if (isPlaceholder(block.thinking)) return block;
			changed = true;
			return { ...block, thinking: AIRA_CONTEXT_COMPACTION_MARKERS.assistantThinking };
		}
		return block;
	});
	if (!changed) return message;
	return { ...message, content };
}

/**
 * Reduce one old successful tool result to a bounded placeholder that keeps
 * the call identity (`toolCallId`, `toolName`, `isError`). Errored results are
 * preserved: an unresolved failure may still matter to the task.
 */
function compactToolResultMessage(
	message: Extract<AgentMessage, { role: "toolResult" }>,
	settings: AiraContextCompactionSettings,
): { message: AgentMessage; compacted: boolean } {
	if (message.isError) return { message, compacted: false };
	const bytes = projectionBytes(message);
	if (bytes < settings.minToolResultBytes) return { message, compacted: false };
	const first = message.content[0];
	if (message.content.length === 1 && first?.type === "text" && first.text.startsWith("[earlier ")) {
		return { message, compacted: false };
	}
	const placeholder: TextContent = {
		type: "text",
		text: AIRA_CONTEXT_COMPACTION_MARKERS.toolResult(message.toolName, bytes),
	};
	return {
		message: { ...message, content: [placeholder] },
		compacted: true,
	};
}

/**
 * Reduce one message if it is safe to do so. Returns the original reference
 * when nothing was provably safe, so callers can keep identity for every
 * protected message.
 */
function compactMessage(
	message: AgentMessage,
	settings: AiraContextCompactionSettings,
): { message: AgentMessage; compacted: boolean } {
	switch (message.role) {
		case "assistant": {
			const next = compactAssistantMessage(message as AssistantMessage, settings);
			return { message: next, compacted: next !== message };
		}
		case "toolResult":
			return compactToolResultMessage(message as Extract<AgentMessage, { role: "toolResult" }>, settings);
		default:
			// Fail open: user content, bash executions, Aira custom messages
			// (intelligence/browser context), summaries, and any future message
			// type are preserved unchanged.
			return { message, compacted: false };
	}
}

/**
 * Compute the deterministic model-visible projection.
 *
 * Pure: the input array and its messages are never mutated. The output is a
 * new array whose entries are either the original message reference
 * (protected/verbatim) or a reduced copy.
 */
export function compactAiraModelContext(
	messages: readonly AgentMessage[],
	settings: AiraContextCompactionSettings = DEFAULT_AIRA_CONTEXT_COMPACTION_SETTINGS,
): AiraContextCompactionResult {
	const originalBytes = measureAiraConversationBytes(messages);
	const baseReport: AiraContextCompactionReport = {
		enabled: settings.enabled,
		triggered: false,
		originalBytes,
		compactedBytes: originalBytes,
		savedBytes: 0,
		messagesCompacted: 0,
		toolResultsCompacted: 0,
		firstCompactedIndex: null,
	};
	if (!settings.enabled || originalBytes <= settings.triggerBytes || messages.length === 0) {
		return { messages: messages.slice(), report: baseReport };
	}

	// The active request and everything it produced stay verbatim: nothing at
	// or after the newest user message is ever eligible.
	let activeStart = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			activeStart = i;
			break;
		}
	}

	// The recent window is a byte budget measured from the newest message
	// backwards, additionally clamped so it never reaches into the active
	// request.
	let verbatimStart = messages.length;
	let accumulated = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (i < activeStart) break;
		accumulated += projectionBytes(messages[i]);
		verbatimStart = i;
		if (accumulated >= settings.recentBytes) break;
	}
	if (activeStart < verbatimStart) verbatimStart = activeStart;

	if (verbatimStart === 0) {
		return { messages: messages.slice(), report: baseReport };
	}

	const output: AgentMessage[] = messages.slice();
	let messagesCompacted = 0;
	let toolResultsCompacted = 0;
	let firstCompactedIndex: number | null = null;
	let compactedBytes = 0;

	for (let i = 0; i < verbatimStart; i++) {
		const before = projectionBytes(messages[i]);
		const outcome = compactMessage(messages[i], settings);
		if (!outcome.compacted) continue;
		output[i] = outcome.message;
		const after = projectionBytes(outcome.message);
		compactedBytes += before - after;
		if (firstCompactedIndex === null) firstCompactedIndex = i;
		if (messages[i].role === "toolResult") {
			toolResultsCompacted++;
		} else {
			messagesCompacted++;
		}
	}

	if (firstCompactedIndex === null) {
		return { messages: messages.slice(), report: baseReport };
	}

	return {
		messages: output,
		report: {
			enabled: true,
			triggered: true,
			originalBytes,
			compactedBytes: originalBytes - compactedBytes,
			savedBytes: compactedBytes,
			messagesCompacted,
			toolResultsCompacted,
			firstCompactedIndex,
		},
	};
}
