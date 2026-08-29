/**
 * Phase 9 — orchestration settings: canonical normalization, conservative
 * defaults, and invalid-value sanitization (hand-edited files cannot break
 * the runtime).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_AIRA_ORCHESTRATION_SETTINGS,
	normalizeAiraOrchestrationSettings,
} from "../../../src/aira/orchestration/settings.ts";

describe("Aira orchestration settings (Phase 9)", () => {
	it("defaults are conservative", () => {
		expect(DEFAULT_AIRA_ORCHESTRATION_SETTINGS).toEqual({
			enabled: true,
			maxParallel: 2,
			model: "inherit",
			timeoutMs: 300_000,
		});
		expect(normalizeAiraOrchestrationSettings(undefined)).toEqual(DEFAULT_AIRA_ORCHESTRATION_SETTINGS);
	});

	it("normalizes valid values", () => {
		expect(
			normalizeAiraOrchestrationSettings({ enabled: false, maxParallel: 4, model: "default", timeoutMs: 60_000 }),
		).toEqual({ enabled: false, maxParallel: 4, model: "default", timeoutMs: 60_000 });
		expect(
			normalizeAiraOrchestrationSettings({ model: "anthropic/claude-sonnet-4-5", maxParallel: 8 }),
		).toMatchObject({ model: "anthropic/claude-sonnet-4-5", maxParallel: 8 });
	});

	it("sanitizes out-of-range and malformed values", () => {
		expect(normalizeAiraOrchestrationSettings({ maxParallel: 99 }).maxParallel).toBe(2);
		expect(normalizeAiraOrchestrationSettings({ maxParallel: 0 }).maxParallel).toBe(2);
		expect(normalizeAiraOrchestrationSettings({ maxParallel: 2.5 }).maxParallel).toBe(2);
		expect(normalizeAiraOrchestrationSettings({ timeoutMs: 1000 }).timeoutMs).toBe(300_000);
		expect(normalizeAiraOrchestrationSettings({ timeoutMs: 0 }).timeoutMs).toBe(300_000);
		expect(normalizeAiraOrchestrationSettings({ model: "not a selector!" }).model).toBe("inherit");
		expect(normalizeAiraOrchestrationSettings({ model: "noprovider" }).model).toBe("inherit");
		expect(normalizeAiraOrchestrationSettings({ model: 42 }).model).toBe("inherit");
		expect(normalizeAiraOrchestrationSettings({ enabled: "yes" }).enabled).toBe(false);
	});
});

afterEach(() => {
	// keep vitest deterministic; no shared state in this module
});
