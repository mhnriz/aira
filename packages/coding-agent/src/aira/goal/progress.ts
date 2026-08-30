/**
 * Aira goal — progress / no-progress detection.
 *
 * Continuation bounds must not rely on round numbers alone: two consecutive
 * rounds that leave the implementation state IDENTICAL (same verified
 * revision fingerprint, or an identical blocking FINDING) are no-progress,
 * even if the model spent tokens. This module computes revision and
 * blocking-finding fingerprints and decides whether a round advanced the
 * work.
 *
 * Progress signals consumed (from canonical snapshots, never transcripts):
 * - the verification revision id (change-set + mtime fingerprint);
 * - the highest-priority blocking finding text (FAIL evidence);
 * - the verification verdict class.
 */
export interface AiraRoundObservation {
	/** Verification revision id of the round's change set (undefined when unverified). */
	revisionId: string | undefined;
	/** Highest-priority blocking finding text (undefined when none). */
	blockingFinding: string | undefined;
	/** Verdict class of the round ("pass" | "fail" | "inconclusive" | undefined). */
	verdict: "pass" | "fail" | "inconclusive" | undefined;
}

const MAX_BLOCKING_SIGNATURE_CHARS = 240;

/** Stable short signature of a blocking finding (identical findings collide). */
export function blockingFindingSignature(finding: string | undefined): string | undefined {
	if (!finding) {
		return undefined;
	}
	const normalized = finding.trim().replace(/\s+/g, " ");
	if (normalized.length === 0) {
		return undefined;
	}
	const bounded =
		normalized.length <= MAX_BLOCKING_SIGNATURE_CHARS
			? normalized
			: `${normalized.slice(0, MAX_BLOCKING_SIGNATURE_CHARS - 1)}…`;
	return `${bounded.length}:${bounded}`;
}

/** Fingerprint of a round's implementation state (revision + blocking finding). */
export function roundFingerprint(observation: AiraRoundObservation): string | undefined {
	const signature = blockingFindingSignature(observation.blockingFinding);
	if (observation.revisionId || signature) {
		return `${observation.revisionId ?? "-"}\u0000${signature ?? "-"}`;
	}
	return undefined;
}

/**
 * No-progress decision: the previous round and the current round ended with
 * the same implementation fingerprint (identical revision AND same blocking
 * finding — or both absent). A new revision with the same finding is
 * progress in evidence terms (the finding may persist legitimately); only
 * a FULLY identical state is no-progress.
 */
export function isNoProgress(previous: AiraRoundObservation | undefined, current: AiraRoundObservation): boolean {
	if (!previous) {
		return false;
	}
	const previousFingerprint = roundFingerprint(previous);
	const currentFingerprint = roundFingerprint(current);
	if (previousFingerprint === undefined || currentFingerprint === undefined) {
		return false;
	}
	return previousFingerprint === currentFingerprint;
}

/**
 * Repeated-verdict decision: two consecutive rounds ended with the SAME
 * verdict class and the SAME blocking finding signature (an identical FAIL
 * that repair did not change). PASS is never repeated (completion ends the
 * goal); INCONCLUSIVE repetition is handled by the waiting logic, not this
 * bound.
 */
export function isRepeatedVerdict(previous: AiraRoundObservation | undefined, current: AiraRoundObservation): boolean {
	if (!previous || previous.verdict !== "fail" || current.verdict !== "fail") {
		return false;
	}
	if (!previous.blockingFinding || !current.blockingFinding) {
		return false;
	}
	return blockingFindingSignature(previous.blockingFinding) === blockingFindingSignature(current.blockingFinding);
}
