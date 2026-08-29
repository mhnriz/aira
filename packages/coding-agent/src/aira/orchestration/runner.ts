/**
 * Aira orchestration — child runner.
 *
 * Executes one child as an independent fresh-context model invocation through
 * the session's stream function: child system prompt + bounded task envelope
 * + the mode-gated tool set. The parent conversation is never included. Tools
 * are bounded by `maxToolRounds` rounds and per-round call limits so a
 * runaway child cannot loop forever (the scheduler's timeout is the outer
 * bound).
 *
 * Failure behavior: any driver failure (model/provider error, timeout,
 * cancellation, tool-budget exhaustion, unparseable result) yields
 * `{ driverError }` — the manager maps it to a failed run with a bounded
 * failure category, never to a fabricated result. Token usage is carried
 * when the provider exposes it (`AssistantMessage.usage`) and never invented.
 */
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	Message,
	Model,
	SimpleStreamOptions,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai/compat";
import {
	boundChildList,
	boundChildText,
	MAX_CHILD_FINDING_CHARS,
	MAX_CHILD_FINDINGS,
	MAX_CHILD_ITEM_CHARS,
	MAX_CHILD_LIST_ITEMS,
	MAX_CHILD_SUMMARY_CHARS,
} from "./envelope.ts";
import type { AiraChildResult, AiraChildTokenUsage } from "./types.ts";

export const DEFAULT_CHILD_TIMEOUT_MS = 300_000;
export const MAX_CHILD_TOOL_ROUNDS = 8;
export const MAX_CHILD_TOOL_CALLS_PER_ROUND = 4;
export const MAX_CHILD_OUTPUT_TOKENS = 2_000;

export interface AiraChildRuntime {
	model: Model<any>;
	streamFn: StreamFn;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

export interface AiraChildRunnerOptions {
	cwd: string;
	/** Bounded child prompt (user message). */
	prompt: string;
	/** Child system prompt. */
	systemPrompt: string;
	/** Mode-gated tool set. */
	tools: AgentTool[];
	timeoutMs?: number;
	maxToolRounds?: number;
	thinkingLevel?: "off" | "low" | "medium" | "high";
}

export type AiraChildOutcome =
	| { ok: true; result: AiraChildResult; model: string; tokenUsage?: AiraChildTokenUsage }
	| { ok: false; driverError: string };

/** Run one fresh-context child (bounded tool loop + structured result). */
export async function runAiraChild(
	runtime: AiraChildRuntime,
	options: AiraChildRunnerOptions,
	signal?: AbortSignal,
): Promise<AiraChildOutcome> {
	const { model, streamFn } = runtime;
	if (!model) {
		return { ok: false, driverError: "no child model configured" };
	}

	const timeoutMs = options.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS;
	const maxRounds = options.maxToolRounds ?? MAX_CHILD_TOOL_ROUNDS;
	const baseOptions: SimpleStreamOptions = {
		maxTokens: MAX_CHILD_OUTPUT_TOKENS,
		cacheRetention: "none",
		toolChoice: "auto",
		...(options.thinkingLevel !== undefined && options.thinkingLevel !== "off" && model.reasoning
			? { reasoning: options.thinkingLevel }
			: {}),
	};
	if (runtime.apiKey !== undefined) baseOptions.apiKey = runtime.apiKey;
	if (runtime.headers !== undefined) baseOptions.headers = runtime.headers;
	if (runtime.env !== undefined) baseOptions.env = runtime.env;

	let timeoutTimer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timeoutTimer = setTimeout(() => reject(new Error("child timed out")), timeoutMs);
	});

	const messages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: options.prompt }],
			timestamp: Date.now(),
		},
	];

	let totalUsage: AiraChildTokenUsage | undefined;
	const accumulateUsage = (message: AssistantMessage): void => {
		const usage = message.usage;
		if (!usage || typeof usage.totalTokens !== "number") {
			return;
		}
		totalUsage = {
			input: (totalUsage?.input ?? 0) + (usage.input ?? 0),
			output: (totalUsage?.output ?? 0) + (usage.output ?? 0),
			cacheRead: (totalUsage?.cacheRead ?? 0) + (usage.cacheRead ?? 0),
			cacheWrite: (totalUsage?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0),
			total: (totalUsage?.total ?? 0) + (usage.totalTokens ?? 0),
		};
	};

	try {
		let assistant = await raceWithTimeout(
			callStream(streamFn, model, options.systemPrompt, messages, options.tools, baseOptions, signal),
			timeout,
			signal,
		);
		accumulateUsage(assistant);
		let round = 0;
		while (hasToolCalls(assistant) && round < maxRounds) {
			round += 1;
			const calls = toolCallsOf(assistant).slice(0, MAX_CHILD_TOOL_CALLS_PER_ROUND);
			if (calls.length === 0) {
				break;
			}
			const results: ToolResultMessage[] = [];
			for (const call of calls) {
				results.push(await executeChildTool(options.tools, call, signal));
			}
			messages.push(assistant, ...results);
			assistant = await raceWithTimeout(
				callStream(streamFn, model, options.systemPrompt, messages, options.tools, baseOptions, signal),
				timeout,
				signal,
			);
			accumulateUsage(assistant);
		}
		if (hasToolCalls(assistant)) {
			return { ok: false, driverError: "child exceeded its tool budget" };
		}
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			return { ok: false, driverError: assistant.errorMessage ?? `child ${assistant.stopReason}` };
		}
		const parsed = parseChildResult(contentText(assistant));
		if (!parsed) {
			return { ok: false, driverError: "child returned no valid structured result" };
		}
		return {
			ok: true,
			result: normalizeChildResult(parsed),
			model: assistant.responseModel ?? assistant.model,
			...(totalUsage !== undefined ? { tokenUsage: totalUsage } : {}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			driverError: message === "child timed out" ? `child timed out after ${timeoutMs}ms` : message,
		};
	} finally {
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
	}
}

function callStream(
	streamFn: StreamFn,
	model: Model<any>,
	systemPrompt: string,
	messages: Message[],
	tools: AgentTool[],
	options: SimpleStreamOptions,
	signal?: AbortSignal,
): Promise<AssistantMessage> {
	const maybePromise = streamFn(model, { systemPrompt, messages, tools }, { ...options, signal });
	return (maybePromise instanceof Promise ? maybePromise : Promise.resolve(maybePromise)).then((stream) =>
		stream.result(),
	);
}

function raceWithTimeout<T>(promise: Promise<T>, timeout: Promise<never>, signal?: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const settle = (action: () => void): void => {
			if (!settled) {
				settled = true;
				action();
			}
		};
		const onAbort = () => {
			settle(() => reject(new Error("child cancelled")));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => settle(() => resolve(value)),
			(error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
		);
		timeout.then(
			() => undefined,
			(error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
		);
	});
}

function hasToolCalls(message: AssistantMessage): boolean {
	return message.content.some((block) => (block as { type?: string }).type === "toolCall");
}

function toolCallsOf(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => (block as { type?: string }).type === "toolCall");
}

async function executeChildTool(tools: AgentTool[], call: ToolCall, signal?: AbortSignal): Promise<ToolResultMessage> {
	const tool = tools.find((candidate) => candidate.name === call.name);
	if (!tool) {
		return toolResultMessage(call, [{ type: "text", text: `unknown tool ${call.name}` }], true);
	}
	try {
		const params = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
		const result = await tool.execute(call.id, params, signal);
		return toolResultMessage(
			call,
			result.content,
			result.content.some(
				(block) =>
					(block as { type?: string }).type === "text" && (block as { text?: string }).text?.startsWith("Error"),
			),
		);
	} catch (error) {
		return toolResultMessage(
			call,
			[{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
			true,
		);
	}
}

function toolResultMessage(call: ToolCall, content: ToolResultMessage["content"], isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content,
		isError,
		timestamp: Date.now(),
	};
}

function contentText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => (block as { type?: string }).type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/** Extract the structured result JSON from the child's final text. */
export function parseChildResult(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	const fenced = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i.exec(trimmed)?.[1];
	const objectStart = trimmed.indexOf("{");
	const objectEnd = trimmed.lastIndexOf("}");
	const embedded = objectStart >= 0 && objectEnd > objectStart ? trimmed.slice(objectStart, objectEnd + 1) : undefined;
	for (const candidate of [fenced, embedded, trimmed]) {
		if (!candidate) {
			continue;
		}
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// fall through to the next candidate
		}
	}
	return undefined;
}

/** Normalize + bound a raw child result into the hardened contract. */
export function normalizeChildResult(value: Record<string, unknown>): AiraChildResult {
	const rawStatus = value.status;
	const status = rawStatus === "failed" ? "failed" : "completed";
	const summary = boundChildText(typeof value.summary === "string" ? value.summary : "", MAX_CHILD_SUMMARY_CHARS);
	const findings = boundChildList(asStringList(value.findings), MAX_CHILD_FINDINGS, MAX_CHILD_FINDING_CHARS);
	const evidence = boundChildList(asStringList(value.evidence), MAX_CHILD_LIST_ITEMS, MAX_CHILD_ITEM_CHARS);
	const relevantFiles = boundChildList(asStringList(value.relevantFiles), MAX_CHILD_LIST_ITEMS, MAX_CHILD_ITEM_CHARS);
	const changedFiles = boundChildList(asStringList(value.changedFiles), MAX_CHILD_LIST_ITEMS, MAX_CHILD_ITEM_CHARS);
	const tests = boundChildList(asStringList(value.tests), MAX_CHILD_LIST_ITEMS, MAX_CHILD_ITEM_CHARS);
	const errors = boundChildList(asStringList(value.errors), MAX_CHILD_LIST_ITEMS, MAX_CHILD_ITEM_CHARS);
	return {
		status,
		summary:
			summary.length > 0
				? summary
				: status === "failed"
					? "Child reported failure without a summary."
					: "Child returned no summary.",
		findings,
		evidence,
		relevantFiles,
		changedFiles,
		tests,
		errors,
	};
}

function asStringList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is string => typeof entry === "string");
}
