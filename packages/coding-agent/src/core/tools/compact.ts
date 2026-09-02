/**
 * Aira conversation — compact tool activity rendering.
 *
 * Shared building blocks for the compact (collapsed/summary) presentation of
 * tool calls in the interactive conversation. Everything in this module is
 * presentation-only: canonical tool results and session state are untouched.
 *
 * Compact rows follow the Workbench shell visual language (aira-zhr):
 *
 *   ✓ read      src/aira/ui/workbench.ts
 *   ✓ edit      workbench.ts                         +42 -11
 *   ✓ test      tui-multipane.test.ts                41 passed · 4.5s
 *   ✕ test      agent-session-retry.test.ts          2 failed
 *   ● process   npm run dev                          running · 3m12s
 *
 * - success: green glyph, running: cyan, failure: red, warning: yellow
 * - tool labels and metadata muted; paths accent; commands neutral
 * - the target column is padded so rows in a turn share alignment
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "./truncate.ts";

export const COMPACT_GLYPH_RUNNING = "●";
export const COMPACT_GLYPH_SUCCESS = "✓";
export const COMPACT_GLYPH_ERROR = "✕";
export const COMPACT_GLYPH_WARNING = "!";

/** Row status drives the glyph color and excerpt styling. */
export type CompactStatus = "running" | "success" | "error" | "warning";

/** Label column width; longer labels (process logs) simply overflow it. */
export const COMPACT_LABEL_WIDTH = 8;
/** Target column width; longer targets are truncated with an ellipsis. */
export const COMPACT_TARGET_WIDTH = 36;

const STATUS_GLYPH: Record<CompactStatus, string> = {
	running: COMPACT_GLYPH_RUNNING,
	success: COMPACT_GLYPH_SUCCESS,
	error: COMPACT_GLYPH_ERROR,
	warning: COMPACT_GLYPH_WARNING,
};

const STATUS_ROLE: Record<CompactStatus, "cyan" | "success" | "error" | "warning"> = {
	running: "cyan",
	success: "success",
	error: "error",
	warning: "warning",
};

/** Status glyph styled for the current theme (for bespoke row layouts). */
export function compactStatusGlyph(status: CompactStatus, theme: Theme): string {
	return theme.fg(STATUS_ROLE[status], STATUS_GLYPH[status]);
}

export interface CompactRowOptions {
	status: CompactStatus;
	/** Muted tool label (read, edit, test, process, ...). */
	label: string;
	/** Raw target text (path, command, pattern). */
	targetText: string;
	/** Render the target as a path (accent); default: neutral text. */
	targetIsPath?: boolean;
	/** Pre-styled excerpt parts joined with " · " (counts, durations, deltas). */
	excerpt?: readonly string[];
}

/**
 * Build one styled compact row. The target is truncated to the shared target
 * column and padded, so excerpts align across rows of a turn.
 */
export function buildCompactRow(theme: Theme, options: CompactRowOptions): string {
	const { status, label, targetText, targetIsPath = false, excerpt } = options;
	const targetStyled = targetIsPath ? theme.fg("accent", targetText) : targetText;
	const targetColumn = truncateToWidth(targetStyled, COMPACT_TARGET_WIDTH, "...", true);
	const glyph = theme.fg(STATUS_ROLE[status], STATUS_GLYPH[status]);
	const excerptText = excerpt && excerpt.length > 0 ? ` ${excerpt.join(theme.fg("muted", " · "))}` : "";
	return `${glyph} ${theme.fg("muted", label.padEnd(Math.max(COMPACT_LABEL_WIDTH, label.length + 1)))}${targetColumn}${excerptText}`;
}

/** Compact duration: "42ms", "4.5s", "3m12s". */
export function formatCompactDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

// =========================================================================
// Shell command classification (test / check / build display labels)
// =========================================================================

export type ShellPurposeKind = "bash" | "test" | "check" | "build";

const TEST_COMMAND_RE =
	/^(?:(?:\.\/)?test(?:\.[a-z]+)?|vitest|jest|karma|mocha|pytest|go\s+test|cargo\s+test|node\s+--test|tsx\s+--test|bun\s+test|deno\s+test)\b/;
const CHECK_COMMAND_RE = /^(?:check|typecheck|lint|tsc\b|biome\s+check|eslint|prettier\s+--?check|biome\s+lint)\b/;
const BUILD_COMMAND_RE = /^(?:build|tsc\s+--?build|bun\s+build|vite\s+build|next\s+build|webpack|rollup|esbuild|swc)\b/;

export interface ShellCommandInfo {
	kind: ShellPurposeKind;
	/** Command without the package-manager / run wrapper. */
	display: string;
	/** Test target (last path-looking argument), when useful. */
	target?: string;
}

/** Classify a shell command for the compact row label and target. */
export function classifyShellCommand(command: string): ShellCommandInfo {
	const trimmed = command.trim();
	const normalized = trimmed.replace(/^(npx|npm|bun|pnpm|yarn|deno)\s+/, "").replace(/^(?:run|exec)\s+/, "");
	const rest = normalized.trim();
	let kind: ShellPurposeKind = "bash";
	if (TEST_COMMAND_RE.test(rest)) kind = "test";
	else if (CHECK_COMMAND_RE.test(rest)) kind = "check";
	else if (BUILD_COMMAND_RE.test(rest)) kind = "build";

	let target: string | undefined;
	if (kind === "test") {
		const parts = rest.split(/\s+/).slice(1);
		const lastArg = parts[parts.length - 1];
		if (lastArg && !lastArg.startsWith("-") && (lastArg.includes("/") || lastArg.includes("."))) {
			target = lastArg;
		}
	}
	return { kind, display: trimmed, target };
}

// =========================================================================
// Test-runner output summarization (pass/fail counts, bounded scan)
// =========================================================================

const TEST_COUNT_RE = /(\d+)\s+(passed|passing|failed|failing)/g;

function parseTestCounts(line: string): { passed?: number; failed?: number } | undefined {
	let passed: number | undefined;
	let failed: number | undefined;
	for (const match of line.matchAll(TEST_COUNT_RE)) {
		const count = Number(match[1]);
		const kind = match[2];
		if (kind === "passed" || kind === "passing") {
			passed = count;
		} else {
			failed = count;
		}
	}
	if (passed === undefined && failed === undefined) return undefined;
	return { passed, failed };
}

/**
 * Extract `41 passed` / `2 failed` / `41 passed · 2 failed` from a test
 * runner's summary region (bounded to the tail of the output). Returns
 * undefined when the output carries no recognizable summary.
 */
export function summarizeTestOutput(output: string): { text: string; failed: number } | undefined {
	const lines = output.split("\n");
	const tailStart = Math.max(0, lines.length - 60);
	const candidates: Array<{ passed?: number; failed?: number }> = [];
	for (let i = lines.length - 1; i >= tailStart; i--) {
		const counts = parseTestCounts(lines[i]);
		if (counts) candidates.push(counts);
	}
	// Prefer a summary containing a passed count; fall back to a failed-only
	// summary ("Tests  2 failed" with zero passed).
	const summary = candidates.find((c) => c.passed !== undefined) ?? candidates.find((c) => c.failed !== undefined);
	if (!summary) return undefined;
	const parts: string[] = [];
	const failed = summary.failed ?? 0;
	if (summary.passed !== undefined) parts.push(`${summary.passed} passed`);
	if (failed > 0) parts.push(`${failed} failed`);
	if (parts.length === 0 && summary.failed !== undefined) parts.push(`${summary.failed} failed`);
	return { text: parts.join(" · "), failed };
}

// =========================================================================
// Bash failures: concise headline + bounded relevant tail
// =========================================================================

const BASH_EXIT_STATUS_RE = /^Command exited with code (\d+)$/;
const BASH_TIMEOUT_STATUS_RE = /^Command timed out after (\d+) seconds$/;
/** Trailing tool-inserted truncation footers (presentation noise in compact rows). */
const BASH_FOOTER_RE = /^\[(?:Showing|Full output)/;
/** Empty-output placeholder inserted by the tool (not real content). */
const BASH_EMPTY_OUTPUT = "(no output)";

export interface BashErrorInfo {
	/** Short failure headline for the row excerpt: "exit 2", "timed out", "aborted". */
	headline: string;
	/** Bounded relevant tail (last non-empty lines of output). */
	tail: string[];
	/** Number of earlier output lines dropped from the tail. */
	skipped: number;
}

/**
 * Split a failed bash result into a concise headline plus a bounded tail.
 * The tool appends its status line ("Command exited with code N", timeout,
 * aborted) after the output; truncation footers are dropped here.
 */
export function summarizeBashError(outputText: string, maxTailLines = 6): BashErrorInfo {
	const rawLines = outputText.split("\n");
	let headline = "failed";
	const contentLines: string[] = [];
	for (let i = 0; i < rawLines.length; i++) {
		const line = rawLines[i].trim();
		if (line === "") continue;
		if (BASH_FOOTER_RE.test(line)) continue;
		if (line === BASH_EMPTY_OUTPUT) continue;
		if (line === "Command aborted") {
			headline = "aborted";
			continue;
		}
		const timeoutMatch = line.match(BASH_TIMEOUT_STATUS_RE);
		if (timeoutMatch) {
			headline = `timed out (${timeoutMatch[1]}s)`;
			continue;
		}
		const exitMatch = line.match(BASH_EXIT_STATUS_RE);
		if (exitMatch) {
			headline = `exit ${exitMatch[1]}`;
			continue;
		}
		contentLines.push(line);
	}
	const tail = contentLines.slice(-maxTailLines);
	const skipped = Math.max(0, contentLines.length - tail.length);
	return { headline, tail, skipped };
}

// =========================================================================
// List-like output summaries (ls / find / grep entry counts)
// =========================================================================

/**
 * Count the meaningful rows of a list-like tool output. Empty lines and
 * trailing tool notices ("[Truncated: ...]") are not entries.
 */
export function countOutputRows(output: string): number {
	let count = 0;
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("[")) continue;
		count++;
	}
	return count;
}

// =========================================================================
// Edit deltas
// =========================================================================

export interface DiffDelta {
	added: number;
	removed: number;
}

/** Count +/- lines of a unified diff, ignoring headers and hunk markers. */
export function diffDelta(diff: string): DiffDelta {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** Style a delta as excerpt parts: "+42", "-11". Empty deltas yield no parts. */
export function formatDiffDeltaParts(theme: Theme, delta: DiffDelta): string[] {
	const parts: string[] = [];
	if (delta.added > 0) parts.push(theme.fg("success", `+${delta.added}`));
	if (delta.removed > 0) parts.push(theme.fg("error", `-${delta.removed}`));
	return parts;
}

// =========================================================================
// Miscellaneous compact helpers
// =========================================================================

/** First non-empty line of an output, truncated (fallback tool rows). */
export function firstOutputLine(output: string, maxWidth = 60): string | undefined {
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return truncateToWidth(trimmed, maxWidth, "...", false);
	}
	return undefined;
}

/** Compact byte count: "1.2KB", "14.5MB". */
export function formatCompactBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Bounded truncation/limit warnings for list-like tools (ls/find/grep),
 * rendered as a single compact "[Truncated: ...]" line.
 */
export function toolLimitWarnings(details: {
	entryLimitReached?: unknown;
	resultLimitReached?: unknown;
	matchLimitReached?: unknown;
	truncation?: { truncated?: boolean; maxBytes?: number } | undefined;
}): string[] {
	const warnings: string[] = [];
	if (details.entryLimitReached) warnings.push("entries limit");
	if (details.resultLimitReached) warnings.push("results limit");
	if (details.matchLimitReached) warnings.push("matches limit");
	if (details.truncation?.truncated) {
		warnings.push(`${formatSize(details.truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
	}
	return warnings;
}
