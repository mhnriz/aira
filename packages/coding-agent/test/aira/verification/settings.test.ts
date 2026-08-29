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
	it("defaults: enabled, auto smart, compact budget", () => {
		expect(DEFAULT_AIRA_VERIFICATION_SETTINGS).toEqual({ enabled: true, auto: "smart", contextBudget: "compact" });
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
		expect(normalizeAiraVerificationSettings({ auto: "always", contextBudget: "expanded" })).toEqual({
			enabled: true,
			auto: "always",
			contextBudget: "expanded",
		});
		expect(normalizeAiraVerificationSettings({ enabled: false })).toEqual({
			enabled: false,
			auto: "smart",
			contextBudget: "compact",
		});
	});

	it("round-trips through the canonical SettingsManager", () => {
		const manager = SettingsManager.inMemory({});
		const defaults = manager.getVerificationSettings();
		expect(defaults).toEqual({ enabled: true, auto: "smart", contextBudget: "compact" });

		manager.setVerificationSettings({ enabled: false, auto: "off", contextBudget: "balanced" });
		expect(manager.getVerificationSettings()).toEqual({ enabled: false, auto: "off", contextBudget: "balanced" });

		// Invalid stored values normalize via the typed accessor too.
		const raw = SettingsManager.inMemory({ verification: { auto: "banana", enabled: 42 } } as never);
		expect(raw.getVerificationSettings()).toEqual({ enabled: false, auto: "smart", contextBudget: "compact" });
	});

	it("extracts from a host Settings record through the settings helper", () => {
		expect(airaVerificationSettingsFrom({} as never)).toEqual(DEFAULT_AIRA_VERIFICATION_SETTINGS);
		expect(airaVerificationSettingsFrom({ verification: { auto: "always" } } as never)).toEqual({
			enabled: true,
			auto: "always",
			contextBudget: "compact",
		});
	});
});
