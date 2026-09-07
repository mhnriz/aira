/**
 * Human-facing rendering for Aira-native intelligence tools.
 *
 * Presentation-only coverage:
 * - friendly display labels while internal tool names stay unchanged;
 * - compact renderers for diagnostics, symbol search, module report and
 *   semantic navigation (one error, many, clean, invalid, unavailable,
 *   truncated, bounded);
 * - model payload integrity: the raw structured result reaching the
 *   AgentSession/model history is untouched by presentation rendering;
 * - generic fallback for unknown tools.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import type {
	AiraDiagnosticsResult,
	AiraIntelligenceHandle,
	AiraModuleReportResult,
	AiraSemanticNavigationResult,
	AiraSymbolSearchResult,
} from "../src/aira/intelligence/coordinator.ts";
import { createAiraIntelligenceToolDefinitions } from "../src/aira/intelligence/model-tools.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import {
	airaToolDisplayLabel,
	decorateAiraIntelligenceRenderers,
} from "../src/core/tools/aira-intelligence-renderers.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

/** Stub runtime returning canned structured payloads (never real providers). */
function createStubRuntime(): AiraIntelligenceHandle {
	const diagnostics: AiraDiagnosticsResult = {
		status: "ready",
		scope: "explicit",
		files: [
			{
				path: "src/probe.ts",
				status: "ready",
				diagnostics: [
					{
						line: 1,
						character: 7,
						severity: "error",
						code: "TS2322",
						source: "typescript",
						message: "Type 'number' is not assignable to type 'string'.",
					},
				],
				truncated: false,
			},
		],
		totals: { errors: 1, warnings: 0, other: 0 },
		truncated: false,
	};
	return {
		searchSymbols: (): AiraSymbolSearchResult => ({
			status: "ready",
			query: "AgentSessionRuntime",
			results: [
				{
					path: "src/agent-session-runtime.ts",
					symbols: ["AgentSessionRuntime", "createAgentSessionRuntime"],
					score: 0.9,
				},
			],
			truncated: false,
			suggestedNext: { tool: "aira_module_report", path: "src/agent-session-runtime.ts" },
		}),
		moduleReport: async (): Promise<AiraModuleReportResult> => ({
			status: "ready",
			path: "src/agent-session-runtime.ts",
			language: "typescript",
			symbols: [{ name: "AgentSessionRuntime", kind: "class", line: 1 }],
			imports: ["src/state.ts"],
			importedBy: ["src/interactive-mode.ts"],
			counterparts: ["src/agent-session-runtime.test.ts"],
			truncated: false,
			suggestedNext: {
				tool: "aira_semantic_navigation",
				operation: "definition",
				path: "src/agent-session-runtime.ts",
				symbol: "AgentSessionRuntime",
			},
		}),
		semanticNavigation: async (): Promise<AiraSemanticNavigationResult> => ({
			status: "ready",
			operation: "definition",
			path: "src/agent-session-runtime.ts",
			symbol: "AgentSessionRuntime",
			locations: [
				{
					uri: "file:///tmp/src/agent-session-runtime.ts",
					path: "src/agent-session-runtime.ts",
					line: 74,
					character: 1,
				},
			],
			truncated: false,
		}),
		diagnostics: async (): Promise<AiraDiagnosticsResult> => diagnostics,
	} as unknown as AiraIntelligenceHandle;
}

function resultOf(details: unknown): {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
	isError: boolean;
} {
	return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: false };
}

interface RenderedTool {
	lines: string[];
	component: ToolExecutionComponent;
}

/** Render one tool execution through the real TUI component (compact view). */
function renderTool(
	name: string,
	args: Record<string, unknown>,
	result: { content: Array<{ type: "text"; text: string }>; details: unknown; isError: boolean },
	definition: ToolDefinition | undefined,
	expanded = false,
): RenderedTool {
	const component = new ToolExecutionComponent(
		name,
		`tool-${name}`,
		args,
		{},
		definition,
		createFakeTui(),
		process.cwd(),
	);
	component.setExpanded(expanded);
	component.markExecutionStarted();
	component.updateResult(result);
	return { lines: stripAnsi(component.render(120).join("\n")).split("\n"), component };
}

describe("Aira intelligence tool presentation", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	// ========================================================================
	// A. Display labels and model contract
	// ========================================================================

	test("friendly labels while internal tool names stay unchanged", () => {
		const plain = createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() });
		const decorated = decorateAiraIntelligenceRenderers(plain);

		expect(airaToolDisplayLabel("aira_symbol_search")).toBe("Symbol Search");
		expect(airaToolDisplayLabel("aira_module_report")).toBe("Module Report");
		expect(airaToolDisplayLabel("aira_semantic_navigation")).toBe("Code Navigation");
		expect(airaToolDisplayLabel("aira_diagnostics")).toBe("Diagnostics");
		expect(airaToolDisplayLabel("aira_unknown_future_tool")).toBeUndefined();

		for (const [name, tool] of Object.entries(decorated)) {
			const original = plain[name];
			expect(tool.name).toBe(name);
			expect(tool.name).toBe(original.name);
			expect(tool.description).toBe(original.description);
			expect(tool.parameters).toBe(original.parameters);
			expect(tool.promptSnippet).toBe(original.promptSnippet);
			expect(tool.promptGuidelines).toBe(original.promptGuidelines);
			expect(tool.execute).toBe(original.execute);
		}
		expect(decorated.aira_symbol_search.label).toBe("Symbol Search");
		expect(decorated.aira_module_report.label).toBe("Module Report");
		expect(decorated.aira_semantic_navigation.label).toBe("Code Navigation");
		expect(decorated.aira_diagnostics.label).toBe("Diagnostics");
	});

	// ========================================================================
	// B. Diagnostics renderer
	// ========================================================================

	test("diagnostics: one error in one file", async () => {
		const details: AiraDiagnosticsResult = {
			status: "ready",
			scope: "explicit",
			files: [
				{
					path: "aira-diagnostic-probe.ts",
					status: "ready",
					diagnostics: [
						{
							line: 1,
							character: 7,
							severity: "error",
							code: "TS2322",
							source: "typescript",
							message: "Type 'number' is not assignable to type 'string'.",
						},
					],
					truncated: false,
				},
			],
			totals: { errors: 1, warnings: 0, other: 0 },
			truncated: false,
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_diagnostics",
			{ paths: ["aira-diagnostic-probe.ts"] },
			resultOf(details),
			definitions.aira_diagnostics,
		);

		expect(lines[0]).toContain("✓");
		expect(lines[0]).toContain("Diagnostics");
		expect(lines[0]).toContain("aira-diagnostic-probe.ts");
		expect(lines[0]).toContain("1 error");
		expect(lines[1]).toContain("TS2322 · 1:7");
		expect(lines[2]).toContain("Type 'number' is not assignable to type 'string'.");
		// No raw JSON dump in the human view.
		expect(lines.join("\n")).not.toContain('"status"');
		expect(lines.join("\n")).not.toContain("totals");
	});

	test("diagnostics: multiple files with errors and warnings, bounded", async () => {
		const details: AiraDiagnosticsResult = {
			status: "ready",
			scope: "explicit",
			files: [
				{
					path: "agent-session.ts",
					status: "ready",
					diagnostics: [
						{
							line: 14,
							character: 7,
							severity: "error",
							code: "TS2322",
							source: "typescript",
							message: "Type 'number' is not assignable to type 'string'.",
						},
						{
							line: 15,
							character: 3,
							severity: "error",
							code: "TS2322",
							source: "typescript",
							message: "Type 'boolean' is not assignable to type 'string'.",
						},
					],
					truncated: false,
				},
				{
					path: "sdk.ts",
					status: "ready",
					diagnostics: [
						{
							line: 44,
							character: 3,
							severity: "warning",
							code: "TS6133",
							source: "typescript",
							message: "'foo' is declared but its value is never read.",
						},
					],
					truncated: false,
				},
				{ path: "clean.ts", status: "ready", diagnostics: [], truncated: false },
			],
			totals: { errors: 2, warnings: 1, other: 0 },
			truncated: false,
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool("aira_diagnostics", { paths: [] }, resultOf(details), definitions.aira_diagnostics);

		expect(lines[0]).toContain("✓");
		expect(lines[0]).toContain("Diagnostics");
		expect(lines[0]).toContain("3 files");
		expect(lines[0]).toContain("2 errors");
		expect(lines[0]).toContain("1 warning");
		expect(lines.join("\n")).toContain("TS2322 · 14:7");
		expect(lines.join("\n")).toContain("TS6133 · 44:3");
		expect(lines.join("\n")).toContain("'foo' is declared but its value is never read.");
		// Clean file listed without diagnostics.
		expect(lines.join("\n")).toContain("clean.ts");
	});

	test("diagnostics: bounded per-file entries with an explicit more marker", async () => {
		const diagnostics: Array<{
			line: number;
			character: number;
			severity: "error";
			code: string;
			source: string;
			message: string;
		}> = Array.from({ length: 5 }, (_, index) => ({
			line: index + 1,
			character: 1,
			severity: "error",
			code: "TS2322",
			source: "typescript",
			message: `Type error ${index + 1}.`,
		}));
		const details: AiraDiagnosticsResult = {
			status: "ready",
			scope: "explicit",
			files: [{ path: "sdk.ts", status: "ready", diagnostics, truncated: false }],
			totals: { errors: 5, warnings: 0, other: 0 },
			truncated: false,
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_diagnostics",
			{ paths: ["sdk.ts"] },
			resultOf(details),
			definitions.aira_diagnostics,
		);

		expect(lines.join("\n")).toContain("… 2 more");
		// Exactly the compact cap (3) of headline+message pairs is shown.
		expect(lines.join("\n")).not.toContain("Type error 4.");
		expect(lines.join("\n")).not.toContain("Type error 5.");
	});

	test("diagnostics: clean result", async () => {
		const details: AiraDiagnosticsResult = {
			status: "ready",
			scope: "explicit",
			files: [{ path: "sdk.ts", status: "ready", diagnostics: [], truncated: false }],
			totals: { errors: 0, warnings: 0, other: 0 },
			truncated: false,
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_diagnostics",
			{ paths: ["sdk.ts"] },
			resultOf(details),
			definitions.aira_diagnostics,
		);

		expect(lines[0]).toContain("✓");
		expect(lines[0]).toContain("sdk.ts");
		expect(lines[0]).toContain("no issues");
		expect(lines.length).toBe(1);
	});

	test("diagnostics: invalid path is an explicit error state", async () => {
		const details: AiraDiagnosticsResult = {
			status: "ready",
			scope: "explicit",
			files: [
				{
					path: "src/missing.ts",
					status: "invalid-path",
					diagnostics: [],
					truncated: false,
					reason: "path does not exist",
				},
			],
			totals: { errors: 0, warnings: 0, other: 0 },
			truncated: false,
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_diagnostics",
			{ paths: ["src/missing.ts"] },
			resultOf(details),
			definitions.aira_diagnostics,
		);

		expect(lines[0]).toContain("✕");
		expect(lines[0]).toContain("invalid path");
		expect(lines[1]).toContain("invalid path · path does not exist");
	});

	test("diagnostics: per-file unavailable state", async () => {
		const details: AiraDiagnosticsResult = {
			status: "ready",
			scope: "explicit",
			files: [
				{
					path: "sdk.ts",
					status: "server-unavailable",
					diagnostics: [],
					truncated: false,
					reason: "language server is not installed",
				},
			],
			totals: { errors: 0, warnings: 0, other: 0 },
			truncated: false,
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_diagnostics",
			{ paths: ["sdk.ts"] },
			resultOf(details),
			definitions.aira_diagnostics,
		);

		expect(lines[0]).toContain("✓");
		expect(lines[0]).toContain("sdk.ts");
		expect(lines[0]).toContain("server unavailable");
		expect(lines[1]).toContain("language server is not installed");
	});

	test("diagnostics: query-level unavailable/degraded states", async () => {
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const unavailable: AiraDiagnosticsResult = {
			status: "unavailable",
			scope: "working-set",
			files: [],
			totals: { errors: 0, warnings: 0, other: 0 },
			truncated: false,
			reason: "live-code intelligence is unavailable (no language server support armed)",
		};
		const { lines: unavailableLines } = renderTool(
			"aira_diagnostics",
			{},
			resultOf(unavailable),
			definitions.aira_diagnostics,
		);
		expect(unavailableLines[0]).toContain("✓");
		expect(unavailableLines[0]).toContain("unavailable");
		expect(unavailableLines[1]).toContain("live-code intelligence is unavailable");

		const degraded: AiraDiagnosticsResult = {
			status: "degraded",
			scope: "explicit",
			files: [],
			totals: { errors: 0, warnings: 0, other: 0 },
			truncated: false,
			reason: "request failed",
		};
		const { lines: degradedLines } = renderTool(
			"aira_diagnostics",
			{ paths: ["sdk.ts"] },
			resultOf(degraded),
			definitions.aira_diagnostics,
		);
		expect(degradedLines[0]).toContain("✕");
		expect(degradedLines[0]).toContain("degraded");
		expect(degradedLines[1]).toContain("request failed");
	});

	test("diagnostics: no-targets state", async () => {
		const details: AiraDiagnosticsResult = {
			status: "no-targets",
			scope: "working-set",
			files: [],
			totals: { errors: 0, warnings: 0, other: 0 },
			truncated: false,
			reason: "no changed or working-set files to diagnose",
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool("aira_diagnostics", {}, resultOf(details), definitions.aira_diagnostics);
		expect(lines[0]).toContain("no changed files");
	});

	test("diagnostics: truncated result shows an explicit indicator", async () => {
		const details: AiraDiagnosticsResult = {
			status: "ready",
			scope: "explicit",
			files: [{ path: "sdk.ts", status: "ready", diagnostics: [], truncated: true }],
			totals: { errors: 0, warnings: 0, other: 0 },
			truncated: true,
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_diagnostics",
			{ paths: ["sdk.ts"] },
			resultOf({
				...details,
				files: [
					{
						path: "sdk.ts",
						status: "ready",
						diagnostics: [
							{ line: 1, character: 7, severity: "error", code: "TS2322", source: "t", message: "m" },
						],
						truncated: true,
					},
				],
				totals: { errors: 1, warnings: 0, other: 0 },
			}),
			definitions.aira_diagnostics,
		);
		expect(lines.join("\n")).toContain("… more");
	});

	// ========================================================================
	// C. Symbol search renderer
	// ========================================================================

	test("symbol search: single result with symbol hints, no ranking metadata", () => {
		const details: AiraSymbolSearchResult = {
			status: "ready",
			query: "AgentSessionRuntime",
			results: [
				{
					path: "src/agent-session-runtime.ts",
					symbols: ["AgentSessionRuntime", "createAgentSessionRuntime"],
					score: 0.95,
				},
			],
			truncated: false,
			suggestedNext: { tool: "aira_module_report", path: "src/agent-session-runtime.ts" },
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_symbol_search",
			{ query: "AgentSessionRuntime" },
			resultOf(details),
			definitions.aira_symbol_search,
		);

		expect(lines[0]).toContain("✓");
		expect(lines[0]).toContain("Symbol Search");
		expect(lines[0]).toContain("AgentSessionRuntime");
		expect(lines[0]).toContain("1 match");
		expect(lines[1]).toContain("src/agent-session-runtime.ts");
		expect(lines[2]).toContain("AgentSessionRuntime");
		expect(lines[3]).toContain("createAgentSessionRuntime");
		expect(lines.join("\n")).not.toContain("score");
		expect(lines.join("\n")).not.toContain("0.95");
	});

	test("symbol search: multiple results and truncation", () => {
		const details: AiraSymbolSearchResult = {
			status: "ready",
			query: "Tray",
			results: [
				{ path: "src/tray.ts", symbols: ["Tray"], score: 0.8 },
				{ path: "src/tray-runtime.ts", symbols: ["TrayRuntime", "createTray"], score: 0.6 },
				{ path: "src/tray-renderer.ts", symbols: [], score: 0.4 },
			],
			truncated: true,
			suggestedNext: { tool: "aira_module_report", path: "src/tray.ts" },
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_symbol_search",
			{ query: "Tray" },
			resultOf(details),
			definitions.aira_symbol_search,
		);

		expect(lines[0]).toContain("3 matches");
		expect(lines[0]).toContain("truncated");
		expect(lines.join("\n")).toContain("src/tray.ts");
		expect(lines.join("\n")).toContain("src/tray-runtime.ts");
		expect(lines.join("\n")).toContain("src/tray-renderer.ts");
		expect(lines.join("\n")).toContain("TrayRuntime");
		expect(lines.join("\n")).toContain("[Truncated: more matches]");
	});

	test("symbol search: no matches", () => {
		const details: AiraSymbolSearchResult = {
			status: "ready",
			query: "zzz",
			results: [],
			truncated: false,
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_symbol_search",
			{ query: "zzz" },
			resultOf(details),
			definitions.aira_symbol_search,
		);
		expect(lines[0]).toContain("zzz");
		expect(lines[0]).toContain("no matches");
	});

	// ========================================================================
	// D. Module report renderer
	// ========================================================================

	test("module report: counts and section structure", () => {
		const details: AiraModuleReportResult = {
			status: "ready",
			path: "src/agent-session-runtime.ts",
			language: "typescript",
			symbols: [
				{ name: "AgentSessionRuntime", kind: "class", line: 1 },
				{ name: "createAgentSessionRuntime", kind: "function", line: 2 },
			],
			imports: ["src/state.ts", "src/messages.ts"],
			importedBy: ["src/interactive-mode.ts", "src/rpc-mode.ts"],
			counterparts: ["src/agent-session-runtime.test.ts"],
			truncated: false,
			suggestedNext: undefined,
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_module_report",
			{ path: "src/agent-session-runtime.ts" },
			resultOf(details),
			definitions.aira_module_report,
		);

		expect(lines[0]).toContain("✓");
		expect(lines[0]).toContain("Module Report");
		expect(lines[0]).toContain("src/agent-session-runtime.ts");
		expect(lines[0]).toContain("2 symbols");
		expect(lines[0]).toContain("2 imports");
		expect(lines[0]).toContain("2 importers");
		expect(lines[0]).toContain("1 test");
		const text = lines.join("\n");
		expect(text).toContain("Symbols");
		expect(text).toContain("AgentSessionRuntime");
		expect(text).toContain("createAgentSessionRuntime");
		expect(text).toContain("Imports");
		expect(text).toContain("src/state.ts");
		expect(text).toContain("Importers");
		expect(text).toContain("src/interactive-mode.ts");
		expect(text).toContain("Tests");
		expect(text).toContain("src/agent-session-runtime.test.ts");
	});

	test("module report: bounded display with overflow markers", () => {
		const details: AiraModuleReportResult = {
			status: "ready",
			path: "src/agent-session-runtime.ts",
			symbols: Array.from({ length: 30 }, (_, index) => ({ name: `Symbol${index}`, kind: "class", line: index })),
			imports: ["a.ts", "b.ts", "c.ts", "d.ts"],
			importedBy: ["x.ts", "y.ts", "z.ts"],
			counterparts: [],
			truncated: false,
			suggestedNext: undefined,
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_module_report",
			{ path: "src/agent-session-runtime.ts" },
			resultOf(details),
			definitions.aira_module_report,
		);

		const text = lines.join("\n");
		expect(text).toContain("30 symbols");
		// Compact cap is 6: only Symbol0..Symbol5 appear, then a marker.
		expect(lines.filter((line) => line.includes("Symbol0")).length).toBe(1);
		expect(text).toContain("Symbol5");
		expect(text).not.toContain("Symbol6");
		expect(text).toContain("… 24 more");
		expect(text).toContain("4 imports");
		expect(text).toContain("… 1 more");
		expect(text).toContain("3 importers");
	});

	test("module report: not-found and invalid-path states", () => {
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines: notFoundLines } = renderTool(
			"aira_module_report",
			{ path: "src/gone.ts" },
			resultOf({
				status: "not-found",
				path: "src/gone.ts",
				symbols: [],
				imports: [],
				importedBy: [],
				counterparts: [],
				truncated: false,
			} as AiraModuleReportResult),
			definitions.aira_module_report,
		);
		expect(notFoundLines[0]).toContain("✕");
		expect(notFoundLines[0]).toContain("not found");
		expect(notFoundLines[1]).toContain("not in repository index");

		const { lines: invalidLines } = renderTool(
			"aira_module_report",
			{ path: "src/../outside.ts" },
			resultOf({
				status: "invalid-path",
				path: "src/../outside.ts",
				symbols: [],
				imports: [],
				importedBy: [],
				counterparts: [],
				truncated: false,
				reason: "path is outside the project root",
			} as AiraModuleReportResult),
			definitions.aira_module_report,
		);
		expect(invalidLines[0]).toContain("✕");
		expect(invalidLines[0]).toContain("invalid path");
		expect(invalidLines[1]).toContain("path is outside the project root");
	});

	// ========================================================================
	// E. Semantic navigation renderer
	// ========================================================================

	test("semantic navigation: definition", () => {
		const details: AiraSemanticNavigationResult = {
			status: "ready",
			operation: "definition",
			path: "src/agent-session-runtime.ts",
			symbol: "AgentSessionRuntime",
			locations: [
				{
					uri: "file:///tmp/src/agent-session-runtime.ts",
					path: "src/agent-session-runtime.ts",
					line: 74,
					character: 1,
				},
			],
			truncated: false,
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_semantic_navigation",
			{ operation: "definition", path: "src/agent-session-runtime.ts", symbol: "AgentSessionRuntime" },
			resultOf(details),
			definitions.aira_semantic_navigation,
		);

		expect(lines[0]).toContain("✓");
		expect(lines[0]).toContain("Code Navigation");
		expect(lines[0]).toContain("AgentSessionRuntime");
		expect(lines[0]).toContain("definition");
		expect(lines[1]).toContain("src/agent-session-runtime.ts:74");
	});

	test("semantic navigation: references (bounded)", () => {
		const locations = Array.from({ length: 12 }, (_, index) => ({
			uri: `file:///tmp/${index}.ts`,
			path: `src/module-${index}.ts`,
			line: 100 + index,
			character: 1,
		}));
		const details: AiraSemanticNavigationResult = {
			status: "ready",
			operation: "references",
			path: "src/agent-session-runtime.ts",
			symbol: "AgentSessionRuntime",
			locations,
			truncated: false,
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_semantic_navigation",
			{ operation: "references", symbol: "AgentSessionRuntime" },
			resultOf(details),
			definitions.aira_semantic_navigation,
		);

		expect(lines[0]).toContain("12 references");
		const text = lines.join("\n");
		expect(text).toContain("src/module-0.ts:100");
		expect(text).toContain("src/module-4.ts:104");
		expect(text).not.toContain("src/module-5.ts:105");
		expect(text).toContain("… 7 more");
	});

	test("semantic navigation: document symbols", () => {
		const details: AiraSemanticNavigationResult = {
			status: "ready",
			operation: "symbols",
			path: "src/agent-session-runtime.ts",
			locations: [
				{
					uri: "file:///tmp/src/agent-session-runtime.ts",
					path: "src/agent-session-runtime.ts",
					line: 1,
					character: 1,
				},
				{
					uri: "file:///tmp/src/agent-session-runtime.ts",
					path: "src/agent-session-runtime.ts",
					line: 2,
					character: 1,
				},
			],
			truncated: false,
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_semantic_navigation",
			{ operation: "symbols", path: "src/agent-session-runtime.ts" },
			resultOf(details),
			definitions.aira_semantic_navigation,
		);

		expect(lines[0]).toContain("Code Navigation");
		expect(lines[0]).toContain("src/agent-session-runtime.ts");
		expect(lines[0]).toContain("2 symbols");
		expect(lines.join("\n")).toContain("src/agent-session-runtime.ts:1");
	});

	test("semantic navigation: no results and failure states", () => {
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines: noResultsLines } = renderTool(
			"aira_semantic_navigation",
			{ operation: "references", symbol: "Missing" },
			resultOf({
				status: "no-results",
				operation: "references",
				path: "src/agent-session-runtime.ts",
				symbol: "Missing",
				locations: [],
				truncated: false,
			} as AiraSemanticNavigationResult),
			definitions.aira_semantic_navigation,
		);
		expect(noResultsLines[0]).toContain("✓");
		expect(noResultsLines[0]).toContain("no results");

		const { lines: invalidLines } = renderTool(
			"aira_semantic_navigation",
			{ operation: "definition", path: "src/missing.ts", symbol: "X" },
			resultOf({
				status: "invalid-path",
				operation: "definition",
				path: "src/missing.ts",
				symbol: "X",
				truncated: false,
				reason: "path does not exist",
			} as AiraSemanticNavigationResult),
			definitions.aira_semantic_navigation,
		);
		expect(invalidLines[0]).toContain("✕");
		expect(invalidLines[0]).toContain("invalid path");
		expect(invalidLines[1]).toContain("path does not exist");
	});

	// ========================================================================
	// Call rows (pending/running) and expanded view
	// ========================================================================

	test("running call rows use the friendly label and target", () => {
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const diagnostics = new ToolExecutionComponent(
			"aira_diagnostics",
			"tool-call-1",
			{ paths: ["sdk.ts"] },
			{},
			definitions.aira_diagnostics,
			createFakeTui(),
			process.cwd(),
		);
		let text = stripAnsi(diagnostics.render(120).join("\n"));
		expect(text).toContain("●");
		expect(text).toContain("Diagnostics");
		expect(text).toContain("sdk.ts");

		const navigation = new ToolExecutionComponent(
			"aira_semantic_navigation",
			"tool-call-2",
			{ operation: "references", symbol: "AgentSessionRuntime" },
			{},
			definitions.aira_semantic_navigation,
			createFakeTui(),
			process.cwd(),
		);
		text = stripAnsi(navigation.render(120).join("\n"));
		expect(text).toContain("Code Navigation");
		expect(text).toContain("AgentSessionRuntime");
		expect(text).toContain("references");
	});

	test("expanded view keeps the raw payload accessible", () => {
		const details: AiraDiagnosticsResult = {
			status: "ready",
			scope: "explicit",
			files: [
				{
					path: "sdk.ts",
					status: "ready",
					diagnostics: [
						{
							line: 44,
							character: 3,
							severity: "warning",
							code: "TS6133",
							source: "typescript",
							message: "'foo' is declared but its value is never read.",
						},
					],
					truncated: false,
				},
			],
			totals: { errors: 0, warnings: 1, other: 0 },
			truncated: false,
		};
		const definitions = decorateAiraIntelligenceRenderers(
			createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() }),
		);
		const { lines } = renderTool(
			"aira_diagnostics",
			{ paths: ["sdk.ts"] },
			resultOf(details),
			definitions.aira_diagnostics,
			true,
		);

		const text = lines.join("\n");
		expect(text).toContain("Diagnostics");
		expect(text).toContain("TS6133 · 44:3");
		expect(text).toContain("Raw");
		expect(text).toContain('"status": "ready"');
		expect(text).toContain('"message": "\'foo\' is declared but its value is never read."');
	});

	// ========================================================================
	// F. Model payload integrity
	// ========================================================================

	test("decorating definitions never changes the executed model payload", async () => {
		const plain = createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() });
		const decorated = decorateAiraIntelligenceRenderers(plain);
		for (const name of ["aira_symbol_search", "aira_module_report", "aira_semantic_navigation", "aira_diagnostics"]) {
			const original = plain[name];
			const presented = decorated[name];
			expect(presented.execute).toBe(original.execute);
			const [originalResult, presentedResult] = await Promise.all([
				(original.execute as (id: string, params: unknown) => Promise<AgentToolResult<unknown>>)("id", {}),
				(presented.execute as (id: string, params: unknown) => Promise<AgentToolResult<unknown>>)("id", {}),
			]);
			expect(presentedResult.content).toEqual(originalResult.content);
			expect(presentedResult.details).toEqual(originalResult.details);
			expect(JSON.stringify(originalResult.details)).toBe(
				(originalResult.content as Array<{ type: string; text: string }>)[0].text,
			);
		}
	});

	test("raw structured result reaches session history unchanged by rendering", async () => {
		const harness = await createHarness({});
		try {
			// The session arms the real intelligence coordinator (no project:
			// a truthful "unavailable" structured payload, no language server).
			const definition = harness.session.getToolDefinition("aira_diagnostics");
			expect(definition).toBeDefined();
			expect(definition?.label).toBe("Diagnostics");
			expect(definition?.renderResult).toBeDefined();

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("aira_diagnostics", { paths: ["src/probe.ts"] }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("inspect src/probe.ts diagnostics");

			const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
			const resultMessage = toolResults.at(-1);
			expect(resultMessage).toBeDefined();
			const text =
				typeof resultMessage?.content === "string"
					? resultMessage.content
					: (resultMessage?.content ?? [])
							.filter((part): part is { type: "text"; text: string } => part.type === "text")
							.map((part) => part.text)
							.join("\n");
			expect(text.length).toBeGreaterThan(0);

			// The model-facing payload is the full raw structured result
			// (status, scope, reason) — exactly what the coordinator produced,
			// with no presentation artifacts.
			const expected = await harness.session.airaIntelligence?.diagnostics({ paths: ["src/probe.ts"] });
			expect(JSON.parse(text)).toEqual(expected);
			expect(text).toContain('"status":"unavailable"');
			expect(text).not.toContain("Diagnostics ✓");
		} finally {
			harness.cleanup();
		}
	});

	// ========================================================================
	// G. Generic fallback for unknown tools
	// ========================================================================

	test("unknown tools pass through the decorator unchanged and keep generic rendering", () => {
		const plain = createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() });
		const withUnknown = decorateAiraIntelligenceRenderers({ aira_future_tool: plain.aira_diagnostics });
		expect(withUnknown.aira_future_tool).toBe(plain.aira_diagnostics);

		const genericDefinition: ToolDefinition = {
			name: "aira_future_tool",
			label: "aira_future_tool",
			description: "A future intelligence tool without a dedicated renderer",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "future payload" }], details: {} }),
		};
		const component = new ToolExecutionComponent(
			"aira_future_tool",
			"tool-future",
			{},
			{},
			genericDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "future payload" }], details: {}, isError: false });
		const text = stripAnsi(component.render(120).join("\n"));
		expect(text).toContain("✓");
		expect(text).toContain("aira_future_tool");
		expect(text).toContain("future payload");
	});

	test("generic fallback still renders raw text for undecorated intelligence results", () => {
		// A definition WITHOUT renderers (e.g. delivered before decoration)
		// falls back to the generic compact row + raw text output.
		const plain = createAiraIntelligenceToolDefinitions({ runtime: createStubRuntime() });
		const payload = {
			status: "ready",
			scope: "explicit",
			files: [],
			totals: { errors: 0, warnings: 0, other: 0 },
			truncated: false,
		};
		const component = new ToolExecutionComponent(
			"aira_diagnostics",
			"tool-raw",
			{ paths: ["sdk.ts"] },
			{},
			plain.aira_diagnostics,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(resultOf(payload));
		const text = stripAnsi(component.render(120).join("\n"));
		expect(text).toContain("✓");
		expect(text).toContain("aira_diagnostics");
		expect(text).toContain('"status":"ready"');
	});
});
