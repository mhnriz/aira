/**
 * Phase 7 — bounded console/network evidence buffers.
 *
 * Deduplication, counts, top findings, caps. No browser involved.
 */
import { describe, expect, it } from "vitest";
import { createAiraConsoleBuffer } from "../../../src/aira/browser/cdp/console.ts";
import { createAiraNetworkBuffer } from "../../../src/aira/browser/cdp/network.ts";
import type { AiraBrowserNetworkRecord } from "../../../src/aira/browser/types.ts";

describe("Phase 7 — console evidence buffer", () => {
	it("captures errors/warnings with source lines and deduplicates repeats", () => {
		const buffer = createAiraConsoleBuffer();
		buffer.ingestConsoleApi({
			type: "error",
			args: [{ type: "string", value: "TypeError: player.seek is not a function" }],
			stackTrace: {
				callFrames: [{ url: "http://localhost:5173/src/player.ts", lineNumber: 183, functionName: "seek" }],
			},
		});
		buffer.ingestConsoleApi({
			type: "error",
			args: [{ type: "string", value: "TypeError: player.seek is not a function" }],
			stackTrace: {
				callFrames: [{ url: "http://localhost:5173/src/player.ts", lineNumber: 183, functionName: "seek" }],
			},
		});
		buffer.ingestConsoleApi({ type: "warning", args: [{ type: "string", value: "deprecated API" }] });
		buffer.ingestConsoleApi({ type: "log", args: [{ type: "string", value: "routine noise" }] });

		const summary = buffer.summary();
		expect(summary.errors).toBe(2); // deduplicated count
		expect(summary.warnings).toBe(1);
		expect(summary.total).toBe(4);
		expect(summary.topFinding?.message).toBe("TypeError: player.seek is not a function");
		expect(summary.topFinding?.source).toBe("http://localhost:5173/src/player.ts");
		expect(summary.topFinding?.line).toBe(184);

		const drain = buffer.drain();
		expect(drain.records.length).toBe(3); // one record per unique message
		expect(drain.errors).toBe(2);
	});

	it("logs entries (Log.entryAdded) are captured too", () => {
		const buffer = createAiraConsoleBuffer();
		buffer.ingestLogEntry({
			entry: {
				level: "error",
				text: "Uncaught ReferenceError: x",
				url: "http://localhost:5173/app.js",
				lineNumber: 9,
			},
		});
		const summary = buffer.summary();
		expect(summary.errors).toBe(1);
		expect(summary.topFinding?.source).toBe("http://localhost:5173/app.js");
	});

	it("respects the per-record cap and drain cursor", () => {
		const buffer = createAiraConsoleBuffer(5);
		for (let i = 0; i < 7; i++) {
			buffer.ingestConsoleApi({ type: "log", args: [{ type: "string", value: `line-${i}` }] });
		}
		const drain = buffer.drain();
		expect(drain.records.length).toBe(5);
		expect(drain.overflowed).toBe(true); // 2 dropped
		// sinceSeq cursor returns only newer records.
		const seq = drain.records[2]!.seq;
		const later = buffer.drain(seq);
		expect(later.records.length).toBe(2);
	});
});

describe("Phase 7 — network failure buffer", () => {
	it("keeps failed requests with error texts, deduplicated", () => {
		let t = 1000;
		const now = () => t++;
		const buffer = createAiraNetworkBuffer(50, now);
		buffer.ingestRequestWillBeSent({
			requestId: "r1",
			request: { url: "http://localhost:5173/api/players", method: "GET" },
			type: "Fetch",
		});
		buffer.ingestLoadingFailed({ requestId: "r1", errorText: "net::ERR_CONNECTION_REFUSED" });
		// Duplicate failure (new request id, same URL+error) dedupes.
		buffer.ingestRequestWillBeSent({
			requestId: "r2",
			request: { url: "http://localhost:5173/api/players", method: "GET" },
			type: "Fetch",
		});
		buffer.ingestLoadingFailed({ requestId: "r2", errorText: "net::ERR_CONNECTION_REFUSED" });

		const summary = buffer.summary();
		expect(summary.failures).toBe(2);
		expect(summary.topFinding?.message).toContain("GET http://localhost:5173/api/players");
		expect(summary.topFinding?.count).toBe(2);

		const drain = buffer.drain();
		expect(drain.records.length).toBe(1);
		expect(drain.failures).toBe(2);
	});

	it("retains relevant 4xx/5xx responses", () => {
		const buffer = createAiraNetworkBuffer();
		buffer.ingestRequestWillBeSent({
			requestId: "r1",
			request: { url: "http://localhost:5173/api/now-playing", method: "GET" },
			type: "Fetch",
		});
		buffer.ingestResponseReceived({ requestId: "r1", response: { status: 500 }, type: "Fetch" });
		const summary = buffer.summary();
		expect(summary.failures).toBe(1);
		expect(summary.topFinding?.message).toContain("HTTP 500");
	});

	it("ignores successful traffic and cosmetic subresource noise", () => {
		const buffer = createAiraNetworkBuffer();
		buffer.ingestRequestWillBeSent({
			requestId: "ok1",
			request: { url: "http://localhost:5173/app.js", method: "GET" },
			type: "Script",
		});
		buffer.ingestResponseReceived({ requestId: "ok1", response: { status: 200 } });
		buffer.ingestRequestWillBeSent({
			requestId: "img1",
			request: { url: "http://localhost:5173/logo.png", method: "GET" },
			type: "Image",
		});
		buffer.ingestLoadingFailed({ requestId: "img1", errorText: "net::ERR_ABORTED" });
		expect(buffer.summary().failures).toBe(0);
	});

	it("marks aborted and blocked requests truthfully", () => {
		const buffer = createAiraNetworkBuffer();
		buffer.ingestRequestWillBeSent({
			requestId: "a",
			request: { url: "http://localhost:5173/api/x", method: "POST" },
			type: "Fetch",
		});
		buffer.ingestLoadingFailed({ requestId: "a", cancelled: true });
		buffer.ingestRequestWillBeSent({
			requestId: "b",
			request: { url: "http://localhost:5173/api/y", method: "GET" },
			type: "Fetch",
		});
		buffer.ingestLoadingFailed({ requestId: "b", blockedReason: "inspector" });
		const records = buffer.drain().records as AiraBrowserNetworkRecord[];
		expect(records.some((r) => r.errorText === "cancelled")).toBe(true);
		expect(records.some((r) => r.errorText === "blocked (inspector)")).toBe(true);
	});

	it("caps records and drops the oldest", () => {
		const buffer = createAiraNetworkBuffer(3);
		for (let i = 0; i < 5; i++) {
			buffer.ingestRequestWillBeSent({
				requestId: `r${i}`,
				request: { url: `http://localhost:5173/api/${i}`, method: "GET" },
				type: "Fetch",
			});
			buffer.ingestResponseReceived({ requestId: `r${i}`, response: { status: 404 } });
		}
		const drain = buffer.drain();
		expect(drain.records.length).toBe(3);
		expect(drain.total).toBe(5);
		expect(drain.overflowed).toBe(true);
	});
});
