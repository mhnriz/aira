/**
 * Aira verification — eligibility.
 *
 * Deterministic rules deciding whether an ended agent run qualifies for
 * automatic verification (and whether `smart` mode should skip it to avoid
 * spending verifier model tokens on trivial work).
 *
 * Trivial work (docs/comments/spelling/one-line renames) does NOT justify an
 * independent verifier call. Non-trivial classes (bug fixes, behavior
 * changes, multi-file implementations, API changes, state-machine changes,
 * browser/UI behavior, test-related work, refactors with meaningful impact)
 * do. The classification is conservative: when the evidence is ambiguous the
 * change counts as non-trivial (verification is the safe direction), and
 * `always` mode verifies every meaningful implementation regardless.
 */
import type { AiraVerificationAutoSetting } from "./settings.ts";

export interface AiraChangeFile {
	/** Path relative to the project root. */
	path: string;
	status: "added" | "modified" | "deleted" | "renamed" | "untracked";
	/** Added lines (git numstat; unknown for untracked files). */
	added: number;
	/** Deleted lines (git numstat; unknown for untracked files). */
	deleted: number;
}

export interface AiraChangeObservation {
	/** Bounded list of paths in the implementation change set. */
	files: AiraChangeFile[];
	/** True when the change set source (git) is unavailable and paths are run-tracked only. */
	unreliable?: boolean;
	/** Whether the ended run performed real work (edits/execution/browser). */
	workHappened: boolean;
}

/** One-line rename bound: a single code file with a tiny content delta. */
export const MAX_TRIVIAL_CODE_DELTA_LINES = 2;

/** Upper bound on paths considered for classification. */
export const MAX_CHANGE_PATHS_FOR_CLASSIFICATION = 200;

const DOC_PATH_RE =
	/(^|[\\/])(docs?|doc|documentation)([\\/]|$)|\.(md|markdown|txt|rst|adoc)($|[\\/])|readme|changelog|license|contributing|notice|copying/i;

/** File names that are documentation/comment-shaped regardless of location. */
const DOC_NAME_RE = /^(readme|changelog|license|licence|contributing|notice|copying|authors|codeowners)(\.[^\\/]*)?$/i;

/** Config files that are declaration-only (not behavior). Conservative list. */
const CONFIG_DECLARATION_RE =
	/(^|[\\/])(\.github|\.vscode|\.idea)([\\/]|$)|\.(json5?|ya?ml|toml|editorconfig|gitignore|gitattributes|npmrc|prettierrc|eslintignore|prettierignore|dockerignore)($|[\\/])/i;

export function isDocLikePath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	return DOC_PATH_RE.test(normalized) || DOC_NAME_RE.test(normalized) || CONFIG_DECLARATION_RE.test(normalized);
}

/**
 * Smart-mode trivial classification.
 *
 * A change is trivial when:
 * - every changed path is doc/declaration-shaped, OR
 * - exactly one code file changed with at most MAX_TRIVIAL_CODE_DELTA_LINES
 *   total added+deleted lines and the language diagnostics are clean
 *   (a one-line rename / tiny reply-style edit).
 *
 * Diagnostics cleanliness is only trusted when the live-code snapshot says
 * findings are non-stale; without diagnostics evidence the code change is
 * conservatively non-trivial.
 */
export function isTrivialImplementationChange(
	files: readonly AiraChangeFile[],
	diagnosticsClean: boolean | undefined,
): boolean {
	if (files.length === 0) {
		return true;
	}
	if (files.length > MAX_CHANGE_PATHS_FOR_CLASSIFICATION) {
		return false;
	}
	const nonDoc = files.filter((file) => file.path !== undefined && !isDocLikePath(file.path));
	if (nonDoc.length === 0) {
		return true;
	}
	if (nonDoc.length === 1 && diagnosticsClean === true) {
		const file = nonDoc[0];
		const delta = (file.added > 0 ? file.added : 0) + (file.deleted > 0 ? file.deleted : 0);
		if (delta <= MAX_TRIVIAL_CODE_DELTA_LINES && file.added + file.deleted > 0) {
			return true;
		}
	}
	return false;
}

/**
 * Smart-mode decision: would an automatic run be worthwhile?
 *
 * `workHappened` is the gate for every auto mode (nothing meaningful was
 * implemented → nothing to verify). `trivial` only skips under `smart`.
 */
export function decideAutomaticVerification(
	auto: AiraVerificationAutoSetting,
	workHappened: boolean,
	files: readonly AiraChangeFile[],
	diagnosticsClean: boolean | undefined,
): { run: boolean; reason: string } {
	if (!workHappened) {
		return { run: false, reason: "no implementation work in the ended run" };
	}
	if (auto === "off") {
		return { run: false, reason: "verification.auto is off" };
	}
	if (auto === "smart" && isTrivialImplementationChange(files, diagnosticsClean)) {
		return { run: false, reason: "trivial change (smart mode skips verifier tokens)" };
	}
	return { run: true, reason: auto === "always" ? "always mode" : "non-trivial implementation (smart mode)" };
}
