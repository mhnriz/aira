/**
 * Phase 7 — browser settings tests.
 *
 * Canonical settings store: defaults, normalization of malformed values,
 * SettingsManager round-trip, /settings surface contract.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_AIRA_BROWSER_SETTINGS, normalizeAiraBrowserSettings } from "../../../src/aira/browser/settings.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

describe("Phase 7 — browser settings", () => {
	it("has conservative documented defaults", () => {
		expect(DEFAULT_AIRA_BROWSER_SETTINGS).toEqual({
			enabled: true,
			context: "auto",
			autoVerify: true,
			contextBudget: "compact",
		});
	});

	it("normalizes malformed stored values to defaults", () => {
		expect(normalizeAiraBrowserSettings(undefined)).toEqual(DEFAULT_AIRA_BROWSER_SETTINGS);
		expect(normalizeAiraBrowserSettings({ context: "bogus", enabled: "yes" })).toEqual({
			enabled: false,
			context: "auto",
			autoVerify: true,
			contextBudget: "compact",
		});
		expect(normalizeAiraBrowserSettings({ context: "off", contextBudget: "expanded", autoVerify: false })).toEqual({
			enabled: true,
			context: "off",
			autoVerify: false,
			contextBudget: "expanded",
		});
	});

	it("round-trips through the host SettingsManager (canonical settings file)", () => {
		const manager = SettingsManager.inMemory({});
		const defaults = manager.getBrowserSettings();
		expect(defaults).toEqual(DEFAULT_AIRA_BROWSER_SETTINGS);

		manager.setBrowserSettings({ enabled: false, context: "off", autoVerify: false, contextBudget: "balanced" });
		expect(manager.getBrowserSettings()).toEqual({
			enabled: false,
			context: "off",
			autoVerify: false,
			contextBudget: "balanced",
		});

		// The stored settings object is typed into the canonical Settings.
		const stored = manager.getGlobalSettings().browser;
		expect(stored).toEqual({ enabled: false, context: "off", autoVerify: false, contextBudget: "balanced" });
	});

	it("ignores unrelated host settings when reading browser controls", () => {
		const manager = SettingsManager.inMemory({ theme: "dark", browser: { context: "on" } });
		const browser = manager.getBrowserSettings();
		expect(browser.context).toBe("on");
		expect(browser.enabled).toBe(true);
	});
});
