/**
 * Aira browser — canonical-state snapshot shapes.
 *
 * `AiraBrowserStatus` is the bounded, provider-independent snapshot the
 * browser runtime publishes into `AiraSessionState.browser` (ADR-005: one
 * canonical state owner). It carries summaries and references — never DOM
 * trees, screenshots, raw logs, or provider internals. The future Workbench
 * and footer render this state without reaching into browser internals and
 * without spending model tokens.
 */

/**
 * Truthful browser capability availability state in the canonical snapshot
 * (distinct from the provider probe result `AiraBrowserAvailability`).
 */
export type AiraBrowserAvailabilityState = "unknown" | "available" | "unavailable" | "disabled";

/** Truthful browser lifecycle status. */
export type AiraBrowserRuntimeStatus = "idle" | "active" | "degraded" | "unavailable";

/** Bounded verification outcome of a browser check pass. */
export type AiraBrowserVerificationStatus = "none" | "pending" | "passed" | "failed";

export interface AiraBrowserFinding {
	/** One-line message (deduplicated representative). */
	message: string;
	/** Source hint when known (`src/player.ts` style path or URL). */
	source?: string;
	/** 1-based line in the source, when known. */
	line?: number;
	/** How many times this exact finding occurred. */
	count: number;
	/** Milliseconds since epoch of the first occurrence. */
	firstAt: number;
	/** Milliseconds since epoch of the latest occurrence. */
	lastAt: number;
}

export interface AiraBrowserTabSnapshot {
	id: string;
	url: string;
	title: string;
	/** document.readyState of the active frame. */
	readyState: "loading" | "interactive" | "complete" | "unknown";
}

export interface AiraBrowserStatus {
	/** "unknown" before the first probe; "available"/"unavailable"/"disabled" after. */
	availability: AiraBrowserAvailabilityState;
	/** True when the current project/task could benefit from browser checks. */
	eligible: boolean;
	/** idle | active | degraded | unavailable. */
	status: AiraBrowserRuntimeStatus;
	/** Provider id, e.g. "cdp-chromium". */
	provider: string;
	/** "isolated" always in Phase 7: Aira never attaches to a personal profile. */
	profileKind: "isolated";
	/** Aira-owned profile directory (display path), when a session exists. */
	profileDir?: string;
	/** Bounded tab table. */
	tabs: AiraBrowserTabSnapshot[];
	/** The active tab, when any. */
	activeTab?: AiraBrowserTabSnapshot;
	/** Console evidence summary (counts + top finding only). */
	console: {
		errors: number;
		warnings: number;
		/** Total captured log entries. */
		total: number;
		topFinding?: AiraBrowserFinding;
	};
	/** Network evidence summary (failures only). */
	network: {
		/** Failed/4xx/5xx/aborted/blocked request count (deduplicated). */
		failures: number;
		topFinding?: AiraBrowserFinding;
	};
	/** Observation state (revision bumps whenever a semantic observation lands). */
	observation: {
		revision: number;
		/** One-line semantic summary, e.g. "player page · ready · 3 inputs". */
		summary?: string;
		nodeCount?: number;
		lastAt?: number;
	};
	/** Bounded automatic/explicit verification evidence. */
	verification: {
		status: AiraBrowserVerificationStatus;
		lastCheckAt?: number;
		/** Top console/network finding at the last check, when it failed. */
		finding?: AiraBrowserFinding;
	};
	/** Screenshot reference metadata (never image bytes). */
	screenshot: {
		lastPath?: string;
		lastAt?: number;
	};
	/** Associated Phase 6 dev process (runtime association), when any. */
	devProcess?: {
		id: string;
		status: string;
		url?: string;
	};
	/** Truthful degraded/unavailable reason, when applicable. */
	reason?: string;
	/** When this snapshot was published (ms since epoch). */
	updatedAt: number;
}

export function initialAiraBrowserStatus(): AiraBrowserStatus {
	return {
		availability: "unknown",
		eligible: false,
		status: "idle",
		provider: "cdp-chromium",
		profileKind: "isolated",
		tabs: [],
		console: { errors: 0, warnings: 0, total: 0 },
		network: { failures: 0 },
		observation: { revision: 0 },
		verification: { status: "none" },
		screenshot: {},
		updatedAt: Date.now(),
	};
}
