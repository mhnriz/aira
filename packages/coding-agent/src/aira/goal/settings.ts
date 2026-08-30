/**
 * Aira goal — canonical settings.
 *
 * Goal controls live in Aira's canonical settings architecture: the `goals`
 * object inside the host settings file, read/written through the host
 * `SettingsManager` and surfaced through `/settings` (and the future
 * Workbench). Autonomous continuation consumes model tokens; these settings
 * make the bounds explicit and conservative by default.
 *
 * Defaults:
 * - enabled:     true — the goal runtime is available.
 * - auto:        "smart" — a durable Goal is created only for non-trivial
 *                objectives (multi-step features, significant bugs, cross-
 *                module changes, browser behavior, refactors, delegated
 *                work). Trivial prompts (typos, comment edits, one-line
 *                changes, tiny docs) stay plain root turns with zero goal
 *                overhead.
 * - maxRounds:   4 — at most 3 bounded repair continuations after the
 *                initial round; continuation stops rather than thrashes.
 * - tokenBudget: unset — optional; when set, aggregate token consumption
 *                (session-attributed + children + verifier) stops the goal
 *                truthfully at the bound.
 * - maxDurationMs: unset — optional; when set, elapsed goal time stops
 *                continuation at the bound.
 */
import type { Settings } from "../../core/settings-manager.ts";

export type AiraGoalAutoSetting = "off" | "smart" | "always";

export interface AiraGoalSettings {
	/** Whether the goal runtime may operate at all. */
	enabled: boolean;
	/** Automatic goal promotion policy (off | smart | always). */
	auto: AiraGoalAutoSetting;
	/** Maximum implementation rounds (1..20; includes the initial round). */
	maxRounds: number;
	/** Optional aggregate token budget (undefined = unbounded). */
	tokenBudget: number | undefined;
	/** Optional elapsed-time budget in milliseconds (undefined = unbounded). */
	maxDurationMs: number | undefined;
}

/** The canonical default goal settings (conservative). */
export const DEFAULT_AIRA_GOAL_SETTINGS: AiraGoalSettings = {
	enabled: true,
	auto: "smart",
	maxRounds: 4,
	tokenBudget: undefined,
	maxDurationMs: undefined,
};

export const AIRA_GOAL_MIN_MAX_ROUNDS = 1;
export const AIRA_GOAL_MAX_MAX_ROUNDS = 20;
export const AIRA_GOAL_MIN_TOKEN_BUDGET = 1000;
export const AIRA_GOAL_MAX_TOKEN_BUDGET = 100_000_000;
export const AIRA_GOAL_MIN_MAX_DURATION_MS = 60_000;
export const AIRA_GOAL_MAX_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** Sanitize an unknown settings object into valid goal settings. */
export function normalizeAiraGoalSettings(value: unknown): AiraGoalSettings {
	const record = (value ?? {}) as Record<string, unknown>;
	return {
		enabled: record.enabled === undefined ? DEFAULT_AIRA_GOAL_SETTINGS.enabled : record.enabled === true,
		auto: normalizeAuto(record.auto),
		maxRounds: normalizeMaxRounds(record.maxRounds),
		tokenBudget: normalizeOptional(record.tokenBudget, AIRA_GOAL_MIN_TOKEN_BUDGET, AIRA_GOAL_MAX_TOKEN_BUDGET),
		maxDurationMs: normalizeOptional(
			record.maxDurationMs,
			AIRA_GOAL_MIN_MAX_DURATION_MS,
			AIRA_GOAL_MAX_MAX_DURATION_MS,
		),
	};
}

function normalizeAuto(value: unknown): AiraGoalAutoSetting {
	if (value === "off" || value === "smart" || value === "always") {
		return value;
	}
	return DEFAULT_AIRA_GOAL_SETTINGS.auto;
}

function normalizeMaxRounds(value: unknown): number {
	if (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= AIRA_GOAL_MIN_MAX_ROUNDS &&
		value <= AIRA_GOAL_MAX_MAX_ROUNDS
	) {
		return value;
	}
	return DEFAULT_AIRA_GOAL_SETTINGS.maxRounds;
}

function normalizeOptional(value: unknown, min: number, max: number): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) {
		return Math.floor(value);
	}
	return undefined;
}

/**
 * Extract canonical goal settings from a host Settings record.
 * Unknown/malformed values normalize to defaults so a hand-edited settings
 * file can never break the runtime.
 */
export function airaGoalSettingsFrom(settings: Settings): AiraGoalSettings {
	return normalizeAiraGoalSettings(settings.goals);
}
