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
		findings: { total: 0, errors: 0, warnings: 0, stale: 0 },
		degraded: false,
	};
}
