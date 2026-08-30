/**
 * Phase 10 — goal settings: defaults, normalization, canonical
 * SettingsManager round-trip.
 */
import { describe, expect, it } from "vitest";
import {
	airaGoalSettingsFrom,
	DEFAULT_AIRA_GOAL_SETTINGS,
	normalizeAiraGoalSettings,
} from "../../../src/aira/goal/settings.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

describe("Aira goal settings (Phase 10)", () => {
	it("defaults: enabled, auto smart, max rounds 4, no token/duration budgets", () => {
		expect(DEFAULT_AIRA_GOAL_SETTINGS).toEqual({
			enabled: true,
			auto: "smart",
			maxRounds: 4,
			tokenBudget: undefined,
			maxDurationMs: undefined,
		});
		expect(normalizeAiraGoalSettings(undefined)).toEqual(DEFAULT_AIRA_GOAL_SETTINGS);
		expect(normalizeAiraGoalSettings({})).toEqual(DEFAULT_AIRA_GOAL_SETTINGS);
	});

	it("normalizes malformed values to conservative defaults", () => {
		expect(
			normalizeAiraGoalSettings({
				enabled: "yes",
				auto: "sometimes",
				maxRounds: 999,
				tokenBudget: 5,
				maxDurationMs: -1,
			}),
		).toEqual({
			enabled: false,
			auto: "smart",
			maxRounds: 4,
			tokenBudget: undefined,
			maxDurationMs: undefined,
		});
		expect(
			normalizeAiraGoalSettings({
				enabled: true,
				auto: "always",
				maxRounds: 20,
				tokenBudget: 500_000,
				maxDurationMs: 3_600_000,
			}),
		).toEqual({
			enabled: true,
			auto: "always",
			maxRounds: 20,
			tokenBudget: 500_000,
			maxDurationMs: 3_600_000,
		});
		// Out-of-range optional budgets normalize to unset (never break the runtime).
		expect(normalizeAiraGoalSettings({ tokenBudget: 2_000_000_000, maxDurationMs: 10 })).toEqual({
			enabled: true,
			auto: "smart",
			maxRounds: 4,
			tokenBudget: undefined,
			maxDurationMs: undefined,
		});
	});

	it("round-trips through the canonical SettingsManager", () => {
		const manager = SettingsManager.inMemory({});
		const defaults = manager.getGoalSettings();
		expect(defaults).toEqual({
			enabled: true,
			auto: "smart",
			maxRounds: 4,
			tokenBudget: undefined,
			maxDurationMs: undefined,
		});

		manager.setGoalSettings({
			enabled: false,
			auto: "off",
			maxRounds: 2,
			tokenBudget: 100_000,
			maxDurationMs: 1_800_000,
		});
		expect(manager.getGoalSettings()).toEqual({
			enabled: false,
			auto: "off",
			maxRounds: 2,
			tokenBudget: 100_000,
			maxDurationMs: 1_800_000,
		});

		// Invalid stored values normalize via the typed accessor too.
		const raw = SettingsManager.inMemory({ goals: { auto: "banana", maxRounds: 0, tokenBudget: 3 } } as never);
		expect(raw.getGoalSettings()).toEqual({
			enabled: true,
			auto: "smart",
			maxRounds: 4,
			tokenBudget: undefined,
			maxDurationMs: undefined,
		});
	});

	it("extracts from a host Settings record through the settings helper", () => {
		expect(airaGoalSettingsFrom({} as never)).toEqual(DEFAULT_AIRA_GOAL_SETTINGS);
		expect(airaGoalSettingsFrom({ goals: { auto: "always", maxRounds: 3 } } as never)).toEqual({
			enabled: true,
			auto: "always",
			maxRounds: 3,
			tokenBudget: undefined,
			maxDurationMs: undefined,
		});
	});
});
