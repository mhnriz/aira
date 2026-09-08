/**
 * Phase 8 — verification settings: defaults, normalization, canonical
 * SettingsManager round-trip.
 */
import { describe, expect, it } from "vitest";
import {
	airaVerificationSettingsFrom,
	DEFAULT_AIRA_VERIFICATION_SETTINGS,
	normalizeAiraVerificationSettings,
} from "../../../src/aira/verification/settings.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

describe("Aira verification settings (Phase 8)", () => {
	it("defaults: disabled, auto smart, compact budget", () => {
		expect(DEFAULT_AIRA_VERIFICATION_SETTINGS).toEqual({ enabled: false, auto: "smart", contextBudget: "compact" });
		expect(normalizeAiraVerificationSettings(undefined)).toEqual(DEFAULT_AIRA_VERIFICATION_SETTINGS);
		expect(normalizeAiraVerificationSettings({})).toEqual(DEFAULT_AIRA_VERIFICATION_SETTINGS);
	});

	it("normalizes malformed values to defaults", () => {
		// Boolean fields follow the canonical rule: a non-true value disables.
		expect(normalizeAiraVerificationSettings({ enabled: "yes", auto: "sometimes", contextBudget: "huge" })).toEqual({
			enabled: false,
			auto: "smart",
			contextBudget: "compact",
		});
		// A mode without an explicit `enabled` stays off by default.
		expect(normalizeAiraVerificationSettings({ auto: "always", contextBudget: "expanded" })).toEqual({
			enabled: false,
			auto: "always",
			contextBudget: "expanded",
		});
		expect(normalizeAiraVerificationSettings({ enabled: false })).toEqual({
			enabled: false,
			auto: "smart",
			contextBudget: "compact",
		});
		// Explicit enabling works and preserves the other fields.
		expect(normalizeAiraVerificationSettings({ enabled: true, auto: "always", contextBudget: "expanded" })).toEqual({
			enabled: true,
			auto: "always",
			contextBudget: "expanded",
		});
	});

	it("round-trips through the canonical SettingsManager", () => {
		const manager = SettingsManager.inMemory({});
		const defaults = manager.getVerificationSettings();
		expect(defaults).toEqual({ enabled: false, auto: "smart", contextBudget: "compact" });

		manager.setVerificationSettings({ enabled: false, auto: "off", contextBudget: "balanced" });
		expect(manager.getVerificationSettings()).toEqual({ enabled: false, auto: "off", contextBudget: "balanced" });

		// Invalid stored values normalize via the typed accessor too.
		const raw = SettingsManager.inMemory({ verification: { auto: "banana", enabled: 42 } } as never);
		expect(raw.getVerificationSettings()).toEqual({ enabled: false, auto: "smart", contextBudget: "compact" });
	});

	it("a persisted explicit enabled:true wins over the default", () => {
		const manager = SettingsManager.inMemory({
			verification: { enabled: true, auto: "off", contextBudget: "balanced" },
		} as never);
		expect(manager.getVerificationSettings()).toEqual({ enabled: true, auto: "off", contextBudget: "balanced" });

		const raw = SettingsManager.inMemory({ verification: { enabled: true } } as never);
		expect(raw.getVerificationSettings()).toEqual({ enabled: true, auto: "smart", contextBudget: "compact" });
	});

	it("extracts from a host Settings record through the settings helper", () => {
		expect(airaVerificationSettingsFrom({} as never)).toEqual(DEFAULT_AIRA_VERIFICATION_SETTINGS);
		expect(airaVerificationSettingsFrom({ verification: { enabled: true, auto: "always" } } as never)).toEqual({
			enabled: true,
			auto: "always",
			contextBudget: "compact",
		});
	});

	it("fresh defaults: Goals OFF and Verification OFF; explicit Verification ON stays ON", () => {
		const manager = SettingsManager.inMemory({});
		expect(manager.getGoalSettings().enabled).toBe(false);
		expect(manager.getVerificationSettings().enabled).toBe(false);
		manager.setVerificationSettings({ enabled: true, auto: "smart", contextBudget: "compact" });
		expect(manager.getVerificationSettings().enabled).toBe(true);
		expect(manager.getGoalSettings().enabled).toBe(false);
	});
});
