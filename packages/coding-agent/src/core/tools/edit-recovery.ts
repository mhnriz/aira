/**
 * Bounded structural recovery for failed exact edits.
 *
 * A stale edit (the file changed between the model's read and the edit landing)
 * can no longer match its oldText exactly. This module re-locates the intended
 * region using deterministic structural evidence only:
 *
 * 1. The line-wise common prefix/suffix of oldText and newText isolates the
 *    lines the model actually intended to change.
 * 2. That changed block must occur exactly once in the current file, comparing
 *    lines with trailing-whitespace tolerance (the tolerance the existing fuzzy
 *    matcher already applies).
 * 3. The located region must be brace-depth balanced, so recovery never splices
 *    across an unrelated declaration.
 *
 * This is deliberately not a fuzzy patch engine: one pass over one file
 * snapshot, exactly one candidate or a conflict, no model call, no embeddings,
 * no edit-distance "closest string wins".
 */

/** Maximum oldText lines considered for recovery. Larger blocks are left to the model. */
const MAX_OLD_TEXT_LINES = 200;
/** Maximum file lines considered for recovery. Keeps candidate derivation bounded. */
const MAX_FILE_LINES = 20000;
const PREVIEW_MAX_LINES = 3;
const PREVIEW_MAX_LINE_CHARS = 160;
const PREVIEW_MAX_CHARS = 480;
const INTENDED_REGION_MAX_CHARS = 96;

/**
 * Metadata attached to a successful edit result when the tool recovered a
 * single stale exact-match failure automatically. Contains no source text.
 */
export interface EditRecoveryMetadata {
	/** How the region was re-located. */
	strategy: "structural-anchor";
	/** Which conflict class triggered recovery. */
	conflict: "stale_region";
	/** Always 1: recovery refuses to choose among multiple candidates. */
	candidateCount: 1;
	/** Whether the current file provably differs from the edit's expectation. */
	fileChanged: true | "unknown";
	/** 1-based first file line replaced by the recovered edit. */
	startLine: number;
	/** 1-based last file line replaced by the recovered edit. */
	endLine: number;
	/** Number of current file lines the recovered edit replaces. */
	replacedLineCount: number;
	/** Number of lines the recovered edit inserts. */
	insertedLineCount: number;
}

/** Compact, bounded hint pointing at a likely-but-unsafe region. */
export interface EditRegionHint {
	/** 1-based first line of the hinted region. */
	startLine: number;
	/** 1-based last line of the hinted region. */
	endLine: number;
	/** Bounded preview of the hinted region (never the whole file). */
	preview: string;
}

export type EditConflictReason = "target_not_found" | "multiple_candidates" | "unsafe_recovery" | "unsupported";

/** Structured, machine-readable description of a failed exact edit. */
export interface EditConflict {
	reason: EditConflictReason;
	candidateCount: number;
	fileChanged: boolean | "unknown";
	intendedRegion: string | null;
	closestRegion: EditRegionHint | null;
	recommendation: string;
}

/** A safe, uniquely-located replacement for a stale edit. */
export interface RecoveredEditRegion {
	/** Exact current-file text to replace (verbatim slice of the file). */
	oldText: string;
	/** Replacement text derived from the model's intended newText. */
	newText: string;
	metadata: EditRecoveryMetadata;
	/** Bounded hint describing the located region. */
	regionHint: EditRegionHint;
}

export type StaleRegionPlan =
	| { status: "recovered"; region: RecoveredEditRegion }
	| { status: "conflict"; conflict: EditConflict };

function conflict(
	reason: EditConflictReason,
	candidateCount: number,
	fileChanged: boolean | "unknown",
	intendedRegion: string | null,
	closestRegion: EditRegionHint | null,
	recommendation: string,
): StaleRegionPlan {
	return {
		status: "conflict",
		conflict: { reason, candidateCount, fileChanged, intendedRegion, closestRegion, recommendation },
	};
}

/** Split into lines, dropping the single trailing empty element produced by a final newline. */
function splitEditLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

function lineKey(line: string): string {
	return line.trimEnd();
}

function truncate(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function regionHint(fileLines: string[], start: number, end: number): EditRegionHint {
	const previewLines = fileLines
		.slice(start, Math.min(end + 1, start + PREVIEW_MAX_LINES))
		.map((line) => truncate(line.trim(), PREVIEW_MAX_LINE_CHARS));
	return {
		startLine: start + 1,
		endLine: end + 1,
		preview: truncate(previewLines.join("\n"), PREVIEW_MAX_CHARS),
	};
}

/** Line-wise common prefix length, comparing raw lines so whitespace-only changes still count. */
function commonLinePrefix(oldLines: string[], newLines: string[]): number {
	let count = 0;
	while (count < oldLines.length && count < newLines.length && oldLines[count] === newLines[count]) {
		count += 1;
	}
	return count;
}

/** Line-wise common suffix length, never overlapping the prefix. */
function commonLineSuffix(oldLines: string[], newLines: string[], prefixLength: number): number {
	let count = 0;
	while (
		count < oldLines.length - prefixLength &&
		count < newLines.length - prefixLength &&
		oldLines[oldLines.length - 1 - count] === newLines[newLines.length - 1 - count]
	) {
		count += 1;
	}
	return count;
}

/**
 * All file offsets where `targetLines` occurs as a contiguous line block.
 * Lines compare with trailing whitespace stripped, matching the fuzzy matcher's tolerance.
 */
function findContiguousOccurrences(fileLines: string[], targetLines: string[]): number[] {
	const fileKeys = fileLines.map(lineKey);
	const targetKeys = targetLines.map(lineKey);
	const matches: number[] = [];
	for (let start = 0; start + targetKeys.length <= fileKeys.length; start += 1) {
		let matched = true;
		for (let offset = 0; offset < targetKeys.length; offset += 1) {
			if (fileKeys[start + offset] !== targetKeys[offset]) {
				matched = false;
				break;
			}
		}
		if (matched) {
			matches.push(start);
		}
	}
	return matches;
}

/**
 * `true` when the region neither closes a block opened before it nor leaves a
 * block open after it. This is the structural guard that stops recovery from
 * splicing across an unrelated declaration/function boundary. Braces inside
 * strings/comments are not parsed; the check can only reject a candidate, never
 * misapply one.
 */
function regionStaysWithinEnclosingBlock(fileLines: string[], start: number, end: number): boolean {
	let depth = 0;
	for (let index = 0; index < start; index += 1) {
		depth += braceDelta(fileLines[index]);
	}
	const entryDepth = depth;
	for (let index = start; index <= end; index += 1) {
		depth += braceDelta(fileLines[index]);
		if (depth < entryDepth) {
			return false;
		}
	}
	return depth === entryDepth;
}

function braceDelta(line: string): number {
	let delta = 0;
	for (const char of line) {
		if (char === "{") {
			delta += 1;
		} else if (char === "}") {
			delta -= 1;
		}
	}
	return delta;
}

/**
 * Whether the current file provably differs from the edit's expectation.
 * `true` when some non-blank oldText line still survives in the file (evidence
 * of a stale region); `"unknown"` when nothing from oldText survives, because
 * the mismatch may be a model mistake rather than a file change.
 */
function detectFileChanged(oldLines: string[], fileLines: string[]): boolean | "unknown" {
	const fileKeys = new Set(fileLines.map(lineKey));
	for (const line of oldLines) {
		const key = lineKey(line);
		if (key.trim().length === 0) {
			continue;
		}
		if (fileKeys.has(key)) {
			return true;
		}
	}
	return "unknown";
}

function describeIntendedRegion(targetLines: string[], oldLines: string[], prefixLength: number): string | null {
	const source = targetLines.length > 0 ? targetLines : prefixLength > 0 ? [oldLines[prefixLength - 1]] : oldLines;
	if (source.length === 0) {
		return null;
	}
	const first = source[0].trim();
	if (first.length === 0) {
		return null;
	}
	return truncate(first, INTENDED_REGION_MAX_CHARS);
}

/**
 * Attempt exactly one bounded structural recovery for a stale exact edit.
 *
 * The caller has already established that `oldText` does not match the current
 * file. Returns a single safe replacement region, or a structured conflict.
 * Pure: never reads or writes files, never mutates its inputs.
 */
export function planStaleRegionRecovery(content: string, edit: { oldText: string; newText: string }): StaleRegionPlan {
	const oldLines = splitEditLines(edit.oldText);
	const newLines = splitEditLines(edit.newText);
	const fileLines = splitEditLines(content);

	if (oldLines.length === 0) {
		return conflict(
			"unsupported",
			0,
			"unknown",
			null,
			null,
			"reread the relevant region and retry with current exact text",
		);
	}

	const fileChanged = detectFileChanged(oldLines, fileLines);

	if (oldLines.length > MAX_OLD_TEXT_LINES || fileLines.length > MAX_FILE_LINES) {
		return conflict(
			"unsupported",
			0,
			fileChanged,
			describeIntendedRegion([], oldLines, 0),
			null,
			"reread the relevant region and retry with current exact text",
		);
	}

	const prefixLength = commonLinePrefix(oldLines, newLines);
	const suffixLength = commonLineSuffix(oldLines, newLines, prefixLength);
	const oldTarget = oldLines.slice(prefixLength, oldLines.length - suffixLength);
	const newTarget = newLines.slice(prefixLength, newLines.length - suffixLength);
	const intendedRegion = describeIntendedRegion(oldTarget, oldLines, prefixLength);

	if (oldTarget.length === 0) {
		// Pure insertion: the changed region has no old-side anchor, so the
		// insertion point cannot be established safely. Refuse to guess.
		return conflict(
			"unsafe_recovery",
			0,
			fileChanged,
			intendedRegion,
			null,
			"reread the relevant region and retry with current exact text",
		);
	}

	const occurrences = findContiguousOccurrences(fileLines, oldTarget);
	if (occurrences.length === 0) {
		return conflict(
			"target_not_found",
			0,
			fileChanged,
			intendedRegion,
			null,
			"reread the relevant region and retry with current exact text",
		);
	}
	if (occurrences.length > 1) {
		return conflict(
			"multiple_candidates",
			occurrences.length,
			fileChanged,
			intendedRegion,
			null,
			"reread the file and retry with current exact text",
		);
	}

	const start = occurrences[0];
	const end = start + oldTarget.length - 1;
	const regionLines = fileLines.slice(start, end + 1);

	if (!regionStaysWithinEnclosingBlock(fileLines, start, end)) {
		return conflict(
			"unsafe_recovery",
			1,
			fileChanged,
			intendedRegion,
			regionHint(fileLines, start, end),
			"reread the relevant region and retry with current exact text",
		);
	}

	return {
		status: "recovered",
		region: {
			oldText: regionLines.join("\n"),
			newText: newTarget.join("\n"),
			metadata: {
				strategy: "structural-anchor",
				conflict: "stale_region",
				candidateCount: 1,
				fileChanged: true,
				startLine: start + 1,
				endLine: end + 1,
				replacedLineCount: regionLines.length,
				insertedLineCount: newTarget.length,
			},
			regionHint: regionHint(fileLines, start, end),
		},
	};
}

/** Bounded, human-readable rendering of a structured edit conflict. */
export function renderEditConflict(path: string, conflictInfo: EditConflict, originalMessage: string): string {
	const lines = [
		"EDIT_CONFLICT",
		`file: ${path}`,
		`reason: ${conflictInfo.reason}`,
		`candidate_count: ${conflictInfo.candidateCount}`,
		`file_changed: ${conflictInfo.fileChanged}`,
		`intended_region: ${conflictInfo.intendedRegion ?? "null"}`,
	];
	if (conflictInfo.closestRegion) {
		const { startLine, endLine, preview } = conflictInfo.closestRegion;
		lines.push(`closest_region: ${startLine}-${endLine}`);
		lines.push(`closest_preview: ${JSON.stringify(preview)}`);
	} else {
		lines.push("closest_region: null");
	}
	lines.push(`detail: ${originalMessage}`);
	lines.push(`recommendation: ${conflictInfo.recommendation}`);
	return lines.join("\n");
}
