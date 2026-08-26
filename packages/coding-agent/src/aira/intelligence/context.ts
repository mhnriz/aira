/**
 * Aira intelligence — compact context selection.
 *
 * Context is a budget. This module builds the single ambient message Aira
 * injects at prompt time: the funnel is
 *
 * ```text
 * user objective → project profile → likely files → relationships →
 * diagnostics → compact evidence → model
 * ```
 *
 * Everything is optional, capped, and freshness-aware:
 * - the project orientation line injects once per session (coordinator gate);
 * - likely files come from the lexical repository index (no LSP, no disk
 *   reads at prompt time);
 * - diagnostics summaries exclude stale findings;
 * - a hard character cap truncates from the lowest-priority section;
 * - identical content is never re-injected (coordinator hashes it).
 *
 * Mode emphasis: PLAN favors orientation + likely files (read-only planning);
 * REVIEW favors changed files, diagnostics, and impact; BUILD gets the full
 * funnel.
 */
import type { AiraMode } from "../state.ts";
import type { IntelligenceActivation } from "./activation.ts";
import type { AiraFindingsStore } from "./findings.ts";
import { summarizeFindingsForPaths } from "./findings.ts";
import type { RepositoryProvider } from "./providers/repository/index.ts";

export interface AiraIntelligenceContextLimits {
	/** Hard cap for the whole message (chars). */
	maxTotalChars?: number;
	/** Likely-file leads per prompt. */
	maxLikelyFiles?: number;
	/** Changed-file entries. */
	maxChangedFiles?: number;
	/** Diagnostic summary paths. */
	maxDiagnosticPaths?: number;
	/** Diagnostic lines per path. */
	maxDiagnosticLinesPerPath?: number;
	/** Impact (imported-by) entries per changed file. */
	maxImpactPerFile?: number;
}

const DEFAULT_LIMITS: Required<AiraIntelligenceContextLimits> = {
	maxTotalChars: 1600,
	maxLikelyFiles: 4,
	maxChangedFiles: 6,
	maxDiagnosticPaths: 5,
	maxDiagnosticLinesPerPath: 2,
	maxImpactPerFile: 3,
};

export interface AiraIntelligenceContextInput {
	prompt: string;
	mode: AiraMode;
	activation: IntelligenceActivation;
	projectRootName: string | undefined;
	repository: RepositoryProvider | undefined;
	findings: AiraFindingsStore;
	/** True once the session has already seen the orientation line. */
	oriented: boolean;
	limits?: AiraIntelligenceContextLimits;
}

export interface AiraIntelligenceContextResult {
	/** The message content, or undefined when nothing useful is available. */
	content: string | undefined;
	/** True when a previously-relevant change happened (diagnostics/working set moved). */
	hasSignal: boolean;
}

const SECTION_BUILD = ["diagnostics", "likelyFiles", "changedFiles", "impact", "orientation", "availability"] as const;
const SECTION_PLAN = ["likelyFiles", "orientation", "availability", "diagnostics"] as const;
const SECTION_REVIEW = ["diagnostics", "changedFiles", "impact", "orientation", "availability"] as const;

function sectionOrderForMode(mode: AiraMode): readonly string[] {
	if (mode === "plan") {
		return SECTION_PLAN;
	}
	if (mode === "review") {
		return SECTION_REVIEW;
	}
	return SECTION_BUILD;
}

/** Build the ambient context message for a prompt. */
export function buildIntelligenceContext(input: AiraIntelligenceContextInput): AiraIntelligenceContextResult {
	const limits: Required<AiraIntelligenceContextLimits> = { ...DEFAULT_LIMITS, ...input.limits };
	const sectionOrder: readonly string[] = sectionOrderForMode(input.mode);

	const sections = new Map<string, string>();
	let hasSignal = false;

	const orientation = buildOrientationSection(input.activation, input.projectRootName);
	if (orientation && !input.oriented) {
		sections.set("orientation", orientation);
	}

	const availability = buildAvailabilitySection(input.activation);
	if (availability && !input.oriented) {
		sections.set("availability", availability);
	}

	const likelyFiles = buildLikelyFilesSection(input.prompt, input.repository, limits);
	if (likelyFiles) {
		sections.set("likelyFiles", likelyFiles);
		hasSignal = true;
	}

	const workingSet = input.repository ? workingSetPaths(input.repository) : [];
	const changedFiles = buildChangedFilesSection(workingSet, input.repository, limits);
	if (changedFiles) {
		sections.set("changedFiles", changedFiles);
		hasSignal = true;
	}

	const diagnostics = buildDiagnosticsSection(workingSet, input.findings, limits);
	if (diagnostics) {
		sections.set("diagnostics", diagnostics);
		hasSignal = true;
	}

	const impact = buildImpactSection(workingSet, input.repository, limits);
	if (impact) {
		sections.set("impact", impact);
		hasSignal = true;
	}

	// Assemble in priority order under the total cap.
	const lines: string[] = ["Aira intelligence (use silently as evidence; do not repeat it back):"];
	let budget = limits.maxTotalChars;
	for (const name of sectionOrder) {
		const section = sections.get(name);
		if (!section) {
			continue;
		}
		if (budget <= 0) {
			break;
		}
		const block = `${section}\n`;
		if (block.length > budget) {
			const truncated = `${section.slice(0, Math.max(0, budget - 60))}\n[context truncated]`;
			lines.push(truncated);
			break;
		}
		lines.push(section);
		budget -= block.length;
	}

	if (lines.length === 1) {
		// Nothing beyond the header: don't inject an empty message.
		return { content: undefined, hasSignal };
	}
	return { content: lines.join("\n"), hasSignal };
}

function buildOrientationSection(
	activation: IntelligenceActivation,
	projectRootName: string | undefined,
): string | undefined {
	if (!activation.active || !projectRootName) {
		return undefined;
	}
	const languages = activation.languages.length > 0 ? activation.languages.join(", ") : "unknown";
	return `# Project: ${projectRootName} — languages: ${languages} (confidence ${activation.confidence})`;
}

function buildAvailabilitySection(activation: IntelligenceActivation): string | undefined {
	if (!activation.active || activation.liveCodeCandidates.length === 0) {
		return undefined;
	}
	return `Live-code intelligence available for: ${activation.liveCodeCandidates.join(", ")} (language servers spawn on first use; missing servers degrade to plain search).`;
}

function buildLikelyFilesSection(
	prompt: string,
	repository: RepositoryProvider | undefined,
	limits: Required<AiraIntelligenceContextLimits>,
): string | undefined {
	if (!repository) {
		return undefined;
	}
	const hits = repository.discover(prompt, { limit: limits.maxLikelyFiles });
	if (hits.length === 0) {
		return undefined;
	}
	const lines = ["Likely files for this objective:"];
	for (const hit of hits) {
		const symbols = hit.symbols.length > 0 ? ` (symbols: ${hit.symbols.join(", ")})` : "";
		lines.push(`- ${hit.path}${symbols}`);
	}
	return lines.join("\n");
}

function workingSetPaths(repository: RepositoryProvider): string[] {
	// Git/session changes first, then session edits; all absolute.
	return repository.changedAbsolutePaths();
}

function buildChangedFilesSection(
	changed: string[],
	repository: RepositoryProvider | undefined,
	limits: Required<AiraIntelligenceContextLimits>,
): string | undefined {
	if (changed.length === 0 || !repository) {
		return undefined;
	}
	const lines = [`Changed files (${changed.length}):`];
	for (const path of changed.slice(0, limits.maxChangedFiles)) {
		lines.push(`- ${relativeDisplay(repository, path)}`);
	}
	return lines.join("\n");
}

function buildDiagnosticsSection(
	changed: string[],
	findings: AiraFindingsStore,
	limits: Required<AiraIntelligenceContextLimits>,
): string | undefined {
	const paths = changed.length > 0 ? changed : findings.paths;
	if (paths.length === 0) {
		return undefined;
	}
	const counts = findings.counts();
	if (counts.errors + counts.warnings === 0) {
		return undefined;
	}
	const summary = summarizeFindingsForPaths(findings, paths, {
		maxPaths: limits.maxDiagnosticPaths,
		maxPerPath: limits.maxDiagnosticLinesPerPath,
	});
	if (!summary) {
		return undefined;
	}
	return `Diagnostics: ${counts.errors} error(s), ${counts.warnings} warning(s)\n${summary}`;
}

function buildImpactSection(
	changed: string[],
	repository: RepositoryProvider | undefined,
	limits: Required<AiraIntelligenceContextLimits>,
): string | undefined {
	if (changed.length === 0 || !repository) {
		return undefined;
	}
	const lines: string[] = [];
	for (const path of changed.slice(0, limits.maxChangedFiles)) {
		const importers = repository.importedBy(path);
		if (importers.length === 0) {
			continue;
		}
		const top = importers.slice(0, limits.maxImpactPerFile).map((p) => relativeDisplay(repository, p));
		lines.push(`- ${relativeDisplay(repository, path)} is imported by ${importers.length}: ${top.join(", ")}`);
	}
	if (lines.length === 0) {
		return undefined;
	}
	return ["Impact (imported-by):", ...lines].join("\n");
}

function relativeDisplay(repository: RepositoryProvider, absolutePath: string): string {
	const file = repository.fileFor(absolutePath);
	if (file) {
		return file.path;
	}
	return absolutePath;
}
