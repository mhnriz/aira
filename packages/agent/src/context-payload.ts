/**
 * Deterministic serialized-size measurement of one model request at the
 * canonical construction boundary.
 *
 * The boundary is `streamAssistantResponse`: after the agent context has been
 * transformed (`transformContext`) and converted to provider messages
 * (`convertToLlm`), the request is assembled as
 * `{ systemPrompt, messages, tools }` and handed to the stream function. This
 * module measures that exact assembly and nothing else — it never mutates,
 * clones, or retains any part of the request.
 *
 * Size unit: UTF-8 bytes of a stable JSON serialization.
 *
 * - The system prompt is a plain string; its raw UTF-8 byte length is used.
 * - Each provider message is serialized as `{ role, content }` (plus
 *   `toolCallId`/`toolName` for tool results) — the fields the request is
 *   built from. Response-side metadata fields (`usage`, `stopReason`,
 *   provider/model identity, response ids, diagnostics) are never part of an
 *   outgoing request and are excluded from the unit by design.
 * - Each tool definition is serialized as `{ name, description, parameters }`.
 *
 * Because the serialization is deterministic, identical runtime state yields
 * identical measurements, and per-request growth and composition are directly
 * comparable without re-reading conversation contents.
 */

import type { Context, Message, Tool } from "@earendil-works/pi-ai";

const textEncoder = new TextEncoder();

/** The subset of an agent message the measurement reads for identity. */
export interface ModelMessageIdentity {
	role: string;
	customType?: unknown;
	excludeFromContext?: unknown;
}

/**
 * One attributed piece of a request's conversation: a custom message type
 * that carries source identity through the conversion boundary (for example
 * `aira.intelligence`). Only identity keys and byte sizes are retained.
 */
export interface ModelContextContributorMeasurement {
	/** Contributor identity: a custom message type (e.g. "aira.intelligence"). */
	key: string;
	/** UTF-8 bytes of the provider messages this contributor produced. */
	bytes: number;
	/** Number of messages produced by this contributor. */
	messageCount: number;
}

/** Transport-level conversation breakdown by provider role. */
export interface ModelContextRoleBytes {
	userBytes: number;
	assistantBytes: number;
	toolResultBytes: number;
}

/**
 * Serialized-size measurement of one model request payload, captured before
 * dispatch. Metadata only: numbers, counts, and identity keys.
 */
export interface ModelContextPayloadMeasurement {
	/** System prompt bytes (raw UTF-8 string length). */
	systemBytes: number;
	/** Sum of the serialized provider-message sizes. */
	conversationBytes: number;
	/** Sum of the serialized tool-definition sizes. */
	toolsBytes: number;
	/** `systemBytes + conversationBytes + toolsBytes`. */
	totalBytes: number;
	/** Number of provider messages in the request. */
	messageCount: number;
	/** Number of tool definitions in the request. */
	toolCount: number;
	/** Per-role conversation breakdown. */
	conversation: ModelContextRoleBytes;
	/**
	 * Best-effort source attribution. Only messages that keep their identity
	 * through conversion (custom message types) appear here; everything else
	 * stays in the transport-level role buckets.
	 */
	contributors: ModelContextContributorMeasurement[];
}

function utf8ByteLength(text: string): number {
	return textEncoder.encode(text).length;
}

/**
 * The message projection whose JSON serialization is the measurement unit:
 * `{ role, content }` plus the tool-call identity fields for tool results.
 * This is exactly the field set provider layers consume to build the outgoing
 * request; response-side metadata is never sent.
 */
function messageProjection(message: Message): Record<string, unknown> {
	if (message.role === "toolResult") {
		return {
			role: message.role,
			content: message.content,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
		};
	}
	return { role: message.role, content: message.content };
}

/** The tool shape provider layers serialize into request tool schemas. */
function toolProjection(tool: Tool): Record<string, unknown> {
	return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

function roleOf(message: ModelMessageIdentity): string {
	return message.role;
}

/** Custom message type preserved through conversion, when one exists. */
function customMessageType(message: ModelMessageIdentity): string | undefined {
	if (roleOf(message) !== "custom") return undefined;
	const customType = message.customType;
	return typeof customType === "string" && customType.length > 0 ? customType : undefined;
}

/**
 * Whether an agent message produces a provider message under the standard
 * conversion contract. The only dropped messages are `bashExecution` messages
 * explicitly excluded from context.
 */
function isProviderVisible(message: ModelMessageIdentity): boolean {
	if (roleOf(message) === "bashExecution") {
		return message.excludeFromContext !== true;
	}
	return true;
}

/**
 * Attribute provider-message bytes to the agent message that produced them.
 *
 * The standard conversion is order-preserving and 1:1 (only context-excluded
 * bash executions drop out), so pairing is exact under that contract. If the
 * visible counts do not line up (a host uses a different conversion contract),
 * no attribution is reported at all — transport totals are unaffected and no
 * content is guessed into a false bucket.
 */
function attributeContributors(
	agentMessages: readonly ModelMessageIdentity[],
	messageBytes: number[],
): ModelContextContributorMeasurement[] {
	let visibleCount = 0;
	for (const message of agentMessages) {
		if (isProviderVisible(message)) visibleCount++;
	}
	if (visibleCount !== messageBytes.length) {
		return [];
	}
	const totals = new Map<string, { bytes: number; messageCount: number }>();
	let cursor = 0;
	for (const message of agentMessages) {
		if (!isProviderVisible(message)) continue;
		const customType = customMessageType(message);
		if (customType !== undefined) {
			const entry = totals.get(customType) ?? { bytes: 0, messageCount: 0 };
			entry.bytes += messageBytes[cursor] ?? 0;
			entry.messageCount += 1;
			totals.set(customType, entry);
		}
		cursor++;
	}
	return [...totals.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, entry]) => ({ key, bytes: entry.bytes, messageCount: entry.messageCount }));
}

/**
 * Measure the deterministic serialized size of one model-request payload.
 *
 * Pure observation: reads `agentMessages` (for source identity) and `context`
 * (the assembled request) and returns numbers. Nothing is modified, cloned,
 * or retained.
 */
export function measureModelContextPayload(
	agentMessages: readonly ModelMessageIdentity[],
	context: Context,
): ModelContextPayloadMeasurement {
	const messageBytes: number[] = [];
	const conversation: ModelContextRoleBytes = { userBytes: 0, assistantBytes: 0, toolResultBytes: 0 };
	for (const message of context.messages) {
		const bytes = utf8ByteLength(JSON.stringify(messageProjection(message)));
		messageBytes.push(bytes);
		switch (message.role) {
			case "user":
				conversation.userBytes += bytes;
				break;
			case "assistant":
				conversation.assistantBytes += bytes;
				break;
			case "toolResult":
				conversation.toolResultBytes += bytes;
				break;
		}
	}
	const systemBytes = utf8ByteLength(context.systemPrompt ?? "");
	let toolsBytes = 0;
	for (const tool of context.tools ?? []) {
		toolsBytes += utf8ByteLength(JSON.stringify(toolProjection(tool)));
	}
	const conversationBytes = conversation.userBytes + conversation.assistantBytes + conversation.toolResultBytes;
	return {
		systemBytes,
		conversationBytes,
		toolsBytes,
		totalBytes: systemBytes + conversationBytes + toolsBytes,
		messageCount: context.messages.length,
		toolCount: context.tools?.length ?? 0,
		conversation,
		contributors: attributeContributors(agentMessages, messageBytes),
	};
}
