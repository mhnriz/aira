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
	AssistantMessageEvent,
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
import {
	type AiraChildEvent,
	boundChildEventText,
	MAX_CHILD_EVENT_ARGS_CHARS,
	MAX_CHILD_EVENT_RESULT_DETAIL_CHARS,
	MAX_CHILD_EVENT_RESULT_SUMMARY_CHARS,
	MAX_CHILD_EVENT_TEXT_CHARS,
} from "./events.ts";
import type { AiraChildResult, AiraChildTokenUsage } from "./types.ts";

export const DEFAULT_CHILD_TIMEOUT_MS = 300_000;
export const MAX_CHILD_TOOL_ROUNDS = 8;
export const MAX_CHILD_TOOL_CALLS_PER_ROUND = 4;
export const MAX_CHILD_OUTPUT_TOKENS = 2_000;
export const MAX_CHILD_TOOL_EXTENSIONS = 1;
export const CHILD_TOOL_EXTENSION_CALLS = 8;

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
	/**
	 * Phase 11 permission seam: deterministic child tool gate (root-owned
	 * authorization; children never prompt — ASK resolves to DENY upstream).
	 */
	gateTool?: (toolName: string, args: Record<string, unknown>) => { block: boolean; reason?: string } | undefined;
	timeoutMs?: number;
	maxToolRounds?: number;
	thinkingLevel?: "off" | "low" | "medium" | "high";
	/**
	 * Live structured event sink (Agent Inspector). The runner captures the
	 * stream's Pi events (text/thinking/tool calls) and tool outcomes;
	 * lifecycle status/failure/completion events are emitted by the manager.
	 * Optional — plain runs (tests without an inspector) skip capture.
	 */
	events?: (event: AiraChildEvent) => void;
	/** Host callback for successful child edit/write operations. */
	workspaceMutation?: (path: string) => void;
}

export type AiraChildOutcome =
	| {
			ok: true;
			result: AiraChildResult;
			model: string;
			tokenUsage?: AiraChildTokenUsage;
			toolCallsUsed?: number;
			toolBudgetLimit?: number;
			toolBudgetExtensions?: number;
	  }
	| {
			ok: false;
			driverError: string;
			toolCallsUsed?: number;
			toolBudgetLimit?: number;
			toolBudgetExtensions?: number;
	  };

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
	let allowedRounds = maxRounds;
	let toolBudgetLimit = maxRounds * MAX_CHILD_TOOL_CALLS_PER_ROUND;
	let toolCallsUsed = 0;
	let toolBudgetExtensions = 0;
	const seenToolCalls = new Set<string>();
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
			callStream(
				streamFn,
				model,
				options.systemPrompt,
				messages,
				options.tools,
				baseOptions,
				signal,
				options.events,
			),
			timeout,
			signal,
		);
		accumulateUsage(assistant);
		let round = 0;
		let roundHadProgress = false;
		while (hasToolCalls(assistant)) {
			if (round >= allowedRounds) {
				if (toolBudgetExtensions >= MAX_CHILD_TOOL_EXTENSIONS || !roundHadProgress) {
					return {
						ok: false,
						driverError: "child exceeded its tool budget",
						toolCallsUsed,
						toolBudgetLimit,
						toolBudgetExtensions,
					};
				}
				toolBudgetExtensions += 1;
				allowedRounds += Math.ceil(CHILD_TOOL_EXTENSION_CALLS / MAX_CHILD_TOOL_CALLS_PER_ROUND);
				toolBudgetLimit += CHILD_TOOL_EXTENSION_CALLS;
			}
			round += 1;
			roundHadProgress = false;
			const calls = toolCallsOf(assistant).slice(0, MAX_CHILD_TOOL_CALLS_PER_ROUND);
			if (calls.length === 0) {
				break;
			}
			const results: ToolResultMessage[] = [];
			for (const call of calls) {
				toolCallsUsed += 1;
				const signature = `${call.name}:${JSON.stringify(call.arguments ?? {})}`;
				const isNewToolCall = !seenToolCalls.has(signature);
				seenToolCalls.add(signature);
				const gate = options.gateTool?.(call.name, (call.arguments ?? {}) as Record<string, unknown>);
				if (gate?.block) {
					options.events?.({
						kind: "permission",
						at: Date.now(),
						tool: call.name,
						reason: gate.reason ?? "blocked by permission policy",
						decision: "denied",
					});
					results.push(
						toolResultMessage(
							call,
							[{ type: "text", text: gate.reason ?? "blocked by permission policy" }],
							true,
						),
					);
					continue;
				}
				const outcome = await executeChildTool(options.tools, call, signal);
				if (!outcome.isError && (call.name === "edit" || call.name === "write")) {
					const path = toolPath(call);
					if (path) options.workspaceMutation?.(path);
				}
				if (isNewToolCall && !outcome.isError) roundHadProgress = true;
				results.push(outcome.message);
				options.events?.({
					kind: "tool_result",
					at: Date.now(),
					toolCallId: call.id,
					name: call.name,
					isError: outcome.isError,
					summary: boundChildEventText(outcome.summary, MAX_CHILD_EVENT_RESULT_SUMMARY_CHARS),
					...((outcome.detail?.length ?? 0) > 0
						? { detail: boundChildEventText(outcome.detail!, MAX_CHILD_EVENT_RESULT_DETAIL_CHARS) }
						: {}),
				});
			}
			messages.push(assistant, ...results);
			assistant = await raceWithTimeout(
				callStream(
					streamFn,
					model,
					options.systemPrompt,
					messages,
					options.tools,
					baseOptions,
					signal,
					options.events,
				),
				timeout,
				signal,
			);
			accumulateUsage(assistant);
		}
		if (hasToolCalls(assistant)) {
			return {
				ok: false,
				driverError: "child exceeded its tool budget",
				toolCallsUsed,
				toolBudgetLimit,
				toolBudgetExtensions,
			};
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
			toolCallsUsed,
			toolBudgetLimit,
			toolBudgetExtensions,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			driverError: message === "child timed out" ? `child timed out after ${timeoutMs}ms` : message,
			toolCallsUsed,
			toolBudgetLimit,
			toolBudgetExtensions,
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
	events?: (event: AiraChildEvent) => void,
): Promise<AssistantMessage> {
	const maybePromise = streamFn(model, { systemPrompt, messages, tools }, { ...options, signal });
	return (maybePromise instanceof Promise ? maybePromise : Promise.resolve(maybePromise)).then((stream) => {
		void consumeStreamEvents(stream, events);
		return stream.result();
	});
}

/**
 * Consume the stream's event queue into the Agent Inspector sink WITHOUT
 * touching `stream.result()`: the EventStream resolves its final result
 * independently of the async-iteration drain, so capture is a pure
 * side-channel. Delta events accumulate per content block and emit ONE
 * bounded event per completed block (text/thinking/tool_call), which keeps
 * the buffer event count proportional to model blocks, not tokens.
 */
async function consumeStreamEvents(
	stream: AiraStreamLike,
	events: ((event: AiraChildEvent) => void) | undefined,
): Promise<void> {
	if (!events) {
		return;
	}
	const textByIndex = new Map<number, string>();
	const thinkingByIndex = new Map<number, string>();
	try {
		for await (const event of stream) {
			const now = Date.now();
			switch (event.type) {
				case "text_delta": {
					textByIndex.set(event.contentIndex, (textByIndex.get(event.contentIndex) ?? "") + event.delta);
					break;
				}
				case "text_end": {
					const text = (textByIndex.get(event.contentIndex) ?? event.content ?? "").trim();
					textByIndex.delete(event.contentIndex);
					if (text.length > 0) {
						events({ kind: "text", at: now, text: boundChildEventText(text, MAX_CHILD_EVENT_TEXT_CHARS) });
					}
					break;
				}
				case "thinking_delta": {
					thinkingByIndex.set(event.contentIndex, (thinkingByIndex.get(event.contentIndex) ?? "") + event.delta);
					break;
				}
				case "thinking_end": {
					const text = (thinkingByIndex.get(event.contentIndex) ?? event.content ?? "").trim();
					thinkingByIndex.delete(event.contentIndex);
					if (text.length > 0) {
						events({ kind: "thinking", at: now, text: boundChildEventText(text, MAX_CHILD_EVENT_TEXT_CHARS) });
					}
					break;
				}
				case "toolcall_end": {
					const args = toolCallArgsText(event.toolCall);
					events({
						kind: "tool_call",
						at: now,
						toolCallId: event.toolCall.id,
						name: event.toolCall.name,
						args: boundChildEventText(args, MAX_CHILD_EVENT_ARGS_CHARS),
					});
					break;
				}
				default:
					break;
			}
		}
	} catch {
		// Capture must never break the run; the stream's own result() path is
		// unaffected by a drained or errored iteration.
	}
}

/** Compact one-line args summary for a tool call (path / command / pattern). */
function toolCallArgsText(toolCall: ToolCall): string {
	const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
	const readString = (key: string): string | undefined => (typeof args[key] === "string" ? args[key] : undefined);
	const path = readString("path") ?? readString("file_path");
	switch (toolCall.name) {
		case "read":
		case "edit":
		case "write":
		case "ls":
			return path ?? "";
		case "grep":
		case "find":
			return readString("pattern") ?? path ?? "";
		case "process_start": {
			const command = readString("command");
			if (command) {
				return command;
			}
			const exe = readString("exe");
			const argList = Array.isArray(args.args)
				? args.args.filter((item): item is string => typeof item === "string")
				: [];
			return [exe, ...argList].filter(Boolean).join(" ");
		}
		case "process_stop":
		case "process_logs":
		case "process_status":
			return readString("id") ?? "";
		default:
			return path ?? "";
	}
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

async function executeChildTool(
	tools: AgentTool[],
	call: ToolCall,
	signal?: AbortSignal,
): Promise<{ message: ToolResultMessage; isError: boolean; summary: string; detail?: string }> {
	const tool = tools.find((candidate) => candidate.name === call.name);
	if (!tool) {
		const failure = `Error: unknown tool ${call.name}`;
		return {
			message: toolResultMessage(call, [{ type: "text", text: failure }], true),
			isError: true,
			summary: failure,
		};
	}
	try {
		const params = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
		const result = await tool.execute(call.id, params, signal);
		const isError = result.content.some(
			(block) =>
				(block as { type?: string }).type === "text" && (block as { text?: string }).text?.startsWith("Error"),
		);
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => (block as { type?: string }).type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		return {
			message: toolResultMessage(call, result.content, isError),
			isError,
			summary: text.split(/\n/)[0]?.slice(0, MAX_CHILD_EVENT_RESULT_SUMMARY_CHARS) ?? "",
			detail: text.length > 0 ? text : undefined,
		};
	} catch (error) {
		const failure = `Error: ${error instanceof Error ? error.message : String(error)}`;
		return {
			message: toolResultMessage(call, [{ type: "text", text: failure }], true),
			isError: true,
			summary: failure,
		};
	}
}

function toolPath(call: ToolCall): string | undefined {
	const args = (call.arguments ?? {}) as Record<string, unknown>;
	const path = args.path ?? args.file_path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
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

/** Minimal structural view of the stream the runner iterates for capture. */
type AiraStreamLike = AsyncIterable<AssistantMessageEvent> & {
	result(): Promise<AssistantMessage>;
};

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
