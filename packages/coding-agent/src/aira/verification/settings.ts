/**
 * Aira verification — canonical settings.
 *
 * Verification controls live in Aira's canonical settings architecture: the
 * `verification` object inside the host settings file, read/written through
 * the host `SettingsManager` and surfaced through `/settings` (and the
 * future Workbench). Independent verification consumes model tokens; these
 * settings make that cost explicit and configurable.
 *
 * Defaults:
 * - enabled:       true — verification is available.
 * - auto:          "smart" — non-trivial engineering work is verified at
 *                  meaningful completion boundaries; trivial work (docs,
 *                  comments, one-line renames with clean diagnostics) skips
 *                  the verifier model call.
 * - contextBudget: "compact" — the verifier's evidence envelope is small by
 *                  default (bounded model input).
 */
import type { Settings } from "../../core/settings-manager.ts";

export type AiraVerificationAutoSetting = "off" | "smart" | "always";
export type AiraVerificationContextBudget = "compact" | "balanced" | "expanded";

export interface AiraVerificationSettings {
	/** Whether independent verification may run at all. */
	enabled: boolean;
	/** Automatic-verification policy (off | smart | always). */
	auto: AiraVerificationAutoSetting;
	/** Size class of the verifier's bounded evidence envelope. */
	contextBudget: AiraVerificationContextBudget;
}

/** The canonical default verification settings. */
export const DEFAULT_AIRA_VERIFICATION_SETTINGS: AiraVerificationSettings = {
	enabled: true,
	auto: "smart",
	contextBudget: "compact",
};

/** Sanitize an unknown settings object into valid Aira verification settings. */
export function normalizeAiraVerificationSettings(value: unknown): AiraVerificationSettings {
	const record = (value ?? {}) as Record<string, unknown>;
	return {
		enabled: record.enabled === undefined ? DEFAULT_AIRA_VERIFICATION_SETTINGS.enabled : record.enabled === true,
		auto: normalizeAuto(record.auto),
		contextBudget: normalizeBudget(record.contextBudget),
	};
}

function normalizeAuto(value: unknown): AiraVerificationAutoSetting {
	if (value === "off" || value === "smart" || value === "always") {
		return value;
	}
	return DEFAULT_AIRA_VERIFICATION_SETTINGS.auto;
}

function normalizeBudget(value: unknown): AiraVerificationContextBudget {
	if (value === "compact" || value === "balanced" || value === "expanded") {
		return value;
	}
	return DEFAULT_AIRA_VERIFICATION_SETTINGS.contextBudget;
}

/**
 * Extract canonical verification settings from a host Settings record.
 * Unknown/malformed values normalize to defaults so a hand-edited settings
 * file can never break the runtime.
 */
export function airaVerificationSettingsFrom(settings: Settings): AiraVerificationSettings {
	return normalizeAiraVerificationSettings(settings.verification);
}
