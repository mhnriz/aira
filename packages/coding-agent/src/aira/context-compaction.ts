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
 * Active-request protection is deliberately narrower than "protect everything
 * the request produced". One user prompt can drive hundreds of model/tool
 * turns; keeping all of that history verbatim until a second user message
 * arrives would make the common workload ineligible for compaction entirely.
 *
 * Structure, not deletion:
 *
 * - recent history stays verbatim (byte budget, not message count);
 * - the latest user message always stays verbatim (the active request);
 * - the execution history produced after that request is NOT permanently
 *   protected: its newest bytes stay verbatim, older bytes become eligible,
 *   so a single long-running user turn can still compact;
 * - a tool call/result pair straddling the recent-byte boundary is pulled into
 *   the verbatim window instead of being split;
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
	/**
	 * Upper bound on how many conversation-projection bytes a single message
	 * may charge against the recent-byte window. A result larger than this no
	 * longer consumes the whole window by itself, so nearby older context stays
	 * verbatim. Default: 8 KB.
	 */
	maxRecentMessageBytes: number;
	/**
	 * How far back (in messages) the compactor looks for active repository
	 * paths. Activity older than this no longer protects a read. Default: 256.
	 */
	activePathLookbackMessages: number;
	/**
	 * Upper bound on the number of distinct active paths whose latest
	 * successful read is protected from compaction in one pass. Default: 2.
	 */
	maxProtectedActiveReads: number;
}

/** The canonical default policy. Deterministic; identical across sessions. */
export const DEFAULT_AIRA_CONTEXT_COMPACTION_SETTINGS: AiraContextCompactionSettings = {
	enabled: true,
	triggerBytes: 48_000,
	recentBytes: 32_000,
	minAssistantProseChars: 200,
	assistantConclusionHeadChars: 400,
	minToolResultBytes: 400,
	maxRecentMessageBytes: 8_000,
	activePathLookbackMessages: 256,
	maxProtectedActiveReads: 2,
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
	/** Messages kept verbatim because they fall inside the recent-byte window. */
	protectedByRecentWindow: number;
	/** Projection bytes kept verbatim by the recent-byte window. */
	protectedByRecentWindowBytes: number;
	/** Distinct active repository paths considered by this pass. */
	activePathsConsidered: number;
	/** Successful active-path reads kept verbatim outside the recent window. */
	protectedActiveReads: number;
	/** Projection bytes retained by active-path read protection. */
	protectedActiveReadBytes: number;
	/** Assistant reasoning blocks replaced by the thinking marker. */
	compactedAssistantThinking: number;
	/** Assistant narration blocks reduced (replaced or truncated). */
	compactedAssistantNarration: number;
	/** Successful tool results compacted, keyed by tool name. */
	compactedToolResultsByTool: Record<string, number>;
	/** Messages whose recent-byte charge was capped as oversized. */
	oversizedResultCapApplied: number;
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
function compactAssistantMessage(
	message: AssistantMessage,
	settings: AiraContextCompactionSettings,
): { message: AssistantMessage; narration: number; thinking: number } {
	const hasToolCall = message.content.some((block) => block.type === "toolCall");
	let changed = false;
	let narration = 0;
	let thinking = 0;
	const content = message.content.map((block) => {
		if (block.type === "text") {
			const next = hasToolCall
				? isPlaceholder(block.text) || block.text.length < settings.minAssistantProseChars
					? block.text
					: AIRA_CONTEXT_COMPACTION_MARKERS.assistantProse
				: compactAssistantText(block.text, settings.assistantConclusionHeadChars, settings.minAssistantProseChars);
			if (next !== block.text) {
				changed = true;
				narration++;
			}
			return next === block.text ? block : ({ ...block, text: next } satisfies TextContent);
		}
		if (block.type === "thinking") {
			if (isPlaceholder(block.thinking)) return block;
			changed = true;
			thinking++;
			return { ...block, thinking: AIRA_CONTEXT_COMPACTION_MARKERS.assistantThinking };
		}
		return block;
	});
	if (!changed) return { message, narration: 0, thinking: 0 };
	return { message: { ...message, content }, narration, thinking };
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
 * Keep each logical tool interaction on one side of the verbatim boundary.
 *
 * A tool result always follows its call in canonical history, so a pair can
 * straddle the recent-byte boundary in only one direction: the call is
 * eligible while its result is verbatim. Splitting the pair is structurally
 * legal (tool calls are never removed), but the conservative rule here is to
 * keep the whole interaction verbatim. Pulling the boundary down can expose
 * further straddling pairs, so the scan runs to a fixpoint.
 *
 * Deterministic and linear: `toolCallsById` is built once.
 */
function extendVerbatimOverStraddlingToolPairs(messages: readonly AgentMessage[], verbatimStart: number): number {
	const toolCallsById = new Map<string, number>();
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			if (!toolCallsById.has(block.id)) toolCallsById.set(block.id, i);
		}
	}

	let boundary = verbatimStart;
	for (let i = messages.length - 1; i >= boundary; i--) {
		const message = messages[i];
		if (message.role !== "toolResult") continue;
		const callIndex = toolCallsById.get(message.toolCallId);
		if (callIndex === undefined || callIndex >= boundary) continue;
		// The pair straddles: move the boundary up to the call. Lower indices
		// are visited by later iterations, so the walk still converges.
		if (callIndex < boundary) {
			boundary = callIndex;
			i = callIndex + 1;
		}
	}
	return boundary;
}

/**
 * Reduce one message if it is safe to do so. Returns the original reference
 * when nothing was provably safe, so callers can keep identity for every
 * protected message.
 */
function compactMessage(
	message: AgentMessage,
	settings: AiraContextCompactionSettings,
): { message: AgentMessage; compacted: boolean; narrationBlocks: number; thinkingBlocks: number } {
	switch (message.role) {
		case "assistant": {
			const result = compactAssistantMessage(message as AssistantMessage, settings);
			return {
				message: result.message,
				compacted: result.message !== message,
				narrationBlocks: result.narration,
				thinkingBlocks: result.thinking,
			};
		}
		case "toolResult": {
			const result = compactToolResultMessage(message as Extract<AgentMessage, { role: "toolResult" }>, settings);
			return { message: result.message, compacted: result.compacted, narrationBlocks: 0, thinkingBlocks: 0 };
		}
		default:
			// Fail open: user content, bash executions, Aira custom messages
			// (intelligence/browser context), summaries, and any future message
			// type are preserved unchanged.
			return { message, compacted: false, narrationBlocks: 0, thinkingBlocks: 0 };
	}
}

/** Tool names whose `path` argument marks a repository path as active. */
const ACTIVE_READ_TOOL_NAMES = new Set(["read"]);
const ACTIVE_MUTATION_TOOL_NAMES = new Set(["edit", "write"]);

/** Read the `path` string argument out of a tool call, if present. */
function toolCallPath(block: { name: string; arguments: Record<string, unknown> }): string | undefined {
	if (!ACTIVE_READ_TOOL_NAMES.has(block.name) && !ACTIVE_MUTATION_TOOL_NAMES.has(block.name)) return undefined;
	const value = block.arguments.path;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface ActivePathActivity {
	readIndex: number;
	readBytes: number;
	mutationIndex: number;
}

/**
 * Pick the bounded set of active-path reads to protect from compaction.
 *
 * Compaction is otherwise positional: a large newest result can push the
 * latest exact read of a file the model is still working on outside the
 * recent-byte window. This helper reads only existing tool-call metadata:
 *
 * - active paths are the most recently touched paths (read/edit/write) within
 *   `activePathLookbackMessages` messages of the tail, capped by
 *   `maxProtectedActiveReads` and a small candidate bound;
 * - for each active path it protects the latest successful read result;
 * - an edit/write newer than that read makes the read stale, so it is not
 *   protected (the mutation result carries the newer working copy);
 * - errored reads are never protected.
 *
 * Deterministic and linear in the message count.
 */
function collectActiveReadProtection(
	messages: readonly AgentMessage[],
	settings: AiraContextCompactionSettings,
): { indices: Set<number>; activePaths: number; bytes: number } {
	if (settings.maxProtectedActiveReads <= 0 || settings.activePathLookbackMessages <= 0) {
		return { indices: new Set(), activePaths: 0, bytes: 0 };
	}

	// Collect the most recently touched distinct paths, newest first. The
	// candidate bound keeps the scan bounded even for a very long history.
	const windowStart = Math.max(0, messages.length - settings.activePathLookbackMessages);
	const candidateLimit = settings.maxProtectedActiveReads * 4;
	const candidates: string[] = [];
	const seen = new Set<string>();
	for (let i = messages.length - 1; i >= windowStart && candidates.length < candidateLimit; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (let b = message.content.length - 1; b >= 0; b--) {
			const block = message.content[b];
			if (block.type !== "toolCall") continue;
			const path = toolCallPath(block);
			if (path === undefined || seen.has(path)) continue;
			seen.add(path);
			candidates.push(path);
			if (candidates.length >= candidateLimit) break;
		}
	}
	if (candidates.length === 0) return { indices: new Set(), activePaths: 0, bytes: 0 };

	const candidateSet = new Set(candidates);
	const activity = new Map<string, ActivePathActivity>();
	for (const path of candidates) activity.set(path, { readIndex: -1, readBytes: 0, mutationIndex: -1 });

	const readCallPaths = new Map<string, string>();
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const path = toolCallPath(block);
				if (path === undefined || !candidateSet.has(path)) continue;
				if (ACTIVE_MUTATION_TOOL_NAMES.has(block.name)) {
					const entry = activity.get(path);
					if (entry !== undefined && i > entry.mutationIndex) entry.mutationIndex = i;
				}
				if (ACTIVE_READ_TOOL_NAMES.has(block.name)) readCallPaths.set(block.id, path);
			}
			continue;
		}
		if (message.role === "toolResult" && !message.isError) {
			const path = readCallPaths.get(message.toolCallId);
			if (path === undefined) continue;
			const entry = activity.get(path);
			if (entry !== undefined && i > entry.readIndex) {
				entry.readIndex = i;
				entry.readBytes = projectionBytes(message);
			}
		}
	}

	// Walk candidates in recency order so the cap keeps the newest protectable
	// reads.
	const indices = new Set<number>();
	let bytes = 0;
	for (const path of candidates) {
		if (indices.size >= settings.maxProtectedActiveReads) break;
		const entry = activity.get(path);
		if (entry === undefined || entry.readIndex < 0) continue;
		if (entry.mutationIndex > entry.readIndex) continue;
		indices.add(entry.readIndex);
		bytes += entry.readBytes;
	}
	return { indices, activePaths: candidates.length, bytes };
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
		protectedByRecentWindow: 0,
		protectedByRecentWindowBytes: 0,
		activePathsConsidered: 0,
		protectedActiveReads: 0,
		protectedActiveReadBytes: 0,
		compactedAssistantThinking: 0,
		compactedAssistantNarration: 0,
		compactedToolResultsByTool: {},
		oversizedResultCapApplied: 0,
	};
	if (!settings.enabled || originalBytes <= settings.triggerBytes || messages.length === 0) {
		return { messages: messages.slice(), report: baseReport };
	}

	// The active request is the newest user message. It is protected on its
	// own; the execution history produced after it is not.
	let activeUserIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			activeUserIndex = i;
			break;
		}
	}

	// The recent window is a byte budget measured from the newest message
	// backwards. The active user request never consumes budget: it is kept
	// verbatim regardless, so charging its bytes would only shrink the
	// protection of the work tail for no structural benefit.
	let verbatimStart = messages.length;
	let accumulated = 0;
	let oversizedResultCapApplied = 0;
	const recentMessageCap =
		settings.maxRecentMessageBytes > 0 ? settings.maxRecentMessageBytes : Number.POSITIVE_INFINITY;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (i === activeUserIndex) continue;
		const bytes = projectionBytes(messages[i]);
		if (bytes > recentMessageCap) oversizedResultCapApplied++;
		// Charge at most `recentMessageCap` so one oversized message cannot
		// monopolize the whole window and evict nearby useful context.
		accumulated += Math.min(bytes, recentMessageCap);
		verbatimStart = i;
		if (accumulated >= settings.recentBytes) break;
	}

	verbatimStart = extendVerbatimOverStraddlingToolPairs(messages, verbatimStart);

	if (verbatimStart === 0) {
		return { messages: messages.slice(), report: baseReport };
	}

	// Active-path reads outside the recent window stay verbatim so a large
	// newest result cannot push the file the model is still working on out of
	// context.
	const protection = collectActiveReadProtection(messages, settings);

	let protectedByRecentWindow = 0;
	let protectedByRecentWindowBytes = 0;
	for (let i = verbatimStart; i < messages.length; i++) {
		if (i === activeUserIndex) continue;
		protectedByRecentWindow++;
		protectedByRecentWindowBytes += projectionBytes(messages[i]);
	}

	const output: AgentMessage[] = messages.slice();
	let messagesCompacted = 0;
	let toolResultsCompacted = 0;
	let firstCompactedIndex: number | null = null;
	let compactedBytes = 0;
	let compactedAssistantNarration = 0;
	let compactedAssistantThinking = 0;
	let protectedActiveReads = 0;
	let protectedActiveReadBytes = 0;
	const compactedToolResultsByTool: Record<string, number> = {};

	for (let i = 0; i < verbatimStart; i++) {
		// The active user request is never compacted, whatever the byte
		// budget says. Role dispatch already fails open for user content;
		// this is the explicit invariant.
		if (i === activeUserIndex) continue;
		const source = messages[i];
		const before = projectionBytes(source);
		const outcome = compactMessage(source, settings);
		if (protection.indices.has(i)) {
			// Keep the latest useful read for an active path. Only count it as
			// protected when compaction would otherwise have shrunk it.
			if (outcome.compacted) {
				protectedActiveReads++;
				protectedActiveReadBytes += before;
			}
			continue;
		}
		if (!outcome.compacted) continue;
		output[i] = outcome.message;
		const after = projectionBytes(outcome.message);
		compactedBytes += before - after;
		if (firstCompactedIndex === null) firstCompactedIndex = i;
		if (source.role === "toolResult") {
			toolResultsCompacted++;
			const toolName = source.toolName;
			compactedToolResultsByTool[toolName] = (compactedToolResultsByTool[toolName] ?? 0) + 1;
		} else {
			messagesCompacted++;
			compactedAssistantNarration += outcome.narrationBlocks;
			compactedAssistantThinking += outcome.thinkingBlocks;
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
			protectedByRecentWindow,
			protectedByRecentWindowBytes,
			activePathsConsidered: protection.activePaths,
			protectedActiveReads,
			protectedActiveReadBytes,
			compactedAssistantThinking,
			compactedAssistantNarration,
			compactedToolResultsByTool,
			oversizedResultCapApplied,
		},
	};
}
