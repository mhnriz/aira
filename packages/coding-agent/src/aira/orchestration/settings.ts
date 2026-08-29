/**
 * Aira orchestration — canonical settings.
 *
 * Orchestration controls live in Aira's canonical settings architecture: the
 * `orchestration` object inside the host settings file, read/written through
 * the host `SettingsManager` and surfaced through `/settings` (and the future
 * Workbench). Multi-agent work consumes model tokens; these settings make
 * that cost explicit and conservative by default.
 *
 * Defaults:
 * - enabled:      true — delegation is available.
 * - maxParallel:  2    — bounded default concurrency (children are model runs).
 * - model:        "inherit" — children run the session's current model;
 *                 "default" resolves the configured default model; a
 *                 "provider/model" selector is explicit.
 * - timeoutMs:    300000 — per-child hard bound.
 */
import type { Settings } from "../../core/settings-manager.ts";

export interface AiraOrchestrationSettings {
	/** Whether child delegation may run at all. */
	enabled: boolean;
	/** Maximum children executing in parallel (1..8). */
	maxParallel: number;
	/** "inherit" | "default" | explicit "provider/model" selector. */
	model: string;
	/** Per-child timeout in milliseconds (bounded). */
	timeoutMs: number;
}

/** The canonical default orchestration settings (conservative). */
export const DEFAULT_AIRA_ORCHESTRATION_SETTINGS: AiraOrchestrationSettings = {
	enabled: true,
	maxParallel: 2,
	model: "inherit",
	timeoutMs: 300_000,
};

export const AIRA_ORCHESTRATION_MAX_PARALLEL = 8;
export const AIRA_ORCHESTRATION_MIN_TIMEOUT_MS = 30_000;
export const AIRA_ORCHESTRATION_MAX_TIMEOUT_MS = 900_000;

/** Sanitize an unknown settings object into valid orchestration settings. */
export function normalizeAiraOrchestrationSettings(value: unknown): AiraOrchestrationSettings {
	const record = (value ?? {}) as Record<string, unknown>;
	return {
		enabled: record.enabled === undefined ? DEFAULT_AIRA_ORCHESTRATION_SETTINGS.enabled : record.enabled === true,
		maxParallel: normalizeMaxParallel(record.maxParallel),
		model: normalizeModel(record.model),
		timeoutMs: normalizeTimeoutMs(record.timeoutMs),
	};
}

function normalizeMaxParallel(value: unknown): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= AIRA_ORCHESTRATION_MAX_PARALLEL) {
		return value;
	}
	return DEFAULT_AIRA_ORCHESTRATION_SETTINGS.maxParallel;
}

function normalizeModel(value: unknown): string {
	if (typeof value !== "string") {
		return DEFAULT_AIRA_ORCHESTRATION_SETTINGS.model;
	}
	const trimmed = value.trim();
	if (trimmed === "inherit" || trimmed === "default") {
		return trimmed;
	}
	// Explicit "provider/model" selector (bounded length, plausible shape).
	if (trimmed.length <= 200 && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/-]+$/.test(trimmed)) {
		return trimmed;
	}
	return DEFAULT_AIRA_ORCHESTRATION_SETTINGS.model;
}

function normalizeTimeoutMs(value: unknown): number {
	if (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= AIRA_ORCHESTRATION_MIN_TIMEOUT_MS &&
		value <= AIRA_ORCHESTRATION_MAX_TIMEOUT_MS
	) {
		return Math.floor(value);
	}
	return DEFAULT_AIRA_ORCHESTRATION_SETTINGS.timeoutMs;
}

/** Extract canonical orchestration settings from a host Settings record. */
export function airaOrchestrationSettingsFrom(settings: Settings): AiraOrchestrationSettings {
	return normalizeAiraOrchestrationSettings(settings.orchestration);
}

/** True when the model selector is the session-inherit mode. */
export function isAiraOrchestrationModelInherit(model: string): boolean {
	return model === "inherit";
}
