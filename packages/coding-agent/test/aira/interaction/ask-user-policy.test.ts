/**
 * Aira interaction — ask_user decision policy tests (0.1.8 lean prompt C).
 *
 * Proves the canonical model-facing guidance treats ask_user as a decision
 * boundary rather than an uncertainty escape hatch: repository-resolvable
 * questions are investigated first, routine reversible choices proceed, and
 * user-owned product/architecture/destructive ambiguity is asked. The
 * condensed guideline text keeps those anchors; the tool description
 * continues to state one-question quality and the cancelled-question
 * contract. The tool surface, runtime seam, and execution behavior are
 * unchanged; no classifier or hidden model call is involved.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type AiraInteractionToolRuntime,
	createAiraInteractionToolDefinitions,
} from "../../../src/aira/interaction/model-tool.ts";
import type { AiraInteractionRequest } from "../../../src/aira/interaction/types.ts";
import { buildSystemPrompt } from "../../../src/core/system-prompt.ts";

const SOURCE_URL = new URL("../../../src/aira/interaction/model-tool.ts", import.meta.url);

function stubRuntime(onAsk?: (request: AiraInteractionRequest) => void): AiraInteractionToolRuntime {
	return {
		async ask(request) {
			onAsk?.(request);
			return {
				interactionId: "interaction-1",
				type: "semantic",
				resolution: "answered",
				selections: ["o1"],
			};
		},
	};
}

function askUserTool() {
	return createAiraInteractionToolDefinitions({ runtime: stubRuntime() }).ask_user!;
}

function guidanceText(): string {
	const tool = askUserTool();
	return [tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? []), tool.description ?? ""].join("\n");
}

describe("ask_user decision policy guidance", () => {
	it("frames ask_user as a decision boundary, not an uncertainty escape", () => {
		const text = guidanceText();
		expect(text).toMatch(/decision boundary, not an uncertainty escape/i);
		expect(text).toMatch(/genuinely needs the user/i);
	});

	it("investigates repository-resolvable questions before asking", () => {
		const text = guidanceText();
		expect(text).toMatch(/investigate first when the repository or environment can answer/i);
		expect(text).toMatch(/the repository or environment/);
		expect(text).toMatch(/proceed on routine reversible choices/i);
	});

	it("proceeds on routine reversible choices instead of asking", () => {
		const text = guidanceText();
		expect(text).toMatch(/proceed on routine reversible choices/i);
		expect(text).toMatch(/proceed on reversible choices/i);
	});

	it("asks for user-owned product, UX, and architecture direction", () => {
		const text = guidanceText();
		expect(text).toMatch(/user-owned product\/UX direction/i);
		expect(text).toMatch(/architecture trade-offs/i);
		expect(text).toMatch(/facts only the user can supply/i);
	});

	it("asks before destructive or irreversible actions", () => {
		const text = guidanceText();
		expect(text).toMatch(/destructive or irreversible actions/i);
	});

	it("never re-asks an explicit user decision", () => {
		const text = guidanceText();
		expect(text).toMatch(/never re-ask what the user already decided explicitly/i);
		expect(text).toMatch(/never re-ask what the user already decided/i);
	});

	it("keeps question quality: one concrete question and a recommended default", () => {
		const text = guidanceText();
		expect(text).toMatch(/exactly one concrete question with concise options and a recommended default/i);
		expect(text).toMatch(/exactly one concrete question per call/i);
		expect(text).toMatch(/recommend a\s+default when evidence supports one/i);
	});

	it("keeps the cancelled-question contract in both guideline and description", () => {
		const text = guidanceText();
		expect(text).toMatch(/a cancelled or unavailable question is not an answer/i);
		expect(text).toMatch(/cancelled\/unavailable question/i);
		expect(text).toMatch(/NOT an answer/i);
	});

	it("condenses the old exploratory wording without adding uncertainty triggers", () => {
		const text = guidanceText();
		// Consciously removed by the lean prompt: the "stop investigating"
		// meta-rule and the enumerated reversible-choice examples.
		expect(text).not.toMatch(/stop investigating when further inspection no longer improves confidence/i);
		expect(text).not.toMatch(/I'm uncertain|if unsure, ask/i);
		expect(text).not.toMatch(/confidence score/i);
	});

	it("keeps exactly one ask_user decision tool with unchanged framing", () => {
		const tools = createAiraInteractionToolDefinitions({ runtime: stubRuntime() });
		expect(Object.keys(tools)).toEqual(["ask_user"]);
		const tool = tools.ask_user!;
		expect(tool.promptSnippet).toBe("Ask the user one focused question and wait for the answer");
		expect(tool.label).toBe("ask user");
		// Structured parameters are unchanged.
		const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
		expect(Object.keys(properties).sort()).toEqual([
			"allowFreeform",
			"allowMultiple",
			"context",
			"options",
			"question",
		]);
	});

	it("still executes through the injected interaction runtime", async () => {
		const requests: AiraInteractionRequest[] = [];
		const tools = createAiraInteractionToolDefinitions({ runtime: stubRuntime((request) => requests.push(request)) });
		const result = (await tools.ask_user!.execute(
			"t1",
			{
				question: "Keep JSON settings or migrate to SQLite?",
				options: [{ title: "Keep JSON", description: "No migrations, stays portable" }],
			},
			undefined,
			undefined,
			{} as never,
		)) as { content: Array<{ text?: string }>; details: Record<string, unknown> };

		expect(requests).toHaveLength(1);
		expect(requests[0].type).toBe("semantic");
		expect(requests[0].question).toBe("Keep JSON settings or migrate to SQLite?");
		expect(requests[0].choices?.[0]).toMatchObject({ id: "o1", label: "Keep JSON" });
		expect(result.details.resolution).toBe("answered");
		expect(result.content[0]?.text).toContain("Keep JSON");
	});

	it("reaches the session system prompt through the guidelines wiring", () => {
		const tool = askUserTool();
		const prompt = buildSystemPrompt({
			selectedTools: ["read", "ask_user"],
			toolSnippets: { ask_user: tool.promptSnippet! },
			promptGuidelines: [...(tool.promptGuidelines ?? [])],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});
		expect(prompt).toContain("genuine decision boundary");
		expect(prompt).toContain("investigate first when the repository or environment can answer");
		expect(prompt).toContain("Ask the user one focused question and wait for the answer");
	});

	it("does not fold goals, verification, or task policy into the question tool", () => {
		const text = guidanceText();
		expect(text).not.toMatch(/\bgoal\b|\bgoals\b/i);
		expect(text).not.toMatch(/verification/i);
		expect(text).not.toMatch(/\btasks\b|\btask graph\b/i);
	});

	it("adds no hidden classifier or model call", () => {
		const source = readFileSync(SOURCE_URL, "utf8");
		// The module imports only typebox plus local tool/interaction types: no
		// provider client, no model call, and no separate reasoning surface.
		const imports = [...source.matchAll(/^import[^;]*from\s+"([^"]+)";/gm)].map((match) => match[1]);
		expect(imports.sort()).toEqual(["../../core/extensions/types.ts", "typebox", "./types.ts"].sort());
		expect(source).not.toMatch(/\bgenerateText\b|\bstreamText\b|\bchatCompletion\b|\bcreateClient\b/);
	});
});
