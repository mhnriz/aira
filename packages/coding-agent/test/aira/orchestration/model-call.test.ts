/**
 * Aira shared model-call primitives: the single run deadline (one run -> one
 * deadline for model calls and tool execution) and the pure message helpers
 * shared by the child runner and the fresh-context verifier.
 *
 * Deterministic: fake timers drive the deadline; no real sleeps.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AiraRunAbortError,
	createAiraRunDeadline,
	lastBalancedObject,
	toolResultIsError,
} from "../../../src/aira/orchestration/model-call.ts";

describe("Aira shared model-call primitives", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("aborts the run signal and rejects as timeout when the deadline fires", async () => {
		vi.useFakeTimers();
		const deadline = createAiraRunDeadline({ timeoutMs: 1000, label: "child" });
		const rejection = deadline.race(new Promise<never>(() => {})).catch((error: unknown) => error);
		expect(deadline.signal.aborted).toBe(false);
		expect(deadline.timedOut).toBe(false);

		await vi.advanceTimersByTimeAsync(1000);

		const error = await rejection;
		expect(error).toBeInstanceOf(AiraRunAbortError);
		expect((error as AiraRunAbortError).kind).toBe("timeout");
		expect((error as AiraRunAbortError).message).toBe("child timed out");
		expect(deadline.timedOut).toBe(true);
		expect(deadline.signal.aborted).toBe(true);
		deadline.dispose();
	});

	it("aborts the run signal and rejects as cancelled when the caller cancels", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const deadline = createAiraRunDeadline({ timeoutMs: 1000, signal: controller.signal, label: "verifier" });
		const rejection = deadline.race(new Promise<never>(() => {})).catch((error: unknown) => error);

		controller.abort();

		const error = await rejection;
		expect(error).toBeInstanceOf(AiraRunAbortError);
		expect((error as AiraRunAbortError).kind).toBe("cancelled");
		expect((error as AiraRunAbortError).message).toBe("verifier cancelled");
		expect(deadline.kind).toBe("cancelled");
		expect(deadline.timedOut).toBe(false);
		expect(deadline.signal.aborted).toBe(true);
		deadline.dispose();
	});

	it("treats an already-aborted caller signal as cancellation", () => {
		const controller = new AbortController();
		controller.abort();
		const deadline = createAiraRunDeadline({ timeoutMs: 1000, signal: controller.signal, label: "verifier" });
		expect(deadline.kind).toBe("cancelled");
		expect(deadline.signal.aborted).toBe(true);
		deadline.dispose();
	});

	it("keeps timeout classification when the underlying work later rejects with an AbortError", async () => {
		vi.useFakeTimers();
		const deadline = createAiraRunDeadline({ timeoutMs: 50, label: "verifier" });
		const underlying = new Promise<never>((_resolve, reject) => {
			deadline.signal.addEventListener(
				"abort",
				() => reject(new DOMException("The operation was aborted.", "AbortError")),
				{ once: true },
			);
		});
		const raced = deadline.race(underlying).catch((error: unknown) => error);

		await vi.advanceTimersByTimeAsync(50);
		await Promise.resolve();

		const error = await raced;
		expect(error).toBeInstanceOf(AiraRunAbortError);
		expect((error as AiraRunAbortError).kind).toBe("timeout");
		deadline.dispose();
	});

	it("dispose clears the deadline timer and detaches the caller listener", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const deadline = createAiraRunDeadline({ timeoutMs: 1000, signal: controller.signal, label: "child" });

		deadline.dispose();
		await vi.advanceTimersByTimeAsync(5000);
		expect(deadline.kind).toBeUndefined();

		// The caller listener is detached: aborting after dispose changes nothing.
		controller.abort();
		expect(deadline.kind).toBeUndefined();
		expect(deadline.signal.aborted).toBe(false);
	});

	it("shares the last-balanced-object and tool-result error conventions", () => {
		expect(lastBalancedObject('prefix {"a":1} suffix {"b":2}')).toBe('{"b":2}');
		expect(lastBalancedObject('{"a":1} then a truncated {"b"')).toBeUndefined();
		expect(lastBalancedObject("no object here")).toBeUndefined();
		expect(toolResultIsError([{ type: "text", text: "Error: boom" }])).toBe(true);
		expect(toolResultIsError([{ type: "text", text: "fine" }])).toBe(false);
	});
});
