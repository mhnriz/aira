/** Thin read-only model projections over the session-owned intelligence coordinator. */
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import type { AiraIntelligenceHandle } from "./coordinator.ts";

const symbolSearchSchema = Type.Object({
	query: Type.String({ description: "Identifier, symbol, or file name to find" }),
	limit: Type.Optional(Type.Number({ description: "Maximum candidates to return (default 12)" })),
});

const moduleReportSchema = Type.Object({
	path: Type.String({ description: "Project-relative path to an indexed source file" }),
	limit: Type.Optional(Type.Number({ description: "Maximum entries per section (default 20)" })),
});

const semanticNavigationSchema = Type.Object({
	operation: Type.Union([Type.Literal("definition"), Type.Literal("references"), Type.Literal("symbols")], {
		description: "Semantic operation",
	}),
	path: Type.Optional(
		Type.String({ description: "Project-relative source path; omit when symbol discovery can identify it" }),
	),
	symbol: Type.Optional(
		Type.String({ description: "Symbol name; sufficient for definition/references in common cases" }),
	),
	line: Type.Optional(Type.Number({ description: "Optional zero-based source line" })),
	character: Type.Optional(Type.Number({ description: "Optional zero-based source character" })),
	limit: Type.Optional(Type.Number({ description: "Maximum semantic locations (default 20)" })),
});

type SymbolSearchParams = Static<typeof symbolSearchSchema>;
type ModuleReportParams = Static<typeof moduleReportSchema>;
type SemanticNavigationParams = Static<typeof semanticNavigationSchema>;

function createDefinitions(runtimeForTools: AiraIntelligenceHandle) {
	return {
		aira_symbol_search: {
			name: "aira_symbol_search",
			label: "aira_symbol_search",
			description:
				"Find likely project files and declared symbols by identifier or name. This is cheap, structured lexical/indexed discovery, not semantic reference truth; use the returned path with a module report or semantic navigation when appropriate.",
			promptSnippet: "Find likely files and declared symbols",
			promptGuidelines: [
				"Use for symbol/file discovery when you do not yet know the source path; results are indexed lexical evidence, not semantic references.",
			],
			parameters: symbolSearchSchema,
			async execute(_toolCallId: string, params: SymbolSearchParams) {
				return resultOf(runtimeForTools.searchSymbols(params.query, params.limit));
			},
		},
		aira_module_report: {
			name: "aira_module_report",
			label: "aira_module_report",
			description:
				"Give a compact structural orientation for one indexed source file: declarations, imports, reverse importers, and source/test counterparts. Use before reading a large file when structure is enough.",
			promptSnippet: "Orient within one indexed source file",
			promptGuidelines: [
				"Use for bounded module structure and import relationships; it does not provide source bodies or semantic call sites.",
			],
			parameters: moduleReportSchema,
			async execute(_toolCallId: string, params: ModuleReportParams) {
				return resultOf(await runtimeForTools.moduleReport(params.path, params.limit));
			},
		},
		aira_semantic_navigation: {
			name: "aira_semantic_navigation",
			label: "aira_semantic_navigation",
			description:
				"Use the project language server for go-to-definition, semantic references/call sites, or document symbols. Definition and references can start from a symbol name without exact coordinates; optionally provide a project path and zero-based line/character for precision. Results are bounded and may report ambiguity or unavailable language support.",
			promptSnippet: "Navigate code semantically with the project language server",
			promptGuidelines: [
				"Use for definitions, semantic references/call sites, and document symbols when language-server evidence is useful; grep/read/find remain valid fallbacks for literals and broad text discovery.",
			],
			parameters: semanticNavigationSchema,
			async execute(_toolCallId: string, params: SemanticNavigationParams, signal?: AbortSignal) {
				return resultOf(await runtimeForTools.semanticNavigation({ ...params, signal }));
			},
		},
	} satisfies Record<string, ToolDefinition>;
}

export function createAiraIntelligenceToolDefinitions(options: {
	runtime: AiraIntelligenceHandle;
}): Record<string, ToolDefinition> {
	return createDefinitions(options.runtime);
}

function resultOf(result: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(result) }],
		details: result,
	};
}
