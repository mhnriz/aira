/**
 * Aira intelligence — health snapshot shape.
 *
 * The observable summary of the intelligence service, carried on the
 * canonical `AiraSessionState.intelligence` so `/doctor` (and future
 * surfaces) can report it. The coordinator is the only writer; the shape is
 * deliberately small and degraded-first: when anything is unavailable the
 * snapshot says so, and `degraded: true` is the honest summary.
 */
import type { AiraProjectConfidence } from "../project/profile.ts";

export interface AiraLiveCodeServerStatus {
	id: string;
	status: string;
	available: boolean;
	error?: string;
}

export interface AiraIntelligenceTopFinding {
	severity: "error" | "warning" | "information" | "hint" | "other";
	/** LSP/diagnostic code when the source provided one (e.g. "TS2339"). */
	code?: string | number;
	/** One-line message. */
	message: string;
	/** Path relative to the project root when derivable. */
	path?: string;
	/** 1-based line in the file, when known. */
	line?: number;
	/** Freshness verdict (stale findings never present as current truth). */
	freshness: "fresh" | "stale" | "indeterminate";
}

export interface AiraIntelligenceStatus {
	/** Activation decision for this session. */
	active: boolean;
	activationReason: string;
	confidence: AiraProjectConfidence;
	languages: readonly string[];
	liveCode: {
		status: "unavailable" | "idle" | "ready" | "degraded";
		servers: AiraLiveCodeServerStatus[];
		spawnCount: number;
		crashCount: number;
	};
	repository: {
		status: string;
		filesIndexed: number;
		cacheLoaded: boolean;
		error?: string;
		changesAvailable: boolean;
		changeCount: number | undefined;
	};
	findings: {
		total: number;
		errors: number;
		warnings: number;
		stale: number;
		/** Bounded top findings for UI projections (Workbench/footer); empty when none. */
		top: AiraIntelligenceTopFinding[];
	};
	degraded: boolean;
}

/** The snapshot before any coordinator work ran (or when it failed silently). */
export function initialAiraIntelligenceStatus(): AiraIntelligenceStatus {
	return {
		active: false,
		activationReason: "not yet activated",
		confidence: "none",
		languages: [],
		liveCode: { status: "unavailable", servers: [], spawnCount: 0, crashCount: 0 },
		repository: {
			status: "uninitialized",
			filesIndexed: 0,
			cacheLoaded: false,
			changesAvailable: false,
			changeCount: undefined,
		},
		findings: { total: 0, errors: 0, warnings: 0, stale: 0, top: [] },
		degraded: false,
	};
}
