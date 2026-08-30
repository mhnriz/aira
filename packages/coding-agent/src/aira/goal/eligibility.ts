/**
 * Aira goal — promotion eligibility (SMART mode).
 *
 * Deterministic rules deciding whether a user objective deserves a native
 * durable Goal. A Goal grants autonomous continuation, which spends model
 * tokens; creating one for every prompt would multiply costs on trivial
 * work. `smart` mode therefore skips objectives that are plainly trivial:
 * typo fixes, comment edits, one-line obvious changes, tiny documentation
 * corrections, plain questions, and pure commands.
 *
 * The classification is conservative in the SAFE direction: anything not
 * clearly trivial stays eligible (a durable Goal on a genuinely trivial task
 * costs at most a snapshot; missing one on a substantial task loses bounded
 * autonomy). Trivial work also never fires the automatic verifier
 * (verification eligibility rules), so a promoted Goal on trivial work would
 * not loop: no work → no verdict → no continuation.
 */
import type { AiraGoalAutoSetting } from "./settings.ts";

const MAX_OBJECTIVE_CHARS_FOR_CLASSIFICATION = 400;

/** Content-declaration objectives (no implementation to run autonomously). */
const TRIVIAL_PATTERNS: readonly RegExp[] = [
	// trivial code/doc edits
	/\bfix (a |the )?(typo|spelling|spelling mistake|grammar)\b/i,
	/\b(correct|fix) (the )?(spelling|grammar)\b/i,
	/\b(add|update|fix|remove|improve) (a |the )?comment\b/i,
	/\b(add|fix|remove) (a |the )?semicolon\b/i,
	/\b(rename|re-name) (a |the |this |that )?\w+ (to|into)\b/i,
	/\bsingle[- ]line (change|edit|fix)\b/i,
	/\bfix (the |a )?(spacing|indentation|indent|formatting)\b/i,
	/\b(re-?format|format) (the )?(file|code)\b/i,
	/\b(add|fix) (a )?(newline|blank line)\b/i,
	// tiny documentation corrections
	/\b(update|fix|correct|improve|write) (the )?(readme|docs?|documentation|changelog|comment)\b/i,
	/\bbump (the )?(version|dependency)\b/i,
	// pure questions / explanations (no implementation objective)
	/^(what|how|why|when|where|who|which|explain|describe|summarize|tell me about)\b/i,
	/^(can|could|does|do|is|are|will|would) .*\?$/i,
	// pure commands / control
	/^\/\w+/,
];

/** Goal-worthy (non-trivial) markers — conservative hints, never required. */
const SUBSTANTIAL_PATTERNS: readonly RegExp[] = [
	/\b(implement|build|create|add|develop|write) (a |an |the |new )?(feature|module|endpoint|api|service|component|system|function|command|tool|test)/i,
	/\bfix (a |an |the )?(bug|issue|problem|defect|regression|crash)\b/i,
	/\b(re-?factor|refactoring|restructure|migrate|migration)\b/i,
	/\b(integrate|integration|wire up|hook up)\b/i,
	/\b(debug|investigate|trace)\b/i,
	/\b(cross[- ]module|multi[- ]file|multi[- ]step)\b/i,
	/\b(browser|ui|frontend|front[- ]end|css|layout|visual) .*(fix|change|behavior|behaviour)\b/i,
	/\b(delegate|parallel|children|subagent|agents)\b/i,
	/\b(test|verify|validate).*(suite|coverage|fixture|harness)\b/i,
];

/** Objective text classified as trivially small (very short single intent). */
function isTriviallyShort(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.length > 0 && trimmed.length <= 32;
}

/**
 * True when the objective is clearly trivial (SMART mode skips durable
 * Goals for these). Conservative: non-matching text is NOT trivial.
 */
export function isTrivialGoalObjective(text: string): boolean {
	const bounded = boundedText(text, MAX_OBJECTIVE_CHARS_FOR_CLASSIFICATION);
	const normalized = bounded.trim();
	if (normalized.length === 0) {
		return true;
	}
	if (TRIVIAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
		return true;
	}
	if (isTriviallyShort(normalized)) {
		return true;
	}
	return false;
}

/** True when the objective carries explicit substantial-work markers. */
export function hasSubstantialGoalMarkers(text: string): boolean {
	const bounded = boundedText(text, MAX_OBJECTIVE_CHARS_FOR_CLASSIFICATION);
	return SUBSTANTIAL_PATTERNS.some((pattern) => pattern.test(bounded));
}

/**
 * Smart-mode promotion decision.
 *
 * `smart` promotes unless the objective is CLEARLY trivial; `always`
 * promotes every objective; `off` never promotes automatically. The
 * trivial-skip applies to automatic promotion only — `/goal create` is
 * always explicit user intent.
 */
export function decideAiraGoalPromotion(auto: AiraGoalAutoSetting, text: string): { promote: boolean; reason: string } {
	if (auto === "off") {
		return { promote: false, reason: "goals.auto is off" };
	}
	const trivial = isTrivialGoalObjective(text);
	if (trivial && auto !== "always") {
		return { promote: false, reason: "trivial objective (smart mode skips durable goals)" };
	}
	return { promote: true, reason: auto === "always" ? "always mode" : "non-trivial objective (smart mode)" };
}

function boundedText(value: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	return `${trimmed.slice(0, max - 1)}…`;
}
