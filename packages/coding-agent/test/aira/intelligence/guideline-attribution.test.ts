/**
 * Aira intelligence — guideline attribution tests (0.1.7 step 9C).
 *
 * The system-prompt assembler appends each tool's `promptGuidelines` verbatim
 * as `- <guideline>` bullets. Contributions therefore have to be standalone
 * prose that names its subject (see the `promptGuidelines` contract in
 * core/extensions/types.ts); the intelligence tool guidelines originally
 * started with a bare "Use for ..." / "Use after edits ..." and rendered as
 * bullets with no visible subject, directly after the bash bullet.
 *
 * These tests assert rendered output, not implementation internals: every
 * intelligence guideline must name its tool, and no rendered bullet may be an
 * orphaned imperative.
 */
import { describe, expect, it } from "vitest";
import type { AiraIntelligenceHandle } from "../../../src/aira/intelligence/coordinator.ts";
import { createAiraIntelligenceToolDefinitions } from "../../../src/aira/intelligence/model-tools.ts";
import { buildSystemPrompt } from "../../../src/core/system-prompt.ts";

// The definitions are static; no runtime call happens during construction, so
// a structural stub is sufficient to read descriptions and guidelines.
const stubRuntime = {} as AiraIntelligenceHandle;

const INTELLIGENCE_TOOL_ORDER = [
	"aira_symbol_search",
	"aira_module_report",
	"aira_semantic_navigation",
	"aira_diagnostics",
] as const;

function intelligenceTools() {
	return createAiraIntelligenceToolDefinitions({ runtime: stubRuntime });
}

function renderedIntelligencePrompt(): string {
	const tools = intelligenceTools();
	const selected = ["bash", ...INTELLIGENCE_TOOL_ORDER, "read"];
	const toolSnippets: Record<string, string> = { bash: "Run shell commands", read: "Read a file" };
	const intelligenceGuidelines = INTELLIGENCE_TOOL_ORDER.flatMap((name) => {
		const tool = tools[name]!;
		toolSnippets[name] = tool.promptSnippet ?? "";
		return [...(tool.promptGuidelines ?? [])];
	});
	const promptGuidelines: string[] = [
		"Use bash for file operations like ls, rg, find",
		...intelligenceGuidelines,
		"Use read to examine files instead of cat or sed.",
	];
	return buildSystemPrompt({
		selectedTools: selected,
		toolSnippets,
		promptGuidelines,
		contextFiles: [],
		skills: [],
		cwd: process.cwd(),
	});
}

describe("Aira intelligence guideline attribution", () => {
	it("renders each intelligence guideline with an explicit tool subject", () => {
		const tools = intelligenceTools();
		for (const name of INTELLIGENCE_TOOL_ORDER) {
			for (const guideline of tools[name]!.promptGuidelines ?? []) {
				expect(guideline, `${name} guideline must name its subject`).toContain(name);
			}
		}
	});

	it("does not render orphaned imperative bullets", () => {
		const prompt = renderedIntelligencePrompt();
		const bullets = prompt.split("\n").filter((line) => line.startsWith("- "));
		for (const bullet of bullets) {
			expect(bullet, `orphaned bullet: ${bullet}`).not.toMatch(/^- Use (for|after|at|when)\b/i);
		}
	});

	it("keeps the four intelligence subjects visible in the rendered prompt", () => {
		const prompt = renderedIntelligencePrompt();
		for (const name of INTELLIGENCE_TOOL_ORDER) {
			expect(prompt).toContain(`- Use ${name} `);
		}
	});

	it("keeps intelligence guideline ordering deterministic", () => {
		const prompt = renderedIntelligencePrompt();
		const positions = INTELLIGENCE_TOOL_ORDER.map((name) => prompt.indexOf(`- Use ${name} `));
		expect(positions.every((p) => p >= 0)).toBe(true);
		const sorted = [...positions].sort((a, b) => a - b);
		expect(positions).toEqual(sorted);
	});

	it("appends contributions verbatim (assembler contract unchanged)", () => {
		const tools = intelligenceTools();
		const prompt = renderedIntelligencePrompt();
		for (const name of INTELLIGENCE_TOOL_ORDER) {
			for (const guideline of tools[name]!.promptGuidelines ?? []) {
				expect(prompt).toContain(`- ${guideline}`);
			}
		}
	});
});
