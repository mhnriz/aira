/**
 * Aira orchestration — child event/transcript model (Agent Inspector).
 *
 * Structured, bounded child events captured while a child runs. The buffer
 * is orchestration-owned (per-run, in-memory) and NEVER enters
 * `AiraSessionState` (ADR-005): canonical state stays bounded, token-free,
 * and UI-ready; the transcript stays a queryable/subscribable seam beside
 * the canonical snapshot.
 *
 * Event kinds map to the Pi stream protocol where it already has suitable
 * semantics (assistant text deltas → `text`, thinking deltas → `thinking`,
 * tool-call completion → `tool_call`, tool execution → `tool_result`) and
 * add orchestration lifecycle events (`status`, `permission`, `failure`,
 * `completion`) that only the manager can know truthfully.
 *
 * Hard bounds (protect memory):
 * - per-run event count ring (MAX_CHILD_EVENTS_PER_RUN);
 * - per-event text caps (text/thinking blocks, tool args, tool results);
 * - per-run total character budget (oldest events evicted first).
 */

import type { AiraChildFailureCategory, AiraChildPhase, AiraChildRunStatus } from "./types.ts";

/** Bounded per-run event count (ring). */
export const MAX_CHILD_EVENTS_PER_RUN = 400;
/** Per text/thinking block cap (chars). */
export const MAX_CHILD_EVENT_TEXT_CHARS = 600;
/** Per tool-call arguments summary cap (chars). */
export const MAX_CHILD_EVENT_ARGS_CHARS = 400;
/** Per tool-result summary cap (chars). */
export const MAX_CHILD_EVENT_RESULT_SUMMARY_CHARS = 200;
/** Per tool-result detail cap (chars). */
export const MAX_CHILD_EVENT_RESULT_DETAIL_CHARS = 600;
/** Per-run total character budget — oldest events are evicted to stay under it. */
export const MAX_CHILD_EVENT_TOTAL_CHARS = 100_000;

/** Derived last-activity label for a running/queued child (truthful, bounded). */
export type AiraChildActivity = "thinking" | "tool" | "permission";

/**
 * One structured child event (discriminated union; never preformatted text).
 * `at` is the event timestamp; ordering is by sequence in the buffer.
 */
export type AiraChildEvent =
	| { kind: "text"; at: number; text: string }
	| { kind: "thinking"; at: number; text: string }
	| { kind: "tool_call"; at: number; toolCallId: string; name: string; args: string }
	| {
			kind: "tool_result";
			at: number;
			toolCallId: string;
			name: string;
			isError: boolean;
			summary: string;
			detail?: string;
	  }
	| { kind: "permission"; at: number; tool: string; reason: string; decision?: "allowed" | "denied" }
	| { kind: "status"; at: number; status: AiraChildRunStatus; phase: AiraChildPhase; reason?: string }
	| { kind: "failure"; at: number; category: AiraChildFailureCategory; message: string }
	| { kind: "completion"; at: number; status: "completed" | "failed"; summary: string };

/** Bound one event's text payloads (defense in depth; sinks also bound). */
export function boundChildEventText(value: string, max: number): string {
	if (value.length <= max) {
		return value;
	}
	return `${value.slice(0, max - 1)}…`;
}

/**
 * Bounded per-run event ring. Append-only; evicts the OLDEST events when the
 * count ring or the total character budget is exceeded. Read access is a
 * stable snapshot array (defensive copy on query for cheap memory safety).
 */
export class AiraChildEventBuffer {
	private readonly items: AiraChildEvent[] = [];
	private totalChars = 0;
	private readonly maxEvents: number;
	private readonly maxChars: number;

	constructor(maxEvents: number = MAX_CHILD_EVENTS_PER_RUN, maxChars: number = MAX_CHILD_EVENT_TOTAL_CHARS) {
		this.maxEvents = maxEvents;
		this.maxChars = maxChars;
	}

	append(event: AiraChildEvent): void {
		this.items.push(event);
		this.totalChars += eventChars(event);
		// Char budget: evict oldest until under budget (at least one stays).
		while (this.totalChars > this.maxChars && this.items.length > 1) {
			const oldest = this.items.shift();
			if (oldest) {
				this.totalChars -= eventChars(oldest);
			}
		}
		// Count ring: evict the oldest, and with it its char cost.
		while (this.items.length > this.maxEvents) {
			const oldest = this.items.shift();
			if (oldest) {
				this.totalChars -= eventChars(oldest);
			}
		}
	}

	/** Snapshot of the contained events (oldest first). */
	events(): readonly AiraChildEvent[] {
		return [...this.items];
	}

	last(): AiraChildEvent | undefined {
		return this.items[this.items.length - 1];
	}

	get length(): number {
		return this.items.length;
	}

	/** Total retained character payload (memory bound). */
	get chars(): number {
		return this.totalChars;
	}
}

/** Approximate char cost of one event (bounded payloads only). */
function eventChars(event: AiraChildEvent): number {
	switch (event.kind) {
		case "text":
		case "thinking":
			return event.text.length + 16;
		case "tool_call":
			return event.name.length + event.args.length + 32;
		case "tool_result":
			return event.name.length + event.summary.length + (event.detail?.length ?? 0) + 32;
		case "permission":
			return event.tool.length + event.reason.length + 32;
		case "status":
			return event.reason?.length ?? 4;
		case "failure":
			return event.category.length + event.message.length + 16;
		case "completion":
			return event.summary.length + 8;
	}
}

/** Map one event to its last-activity label, or undefined when it has none. */
export function childActivityOf(event: AiraChildEvent | undefined): AiraChildActivity | undefined {
	switch (event?.kind) {
		case "thinking":
			return "thinking";
		case "tool_call":
		case "tool_result":
			return "tool";
		case "permission":
			return "permission";
		default:
			return undefined;
	}
}
