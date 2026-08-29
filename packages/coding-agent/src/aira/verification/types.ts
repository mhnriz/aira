/**
 * Aira verification — canonical verdict contract and snapshot shapes.
 *
 * Phase 8: independent verification. The verdict is the completion
 * authority ABOVE the implementation agent: PASS / FAIL / INCONCLUSIVE,
 * derived from bounded provider-independent evidence plus a fresh-context
 * verifier model call. `AiraVerificationStatus` is the bounded, token-free,
 * TUI-independent snapshot published into `AiraSessionState.verification`
 * (ADR-005) so the future Workbench/footer render verification without
 * verifier/model internals and without spending model tokens.
 *
 * INCONCLUSIVE must never silently become PASS: the verdict types make the
 * three outcomes explicit, and the manager never upgrades a verdict.
 */
import type { AiraMode } from "../state.ts";
import type { AiraVerificationContextBudget } from "./settings.ts";

/** Canonical independent-verification outcome. */
export type AiraVerificationVerdict = "pass" | "fail" | "inconclusive";

/** Canonical verification snapshot status (lifecycle, mirror of the verdict). */
export type AiraVerificationStatusState =
	| "idle" // never ran for the current state
	| "preparing" // collecting evidence (token-free)
	| "running" // verifier model invocation in flight
	| "passed" // verdict PASS, result current
	| "failed" // verdict FAIL
	| "inconclusive"; // verdict INCONCLUSIVE or verifier driver failure

/** Requirement origin: directly stated vs. necessary for the objective. */
export type AiraRequirementKind = "explicit" | "inferred";

/** Requirement outcome after verification. */
export type AiraRequirementStatus = "verified" | "unmet" | "unverifiable";

/** Finding severity (blocking findings drive FAIL). */
export type AiraFindingSeverity = "blocking" | "warning" | "info";

/** Evidence category in the bounded evidence list. */
export type AiraEvidenceCategory = "repository" | "language" | "execution" | "browser" | "git" | "verifier";

/** Scope-drift assessment outcome. */
export type AiraScopeVerdict = "in-scope" | "drift" | "uncertain";

export interface AiraVerificationRequirement {
	/** Stable id inside the result, e.g. "R1". */
	id: string;
	/** Requirement text (bounded). */
	text: string;
	/** explicit = stated by the user; inferred = necessary for the objective. */
	kind: AiraRequirementKind;
	status: AiraRequirementStatus;
}

export interface AiraVerificationFinding {
	severity: AiraFindingSeverity;
	/** Requirement this finding maps to, when any. */
	requirementId?: string;
	/** One-line actionable message. */
	message: string;
	/** Concrete evidence reference (path/command/console line), bounded. */
	evidence?: string;
}

export interface AiraVerificationEvidenceItem {
	category: AiraEvidenceCategory;
	label: string;
	/** Bounded summary line. */
	summary: string;
}

export interface AiraVerificationScopeAssessment {
	verdict: AiraScopeVerdict;
	/** Why additional scope is suspicious or valid (bounded lines). */
	notes: string[];
}

export interface AiraVerificationResult {
	/** Result id (run identity). */
	id: string;
	/** Change identity this result verifies (hash of the change set). */
	revisionId: string;
	verdict: AiraVerificationVerdict;
	/** Bounded verifier summary. */
	summary: string;
	/** Mode the verification ran in. */
	mode: AiraMode;
	/** Bounded user objective the requirements were derived from. */
	objective: string;
	requirements: AiraVerificationRequirement[];
	findings: AiraVerificationFinding[];
	evidence: AiraVerificationEvidenceItem[];
	/** Explicit missing-evidence list (never silently folded into PASS). */
	missingEvidence: string[];
	scopeAssessment: AiraVerificationScopeAssessment;
	confidence: "low" | "medium" | "high";
	startedAt: number;
	completedAt: number;
	/**
	 * Freshness: true when relevant state moved after completion (a new edit,
	 * a drift in the verified change set, or a blocking diagnostic change).
	 * A stale PASS is not completion evidence.
	 */
	stale: boolean;
	/** Why the result became stale, when applicable. */
	staleReason?: string;
}

/**
 * Canonical verification snapshot (`state.verification`). Bounded,
 * provider-independent, token-free: rendering it never invokes the model.
 */
export interface AiraVerificationStatus {
	status: AiraVerificationStatusState;
	/** Projection of verification.enabled. */
	enabled: boolean;
	/** Projection of verification.auto. */
	auto: "off" | "smart" | "always";
	contextBudget: AiraVerificationContextBudget;
	/** Latest completed result (may be stale; see `stale`). */
	currentResult?: AiraVerificationResult;
	/** Requirement counts derived from currentResult (UI-ready). */
	requirementsTotal: number;
	requirementsVerified: number;
	/** Highest-severity finding (UI-ready "current finding"). */
	highestFinding?: AiraVerificationFinding;
	/** True when currentResult is stale (relevant state moved after it). */
	stale: boolean;
	/** Direct projection of currentResult.missingEvidence. */
	missingEvidence: string[];
	/** Verifier driver failure (model/auth/unavailable), when the last run failed to run. */
	lastError?: string;
	/** Why the last eligible automatic trigger skipped a run (trivial/dedupe), when applicable. */
	lastSkipReason?: string;
	startedAt?: number;
	completedAt?: number;
	updatedAt: number;
}

export function initialAiraVerificationStatus(settings: {
	enabled: boolean;
	auto: "off" | "smart" | "always";
	contextBudget: AiraVerificationContextBudget;
}): AiraVerificationStatus {
	return {
		status: "idle",
		enabled: settings.enabled,
		auto: settings.auto,
		contextBudget: settings.contextBudget,
		requirementsTotal: 0,
		requirementsVerified: 0,
		stale: false,
		missingEvidence: [],
		updatedAt: Date.now(),
	};
}
