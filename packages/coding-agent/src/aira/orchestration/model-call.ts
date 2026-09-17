/**
 * Shared model-call execution primitives for Aira runners.
 *
 * Both the orchestration child runner and the fresh-context verifier drive a
 * bounded model + tool loop. This module owns only the parts those loops
 * genuinely share:
 *
 * - the single run deadline (one run -> one deadline for both model calls and
 *   tool execution) with combined timeout/cancellation semantics;
 * - racing an awaitable against that deadline;
 * - the model stream invocation, with system prompt, tools, and event capture
 *   supplied by the caller;
 * - small assistant/tool-result message helpers and balanced-JSON extraction.
 *
 * It deliberately does NOT own either tool loop. System prompts, budgets,
 * event capture, and termination rules stay with the caller.
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

/** Why a run aborted before it completed on its own. */
export type AiraRunAbortKind = "timeout" | "cancelled";

/** Error surfaced when a run deadline or caller cancellation wins a race. */
export class AiraRunAbortError extends Error {
	readonly kind: AiraRunAbortKind;

	constructor(kind: AiraRunAbortKind, label: string) {
		super(kind === "timeout" ? `${label} timed out` : `${label} cancelled`);
		this.name = "AiraRunAbortError";
		this.kind = kind;
	}
}

/**
 * One run's deadline and cancellation state.
 *
 * `signal` aborts on the FIRST of the run deadline firing or the caller's
 * signal aborting. It must be threaded through every awaitable (model stream
 * and tool execution) so reaching the deadline actually stops in-flight work
 * rather than only abandoning the await.
 */
export interface AiraRunDeadline {
	readonly signal: AbortSignal;
	/** Which source aborted first, or undefined while the deadline is still live. */
	readonly kind: AiraRunAbortKind | undefined;
	/** True when the deadline (not caller cancellation) fired. */
	readonly timedOut: boolean;
	/** Reject as soon as the deadline/cancellation fires; otherwise mirror `promise`. */
	race<T>(promise: Promise<T>): Promise<T>;
	/** Clear the timer and detach the caller listener. Safe to call more than once. */
	dispose(): void;
}

export function createAiraRunDeadline(options: {
	timeoutMs: number;
	signal?: AbortSignal;
	/** Human label for timeout/cancel messages, e.g. "child" or "verifier". */
	label: string;
}): AiraRunDeadline {
	const controller = new AbortController();
	let kind: AiraRunAbortKind | undefined;
	let disposed = false;

	const abort = (next: AiraRunAbortKind): void => {
		if (kind !== undefined) {
			return;
		}
		kind = next;
		controller.abort();
	};
	const onCallerAbort = (): void => abort("cancelled");
	if (options.signal) {
		if (options.signal.aborted) {
			abort("cancelled");
		} else {
			options.signal.addEventListener("abort", onCallerAbort, { once: true });
		}
	}
	const timer = setTimeout(() => abort("timeout"), options.timeoutMs);

	const race = <T>(promise: Promise<T>): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			let settled = false;
			function settle(action: () => void): void {
				if (settled) {
					return;
				}
				settled = true;
				controller.signal.removeEventListener("abort", onAbort);
				action();
			}
			function onAbort(): void {
				settle(() => reject(new AiraRunAbortError(kind ?? "cancelled", options.label)));
			}
			// Attach the rejection handler before any early return so a promise that
			// rejects after the deadline already fired is never an unhandled rejection.
			promise.then(
				(value) => settle(() => resolve(value)),
				(error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
			);
			if (kind !== undefined) {
				onAbort();
				return;
			}
			controller.signal.addEventListener("abort", onAbort, { once: true });
		});

	return {
		signal: controller.signal,
		get kind() {
			return kind;
		},
		get timedOut() {
			return kind === "timeout";
		},
		race,
		dispose() {
			if (disposed) {
				return;
			}
			disposed = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onCallerAbort);
		},
	};
}

/** Minimal structural view of a model stream used for optional event capture. */
export type AiraModelStream = AsyncIterable<AssistantMessageEvent> & {
	result(): Promise<AssistantMessage>;
};

/**
 * Invoke the model stream and await its `result()`.
 *
 * `onStream` runs after the stream exists but before `result()` is awaited so
 * callers can attach event capture without leaking that concern into here.
 */
export async function callModelStream(
	streamFn: StreamFn,
	model: Model<any>,
	systemPrompt: string,
	messages: Message[],
	tools: AgentTool[],
	options: SimpleStreamOptions,
	signal?: AbortSignal,
	onStream?: (stream: AiraModelStream) => void,
): Promise<AssistantMessage> {
	const maybePromise = streamFn(model, { systemPrompt, messages, tools }, { ...options, signal });
	const stream = maybePromise instanceof Promise ? await maybePromise : maybePromise;
	onStream?.(stream);
	return stream.result();
}

export function hasToolCalls(message: AssistantMessage): boolean {
	return message.content.some((block) => (block as { type?: string }).type === "toolCall");
}

export function toolCallsOf(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => (block as { type?: string }).type === "toolCall");
}

export function toolResultMessage(
	call: ToolCall,
	content: ToolResultMessage["content"],
	isError: boolean,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content,
		isError,
		timestamp: Date.now(),
	};
}

/** The runner/verifier convention for marking a tool result as failed. */
export function toolResultIsError(content: ToolResultMessage["content"]): boolean {
	return content.some(
		(block) => (block as { type?: string }).type === "text" && (block as { text?: string }).text?.startsWith("Error"),
	);
}

export function contentText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => (block as { type?: string }).type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/**
 * Return the LAST balanced top-level `{...}` region of `text`, respecting
 * string literals and escapes so braces inside strings do not break balance.
 * This isolates the final result object from earlier JSON examples in prose,
 * unlike slicing from the first `{` to the last `}` (which spans both and
 * yields invalid JSON). Returns undefined when a trailing object was opened
 * but never closed, so a truncated payload is not misread as an earlier
 * narration example.
 */
export function lastBalancedObject(text: string): string | undefined {
	let depth = 0;
	let start = -1;
	let last: string | undefined;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			if (depth === 0) start = index;
			depth += 1;
			continue;
		}
		if (char === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				last = text.slice(start, index + 1);
				start = -1;
			}
		}
	}
	// An opened-but-unclosed object means the trailing (likely final) result was
	// truncated; do not fall back to an earlier balanced object in the prose.
	return depth > 0 ? undefined : last;
}
