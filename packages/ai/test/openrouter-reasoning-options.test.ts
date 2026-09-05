import { describe, expect, it } from "vitest";
import { getOpenRouterThinkingLevelMap } from "../scripts/openrouter-reasoning-options.ts";

describe("getOpenRouterThinkingLevelMap", () => {
	it("marks mandatory reasoning and unsupported efforts unavailable", () => {
		expect(getOpenRouterThinkingLevelMap({ mandatory: true, supported_efforts: ["max", "high", "low"] })).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	it("marks off unavailable when mandatory models omit effort metadata", () => {
		expect(getOpenRouterThinkingLevelMap({ mandatory: true })).toEqual({ off: null });
	});

	it("keeps off available while restricting optional models", () => {
		expect(getOpenRouterThinkingLevelMap({ mandatory: false, supported_efforts: ["high", "low"] })).toEqual({
			off: "none",
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("does not add metadata for optional models without effort controls", () => {
		expect(getOpenRouterThinkingLevelMap({ mandatory: false })).toBeUndefined();
	});
});
