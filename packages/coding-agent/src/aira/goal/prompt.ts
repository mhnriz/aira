/**
 * Aira goal — repair continuation prompt.
 *
 * The bounded directive that drives a repair round after a FAIL verdict.
 * Deliberately NOT the previous conversation: the repair input is the
 * original objective + current verification requirements + blocking
 * findings + concrete evidence + the current task/change state. The
 * implementing model continues its existing session context (the messages
 * it already has), so the continuation only needs the NEW information.
 */
export const AIRA_GOAL_CONTINUATION_TYPE = "aira.goal.continuation";
const MAX_CONTINUATION_CHARS = 3_000;
const MAX_FINDINGS = 5;
const MAX_FINDING_CHARS = 300;
const MAX_EVIDENCE = 8;
const MAX_EVIDENCE_CHARS = 200;

/** Bounded repair context extracted from a FAIL verification result. */
export interface AiraGoalRepairContext {
	/** Bounded verifier summary. */
	summary: string;
	/** Bounded blocking-finding lines. */
	blocking: string[];
	/** Bounded unmet-requirement lines ("R1: detail"). */
	unmet: string[];
	/** Bounded evidence labels the verifier inspected. */
	evidence: string[];
}

export interface AiraGoalContinuationInput {
	/** Goal objective (bounded). */
	objective: string;
	/** Round number of the continuation. */
	round: number;
	/** Bounded repair context (from the FAIL verdict). */
	repair: AiraGoalRepairContext;
	/** Bounded change-state context (what already changed). */
	changeContext: string;
}

/** Build the bounded repair directive (custom-message content). */
export function buildAiraGoalContinuationPrompt(input: AiraGoalContinuationInput): string {
	const lines: string[] = [
		`Continue implementing the active goal objective: ${bound(input.objective, 400)}`,
		`This is repair round ${input.round}.`,
		"",
		"AUTONOMOUS GOAL CONTINUATION: fix the blocking findings below, then stop. Never declare the goal complete; completion is decided by independent verification.",
		"",
	];
	if (input.changeContext.trim().length > 0) {
		lines.push(`Current change state: ${input.changeContext.trim()}`);
		lines.push("");
	}
	if (input.repair.blocking.length > 0) {
		lines.push("Independent verification BLOCKING findings:");
		for (const finding of input.repair.blocking.slice(0, MAX_FINDINGS)) {
			lines.push(`- ${bound(finding, MAX_FINDING_CHARS)}`);
		}
	} else {
		lines.push("Independent verification reported FAIL without blocking findings.");
	}
	if (input.repair.unmet.length > 0) {
		lines.push("");
		lines.push("Unmet verification requirements:");
		for (const requirement of input.repair.unmet) {
			lines.push(`- ${bound(requirement, 180)}`);
		}
	}
	if (input.repair.evidence.length > 0) {
		lines.push("");
		lines.push(
			`Evidence the verifier inspected: ${input.repair.evidence
				.slice(0, MAX_EVIDENCE)
				.map((item) => bound(item, MAX_EVIDENCE_CHARS))
				.join(" | ")}`,
		);
	}
	const joined = lines.join("\n");
	return joined.length <= MAX_CONTINUATION_CHARS ? joined : `${joined.slice(0, MAX_CONTINUATION_CHARS - 1)}…`;
}

function bound(value: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	return `${trimmed.slice(0, max - 1)}…`;
}
