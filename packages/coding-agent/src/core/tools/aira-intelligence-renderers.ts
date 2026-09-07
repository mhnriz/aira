/**
 * Aira conversation — human-facing rendering for Aira-native intelligence tools.
 *
 * Presentation-only adapter over the four model-facing intelligence tools
 * (`aira_symbol_search`, `aira_module_report`, `aira_semantic_navigation`,
 * `aira_diagnostics`). It attaches friendly display labels and compact
 * `renderCall`/`renderResult` renderers to the session tool definitions.
 *
 * The model contract is untouched: tool names, descriptions, parameter
 * schemas, and the structured `content`/`details` results are kept
 * byte-identical, so the model keeps receiving the full raw JSON payload.
 * Only the conversation text changes. Tools without a dedicated renderer pass
 * through unchanged and keep the generic tool-result presentation.
 *
 * Rendering follows the Workbench compact language: one status row
 * (`✓ Diagnostics   path   1 error`) followed by bounded, indented detail
 * lines. Expanded view relaxes the bounds and keeps the raw payload visible
 * for inspection. All truncation is display-only and carries an explicit
 * "more" marker; the underlying results are never mutated.
 */
import { Text } from "@earendil-works/pi-tui";
import type {
	AiraDiagnosticsResult,
	AiraModuleReportResult,
	AiraSemanticNavigationResult,
	AiraSymbolSearchResult,
} from "../../aira/intelligence/coordinator.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { buildCompactRow, type CompactStatus } from "./compact.ts";

// ============================================================================
// Display labels (presentation-only; internal tool names are unchanged)
// ============================================================================

const INTELLIGENCE_TOOL_LABELS: Record<string, string> = {
	aira_symbol_search: "Symbol Search",
	aira_module_report: "Module Report",
	aira_semantic_navigation: "Code Navigation",
	aira_diagnostics: "Diagnostics",
};

/** Human-facing label for an Aira intelligence tool, when one exists. */
export function airaToolDisplayLabel(toolName: string): string | undefined {
	return INTELLIGENCE_TOOL_LABELS[toolName];
}

// ============================================================================
// Display bounds (compact view is tight; expanded relaxes but stays bounded)
// ============================================================================

interface DisplayCaps {
	compact: number;
	expanded: number;
}

const CAPS = {
	diagnosticsFiles: { compact: 4, expanded: 10 },
	diagnosticsPerFile: { compact: 3, expanded: 20 },
	searchPaths: { compact: 4, expanded: 12 },
	searchSymbolsPerPath: { compact: 3, expanded: 8 },
	reportSymbols: { compact: 6, expanded: 15 },
	reportRelations: { compact: 3, expanded: 8 },
	navLocations: { compact: 5, expanded: 15 },
	navCandidates: { compact: 3, expanded: 8 },
} satisfies Record<string, DisplayCaps>;

function capFor(which: keyof typeof CAPS, expanded: boolean): number {
	return expanded ? CAPS[which].expanded : CAPS[which].compact;
}

// ============================================================================
// Shared line helpers
// ============================================================================

const SUB_INDENT = "  ";
const DETAIL_INDENT = "    ";

function plural(count: number, singular: string, pluralForm?: string): string {
	return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

/** Muted "… N more" marker for a capped list. */
function moreLine(theme: Theme, count: number): string {
	return `${SUB_INDENT}${theme.fg("muted", `… ${count} more`)}`;
}

function sectionLine(theme: Theme, title: string): string {
	return `${SUB_INDENT}${theme.fg("muted", title)}`;
}

function pathLine(theme: Theme, path: string, indent = SUB_INDENT): string {
	return `${indent}${theme.fg("accent", path)}`;
}

function valueLine(theme: Theme, value: string, indent = DETAIL_INDENT): string {
	return `${indent}${theme.fg("toolOutput", value)}`;
}

function reasonLine(theme: Theme, reason: string | undefined, indent = SUB_INDENT): string {
	if (!reason) {
		return "";
	}
	const lines = reason.split("\n");
	return `${indent}${lines.map((line) => theme.fg("muted", line)).join(`\n${indent}`)}`;
}

/** Bounded sub-list with an explicit overflow marker. */
function boundedLines(
	theme: Theme,
	entries: string[],
	max: number,
	entryRenderer: (entry: string) => string,
): string[] {
	const shown = entries.slice(0, max);
	const lines = shown.map(entryRenderer);
	const remaining = entries.length - shown.length;
	if (remaining > 0) {
		lines.push(moreLine(theme, remaining));
	}
	return lines;
}

/** Generic fallback when the structured payload does not match expectations. */
function fallbackResultText(theme: Theme, label: string, output: string, expanded: boolean): string {
	const row = buildCompactRow(theme, { status: "success", label, targetText: "" });
	const lines = output.split("\n").filter((line) => line.trim().length > 0);
	const shown = expanded ? lines : lines.slice(0, 10);
	if (shown.length === 0) {
		return row;
	}
	const remaining = lines.length - shown.length;
	const body = shown.map((line) => valueLine(theme, line)).join("\n");
	return `${row}\n${body}${remaining > 0 ? `\n${moreLine(theme, remaining)}` : ""}`;
}

// ============================================================================
// Diagnostics renderer
// ============================================================================

const DIAGNOSTIC_SEVERITY_LABEL: Record<string, string> = {
	error: "error",
	warning: "warning",
	information: "information",
	hint: "hint",
};

function severityColor(theme: Theme, severity: string, text: string): string {
	if (severity === "error") return theme.fg("error", text);
	if (severity === "warning") return theme.fg("warning", text);
	return theme.fg("muted", text);
}

/** One diagnostic entry: `CODE · line:char` headline + indented message. */
function diagnosticLines(theme: Theme, entry: unknown): string[] {
	const record = asRecord(entry);
	if (!record) {
		return [];
	}
	const severity = typeof record.severity === "string" ? record.severity : "information";
	const code =
		record.code !== undefined && record.code !== null ? String(record.code) : DIAGNOSTIC_SEVERITY_LABEL[severity];
	const line = typeof record.line === "number" ? record.line : undefined;
	const character = typeof record.character === "number" ? record.character : undefined;
	const position = line !== undefined ? `${line}${character !== undefined ? `:${character}` : ""}` : undefined;
	const message = typeof record.message === "string" ? record.message : "";
	const lines = [
		`${DETAIL_INDENT}${severityColor(theme, severity, code)}${position !== undefined ? `${theme.fg("muted", " · ")}${theme.fg("toolOutput", position)}` : ""}`,
	];
	for (const messageLine of message.split("\n")) {
		if (messageLine.trim().length > 0) {
			lines.push(valueLine(theme, messageLine));
		}
	}
	return lines;
}

function diagnosticsTotalsParts(theme: Theme, totals: unknown): string[] {
	const record = asRecord(totals);
	if (!record) {
		return [];
	}
	const parts: string[] = [];
	const errors = typeof record.errors === "number" ? record.errors : 0;
	const warnings = typeof record.warnings === "number" ? record.warnings : 0;
	const other = typeof record.other === "number" ? record.other : 0;
	if (errors > 0) parts.push(theme.fg("error", plural(errors, "error")));
	if (warnings > 0) parts.push(theme.fg("warning", plural(warnings, "warning")));
	if (other > 0) parts.push(theme.fg("muted", plural(other, "finding")));
	return parts;
}

const FILE_STATUS_LABEL: Record<string, string> = {
	"no-publish": "no publish",
	"server-unavailable": "server unavailable",
	"unsupported-language": "unsupported language",
	unreadable: "unreadable",
	cancelled: "cancelled",
	degraded: "degraded",
};

function renderDiagnostics(theme: Theme, details: AiraDiagnosticsResult, expanded: boolean): string {
	const files = Array.isArray(details.files) ? details.files : [];
	const invalidFiles = files.filter((file) => file.status === "invalid-path");
	const rowStatus: CompactStatus = details.status === "degraded" || invalidFiles.length > 0 ? "error" : "success";
	const unavailableReason =
		details.status === "unavailable" || details.status === "cancelled" || details.status === "degraded"
			? details.reason
			: undefined;
	const lines: string[] = [];

	const singleFile = files.length === 1 ? files[0] : undefined;
	const totals = asRecord(details.totals) ?? {};
	const hasIssues =
		(typeof totals.errors === "number" ? totals.errors : 0) +
			(typeof totals.warnings === "number" ? totals.warnings : 0) +
			(typeof totals.other === "number" ? totals.other : 0) >
		0;

	if (details.status === "no-targets") {
		lines.push(
			buildCompactRow(theme, {
				status: "success",
				label: "Diagnostics",
				targetText: "",
				excerpt: ["no changed files"],
			}),
		);
		const reason = reasonLine(theme, details.reason ?? unavailableReason);
		if (reason) lines.push(reason);
		return lines.join("\n");
	}
	if (details.status === "unavailable" || details.status === "cancelled") {
		lines.push(
			buildCompactRow(theme, { status: "success", label: "Diagnostics", targetText: "", excerpt: [details.status] }),
		);
		const reason = reasonLine(theme, details.reason ?? unavailableReason);
		if (reason) lines.push(reason);
		return lines.join("\n");
	}
	if (details.status === "degraded") {
		lines.push(
			buildCompactRow(theme, { status: "error", label: "Diagnostics", targetText: "", excerpt: ["degraded"] }),
		);
		const reason = reasonLine(theme, details.reason);
		if (reason) lines.push(reason);
		return lines.join("\n");
	}

	if (singleFile) {
		const file = singleFile;
		const targetText = typeof file.path === "string" ? file.path : "";
		if (file.status === "invalid-path") {
			lines.push(
				buildCompactRow(theme, {
					status: "error",
					label: "Diagnostics",
					targetText,
					targetIsPath: true,
					excerpt: ["invalid path"],
				}),
			);
			lines.push(`${SUB_INDENT}${theme.fg("error", `invalid path · ${file.reason ?? "path is not resolvable"}`)}`);
			return lines.join("\n");
		}
		if (file.status === "ready") {
			const excerpt = hasIssues ? diagnosticsTotalsParts(theme, totals) : [theme.fg("success", "no issues")];
			lines.push(
				buildCompactRow(theme, {
					status: "success",
					label: "Diagnostics",
					targetText,
					targetIsPath: true,
					excerpt,
				}),
			);
			if (hasIssues) {
				const maxPerFile = capFor("diagnosticsPerFile", expanded);
				const diagnostics = Array.isArray(file.diagnostics) ? file.diagnostics : [];
				for (const entry of diagnostics.slice(0, maxPerFile)) {
					lines.push(...diagnosticLines(theme, entry));
				}
				const remaining = diagnostics.length - maxPerFile;
				if (remaining > 0) {
					lines.push(`${DETAIL_INDENT}${theme.fg("muted", `… ${remaining} more`)}`);
				} else if (file.truncated || details.truncated) {
					lines.push(`${DETAIL_INDENT}${theme.fg("muted", "… more")}`);
				}
			}
			return lines.join("\n");
		}
		const label = FILE_STATUS_LABEL[file.status] ?? file.status;
		lines.push(
			buildCompactRow(theme, {
				status: "success",
				label: "Diagnostics",
				targetText,
				targetIsPath: true,
				excerpt: [label],
			}),
		);
		const reason = reasonLine(theme, file.reason);
		if (reason) lines.push(reason);
		return lines.join("\n");
	}

	// Multiple files: counts on the row, bounded per-file detail below.
	const excerpt: string[] = [theme.fg("muted", plural(files.length, "file"))];
	if (hasIssues) {
		excerpt.push(...diagnosticsTotalsParts(theme, totals));
	} else {
		excerpt.push(theme.fg("success", "no issues"));
	}
	lines.push(buildCompactRow(theme, { status: rowStatus, label: "Diagnostics", targetText: "", excerpt }));

	const maxFiles = capFor("diagnosticsFiles", expanded);
	const shownFiles = files.slice(0, maxFiles);
	for (const file of shownFiles) {
		const path = typeof file.path === "string" ? file.path : "";
		if (file.status === "invalid-path") {
			lines.push(`${SUB_INDENT}${theme.fg("error", `invalid path · ${file.reason ?? "path is not resolvable"}`)}`);
			continue;
		}
		if (file.status === "ready") {
			const diagnostics = Array.isArray(file.diagnostics) ? file.diagnostics : [];
			if (diagnostics.length === 0) {
				lines.push(pathLine(theme, path));
				continue;
			}
			lines.push(pathLine(theme, path));
			const maxPerFile = capFor("diagnosticsPerFile", expanded);
			for (const entry of diagnostics.slice(0, maxPerFile)) {
				lines.push(...diagnosticLines(theme, entry));
			}
			const remaining = diagnostics.length - maxPerFile;
			if (remaining > 0) {
				lines.push(`${DETAIL_INDENT}${theme.fg("muted", `… ${remaining} more`)}`);
			} else if (file.truncated) {
				lines.push(`${DETAIL_INDENT}${theme.fg("muted", "… more")}`);
			}
			continue;
		}
		const label = FILE_STATUS_LABEL[file.status] ?? file.status;
		lines.push(`${pathLine(theme, path)}${theme.fg("muted", ` · ${label}`)}`);
		const reason = reasonLine(theme, file.reason, DETAIL_INDENT);
		if (reason) lines.push(reason);
	}
	if (files.length > maxFiles) {
		lines.push(moreLine(theme, files.length - maxFiles));
	}
	if (details.truncated) {
		lines.push(`${SUB_INDENT}${theme.fg("warning", "[Truncated: more files]")}`);
	}
	return lines.join("\n");
}

// ============================================================================
// Symbol search renderer
// ============================================================================

function renderSymbolSearch(theme: Theme, details: AiraSymbolSearchResult, expanded: boolean): string {
	const lines: string[] = [];
	const query = details.query ?? "";
	if (details.status === "unavailable") {
		lines.push(
			buildCompactRow(theme, {
				status: "success",
				label: "Symbol Search",
				targetText: query,
				excerpt: ["unavailable"],
			}),
		);
		return lines.join("\n");
	}
	const results = Array.isArray(details.results) ? details.results : [];
	if (results.length === 0) {
		lines.push(
			buildCompactRow(theme, {
				status: "success",
				label: "Symbol Search",
				targetText: query,
				excerpt: ["no matches"],
			}),
		);
		return lines.join("\n");
	}
	const excerpt: string[] = [theme.fg("muted", plural(results.length, "match", "matches"))];
	if (details.truncated) {
		excerpt.push(theme.fg("warning", "truncated"));
	}
	lines.push(buildCompactRow(theme, { status: "success", label: "Symbol Search", targetText: query, excerpt }));

	const maxPaths = capFor("searchPaths", expanded);
	const shownPaths = results.slice(0, maxPaths);
	const maxSymbols = capFor("searchSymbolsPerPath", expanded);
	for (const hit of shownPaths) {
		const path = typeof hit.path === "string" ? hit.path : "";
		lines.push(pathLine(theme, path));
		const symbols = Array.isArray(hit.symbols) ? hit.symbols.filter((s): s is string => typeof s === "string") : [];
		const shownSymbols = symbols.slice(0, maxSymbols);
		for (const symbol of shownSymbols) {
			lines.push(valueLine(theme, symbol));
		}
		const remaining = symbols.length - shownSymbols.length;
		if (remaining > 0) {
			lines.push(`${DETAIL_INDENT}${theme.fg("muted", `… ${remaining} more`)}`);
		}
	}
	if (results.length > maxPaths) {
		lines.push(moreLine(theme, results.length - maxPaths));
	}
	if (details.truncated) {
		lines.push(`${SUB_INDENT}${theme.fg("warning", "[Truncated: more matches]")}`);
	}
	return lines.join("\n");
}

// ============================================================================
// Module report renderer
// ============================================================================

function relationLines(theme: Theme, entries: unknown, max: number): string[] {
	if (!Array.isArray(entries)) {
		return [];
	}
	const values = entries.filter((entry): entry is string => typeof entry === "string");
	return boundedLines(theme, values, max, (path) => pathLine(theme, path));
}

function renderModuleReport(theme: Theme, details: AiraModuleReportResult, expanded: boolean): string {
	const lines: string[] = [];
	const path = details.path ?? "";
	if (details.status === "invalid-path" || details.status === "not-found") {
		const statusLabel = details.status === "invalid-path" ? "invalid path" : "not found";
		lines.push(
			buildCompactRow(theme, {
				status: "error",
				label: "Module Report",
				targetText: path,
				targetIsPath: true,
				excerpt: [statusLabel],
			}),
		);
		if (details.status === "not-found") {
			lines.push(`${SUB_INDENT}${theme.fg("muted", "not in repository index")}`);
		} else {
			const reason = reasonLine(theme, details.reason);
			if (reason) lines.push(reason);
		}
		return lines.join("\n");
	}
	if (details.status === "unavailable") {
		lines.push(
			buildCompactRow(theme, {
				status: "success",
				label: "Module Report",
				targetText: path,
				targetIsPath: true,
				excerpt: ["unavailable"],
			}),
		);
		const reason = reasonLine(theme, details.reason);
		if (reason) lines.push(reason);
		return lines.join("\n");
	}

	const excerpt: string[] = [];
	const symbolCount = Array.isArray(details.symbols) ? details.symbols.length : 0;
	const importCount = Array.isArray(details.imports) ? details.imports.length : 0;
	const importerCount = Array.isArray(details.importedBy) ? details.importedBy.length : 0;
	const testCount = Array.isArray(details.counterparts) ? details.counterparts.length : 0;
	if (symbolCount > 0) excerpt.push(theme.fg("muted", plural(symbolCount, "symbol")));
	if (importCount > 0) excerpt.push(theme.fg("muted", plural(importCount, "import")));
	if (importerCount > 0) excerpt.push(theme.fg("muted", plural(importerCount, "importer")));
	if (testCount > 0) excerpt.push(theme.fg("muted", plural(testCount, "test")));
	if (details.truncated) excerpt.push(theme.fg("warning", "truncated"));
	lines.push(
		buildCompactRow(theme, {
			status: "success",
			label: "Module Report",
			targetText: path,
			targetIsPath: true,
			excerpt,
		}),
	);

	const maxSymbols = capFor("reportSymbols", expanded);
	const symbols = Array.isArray(details.symbols) ? details.symbols : [];
	const symbolNames = symbols.map((symbol) => symbol.name).filter((name): name is string => typeof name === "string");
	if (symbolNames.length > 0) {
		lines.push(sectionLine(theme, "Symbols"));
		lines.push(...boundedLines(theme, symbolNames, maxSymbols, (name) => valueLine(theme, name)));
	}
	const maxRelations = capFor("reportRelations", expanded);
	if (importCount > 0) {
		lines.push(sectionLine(theme, "Imports"));
		lines.push(...relationLines(theme, details.imports, maxRelations));
	}
	if (importerCount > 0) {
		lines.push(sectionLine(theme, "Importers"));
		lines.push(...relationLines(theme, details.importedBy, maxRelations));
	}
	if (testCount > 0) {
		lines.push(sectionLine(theme, "Tests"));
		lines.push(...relationLines(theme, details.counterparts, maxRelations));
	}
	return lines.join("\n");
}

// ============================================================================
// Semantic navigation renderer
// ============================================================================

function navigationLocationLine(theme: Theme, location: unknown): string {
	const record = asRecord(location);
	if (!record) {
		return "";
	}
	const path = typeof record.path === "string" ? record.path : "";
	const line = typeof record.line === "number" ? record.line : undefined;
	if (!path) {
		return "";
	}
	const suffix = line !== undefined ? `${theme.fg("muted", `:${line}`)}` : "";
	return `${pathLine(theme, path)}${suffix}`;
}

function renderSemanticNavigation(theme: Theme, details: AiraSemanticNavigationResult, expanded: boolean): string {
	const record = asRecord(details);
	const lines: string[] = [];
	const status = typeof record?.status === "string" ? record.status : "degraded";
	const target = (record?.symbol ?? record?.path ?? "") as string;
	const operation = typeof record?.operation === "string" ? record.operation : "definition";
	const reason = typeof record?.reason === "string" ? record.reason : undefined;

	const failure = (rowStatus: CompactStatus, excerpt: string[]): string => {
		lines.push(buildCompactRow(theme, { status: rowStatus, label: "Code Navigation", targetText: target, excerpt }));
		const reasonText = reasonLine(theme, reason);
		if (reasonText) lines.push(reasonText);
		return lines.join("\n");
	};

	if (status === "ready") {
		const locations = Array.isArray(record?.locations) ? record.locations : [];
		const count = locations.length;
		const excerpt: string[] =
			operation === "definition"
				? [theme.fg("muted", "definition")]
				: operation === "symbols"
					? [theme.fg("muted", plural(count, "symbol"))]
					: [theme.fg("muted", plural(count, "reference"))];
		if (record?.truncated) excerpt.push(theme.fg("warning", "truncated"));
		lines.push(buildCompactRow(theme, { status: "success", label: "Code Navigation", targetText: target, excerpt }));
		const maxLocations = capFor("navLocations", expanded);
		const shown = locations.slice(0, maxLocations);
		for (const location of shown) {
			const line = navigationLocationLine(theme, location);
			if (line) lines.push(line);
		}
		const remaining = locations.length - shown.length;
		if (remaining > 0) {
			lines.push(moreLine(theme, remaining));
		}
		return lines.join("\n");
	}

	switch (status) {
		case "no-results":
			return failure("success", [theme.fg("muted", "no results")]);
		case "symbol-not-found":
			return failure("success", [theme.fg("muted", "not found")]);
		case "unsupported-language":
			return failure("success", [theme.fg("muted", "unsupported language")]);
		case "server-unavailable":
			return failure("success", [theme.fg("muted", "server unavailable")]);
		case "unavailable":
			return failure("success", [theme.fg("muted", "unavailable")]);
		case "cancelled":
			return failure("success", [theme.fg("muted", "cancelled")]);
		case "ambiguous": {
			lines.push(
				buildCompactRow(theme, {
					status: "success",
					label: "Code Navigation",
					targetText: target,
					excerpt: [theme.fg("warning", "ambiguous")],
				}),
			);
			const candidates = Array.isArray(record?.candidates) ? record.candidates : [];
			const maxCandidates = capFor("navCandidates", expanded);
			const shown = candidates.slice(0, maxCandidates);
			for (const candidate of shown) {
				const recordCandidate = asRecord(candidate);
				const path = typeof recordCandidate?.path === "string" ? recordCandidate.path : "";
				if (path) lines.push(pathLine(theme, path));
			}
			if (candidates.length > maxCandidates) {
				lines.push(moreLine(theme, candidates.length - maxCandidates));
			}
			return lines.join("\n");
		}
		case "invalid-path":
			return failure("error", [theme.fg("error", "invalid path")]);
		case "timeout":
			return failure("error", [theme.fg("error", "timed out")]);
		case "degraded":
			return failure("error", [theme.fg("error", "degraded")]);
		default:
			return failure("error", [theme.fg("error", status)]);
	}
}

// ============================================================================
// Call renderer (pending/running row and expanded call header)
// ============================================================================

const CALL_ARG_ORDER = ["query", "path", "operation", "symbol", "paths", "limit"] as const;

function callTarget(label: string, args: unknown): { targetText: string; targetIsPath: boolean } {
	const record = asRecord(args);
	const none: { targetText: string; targetIsPath: boolean } = { targetText: "", targetIsPath: false };
	if (!record) {
		return none;
	}
	switch (label) {
		case "Symbol Search": {
			const query = typeof record.query === "string" ? record.query : "";
			return { targetText: query, targetIsPath: false };
		}
		case "Module Report": {
			const path = typeof record.path === "string" ? record.path : "";
			return { targetText: path, targetIsPath: true };
		}
		case "Code Navigation": {
			const symbol = typeof record.symbol === "string" ? record.symbol : "";
			const path = typeof record.path === "string" ? record.path : "";
			return { targetText: symbol || path, targetIsPath: !symbol };
		}
		case "Diagnostics": {
			const paths = Array.isArray(record.paths)
				? record.paths.filter((path): path is string => typeof path === "string")
				: [];
			return { targetText: paths.join(", ") || "working set", targetIsPath: paths.length > 0 };
		}
		default:
			return none;
	}
}

function callExcerpt(label: string, args: unknown): string[] {
	const record = asRecord(args);
	if (!record) {
		return [];
	}
	if (label === "Code Navigation") {
		const operation = typeof record.operation === "string" ? record.operation : "";
		return operation ? [operation] : [];
	}
	return [];
}

function formatCallArgs(theme: Theme, args: unknown): string {
	const record = asRecord(args);
	if (!record) {
		return "";
	}
	const parts: string[] = [];
	for (const key of CALL_ARG_ORDER) {
		const value = record[key];
		if (value === undefined) {
			continue;
		}
		const text = Array.isArray(value)
			? value.filter((item): item is string => typeof item === "string").join(", ")
			: String(value);
		if (text.length > 0) {
			parts.push(`${theme.fg("muted", `${key}:`)} ${theme.fg("toolOutput", text)}`);
		}
	}
	return parts.length > 0 ? `\n${parts.map((part) => `${SUB_INDENT}${part}`).join("\n")}` : "";
}

// ============================================================================
// Renderer factories
// ============================================================================

type ResultPayload = { content: Array<{ type: string; text?: string }>; details?: unknown };

function createCallRenderer(label: string): ToolDefinition["renderCall"] {
	return (args, theme, context) => {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		if (!context.expanded) {
			if (context.hasResult) {
				text.setText("");
				return text;
			}
			const { targetText, targetIsPath } = callTarget(label, args);
			text.setText(
				buildCompactRow(theme, {
					status: "running",
					label,
					targetText,
					targetIsPath,
					excerpt: callExcerpt(label, args),
				}),
			);
			return text;
		}
		text.setText(`${theme.fg("toolTitle", theme.bold(label))}${formatCallArgs(theme, args)}`);
		return text;
	};
}

function createResultRenderer(label: string): ToolDefinition["renderResult"] {
	return (result: ResultPayload, options: ToolRenderResultOptions, theme, context) => {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		const fallback = (): string => {
			const output = (result.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
			return fallbackResultText(theme, label, output, options.expanded);
		};
		const details = asRecord(result.details);
		if (!details) {
			text.setText(fallback());
			return text;
		}
		let body: string;
		switch (label) {
			case "Diagnostics": {
				const diagnostics = details as unknown as AiraDiagnosticsResult;
				body = renderDiagnostics(theme, diagnostics, options.expanded);
				break;
			}
			case "Symbol Search": {
				body = renderSymbolSearch(theme, details as unknown as AiraSymbolSearchResult, options.expanded);
				break;
			}
			case "Module Report": {
				body = renderModuleReport(theme, details as unknown as AiraModuleReportResult, options.expanded);
				break;
			}
			case "Code Navigation": {
				body = renderSemanticNavigation(
					theme,
					details as unknown as AiraSemanticNavigationResult,
					options.expanded,
				);
				break;
			}
			default:
				text.setText(fallback());
				return text;
		}
		if (options.expanded) {
			const raw = JSON.stringify(result.details, null, 2);
			if (raw) {
				body += `\n\n${theme.fg("muted", "Raw")}\n${theme.fg("toolOutput", raw)}`;
			}
		}
		text.setText(body);
		return text;
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

// ============================================================================
// Presentation adapter
// ============================================================================

/**
 * Attach human-facing labels and compact renderers to Aira intelligence tool
 * definitions.
 *
 * Presentation-only: names, descriptions, schemas and `execute` are preserved
 * (the returned definition for a tool with a label is a new object carrying
 * the same execute/description/parameters). Unknown tool definitions pass
 * through unchanged and keep the generic tool-result rendering.
 */
export function decorateAiraIntelligenceRenderers(
	definitions: Record<string, ToolDefinition>,
): Record<string, ToolDefinition> {
	const decorated: Record<string, ToolDefinition> = {};
	for (const [name, definition] of Object.entries(definitions)) {
		const label = INTELLIGENCE_TOOL_LABELS[name];
		if (!label) {
			decorated[name] = definition;
			continue;
		}
		decorated[name] = {
			...definition,
			label,
			renderCall: createCallRenderer(label),
			renderResult: createResultRenderer(label),
		};
	}
	return decorated;
}
