import { describe, expect, it } from "vitest";
import { truncateHead, truncateTail } from "../src/core/tools/truncate.ts";

describe("tool output truncation", () => {
	it("reports bytes when only a trailing newline or oversized line exceeds limits at the line cap", () => {
		expect(truncateHead("hello\nworld\n", { maxBytes: 11, maxLines: 2 })).toMatchObject({
			content: "hello\nworld",
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 2,
			outputLines: 2,
		});
		expect(truncateTail("hello\nworld\n", { maxBytes: 11, maxLines: 2 })).toMatchObject({
			content: "hello\nworld",
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 2,
			outputLines: 2,
		});
		expect(truncateTail("x".repeat(100), { maxBytes: 10, maxLines: 1 })).toMatchObject({
			content: "x".repeat(10),
			truncatedBy: "bytes",
			lastLinePartial: true,
			outputLines: 1,
		});
	});
});
