/**
 * Aira browser — canonical settings.
 *
 * Browser controls live in Aira's canonical settings architecture: the
 * `browser` object inside the host settings file (`~/.aira/agent/settings.json`,
 * global scope), read/written through the host `SettingsManager`. The future
 * Workbench renders browser state from the canonical snapshot; these settings
 * decide whether the capability may be used, whether browser evidence may
 * enter model context, and how aggressive automatic verification is.
 *
 * Defaults:
 * - enabled:      true — the capability may be used whenever a browser is
 *                 available. Aira itself never requires a browser.
 * - context:      "auto" — browser evidence enters model context only when
 *                 strongly relevant; commonly zero tokens.
 * - autoVerify:   true — Aira may run ONE bounded verification pass after a
 *                 browser-relevant edit when a local dev process is running
 *                 and a local URL is known. Strictly gated; never a loop.
 * - contextBudget: "compact" — the ambient browser pack is small by default.
 */
import type { Settings } from "../../core/settings-manager.ts";

export type AiraBrowserContextSetting = "off" | "auto" | "on";
export type AiraBrowserContextBudget = "compact" | "balanced" | "expanded";

export interface AiraBrowserSettings {
	/** Whether browser capability may be used at all. */
	enabled: boolean;
	/** Ambient browser-context injection policy (off | auto | on). */
	context: AiraBrowserContextSetting;
	/** Whether bounded automatic verification may run for local UI changes. */
	autoVerify: boolean;
	/** Size class of the ambient browser context pack. */
	contextBudget: AiraBrowserContextBudget;
}

/** The canonical default browser settings. */
export const DEFAULT_AIRA_BROWSER_SETTINGS: AiraBrowserSettings = {
	enabled: true,
	context: "auto",
	autoVerify: true,
	contextBudget: "compact",
};

/** Sanitize an unknown settings object into valid Aira browser settings. */
export function normalizeAiraBrowserSettings(value: unknown): AiraBrowserSettings {
	const record = (value ?? {}) as Record<string, unknown>;
	return {
		enabled: record.enabled === undefined ? DEFAULT_AIRA_BROWSER_SETTINGS.enabled : record.enabled === true,
		context: normalizeContext(record.context),
		autoVerify:
			record.autoVerify === undefined ? DEFAULT_AIRA_BROWSER_SETTINGS.autoVerify : record.autoVerify === true,
		contextBudget: normalizeBudget(record.contextBudget),
	};
}

function normalizeContext(value: unknown): AiraBrowserContextSetting {
	if (value === "on" || value === "off" || value === "auto") {
		return value;
	}
	return DEFAULT_AIRA_BROWSER_SETTINGS.context;
}

function normalizeBudget(value: unknown): AiraBrowserContextBudget {
	if (value === "compact" || value === "balanced" || value === "expanded") {
		return value;
	}
	return DEFAULT_AIRA_BROWSER_SETTINGS.contextBudget;
}

/**
 * Extract canonical browser settings from a host Settings record. The host
 * `Settings` interface carries the optional `browser` object (extended in
 * Phase 7); unknown/malformed values normalize to defaults so a hand-edited
 * settings file can never break the runtime.
 */
export function airaBrowserSettingsFrom(settings: Settings): AiraBrowserSettings {
	return normalizeAiraBrowserSettings(settings.browser);
}
