/**
 * Agent Inspector — bounded child event buffer (Phase 12.x).
 *
 * Ring bounds: per-run event count, per-event text caps, and a per-run total
 * character budget with oldest-first eviction. Buffer data is orchestration
 * owned and never enters AiraSessionState.
 */
import { describe, expect, it } from "vitest";
import {
	type AiraChildEvent,
	AiraChildEventBuffer,
	boundChildEventText,
	childActivityOf,
	MAX_CHILD_EVENT_TEXT_CHARS,
	MAX_CHILD_EVENT_TOTAL_CHARS,
	MAX_CHILD_EVENTS_PER_RUN,
} from "../../../src/aira/orchestration/events.ts";

function textEvent(text: string): AiraChildEvent {
	return { kind: "text", at: Date.now(), text };
}

describe("Aira child event buffer (Agent Inspector)", () => {
	it("retains events in order and returns stable snapshots", () => {
		const buffer = new AiraChildEventBuffer();
		buffer.append({ kind: "status", at: 1, status: "pending", phase: "waiting-capacity" });
		buffer.append(textEvent("hello"));
		const snapshot = buffer.events();
		expect(snapshot.map((event) => event.kind)).toEqual(["status", "text"]);
		// Snapshot is defensive: appending does not mutate the earlier view.
		buffer.append({ kind: "completion", at: 2, status: "completed", summary: "done" });
		expect(snapshot).toHaveLength(2);
		expect(buffer.events()).toHaveLength(3);
	});

	it("evicts the OLDEST events beyond the count ring", () => {
		const buffer = new AiraChildEventBuffer(3, MAX_CHILD_EVENT_TOTAL_CHARS);
		for (let index = 0; index < 5; index += 1) {
			buffer.append(textEvent(`event-${index}`));
		}
		expect(buffer.events().map((event) => (event.kind === "text" ? event.text : ""))).toEqual([
			"event-2",
			"event-3",
			"event-4",
		]);
	});

	it("evicts the OLDEST events beyond the total character budget", () => {
		const buffer = new AiraChildEventBuffer(MAX_CHILD_EVENTS_PER_RUN, 100);
		buffer.append(textEvent("x".repeat(60)));
		buffer.append(textEvent("y".repeat(60)));
		buffer.append(textEvent("z".repeat(10)));
		// 60+60+10 + overhead > 100 → the first 60-char event is evicted;
		// the second 60-char event is kept (single event stays under budget).
		expect(buffer.events().length).toBeLessThanOrEqual(3);
		expect(buffer.events()[0]!.kind).toBe("text");
		const first = buffer.events()[0]!;
		expect(first.kind === "text" ? first.text : "").not.toContain("x");
		expect(buffer.chars).toBeLessThanOrEqual(100 + 16 + 1);
	});

	it("never drops the newest event even when it alone exceeds the budget", () => {
		const buffer = new AiraChildEventBuffer(MAX_CHILD_EVENTS_PER_RUN, 10);
		buffer.append(textEvent("a".repeat(50)));
		expect(buffer.events()).toHaveLength(1);
		expect(buffer.chars).toBeGreaterThan(10);
	});

	it("bounds per-event text through the shared helper", () => {
		const bounded = "x".repeat(MAX_CHILD_EVENT_TEXT_CHARS + 200);
		expect(boundChildEventText(bounded, MAX_CHILD_EVENT_TEXT_CHARS).length).toBe(MAX_CHILD_EVENT_TEXT_CHARS);
	});

	it("maps events to truthful last-activity labels", () => {
		expect(childActivityOf({ kind: "thinking", at: 1, text: "t" })).toBe("thinking");
		expect(childActivityOf({ kind: "tool_call", at: 1, toolCallId: "c", name: "read", args: "a.ts" })).toBe("tool");
		expect(
			childActivityOf({ kind: "tool_result", at: 1, toolCallId: "c", name: "read", isError: false, summary: "ok" }),
		).toBe("tool");
		expect(childActivityOf({ kind: "permission", at: 1, tool: "bash", reason: "denied" })).toBe("permission");
		expect(childActivityOf({ kind: "text", at: 1, text: "hi" })).toBeUndefined();
		expect(childActivityOf({ kind: "completion", at: 1, status: "completed", summary: "s" })).toBeUndefined();
		expect(childActivityOf(undefined)).toBeUndefined();
	});
});
