/**
 * Aira verification — evidence aggregation.
 *
 * Builds the bounded, provider-independent evidence envelope the verifier
 * consumes. Inputs are canonical Aira snapshots (`state.intelligence`,
 * `state.execution`, `state.browser`) plus the repository change seam and
 * run-tracked edit evidence — never raw LSP/CDP/ChildProcess internals.
 *
 * The envelope deliberately excludes the implementation conversation: the
 * verifier receives the user objective, the change summary, diagnostics,
 * execution results, browser evidence, and explicit missing-evidence /
 * limitation markers. This is the documented independence boundary (ADR-026).
 *
 * Budgets: compact ≤ 6000 chars, balanced ≤ 10000, expanded ≤ 16000 (envelope
 * text). All sections carry truncation markers; secrets are redacted.
 */
import type { AiraBrowserStatus } from "../browser/status.ts";
import type { AiraExecutionStatus } from "../execution/status.ts";
import type { AiraIntelligenceStatus } from "../intelligence/status.ts";
import type { AiraMode } from "../state.ts";
import type { AiraWorkspaceOwnershipObservation } from "../workspace/ownership.ts";
import type { AiraChangeFile } from "./eligibility.ts";
import type { AiraVerificationContextBudget } from "./settings.ts";

export const VERIFICATION_BUDGET_CHARS: Record<AiraVerificationContextBudget, number> = {
	compact: 6_000,
	balanced: 10_000,
	expanded: 16_000,
};

export const MAX_OBJECTIVE_CHARS = 4_000;
export const MAX_CHANGE_FILES_IN_SUMMARY = 40;
export const MAX_DIAGNOSTIC_FINDINGS = 6;
export const MAX_EXECUTION_RESULTS = 6;
export const MAX_BROWSER_FINDINGS = 3;

export interface VerificationEvidenceSource {
	objective: string;
	mode: AiraMode;
	/** Per-file change stats from the repository seam (may be undefined). */
	changeFiles: AiraChangeFile[] | undefined;
	/** Run-tracked edited paths (fallback when git is unavailable). */
	editedPaths: string[];
	/** Canonical intelligence snapshot (may be undefined before first publish). */
	intelligence: AiraIntelligenceStatus | undefined;
	/** Canonical execution snapshot. */
	execution: AiraExecutionStatus | undefined;
	/** Canonical browser snapshot. */
	browser: AiraBrowserStatus | undefined;
	/** Host-side baseline/ownership classification for Goal verification. */
	workspace?: AiraWorkspaceOwnershipObservation;
	contextBudget: AiraVerificationContextBudget;
}

export interface VerificationEvidenceBundle {
	/** Bounded objective the requirements derive from. */
	objective: string;
	mode: AiraMode;
	/** Bounded per-category rendered evidence sections. */
	sections: Array<{ category: string; label: string; text: string }>;
	/** Explicit missing-evidence lines (never silently folded away). */
	missingEvidence: string[];
	/** Known limitations of the evidence run. */
	limitations: string[];
	/** The final bounded envelope text (the verifier model input). */
	text: string;
}

/** Build the evidence bundle from canonical snapshots (deterministic, bounded). */
export function buildVerificationEvidence(source: VerificationEvidenceSource): VerificationEvidenceBundle {
	const missingEvidence: string[] = [];
	const limitations: string[] = [];
	const changeSection = renderChangeSection(source, missingEvidence, limitations);
	const diagnosticsSection = renderDiagnosticsSection(source.intelligence, missingEvidence, limitations);
	const executionSection = renderExecutionSection(source.execution, missingEvidence);
	const browserSection = renderBrowserSection(source.browser, missingEvidence, limitations);
	const workspaceSection = renderWorkspaceSection(source.workspace);
	const sections: VerificationEvidenceBundle["sections"] = [
		changeSection,
		diagnosticsSection,
		executionSection,
		browserSection,
		workspaceSection,
	].filter((section) => section.text.length > 0);

	const budget = VERIFICATION_BUDGET_CHARS[source.contextBudget];
	const prefix = [
		`OBJECTIVE`,
		`${boundedText(source.objective, MAX_OBJECTIVE_CHARS) || "(no objective captured)"}`,
		``,
		`MODE`,
		source.mode.toUpperCase(),
		``,
	].join("\n");
	const missingText =
		missingEvidence.length > 0 ? `\nMISSING EVIDENCE\n${missingEvidence.map((m) => `- ${m}`).join("\n")}\n` : "";
	const limitationText =
		limitations.length > 0 ? `\nLIMITATIONS\n${limitations.map((m) => `- ${m}`).join("\n")}\n` : "";
	const sectionsText = sections.map((section) => `${section.label}\n${section.text}`).join("\n\n");
	const text = trimToBudget([prefix, sectionsText, missingText, limitationText].filter(Boolean).join("\n\n"), budget);
	return {
		objective: boundedText(source.objective, MAX_OBJECTIVE_CHARS),
		mode: source.mode,
		sections,
		missingEvidence: [...new Set(missingEvidence)].slice(0, 8),
		limitations: [...new Set(limitations)].slice(0, 6),
		text,
	};
}

function renderWorkspaceSection(workspace: AiraWorkspaceOwnershipObservation | undefined): {
	category: "repository";
	label: string;
	text: string;
} {
	if (!workspace) {
		return { category: "repository", label: "WORKSPACE OWNERSHIP", text: "(not tracked)" };
	}
	const { counts } = workspace;
	const lines = [
		`baseline/pre-existing: ${counts.baseline}`,
		`Goal-owned: ${counts.owned}`,
		`protected: ${counts.protected}`,
		`unowned concurrent: ${counts.unowned}`,
	];
	if (counts.protected > 0) lines.push("Protected workspace changes are excluded from destructive repair.");
	if (counts.unowned > 0) lines.push("Unowned concurrent changes are not attributed to the Goal.");
	return { category: "repository", label: "WORKSPACE OWNERSHIP", text: lines.join(" · ") };
}

function renderChangeSection(
	source: VerificationEvidenceSource,
	missing: string[],
	limitations: string[],
): { category: "repository"; label: string; text: string } {
	const files = source.changeFiles;
	const entries =
		files && files.length > 0
			? files
			: source.editedPaths.map((p) => ({ path: p, status: "modified" as const, added: 0, deleted: 0 }));
	if (entries.length === 0) {
		missing.push("No changed-file summary available.");
		return { category: "repository", label: "CHANGED FILES", text: "(none available)" };
	}
	if (!files || files.length === 0) {
		limitations.push("Git change stats unavailable; only session-tracked edited paths are listed.");
	}
	const shown = entries.slice(0, MAX_CHANGE_FILES_IN_SUMMARY);
	let totalAdded = 0;
	let totalDeleted = 0;
	for (const file of files ?? []) {
		totalAdded += file.added;
		totalDeleted += file.deleted;
	}
	const lines = shown.map((file) => {
		const delta =
			files === undefined || (file.added === 0 && file.deleted === 0) ? "" : ` (+${file.added} -${file.deleted})`;
		const status = (file as { status?: string }).status;
		return `- ${status ? `${status} ` : ""}${file.path}${delta}`;
	});
	lines.push(entries.length > shown.length ? `… and ${entries.length - shown.length} more` : "");
	if (files && files.length > 0) {
		lines.push(`summary: ${files.length} file(s) · +${totalAdded} −${totalDeleted}`);
	}
	return { category: "repository", label: "CHANGED FILES", text: lines.filter(Boolean).join("\n") };
}

function renderDiagnosticsSection(
	intelligence: AiraIntelligenceStatus | undefined,
	missing: string[],
	limitations: string[],
): { category: "language"; label: string; text: string } {
	if (!intelligence || !intelligence.active) {
		missing.push("Language diagnostics unavailable (intelligence inactive).");
		return { category: "language", label: "DIAGNOSTICS", text: "(unavailable)" };
	}
	const live = intelligence.liveCode.status;
	const findings = intelligence.findings;
	const stale = findings.stale > 0 ? ` (${findings.stale} stale findings not counted)` : "";
	const lines = [
		`live-code: ${live} · findings: ${findings.errors} error(s), ${findings.warnings} warning(s)${stale}`,
	];
	if (findings.errors > 0 || findings.warnings > 0) {
		lines.push("Blocking errors must be explained by the change or mapped to unmet/unverifiable requirements.");
	}
	if (findings.errors === 0 && findings.warnings === 0 && live !== "ready") {
		limitations.push("No language-server findings; live-code server status is not ready.");
	}
	return { category: "language", label: "DIAGNOSTICS", text: lines.join("\n") };
}

function renderExecutionSection(
	execution: AiraExecutionStatus | undefined,
	missing: string[],
): { category: "execution"; label: string; text: string } {
	if (!execution || execution.recentResults.length === 0) {
		missing.push("No test/build execution evidence in this session.");
		return { category: "execution", label: "EXECUTION", text: "(nothing run)" };
	}
	const results = execution.recentResults.slice(-MAX_EXECUTION_RESULTS).reverse();
	const lines = results.map((result) => {
		const tail = result.reason ? ` — ${boundedText(result.reason, 200)}` : "";
		return `- ${result.ok ? "ok" : "FAIL"} · ${result.command} (exit ${result.exitCode ?? "n/a"}) · ${result.durationMs}ms${tail}`;
	});
	if (execution.recentResults.length > results.length) {
		lines.push(`… ${execution.recentResults.length - results.length} older result(s) omitted`);
	}
	return { category: "execution", label: "EXECUTION", text: lines.join("\n") };
}

function renderBrowserSection(
	browser: AiraBrowserStatus | undefined,
	missing: string[],
	limitations: string[],
): { category: "browser"; label: string; text: string } {
	if (!browser) {
		missing.push("Browser evidence unavailable (no browser runtime snapshot).");
		return { category: "browser", label: "BROWSER", text: "(unavailable)" };
	}
	if (browser.status === "unavailable") {
		missing.push(`Browser evidence unavailable: ${browser.reason ?? "no browser executable"}.`);
		return { category: "browser", label: "BROWSER", text: "(unavailable)" };
	}
	const lines: string[] = [];
	const check = browser.verification;
	if (check.status !== "none") {
		lines.push(`check: ${check.status}${check.finding ? ` · ${check.finding.message}` : ""}`);
	} else {
		missing.push("Browser check not run (no automatic/explicit browser verification evidence).");
	}
	if (browser.console.total > 0 || browser.network.failures > 0) {
		lines.push(
			`console: ${browser.console.errors}E ${browser.console.warnings}W (${browser.console.total}) · network: ${browser.network.failures} failed`,
		);
		if (browser.console.topFinding) {
			lines.push(`top console finding: ${boundedText(browser.console.topFinding.message, 300)}`);
		}
		if (browser.network.topFinding) {
			lines.push(`top network finding: ${boundedText(browser.network.topFinding.message, 300)}`);
		}
	} else if (check.status === "none") {
		limitations.push("No console/network evidence captured (browser never observed the change).");
	}
	if (browser.observation.summary) {
		lines.push(`observation: ${boundedText(browser.observation.summary, 300)}`);
	}
	return { category: "browser", label: "BROWSER", text: lines.length > 0 ? lines.join("\n") : "(idle)" };
}

/** Trim multi-section text to the budget, keeping a truncation marker. */
export function trimToBudget(text: string, budget: number): string {
	if (text.length <= budget) {
		return text;
	}
	const marker = "\n[TRUNCATED]";
	if (budget <= marker.length) {
		return marker.slice(0, budget);
	}
	return `${text.slice(0, budget - marker.length)}${marker}`;
}

/** Bound a string; secrets redacted first, truncation marked. */
export function boundedText(value: string, max: number): string {
	const redacted = redactVerificationSecrets(value);
	if (redacted.length <= max) {
		return redacted;
	}
	const marker = "…[TRUNCATED]";
	if (max <= marker.length) {
		return marker.slice(0, max);
	}
	return `${redacted.slice(0, max - marker.length)}${marker}`;
}

/** Redact common secret shapes from evidence before it reaches the verifier. */
export function redactVerificationSecrets(value: string): string {
	return value
		.replace(
			/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi,
			"[REDACTED]",
		)
		.replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*$/gi, "[REDACTED]")
		.replace(
			/(^|[\s,{;:])(["']?authorization["']?\s*[:=]\s*["']?)(?:basic|bearer)\s+[^\s"',;}]+["']?/gim,
			"$1$2[REDACTED]",
		)
		.replace(
			/(^|[\s,{;:])(["']?(?:set[-_ ]?cookie|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n}]*)/gim,
			"$1$2[REDACTED]",
		)
		.replace(
			/(^|[\s,{;:])(["']?(?:(?:[a-z0-9]+[-_ ])*(?:api[-_ ]?key|password|passwd|pwd|secret|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|token|jwt|connection[-_ ]?string)|authorization|cookie|set[-_ ]?cookie)["']?\s*[:=]\s*)(?!["']?\[REDACTED\]["']?)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gim,
			"$1$2[REDACTED]",
		)
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@/\s]+@/gi, "$1[REDACTED]@")
		.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
		.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, "[REDACTED]");
}
